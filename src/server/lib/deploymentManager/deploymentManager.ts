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
import { AuthorityLockLostError } from 'server/lib/authorityLock';
import type { HelmSecretMutationGate } from 'server/lib/nativeHelm/helm';

export { DeploymentSupersededError } from 'server/lib/deploymentReconciliation/errors';

const generateJobId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6);

export type NativeMutationGateResult<T> = { admitted: true; value: T } | { admitted: false };

export type NativeMutationGate = <T>(deploy: Deploy, action: () => Promise<T>) => Promise<NativeMutationGateResult<T>>;

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
  /** Services that already failed before rollout; they stay in the plan so their dependents are blocked. */
  failedServices?: string[];
  /** Rows re-stamped to a newer generation are no longer this run's, even before the successor claims them. */
  expectedGeneration?: number;
  /**
   * Resolves once that service's current rollout has an outcome, or when the
   * wait must stop. Consulted only for declared prerequisites this plan cannot
   * order itself: ones another run took, or ones outside the plan.
   */
  prerequisiteOutcome?: (deploy: Deploy, prerequisite: string) => Promise<PrerequisiteOutcome>;
}

export type PrerequisiteOutcome = 'ready' | 'failed' | 'stopped';

type ServiceOutcome = 'ready' | 'failed' | 'superseded';

interface KubernetesDeploymentContext {
  deploy: Deploy;
  deployService: DeployService;
  runUUID: string;
  cliDeploy: boolean;
}

export class DeploymentManager {
  private deploys: Map<string, Deploy> = new Map();
  // Declared dependencies as configured; leveling consumes the lists on the deployables themselves.
  private dependencies: Map<string, string[]> = new Map();
  private deploymentLevels: Map<number, Deploy[]> = new Map();
  // Deploys never placed in a level: members of a dependency cycle, or dependents of one.
  private unresolvedDeploys: Deploy[] = [];
  private dependencyCycleDescription = '';
  private readonly options: DeploymentManagerOptions;

  constructor(deploys: Deploy[], options: DeploymentManagerOptions = {}) {
    this.options = options;
    deploys.forEach((deploy) => {
      this.deploys.set(deploy.deployable.name, deploy);
      this.dependencies.set(
        deploy.deployable.name,
        (deploy.deployable.deploymentDependsOn ?? []).filter((dependency) => dependency !== deploy.deployable.name)
      );
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

  public async deploy(): Promise<{ failed: Deploy[] }> {
    await this.assertCurrent();

    const unresolved = new Set(this.unresolvedDeploys);
    const superseded = new Set<string>();
    // Keyed by name so a failed prerequisite that never reaches this manager (a Codefresh service) still blocks dependents.
    const failed = new Map<string, Deploy | null>();
    for (const name of this.options.failedServices ?? []) {
      failed.set(name, this.deploys.get(name) ?? null);
    }
    for (const value of this.deploys.values()) {
      if (unresolved.has(value) || failed.has(value.deployable.name)) continue;
      if (!(await this.tryPatchDeploy(value, { status: DeployStatus.QUEUED }))) {
        superseded.add(value.deployable.name);
        getLogger().info(`Deploy: ${value.deployable.name} skipped reason=superseded`);
      }
    }

    await this.assertCurrent();

    if (this.unresolvedDeploys.length > 0) {
      const statusMessage = `Dependency cycle detected: ${this.dependencyCycleDescription}; deploy order cannot be resolved`;
      for (const deploy of this.unresolvedDeploys) {
        getLogger().error(`Deploy: ${deploy.deployable.name} failed — ${statusMessage}`);
        await this.tryPatchDeploy(deploy, { status: DeployStatus.DEPLOY_FAILED, statusMessage });
        failed.set(deploy.deployable.name, deploy);
      }
    }

    // Each service launches as soon as its own prerequisites are done, so a service that waits on another run
    // never holds back unrelated work in later levels.
    const levelOf = new Map<string, number>();
    this.deploymentLevels.forEach((deploys, level) => deploys.forEach((d) => levelOf.set(d.deployable.name, level)));
    const outcomes = new Map<string, Promise<ServiceOutcome>>();
    const schedule = (deploy: Deploy): Promise<ServiceOutcome> => {
      const name = deploy.deployable.name;
      let pending = outcomes.get(name);
      if (!pending) {
        pending = this.launchWhenPrerequisitesDone(deploy, levelOf.get(name) ?? 0, failed, superseded, schedule);
        outcomes.set(name, pending);
      }
      return pending;
    };
    await Promise.all(Array.from(this.deploys.values()).map((deploy) => schedule(deploy)));

    return { failed: Array.from(failed.values()).filter((deploy): deploy is Deploy => deploy != null) };
  }

  private async launchWhenPrerequisitesDone(
    deploy: Deploy,
    level: number,
    failed: Map<string, Deploy | null>,
    superseded: Set<string>,
    outcomeOf: (prerequisite: Deploy) => Promise<ServiceOutcome>
  ): Promise<ServiceOutcome> {
    const name = deploy.deployable.name;
    if (superseded.has(name)) return 'superseded';
    if (failed.has(name)) return 'failed';

    for (const dependency of this.dependencies.get(name) ?? []) {
      const inPlan = this.deploys.get(dependency);
      let outcome: ServiceOutcome | PrerequisiteOutcome | 'external';
      if (failed.has(dependency)) outcome = 'failed';
      else if (inPlan && !superseded.has(dependency)) outcome = await outcomeOf(inPlan);
      else outcome = 'external';
      if (outcome === 'superseded' || outcome === 'external') {
        // A prerequisite another run took, or one outside this plan, may be mid-rollout elsewhere right now.
        if (!this.options.prerequisiteOutcome) continue;
        getLogger().info(`Deploy: ${name} checking prerequisite=${dependency}`);
        outcome = await this.options.prerequisiteOutcome(deploy, dependency);
      }
      if (outcome === 'ready') continue;
      if (!(await this.claimForLaunch(deploy, superseded))) return 'superseded';
      const statusMessage =
        outcome === 'failed' ? `Not deployed: ${dependency} failed.` : `Not deployed: ${dependency} did not finish.`;
      getLogger().warn(`Deploy: ${name} skipped — ${statusMessage}`);
      await this.tryPatchDeploy(deploy, { status: DeployStatus.DEPLOY_FAILED, statusMessage });
      failed.set(name, deploy);
      return 'failed';
    }

    if (!(await this.claimForLaunch(deploy, superseded))) return 'superseded';
    await this.launchLevel(level, [deploy], failed, superseded);
    if (failed.has(name)) return 'failed';
    if (superseded.has(name)) return 'superseded';
    return 'ready';
  }

  /** A newer intent may have taken this row while earlier levels ran; nothing launches for a row we no longer own. */
  private async claimForLaunch(deploy: Deploy, superseded: Set<string>): Promise<boolean> {
    if (await this.tryPatchDeploy(deploy, { status: DeployStatus.QUEUED })) return true;
    superseded.add(deploy.deployable.name);
    getLogger().info(`Deploy: ${deploy.deployable.name} skipped reason=superseded`);
    return false;
  }

  private async launchLevel(
    level: number,
    runnable: Deploy[],
    failed: Map<string, Deploy | null>,
    superseded: Set<string>
  ): Promise<void> {
    if (runnable.length === 0) return;

    const helmDeploys = runnable.filter((d) => this.shouldDeployWithHelm(d));
    const githubDeploys = runnable.filter((d) => this.shouldDeployWithKubernetes(d));

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
    // may continue in the provider while a newer generation starts. Each
    // service is launched on its own so one failure is attributed to one row.
    const codefreshOutcomes = Promise.allSettled(
      codefreshHelmDeploys.map(async (deploy) => {
        // Provider launches sit outside the promotion gate; ownership is re-checked right before handing off.
        if (!(await this.tryPatchDeploy(deploy, { status: DeployStatus.QUEUED }))) {
          throw new DeploymentSupersededError();
        }
        return deployHelm([deploy], {
          providerSubmissionGate: (candidate) => this.tryPatchDeploy(candidate, { status: DeployStatus.DEPLOYING }),
        });
      })
    );

    const nativeDeploys = [...nativeHelmDeploys, ...githubDeploys];
    const nativeOutcomes = await Promise.allSettled([
      ...nativeHelmDeploys.map((deploy) =>
        this.runNativeMutation(deploy, () =>
          deployHelm([deploy], { secretMutationGate: this.options.nativeSecretMutationGate })
        )
      ),
      ...githubDeploys.map((deploy) => this.runNativeMutation(deploy, () => this.applyManifests(deploy))),
    ]);
    await this.assertCurrent();

    // A lost promotion lease is not a service failure: the apply may have landed, so the run must retry.
    const lostLease = nativeOutcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected' && outcome.reason instanceof AuthorityLockLostError
    );
    if (lostLease) throw lostLease.reason;

    const kubernetesDeployments: KubernetesDeploymentContext[] = [];
    nativeOutcomes.forEach((outcome, index) => {
      const deploy = nativeDeploys[index];
      if (outcome.status === 'fulfilled') {
        if (index >= nativeHelmDeploys.length) kubernetesDeployments.push(outcome.value as KubernetesDeploymentContext);
        return;
      }
      if (outcome.reason instanceof DeploymentSupersededError) {
        superseded.add(deploy.deployable.name);
        getLogger().info(`Deploy: ${deploy.deployable.name} stopped reason=superseded`);
        return;
      }
      failed.set(deploy.deployable.name, deploy);
    });

    // Pod readiness is observational and must not hold a promotion gate.
    const readiness = await Promise.allSettled(
      kubernetesDeployments.map((deployment) => this.waitForManifestReadiness(deployment))
    );
    readiness.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') return;
      const { deploy } = kubernetesDeployments[index];
      if (outcome.reason instanceof DeploymentSupersededError) {
        superseded.add(deploy.deployable.name);
        getLogger().info(`Deploy: ${deploy.deployable.name} stopped reason=superseded`);
        return;
      }
      failed.set(deploy.deployable.name, deploy);
    });

    (await codefreshOutcomes).forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') return;
      const deploy = codefreshHelmDeploys[index];
      if (outcome.reason instanceof DeploymentSupersededError) {
        superseded.add(deploy.deployable.name);
        getLogger().info(`Deploy: ${deploy.deployable.name} codefresh stopped reason=superseded`);
        return;
      }
      getLogger().error({ error: outcome.reason }, `Deploy: ${deploy.deployable.name} codefresh helm failed`);
      failed.set(deploy.deployable.name, deploy);
    });

    await this.assertCurrent();
  }

  private async assertCurrent(): Promise<void> {
    if (this.options.isCurrent && !(await this.options.isCurrent())) {
      throw new DeploymentSupersededError();
    }
  }

  private async runNativeMutation<T>(deploy: Deploy, action: () => Promise<T>): Promise<T> {
    if (!this.options.nativeMutationGate) return action();

    const result = await this.options.nativeMutationGate(deploy, action);
    if (!result.admitted) throw new DeploymentSupersededError();
    return result.value;
  }

  /** False means another run owns the row now; the caller skips it instead of failing its siblings. */
  private async tryPatchDeploy(deploy: Deploy, patch: Partial<Deploy>): Promise<boolean> {
    if (deploy.id == null || !deploy.runUUID) {
      getLogger().info(
        `Deploy: status patch skipped reason=missing_run_identity deployUuid=${deploy.uuid || 'unknown'}`
      );
      return true;
    }

    const generation = this.options.expectedGeneration;
    const patched = await deploy
      .$query()
      .patch(patch)
      .where({
        id: deploy.id,
        runUUID: deploy.runUUID,
        ...(generation != null ? { desiredGeneration: generation } : {}),
      });
    return patched > 0;
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
