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
import { DeployTypes, FeatureFlags } from 'shared/constants';
import { getLogger } from 'server/lib/logger';

export class BuildEnvironmentVariables extends EnvironmentVariables {
  /**
   * Now we need to resolve the environment the service expects
   * Once we have the resolved environment for each service in place, we'll
   * need to regenerate and reapply our manifest
   * 1. Loop through deploys
   * 2. Interpolate env from deploy parent service (via db or yaml definition for specific branch)
   * 3. Save to deploy
   * @param build Build model from associated PR
   * @param githubRepositoryId Optional filter to only resolve env for deploys from a specific repo
   * @returns Map of env variables
   */
  public async resolve(build: Build, githubRepositoryId?: number): Promise<Record<string, any>> {
    if (build != null) {
      await build?.$fetchGraph('[services, deploys.[deployable]]');
      const allDeploys = build?.deploys;
      const deploys = githubRepositoryId
        ? allDeploys.filter((d) => d.githubRepositoryId === githubRepositoryId)
        : allDeploys;
      const availableEnv = this.cleanup(await this.availableEnvironmentVariablesForBuild(build));

      const useDeafulttUUID =
        !Array.isArray(build?.enabledFeatures) || !build.enabledFeatures.includes(FeatureFlags.NO_DEFAULT_ENV_RESOLVE);
      const promises = deploys.map(async (deploy) => {
        // Configuration deploys are never built or deployed; their data is consumed
        // directly into availableEnv from deployable.env (see configurationServiceEnvironments).
        // Skip patching deploy.env so we never persist the (possibly secret-ref-bearing)
        // configuration data as plaintext on the unused configuration deploy.
        if (deploy.deployable?.type === DeployTypes.CONFIGURATION) {
          return;
        }

        await deploy
          .$query()
          .patch({
            env: this.parseTemplateData(
              await this.compileEnv(deploy.deployable?.env ?? {}, availableEnv, useDeafulttUUID, build.namespace)
            ),
          })
          .catch((error) => {
            getLogger().error({ error }, 'EnvVars: preparation failed');
          });

        if (deploy.deployable?.initDockerfilePath) {
          await deploy
            .$query()
            .patch({
              initEnv: this.parseTemplateData(
                await this.compileEnv(deploy.deployable?.initEnv ?? {}, availableEnv, useDeafulttUUID, build.namespace)
              ),
            })
            .catch((error) => {
              getLogger().error({ error }, 'EnvVars: init preparation failed');
            });
        }
      });

      await Promise.all(promises);
      await build?.$fetchGraph('[services, deploys.[deployable]]');
    }

    return build;
  }
}
