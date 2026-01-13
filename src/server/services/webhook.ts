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

import { withLogContext, getLogger, LogStage, updateLogContext } from 'server/lib/logger';
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

    if (build?.uuid) {
      updateLogContext({ buildUuid: build.uuid });
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
        getLogger().info(`Webhook: config updated webhooks=${JSON.stringify(webhooks)}`);
      } else {
        await build.$query().patch({ webhooksYaml: null });
        getLogger().info('Webhook: config empty');
      }
    }
    return webhooks;
  }

  /**
   * Runs all of the webhooks for a build, based on its current state
   * @param build the build for which we want to run webhooks against
   */
  async runWebhooksForBuild(build: Build): Promise<void> {
    updateLogContext({ buildUuid: build.uuid });

    // Check feature flag - if disabled, skip all webhooks
    // Only skips if explicitly set to false. If undefined/missing, webhooks execute (default behavior)
    const { features } = await this.db.services.GlobalConfig.getAllConfigs();
    if (features?.webhooks === false) {
      getLogger().debug('Webhooks feature flag is disabled, skipping webhook execution');
      return;
    }

    switch (build.status) {
      case BuildStatus.DEPLOYED:
      case BuildStatus.ERROR:
      case BuildStatus.TORN_DOWN:
        break;
      default:
        getLogger().debug(`Skipping Lifecycle Webhooks execution for status: ${build.status}`);
        return;
    }

    // if build is not full yaml and no webhooks defined in YAML config, we should not run webhooks (no more db webhook support)
    if (!build.enableFullYaml && build.webhooksYaml == null) {
      getLogger().debug(`Skipping Lifecycle Webhooks (non yaml config build) execution for status: ${build.status}`);
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
      getLogger().info(`Webhook: skipped reason=noMatch status=${build.status}`);
      return;
    }
    getLogger().info(`Webhook: triggering status=${build.status}`);
    for (const webhook of configFileWebhooks) {
      await withLogContext({ webhookName: webhook.name, webhookType: webhook.type }, async () => {
        getLogger().info(`Webhook: running name=${webhook.name}`);
        await this.runYamlConfigFileWebhookForBuild(webhook, build);
      });
    }
    getLogger({ stage: LogStage.WEBHOOK_COMPLETE }).info(
      `Webhook: completed count=${configFileWebhooks.length} status=${build.status}`
    );
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
          getLogger().info(`Webhook: triggered buildId=${buildId} url=https://g.codefresh.io/build/${buildId}`);
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
          getLogger().info(`Webhook: invoking`);

          // Execute webhook (this waits for completion)
          const result = await executeDockerWebhook(webhook, build, data);
          getLogger().info(`Webhook: executed jobName=${result.jobName}`);

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
          getLogger().info(`Webhook: invoking`);

          // Execute webhook (this waits for completion)
          const result = await executeCommandWebhook(webhook, build, data);
          getLogger().info(`Webhook: executed jobName=${result.jobName}`);

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

      getLogger().debug(`Webhook: history added runUUID=${build.runUUID}`);
    } catch (error) {
      getLogger({ error }).error('Webhook: invocation failed');

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
    const { buildId, sender, correlationId, _ddTraceContext } = job.data;

    return withLogContext({ correlationId, sender, _ddTraceContext }, async () => {
      const build = await this.db.models.Build.query().findOne({
        id: buildId,
      });

      if (build?.uuid) {
        updateLogContext({ buildUuid: build.uuid });
      }

      try {
        await this.db.services.Webhook.runWebhooksForBuild(build);
      } catch (e) {
        getLogger({ stage: LogStage.WEBHOOK_PROCESSING }).error({ error: e }, 'Webhook: invocation failed');
      }
    });
  };
}
