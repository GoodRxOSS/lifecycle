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
import DeployService from '../deploy';
import { DeployStatus, DeployTypes } from 'shared/constants';
import { ChartType } from 'server/lib/nativeHelm';
import * as github from 'server/lib/github';
import { SecretProcessor } from 'server/services/secretProcessor';

mockRedisClient();

const mockCliDeploy = jest.fn();
const mockCodefreshBuildImage = jest.fn();
const mockCodefreshGetLogs = jest.fn();
const mockCodefreshGetRepositoryTag = jest.fn();
const mockCodefreshTagExists = jest.fn();
const mockCodefreshWaitForImage = jest.fn();
const mockBuildWithNative = jest.fn();
const mockGlobalConfigGetAllConfigs = jest.fn();
const mockGlobalConfigGetOrgChartName = jest.fn();
const mockCreateOrUpdateNamespace = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  })),
  withLogContext: jest.fn((ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  LogStage: {},
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: any[]) => mockGlobalConfigGetAllConfigs(...args),
      getOrgChartName: (...args: any[]) => mockGlobalConfigGetOrgChartName(...args),
    })),
  },
}));

jest.mock('server/lib/codefresh', () => ({
  buildImage: (...args: any[]) => mockCodefreshBuildImage(...args),
  getLogs: (...args: any[]) => mockCodefreshGetLogs(...args),
  getRepositoryTag: (...args: any[]) => mockCodefreshGetRepositoryTag(...args),
  tagExists: (...args: any[]) => mockCodefreshTagExists(...args),
  waitForImage: (...args: any[]) => mockCodefreshWaitForImage(...args),
}));

jest.mock('server/lib/nativeBuild', () => ({
  buildWithNative: (...args: any[]) => mockBuildWithNative(...args),
}));

jest.mock('server/lib/kubernetes', () => ({
  createOrUpdateNamespace: (...args: any[]) => mockCreateOrUpdateNamespace(...args),
}));

const mockDetermineChartType = jest.fn();
jest.mock('server/lib/nativeHelm', () => ({
  ...jest.requireActual('server/lib/nativeHelm'),
  determineChartType: (...args: any[]) => mockDetermineChartType(...args),
}));

jest.mock('server/lib/github', () => ({
  getSHAForBranch: jest.fn(),
  getShaForDeploy: jest.fn(),
}));

jest.mock('server/lib/cli', () => ({
  cliDeploy: (...args: any[]) => mockCliDeploy(...args),
  codefreshDeploy: jest.fn(),
  waitForCodefresh: jest.fn(),
}));

describe('DeployService - shouldTriggerGithubDeployment', () => {
  let deployService: DeployService;
  let mockDb: any;
  let mockRedis: any;
  let mockRedlock: any;
  let mockQueueManager: any;

  const createMockDeploy = (overrides: any = {}) => ({
    id: 1,
    active: true,
    service: {
      public: true,
      type: DeployTypes.DOCKER,
    },
    deployable: {
      public: true,
      type: DeployTypes.DOCKER,
      helm: {},
    },
    build: {},
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCliDeploy.mockReset();
    mockCodefreshBuildImage.mockReset();
    mockCodefreshGetLogs.mockReset();
    mockCodefreshGetRepositoryTag.mockReset();
    mockCodefreshTagExists.mockReset();
    mockCodefreshWaitForImage.mockReset();
    mockBuildWithNative.mockReset();
    mockCreateOrUpdateNamespace.mockReset();
    mockGlobalConfigGetOrgChartName.mockResolvedValue('org-chart');
    mockGlobalConfigGetAllConfigs.mockResolvedValue({
      lifecycleDefaults: {
        buildPipeline: 'sample/build-image',
        deployCluster: 'test-cluster',
        ecrDomain: '123456789012.dkr.ecr.us-west-2.amazonaws.com',
        ecrRegistry: 'sample-registry',
      },
      app_setup: {
        org: 'example-org',
      },
      buildDefaults: {},
    });
    mockDetermineChartType.mockResolvedValue(ChartType.PUBLIC);

    mockDb = {
      models: {},
      services: {},
    };

    mockRedis = {};
    mockRedlock = {};

    mockQueueManager = {
      registerQueue: jest.fn().mockReturnValue({
        add: jest.fn(),
        process: jest.fn(),
        on: jest.fn(),
      }),
    };

    deployService = new DeployService(mockDb, mockRedis, mockRedlock, mockQueueManager);
  });

  describe('deploy type filtering', () => {
    test('should return true for DOCKER type', async () => {
      const deploy = createMockDeploy({
        deployable: { public: true, type: DeployTypes.DOCKER, helm: {} },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(true);
    });

    test('should return true for GITHUB type', async () => {
      const deploy = createMockDeploy({
        deployable: { public: true, type: DeployTypes.GITHUB, helm: {} },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(true);
    });

    test('should return true for CODEFRESH type', async () => {
      const deploy = createMockDeploy({
        deployable: { public: true, type: DeployTypes.CODEFRESH, helm: {} },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(true);
    });

    test('should return true for HELM type', async () => {
      const deploy = createMockDeploy({
        deployable: { public: true, type: DeployTypes.HELM, helm: {} },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(true);
    });

    test('should return false for CONFIGURATION type', async () => {
      const deploy = createMockDeploy({
        deployable: { public: true, type: DeployTypes.CONFIGURATION, helm: {} },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(false);
    });

    test('should return false for AURORA_RESTORE type', async () => {
      const deploy = createMockDeploy({
        deployable: { public: true, type: DeployTypes.AURORA_RESTORE, helm: {} },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(false);
    });
  });

  describe('active filtering', () => {
    test('should return true when deploy is active', async () => {
      const deploy = createMockDeploy({ active: true });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(true);
    });

    test('should return false when deploy is not active', async () => {
      const deploy = createMockDeploy({ active: false });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(false);
    });
  });

  describe('public filtering', () => {
    test('should return true when deployable is public', async () => {
      const deploy = createMockDeploy({
        deployable: { public: true, type: DeployTypes.DOCKER, helm: {} },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(true);
    });

    test('should return false when deployable is not public', async () => {
      const deploy = createMockDeploy({
        deployable: { public: false, type: DeployTypes.DOCKER, helm: {} },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(false);
    });
  });

  describe('org chart handling', () => {
    test('should return true for org helm chart even if not explicitly public', async () => {
      const deploy = createMockDeploy({
        deployable: {
          public: false,
          type: DeployTypes.HELM,
          helm: { chart: { name: 'org-chart' } },
        },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(true);
    });

    test('should return true for PUBLIC helm chart even if not explicitly public', async () => {
      mockDetermineChartType.mockResolvedValue(ChartType.PUBLIC);
      const deploy = createMockDeploy({
        deployable: {
          public: false,
          type: DeployTypes.HELM,
          helm: { chart: { name: 'bitnami/jenkins' } },
        },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(true);
    });

    test('should return false for LOCAL helm chart that is not explicitly public', async () => {
      mockDetermineChartType.mockResolvedValue(ChartType.LOCAL);
      const deploy = createMockDeploy({
        deployable: {
          public: false,
          type: DeployTypes.HELM,
          helm: { chart: { name: './local-chart' } },
        },
      });

      const result = await deployService['shouldTriggerGithubDeployment'](deploy as any);
      expect(result).toBe(false);
    });
  });

  describe('failure boundaries', () => {
    test('recordDeployFailure writes a terminal status with the original error message', async () => {
      const patchSpy = jest.spyOn(deployService, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
      const deploy = {
        uuid: 'sample-service-build',
        runUUID: 'run-1',
        $query: jest.fn(() => ({
          patch: jest.fn().mockResolvedValue(undefined),
        })),
      };

      const result = await deployService.recordDeployFailure(deploy as any, 'run-1', {
        status: DeployStatus.DEPLOY_FAILED,
        error: new Error('Kubernetes apply job failed: pod quota exceeded'),
        fallbackMessage: 'Kubernetes deployment failed.',
      });

      expect(result).toBe(false);
      expect(patchSpy).toHaveBeenCalledWith(
        deploy,
        {
          status: DeployStatus.DEPLOY_FAILED,
          statusMessage: 'Kubernetes apply job failed: pod quota exceeded',
        },
        'run-1'
      );
    });

    test('buildImage boundary records a source resolution failure statusMessage', async () => {
      (github.getSHAForBranch as jest.Mock).mockRejectedValue(new Error('Not Found'));
      const patchSpy = jest.spyOn(deployService, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
      const deploy = {
        uuid: 'sample-service-build',
        runUUID: 'run-1',
        branchName: 'missing-branch',
        env: {},
        tag: 'latest',
        $query: jest.fn(() => ({
          patch: jest.fn().mockResolvedValue(undefined),
        })),
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        deployable: {
          name: 'sample-service',
          type: DeployTypes.GITHUB,
          dockerfilePath: './Dockerfile',
          initDockerfilePath: null,
          repository: {
            fullName: 'example-org/example-repo',
          },
          $fetchGraph: jest.fn().mockResolvedValue(undefined),
        },
        build: {
          uuid: 'sample-build',
          commentRuntimeEnv: {},
          enabledFeatures: [],
          pullRequest: {
            githubLogin: 'sample-user',
          },
          $fetchGraph: jest.fn().mockResolvedValue(undefined),
        },
      };

      const result = await deployService.buildImage(deploy as any, 0);

      expect(result).toBe(false);
      expect(github.getSHAForBranch).toHaveBeenCalledWith('missing-branch', 'example-org', 'example-repo');
      expect(patchSpy).toHaveBeenLastCalledWith(
        deploy,
        {
          status: DeployStatus.BUILD_FAILED,
          statusMessage:
            'Unable to resolve branch "missing-branch" in repository "example-org/example-repo". Verify the branch exists and the repository matches the selected service.',
        },
        'run-1'
      );
    });

    test('buildImageForHelmAndGithub uses Codefresh when builder engine is ci', async () => {
      (github.getSHAForBranch as jest.Mock).mockResolvedValue('abcdef1234567890');
      mockCodefreshTagExists.mockResolvedValue(false);
      mockCodefreshBuildImage.mockResolvedValue('codefresh-build-123');
      mockCodefreshWaitForImage.mockResolvedValue(false);
      mockCodefreshGetLogs.mockResolvedValue('codefresh logs');
      const patchSpy = jest.spyOn(deployService, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
      const deployPatch = jest.fn().mockResolvedValue(undefined);
      const deploy = {
        uuid: 'sample-service-build',
        runUUID: 'run-1',
        branchName: 'feature-branch',
        env: {},
        initEnv: {},
        dockerImage: 'old-image',
        service: {
          name: 'sample-service',
        },
        build: {
          id: 1,
          uuid: 'sample-build',
          namespace: 'env-sample',
          isStatic: false,
          commentRuntimeEnv: {},
          enabledFeatures: [],
          pullRequest: {
            githubLogin: 'sample-user',
          },
          $fetchGraph: jest.fn().mockResolvedValue(undefined),
        },
        deployable: {
          name: 'sample-service',
          type: DeployTypes.GITHUB,
          dockerfilePath: './Dockerfile',
          initDockerfilePath: null,
          env: {},
          ecr: 'sample/app-images',
          dockerBuildPipelineName: 'sample/build-image',
          builder: {
            engine: 'ci',
          },
          repository: {
            fullName: 'example-org/example-repo',
          },
          $fetchGraph: jest.fn().mockResolvedValue(undefined),
        },
        reload: jest.fn().mockResolvedValue(undefined),
        $query: jest.fn(() => ({
          patch: deployPatch,
        })),
      };

      const result = await deployService.buildImageForHelmAndGithub(deploy as any, 'run-1');

      expect(result).toBe(false);
      expect(mockBuildWithNative).not.toHaveBeenCalled();
      expect(mockCodefreshBuildImage).toHaveBeenCalledTimes(1);
      expect(mockCodefreshBuildImage).toHaveBeenCalledWith(
        expect.objectContaining({
          buildPipelineName: 'sample/build-image',
          dockerfilePath: './Dockerfile',
          repo: 'example-org/example-repo',
        })
      );
      expect(deployPatch).toHaveBeenCalledWith({ buildPipelineId: 'codefresh-build-123' });
      expect(deployPatch).toHaveBeenCalledWith({ buildOutput: 'codefresh logs' });
      expect(patchSpy).toHaveBeenLastCalledWith(deploy, { status: DeployStatus.BUILD_FAILED }, 'run-1');
    });

    test('buildImageForHelmAndGithub syncs external secrets when native image tag already exists', async () => {
      (github.getSHAForBranch as jest.Mock).mockResolvedValue('abcdef1234567890');
      mockCodefreshTagExists.mockResolvedValue(true);
      mockCodefreshGetRepositoryTag.mockReturnValue(
        '123456789012.dkr.ecr.us-west-2.amazonaws.com/sample/app-images:lfc-abcdef1'
      );
      mockGlobalConfigGetAllConfigs.mockResolvedValue({
        lifecycleDefaults: {
          buildPipeline: 'sample/build-image',
          deployCluster: 'test-cluster',
          ecrDomain: '123456789012.dkr.ecr.us-west-2.amazonaws.com',
          ecrRegistry: 'sample-registry',
        },
        app_setup: {
          org: 'example-org',
        },
        buildDefaults: {},
        secretProviders: {
          aws: {
            enabled: true,
            clusterSecretStore: 'aws-secretsmanager',
            refreshInterval: '1h',
            allowedPrefixes: [],
          },
        },
      });

      const processSecretsSpy = jest.spyOn(SecretProcessor.prototype, 'processEnvSecrets').mockResolvedValue({
        secretRefs: [
          {
            envKey: 'API_TOKEN',
            provider: 'aws',
            path: 'repo/example-repo/api',
            key: 'API_TOKEN',
          },
        ],
        expectedKeysPerSecret: {
          'sample-service-aws-secrets': ['API_TOKEN'],
        },
        syncTokensPerSecret: {
          'sample-service-aws-secrets': 'sync-token',
        },
        warnings: [],
      });
      const waitForSecretSyncSpy = jest
        .spyOn(SecretProcessor.prototype, 'waitForSecretSync')
        .mockResolvedValue(undefined);

      const patchSpy = jest.spyOn(deployService, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
      const deployPatch = jest.fn().mockResolvedValue(undefined);
      const deploy = {
        uuid: 'sample-service-build',
        runUUID: 'run-1',
        branchName: 'feature-branch',
        env: {
          NODE_ENV: 'production',
          API_TOKEN: '{{aws:repo/example-repo/api:API_TOKEN}}',
        },
        initEnv: {},
        dockerImage: 'old-image',
        service: {
          name: 'sample-service',
        },
        build: {
          id: 1,
          uuid: 'sample-build',
          namespace: 'env-sample',
          isStatic: false,
          commentRuntimeEnv: {},
          enabledFeatures: [],
          pullRequest: {
            githubLogin: 'sample-user',
          },
          $fetchGraph: jest.fn().mockResolvedValue(undefined),
        },
        deployable: {
          name: 'sample-service',
          type: DeployTypes.GITHUB,
          dockerfilePath: './Dockerfile',
          initDockerfilePath: null,
          env: {},
          ecr: 'sample/app-images',
          dockerBuildPipelineName: 'sample/build-image',
          builder: {
            engine: 'buildkit',
          },
          repository: {
            fullName: 'example-org/example-repo',
          },
          $fetchGraph: jest.fn().mockResolvedValue(undefined),
        },
        reload: jest.fn().mockResolvedValue(undefined),
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        $query: jest.fn(() => ({
          patch: deployPatch,
        })),
      };

      try {
        const result = await deployService.buildImageForHelmAndGithub(deploy as any, 'run-1');

        expect(result).toBe(true);
        expect(mockBuildWithNative).not.toHaveBeenCalled();
        expect(mockCreateOrUpdateNamespace).toHaveBeenCalledWith({
          name: 'env-sample',
          buildUUID: 'sample-build',
          staticEnv: false,
          pullRequest: {
            githubLogin: 'sample-user',
          },
          waitForReady: true,
        });
        expect(processSecretsSpy).toHaveBeenCalledWith({
          env: {
            API_TOKEN: '{{aws:repo/example-repo/api:API_TOKEN}}',
          },
          serviceName: 'sample-service',
          namespace: 'env-sample',
          buildUuid: 'sample-service-build',
        });
        expect(waitForSecretSyncSpy).toHaveBeenCalledWith(
          {
            'sample-service-aws-secrets': ['API_TOKEN'],
          },
          'env-sample',
          60000,
          {
            'sample-service-aws-secrets': 'sync-token',
          }
        );
        expect(deployPatch).toHaveBeenCalledWith(
          expect.objectContaining({
            status: DeployStatus.BUILT,
            dockerImage: '123456789012.dkr.ecr.us-west-2.amazonaws.com/sample/app-images:lfc-abcdef1',
          })
        );
        expect(patchSpy).toHaveBeenLastCalledWith(deploy, { status: DeployStatus.BUILT }, 'run-1');
      } finally {
        processSecretsSpy.mockRestore();
        waitForSecretSyncSpy.mockRestore();
      }
    });

    test('buildImageForHelmAndGithub syncs comment init env secrets when native image tag already exists', async () => {
      (github.getSHAForBranch as jest.Mock).mockResolvedValue('abcdef1234567890');
      mockCodefreshTagExists.mockResolvedValue(true);
      mockCodefreshGetRepositoryTag.mockReturnValue(
        '123456789012.dkr.ecr.us-west-2.amazonaws.com/sample/app-images:lfc-abcdef1'
      );
      mockGlobalConfigGetAllConfigs.mockResolvedValue({
        lifecycleDefaults: {
          buildPipeline: 'sample/build-image',
          deployCluster: 'test-cluster',
          ecrDomain: '123456789012.dkr.ecr.us-west-2.amazonaws.com',
          ecrRegistry: 'sample-registry',
        },
        app_setup: {
          org: 'example-org',
        },
        buildDefaults: {},
        secretProviders: {
          aws: {
            enabled: true,
            clusterSecretStore: 'aws-secretsmanager',
            refreshInterval: '1h',
            allowedPrefixes: [],
          },
        },
      });

      const processSecretsSpy = jest.spyOn(SecretProcessor.prototype, 'processEnvSecrets').mockResolvedValue({
        secretRefs: [
          {
            envKey: 'INIT_TOKEN',
            provider: 'aws',
            path: 'repo/example-repo/api',
            key: 'INIT_TOKEN',
          },
        ],
        expectedKeysPerSecret: {
          'sample-service-aws-secrets': ['INIT_TOKEN'],
        },
        syncTokensPerSecret: {
          'sample-service-aws-secrets': 'sync-token',
        },
        warnings: [],
      });
      const waitForSecretSyncSpy = jest
        .spyOn(SecretProcessor.prototype, 'waitForSecretSync')
        .mockResolvedValue(undefined);

      const deployPatch = jest.fn().mockResolvedValue(undefined);
      const deploy = {
        uuid: 'sample-service-build',
        runUUID: 'run-1',
        branchName: 'feature-branch',
        env: {
          NODE_ENV: 'production',
        },
        initEnv: {},
        dockerImage: 'old-image',
        service: {
          name: 'sample-service',
        },
        build: {
          id: 1,
          uuid: 'sample-build',
          namespace: 'env-sample',
          commentRuntimeEnv: {},
          commentInitEnv: {
            INIT_TOKEN: '{{aws:repo/example-repo/api:INIT_TOKEN}}',
          },
          enabledFeatures: [],
          pullRequest: {
            githubLogin: 'sample-user',
          },
          $fetchGraph: jest.fn().mockResolvedValue(undefined),
        },
        deployable: {
          name: 'sample-service',
          type: DeployTypes.GITHUB,
          dockerfilePath: './Dockerfile',
          initDockerfilePath: './init.Dockerfile',
          env: {},
          ecr: 'sample/app-images',
          dockerBuildPipelineName: 'sample/build-image',
          builder: {
            engine: 'buildkit',
          },
          repository: {
            fullName: 'example-org/example-repo',
          },
          $fetchGraph: jest.fn().mockResolvedValue(undefined),
        },
        reload: jest.fn().mockResolvedValue(undefined),
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        $query: jest.fn(() => ({
          patch: deployPatch,
        })),
      };

      try {
        const result = await deployService.buildImageForHelmAndGithub(deploy as any, 'run-1');

        expect(result).toBe(true);
        expect(mockBuildWithNative).not.toHaveBeenCalled();
        expect(processSecretsSpy).toHaveBeenCalledWith({
          env: {
            INIT_TOKEN: '{{aws:repo/example-repo/api:INIT_TOKEN}}',
          },
          serviceName: 'sample-service',
          namespace: 'env-sample',
          buildUuid: 'sample-service-build',
        });
        expect(waitForSecretSyncSpy).toHaveBeenCalledWith(
          {
            'sample-service-aws-secrets': ['INIT_TOKEN'],
          },
          'env-sample',
          60000,
          {
            'sample-service-aws-secrets': 'sync-token',
          }
        );
      } finally {
        processSecretsSpy.mockRestore();
        waitForSecretSyncSpy.mockRestore();
      }
    });

    test('deployAurora records failures with the newly assigned runUUID', async () => {
      const patchSpy = jest.spyOn(deployService, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
      jest.spyOn(deployService as any, 'findExistingAuroraDatabase').mockResolvedValue(null);
      mockCliDeploy.mockRejectedValue(new Error('restore command failed'));

      const patches: any[] = [];
      const deploy = {
        uuid: 'sample-aurora-restore',
        runUUID: 'old-run',
        status: DeployStatus.PENDING,
        buildLogs: null,
        build: {
          uuid: 'sample-build',
        },
        deployable: {
          name: 'sample-database',
          type: DeployTypes.AURORA_RESTORE,
        },
        reload: jest.fn().mockResolvedValue(undefined),
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        $query: jest.fn(() => ({
          patch: jest.fn((params) => {
            patches.push(params);
            return Promise.resolve(undefined);
          }),
        })),
      };

      const result = await deployService.deployAurora(deploy as any);
      const assignedRunUUID = patches.find((params) => params.status === DeployStatus.BUILDING)?.runUUID;

      expect(result).toBe(false);
      expect(assignedRunUUID).toBeDefined();
      expect(assignedRunUUID).not.toBe('old-run');
      expect(deploy.runUUID).toBe(assignedRunUUID);
      expect(patchSpy).toHaveBeenLastCalledWith(
        deploy,
        {
          status: DeployStatus.ERROR,
          statusMessage: 'restore command failed',
        },
        assignedRunUUID
      );
    });
  });
});
