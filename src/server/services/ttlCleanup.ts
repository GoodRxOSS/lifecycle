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
import rootLogger from 'server/lib/logger';
import * as k8s from '@kubernetes/client-node';
import { updatePullRequestLabels, createOrUpdatePullRequestComment, getPullRequestLabels } from 'server/lib/github';
import { getKeepLabel, getDisabledLabel, getDeployLabel } from 'server/lib/utils';
import { Build, PullRequest } from 'server/models';
import Metrics from 'server/lib/metrics';
import { DEFAULT_TTL_INACTIVITY_DAYS, DEFAULT_TTL_CHECK_INTERVAL_MINUTES } from 'shared/constants';
import GlobalConfigService from './globalConfig';

const logger = rootLogger.child({
  filename: 'services/ttlCleanup.ts',
});

interface TTLCleanupJob {
  dryRun?: boolean;
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
    try {
      // Always read fresh config to handle runtime config changes
      const config = await this.getTTLConfig();

      if (!config.enabled) {
        logger.info('[TTL] TTL cleanup is disabled, skipping');
        return;
      }

      // Job data takes precedence (for manual API calls), fall back to config for scheduled jobs
      const dryRun = job.data.dryRun ?? config.dryRun;
      const source = job.data.dryRun !== undefined ? 'api-override' : 'config';

      logger.info('[TTL] Starting TTL cleanup job', {
        dryRun,
        source,
        jobDataDryRun: job.data.dryRun,
        configDryRun: config.dryRun,
      });

      const staleEnvironments = await this.findStaleEnvironments(config.inactivityDays, config.excludedRepositories);

      logger.info(`[TTL] Found ${staleEnvironments.length} stale environments`, {
        inactivityDays: config.inactivityDays,
        dryRun,
      });

      let successCount = 0;
      let errorCount = 0;

      for (const env of staleEnvironments) {
        try {
          if (dryRun) {
            const dbLabels = this.parseLabels(env.pullRequest.labels);

            logger.info(`[TTL ${env.buildUUID}] [DRY RUN] Would clean up environment (NO ACTION TAKEN)`, {
              namespace: env.namespace,
              prNumber: env.pullRequest.pullRequestNumber,
              fullName: env.pullRequest.fullName,
              daysExpired: env.daysExpired,
              currentLabelsFromGitHub: env.currentLabels,
              labelsInDatabase: dbLabels,
              labelDriftDetected: env.hadLabelDrift,
            });
            successCount++;
          } else {
            logger.info(`[TTL ${env.buildUUID}] Cleaning up stale environment`, {
              namespace: env.namespace,
              prNumber: env.pullRequest.pullRequestNumber,
              fullName: env.pullRequest.fullName,
            });
            await this.cleanupStaleEnvironment(env, config.inactivityDays, config.commentTemplate, dryRun);
            successCount++;
          }
        } catch (error) {
          errorCount++;
          logger.error(`[TTL ${env.buildUUID}] Failed to cleanup environment`, {
            namespace: env.namespace,
            error,
          });
        }
      }

      logger.info('[TTL] TTL cleanup job completed', {
        totalFound: staleEnvironments.length,
        successCount,
        errorCount,
        dryRun,
      });
    } catch (error) {
      logger.error('[TTL] Error in TTL cleanup job', { error });
      throw error;
    }
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

      logger.info(`[TTL] Scanning ${namespaces.length} namespaces with TTL enabled`);

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
          logger.debug(`[TTL] Namespace ${nsName} has no TTL expiration label, skipping`);
          continue;
        }

        const expireTime = parseInt(expireAtUnix, 10);

        if (isNaN(expireTime) || expireTime > now) {
          continue;
        }

        const daysExpired = Math.floor((now - expireTime) / (1000 * 60 * 60 * 24));

        const buildUUID = labels['lfc/uuid']; // Use lfc/uuid (intentional difference)
        if (!buildUUID) {
          logger.warn(`[TTL] Namespace ${nsName} has no lfc/uuid label, skipping`);
          continue;
        }

        logger.debug(`[TTL ${buildUUID}] Namespace ${nsName} expired ${daysExpired} days ago`);

        const build = await this.db.models.Build.query()
          .findOne({ uuid: buildUUID })
          .withGraphFetched('[pullRequest.repository]');

        if (!build) {
          logger.warn(`[TTL ${buildUUID}] No build found for namespace ${nsName}, skipping`);
          continue;
        }

        if (build.status === 'torn_down' || build.status === 'pending') {
          logger.debug(`[TTL ${buildUUID}] Build is already ${build.status}, skipping`);
          continue;
        }

        if (build.isStatic) {
          logger.debug(`[TTL ${buildUUID}] Build is static environment, skipping`);
          continue;
        }

        const pullRequest = build.pullRequest;

        if (!pullRequest) {
          logger.warn(`[TTL ${buildUUID}] No pull request found, skipping`);
          continue;
        }

        if (pullRequest.status !== 'open') {
          logger.debug(`[TTL ${buildUUID}] PR is ${pullRequest.status}, skipping`);
          continue;
        }

        if (excludedRepositories.length > 0 && excludedRepositories.includes(pullRequest.fullName)) {
          logger.debug(`[TTL ${buildUUID}] Repository ${pullRequest.fullName} is excluded from TTL cleanup, skipping`);
          continue;
        }

        // Fetch current labels from GitHub to avoid stale data due to webhook incidents
        let currentLabels: string[];
        try {
          currentLabels = await getPullRequestLabels({
            installationId: pullRequest.repository.githubInstallationId,
            pullRequestNumber: pullRequest.pullRequestNumber,
            fullName: pullRequest.fullName,
          });

          logger.debug(
            `[TTL ${buildUUID}] Fetched ${currentLabels.length} labels from GitHub: ${currentLabels.join(', ')}`
          );

          // Sync labels back to DB if they differ (self-healing)
          const dbLabels = this.parseLabels(pullRequest.labels);
          if (JSON.stringify(currentLabels.sort()) !== JSON.stringify(dbLabels.sort())) {
            logger.info(`[TTL ${buildUUID}] Label drift detected, syncing to database`, {
              dbLabels,
              currentLabels,
            });
            await pullRequest.$query().patch({
              labels: JSON.stringify(currentLabels) as any,
            });
          }
        } catch (error) {
          logger.warn(`[TTL ${buildUUID}] Failed to fetch labels from GitHub, falling back to DB: ${error}`);
          // Fallback to DB labels if GitHub API fails
          currentLabels = this.parseLabels(pullRequest.labels);
        }

        if (currentLabels.includes(keepLabel)) {
          logger.debug(`[TTL ${buildUUID}] Has ${keepLabel} label (verified from GitHub), skipping`);
          continue;
        }

        if (currentLabels.includes(disabledLabel)) {
          logger.debug(`[TTL ${buildUUID}] Already has ${disabledLabel} label (verified from GitHub), skipping`);
          continue;
        }

        // Store current labels and drift status for dry-run reporting
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
      logger.error('[TTL] Error scanning K8s namespaces for stale environments', { error });
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

    logger.info(`[TTL ${buildUuid}] Cleaning up stale environment`, {
      namespace,
      prNumber: pullRequest.pullRequestNumber,
      fullName: pullRequest.fullName,
      daysExpired: env.daysExpired,
    });

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

      logger.info(`[TTL ${buildUuid}] Updated labels: removed ${deployLabel}, added ${disabledLabel}`, {
        prNumber: pullRequest.pullRequestNumber,
      });

      const commentMessage = await this.generateCleanupComment(inactivityDays, commentTemplate);

      await createOrUpdatePullRequestComment({
        installationId: repository.githubInstallationId,
        pullRequestNumber: pullRequest.pullRequestNumber,
        fullName: pullRequest.fullName,
        message: commentMessage,
        commentId: null,
        etag: null,
      });

      logger.info(`[TTL ${buildUuid}] Posted cleanup comment to PR`, {
        prNumber: pullRequest.pullRequestNumber,
      });

      await pullRequest.$query().patch({
        labels: JSON.stringify(updatedLabels) as any,
      });

      // Track successful cleanup metric
      const metrics = new Metrics('ttl.cleanup', { repositoryName: pullRequest.fullName });
      metrics.increment('total', { dry_run: dryRun.toString() });
    } catch (error) {
      logger.error(`[TTL ${buildUuid}] Failed to cleanup stale environment`, {
        namespace,
        prNumber: pullRequest.pullRequestNumber,
        error,
      });
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
      logger.info('[TTL] TTL cleanup is disabled in global config');
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

    logger.info(
      `[TTL] TTL cleanup job scheduled every ${config.checkIntervalMinutes} minutes (${config.inactivityDays} day TTL, dryRun: ${config.dryRun})`
    );
  }
}
