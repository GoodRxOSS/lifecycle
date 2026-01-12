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
import { Build, Deploy } from 'server/models';
import { DeployTypes, FeatureFlags } from 'shared/constants';
import { getLogger } from 'server/lib/logger/index';
import { ValidationError } from './yamlConfigValidator';
import * as YamlService from 'server/models/yaml';

export class BuildEnvironmentVariables extends EnvironmentVariables {
  /**
   * Retrieve Environment variables. Use lifecycle yaml file while exists; otherwise, falling back to the old LC services table env column.
   * @param deploy LC deploy db model
   * @returns Environment variables key/value pairs per deploy
   */
  private async fetchEnvironmentVariables(deploy: Deploy): Promise<Record<string, any>> {
    let result: Record<string, any> = {};

    await deploy.$fetchGraph('[service.[repository], build.[environment]]');

    if (deploy?.service != null) {
      const { service } = deploy;
      await service.$fetchGraph('repository');

      if (service.env != null) {
        result = service.env;
      }

      if (service.type === DeployTypes.GITHUB && service.repository) {
        try {
          let config: YamlService.LifecycleConfig;
          if (!deploy.build.environment.classicModeOnly) {
            config = await YamlService.fetchLifecycleConfigByRepository(service.repository, deploy.branchName);
          }

          if (config != null) {
            // Merge the database service environment variables with config file ones
            const yamlService: YamlService.Service = YamlService.getDeployingServicesByName(config, service.name);
            if (yamlService !== null && yamlService !== undefined) {
              Object.assign(result, YamlService.getEnvironmentVariables(yamlService));
            }
          }
        } catch (error) {
          if (error instanceof ValidationError) {
            error.uuid = deploy.uuid;
            throw error;
          } else {
            getLogger().warn({ error }, 'EnvVars: fallback to database');
          }
        }
      }
    }

    return result;
  }

  /**
   * Retrieve Init environment variables. Use lifecycle yaml file while exists; otherwise, falling back to the old LC services table env column.
   * @param deploy LC deploy db model
   * @returns Environment variables key/value pairs per deploy
   */
  private async fetchInitEnvironmentVariables(deploy: Deploy): Promise<Record<string, any>> {
    let result: Record<string, any> = {};

    await deploy.$fetchGraph('[service.[repository], build.[environment]]');

    if (deploy?.service != null) {
      // If above works, the :poop: below can all go away!!!!!
      const { service } = deploy;
      await service.$fetchGraph('repository');

      if (service.initEnv != null) {
        result = service.initEnv;
      }

      if (service.type === DeployTypes.GITHUB && service.repository) {
        try {
          let config: YamlService.LifecycleConfig;
          if (!deploy.build.environment.classicModeOnly) {
            config = await YamlService.fetchLifecycleConfigByRepository(service.repository, deploy.branchName);
          }

          if (config != null) {
            // Merge the database service environment variables with config file ones
            const yamlService: YamlService.Service = YamlService.getDeployingServicesByName(config, service.name);
            if (yamlService != null) {
              Object.assign(result, YamlService.getInitEnvironmentVariables(yamlService));
            }
          }
        } catch (error) {
          if (error instanceof ValidationError) {
            error.uuid = deploy.uuid;
            throw error;
          } else {
            getLogger().warn({ error }, 'EnvVars: init fallback to database');
          }
        }
      }
    } else {
      throw new Error(`Deploy and Service object cannot be undefined.`);
    }

    return result;
  }

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
      await build?.$fetchGraph('[services, deploys.[service.[repository], deployable]]');
      const allDeploys = build?.deploys;
      const deploys = githubRepositoryId
        ? allDeploys.filter((d) => d.githubRepositoryId === githubRepositoryId)
        : allDeploys;
      const availableEnv = this.cleanup(await this.availableEnvironmentVariablesForBuild(build));

      const useDeafulttUUID =
        !Array.isArray(build?.enabledFeatures) || !build.enabledFeatures.includes(FeatureFlags.NO_DEFAULT_ENV_RESOLVE);
      const promises = deploys.map(async (deploy) => {
        await deploy
          .$query()
          .patch({
            env: this.parseTemplateData(
              await this.compileEnv(
                build.enableFullYaml && deploy?.deployable?.env
                  ? deploy.deployable.env
                  : await this.fetchEnvironmentVariables(deploy),
                availableEnv,
                useDeafulttUUID,
                build.namespace
              )
            ),
          })
          .catch((error) => {
            getLogger().error({ error }, 'EnvVars: preparation failed');
          });

        if (deploy.deployable?.initDockerfilePath || deploy.service?.initDockerfilePath) {
          await deploy
            .$query()
            .patch({
              initEnv: this.parseTemplateData(
                await this.compileEnv(
                  build.enableFullYaml && deploy?.deployable?.initEnv
                    ? deploy.deployable.initEnv
                    : await this.fetchInitEnvironmentVariables(deploy),
                  availableEnv,
                  useDeafulttUUID,
                  build.namespace
                )
              ),
            })
            .catch((error) => {
              getLogger().error({ error }, 'EnvVars: init preparation failed');
            });
        }
      });

      await Promise.all(promises);
      await build?.$fetchGraph('[services, deploys.[service.[repository], deployable]]');
    }

    return build;
  }
}
