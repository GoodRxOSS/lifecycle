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

import { EnvironmentVariables } from 'server/lib/envVariables';
import { Build } from 'server/models';
import { getLogger } from 'server/lib/logger/index';
import { Webhook } from 'server/models/yaml';
import { FeatureFlags } from 'shared/constants';

export class ConfigFileWebhookEnvironmentVariables extends EnvironmentVariables {
  /**
   * Use lifecycle yaml file while exists; otherwise, falling back to the old LC services table env column.
   * @param deploy LC deploy db model
   * @returns Environment variables key/value pairs per deploy
   */
  private async fetchEnvironmentVariablesFromWebhook(webhook: Webhook): Promise<Record<string, any>> {
    return webhook.env || {};
  }

  /**
   * Determines all of the environment variables for a given build.
   * @param build the build to resolve environment variables for
   */
  public async resolve(build: Build, webhook: Webhook): Promise<Record<string, any>> {
    let result: Record<string, any>;

    if (build != null) {
      await build?.$fetchGraph('[services, deploys.service.repository]');
      const availableEnv = this.cleanup(await this.availableEnvironmentVariablesForBuild(build));
      const useDefaultUUID =
        !Array.isArray(build?.enabledFeatures) || !build.enabledFeatures.includes(FeatureFlags.NO_DEFAULT_ENV_RESOLVE);

      result = this.parseTemplateData(
        await this.compileEnv(
          await this.fetchEnvironmentVariablesFromWebhook(webhook),
          availableEnv,
          useDefaultUUID,
          build.namespace
        )
      );

      await build?.$fetchGraph('[services, deploys.service.repository]');
    } else {
      getLogger().fatal("Build and Webhook shouldn't be undefined");
    }

    return result;
  }
}
