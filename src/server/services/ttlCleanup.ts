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

import Service from './_service';
import { Queue, Job } from 'bullmq';
import { QUEUE_NAMES } from 'shared/config';
import { redisClient } from 'server/lib/dependencies';
import { withLogContext, updateLogContext, getLogger, LogStage } from 'server/lib/logger/index';
import * as k8s from '@kubernetes/client-node';
import { updatePullRequestLabels, createOrUpdatePullRequestComment, getPullRequestLabels } from 'server/lib/github';
import { getKeepLabel, getDisabledLabel, getDeployLabel } from 'server/lib/utils';
import { Build, PullRequest } from 'server/models';
import Metrics from 'server/lib/metrics';
import { DEFAULT_TTL_INACTIVITY_DAYS, DEFAULT_TTL_CHECK_INTERVAL_MINUTES } from 'shared/constants';
import GlobalConfigService from './globalConfig';

interface TTLCleanupJob {
  dryRun?: boolean;
  correlationId?: string;
}

interface StaleEnvironment {
  namespace: string;
  buildUUID: string;
  build: Build;
  pullRequest: PullRequest;
  daysExpired: number;
  currentLabels: string[];
  hadLabelDrift: boolean;
}

export default class TTLCleanupService extends Service {
  /**
   * Queue for managing TTL cleanup operations
   */
  ttlCleanupQueue: Queue<TTLCleanupJob> = this.queueManager.registerQueue(QUEUE_NAMES.TTL_CLEANUP, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

  /**
   * Process TTL cleanup queue jobs
   */
  processTTLCleanupQueue = async (job: Job<TTLCleanupJob>) => {
    const { correlationId } = job.data || {};

    return withLogContext({ correlationId: correlationId || `ttl-cleanup-${Date.now()}` }, async () => {
      try {
        // Always read fresh config to handle runtime config changes
        const config = await this.getTTLConfig();

        if (!config.enabled) {
          getLogger({ stage: LogStage.CLEANUP_STARTING }).debug('TTL: disabled, skipping');
          return;
        }

        // Job data takes precedence (for manual API calls), fall back to config for scheduled jobs
        const dryRun = job.data.dryRun ?? config.dryRun;

        getLogger({ stage: LogStage.CLEANUP_STARTING }).info(`TTL: starting cleanup dryRun=${dryRun}`);

        const staleEnvironments = await this.findStaleEnvironments(config.inactivityDays, config.excludedRepositories);

        getLogger({ stage: LogStage.CLEANUP_STARTING }).info(
          `TTL: found stale environments count=${staleEnvironments.length} inactivityDays=${config.inactivityDays}`
        );

        let successCount = 0;
        let errorCount = 0;

        for (const env of staleEnvironments) {
          await withLogContext({ buildUuid: env.buildUUID }, async () => {
            try {
              if (dryRun) {
                getLogger().info(
                  `TTL: dry run would cleanup namespace=${env.namespace} pr=${env.pullRequest.pullRequestNumber}`
                );
                successCount++;
              } else {
                getLogger().info(`TTL: cleaning namespace=${env.namespace} pr=${env.pullRequest.pullRequestNumber}`);
                await this.cleanupStaleEnvironment(env, config.inactivityDays, config.commentTemplate, dryRun);
                successCount++;
              }
            } catch (error) {
              errorCount++;
              getLogger().error({ error }, `TTL: cleanup failed namespace=${env.namespace}`);
            }
          });
        }

        getLogger({ stage: LogStage.CLEANUP_COMPLETE }).info(
          `TTL: completed found=${staleEnvironments.length} success=${successCount} errors=${errorCount}`
        );
      } catch (error) {
        getLogger({ stage: LogStage.CLEANUP_FAILED }).error({ error }, 'TTL: cleanup job failed');
        throw error;
      }
    });
  };

  private parseLabels(labels: string | string[] | null): string[] {
    if (!labels) return [];
    return typeof labels === 'string' ? JSON.parse(labels) : labels;
  }

  private async getTTLConfig() {
    const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();

    return {
      enabled: globalConfig.ttl_cleanup?.enabled ?? false,
      dryRun: globalConfig.ttl_cleanup?.dryRun ?? false,
      inactivityDays: globalConfig.ttl_cleanup?.inactivityDays ?? DEFAULT_TTL_INACTIVITY_DAYS,
      checkIntervalMinutes: globalConfig.ttl_cleanup?.checkIntervalMinutes ?? DEFAULT_TTL_CHECK_INTERVAL_MINUTES,
      commentTemplate: globalConfig.ttl_cleanup?.commentTemplate ?? this.getDefaultCommentTemplate(),
      excludedRepositories: globalConfig.ttl_cleanup?.excludedRepositories ?? [],
    };
  }

  /**
   * Find stale environments that haven't had activity within the TTL window
   */
  private async findStaleEnvironments(
    _inactivityDays: number,
    excludedRepositories: string[]
  ): Promise<StaleEnvironment[]> {
    const staleEnvironments: StaleEnvironment[] = [];
    const now = Date.now();

    try {
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      const client = kc.makeApiClient(k8s.CoreV1Api);

      const namespacesResponse = await client.listNamespace(
        undefined,
        undefined,
        undefined,
        undefined,
        'lfc/ttl-enable=true'
      );

      const namespaces = namespacesResponse.body.items;

      getLogger({ stage: LogStage.CLEANUP_STARTING }).info(`TTL: scanning namespaces count=${namespaces.length}`);

      // Fetch dynamic labels once at the start
      const keepLabel = await getKeepLabel();
      const disabledLabel = await getDisabledLabel();

      for (const namespace of namespaces) {
        const nsName = namespace.metadata?.name;
        const labels = namespace.metadata?.labels || {};

        if (!nsName || !nsName.startsWith('env-')) {
          continue;
        }

        const expireAtUnix = labels['lfc/ttl-expireAtUnix'];

        if (!expireAtUnix) {
          getLogger().debug(`Namespace ${nsName} has no TTL expiration label, skipping`);
          continue;
        }

        const expireTime = parseInt(expireAtUnix, 10);

        if (isNaN(expireTime) || expireTime > now) {
          continue;
        }

        const daysExpired = Math.floor((now - expireTime) / (1000 * 60 * 60 * 24));

        const buildUUID = labels['lfc/uuid'];
        if (!buildUUID) {
          getLogger().warn(`TTL: namespace missing uuid label namespace=${nsName}`);
          continue;
        }

        updateLogContext({ buildUuid: buildUUID });

        getLogger().debug(`Namespace ${nsName} expired ${daysExpired} days ago`);

        const build = await this.db.models.Build.query()
          .findOne({ uuid: buildUUID })
          .withGraphFetched('[pullRequest.repository]');

        if (!build) {
          getLogger().warn(`TTL: build not found namespace=${nsName}`);
          continue;
        }

        if (build.status === 'torn_down' || build.status === 'pending') {
          getLogger().debug(`Build is already ${build.status}, skipping`);
          continue;
        }

        if (build.isStatic) {
          getLogger().debug(`Build is static environment, skipping`);
          continue;
        }

        const pullRequest = build.pullRequest;

        if (!pullRequest) {
          getLogger().warn('TTL: pull request not found');
          continue;
        }

        if (pullRequest.status !== 'open') {
          getLogger().debug(`PR is ${pullRequest.status}, skipping`);
          continue;
        }

        if (excludedRepositories.length > 0 && excludedRepositories.includes(pullRequest.fullName)) {
          getLogger().debug(`Repository ${pullRequest.fullName} is excluded from TTL cleanup, skipping`);
          continue;
        }

        let currentLabels: string[];
        try {
          currentLabels = await getPullRequestLabels({
            installationId: pullRequest.repository.githubInstallationId,
            pullRequestNumber: pullRequest.pullRequestNumber,
            fullName: pullRequest.fullName,
          });

          getLogger().debug(`Fetched ${currentLabels.length} labels from GitHub: ${currentLabels.join(', ')}`);

          const dbLabels = this.parseLabels(pullRequest.labels);
          if (JSON.stringify(currentLabels.sort()) !== JSON.stringify(dbLabels.sort())) {
            getLogger().debug('TTL: label drift detected, syncing to DB');
            await pullRequest.$query().patch({
              labels: JSON.stringify(currentLabels) as any,
            });
          }
        } catch (error) {
          getLogger().warn({ error }, 'TTL: GitHub labels fetch failed, using DB');
          currentLabels = this.parseLabels(pullRequest.labels);
        }

        if (currentLabels.includes(keepLabel)) {
          getLogger().debug(`Has ${keepLabel} label (verified from GitHub), skipping`);
          continue;
        }

        if (currentLabels.includes(disabledLabel)) {
          getLogger().debug(`Already has ${disabledLabel} label (verified from GitHub), skipping`);
          continue;
        }

        const dbLabels = this.parseLabels(pullRequest.labels);
        const hadLabelDrift = JSON.stringify(currentLabels.sort()) !== JSON.stringify(dbLabels.sort());

        staleEnvironments.push({
          namespace: nsName,
          buildUUID,
          build,
          pullRequest,
          daysExpired,
          currentLabels,
          hadLabelDrift,
        });
      }
    } catch (error) {
      getLogger({ stage: LogStage.CLEANUP_FAILED }).error(
        { error },
        'Error scanning K8s namespaces for stale environments'
      );
      throw error;
    }

    return staleEnvironments;
  }

  /**
   * Cleanup a stale environment by updating labels and posting a comment
   */
  private async cleanupStaleEnvironment(
    env: StaleEnvironment,
    inactivityDays: number,
    commentTemplate: string | undefined,
    dryRun: boolean
  ) {
    const { build, pullRequest, namespace } = env;
    const buildUuid = build.uuid;
    const repository = pullRequest.repository;

    updateLogContext({ buildUuid });

    getLogger().info(`TTL: cleaning namespace=${namespace} pr=${pullRequest.pullRequestNumber}`);

    // Fetch dynamic labels at runtime
    const deployLabel = await getDeployLabel();
    const disabledLabel = await getDisabledLabel();

    const currentLabels = this.parseLabels(pullRequest.labels);

    const updatedLabels = currentLabels.filter((label) => label !== deployLabel).concat(disabledLabel);

    try {
      await updatePullRequestLabels({
        installationId: repository.githubInstallationId,
        pullRequestNumber: pullRequest.pullRequestNumber,
        fullName: pullRequest.fullName,
        labels: updatedLabels,
      });

      getLogger().debug(`TTL: labels updated PR#${pullRequest.pullRequestNumber}`);

      const commentMessage = await this.generateCleanupComment(inactivityDays, commentTemplate);

      await createOrUpdatePullRequestComment({
        installationId: repository.githubInstallationId,
        pullRequestNumber: pullRequest.pullRequestNumber,
        fullName: pullRequest.fullName,
        message: commentMessage,
        commentId: null,
        etag: null,
      });

      getLogger().debug(`TTL: cleanup comment posted PR#${pullRequest.pullRequestNumber}`);

      await pullRequest.$query().patch({
        labels: JSON.stringify(updatedLabels) as any,
      });

      // Track successful cleanup metric
      const metrics = new Metrics('ttl.cleanup', { repositoryName: pullRequest.fullName });
      metrics.increment('total', { dry_run: dryRun.toString() });
    } catch (error) {
      getLogger().error(
        { error },
        `Failed to cleanup stale environment: namespace=${namespace} prNumber=${pullRequest.pullRequestNumber}`
      );
      throw error;
    }
  }

  /**
   * Generate cleanup comment message with dynamic labels
   */
  private async generateCleanupComment(inactivityDays: number, template?: string): Promise<string> {
    const defaultTemplate = this.getDefaultCommentTemplate();
    const commentTemplate = template || defaultTemplate;

    // Fetch dynamic labels for replacement
    const keepLabel = await getKeepLabel();
    const disabledLabel = await getDisabledLabel();
    const deployLabel = await getDeployLabel();

    return commentTemplate
      .replace(/{inactivityDays}/g, inactivityDays.toString())
      .replace(/lifecycle-disabled!/g, disabledLabel)
      .replace(/lifecycle-deploy!/g, deployLabel)
      .replace(/lifecycle-keep!/g, keepLabel);
  }

  /**
   * Get default comment template with placeholders for dynamic labels
   */
  private getDefaultCommentTemplate(): string {
    return 'Tearing down lifecycle env since no activity in the past {inactivityDays} days.';
  }

  /**
   * Setup TTL cleanup recurring job
   */
  async setupTTLCleanupJob() {
    const config = await this.getTTLConfig();

    if (!config.enabled) {
      getLogger().debug('TTL: disabled in config');
      return;
    }

    const intervalMs = config.checkIntervalMinutes * 60 * 1000;

    await this.ttlCleanupQueue.add(
      'ttl-cleanup',
      {},
      {
        repeat: {
          every: intervalMs,
        },
      }
    );

    getLogger().info(`TTL: scheduled interval=${config.checkIntervalMinutes}min`);
  }
}
