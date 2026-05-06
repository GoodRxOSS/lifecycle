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

const mockGetAllConfigs = jest.fn();
const mockInstance = {
  getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args),
  isFeatureEnabled: jest.fn().mockResolvedValue(false),
};

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => mockInstance),
  },
}));

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: {
    getConnection: jest.fn(),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
  })),
}));

jest.mock('server/lib/github', () => ({
  getYamlFileContentFromBranch: jest.fn(),
}));

import * as YamlService from 'server/models/yaml';
import DeployableService, { DeployableAttributes } from '../deployable';

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
  acmARN: 'arn:aws:acm:us-west-2:account-id:certificate/ceritifcate-id',
  grpc: false,
  defaultIPWhiteList: '{ 70.52.40.40/32,160.72.36.84/32 }',
};

const domainDefaults = {
  http: 'lifecycle.example.com',
  grpc: 'lifecycle-grpc.example.com',
};

const globalConfigs = {
  lifecycleDefaults: lifecycleDefaults,
  serviceDefaults: serviceDefaults,
  domainDefaults: domainDefaults,
};

describe('Deployable Service', () => {
  describe('generateAttributesFromYamlConfig', () => {
    const deployableService: DeployableService = new DeployableService(null, null, null);

    beforeEach(() => {
      mockGetAllConfigs.mockResolvedValue(globalConfigs);
      mockInstance.isFeatureEnabled.mockResolvedValue(false);
    });

    test('Generates from Github Service Type Configuration', async () => {
      const githubService: YamlService.GithubService = {
        name: 'github-app',
        requires: [
          { name: 'github-db' },
          { name: 'test-db', repository: 'example-org/example-database', branch: 'main' },
          { serviceId: 23 },
        ],
        github: {
          repository: 'example-org/example-service',
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
        resolvedFromRepositoryId: 1234567890,
        source: 'yaml',
        reconcileEligible: true,
        branchName: 'unit-test',
        defaultUUID: lifecycleDefaults.defaultUUID,
        dockerfilePath: 'app1/app.Dockerfile',
        command: 'server',
        arguments: 'docker/scripts/lifecycle/startup.sh',
        env: {
          SOURCE: 'yaml',
          TOKEN1: 'abcdefghijk',
        },
        envLens: false,
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
        deploymentDependsOn: [],
        helm: undefined,
      });
    });

    test('Generate config should have httpGet port and path', async () => {
      const githubService: YamlService.GithubService = {
        name: 'github-app',
        requires: [
          { name: 'github-db' },
          { name: 'test-db', repository: 'example-org/example-database', branch: 'main' },
          { serviceId: 23 },
        ],
        github: {
          repository: 'example-org/example-service',
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
        type: 'github',
        buildUUID: 'unit-test-12345',
        buildId: 100,
        repositoryId: '1234567890',
        resolvedFromRepositoryId: 1234567890,
        source: 'yaml',
        reconcileEligible: true,
        branchName: 'unit-test',
        defaultUUID: lifecycleDefaults.defaultUUID,
        dockerfilePath: 'app1/app.Dockerfile',
        command: 'server',
        arguments: 'docker/scripts/lifecycle/startup.sh',
        env: {
          SOURCE: 'yaml',
          TOKEN1: 'abcdefghijk',
        },
        envLens: false,
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

    test('Generate config should not infer readiness when not configured', async () => {
      const githubService: YamlService.GithubService = {
        name: 'github-app',
        github: {
          repository: 'example-org/example-service',
          branchName: 'unit-test',
          docker: {
            defaultTag: 'main',
            app: {
              dockerfilePath: 'app1/app.Dockerfile',
              ports: [8080],
            },
          },
          deployment: {
            public: false,
            capacityType: 'SPOT',
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

      expect(result.readinessTcpSocketPort).toBeNull();
      expect(result.readinessHttpGetPort).toBeUndefined();
      expect(result.readinessHttpGetPath).toBeUndefined();
    });

    test('inherits global buildkit engine for Github docker services', async () => {
      mockGetAllConfigs.mockResolvedValue({
        ...globalConfigs,
        buildDefaults: { engine: 'buildkit' },
      });
      const githubService: YamlService.GithubService = {
        name: 'github-app',
        github: {
          repository: 'example-org/example-service',
          branchName: 'unit-test',
          docker: {
            defaultTag: 'main',
            app: {
              dockerfilePath: 'app1/app.Dockerfile',
              ports: [8080],
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

      expect(result.builder).toEqual({ engine: 'buildkit' });
    });

    test('inherits global buildkit engine for Helm docker services', async () => {
      mockGetAllConfigs.mockResolvedValue({
        ...globalConfigs,
        buildDefaults: { engine: 'buildkit' },
        'sample-chart': {
          chart: {
            name: 'sample-chart',
            values: [],
          },
        },
      });
      const helmService = {
        name: 'helm-app',
        helm: {
          cfStepType: 'helm',
          repository: 'example-org/example-service',
          branchName: 'unit-test',
          chart: {
            name: 'sample-chart',
            values: [],
          },
          docker: {
            defaultTag: 'main',
            app: {
              dockerfilePath: 'app1/app.Dockerfile',
              ports: [8080],
            },
          },
        },
      } as unknown as YamlService.Service;

      // @ts-ignore
      const result: DeployableAttributes = await deployableService.generateAttributesFromYamlConfig(
        100,
        'unit-test-12345',
        '1234567890',
        'unit-test',
        helmService
      );

      expect(result.builder).toEqual({ engine: 'buildkit' });
    });

    test('service builder engine ci overrides global buildkit and persists ci', async () => {
      mockGetAllConfigs.mockResolvedValue({
        ...globalConfigs,
        buildDefaults: { engine: 'buildkit' },
      });
      const githubService: YamlService.GithubService = {
        name: 'github-app',
        github: {
          repository: 'example-org/example-service',
          branchName: 'unit-test',
          docker: {
            defaultTag: 'main',
            builder: {
              engine: 'ci',
            },
            app: {
              dockerfilePath: 'app1/app.Dockerfile',
              ports: [8080],
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

      expect(result.builder).toEqual({ engine: 'ci' });
    });

    test('service builder engine kaniko overrides global buildkit', async () => {
      mockGetAllConfigs.mockResolvedValue({
        ...globalConfigs,
        buildDefaults: { engine: 'buildkit' },
      });
      const githubService: YamlService.GithubService = {
        name: 'github-app',
        github: {
          repository: 'example-org/example-service',
          branchName: 'unit-test',
          docker: {
            defaultTag: 'main',
            builder: {
              engine: 'kaniko',
            },
            app: {
              dockerfilePath: 'app1/app.Dockerfile',
              ports: [8080],
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

      expect(result.builder).toEqual({ engine: 'kaniko' });
    });
  });
});
