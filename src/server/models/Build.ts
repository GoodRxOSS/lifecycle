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

import { BuildKind, DeployStatus } from 'shared/constants';
import { BuildServiceOverride, Deploy, Deployable, Environment, PullRequest, Service } from '.';
import Model from './_Model';

export default class Build extends Model {
  uuid!: string;
  status!: string;
  statusMessage!: string;
  manifest!: string;
  kind!: BuildKind;

  sha?: string;

  environmentId: number;
  baseBuildId?: number | null;
  environment?: Environment;
  baseBuild?: Build;
  deploys?: Deploy[];
  services?: Service[];
  buildServiceOverrides?: BuildServiceOverride[];
  pullRequest: PullRequest;
  deployables?: Deployable[];

  commentRuntimeEnv: Record<string, any>;
  commentInitEnv: Record<string, any>;

  /* A way to keep track of who is currently in charge of a given build */
  runUUID: string;

  /**
   * Set to true if you want deploys to rebuild if they are tracking a default branch
   * and there was a push to that branch.
   *
   * Setting to false helps reduce churn on services you aren't tracking but "need" for testing.
   */
  trackDefaultBranches: boolean;

  // Whether or not this service tolerates well being run on a spot instance
  capacityType: string;

  // Feature flag to switch to new logic to handle yaml
  enableFullYaml: boolean;
  webhooksYaml: string;

  dashboardLinks: Record<string, string>;

  enabledFeatures: string[];
  isStatic: boolean;
  githubDeployments: boolean;
  dependencyGraph: Record<string, any>;
  namespace: string;

  static tableName = 'builds';
  static timestamps = true;

  static jsonSchema = {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        default: DeployStatus.QUEUED,
      },
      kind: {
        type: 'string',
        default: BuildKind.ENVIRONMENT,
      },
      name: {
        type: 'string',
      },
    },
  };

  static relationMappings = {
    environment: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Environment,
      join: {
        from: 'builds.environmentId',
        to: 'environments.id',
      },
    },
    baseBuild: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Build,
      join: {
        from: 'builds.baseBuildId',
        to: 'builds.id',
      },
    },
    services: {
      relation: Model.ManyToManyRelation,
      modelClass: () => Service,
      join: {
        from: 'builds.id',
        through: {
          from: 'deploys.buildId',
          to: 'deploys.serviceId',
          extra: ['dockerImage'],
        },
        to: 'services.id',
      },
    },
    deploys: {
      relation: Model.HasManyRelation,
      modelClass: () => Deploy,
      join: {
        from: 'builds.id',
        to: 'deploys.buildId',
      },
    },
    pullRequest: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => PullRequest,
      join: {
        from: 'builds.pullRequestId',
        to: 'pull_requests.id',
      },
    },
    buildServiceOverrides: {
      relation: Model.HasManyRelation,
      modelClass: () => BuildServiceOverride,
      join: {
        from: 'builds.id',
        to: 'build_service_overrides.buildId',
      },
    },
    deployables: {
      relation: Model.HasManyRelation,
      modelClass: () => Deployable,
      join: {
        from: ['builds.id', 'builds.uuid'],
        to: ['deployables.buildId', 'deployables.buildUUID'],
      },
    },
  };

  static get jsonAttributes() {
    return ['commentInitEnv', 'commentRuntimeEnv'];
  }
}
