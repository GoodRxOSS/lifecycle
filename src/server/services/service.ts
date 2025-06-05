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

import rootLogger from 'server/lib/logger';
import { Environment, Repository } from 'server/models';
import ServiceModel from 'server/models/Service';
import { CAPACITY_TYPE, DeployTypes } from 'shared/constants';
import BaseService from './_service';
import GlobalConfigService from './globalConfig';

const logger = rootLogger.child({
  filename: 'services/service.ts',
});

export default class ServiceService extends BaseService {
  async findOrCreateDefaultService(environment: Environment, repository: Repository): Promise<ServiceModel[]> {
    let services: ServiceModel[] = [];

    try {
      await environment.$fetchGraph('[defaultServices]');
      if (environment.defaultServices != null && environment.defaultServices.length > 0) {
        logger.debug(
          `[${environment.name}] There is/are ${environment.defaultServices.length} default dependency service(s) in the database.`
        );
        services = environment.defaultServices;
      } else {
        const { serviceDefaults, lifecycleDefaults, domainDefaults } =
          await GlobalConfigService.getInstance().getAllConfigs();
        const defaultUUID = lifecycleDefaults?.defaultUUID;
        const service: ServiceModel = await this.db.models.Service.create({
          name: environment.name,
          type: DeployTypes.GITHUB,
          repositoryId: repository.githubRepositoryId,
          defaultTag: 'main',
          dockerfilePath: 'sysops/dockerfiles/app.Dockerfile',
          port: 8080,
          env: '{}',
          environmentId: environment.id,
          branchName: 'main',
          public: true,
          cpuRequest: '10m',
          memoryRequest: '100Mi',
          readinessInitialDelaySeconds: 0,
          readinessPeriodSeconds: 10,
          readinessTimeoutSeconds: 1,
          readinessSuccessThreshold: 1,
          readinessFailureThreshold: 30,
          readinessTcpSocketPort: 8090,
          readinessHttpGetPath: '/__lbheartbeat__',
          readinessHttpGetPort: 8080,
          host: domainDefaults.http,
          acmARN: serviceDefaults.acmARN,
          initEnv: '{}',
          hostPortMapping: '{}',
          defaultInternalHostname: environment.name + `-${defaultUUID}`,
          defaultPublicUrl: environment.name + `-${defaultUUID}.${domainDefaults.http}`,
          defaultUUID: defaultUUID,
          ipWhitelist: serviceDefaults.defaultIPWhiteList,
          pathPortMapping: '{}',
          detatchAfterBuildPipeline: false,
          grpc: false,
          grpcHost: domainDefaults.grpc,
          capacityType: CAPACITY_TYPE.ON_DEMAND,
        });

        if (service) {
          services = services.concat(service);
          await environment.$relatedQuery('defaultServices').relate(service);
        }
      }
    } catch (error) {
      logger.error(error);
      throw error;
    }

    return services;
  }
}
