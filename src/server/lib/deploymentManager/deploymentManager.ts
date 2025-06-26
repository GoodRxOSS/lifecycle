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
import { DeployStatus, DeployTypes, CLIDeployTypes } from 'shared/constants';
import { createKubernetesApplyJob, monitorKubernetesJob } from '../kubernetesApply/applyManifest';
import { nanoid, customAlphabet } from 'nanoid';
import DeployService from 'server/services/deploy';
import rootLogger from 'server/lib/logger';
import { ensureServiceAccountForJob } from '../kubernetes/common/serviceAccount';

const logger = rootLogger.child({ filename: 'lib/deploymentManager/deploymentManager.ts' });
const generateJobId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6);

export class DeploymentManager {
  private deploys: Map<string, Deploy> = new Map();
  private deploymentLevels: Map<number, Deploy[]> = new Map();

  constructor(deploys: Deploy[]) {
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

    // Log final deployment order in a single line
    const orderSummary = Array.from({ length: this.deploymentLevels.size }, (_, i) => {
      const services =
        this.deploymentLevels
          .get(i)
          ?.map((d) => d.deployable.name)
          .join(',') || '';
      return `L${i}=[${services}]`;
    }).join(' ');

    logger.info(`DeploymentManager: Deployment order calculated levels=${this.deploymentLevels.size} ${orderSummary}`);
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
    const buildUuid = this.deploys.values().next().value?.build?.uuid || 'unknown';

    for (const value of this.deploys.values()) {
      await value.$query().patch({ status: DeployStatus.QUEUED });
    }

    for (let level = 0; level < this.deploymentLevels.size; level++) {
      const deploysAtLevel = this.deploymentLevels.get(level);
      if (deploysAtLevel) {
        const helmDeploys = deploysAtLevel.filter((d) => this.shouldDeployWithHelm(d));
        const githubDeploys = deploysAtLevel.filter((d) => this.shouldDeployWithKubernetes(d));

        const helmServices = helmDeploys.map((d) => d.deployable.name).join(',');
        const k8sServices = githubDeploys.map((d) => d.deployable.name).join(',');
        logger.info(
          `DeploymentManager: Deploying level=${level} buildUuid=${buildUuid} helm=[${helmServices}] k8s=[${k8sServices}]`
        );

        await Promise.all([
          helmDeploys.length > 0 ? deployHelm(helmDeploys) : Promise.resolve(),
          ...githubDeploys.map((deploy) => this.deployGitHubDeploy(deploy)),
        ]);
      }
    }
  }

  private shouldDeployWithHelm(deploy: Deploy): boolean {
    const deployType = deploy.deployable?.type || deploy.service?.type;
    return deployType === DeployTypes.HELM;
  }

  private shouldDeployWithKubernetes(deploy: Deploy): boolean {
    const deployType = deploy.deployable?.type || deploy.service?.type;
    return deployType === DeployTypes.GITHUB || deployType === DeployTypes.DOCKER || CLIDeployTypes.has(deployType);
  }

  private async deployGitHubDeploy(deploy: Deploy): Promise<void> {
    const jobId = generateJobId();
    const deployService = new DeployService();
    const runUUID = deploy.runUUID || nanoid();

    try {
      await deployService.patchAndUpdateActivityFeed(
        deploy,
        {
          status: DeployStatus.DEPLOYING,
          statusMessage: 'Creating Kubernetes apply job',
        },
        runUUID
      );

      await deploy.$fetchGraph('[build, deployable, service]');

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
      const jobName = `${deploy.uuid}-deploy-${jobId}-${shortSha}`;
      const result = await monitorKubernetesJob(jobName, deploy.build.namespace);

      if (result.success) {
        // Wait for the actual application pods to be ready
        await deployService.patchAndUpdateActivityFeed(
          deploy,
          {
            status: DeployStatus.DEPLOYING,
            statusMessage: 'Waiting for pods to be ready',
          },
          runUUID
        );

        const { waitForDeployPodReady } = await import('../kubernetes');
        const isReady = await waitForDeployPodReady(deploy);

        if (isReady) {
          await deployService.patchAndUpdateActivityFeed(
            deploy,
            {
              status: DeployStatus.READY,
              statusMessage: 'Kubernetes pods are ready',
            },
            runUUID
          );
        } else {
          throw new Error('Pods failed to become ready within timeout');
        }
      } else {
        throw new Error(result.message);
      }
    } catch (error) {
      await deployService.patchAndUpdateActivityFeed(
        deploy,
        {
          status: DeployStatus.DEPLOY_FAILED,
          statusMessage: `Kubernetes apply failed: ${error.message}`,
        },
        runUUID
      );
      throw error;
    }
  }
}
