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

import { IServices } from 'server/services/types';
import rootLogger from '../lib/logger';
import { defaultDb, redisClient } from 'server/lib/dependencies';
import RedisClient from 'server/lib/redisClient';
import QueueManager from 'server/lib/queueManager';
import { MAX_GITHUB_API_REQUEST, GITHUB_API_REQUEST_INTERVAL, QUEUE_NAMES } from 'shared/config';

let isBootstrapped = false;

const logger = rootLogger.child({
  filename: 'jobs/index.ts',
});

export default function bootstrapJobs(services: IServices) {
  if (defaultDb.services) {
    return;
  }

  logger.info(`Bootstrapping jobs...... Yes`);
  const queueManager = QueueManager.getInstance();

  queueManager.registerWorker(QUEUE_NAMES.WEBHOOK_PROCESSING, services.GithubService.processWebhooks, {
    connection: redisClient.getConnection(),
    concurrency: 125,
  });

  queueManager.registerWorker(QUEUE_NAMES.COMMENT_QUEUE, services.ActivityStream.processComments, {
    connection: redisClient.getConnection(),
    concurrency: 2,
    limiter: {
      max: MAX_GITHUB_API_REQUEST,
      duration: GITHUB_API_REQUEST_INTERVAL,
    },
  });

  /* Run once per hour */
  services.PullRequest.cleanupClosedPRQueue.add(
    'cleanup',
    {},
    {
      repeat: {
        every: 60000 * 60, // Once an hour
      },
    }
  );

  queueManager.registerWorker(QUEUE_NAMES.CLEANUP, services.PullRequest.processCleanupClosedPRs, {
    connection: redisClient.getConnection(),
    concurrency: 1,
  });

  services.GlobalConfig.setupCacheRefreshJob();

  queueManager.registerWorker(QUEUE_NAMES.GLOBAL_CONFIG_CACHE_REFRESH, services.GlobalConfig.processCacheRefresh, {
    connection: redisClient.getConnection(),
    concurrency: 1,
  });

  services.PullRequest.cleanupClosedPRQueue.add('cleanup', {}, {});

  queueManager.registerWorker(QUEUE_NAMES.INGRESS_MANIFEST, services.Ingress.createOrUpdateIngressForBuild, {
    connection: redisClient.getConnection(),
    concurrency: 1,
  });

  queueManager.registerWorker(QUEUE_NAMES.INGRESS_CLEANUP, services.Ingress.ingressCleanupForBuild, {
    connection: redisClient.getConnection(),
    concurrency: 1,
  });

  queueManager.registerWorker(QUEUE_NAMES.DELETE_QUEUE, services.BuildService.processDeleteQueue, {
    connection: redisClient.getConnection(),
    concurrency: 20,
  });

  queueManager.registerWorker(QUEUE_NAMES.WEBHOOK_QUEUE, services.Webhook.processWebhookQueue, {
    connection: redisClient.getConnection(),
    concurrency: 10,
  });

  queueManager.registerWorker(QUEUE_NAMES.RESOLVE_AND_DEPLOY, services.BuildService.processResolveAndDeployBuildQueue, {
    connection: redisClient.getConnection(),
    concurrency: 125,
  });

  /**
   * The actual build queue
   */
  queueManager.registerWorker(QUEUE_NAMES.BUILD_QUEUE, services.BuildService.processBuildQueue, {
    connection: redisClient.getConnection(),
    concurrency: 125,
  });

  queueManager.registerWorker(QUEUE_NAMES.GITHUB_DEPLOYMENT, services.GithubService.processGithubDeployment, {
    connection: redisClient.getConnection(),
    concurrency: 125,
  });

  defaultDb.services = services;

  if (process.env.NEXT_MANUAL_SIG_HANDLE) {
    if (!isBootstrapped) {
      isBootstrapped = true;

      // This function is used to handle graceful shutdowns add things as needed.
      const handleExit = async (signal: string) => {
        logger.info(` ✍️Shutting down (${signal})`);
        try {
          const redisClient = RedisClient.getInstance();
          const queueManager = QueueManager.getInstance();
          await queueManager.emptyAndCloseAllQueues();
          await redisClient.close();
          process.exit(0);
        } catch (error) {
          logger.info(`Unable to shutdown gracefully: ${error}`);
          process.exit(0);
        }
      };

      process.on('SIGINT', () => handleExit('SIGINT'));
      process.on('SIGTERM', () => handleExit('SIGTERM'));
      logger.info(' ✍️Signal handlers registered');
    }
  }
  logger.info('Bootstrapping complete');
}
