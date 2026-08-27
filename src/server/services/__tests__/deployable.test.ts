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
const mockResolveRepositoryForAttributes = jest.fn();
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

jest.mock('server/models/yaml', () => {
  const actual = jest.requireActual('server/models/yaml');
  return {
    __esModule: true,
    ...actual,
    resolveRepository: (...args: unknown[]) => mockResolveRepositoryForAttributes(...args),
  };
});

import * as YamlService from 'server/models/yaml';
import { Build } from 'server/models';
import { FeatureFlags, NO_DEFAULT_ENV_UUID } from 'shared/constants';
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
        requires: ['github-db', 'test-db'],
        deploymentDependsOn: [],
        helm: undefined,
      });
    });

    test('service-level defaultUUID overrides the global default for hostname/URL fallbacks', async () => {
      const githubService: YamlService.GithubService = {
        name: 'github-app',
        defaultUUID: 'sandbox',
        github: {
          repository: 'example-org/example-service',
          branchName: 'unit-test',
          docker: {
            defaultTag: 'main',
            app: {
              dockerfilePath: 'app1/app.Dockerfile',
            },
          },
        },
      };

      const build = { enabledFeatures: [] } as unknown as Build;

      // @ts-ignore
      const result: DeployableAttributes = await deployableService.generateAttributesFromYamlConfig(
        100,
        'unit-test-12345',
        1234567890,
        'unit-test',
        githubService,
        false,
        '',
        build
      );

      expect(result.defaultUUID).toEqual('sandbox');
      expect(result.defaultInternalHostname).toEqual('github-app-sandbox');
      expect(result.defaultPublicUrl).toEqual(`github-app-sandbox.${domainDefaults.http}`);
      expect(result.defaultGrpcHost).toEqual(`github-app-sandbox.${domainDefaults.grpc}`);
    });

    test('NO_DEFAULT_ENV_RESOLVE takes priority over a service-level defaultUUID override', async () => {
      const githubService: YamlService.GithubService = {
        name: 'github-app',
        defaultUUID: 'sandbox',
        github: {
          repository: 'example-org/example-service',
          branchName: 'unit-test',
          docker: {
            defaultTag: 'main',
            app: {
              dockerfilePath: 'app1/app.Dockerfile',
            },
          },
        },
      };

      const build = { enabledFeatures: [FeatureFlags.NO_DEFAULT_ENV_RESOLVE] } as unknown as Build;

      // @ts-ignore
      const result: DeployableAttributes = await deployableService.generateAttributesFromYamlConfig(
        100,
        'unit-test-12345',
        1234567890,
        'unit-test',
        githubService,
        false,
        '',
        build
      );

      expect(result.defaultUUID).toEqual(NO_DEFAULT_ENV_UUID);
      expect(result.defaultInternalHostname).toEqual(`github-app-${NO_DEFAULT_ENV_UUID}`);
      expect(result.defaultPublicUrl).toEqual(`github-app-${NO_DEFAULT_ENV_UUID}.${domainDefaults.http}`);
      expect(result.defaultGrpcHost).toEqual(`github-app-${NO_DEFAULT_ENV_UUID}.${domainDefaults.grpc}`);
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
        requires: ['github-db', 'test-db'],
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

  describe('YAML attribute resolution boundaries', () => {
    const deployableService: DeployableService = new DeployableService(null, null, null);
    const githubService: YamlService.GithubService = {
      name: 'github-app',
      github: {
        repository: 'example-org/example-service',
        branchName: 'configured-branch',
        docker: {
          defaultTag: 'main',
          app: {
            dockerfilePath: 'app/app.Dockerfile',
          },
        },
      },
    };

    beforeEach(() => {
      mockGetAllConfigs.mockResolvedValue(globalConfigs);
      mockResolveRepositoryForAttributes.mockReset();
    });

    test('maps an external Docker service and preserves explicit deployment overrides', async () => {
      const dockerService: YamlService.DockerService = {
        name: 'postgres',
        docker: {
          dockerImage: 'postgres',
          defaultTag: '16',
          command: 'postgres',
          arguments: '-c max_connections=250',
          env: { POSTGRES_DB: 'app' },
          ports: [5432],
          deployment: {
            public: true,
            capacityType: 'ON_DEMAND',
            resource: {
              cpu: { request: '250m', limit: '1' },
              memory: { request: '256Mi', limit: '1Gi' },
            },
            readiness: {
              initialDelaySeconds: 4,
              periodSeconds: 5,
              timeoutSeconds: 6,
              successThreshold: 2,
              failureThreshold: 7,
              tcpSocketPort: 5432,
            },
            hostnames: {
              host: 'postgres.example.test',
              acmARN: 'arn:explicit',
              defaultInternalHostname: 'postgres.internal',
              defaultPublicUrl: 'postgres.public.example.test',
            },
            network: {
              ipWhitelist: ['10.0.0.0/8', '192.168.0.0/16'],
              pathPortMapping: { metrics: '9187' },
              hostPortMapping: { postgres: '5432' },
              grpc: {
                enable: true,
                host: 'grpc.postgres.example.test',
                defaultHost: 'postgres.grpc.internal',
              },
              ingressAnnotations: { 'example.test/owner': 'platform' },
            },
            serviceDisks: [
              {
                name: 'data',
                mountPath: '/var/lib/postgresql/data',
                storageSize: '10Gi',
              },
            ],
            node_selector: { workload: 'stateful' },
            node_affinity: { required: { zone: 'west' } },
          },
        },
      };

      const result: DeployableAttributes = await (deployableService as any).generateAttributesFromYamlConfig(
        100,
        'unit-test-12345',
        null,
        undefined,
        dockerService,
        true,
        null
      );

      expect(result).toEqual(
        expect.objectContaining({
          name: 'postgres',
          type: 'docker',
          dockerImage: 'postgres',
          defaultTag: '16',
          dockerfilePath: serviceDefaults.dockerfilePath,
          repositoryId: null,
          resolvedFromRepositoryId: null,
          branchName: 'main',
          command: 'postgres',
          arguments: '-c max_connections=250',
          env: { POSTGRES_DB: 'app' },
          port: '5432',
          public: true,
          capacityType: 'ON_DEMAND',
          cpuRequest: '250m',
          cpuLimit: '1',
          memoryRequest: '256Mi',
          memoryLimit: '1Gi',
          readinessInitialDelaySeconds: 4,
          readinessPeriodSeconds: 5,
          readinessTimeoutSeconds: 6,
          readinessSuccessThreshold: 2,
          readinessFailureThreshold: 7,
          readinessTcpSocketPort: 5432,
          host: 'postgres.example.test',
          acmARN: 'arn:explicit',
          defaultInternalHostname: 'postgres.internal',
          defaultPublicUrl: 'postgres.public.example.test',
          ipWhitelist: '{10.0.0.0/8,192.168.0.0/16}',
          pathPortMapping: { metrics: '9187' },
          hostPortMapping: { postgres: '5432' },
          grpc: true,
          grpcHost: 'grpc.postgres.example.test',
          defaultGrpcHost: 'postgres.grpc.internal',
          ingressAnnotations: { 'example.test/owner': 'platform' },
          serviceDisksYaml: JSON.stringify([
            {
              name: 'data',
              mountPath: '/var/lib/postgresql/data',
              storageSize: '10Gi',
            },
          ]),
          nodeSelector: { workload: 'stateful' },
          nodeAffinity: { required: { zone: 'west' } },
          active: true,
          source: 'yaml',
          reconcileEligible: true,
        })
      );
    });

    test('maps Codefresh deploy and destroy pipeline contracts', async () => {
      const codefreshService: YamlService.CodefreshService = {
        name: 'legacy-pipeline-service',
        codefresh: {
          repository: 'example-org/legacy-pipeline-service',
          branchName: 'main',
          env: { SOURCE: 'codefresh' },
          deploy: { pipelineId: 'deploy-pipeline', trigger: 'deploy-trigger' },
          destroy: { pipelineId: 'destroy-pipeline', trigger: 'destroy-trigger' },
          deployment: { public: false },
        },
      };

      const result: DeployableAttributes = await (deployableService as any).generateAttributesFromYamlConfig(
        100,
        'unit-test-12345',
        42,
        'main',
        codefreshService,
        true,
        null
      );

      expect(result).toEqual(
        expect.objectContaining({
          name: 'legacy-pipeline-service',
          type: 'codefresh',
          dockerfilePath: serviceDefaults.dockerfilePath,
          deployPipelineId: 'deploy-pipeline',
          deployTrigger: 'deploy-trigger',
          destroyPipelineId: 'destroy-pipeline',
          destroyTrigger: 'destroy-trigger',
          active: true,
          source: 'yaml',
          reconcileEligible: true,
        })
      );
    });

    test('applies the pull-request branch hack only to explicitly enabled services', async () => {
      const matchingBuild = {
        enabledFeatures: ['hack-force-pull-request-branch', 'hack-force-pull-request-service-github-app'],
        pullRequest: { branchName: 'pull-request-branch' },
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      } as unknown as Build;

      const matchingResult: DeployableAttributes = await (deployableService as any).generateAttributesFromYamlConfig(
        100,
        'unit-test-12345',
        42,
        'delivery-branch',
        githubService,
        true,
        null,
        matchingBuild
      );

      expect(matchingBuild.$fetchGraph).toHaveBeenCalledWith('pullRequest');
      expect(matchingResult.branchName).toBe('pull-request-branch');

      const nonMatchingBuild = {
        enabledFeatures: ['hack-force-pull-request-branch'],
        pullRequest: { branchName: 'other-pull-request-branch' },
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      } as unknown as Build;
      const nonMatchingResult: DeployableAttributes = await (deployableService as any).generateAttributesFromYamlConfig(
        100,
        'unit-test-12345',
        42,
        'delivery-branch',
        githubService,
        true,
        null,
        nonMatchingBuild
      );

      expect(nonMatchingResult.branchName).toBe('delivery-branch');

      const buildWithoutPullRequest = {
        enabledFeatures: ['hack-force-pull-request-branch', 'hack-force-pull-request-service-github-app'],
        pullRequest: null,
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      } as unknown as Build;
      const resultWithoutPullRequest: DeployableAttributes = await (
        deployableService as any
      ).generateAttributesFromYamlConfig(
        100,
        'unit-test-12345',
        42,
        'delivery-branch',
        githubService,
        true,
        null,
        buildWithoutPullRequest
      );

      expect(resultWithoutPullRequest.branchName).toBe('delivery-branch');
    });

    test('uses the delivered branch for the source repository and the configured branch for another repository', async () => {
      const repository = { githubRepositoryId: 42, fullName: 'example-org/example-service' };
      mockResolveRepositoryForAttributes.mockResolvedValue(repository);
      const deployableServices = new Map<string, DeployableAttributes>();

      await deployableService.updateOrCreateDeployableAttributesUsingYAMLConfig(
        deployableServices,
        100,
        'unit-test-12345',
        githubService,
        42,
        'delivery-branch',
        true,
        null
      );
      expect(deployableServices.get('github-app')).toEqual(
        expect.objectContaining({ repositoryId: 42, branchName: 'delivery-branch', active: true })
      );

      await deployableService.updateOrCreateDeployableAttributesUsingYAMLConfig(
        deployableServices,
        100,
        'unit-test-12345',
        githubService,
        99,
        'unrelated-delivery-branch',
        false,
        'parent-service'
      );
      expect(deployableServices.get('github-app')).toEqual(
        expect.objectContaining({
          repositoryId: 42,
          branchName: 'configured-branch',
          active: false,
          dependsOnDeployableName: 'parent-service',
        })
      );
      expect(deployableServices.size).toBe(1);
    });

    test('falls back to the build pull-request repository and the default branch when repository resolution misses', async () => {
      const repository = { githubRepositoryId: 77, fullName: 'example-org/fallback' };
      const pullRequest = {
        repository,
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };
      const build = {
        enabledFeatures: [],
        pullRequest,
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      } as unknown as Build;
      mockResolveRepositoryForAttributes.mockResolvedValue(null);
      const deployableServices = new Map<string, DeployableAttributes>();

      await deployableService.updateOrCreateDeployableAttributesUsingYAMLConfig(
        deployableServices,
        100,
        'unit-test-12345',
        githubService,
        42,
        'delivery-branch',
        true,
        null,
        build
      );

      expect(build.$fetchGraph).toHaveBeenCalledWith('[pullRequest, environment]');
      expect(pullRequest.$fetchGraph).toHaveBeenCalledWith('[repository]');
      expect(deployableServices.get('github-app')).toEqual(
        expect.objectContaining({ repositoryId: 77, branchName: 'main' })
      );
    });

    test('keeps a resolvable YAML service when neither repository lookup can identify its repository', async () => {
      const build = {
        enabledFeatures: [],
        pullRequest: null,
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      } as unknown as Build;
      mockResolveRepositoryForAttributes.mockResolvedValue(null);
      const deployableServices = new Map<string, DeployableAttributes>();

      await deployableService.updateOrCreateDeployableAttributesUsingYAMLConfig(
        deployableServices,
        100,
        'unit-test-12345',
        githubService,
        42,
        'delivery-branch',
        true,
        null,
        build
      );

      expect(deployableServices.get('github-app')).toEqual(
        expect.objectContaining({ repositoryId: null, resolvedFromRepositoryId: null, branchName: 'main' })
      );
    });

    test('preserves YAML resolution errors without mutating the in-memory deployable set', async () => {
      const resolutionError = new Error('global defaults unavailable');
      mockResolveRepositoryForAttributes.mockResolvedValue({ githubRepositoryId: 42 });
      mockGetAllConfigs.mockRejectedValueOnce(resolutionError);
      const deployableServices = new Map<string, DeployableAttributes>();

      await expect(
        deployableService.updateOrCreateDeployableAttributesUsingYAMLConfig(
          deployableServices,
          100,
          'unit-test-12345',
          githubService,
          42,
          'delivery-branch',
          true,
          null
        )
      ).rejects.toBe(resolutionError);

      expect(deployableServices.size).toBe(0);
    });
  });
});
