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

import rootLogger from 'server/lib/logger';
import BaseService from './_service';
import { Build, PullRequest } from 'server/models';
import * as YamlService from 'server/models/yaml';
import { BuildStatus } from 'shared/constants';
import { merge } from 'lodash';
import { ConfigFileWebhookEnvironmentVariables } from 'server/lib/configFileWebhookEnvVariables';

import { LifecycleError } from 'server/lib/errors';
import { QUEUE_NAMES } from 'shared/config';
import { redisClient } from 'server/lib/dependencies';
import { validateWebhook } from 'server/lib/webhook/webhookValidator';
import { executeDockerWebhook, executeCommandWebhook } from 'server/lib/webhook';

const logger = rootLogger.child({
  filename: 'services/webhook.ts',
});

export class WebhookError extends LifecycleError {
  constructor(msg: string, uuid: string = null, service: string = null) {
    super(uuid, service, msg);
  }
}
export default class WebhookService extends BaseService {
  /**
   * Import webhook configurations from the YAML config file specific in the PR.
   * @param build The build associates with the pull request
   * @param pullRequest The pull request associates with the branch contains the YAML config file
   * @returns Lifecycle webhooks. Empty array if none can be found in the yaml
   */
  public async upsertWebhooksWithYaml(build: Build, pullRequest: PullRequest): Promise<YamlService.Webhook[]> {
    let webhooks: YamlService.Webhook[] = [];

    // if both pullRequest and build are null, we should not proceed and something is wrong
    if (pullRequest == null && build == null) {
      throw new WebhookError('Pull Request and Build cannot be null when upserting webhooks');
    }

    await pullRequest.$fetchGraph('repository');

    // if build is in classic mode, we should not proceed with yaml webhooks since db webhooks are not supported anymore
    if (build?.environment?.classicModeOnly) return webhooks;

    if (pullRequest.repository != null && pullRequest.branchName != null) {
      const yamlConfig: YamlService.LifecycleConfig = await YamlService.fetchLifecycleConfigByRepository(
        pullRequest.repository,
        pullRequest.branchName
      );

      if (yamlConfig?.environment?.webhooks != null) {
        webhooks = yamlConfig.environment.webhooks;
        await build.$query().patch({ webhooksYaml: JSON.stringify(webhooks) });
        logger.child({ webhooks }).info(`[BUILD ${build.uuid}] Updated build with webhooks from config`);
      } else {
        await build.$query().patch({ webhooksYaml: null });
        logger.info(`[BUILD ${build.uuid}] No webhooks found in config`);
      }
    }
    return webhooks;
  }

  /**
   * Runs all of the webhooks for a build, based on its current state
   * @param build the build for which we want to run webhooks against
   */
  async runWebhooksForBuild(build: Build): Promise<void> {
    // Check feature flag - if disabled, skip all webhooks
    // Only skips if explicitly set to false. If undefined/missing, webhooks execute (default behavior)
    const { features } = await this.db.services.GlobalConfig.getAllConfigs();
    if (features?.webhooks === false) {
      logger.debug(`[BUILD ${build.uuid}] Webhooks feature flag is disabled. Skipping webhook execution.`);
      return;
    }

    switch (build.status) {
      case BuildStatus.DEPLOYED:
      case BuildStatus.ERROR:
      case BuildStatus.TORN_DOWN:
        break;
      default:
        logger.debug(`[BUILD ${build.uuid}] Skipping Lifecycle Webhooks execution for status: ${build.status}`);
        return;
    }

    // if build is not full yaml and no webhooks defined in YAML config, we should not run webhooks (no more db webhook support)
    if (!build.enableFullYaml && build.webhooksYaml == null) {
      logger.debug(
        `[BUILD ${build.uuid}] Skipping Lifecycle Webhooks(non yaml config build) execution for status: ${build.status}`
      );
      return;
    }
    const webhooks: YamlService.Webhook[] = JSON.parse(build.webhooksYaml);
    // no webhooks defined in YAML config, we should not run webhooks
    if (!webhooks) {
      return;
    }

    const configFileWebhooks: YamlService.Webhook[] = webhooks.filter((webhook) => webhook.state === build.status);
    // if no webhooks defined in YAML config, we should not run webhooks
    if (configFileWebhooks != null && configFileWebhooks.length < 1) {
      logger.info(`[BUILD ${build.uuid}] No webhooks found to be triggered for build status: ${build.status}`);
      return;
    }
    logger.info(`[BUILD ${build.uuid}] Triggering for build status: ${build.status}`);
    for (const webhook of configFileWebhooks) {
      logger.info(`[BUILD ${build.uuid}] Running webhook: ${webhook.name}`);
      await this.runYamlConfigFileWebhookForBuild(webhook, build);
    }
  }

  /**
   * Runs a single webhook for a given build
   * @param webhook
   * @param build
   */
  private async runYamlConfigFileWebhookForBuild(webhook: YamlService.Webhook, build: Build): Promise<void> {
    // Validate webhook configuration
    const validationErrors = validateWebhook(webhook);
    if (validationErrors.length > 0) {
      const errorMessage = validationErrors.map((e) => `${e.field}: ${e.message}`).join(', ');
      throw new Error(`Invalid webhook configuration: ${errorMessage}`);
    }

    const envVariables = await new ConfigFileWebhookEnvironmentVariables(this.db).resolve(build, webhook);
    const data = merge(envVariables, build.commentRuntimeEnv);

    try {
      let metadata: Record<string, any> = {};

      switch (webhook.type) {
        case 'codefresh': {
          const buildId: string = await this.db.services.Codefresh.triggerYamlConfigWebhookPipeline(webhook, data);
          logger
            .child({ url: `https://g.codefresh.io/build/${buildId}` })
            .info(`[BUILD ${build.uuid}] Webhook (${webhook.name}) triggered: ${buildId}`);
          metadata = {
            link: `https://g.codefresh.io/build/${buildId}`,
          };
          await this.db.models.WebhookInvocations.create({
            buildId: build.id,
            runUUID: build.runUUID,
            name: webhook.name,
            type: webhook.type,
            state: webhook.state,
            yamlConfig: JSON.stringify(webhook),
            metadata,
            status: 'completed',
          });
          break;
        }

        case 'docker': {
          const invocation = await this.db.models.WebhookInvocations.create({
            buildId: build.id,
            runUUID: build.runUUID,
            name: webhook.name,
            type: webhook.type,
            state: webhook.state,
            yamlConfig: JSON.stringify(webhook),
            metadata: { status: 'starting' },
            status: 'executing',
          });
          logger.info(`[BUILD ${build.uuid}] Docker webhook (${webhook.name}) invoked`);

          // Execute webhook (this waits for completion)
          const result = await executeDockerWebhook(webhook, build, data);
          logger.info(`[BUILD ${build.uuid}] Docker webhook (${webhook.name}) executed: ${result.jobName}`);

          // Update the invocation record with final status
          await invocation.$query().patch({
            metadata: {
              jobName: result.jobName,
              success: result.success,
              ...result.metadata,
            },
            status: result.success ? 'completed' : 'failed',
          });

          break;
        }

        case 'command': {
          const invocation = await this.db.models.WebhookInvocations.create({
            buildId: build.id,
            runUUID: build.runUUID,
            name: webhook.name,
            type: webhook.type,
            state: webhook.state,
            yamlConfig: JSON.stringify(webhook),
            metadata: { status: 'starting' },
            status: 'executing',
          });
          logger.info(`[BUILD ${build.uuid}] Command webhook (${webhook.name}) invoked`);

          // Execute webhook (this waits for completion)
          const result = await executeCommandWebhook(webhook, build, data);
          logger.info(`[BUILD ${build.uuid}] Command webhook (${webhook.name}) executed: ${result.jobName}`);

          // Update the invocation record with final status
          await invocation.$query().patch({
            metadata: {
              jobName: result.jobName,
              success: result.success,
              ...result.metadata,
            },
            status: result.success ? 'completed' : 'failed',
          });

          break;
        }
        default:
          throw new Error(`Unsupported webhook type: ${webhook.type}`);
      }

      logger.debug(`[BUILD ${build.uuid}] Webhook history added for runUUID: ${build.runUUID}`);
    } catch (error) {
      logger.error(`[BUILD ${build.uuid}] Error invoking webhook: ${error}`);

      // Still create a failed invocation record
      await this.db.models.WebhookInvocations.create({
        buildId: build.id,
        runUUID: build.runUUID,
        name: webhook.name,
        type: webhook.type,
        state: webhook.state,
        yamlConfig: JSON.stringify(webhook),
        metadata: { error: error.message },
        status: 'failed',
      });
    }
  }

  /**
   * A queue specifically for triggering webhooks after build complete
   */
  webhookQueue = this.queueManager.registerQueue(QUEUE_NAMES.WEBHOOK_QUEUE, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  processWebhookQueue = async (job) => {
    const buildId = job.data.buildId;
    const build = await this.db.models.Build.query().findOne({
      id: buildId,
    });
    try {
      await this.db.services.Webhook.runWebhooksForBuild(build);
    } catch (e) {
      logger.error(`[BUILD ${build.uuid}] Failed to invoke the webhook: ${e}`);
    }
  };
}
