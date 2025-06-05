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

/* eslint-disable no-unused-vars */
import { ref, raw } from 'objection';
import { EmptyFileError, ParsingError, YamlConfigParser } from 'server/lib/yamlConfigParser';
import { ValidationError, YamlConfigValidator } from 'server/lib/yamlConfigValidator';
import Repository from '../Repository';
import { Environment } from './YamlEnvironment';
import { Service, Service001 } from './YamlService';
import rootLogger from 'server/lib/logger';

const logger = rootLogger.child({
  filename: 'models/yaml/Config.ts',
});

export interface LifecycleConfig {
  readonly version: string;
  readonly environment: Environment;
  readonly service?: Service001;
  readonly services: Service[];
}

/**
 *
 * @param repositoryName
 * @param branch
 * @returns
 */
export async function fetchLifecycleConfig(repositoryName: string, branchName: string) {
  let config: LifecycleConfig;

  if (repositoryName != null && branchName != null) {
    const repository: Repository = await resolveRepository(repositoryName);

    if (repository != null) {
      config = await fetchLifecycleConfigByRepository(repository, branchName);
    }
  }

  return config;
}

/**
 * Helper function to retrieve Lifecycle YAML configuration from a specific branch
 * @param repository The github repository to look for the Lifecycle YAML configuration
 * @param branchName The github repository branch to fetch the Lifecycle YAML configuration
 * @returns If valid Lifecycle YAML configuration is found, LifecycleConfig interface will be returned. Otherwise, either EmptyFileError exception or ValidationError exception will be thrown.
 */
export async function fetchLifecycleConfigByRepository(
  repository: Repository,
  branchName: string
): Promise<LifecycleConfig> {
  let config: LifecycleConfig;

  if (repository != null) {
    try {
      config = await new YamlConfigParser().parseYamlConfigFromBranch(repository.fullName, branchName);
    } catch (error) {
      logger.warn(`Unable to fetch configuration from ${repository.fullName}/${branchName}: ${error}`);

      if (error instanceof EmptyFileError) {
        config = null;
      } else if (error instanceof ParsingError || error?.message?.includes('API rate limit exceeded')) {
        throw error;
      }
    }

    if (config != null) {
      // The YAML config file could be syntax correctly but the schema could be wrong.
      try {
        new YamlConfigValidator().validate(config.version, config);
      } catch (error) {
        logger.error(
          `YAML Config validation failed for ${repository.fullName}/${branchName} using version=${config.version}: ${error}`
        );
        throw new ValidationError(error);
      }
    }
  }

  return config;
}

/**
 * Helper function to retrieve a specific Lifecycle service by name, which should be uniqued.
 * @param config LifecycleConfig interface contains valid Lifecycle configuration
 * @param serviceName The name of the Lifecycle service
 * @returns Returning the valid Lifecycle service configuration if the name can be found; otherwise, return undefined. If more than 1 service is found, return the very first one from the list.
 */
export function getDeployingServicesByName(config: LifecycleConfig, serviceName: string): Service {
  let result: Service;
  try {
    if (config != null && serviceName != null) {
      if (config.services != null && config.services.length > 0) {
        result = config.services.find((service) => serviceName.localeCompare(service.name) === 0);
      }
    }
  } catch (error) {
    logger
      .child({ error })
      .error(`There was a problem getting the service by its name while searching for ${serviceName} service`);
    throw error;
  }

  return result;
}

/**
 *
 * @param repositoryFullName
 * @returns
 */
export async function resolveRepository(repositoryFullName: string): Promise<Repository> {
  let repository: Repository;
  try {
    if (repositoryFullName != null) {
      const key = ref('repositories.fullName').castText();
      const repositories: Repository[] = await Repository.query()
        .where(raw('LOWER(??)', [key]), '=', `${repositoryFullName.toLowerCase()}`)
        .catch((error) => {
          logger.error(
            `Unable to find ${repositoryFullName} from Lifecycle Database. Note that repository name is case sensitive: ${error}`
          );
          return null;
        });

      if (repositories.length > 0) {
        repository = repositories[0];
      }
    }
  } catch (error) {
    logger.error(
      `There was a problem resolving the repository from the repository name: ${repositoryFullName} \n Error: ${error}`
    );
    throw error;
  }

  return repository;
}
