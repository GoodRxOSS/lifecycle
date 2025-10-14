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
import { DeployTypes } from 'shared/constants';
import { Environment, Repository, ServiceDisk } from '.';
import { createColumnMapper } from 'server/lib/columnMappers';

export default class Service extends Model {
  name!: string;
  type!: DeployTypes;
  layer: number;
  public: boolean;
  dockerImage: string;
  dockerfilePath: string;
  // Dockerfile path specifically for the init container.
  initDockerfilePath: string;
  branchName: string;
  repositoryId: string;
  defaultTag: string;
  port: string;
  env!: Record<string, any>;
  initEnv!: Record<string, any>;
  hostPortMapping!: Record<string, any>;
  pathPortMapping!: Record<string, any>;
  command: string;
  // Comamnd specifically for the init container
  initCommand: string;
  arguments: string;
  // Arguments specifically for the init command
  initArguments: string;
  // The environment ID field is deprecated. It was replaced by DefaultServices and OptionalServices tables.
  environmentId!: number;
  host: string;
  grpcHost: string;
  acmARN: string;

  // Resource limits
  memoryRequest: string;
  memoryLimit: string;
  cpuRequest: string;
  cpuLimit: string;

  // Probes
  readinessInitialDelaySeconds: number;
  readinessPeriodSeconds: number;
  readinessTimeoutSeconds: number;
  readinessSuccessThreshold: number;
  readinessFailureThreshold: number;
  readinessTcpSocketPort: number;
  readinessHttpGetPath: string;
  readinessHttpGetPort: number;

  serviceDisks: ServiceDisk[];

  environment?: Environment;
  repository?: Repository;

  // A fallback hostname in the event we don't want to spin up a dedicate service
  defaultInternalHostname: string;
  defaultPublicUrl: string;
  defaultGrpcHost: string;

  // The fallback UUID for this service, that we can use in the event a service checkbox is not selected
  defaultUUID: string;

  // Optional service dependency, which we can use to determine whether or not to spin up a particular service
  dependsOnServiceId: number;
  dependsOnService: Service;

  // Codefresh deploy pipeline ID (required)
  deployPipelineId: string;
  destroyPipelineId: string;

  // Codefresh deploy / destroy trigger names (optional)
  deployTrigger: string;
  destroyTrigger: string;

  ipWhitelist: string[];

  afterBuildPipelineId: string;
  detatchAfterBuildPipeline: boolean;

  grpc: boolean;

  // Whether or not this service tolerates well being run on a spot instance
  capacityType: string;

  // The codefresh runtime to use when building this service
  runtimeName: string;

  // The codefresh pipeline to use when building this service
  dockerBuildPipelineName: string;

  ingressAnnotations: Record<string, any>;

  nodeSelector: Record<string, string>;
  nodeAffinity: Record<string, unknown>;

  static tableName = 'services';
  static timestamps = true;

  static relationMappings = {
    environment: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Environment,
      join: {
        from: 'services.environmentId',
        to: 'environments.id',
      },
    },
    repository: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Repository,
      join: {
        from: 'services.repositoryId',
        to: 'repositories.githubRepositoryId',
      },
    },
    serviceDisks: {
      relation: Model.HasManyRelation,
      modelClass: () => ServiceDisk,
      join: {
        from: 'services.id',
        to: 'services_disks.serviceId',
      },
    },
  };

  static jsonSchema = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
      },
    },
  };

  static get jsonAttributes() {
    return ['env', 'initEnv', 'hostPortMapping', 'pathPortMapping', 'ipWhitelist', 'nodeSelector', 'nodeAffinity'];
  }

  // Map specific camelCase property names to snake_case column names
  static columnNameMappers = createColumnMapper({
    nodeSelector: 'node_selector',
    nodeAffinity: 'node_affinity',
  });

  $parseDatabaseJson(json: any) {
    json = super.$parseDatabaseJson(json);
    return (this.constructor as typeof Service).columnNameMappers.parse(json);
  }

  $formatDatabaseJson(json: any) {
    json = (this.constructor as typeof Service).columnNameMappers.format(json);
    return super.$formatDatabaseJson(json);
  }
}
