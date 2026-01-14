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

import { ref, raw } from 'objection';
import { DEPLOY_TYPES } from 'shared/constants';
import { YamlConfigValidator } from 'server/lib/yamlConfigValidator';
import { YamlConfigParser } from 'server/lib/yamlConfigParser';
import Repository from 'server/models/Repository';
import { Service } from 'server/models/yaml/types';

import { getLogger } from 'server/lib/logger';

export const isInObj = (obj, key) => (!obj ? false : key in obj);

export const getDeployType = (service: Service): string =>
  Object.keys(service).find((key) => DEPLOY_TYPES.includes(key));

export const resolveRepository = async (repositoryFullName: string) => {
  if (!repositoryFullName) return;
  try {
    const key = ref('repositories.fullName').castText();
    const name = repositoryFullName.toLowerCase();
    const repositories = await Repository.query()
      .where(raw('LOWER(??)', [key]), '=', name)
      .catch((error) => {
        getLogger().error({ error }, `Repository: not found name=${repositoryFullName}`);
        return null;
      });
    if (!repositories || repositories?.length === 0) {
      throw new Error(`Unable to find ${repositoryFullName} from Lifecycle Database`);
    }
    return repositories[0];
  } catch (err) {
    getLogger().error({ error: err }, `Repository: resolution failed name=${repositoryFullName}`);
  }
};

export const fetchLifecycleConfigByRepository = async (repository: Repository, branchName: string) => {
  if (!repository || !branchName) return null;
  const parser = new YamlConfigParser();
  try {
    const name = repository?.fullName;
    const isClassicModeOnly = repository?.defaultEnvironment?.classicModeOnly ?? false;
    const config = !isClassicModeOnly ? await parser.parseYamlConfigFromBranch(name, branchName) : null;
    if (!config) throw new Error(`Unable to fetch configuration from ${name}/${branchName}`);
    const configVersion = config?.version;
    if (!configVersion) throw new Error(`YAML Config version is missing for ${name}/${branchName}`);
    const validator = new YamlConfigValidator();
    const isConfigValid = validator.validate(configVersion, config);
    if (!isConfigValid) {
      getLogger().error(`Config: validation failed repo=${name}/${branchName} version=${configVersion}`);
      // TODO: This is a temporary fix to allow the UI to display the config
      // throw new Error(
      //   `YAML Config validation failed for ${name}/${branchName} using version Lifecyle Yaml version=${configVersion}`
      // );
    }
    return config;
  } catch (err) {
    getLogger().error({ error: err }, `Config: fetch failed`);
    return null;
  }
};
