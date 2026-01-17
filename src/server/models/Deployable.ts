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
import { Environment, Repository, Service, ServiceDisk } from '.';
import { Builder, Helm, KedaScaleToZero } from './yaml/YamlService';

export default class Deployable extends Service {
  static tableName = 'deployables';
  static timestamps = true;

  buildUUID: string;
  serviceId: number;
  buildId: number;
  serviceDisksYaml: string;
  active: boolean;
  dependsOnDeployableId: number;
  dependsOnDeployableName: string;
  defaultBranchName: string;
  commentBranchName: string;
  appShort?: string;
  ecr?: string;
  helm: Helm;
  deploymentDependsOn: string[];
  kedaScaleToZero: KedaScaleToZero;
  builder: Builder;
  envLens?: boolean;

  static relationMappings = {
    environment: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Environment,
      join: {
        from: 'deployables.environmentId',
        to: 'environments.id',
      },
    },
    repository: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Repository,
      join: {
        from: 'deployables.repositoryId',
        to: 'repositories.githubRepositoryId',
      },
    },
    serviceDisks: {
      relation: Model.HasManyRelation,
      modelClass: () => ServiceDisk,
      join: {
        from: 'deployables.serviceId',
        to: 'services_disks.serviceId',
      },
    },
  };
}
