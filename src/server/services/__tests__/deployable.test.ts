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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

import * as YamlService from 'server/models/yaml';
import GlobalConfigService from 'server/services/globalConfig';
import DeployableService, { DeployableAttributes } from '../deployable';

jest.mock('server/services/globalConfig');

const lifecycleDefaults = {
  defaultUUID: 'mockedUUID',
  defaultPublicUrl: 'mockedPublicUrl',
  buildPipeline: 'lifecycle/lifecycle-build',
  ecrDomain: 'account-id.dkr.ecr.us-west-2.amazonaws.com',
  ecrRegistry: 'lfc',
};

const serviceDefaults = {
  dockerfilePath: 'sysops/dockerfiles/app.Dockerfile',
  cpuRequest: '10m',
  memoryRequest: '100Mi',
  readinessInitialDelaySeconds: 0,
  readinessPeriodSeconds: 10,
  readinessTimeoutSeconds: 1,
  readinessSuccessThreshold: 1,
  readinessFailureThreshold: 30,
  readinessTcpSocketPort: 8090,
  readinessHttpGetPort: 8080,
  readinessHttpGetPath: '/__lbheartbeat__',
  acmARN: 'arn:aws:acm:us-west-2:account-id:certificate/ceritifcate-id',
  grpc: false,
  defaultIPWhiteList: '{ 70.52.40.40/32,160.72.36.84/32 }',
};

const domainDefaults = {
  http: 'lifecycle.example.com',
  grpc: 'lifecycle-grpc.example.com',
};

const mockedGetAllConfigs = jest.fn().mockResolvedValue({
  lifecycleDefaults: lifecycleDefaults,
  serviceDefaults: serviceDefaults,
  domainDefaults: domainDefaults,
});

const mockedInstance = {
  getAllConfigs: mockedGetAllConfigs,
};

(GlobalConfigService.getInstance as jest.Mock).mockReturnValue(mockedInstance);
describe('Deployable Service', () => {
  describe('generateAttributesFromYamlConfig', () => {
    const deployableService: DeployableService = new DeployableService(null, null, null);

    test('Generates from Github Service Type Configuration', async () => {
      const githubService: YamlService.GithubService = {
        name: 'github-app',
        requires: [
          { name: 'github-db' },
          { name: 'test-db', repository: 'iceycake/test', branch: 'main' },
          { serviceId: 23 },
        ],
        github: {
          repository: 'org/lifecycle-test',
          branchName: 'unit-test',
          docker: {
            defaultTag: 'main',
            app: {
              dockerfilePath: 'app1/app.Dockerfile',
              command: 'server',
              arguments: 'docker/scripts/lifecycle/startup.sh',
              env: {
                SOURCE: 'yaml',
                TOKEN1: 'abcdefghijk',
              },
              ports: [8080, 8089, 8888],
            },
            init: {
              dockerfilePath: 'app1/init.Dockerfile',
              command: 'sh',
              arguments:
                '-c%%SPLIT%%local%%SPLIT%%-i%%SPLIT%%./sysops/ansible/spinnaker_inventory.py%%SPLIT%%./sysops/ansible/playbooks/lifecycle.yaml',
              env: {
                ENV: 'lifecycle',
                COMPONENT: 'app',
              },
            },
          },
          deployment: {
            public: false,
            capacityType: 'SPOT',
            resource: {
              cpu: {
                limit: '1000m',
                request: '50m',
              },
              memory: {
                limit: '1000Mi',
                request: '500Mi',
              },
            },
            readiness: {
              httpGet: {
                path: '/hello',
                port: 10500,
              },
              tcpSocketPort: 10500,
            },
            network: {
              grpc: {
                enable: true,
              },
              hostPortMapping: {
                admin: '9991',
                callback: '9990',
                web: '8080',
              },
            },
          },
        },
      };

      // @ts-ignore
      const result: DeployableAttributes = await deployableService.generateAttributesFromYamlConfig(
        100,
        'unit-test-12345',
        '1234567890',
        'unit-test',
        githubService
      );
      expect(result).toEqual({
        name: 'github-app',
        serviceId: null,
        type: 'github',
        buildUUID: 'unit-test-12345',
        buildId: 100,
        repositoryId: '1234567890',
        branchName: 'unit-test',
        defaultUUID: lifecycleDefaults.defaultUUID,
        dockerfilePath: 'app1/app.Dockerfile',
        command: 'server',
        arguments: 'docker/scripts/lifecycle/startup.sh',
        env: {
          SOURCE: 'yaml',
          TOKEN1: 'abcdefghijk',
        },
        port: '8080,8089,8888',
        initArguments:
          '-c%%SPLIT%%local%%SPLIT%%-i%%SPLIT%%./sysops/ansible/spinnaker_inventory.py%%SPLIT%%./sysops/ansible/playbooks/lifecycle.yaml',
        initCommand: 'sh',
        initDockerfilePath: 'app1/init.Dockerfile',
        initEnv: {
          ENV: 'lifecycle',
          COMPONENT: 'app',
        },
        dockerImage: undefined,
        defaultTag: 'main',
        afterBuildPipelineId: undefined,
        appShort: undefined,
        ecr: 'lfc/lifecycle-deployments',
        builder: {},
        public: false,
        capacityType: 'SPOT',

        cpuLimit: '1000m',
        cpuRequest: '50m',
        memoryLimit: '1000Mi',
        memoryRequest: '500Mi',

        readinessFailureThreshold: 30,
        readinessHttpGetPath: null,
        readinessHttpGetPort: null,
        readinessInitialDelaySeconds: 0,
        readinessPeriodSeconds: 10,
        readinessSuccessThreshold: 1,
        readinessTcpSocketPort: 10500,
        readinessTimeoutSeconds: 1,

        host: domainDefaults.http,
        acmARN: 'arn:aws:acm:us-west-2:account-id:certificate/ceritifcate-id',
        defaultInternalHostname: `github-app-${lifecycleDefaults.defaultUUID}`,
        defaultPublicUrl: `github-app-${lifecycleDefaults.defaultUUID}.${domainDefaults.http}`,

        ipWhitelist: '{ 70.52.40.40/32,160.72.36.84/32 }',
        hostPortMapping: {
          admin: '9991',
          callback: '9990',
          web: '8080',
        },
        ingressAnnotations: {},
        pathPortMapping: {},
        grpc: true,
        grpcHost: domainDefaults.grpc,
        defaultGrpcHost: `github-app-${lifecycleDefaults.defaultUUID}.${domainDefaults.grpc}`,

        detatchAfterBuildPipeline: false,
        deployPipelineId: null,
        deployTrigger: null,
        destroyPipelineId: null,
        destroyTrigger: null,

        dockerBuildPipelineName: lifecycleDefaults.buildPipeline,
        runtimeName: '',
        serviceDisksYaml: null,
        nodeSelector: null,
        nodeAffinity: null,
        active: undefined,
        defaultBranchName: 'unit-test',
        dependsOnDeployableName: undefined,
        kedaScaleToZero: null,
        deploymentDependsOn: [],
        helm: undefined,
      });
    });

    test('Generate config should have httpGet port and path', async () => {
      const githubService: YamlService.GithubService = {
        name: 'github-app',
        requires: [
          { name: 'github-db' },
          { name: 'test-db', repository: 'iceycake/test', branch: 'main' },
          { serviceId: 23 },
        ],
        github: {
          repository: 'org/lifecycle-test',
          branchName: 'unit-test',
          docker: {
            defaultTag: 'main',
            ecr: 'lfc/lifecycle-deployments',
            app: {
              dockerfilePath: 'app1/app.Dockerfile',
              command: 'server',
              arguments: 'docker/scripts/lifecycle/startup.sh',
              env: {
                SOURCE: 'yaml',
                TOKEN1: 'abcdefghijk',
              },
              ports: [8080, 8089, 8888],
            },
            init: {
              dockerfilePath: 'app1/init.Dockerfile',
              command: 'sh',
              arguments:
                '-c%%SPLIT%%local%%SPLIT%%-i%%SPLIT%%./sysops/ansible/spinnaker_inventory.py%%SPLIT%%./sysops/ansible/playbooks/lifecycle.yaml',
              env: {
                ENV: 'lifecycle',
                COMPONENT: 'app',
              },
            },
          },
          deployment: {
            public: false,
            capacityType: 'SPOT',
            resource: {
              cpu: {
                limit: '1000m',
                request: '50m',
              },
              memory: {
                limit: '1000Mi',
                request: '500Mi',
              },
            },
            readiness: {
              httpGet: {
                path: '/hello',
                port: 10500,
              },
            },
            network: {
              grpc: {
                enable: true,
              },
              hostPortMapping: {
                admin: '9991',
                callback: '9990',
                web: '8080',
              },
            },
          },
        },
      };

      // @ts-ignore
      const result: DeployableAttributes = await deployableService.generateAttributesFromYamlConfig(
        100,
        'unit-test-12345',
        '1234567890',
        'unit-test',
        githubService
      );

      expect(result).toEqual({
        name: 'github-app',
        serviceId: null,
        kedaScaleToZero: null,
        type: 'github',
        buildUUID: 'unit-test-12345',
        buildId: 100,
        repositoryId: '1234567890',
        branchName: 'unit-test',
        defaultUUID: lifecycleDefaults.defaultUUID,
        dockerfilePath: 'app1/app.Dockerfile',
        command: 'server',
        arguments: 'docker/scripts/lifecycle/startup.sh',
        env: {
          SOURCE: 'yaml',
          TOKEN1: 'abcdefghijk',
        },
        port: '8080,8089,8888',
        initArguments:
          '-c%%SPLIT%%local%%SPLIT%%-i%%SPLIT%%./sysops/ansible/spinnaker_inventory.py%%SPLIT%%./sysops/ansible/playbooks/lifecycle.yaml',
        initCommand: 'sh',
        initDockerfilePath: 'app1/init.Dockerfile',
        initEnv: {
          ENV: 'lifecycle',
          COMPONENT: 'app',
        },
        dockerImage: undefined,
        defaultTag: 'main',

        public: false,
        capacityType: 'SPOT',

        cpuLimit: '1000m',
        cpuRequest: '50m',
        memoryLimit: '1000Mi',
        memoryRequest: '500Mi',

        readinessFailureThreshold: 30,
        readinessHttpGetPath: '/hello',
        readinessHttpGetPort: 10500,
        readinessInitialDelaySeconds: 0,
        readinessPeriodSeconds: 10,
        readinessSuccessThreshold: 1,
        readinessTcpSocketPort: null,
        readinessTimeoutSeconds: 1,
        afterBuildPipelineId: undefined,
        appShort: undefined,
        ecr: 'lfc/lifecycle-deployments',
        builder: {},

        host: domainDefaults.http,
        acmARN: 'arn:aws:acm:us-west-2:account-id:certificate/ceritifcate-id',
        defaultInternalHostname: `github-app-${lifecycleDefaults.defaultUUID}`,
        defaultPublicUrl: `github-app-${lifecycleDefaults.defaultUUID}.${domainDefaults.http}`,

        ipWhitelist: '{ 70.52.40.40/32,160.72.36.84/32 }',
        hostPortMapping: {
          admin: '9991',
          callback: '9990',
          web: '8080',
        },
        ingressAnnotations: {},
        pathPortMapping: {},
        grpc: true,
        grpcHost: domainDefaults.grpc,
        defaultGrpcHost: `github-app-${lifecycleDefaults.defaultUUID}.${domainDefaults.grpc}`,

        detatchAfterBuildPipeline: false,
        deployPipelineId: null,
        deployTrigger: null,
        destroyPipelineId: null,
        destroyTrigger: null,

        dockerBuildPipelineName: lifecycleDefaults.buildPipeline,
        runtimeName: '',
        serviceDisksYaml: null,
        nodeSelector: null,
        nodeAffinity: null,
        active: undefined,
        defaultBranchName: 'unit-test',
        dependsOnDeployableName: undefined,
        deploymentDependsOn: [],
        helm: undefined,
      });
    });
  });
});
