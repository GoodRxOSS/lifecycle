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
import { DeployStatus } from 'shared/constants';
import { Service, Build, Deployable, Repository } from '.';
import { KedaScaleToZero } from './yaml/YamlService';

export default class Deploy extends Model {
  uuid: string;
  status!: DeployStatus;
  statusMessage!: string;
  dockerImage!: string;
  initDockerImage: string;
  initEnv: Record<string, any>;
  ipAddress!: string;
  publicUrl: string;
  env: Record<string, any>;
  port: number;
  buildLogs: string;
  containerLogs: string;
  branchName: string;
  tag: string;
  githubRepositoryId: number;
  internalHostname: string;
  sha: string;
  cname: string;

  serviceId: number;
  service: Service;

  buildId: number;
  build: Build;

  deployableId: number;
  deployable?: Deployable;

  runUUID: string;

  replicaCount: number;

  // Whether or not this service is actually active
  active: boolean;

  repository: Repository;
  runningImage?: string;
  isRunningLatest?: boolean;
  githubDeploymentId?: number;
  deployPipelineId?: string;
  kedaScaleToZero: KedaScaleToZero;
  buildPipelineId: string;
  buildOutput: string;
  deployOutput: string;
  buildJobName: string;
  manifest: string;

  static tableName = 'deploys';
  static timestamps = true;

  static jsonSchema = {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        default: DeployStatus.PENDING,
      },
    },
  };

  static relationMappings = {
    service: {
      relation: Model.BelongsToOneRelation,
      modelClass: Service,
      join: {
        from: 'deploys.serviceId',
        to: 'services.id',
      },
    },
    build: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Build,
      join: {
        from: 'deploys.buildId',
        to: 'builds.id',
      },
    },
    repository: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Repository,
      join: {
        from: 'deploys.githubRepositoryId',
        to: 'repositories.githubRepositoryId',
      },
    },
    deployable: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Deployable,
      join: {
        from: 'deploys.deployableId',
        to: 'deployables.id',
      },
    },
  };

  static get jsonAttributes() {
    return ['env', 'initEnv'];
  }
}
