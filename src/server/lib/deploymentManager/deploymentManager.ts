/**
 * Copyright 2025 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Deploy } from 'server/models';
import { deployHelm } from '../helm';
import { shouldUseNativeHelm } from '../nativeHelm';
import { DeployStatus, DeployTypes, CLIDeployTypes } from 'shared/constants';
import { createKubernetesApplyJob, monitorKubernetesJob } from '../kubernetesApply/applyManifest';
import { nanoid, customAlphabet } from 'nanoid';
import DeployService from 'server/services/deploy';
import { getLogger, withLogContext } from 'server/lib/logger';
import { ensureServiceAccountForJob } from '../kubernetes/common/serviceAccount';
import { waitForDeployPodReady } from '../kubernetes';
import { buildDeployJobName } from '../kubernetes/jobNames';
import GlobalConfigService from 'server/services/globalConfig';
import { getLogArchivalService } from 'server/services/logArchival';
import { DeploymentSupersededError } from 'server/lib/deploymentReconciliation/errors';
import type { HelmSecretMutationGate } from 'server/lib/nativeHelm/helm';

export { DeploymentSupersededError } from 'server/lib/deploymentReconciliation/errors';

const generateJobId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6);

export type NativeMutationGateResult<T> = { admitted: true; value: T } | { admitted: false };

export type NativeMutationGate = <T>(action: () => Promise<T>) => Promise<NativeMutationGateResult<T>>;

export interface DeploymentManagerOptions {
  /** Returns false once this deployment generation is no longer authoritative. */
  isCurrent?: () => Promise<boolean>;
  /**
   * Admits the native mutations for one dependency level after acquiring the
   * caller's promotion lock and rechecking generation authority.
   */
  nativeMutationGate?: NativeMutationGate;
  /** Serializes only writers of one Deploy's ExternalSecret resources. */
  nativeSecretMutationGate?: HelmSecretMutationGate;
}

interface KubernetesDeploymentContext {
  deploy: Deploy;
  deployService: DeployService;
  runUUID: string;
  cliDeploy: boolean;
}

export class DeploymentManager {
  private deploys: Map<string, Deploy> = new Map();
  private deploymentLevels: Map<number, Deploy[]> = new Map();
  // Deploys never placed in a level: members of a dependency cycle, or dependents of one.
  private unresolvedDeploys: Deploy[] = [];
  private dependencyCycleDescription = '';
  private readonly options: DeploymentManagerOptions;

  constructor(deploys: Deploy[], options: DeploymentManagerOptions = {}) {
    this.options = options;
    deploys.forEach((deploy) => {
      this.deploys.set(deploy.deployable.name, deploy);
    });

    this.calculateDeploymentOrder();
  }

  private calculateDeploymentOrder(): void {
    this.removeInvalidDependencies();
    let level = 0;

    // Remove self-dependencies
    this.deploys.forEach((deploy, deployableName) => {
      const selfDependencyIndex = deploy.deployable.deploymentDependsOn.indexOf(deployableName);
      if (selfDependencyIndex > -1) {
        deploy.deployable.deploymentDependsOn.splice(selfDependencyIndex, 1);
      }
    });

    let deploysWithoutDependencies = Array.from(this.deploys.values()).filter(
      (d) => d.deployable.deploymentDependsOn.length === 0
    );

    while (deploysWithoutDependencies.length > 0) {
      this.deploymentLevels.set(
        level,
        deploysWithoutDependencies.map((d) => d)
      );
      const nextToDeploy: Deploy[] = [];

      deploysWithoutDependencies.forEach((deploy) => {
        Array.from(this.deploys.values()).forEach((d) => {
          if (d.deployable.deploymentDependsOn.includes(deploy.deployable.name)) {
            const index = d.deployable.deploymentDependsOn.indexOf(deploy.deployable.name);
            d.deployable.deploymentDependsOn.splice(index, 1);
            if (d.deployable.deploymentDependsOn.length === 0) {
              nextToDeploy.push(d);
            }
          }
        });
      });

      deploysWithoutDependencies = nextToDeploy;
      level++;
    }

    const placed = new Set<string>();
    this.deploymentLevels.forEach((levelDeploys) => levelDeploys.forEach((d) => placed.add(d.deployable.name)));
    this.unresolvedDeploys = Array.from(this.deploys.values()).filter((d) => !placed.has(d.deployable.name));
    if (this.unresolvedDeploys.length > 0) {
      this.dependencyCycleDescription = this.describeDependencyCycle();
      const unresolvedNames = this.unresolvedDeploys.map((d) => d.deployable.name).join(',');
      getLogger().warn(
        `Deploy: dependency cycle ${this.dependencyCycleDescription} leaves [${unresolvedNames}] unschedulable`
      );
    }

    const orderSummary = Array.from({ length: this.deploymentLevels.size }, (_, i) => {
      const services =
        this.deploymentLevels
          .get(i)
          ?.map((d) => d.deployable.name)
          .join(',') || '';
      return `L${i}=[${services}]`;
    }).join(' ');

    getLogger().info(`Deploy: ${this.deploymentLevels.size} levels ${orderSummary}`);
  }

  // After leveling, unresolved deploys only retain deps on other unresolved deploys; walking them finds the cycle.
  private describeDependencyCycle(): string {
    const unresolved = new Map(this.unresolvedDeploys.map((d) => [d.deployable.name, d]));
    const start = Array.from(unresolved.keys()).sort()[0];
    const path: string[] = [];
    let current: string | undefined = start;

    while (current && !path.includes(current)) {
      path.push(current);
      current = unresolved.get(current)?.deployable.deploymentDependsOn.find((dep) => unresolved.has(dep));
    }

    if (!current) {
      return path.join(' -> ');
    }

    return [...path.slice(path.indexOf(current)), current].join(' -> ');
  }

  private removeInvalidDependencies(): void {
    const validDeployNames = new Set(this.deploys.keys());

    this.deploys.forEach((deploy) => {
      deploy.deployable.deploymentDependsOn = deploy.deployable.deploymentDependsOn.filter((dependencyName) => {
        return validDeployNames.has(dependencyName);
      });
    });
  }

  public async deploy(): Promise<void> {
    await this.assertCurrent();

    const unresolved = new Set(this.unresolvedDeploys);
    for (const value of this.deploys.values()) {
      if (!unresolved.has(value)) {
        await this.patchDeployIfCurrent(value, { status: DeployStatus.QUEUED });
      }
    }

    await this.assertCurrent();

    if (this.unresolvedDeploys.length > 0) {
      const statusMessage = `Dependency cycle detected: ${this.dependencyCycleDescription}; deploy order cannot be resolved`;
      for (const deploy of this.unresolvedDeploys) {
        getLogger().error(`Deploy: ${deploy.deployable.name} failed — ${statusMessage}`);
        await this.patchDeployIfCurrent(deploy, { status: DeployStatus.DEPLOY_FAILED, statusMessage });
      }
    }

    for (let level = 0; level < this.deploymentLevels.size; level++) {
      await this.assertCurrent();

      const deploysAtLevel = this.deploymentLevels.get(level);
      if (deploysAtLevel) {
        const helmDeploys = deploysAtLevel.filter((d) => this.shouldDeployWithHelm(d));
        const githubDeploys = deploysAtLevel.filter((d) => this.shouldDeployWithKubernetes(d));

        const helmMethods = await Promise.all(
          helmDeploys.map(async (deploy) => ({ deploy, native: await shouldUseNativeHelm(deploy) }))
        );
        await this.assertCurrent();

        const nativeHelmDeploys = helmMethods.filter(({ native }) => native).map(({ deploy }) => deploy);
        const codefreshHelmDeploys = helmMethods.filter(({ native }) => !native).map(({ deploy }) => deploy);

        const nativeHelmServices = nativeHelmDeploys.map((d) => d.deployable.name).join(',');
        const codefreshHelmServices = codefreshHelmDeploys.map((d) => d.deployable.name).join(',');
        const k8sServices = githubDeploys.map((d) => d.deployable.name).join(',');
        getLogger().info(
          `Deploy: level ${level} nativeHelm=[${nativeHelmServices}] codefreshHelm=[${codefreshHelmServices}] k8s=[${k8sServices}]`
        );

        // Codefresh is intentionally not part of native mutation admission. It
        // may continue in the provider while a newer generation starts.
        const codefreshDeploy = codefreshHelmDeploys.length > 0 ? deployHelm(codefreshHelmDeploys) : Promise.resolve();
        // Attach a handler immediately because supersession may deliberately
        // detach this provider wait before we await it below.
        void codefreshDeploy.catch(() => undefined);

        let kubernetesDeployments: KubernetesDeploymentContext[] = [];
        let nativeFailure: unknown;
        try {
          if (nativeHelmDeploys.length > 0 || githubDeploys.length > 0) {
            const nativeResult = await this.runNativeMutation(async () => {
              // Run same-generation siblings in parallel, but do not release the
              // promotion gate until every admitted native mutation is terminal.
              const settled = await Promise.allSettled([
                ...nativeHelmDeploys.map((deploy) =>
                  deployHelm([deploy], { secretMutationGate: this.options.nativeSecretMutationGate })
                ),
                ...githubDeploys.map((deploy) => this.applyManifests(deploy)),
              ]);
              const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
              const successfulKubernetesDeployments = settled
                .slice(nativeHelmDeploys.length)
                .filter(
                  (result): result is PromiseFulfilledResult<KubernetesDeploymentContext> =>
                    result.status === 'fulfilled'
                )
                .map((result) => result.value);
              return { kubernetesDeployments: successfulKubernetesDeployments, failure: failure?.reason };
            });
            kubernetesDeployments = nativeResult.kubernetesDeployments;
            nativeFailure = nativeResult.failure;
          }

          await this.assertCurrent();

          // Pod readiness is observational and must not hold the native mutation
          // gate. Settle every successful sibling even when another native
          // mutation failed so no Deploy is left indefinitely at DEPLOYING.
          const readiness = await Promise.allSettled(
            kubernetesDeployments.map((deployment) => this.waitForManifestReadiness(deployment))
          );
          if (nativeFailure) throw nativeFailure;
          const readinessFailure = readiness.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
          );
          if (readinessFailure) throw readinessFailure.reason;
          await codefreshDeploy;
        } catch (error) {
          if (error instanceof DeploymentSupersededError) {
            getLogger().info(`Deploy: level ${level} stopped reason=superseded`);
          }
          throw error;
        }
      }

      await this.assertCurrent();
    }
  }

  private async assertCurrent(): Promise<void> {
    if (this.options.isCurrent && !(await this.options.isCurrent())) {
      throw new DeploymentSupersededError();
    }
  }

  private async runNativeMutation<T>(action: () => Promise<T>): Promise<T> {
    if (!this.options.nativeMutationGate) return action();

    const result = await this.options.nativeMutationGate(action);
    if (!result.admitted) throw new DeploymentSupersededError();
    return result.value;
  }

  private async patchDeployIfCurrent(deploy: Deploy, patch: Partial<Deploy>): Promise<void> {
    if (deploy.id == null || !deploy.runUUID) {
      getLogger().info(
        `Deploy: status patch skipped reason=missing_run_identity deployUuid=${deploy.uuid || 'unknown'}`
      );
      return;
    }

    const patched = await deploy.$query().patch(patch).where({ id: deploy.id, runUUID: deploy.runUUID });
    if (!patched) throw new DeploymentSupersededError();
  }

  private shouldDeployWithHelm(deploy: Deploy): boolean {
    const deployType = deploy.deployable?.type;
    return deployType === DeployTypes.HELM;
  }

  private shouldDeployWithKubernetes(deploy: Deploy): boolean {
    const deployType = deploy.deployable?.type;
    // Note: only the below types have Kubernetes manifests
    return (
      deployType != null && [DeployTypes.GITHUB, DeployTypes.DOCKER, DeployTypes.AURORA_RESTORE].includes(deployType)
    );
  }

  private async archiveDeployLogs(
    deploy: Deploy,
    jobName: string,
    result: {
      success: boolean;
      logs?: string;
      startedAt?: string;
      completedAt?: string;
      duration?: number;
    }
  ): Promise<void> {
    const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
    if (!globalConfig.logArchival?.enabled || !result.logs) {
      return;
    }

    await getLogArchivalService().archiveLogs(
      {
        jobName,
        jobType: 'deploy',
        serviceName: deploy.deployable?.name || '',
        namespace: deploy.build.namespace,
        status: result.success ? 'Complete' : 'Failed',
        sha: deploy.sha || '',
        deployUuid: deploy.uuid,
        deploymentType: 'github',
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        duration: result.duration,
        archivedAt: new Date().toISOString(),
      },
      result.logs
    );
  }

  private async applyManifests(deploy: Deploy): Promise<KubernetesDeploymentContext> {
    return withLogContext({ deployUuid: deploy.uuid, serviceName: deploy.deployable?.name }, async () => {
      const jobId = generateJobId();
      const deployService = new DeployService();
      const runUUID = deploy.runUUID || nanoid();
      if (deploy.runUUID !== runUUID) {
        await deploy.$query().patch({ runUUID });
        deploy.runUUID = runUUID;
      }

      try {
        await deployService.patchAndUpdateActivityFeed(
          deploy,
          {
            status: DeployStatus.DEPLOYING,
            statusMessage: 'Creating Kubernetes apply job',
          },
          runUUID
        );

        await deploy.$fetchGraph('[build, deployable]');

        if (!deploy.manifest) {
          throw new Error(`Deploy ${deploy.uuid} has no manifest. Ensure manifests are generated before deployment.`);
        }

        await ensureServiceAccountForJob(deploy.build.namespace, 'deploy');

        await createKubernetesApplyJob({
          deploy,
          namespace: deploy.build.namespace,
          jobId,
        });

        const shortSha = deploy.sha?.substring(0, 7) || 'unknown';
        const jobName = buildDeployJobName({
          deployUuid: deploy.uuid,
          jobId,
          shortSha,
        });
        const result = await monitorKubernetesJob(jobName, deploy.build.namespace);
        await this.archiveDeployLogs(deploy, jobName, result);

        if (!result.success) {
          throw new Error(result.message);
        }

        await deployService.patchAndUpdateActivityFeed(
          deploy,
          {
            status: DeployStatus.DEPLOYING,
            statusMessage: 'Waiting for pods to be ready',
          },
          runUUID
        );

        const cliDeploy = CLIDeployTypes.has(deploy.deployable.type);
        return { deploy, deployService, runUUID, cliDeploy };
      } catch (error) {
        if (error instanceof DeploymentSupersededError) throw error;
        await deployService.recordDeployFailure(deploy, runUUID, {
          status: DeployStatus.DEPLOY_FAILED,
          error,
          fallbackMessage: `Deployment failed for ${deploy.uuid}. Check deploy logs in Console > Deploy tab for details.`,
        });
        throw error;
      }
    });
  }

  private async waitForManifestReadiness({
    deploy,
    deployService,
    runUUID,
    cliDeploy,
  }: KubernetesDeploymentContext): Promise<void> {
    return withLogContext({ deployUuid: deploy.uuid, serviceName: deploy.deployable?.name }, async () => {
      try {
        const readiness = cliDeploy ? { ready: true } : await waitForDeployPodReady(deploy);

        if (!readiness.ready) {
          const cause = readiness.causeSummary ? `: ${readiness.causeSummary.slice(0, 350)}` : '';
          throw new Error(`Pods failed to become ready within timeout${cause}`);
        }

        await deployService.patchAndUpdateActivityFeed(
          deploy,
          {
            status: DeployStatus.READY,
            statusMessage: cliDeploy ? 'CLI Deploy completed' : 'Kubernetes pods are ready',
          },
          runUUID
        );
      } catch (error) {
        if (error instanceof DeploymentSupersededError) throw error;
        await deployService.recordDeployFailure(deploy, runUUID, {
          status: DeployStatus.DEPLOY_FAILED,
          error,
          fallbackMessage: `Deployment failed for ${deploy.uuid}. Check deploy logs in Console > Deploy tab for details.`,
        });
        throw error;
      }
    });
  }
}
