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

import { getLogger } from 'server/lib/logger';
import Environment from 'server/models/Environment';
import Service from './_service';

export default class EnvironmentService extends Service {
  /**
   * Retrieve a Lifecycle environment. If it doesn't exist, create a new record.
   * @param envName Lifecycle environment name. Usually, it is the same as the Lifecycle service name since it's a 1 to 1 relationship.
   * @param uuid Environemnt UUID. Not being in used.
   * @returns Lifecycle Github Repository model.
   */
  async findOrCreateEnvironment(envName: string, uuid?: string, autoDeploy = false) {
    let env: Environment;

    try {
      if (uuid === undefined && uuid === null) {
        uuid = envName;
      }

      env =
        (await this.db.models.Environment.findOne({
          name: envName,
        })) ||
        (await this.db.models.Environment.create({
          name: envName,
          uuid,
          enableFullYaml: true,
          autoDeploy,
        }));
    } catch (error) {
      getLogger({ environment: envName, uuid, error }).fatal('Unable to find or create environment');
      throw error;
    }

    return env;
  }

  public enableFullYamlSupport(environment: Environment): boolean {
    return environment.enableFullYaml;
  }
}
