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
import { withLogContext, updateLogContext, getLogger, LogStage } from 'server/lib/logger';
import * as k8s from '@kubernetes/client-node';
import { updatePullRequestLabels, createOrUpdatePullRequestComment, getPullRequestLabels } from 'server/lib/github';
import { getKeepLabel, getDisabledLabel, getDeployLabel, parsePullRequestLabels } from 'server/lib/utils';
import { Build, PullRequest } from 'server/models';
import Metrics from 'server/lib/metrics';
import {
  BuildKind,
  DEFAULT_TTL_INACTIVITY_DAYS,
  DEFAULT_TTL_CHECK_INTERVAL_MINUTES,
  PullRequestStatus,
} from 'shared/constants';
import GlobalConfigService from './globalConfig';

interface TTLCleanupJob {
  dryRun?: boolean;
  correlationId?: string;
}

type StaleEnvironmentAction = 'closed_pull_request' | 'disable_pull_request' | 'already_disabled' | 'expired_sandbox';

interface StaleEnvironment {
  namespace: string;
  buildUUID: string;
  build: Build;
  pullRequest: PullRequest;
  daysExpired: number;
  currentLabels: string[];
  hadLabelDrift: boolean;
  action: StaleEnvironmentAction;
}

const TTL_NAMESPACE_PREFIXES = ['env-', 'sbx-'];
const DAY_MS = 1000 * 60 * 60 * 24;

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
                  `TTL: dry run would cleanup namespace=${env.namespace} pr=${env.pullRequest.pullRequestNumber} action=${env.action}`
                );
                successCount++;
              } else {
                await this.cleanupEnvironment(env, config.inactivityDays, config.commentTemplate, dryRun);
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
    inactivityDays: number,
    excludedRepositories: string[]
  ): Promise<StaleEnvironment[]> {
    const staleEnvironments: StaleEnvironment[] = [];
    const now = Date.now();

    try {
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      const client = kc.makeApiClient(k8s.CoreV1Api);

      // `!=false` also matches namespaces with no TTL labels at all, which would otherwise never expire.
      const namespacesResponse = await client.listNamespace(
        undefined,
        undefined,
        undefined,
        undefined,
        'lfc/ttl-enable!=false'
      );

      const namespaces = namespacesResponse.body.items;

      getLogger({ stage: LogStage.CLEANUP_STARTING }).info(`TTL: scanning namespaces count=${namespaces.length}`);

      // Fetch dynamic labels once at the start
      const keepLabel = await getKeepLabel();
      const disabledLabel = await getDisabledLabel();

      for (const namespace of namespaces) {
        const nsName = namespace.metadata?.name;
        const labels = namespace.metadata?.labels || {};

        const prefix = nsName && TTL_NAMESPACE_PREFIXES.find((candidate) => nsName.startsWith(candidate));
        if (!nsName || !prefix) {
          continue;
        }

        const expireAtUnix = labels['lfc/ttl-expireAtUnix'];
        const hasTTLLabels = expireAtUnix != null || labels['lfc/ttl-enable'] != null;

        if (hasTTLLabels && !expireAtUnix) {
          getLogger().debug(`Namespace ${nsName} has no TTL expiration label, skipping`);
          continue;
        }

        let expireTime = hasTTLLabels ? parseInt(expireAtUnix, 10) : NaN;

        if (hasTTLLabels && (isNaN(expireTime) || expireTime > now)) {
          continue;
        }

        let buildUUID = labels['lfc/uuid'];
        if (!buildUUID) {
          buildUUID = nsName.slice(prefix.length);
          getLogger().warn(`TTL: namespace missing uuid label, derived from name namespace=${nsName}`);
        }

        updateLogContext({ buildUuid: buildUUID });

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

        if (!hasTTLLabels) {
          // No TTL labels to read, so measure inactivity from the namespace's own age or the build's last update.
          const createdAt = new Date(namespace.metadata?.creationTimestamp ?? 0).getTime();
          const updatedAt = new Date(build.updatedAt ?? 0).getTime();
          expireTime = Math.max(createdAt || 0, updatedAt || 0) + inactivityDays * DAY_MS;
          if (expireTime > now) {
            continue;
          }
          getLogger().info(`TTL: namespace has no TTL labels, using last activity namespace=${nsName}`);
        }

        const daysExpired = Math.floor((now - expireTime) / DAY_MS);

        getLogger().debug(`Namespace ${nsName} expired ${daysExpired} days ago`);

        const pullRequest = build.pullRequest;

        if (build.kind === BuildKind.SANDBOX && pullRequest) {
          // The pull request belongs to the base environment, so its labels must not be touched.
          staleEnvironments.push({
            namespace: nsName,
            buildUUID,
            build,
            pullRequest,
            daysExpired,
            currentLabels: parsePullRequestLabels(pullRequest.labels),
            hadLabelDrift: false,
            action: 'expired_sandbox',
          });
          continue;
        }

        if (!pullRequest) {
          // API-environment expiry belongs to the expiresAt sweep; the scanner
          // only repairs drift — a labeled, expired namespace whose PR-less build never got a lease.
          if (build.triggerType === 'api' && !build.expiresAt) {
            await this.db.services.BuildService.enqueueBuildDeletion(build, 'ttl_namespace_drift');
          } else {
            getLogger().warn('TTL: pull request not found');
          }
          continue;
        }

        if (excludedRepositories.length > 0 && excludedRepositories.includes(pullRequest.fullName)) {
          getLogger().debug(`Repository ${pullRequest.fullName} is excluded from TTL cleanup, skipping`);
          continue;
        }

        if (pullRequest.status !== PullRequestStatus.OPEN) {
          getLogger().info(
            `TTL: found expired closed PR namespace=${nsName} pr=${pullRequest.pullRequestNumber} status=${pullRequest.status}`
          );
          staleEnvironments.push({
            namespace: nsName,
            buildUUID,
            build,
            pullRequest,
            daysExpired,
            currentLabels: parsePullRequestLabels(pullRequest.labels),
            hadLabelDrift: false,
            action: 'closed_pull_request',
          });
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

          const dbLabels = parsePullRequestLabels(pullRequest.labels);
          if (JSON.stringify(currentLabels.sort()) !== JSON.stringify(dbLabels.sort())) {
            getLogger().debug('TTL: label drift detected, syncing to DB');
            await pullRequest.$query().patch({
              labels: JSON.stringify(currentLabels) as any,
            });
          }
        } catch (error) {
          getLogger().warn({ error }, 'TTL: GitHub labels fetch failed, using DB');
          currentLabels = parsePullRequestLabels(pullRequest.labels);
        }

        if (currentLabels.includes(keepLabel)) {
          getLogger().debug(`Has ${keepLabel} label (verified from GitHub), skipping`);
          continue;
        }

        const dbLabels = parsePullRequestLabels(pullRequest.labels);
        const hadLabelDrift = JSON.stringify(currentLabels.sort()) !== JSON.stringify(dbLabels.sort());

        // An expired build that is still alive under the disabled label means the label webhook that should have
        // torn it down never arrived.
        staleEnvironments.push({
          namespace: nsName,
          buildUUID,
          build,
          pullRequest,
          daysExpired,
          currentLabels,
          hadLabelDrift,
          action: currentLabels.includes(disabledLabel) ? 'already_disabled' : 'disable_pull_request',
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

  private async cleanupEnvironment(
    env: StaleEnvironment,
    inactivityDays: number,
    commentTemplate: string | undefined,
    dryRun: boolean
  ) {
    switch (env.action) {
      case 'closed_pull_request':
        await this.enqueueClosedPullRequestCleanup(env);
        return;
      case 'expired_sandbox':
        getLogger().info(`TTL: enqueueing expired sandbox cleanup namespace=${env.namespace}`);
        await this.db.services.BuildService.enqueueBuildDeletion(env.build, 'ttl_sandbox_expired');
        return;
      case 'already_disabled':
        getLogger().info(
          `TTL: tearing down disabled environment namespace=${env.namespace} pr=${env.pullRequest.pullRequestNumber}`
        );
        await this.disableAndEnqueueDeletion(env, env.currentLabels);
        return;
      case 'disable_pull_request':
        getLogger().info(`TTL: cleaning namespace=${env.namespace} pr=${env.pullRequest.pullRequestNumber}`);
        await this.cleanupStaleEnvironment(env, inactivityDays, commentTemplate, dryRun);
        return;
    }
  }

  /**
   * Teardown must not depend on the label webhook: if GitHub drops or delays it, the environment would stay up and
   * later scans would skip it for already carrying the disabled label.
   */
  private async disableAndEnqueueDeletion(env: StaleEnvironment, labels: string[]) {
    await env.pullRequest.$query().patch({
      labels: JSON.stringify(labels) as any,
      deployOnUpdate: false,
    });
    await this.db.services.BuildService.enqueueBuildDeletion(env.build, 'deploy_disabled');
  }

  private async enqueueClosedPullRequestCleanup(env: StaleEnvironment) {
    const { build, pullRequest, namespace } = env;
    const buildId = build.id;

    if (!buildId) {
      throw new Error(`TTL cleanup cannot enqueue closed PR cleanup without build id namespace=${namespace}`);
    }

    getLogger().info(
      `TTL: enqueueing closed PR cleanup namespace=${namespace} pr=${pullRequest.pullRequestNumber} status=${pullRequest.status}`
    );

    await this.db.services.BuildService.enqueueBuildDeletion(build, 'ttl_closed_pull_request');
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

    const currentLabels = parsePullRequestLabels(pullRequest.labels);

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
      });

      getLogger().debug(`TTL: cleanup comment posted PR#${pullRequest.pullRequestNumber}`);

      await this.disableAndEnqueueDeletion(env, updatedLabels);

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
