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

import Model from './_Model';
import { PullRequest, Environment } from '.';

export default class Repository extends Model {
  githubRepositoryId: number;
  githubInstallationId: number;
  ownerId: number;
  fullName: string;
  htmlUrl: string;

  defaultEnvId: number;
  defaultEnvironment?: Environment;
  pullRequests?: PullRequest[];

  static tableName = 'repositories';
  static timestamps = true;

  static relationMappings = {
    defaultEnvironment: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Environment,
      join: {
        from: 'repositories.defaultEnvId',
        to: 'environments.id',
      },
    },

    pullRequests: {
      relation: Model.HasManyRelation,
      modelClass: () => PullRequest,
      join: {
        from: 'repositories.id',
        to: 'pull_requests.repositoryId',
      },
    },
  };
}
