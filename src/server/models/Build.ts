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
import { Deploy, Deployable, Environment, PullRequest, Service } from '.';
import Model from './_Model';

export default class Build extends Model {
  uuid!: string;
  /**
   * queued → pending → building → built → deploying → deployed
   * (API creates start at queued; webhook builds enter at pending;
   *  error/config_error from any stage; tearing_down → torn_down terminal.)
   */
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
  pullRequest?: PullRequest | null;
  pullRequestId?: number | null;
  deployables?: Deployable[];

  /* Trigger context for PR-less (API-created) builds; NULL/'github_pr' for webhook builds. */
  triggerType?: 'github_pr' | 'api';
  githubRepositoryId?: number | null;
  branchName?: string | null;
  configSha?: string | null;
  deployEnabled?: boolean | null;
  expiresAt?: string | null;
  idempotencyKey?: string | null;
  idempotencyRequestDigest?: string | null;
  createdByTokenId?: number | null;
  /* Human attribution for API-created envs (from the owner of a user token or a JWT user); null for org tokens. */
  createdByUserId?: string | null;
  createdByGithubLogin?: string | null;
  autoTrack?: boolean;

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

  webhooksYaml: string;

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
