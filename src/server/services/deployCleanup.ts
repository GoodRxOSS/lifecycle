/**
 * Copyright 2026 GoodRx, Inc.
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

import { Job, Queue } from 'bullmq';
import { Deploy } from 'server/models';
import { shellPromise } from 'server/lib/shell';
import { extractContextForQueue, getLogger, withLogContext } from 'server/lib/logger';
import { CLIDeployTypes, DeployStatus, DeployTypes } from 'shared/constants';
import { codefreshDestroy, deleteDeploy } from 'server/lib/cli';
import Metrics from 'server/lib/metrics';
import BaseService from './_service';
import { parseSecretRefsFromEnv } from 'server/lib/secretRefs';
import { generateSecretName } from 'server/lib/kubernetes/externalSecret';
import { QUEUE_NAMES } from 'shared/config';
import { redisClient } from 'server/lib/dependencies';

export type DeployCleanupMode = 'infra' | 'service';

interface CleanupTask {
  name: string;
  resourceType: string;
  run: () => Promise<unknown>;
}

interface ServiceDiskConfig {
  name: string;
}

interface DeployCleanupQueueJob {
  deployId: number;
  mode: 'infra';
  sender?: string;
  correlationId?: string;
  _ddTraceContext?: Record<string, string>;
}

interface DestroyServiceDeploymentResult {
  status: 'success' | 'not_found' | 'error';
  message: string;
}

function shellQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function unique<T>(values: Array<T | null | undefined | false>): T[] {
  return Array.from(new Set(values.filter((value): value is T => Boolean(value))));
}

function parseServiceDisks(raw: string | null | undefined): ServiceDiskConfig[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((disk) => disk?.name) : [];
  } catch (error) {
    getLogger({ error }).warn('Deploy cleanup: service disk parse failed');
    return [];
  }
}

function isMissingResourceTypeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();

  return (
    normalized.includes("the server doesn't have a resource type") ||
    normalized.includes('the server does not have a resource type') ||
    normalized.includes('no matches for kind')
  );
}

function isHelmReleaseNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.toLowerCase().includes('release: not found');
}

export default class DeployCleanupService extends BaseService {
  deployCleanupQueue: Queue<DeployCleanupQueueJob> = this.queueManager.registerQueue(QUEUE_NAMES.DEPLOY_CLEANUP, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });

  async enqueueCleanup({ deployId, mode }: { deployId: number; mode: 'infra' }) {
    return this.deployCleanupQueue.add('cleanup', {
      deployId,
      mode,
      ...extractContextForQueue(),
    });
  }

  processCleanupQueue = async (job: Job<DeployCleanupQueueJob>) => {
    const { deployId, mode, sender, correlationId, _ddTraceContext } = job.data;

    return withLogContext({ sender, correlationId, _ddTraceContext }, async () => {
      const success = await this.cleanupDeploy(deployId, { mode });
      if (!success) {
        throw new Error(`Deploy cleanup failed deployId=${deployId} mode=${mode}`);
      }
    });
  };

  async destroyServiceDeployment(buildUuid: string, serviceName: string): Promise<DestroyServiceDeploymentResult> {
    return withLogContext({ buildUuid, serviceName }, async () => {
      const build = await this.db.models.Build.query()
        .findOne({ uuid: buildUuid })
        .withGraphFetched('deploys.[build, deployable]');

      if (!build) {
        return {
          status: 'not_found',
          message: `Build not found for ${buildUuid}.`,
        };
      }

      const deploy = build.deploys?.find((candidate) => candidate.deployable?.name === serviceName);

      if (!deploy) {
        return {
          status: 'not_found',
          message: `Service ${serviceName} not found for ${buildUuid}.`,
        };
      }

      if (deploy.status === DeployStatus.TORN_DOWN) {
        return {
          status: 'success',
          message: `Service ${serviceName} in build ${buildUuid} is already torn down`,
        };
      }

      await this.enqueueCleanup({ deployId: deploy.id, mode: 'infra' });

      return {
        status: 'success',
        message: `Service ${serviceName} in build ${buildUuid} teardown has been queued`,
      };
    });
  }

  async cleanupDeploy(deployOrId: Deploy | number, { mode }: { mode: DeployCleanupMode }): Promise<boolean> {
    const deploy = await this.resolveDeploy(deployOrId);
    if (!deploy) {
      getLogger({ deployId: deployOrId, mode }).warn('Deploy cleanup: deploy not found');
      return false;
    }

    const metadata = this.resolveCleanupMetadata(deploy);
    if (!metadata) {
      getLogger({
        deployId: deploy.id,
        deployUuid: deploy.uuid,
        mode,
      }).warn('Deploy cleanup: missing deploy metadata');
      return false;
    }

    const { namespace, serviceName, deployType } = metadata;
    return withLogContext({ deployUuid: deploy.uuid, serviceName }, async () => {
      const metrics = this.metricsFor(deploy, mode);
      const tasks = [
        ...this.buildKubernetesTasks(deploy, namespace),
        ...this.buildSecretTasks(deploy, namespace, serviceName),
        this.buildHelmTask(deploy, namespace, deployType),
        this.buildCliTask(deploy, deployType),
      ].filter(Boolean) as CleanupTask[];

      getLogger({ mode, taskCount: tasks.length }).info('Deploy cleanup: targeted teardown started');

      const results: boolean[] = [];
      for (const task of tasks) {
        results.push(await this.runTask(task, deploy, metrics, mode));
      }

      const success = results.every(Boolean);
      metrics.increment('deploy', { mode, result: success ? 'complete' : 'partial_failure' });

      if (mode === 'infra' && success) {
        await deploy.$query().patch({
          status: DeployStatus.TORN_DOWN,
          statusMessage: 'Deploy infrastructure was cleaned up successfully',
        });
      }

      getLogger({ mode, taskCount: tasks.length, success }).info('Deploy cleanup: targeted teardown complete');
      return success;
    });
  }

  async deleteServiceRows({ buildId, deployableIds }: { buildId: number; deployableIds: number[] }): Promise<void> {
    const uniqueDeployableIds = unique(deployableIds);
    if (uniqueDeployableIds.length === 0) {
      return;
    }

    await this.db.models.Deployable.transact(async (trx) => {
      await this.db.models.Deploy.query(trx).where({ buildId }).whereIn('deployableId', uniqueDeployableIds).delete();
      await this.db.models.Deployable.query(trx).whereIn('id', uniqueDeployableIds).delete();
    });
  }

  private async resolveDeploy(deployOrId: Deploy | number): Promise<Deploy | null> {
    if (typeof deployOrId === 'number') {
      return (await this.db.models.Deploy.query().findById(deployOrId).withGraphFetched('[build, deployable]')) ?? null;
    }

    await deployOrId.$fetchGraph('[build, deployable]');
    return deployOrId;
  }

  private resolveCleanupMetadata(
    deploy: Deploy
  ): { namespace: string; serviceName: string; deployType: DeployTypes } | null {
    const namespace = deploy.build?.namespace;
    const serviceName = deploy.deployable?.name;
    const deployType = deploy.deployable?.type;

    if (!namespace || !deploy.uuid || !serviceName || !deployType) {
      return null;
    }

    return { namespace, serviceName, deployType: deployType as DeployTypes };
  }

  private metricsFor(deploy: Deploy, mode: DeployCleanupMode): Metrics {
    return new Metrics('deploy_cleanup', {
      uuid: deploy?.build?.uuid,
      tags: {
        mode,
        deployUuid: deploy?.uuid,
        serviceName: deploy?.deployable?.name ?? '',
      },
    });
  }

  private kubectlDeleteExact(resourceType: string, namespace: string, names: string[]): CleanupTask | null {
    const filteredNames = unique(names);
    if (filteredNames.length === 0) {
      return null;
    }

    return {
      name: `kubectl-exact-${resourceType}`,
      resourceType,
      run: () =>
        shellPromise(
          `kubectl delete ${resourceType} ${filteredNames.map(shellQuote).join(' ')} --namespace ${shellQuote(
            namespace
          )} --ignore-not-found`
        ),
    };
  }

  private kubectlDeleteBySelector(resourceType: string, namespace: string, selector: string): CleanupTask {
    return {
      name: `kubectl-selector-${resourceType}`,
      resourceType,
      run: () =>
        shellPromise(
          `kubectl delete ${resourceType} --namespace ${shellQuote(namespace)} -l ${shellQuote(
            selector
          )} --ignore-not-found`
        ),
    };
  }

  private buildKubernetesTasks(deploy: Deploy, namespace: string): CleanupTask[] {
    const deployUuid = deploy.uuid;
    const deployId = deploy.id != null ? String(deploy.id) : null;
    const deployableId = deploy.deployableId != null ? String(deploy.deployableId) : null;
    const tasks: CleanupTask[] = [];

    const exactTasks = [
      this.kubectlDeleteExact('deployment', namespace, [deployUuid]),
      this.kubectlDeleteExact('service', namespace, [deployUuid, `internal-lb-${deployUuid}`]),
      this.kubectlDeleteExact('mapping', namespace, [deployUuid]),
      this.kubectlDeleteExact('ingress', namespace, [`ingress-${deployUuid}`]),
    ].filter(Boolean) as CleanupTask[];
    tasks.push(...exactTasks);

    const serviceDisks = parseServiceDisks(deploy.deployable?.serviceDisksYaml);
    const pvcNames = serviceDisks.map((disk) => `${deployUuid}-${disk.name}-claim`);
    const pvcTask = this.kubectlDeleteExact('pvc', namespace, pvcNames);
    if (pvcTask) {
      tasks.push(pvcTask);
    }

    const selectors = unique([
      `deploy_uuid=${deployUuid}`,
      `lc-deploy-uuid=${deployUuid}`,
      deployId ? `deploy-id=${deployId}` : null,
      deployableId ? `deployable-id=${deployableId}` : null,
    ]);

    for (const resourceType of ['pod', 'job', 'configmap']) {
      for (const selector of selectors) {
        tasks.push(this.kubectlDeleteBySelector(resourceType, namespace, selector));
      }
    }

    return tasks;
  }

  private buildSecretTasks(deploy: Deploy, namespace: string, serviceName: string): CleanupTask[] {
    const envRefs = parseSecretRefsFromEnv(deploy.env as Record<string, string>);
    const initEnvRefs = parseSecretRefsFromEnv(deploy.initEnv as Record<string, string>);
    const providers = unique([...envRefs, ...initEnvRefs].map((ref) => ref.provider));

    return providers.flatMap((provider) => {
      const secretName = generateSecretName(serviceName, provider);
      return [
        {
          name: `externalsecret-${provider}`,
          resourceType: 'externalsecret',
          run: () =>
            shellPromise(
              `kubectl delete externalsecret ${shellQuote(secretName)} --namespace ${shellQuote(
                namespace
              )} --ignore-not-found`
            ),
        },
        {
          name: `secret-${provider}`,
          resourceType: 'secret',
          run: () =>
            shellPromise(
              `kubectl delete secret ${shellQuote(secretName)} --namespace ${shellQuote(namespace)} --ignore-not-found`
            ),
        },
      ];
    });
  }

  private buildHelmTask(deploy: Deploy, namespace: string, deployType: DeployTypes): CleanupTask | null {
    if (deployType !== DeployTypes.HELM) {
      return null;
    }

    return {
      name: 'helm-uninstall',
      resourceType: 'helm-release',
      run: () => shellPromise(`helm uninstall ${shellQuote(deploy.uuid)} --namespace ${shellQuote(namespace)}`),
    };
  }

  private buildCliTask(deploy: Deploy, deployType: DeployTypes): CleanupTask | null {
    if (!CLIDeployTypes.has(deployType)) {
      return null;
    }

    return {
      name: 'cli-destroy',
      resourceType: deployType,
      run: () => (deployType === DeployTypes.CODEFRESH ? codefreshDestroy(deploy) : deleteDeploy(deploy)),
    };
  }

  private async runTask(
    task: CleanupTask,
    deploy: Deploy,
    metrics: Metrics,
    mode: DeployCleanupMode
  ): Promise<boolean> {
    try {
      await task.run();
      metrics.increment('task', {
        mode,
        result: 'success',
        resourceType: task.resourceType,
      });
      return true;
    } catch (error) {
      if (task.resourceType === 'helm-release' && isHelmReleaseNotFoundError(error)) {
        metrics.increment('task', {
          mode,
          result: 'skipped_not_found',
          resourceType: task.resourceType,
        });
        getLogger({
          mode,
          deployUuid: deploy.uuid,
          deployId: deploy.id,
          deployableId: deploy.deployableId,
          resourceType: task.resourceType,
          task: task.name,
        }).debug('Deploy cleanup: skipped missing Helm release');
        return true;
      }

      if (isMissingResourceTypeError(error)) {
        metrics.increment('task', {
          mode,
          result: 'skipped_missing_resource_type',
          resourceType: task.resourceType,
        });
        getLogger({
          mode,
          deployUuid: deploy.uuid,
          deployId: deploy.id,
          deployableId: deploy.deployableId,
          resourceType: task.resourceType,
          task: task.name,
        }).debug('Deploy cleanup: skipped missing Kubernetes resource type');
        return true;
      }

      metrics.increment('task', {
        mode,
        result: 'error',
        resourceType: task.resourceType,
      });
      getLogger({
        error,
        mode,
        deployUuid: deploy.uuid,
        deployId: deploy.id,
        deployableId: deploy.deployableId,
        resourceType: task.resourceType,
        task: task.name,
      }).error('Deploy cleanup: targeted teardown failed');
      return false;
    }
  }
}
