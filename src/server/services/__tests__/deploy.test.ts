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
import hash from 'object-hash';
import DeployService from '../deploy';
import { BuildKind, DeployStatus, DeployTypes } from 'shared/constants';
import { ChartType } from 'server/lib/nativeHelm';
import * as github from 'server/lib/github';
import { SecretProcessor } from 'server/services/secretProcessor';
import { AuthorityLockLostError } from 'server/lib/authorityLock';

mockRedisClient();

const mockCliDeploy = jest.fn();
const mockCodefreshDeploy = jest.fn();
const mockWaitForCodefresh = jest.fn();
const mockCodefreshBuildImage = jest.fn();
const mockCodefreshGetLogs = jest.fn();
const mockCodefreshGetRepositoryTag = jest.fn();
const mockCodefreshTagExists = jest.fn();
const mockCodefreshTriggerPipeline = jest.fn();
const mockCodefreshWaitForImage = jest.fn();
const mockBuildWithNative = jest.fn();
const mockGlobalConfigGetAllConfigs = jest.fn();
const mockGlobalConfigGetOrgChartName = jest.fn();
const mockCreateOrUpdateNamespace = jest.fn();
const mockExtractEnvVarsWithBuildDependencies = jest.fn().mockReturnValue({});
const mockWaitForColumnValue = jest.fn();
const mockTaggingGetResources = jest.fn();
const mockRdsDescribeDBInstances = jest.fn();
const mockRdsDescribeDBClusters = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerDebug = jest.fn();
const mockGetLogger = jest.fn(() => ({
  error: mockLoggerError,
  info: mockLoggerInfo,
  warn: mockLoggerWarn,
  debug: mockLoggerDebug,
  child: jest.fn().mockReturnThis(),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: (...args: any[]) => mockGetLogger(...args),
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
  triggerPipeline: (...args: any[]) => mockCodefreshTriggerPipeline(...args),
  waitForImage: (...args: any[]) => mockCodefreshWaitForImage(...args),
}));

jest.mock('server/lib/nativeBuild', () => ({
  buildWithNative: (...args: any[]) => mockBuildWithNative(...args),
}));

jest.mock('server/lib/kubernetes', () => ({
  createOrUpdateNamespace: (...args: any[]) => mockCreateOrUpdateNamespace(...args),
}));

jest.mock('shared/utils', () => ({
  ...jest.requireActual('shared/utils'),
  extractEnvVarsWithBuildDependencies: (...args: any[]) => mockExtractEnvVarsWithBuildDependencies(...args),
  waitForColumnValue: (...args: any[]) => mockWaitForColumnValue(...args),
}));

jest.mock('aws-sdk/clients/rds', () =>
  jest.fn().mockImplementation(() => ({
    describeDBInstances: (...args: any[]) => ({
      promise: () => mockRdsDescribeDBInstances(...args),
    }),
    describeDBClusters: (...args: any[]) => ({
      promise: () => mockRdsDescribeDBClusters(...args),
    }),
  }))
);

jest.mock('aws-sdk/clients/resourcegroupstaggingapi', () =>
  jest.fn().mockImplementation(() => ({
    getResources: (...args: any[]) => ({
      promise: () => mockTaggingGetResources(...args),
    }),
  }))
);

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
  codefreshDeploy: (...args: any[]) => mockCodefreshDeploy(...args),
  waitForCodefresh: (...args: any[]) => mockWaitForCodefresh(...args),
}));

describe('DeployService - shouldTriggerGithubDeployment', () => {
  let deployService: DeployService;
  let mockDb: any;
  let mockRedis: any;
  let mockRedlock: any;
  let mockQueueManager: any;
  let conditionalDeployPatch: jest.Mock;
  let conditionalDeployWhere: jest.Mock;
  let currentDeploySelect: jest.Mock;
  let currentDeployFindOne: jest.Mock;

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
    mockCodefreshDeploy.mockReset();
    mockCodefreshBuildImage.mockReset();
    mockCodefreshGetLogs.mockReset();
    mockCodefreshGetRepositoryTag.mockReset();
    mockCodefreshTagExists.mockReset();
    mockCodefreshTriggerPipeline.mockReset();
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

    conditionalDeployPatch = jest.fn().mockResolvedValue(1);
    conditionalDeployWhere = jest.fn().mockReturnValue({ patch: conditionalDeployPatch });
    currentDeploySelect = jest.fn().mockResolvedValue({ id: 1 });
    currentDeployFindOne = jest.fn().mockReturnValue({ select: currentDeploySelect });
    mockDb = {
      models: {
        Deploy: {
          query: jest.fn(() => ({ where: conditionalDeployWhere, findOne: currentDeployFindOne })),
        },
      },
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

  describe('deployment source pinning', () => {
    test('updates only deploys matching the targeted repository and exact effective branch', async () => {
      const mainPatch = jest.fn().mockResolvedValue(undefined);
      const stablePatch = jest.fn().mockResolvedValue(undefined);
      const mainDeploy = {
        id: 1,
        deployableId: 11,
        githubRepositoryId: 42,
        branchName: 'main',
        $query: jest.fn(() => ({ patch: mainPatch })),
      };
      const stableDeploy = {
        id: 2,
        deployableId: 22,
        githubRepositoryId: 42,
        branchName: 'stable',
        $query: jest.fn(() => ({ patch: stablePatch })),
      };
      const deployQuery: any = {
        where: jest.fn().mockReturnThis(),
        withGraphFetched: jest.fn().mockResolvedValue([mainDeploy, stableDeploy]),
      };
      mockDb.models.Deploy = {
        query: jest.fn(() => deployQuery),
        findOne: jest.fn(),
      };
      mockDb.services.Deploy = { hostForDeployableDeploy: jest.fn(() => 'service.example.test') };
      const build = {
        id: 7,
        uuid: 'pr-env-123456',
        triggerType: 'github_pr',
        githubRepositoryId: 42,
        branchName: 'main',
        configSha: null,
        deployables: [
          {
            id: 11,
            name: 'root',
            repositoryId: 42,
            branchName: 'main',
            commentBranchName: null,
            type: DeployTypes.GITHUB,
          },
          {
            id: 22,
            name: 'same-repo-dependency',
            repositoryId: 42,
            branchName: 'stable',
            commentBranchName: null,
            type: DeployTypes.GITHUB,
          },
        ],
        deploys: [mainDeploy, stableDeploy],
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };

      await deployService.findOrCreateDeploys({} as any, build as any, 42, 'main-push-sha', 'main');

      expect(mainPatch).toHaveBeenCalledWith(expect.objectContaining({ branchName: 'main', sha: 'main-push-sha' }));
      expect(stablePatch).not.toHaveBeenCalled();
      expect(github.getShaForDeploy).not.toHaveBeenCalled();
    });

    test('keeps source identity when a root push intentionally targets the whole environment', async () => {
      const rootPatch = jest.fn().mockResolvedValue(undefined);
      const dependencyPatch = jest.fn().mockResolvedValue(undefined);
      const rootDeploy = {
        id: 1,
        deployableId: 11,
        githubRepositoryId: 42,
        branchName: 'main',
        $query: jest.fn(() => ({ patch: rootPatch })),
      };
      const dependencyDeploy = {
        id: 2,
        deployableId: 22,
        githubRepositoryId: 99,
        branchName: 'main',
        $query: jest.fn(() => ({ patch: dependencyPatch })),
      };
      const deployQuery: any = {
        where: jest.fn().mockReturnThis(),
        withGraphFetched: jest.fn().mockResolvedValue([rootDeploy, dependencyDeploy]),
      };
      mockDb.models.Deploy = { query: jest.fn(() => deployQuery), findOne: jest.fn() };
      mockDb.services.Deploy = { hostForDeployableDeploy: jest.fn(() => 'service.example.test') };
      (github.getShaForDeploy as jest.Mock).mockResolvedValue('dependency-head');
      const build = {
        id: 7,
        uuid: 'static-env-123456',
        triggerType: 'github_pr',
        githubRepositoryId: 42,
        branchName: 'main',
        deployables: [
          { id: 11, name: 'root', repositoryId: 42, branchName: 'main', type: DeployTypes.GITHUB },
          { id: 22, name: 'dependency', repositoryId: 99, branchName: 'main', type: DeployTypes.GITHUB },
        ],
        deploys: [rootDeploy, dependencyDeploy],
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };

      await deployService.findOrCreateDeploys({} as any, build as any, undefined, 'root-push-sha', 'main', 42);

      expect(rootPatch).toHaveBeenCalledWith(expect.objectContaining({ sha: 'root-push-sha' }));
      expect(dependencyPatch).toHaveBeenCalledWith(expect.objectContaining({ sha: 'dependency-head' }));
    });

    test('backfills a missing deploy row outside the targeted source without resolving its SHA', async () => {
      const createdPatch = jest.fn().mockResolvedValue(undefined);
      const createdDeploy = {
        id: 3,
        deployableId: 33,
        githubRepositoryId: 43,
        $query: jest.fn(() => ({ patch: createdPatch })),
        $setRelated: jest.fn(),
      };
      const deployQuery: any = {
        where: jest.fn().mockReturnThis(),
        withGraphFetched: jest.fn().mockResolvedValue([]),
      };
      mockDb.models.Deploy = {
        query: jest.fn(() => deployQuery),
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(createdDeploy),
      };
      mockDb.services.Deploy = { hostForDeployableDeploy: jest.fn(() => 'service.example.test') };
      const build = {
        id: 7,
        uuid: 'api-env-123456',
        triggerType: 'api',
        githubRepositoryId: 42,
        branchName: 'main',
        configSha: null,
        deployables: [
          {
            id: 33,
            name: 'other-repo-dependency',
            repositoryId: 43,
            branchName: 'stable',
            commentBranchName: null,
            active: true,
            type: DeployTypes.GITHUB,
          },
        ],
        deploys: [],
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };

      await deployService.findOrCreateDeploys({} as any, build as any, 42, 'main-push-sha', 'main');

      expect(mockDb.models.Deploy.create).toHaveBeenCalledWith(
        expect.objectContaining({ buildId: 7, deployableId: 33, githubRepositoryId: 43 })
      );
      expect(createdPatch).toHaveBeenCalledWith(expect.objectContaining({ branchName: 'stable' }));
      expect(createdPatch.mock.calls[0][0]).not.toHaveProperty('sha');
      expect(github.getShaForDeploy).not.toHaveBeenCalled();
    });

    test('uses the create-time SHA for the root repository without resolving the branch head', async () => {
      const deploy = {
        githubRepositoryId: 42,
        branchName: 'main',
        build: { triggerType: 'api', githubRepositoryId: 42, branchName: 'main', configSha: 'create-sha' },
      };

      await expect((deployService as any).resolveSourceSha(deploy, 'org/repo', 'main')).resolves.toBe('create-sha');
      expect(github.getSHAForBranch).not.toHaveBeenCalled();
    });

    test('uses the pushed source ref for an auto-track run', async () => {
      const deploy = {
        githubRepositoryId: 42,
        branchName: 'main',
        build: { triggerType: 'api', githubRepositoryId: 42, branchName: 'main', configSha: 'create-sha' },
      };

      await expect(
        (deployService as any).resolveSourceSha(deploy, 'org/repo', 'main', 'push-sha', 42, 'main')
      ).resolves.toBe('push-sha');
      expect(github.getSHAForBranch).not.toHaveBeenCalled();
    });

    test('passes the immutable API source ref to the actual Codefresh pipeline invocation', async () => {
      mockCodefreshDeploy.mockResolvedValue('codefresh-build-1');
      mockCodefreshGetLogs.mockResolvedValue('build logs');
      jest.spyOn(deployService, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
      const deploy = {
        id: 5,
        uuid: 'codefresh-deploy',
        githubRepositoryId: 42,
        branchName: 'main',
        sha: null,
        env: {},
        runUUID: 'old-run',
        build: {
          uuid: 'api-env-123456',
          triggerType: 'api',
          githubRepositoryId: 42,
          branchName: 'main',
          configSha: null,
          commentRuntimeEnv: {},
        },
        deployable: {
          name: 'pipeline',
          type: DeployTypes.CODEFRESH,
          repository: { fullName: 'org/repo' },
        },
        reload: jest.fn().mockResolvedValue(undefined),
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        $query: jest.fn(() => ({ patch: jest.fn().mockResolvedValue(undefined) })),
      };

      await deployService.deployCodefresh(deploy as any, 'old-run', 'push-sha', 42, 'main');

      expect(mockCodefreshDeploy).toHaveBeenCalledWith(deploy, deploy.build, deploy.deployable, 'push-sha');
      expect(github.getSHAForBranch).not.toHaveBeenCalled();
    });

    test('keeps the PR Codefresh invocation on its branch when a push source ref is present', async () => {
      (github.getSHAForBranch as jest.Mock).mockResolvedValue('resolved-branch-sha');
      mockCodefreshDeploy.mockResolvedValue('codefresh-build-2');
      mockCodefreshGetLogs.mockResolvedValue('build logs');
      jest.spyOn(deployService, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
      const deploy = {
        id: 6,
        uuid: 'pr-codefresh-deploy',
        githubRepositoryId: 42,
        branchName: 'feature-branch',
        sha: null,
        env: {},
        runUUID: 'old-run',
        build: {
          uuid: 'pr-env-123456',
          triggerType: 'github_pr',
          githubRepositoryId: 42,
          configSha: null,
          commentRuntimeEnv: {},
        },
        deployable: {
          name: 'pipeline',
          type: DeployTypes.CODEFRESH,
          repository: { fullName: 'org/repo' },
        },
        reload: jest.fn().mockResolvedValue(undefined),
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        $query: jest.fn(() => ({ patch: jest.fn().mockResolvedValue(undefined) })),
      };

      await deployService.deployCodefresh(deploy as any, 'old-run', 'push-sha', 42);

      expect(mockCodefreshDeploy).toHaveBeenCalledWith(deploy, deploy.build, deploy.deployable, null);
      expect(github.getSHAForBranch).toHaveBeenCalledWith('feature-branch', 'org', 'repo');
    });

    test('keeps branch resolution for PR builds and dependency repositories', async () => {
      (github.getSHAForBranch as jest.Mock).mockResolvedValue('branch-sha');
      const prDeploy = {
        githubRepositoryId: 42,
        build: { triggerType: 'github_pr', githubRepositoryId: 42, configSha: null },
      };
      const dependencyDeploy = {
        githubRepositoryId: 99,
        branchName: 'stable',
        build: { triggerType: 'api', githubRepositoryId: 42, branchName: 'main', configSha: 'create-sha' },
      };

      await expect((deployService as any).resolveSourceSha(prDeploy, 'org/repo', 'main', 'push-sha')).resolves.toBe(
        'branch-sha'
      );
      await expect(
        (deployService as any).resolveSourceSha(dependencyDeploy, 'org/dependency', 'stable', 'push-sha')
      ).resolves.toBe('branch-sha');
      expect(github.getSHAForBranch).toHaveBeenNthCalledWith(1, 'main', 'org', 'repo');
      expect(github.getSHAForBranch).toHaveBeenNthCalledWith(2, 'stable', 'org', 'dependency');
    });

    test('pins the delivered dependency SHA for a non-API tracked-source run', async () => {
      const dependencyDeploy = {
        githubRepositoryId: 99,
        branchName: 'main',
        build: { triggerType: 'github_pr', githubRepositoryId: 42, branchName: 'main', configSha: null },
      };

      await expect(
        (deployService as any).resolveSourceSha(
          dependencyDeploy,
          'org/dependency',
          'main',
          'dependency-sha',
          99,
          'main'
        )
      ).resolves.toBe('dependency-sha');
      expect(github.getSHAForBranch).not.toHaveBeenCalled();
    });

    test('does not pin same-repository services configured for another branch', async () => {
      (github.getSHAForBranch as jest.Mock).mockResolvedValue('stable-head-sha');
      const dependencyDeploy = {
        githubRepositoryId: 42,
        branchName: 'stable',
        build: { triggerType: 'api', githubRepositoryId: 42, branchName: 'main', configSha: 'root-create-sha' },
      };

      await expect(
        (deployService as any).resolveSourceSha(dependencyDeploy, 'org/repo', 'stable', 'root-push-sha', 42, 'main')
      ).resolves.toBe('stable-head-sha');
      expect(github.getSHAForBranch).toHaveBeenCalledWith('stable', 'org', 'repo');
    });
  });

  describe('failure boundaries', () => {
    const createNativeAfterBuildDeploy = () => ({
      id: 17,
      buildId: 91,
      uuid: 'sample-service-build',
      branchName: 'feature-branch',
      env: {
        FEATURE_FLAG: 'enabled',
      },
      initEnv: {},
      dockerImage: 'old-image',
      build: {
        id: 91,
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
        ecr: 'sample/app-images',
        afterBuildPipelineId: 'sample/after-build',
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
    });

    const prepareNativeAfterBuildTest = (isCurrent: () => boolean) => {
      (github.getSHAForBranch as jest.Mock).mockResolvedValue('abcdef1234567890');
      mockCodefreshTagExists.mockResolvedValue(false);
      mockCodefreshTriggerPipeline.mockResolvedValue('after-build-run');
      mockCodefreshWaitForImage.mockResolvedValue(true);
      jest.spyOn(deployService as any, 'isDeploymentRunCurrent').mockImplementation(async () => isCurrent());
      jest.spyOn(deployService as any, 'waitAndResolveForBuildDependentEnvVars').mockResolvedValue(undefined);
      jest.spyOn(deployService as any, 'syncServiceExternalSecrets').mockResolvedValue({
        secretNames: [],
        buildSecretEnvKeys: new Set(),
      });
      jest.spyOn(deployService, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
      return jest.spyOn(deployService as any, 'patchDeployWithTag').mockResolvedValue(undefined);
    };

    test('buildImage treats a stale run as a superseded no-op before starting work', async () => {
      currentDeploySelect.mockResolvedValue(undefined);
      const deploy = {
        id: 17,
        uuid: 'sample-service-build',
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };

      await expect(deployService.buildImage(deploy as any, 0, 'stale-run')).resolves.toBe(true);

      expect(currentDeployFindOne).toHaveBeenCalledWith({ id: 17, runUUID: 'stale-run' });
      expect(deploy.$fetchGraph).not.toHaveBeenCalled();
      expect(mockCodefreshBuildImage).not.toHaveBeenCalled();
      expect(mockBuildWithNative).not.toHaveBeenCalled();
    });

    test('generation check uses buildId before the Build relation is loaded', async () => {
      const currentBuildWhere = jest.fn().mockResolvedValue({ id: 91 });
      mockDb.models.Build = {
        query: jest.fn(() => ({
          findOne: jest.fn(() => ({
            whereNull: jest.fn(() => ({ where: currentBuildWhere })),
          })),
        })),
      };
      const patchSpy = jest.spyOn(deployService, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
      const deploy = {
        id: 17,
        buildId: 91,
        uuid: 'sample-service-build',
        deployable: { type: DeployTypes.DOCKER, dockerImage: 'nginx' },
        tag: 'latest',
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };

      await expect(
        deployService.buildImage(deploy as any, 0, 'run-c', undefined, undefined, undefined, 7)
      ).resolves.toBe(true);

      expect(currentBuildWhere).toHaveBeenCalledWith('desiredGeneration', 7);
      expect(deploy.$fetchGraph).toHaveBeenCalled();
      expect(patchSpy).toHaveBeenCalledWith(
        deploy,
        expect.objectContaining({ status: DeployStatus.BUILT, dockerImage: 'nginx:latest' }),
        'run-c'
      );
    });

    test('patchAndUpdateActivityFeed skips stale writes and side effects when runUUID no longer owns the deploy', async () => {
      conditionalDeployPatch.mockResolvedValue(0);
      const deploy = {
        id: 17,
        uuid: 'sample-service-build',
        // Deliberately stale in-memory state: fencing must use the affected-row count,
        // not the model instance that the old worker already holds.
        runUUID: 'stale-run',
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };

      await deployService.patchAndUpdateActivityFeed(
        deploy as any,
        { status: DeployStatus.BUILT, dockerImage: 'stale-image' },
        'stale-run'
      );

      expect(conditionalDeployWhere).toHaveBeenCalledWith({ id: 17, runUUID: 'stale-run' });
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        status: DeployStatus.BUILT,
        dockerImage: 'stale-image',
      });
      expect(deploy.$fetchGraph).not.toHaveBeenCalled();
    });

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

      const result = await deployService.buildImage(deploy as any, 0, 'run-1');

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
      expect(conditionalDeployPatch).toHaveBeenCalledWith({ buildPipelineId: 'codefresh-build-123' });
      expect(conditionalDeployPatch).toHaveBeenCalledWith({ buildOutput: 'codefresh logs' });
      expect(patchSpy).toHaveBeenLastCalledWith(deploy, { status: DeployStatus.BUILD_FAILED }, 'run-1');
    });

    test('native builds invoke and wait for their configured after-build pipeline while current', async () => {
      const deploy = createNativeAfterBuildDeploy();
      const patchTagSpy = prepareNativeAfterBuildTest(() => true);
      mockBuildWithNative.mockResolvedValue({ success: true });

      const result = await deployService.buildImageForHelmAndGithub(
        deploy as any,
        'run-1',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(true);
      expect(patchTagSpy).toHaveBeenCalledTimes(1);
      expect(mockCodefreshTriggerPipeline).toHaveBeenCalledTimes(1);
      expect(mockCodefreshTriggerPipeline).toHaveBeenCalledWith(
        'sample/after-build',
        'cli',
        expect.objectContaining({
          FEATURE_FLAG: 'enabled',
          TAG: expect.stringMatching(
            /^123456789012\.dkr\.ecr\.us-west-2\.amazonaws\.com\/sample\/app-images:lfc-abcdef1-/
          ),
          branch: 'feature-branch',
        })
      );
      expect(mockCodefreshWaitForImage).toHaveBeenCalledWith('after-build-run');
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        status: DeployStatus.BUILDING,
        statusMessage: 'Running after-build pipeline...',
        buildLogs: null,
      });
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        buildLogs: 'https://g.codefresh.io/build/after-build-run',
      });
      const runningPatchIndex = conditionalDeployPatch.mock.calls.findIndex(
        ([params]) => params.buildLogs === 'https://g.codefresh.io/build/after-build-run'
      );
      expect(conditionalDeployPatch.mock.invocationCallOrder[runningPatchIndex]).toBeLessThan(
        mockCodefreshWaitForImage.mock.invocationCallOrder[0]
      );
      expect(mockGetLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          afterBuildPipelineId: 'sample/after-build',
          pipelineId: 'after-build-run',
          imageTag: expect.stringContaining('/sample/app-images:lfc-abcdef1-'),
        })
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Codefresh: after-build pipeline completed result=success afterBuildPipelineId=sample\/after-build pipelineId=after-build-run imageTag=.*\/sample\/app-images:lfc-abcdef1-/
        )
      );
    });

    test('a superseded native build publishes nothing and does not trigger its after-build pipeline', async () => {
      let current = true;
      const deploy = createNativeAfterBuildDeploy();
      const patchTagSpy = prepareNativeAfterBuildTest(() => current);
      mockBuildWithNative.mockImplementation(async () => {
        current = false;
        return { success: true, logs: 'native build completed' };
      });

      const result = await deployService.buildImageForHelmAndGithub(
        deploy as any,
        'run-a',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(true);
      expect(mockCodefreshTriggerPipeline).not.toHaveBeenCalled();
      expect(mockCodefreshWaitForImage).not.toHaveBeenCalled();
      expect(patchTagSpy).not.toHaveBeenCalled();
      expect(conditionalDeployPatch).toHaveBeenCalledTimes(1);
      expect(conditionalDeployPatch).toHaveBeenCalledWith({ afterBuildCompletionKey: null, buildLogs: null });
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        'Image: native result publication skipped reason=superseded result=success'
      );
    });

    test('a run superseded during its after-build trigger still awaits the pipeline result', async () => {
      let current = true;
      const deploy = createNativeAfterBuildDeploy();
      const patchTagSpy = prepareNativeAfterBuildTest(() => current);
      mockBuildWithNative.mockResolvedValue({ success: true });
      conditionalDeployPatch.mockImplementation(async () => (current ? 1 : 0));
      mockCodefreshTriggerPipeline.mockImplementation(async () => {
        current = false;
        return 'after-build-run';
      });

      const result = await deployService.buildImageForHelmAndGithub(
        deploy as any,
        'run-a',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(true);
      expect(mockCodefreshTriggerPipeline).toHaveBeenCalledTimes(1);
      expect(mockCodefreshWaitForImage).toHaveBeenCalledWith('after-build-run');
      expect(patchTagSpy).not.toHaveBeenCalled();
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        buildLogs: 'https://g.codefresh.io/build/after-build-run',
      });
      expect(
        conditionalDeployWhere.mock.calls.every(([where]) => where.id === deploy.id && where.runUUID === 'run-a')
      ).toBe(true);
    });

    test('a failed superseded native build neither invokes the after-build pipeline nor publishes failure', async () => {
      let current = true;
      const deploy = createNativeAfterBuildDeploy();
      const patchTagSpy = prepareNativeAfterBuildTest(() => current);
      mockBuildWithNative.mockImplementation(async () => {
        current = false;
        return { success: false, logs: 'native build failed' };
      });

      const result = await deployService.buildImageForHelmAndGithub(
        deploy as any,
        'run-a',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(true);
      expect(mockCodefreshTriggerPipeline).not.toHaveBeenCalled();
      expect(mockCodefreshWaitForImage).not.toHaveBeenCalled();
      expect(patchTagSpy).not.toHaveBeenCalled();
      expect(deployService.patchAndUpdateActivityFeed).not.toHaveBeenCalledWith(
        deploy,
        { status: DeployStatus.BUILD_FAILED },
        'run-a'
      );
    });

    test('a current native after-build pipeline failure still fails the image phase', async () => {
      const deploy = createNativeAfterBuildDeploy();
      const patchTagSpy = prepareNativeAfterBuildTest(() => true);
      mockBuildWithNative.mockResolvedValue({ success: true });
      mockCodefreshWaitForImage.mockResolvedValue(false);

      const result = await deployService.buildImageForHelmAndGithub(
        deploy as any,
        'run-1',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(false);
      expect(patchTagSpy).not.toHaveBeenCalled();
      expect(deployService.patchAndUpdateActivityFeed).toHaveBeenCalledWith(
        deploy,
        {
          status: DeployStatus.BUILD_FAILED,
          statusMessage: 'After-build pipeline failed.',
        },
        'run-1'
      );
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        buildLogs: 'https://g.codefresh.io/build/after-build-run',
      });
      expect(mockCodefreshTriggerPipeline).toHaveBeenCalledTimes(1);
      expect(mockCodefreshWaitForImage).toHaveBeenCalledWith('after-build-run');
      expect(mockGetLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          afterBuildPipelineId: 'sample/after-build',
          pipelineId: 'after-build-run',
        })
      );
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Codefresh: after-build pipeline completed result=failure afterBuildPipelineId=sample\/after-build pipelineId=after-build-run imageTag=/
        )
      );
    });

    test('a current after-build trigger error publishes a terminal after-build failure', async () => {
      const deploy = createNativeAfterBuildDeploy();
      const patchTagSpy = prepareNativeAfterBuildTest(() => true);
      mockBuildWithNative.mockResolvedValue({ success: true });
      mockCodefreshTriggerPipeline.mockRejectedValue(new Error('Codefresh unavailable'));

      const result = await deployService.buildImageForHelmAndGithub(
        deploy as any,
        'run-1',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(false);
      expect(mockCodefreshWaitForImage).not.toHaveBeenCalled();
      expect(patchTagSpy).not.toHaveBeenCalled();
      expect(deployService.patchAndUpdateActivityFeed).toHaveBeenCalledWith(
        deploy,
        { status: DeployStatus.BUILD_FAILED, statusMessage: 'After-build pipeline failed.' },
        'run-1'
      );
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        status: DeployStatus.BUILDING,
        statusMessage: 'Running after-build pipeline...',
        buildLogs: null,
      });
      expect(conditionalDeployPatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ buildLogs: expect.stringContaining('g.codefresh.io/build/') })
      );
      expect(mockLoggerWarn).toHaveBeenCalledWith('Codefresh: after-build pipeline trigger failed');
    });

    const flushUntil = async (done: () => boolean) => {
      for (let i = 0; i < 20 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
    };

    test('a run that finds the image already pushed still runs and awaits the after-build pipeline before BUILT', async () => {
      const deploy = createNativeAfterBuildDeploy();
      const patchTagSpy = prepareNativeAfterBuildTest(() => true);
      mockCodefreshTagExists.mockResolvedValue(true);
      const pipelineResult: { resolve?: (completed: boolean) => void } = {};
      mockCodefreshWaitForImage.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            pipelineResult.resolve = resolve;
          })
      );

      const resultPromise = deployService.buildImageForHelmAndGithub(
        deploy as any,
        'run-b',
        undefined,
        undefined,
        undefined,
        7
      );
      await flushUntil(() => mockCodefreshWaitForImage.mock.calls.length > 0);

      expect(mockBuildWithNative).not.toHaveBeenCalled();
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        status: DeployStatus.BUILDING,
        statusMessage: 'Running after-build pipeline...',
        buildLogs: null,
      });
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        buildLogs: 'https://g.codefresh.io/build/after-build-run',
      });
      const afterBuildUrlPatchIndex = conditionalDeployPatch.mock.calls.findIndex(
        ([params]) => params.buildLogs === 'https://g.codefresh.io/build/after-build-run'
      );
      expect(conditionalDeployPatch.mock.invocationCallOrder[afterBuildUrlPatchIndex]).toBeLessThan(
        mockCodefreshWaitForImage.mock.invocationCallOrder[0]
      );
      expect(mockCodefreshTriggerPipeline).toHaveBeenCalledTimes(1);
      expect(mockCodefreshTriggerPipeline).toHaveBeenCalledWith(
        'sample/after-build',
        'cli',
        expect.objectContaining({
          FEATURE_FLAG: 'enabled',
          TAG: expect.stringContaining('/sample/app-images:lfc-abcdef1-'),
          branch: 'feature-branch',
        })
      );
      expect(mockCodefreshWaitForImage).toHaveBeenCalledWith('after-build-run');
      expect(patchTagSpy).not.toHaveBeenCalled();

      pipelineResult.resolve!(true);
      await expect(resultPromise).resolves.toBe(true);
      expect(patchTagSpy).toHaveBeenCalledTimes(1);
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        afterBuildCompletionKey: expect.stringMatching(
          /^sample\/after-build@.*\/sample\/app-images:lfc-abcdef1-[^@]+$/
        ),
      });
    });

    test('a matching completion record skips the after-build on the existing-image path', async () => {
      const deploy = createNativeAfterBuildDeploy() as any;
      const patchTagSpy = prepareNativeAfterBuildTest(() => true);
      mockCodefreshTagExists.mockResolvedValue(true);
      const envVarsHash = hash({ FEATURE_FLAG: 'enabled' });
      deploy.afterBuildCompletionKey = `sample/after-build@123456789012.dkr.ecr.us-west-2.amazonaws.com/sample/app-images:lfc-abcdef1-${envVarsHash}`;

      const result = await deployService.buildImageForHelmAndGithub(
        deploy,
        'run-b',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(true);
      expect(mockCodefreshTriggerPipeline).not.toHaveBeenCalled();
      expect(mockCodefreshWaitForImage).not.toHaveBeenCalled();
      expect(patchTagSpy).toHaveBeenCalledTimes(1);
      expect(conditionalDeployPatch).not.toHaveBeenCalledWith(expect.objectContaining({ buildLogs: null }));
    });

    test('rebuilding an image clears the previous completion and build link before building', async () => {
      const deploy = createNativeAfterBuildDeploy() as any;
      deploy.afterBuildCompletionKey = 'sample/after-build@stale-tag';
      const patchTagSpy = prepareNativeAfterBuildTest(() => true);
      mockBuildWithNative.mockResolvedValue({ success: true });

      const result = await deployService.buildImageForHelmAndGithub(
        deploy,
        'run-1',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(true);
      expect(conditionalDeployPatch).toHaveBeenCalledWith({ afterBuildCompletionKey: null, buildLogs: null });
      const rebuildClearIndex = conditionalDeployPatch.mock.calls.findIndex(
        ([params]) => params.afterBuildCompletionKey === null && params.buildLogs === null
      );
      expect(conditionalDeployPatch.mock.invocationCallOrder[rebuildClearIndex]).toBeLessThan(
        mockBuildWithNative.mock.invocationCallOrder[0]
      );
      expect(patchTagSpy).toHaveBeenCalledTimes(1);
    });

    test('a rebuild that cannot clear the completion record does not build', async () => {
      const deploy = createNativeAfterBuildDeploy() as any;
      deploy.afterBuildCompletionKey = 'sample/after-build@stale-tag';
      prepareNativeAfterBuildTest(() => true);
      conditionalDeployPatch.mockResolvedValueOnce(0);

      const result = await deployService.buildImageForHelmAndGithub(
        deploy,
        'run-1',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(true);
      expect(mockBuildWithNative).not.toHaveBeenCalled();
      expect(mockCodefreshBuildImage).not.toHaveBeenCalled();
      expect(mockCodefreshTriggerPipeline).not.toHaveBeenCalled();
    });

    test('a codefresh-engine cold build records completion when its embedded after-build is not detached', async () => {
      const deploy = createNativeAfterBuildDeploy() as any;
      deploy.deployable.builder = { engine: 'ci' };
      const patchTagSpy = prepareNativeAfterBuildTest(() => true);
      mockCodefreshBuildImage.mockResolvedValue('codefresh-build-123');
      mockCodefreshGetLogs.mockResolvedValue('codefresh logs');

      const result = await deployService.buildImageForHelmAndGithub(
        deploy,
        'run-1',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(true);
      expect(mockBuildWithNative).not.toHaveBeenCalled();
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        afterBuildCompletionKey: expect.stringMatching(
          /^sample\/after-build@.*\/sample\/app-images:lfc-abcdef1-[^@]+$/
        ),
      });
      expect(patchTagSpy).toHaveBeenCalledTimes(1);
    });

    test('a detached codefresh-engine cold build does not record completion', async () => {
      const deploy = createNativeAfterBuildDeploy() as any;
      deploy.deployable.builder = { engine: 'ci' };
      deploy.deployable.detatchAfterBuildPipeline = true;
      const patchTagSpy = prepareNativeAfterBuildTest(() => true);
      mockCodefreshBuildImage.mockResolvedValue('codefresh-build-123');
      mockCodefreshGetLogs.mockResolvedValue('codefresh logs');

      const result = await deployService.buildImageForHelmAndGithub(
        deploy,
        'run-1',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(true);
      expect(conditionalDeployPatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ afterBuildCompletionKey: expect.any(String) })
      );
      expect(patchTagSpy).toHaveBeenCalledTimes(1);
    });

    test('a failed after-build on the existing-image path never publishes BUILT', async () => {
      const deploy = createNativeAfterBuildDeploy();
      const patchTagSpy = prepareNativeAfterBuildTest(() => true);
      mockCodefreshTagExists.mockResolvedValue(true);
      mockCodefreshWaitForImage.mockResolvedValue(false);

      const result = await deployService.buildImageForHelmAndGithub(
        deploy as any,
        'run-b',
        undefined,
        undefined,
        undefined,
        7
      );

      expect(result).toBe(false);
      expect(patchTagSpy).not.toHaveBeenCalled();
      expect(deployService.patchAndUpdateActivityFeed).toHaveBeenCalledWith(
        deploy,
        {
          status: DeployStatus.BUILD_FAILED,
          statusMessage: 'After-build pipeline failed.',
        },
        'run-b'
      );
      expect(conditionalDeployPatch).toHaveBeenCalledWith({
        buildLogs: 'https://g.codefresh.io/build/after-build-run',
      });
    });

    test('a codefresh-engine cache hit still runs and awaits the after-build pipeline before BUILT', async () => {
      const deploy = createNativeAfterBuildDeploy() as any;
      deploy.deployable.builder = { engine: 'ci' };
      const patchTagSpy = prepareNativeAfterBuildTest(() => true);
      mockCodefreshTagExists.mockResolvedValue(true);
      const pipelineResult: { resolve?: (completed: boolean) => void } = {};
      mockCodefreshWaitForImage.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            pipelineResult.resolve = resolve;
          })
      );

      const resultPromise = deployService.buildImageForHelmAndGithub(
        deploy,
        'run-b',
        undefined,
        undefined,
        undefined,
        7
      );
      await flushUntil(() => mockCodefreshWaitForImage.mock.calls.length > 0);

      expect(mockBuildWithNative).not.toHaveBeenCalled();
      expect(mockCodefreshBuildImage).not.toHaveBeenCalled();
      expect(mockCodefreshTriggerPipeline).toHaveBeenCalledWith(
        'sample/after-build',
        'cli',
        expect.objectContaining({
          TAG: expect.stringContaining('/sample/app-images:lfc-abcdef1-'),
          SOURCE_REVISION: 'abcdef1234567890',
          SOURCE_BRANCH: 'feature-branch',
        })
      );
      expect(patchTagSpy).not.toHaveBeenCalled();

      pipelineResult.resolve!(true);
      await expect(resultPromise).resolves.toBe(true);
      expect(patchTagSpy).toHaveBeenCalledTimes(1);
    });

    test('a run superseded during the existing-image after-build wait publishes neither BUILT nor BUILD_FAILED', async () => {
      let current = true;
      const deploy = createNativeAfterBuildDeploy();
      const patchTagSpy = prepareNativeAfterBuildTest(() => current);
      mockCodefreshTagExists.mockResolvedValue(true);
      const pipelineResult: { resolve?: (completed: boolean) => void } = {};
      mockCodefreshWaitForImage.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            pipelineResult.resolve = resolve;
          })
      );

      const resultPromise = deployService.buildImageForHelmAndGithub(
        deploy as any,
        'run-b',
        undefined,
        undefined,
        undefined,
        7
      );
      await flushUntil(() => mockCodefreshWaitForImage.mock.calls.length > 0);

      current = false;
      pipelineResult.resolve!(true);

      await expect(resultPromise).resolves.toBe(true);
      expect(patchTagSpy).not.toHaveBeenCalled();
      expect(deployService.patchAndUpdateActivityFeed).not.toHaveBeenCalledWith(
        deploy,
        { status: DeployStatus.BUILT },
        'run-b'
      );
      expect(deployService.patchAndUpdateActivityFeed).not.toHaveBeenCalledWith(
        deploy,
        { status: DeployStatus.BUILD_FAILED },
        'run-b'
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        'Image: after-build publication skipped reason=superseded result=success'
      );
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
        expect(conditionalDeployPatch).toHaveBeenCalledWith(
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

    test('deployAurora records failures with its expected runUUID', async () => {
      const patchSpy = jest.spyOn(deployService, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
      jest.spyOn(deployService as any, 'findExistingAuroraDatabase').mockResolvedValue(null);
      mockCliDeploy.mockRejectedValue(new Error('restore command failed'));

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
        $query: jest.fn(() => ({ patch: jest.fn().mockResolvedValue(undefined) })),
      };

      const result = await deployService.deployAurora(deploy as any, 'expected-run');

      expect(result).toBe(false);
      expect(conditionalDeployPatch).toHaveBeenCalledWith(expect.objectContaining({ status: DeployStatus.BUILDING }));
      expect(conditionalDeployPatch).not.toHaveBeenCalledWith(expect.objectContaining({ runUUID: expect.anything() }));
      expect(deploy.runUUID).toBe('old-run');
      expect(patchSpy).toHaveBeenLastCalledWith(
        deploy,
        {
          status: DeployStatus.ERROR,
          statusMessage: 'restore command failed',
        },
        'expected-run'
      );
    });
  });
});

describe('DeployService uncovered public behavior', () => {
  const queueManager = () => ({
    registerQueue: jest.fn(() => ({
      add: jest.fn().mockResolvedValue(undefined),
      process: jest.fn(),
      on: jest.fn(),
    })),
  });

  const serviceHarness = () => {
    const deployPatch = jest.fn().mockResolvedValue(1);
    const deployQuery: any = {
      where: jest.fn(() => deployQuery),
      patch: deployPatch,
      findOne: jest.fn(() => deployQuery),
      select: jest.fn().mockResolvedValue({ id: 1 }),
    };
    const buildQuery: any = {
      findOne: jest.fn(() => buildQuery),
      whereNull: jest.fn(() => buildQuery),
      where: jest.fn(() => buildQuery),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ id: 91 }).then(resolve, reject),
    };
    const githubDeploymentAdd = jest.fn().mockResolvedValue(undefined);
    const updatePullRequestActivityStream = jest.fn().mockResolvedValue(undefined);
    const db: any = {
      models: {
        Deploy: { query: jest.fn(() => deployQuery) },
        Build: { query: jest.fn(() => buildQuery) },
      },
      services: {
        ActivityStream: { updatePullRequestActivityStream },
        GithubService: { githubDeploymentQueue: { add: githubDeploymentAdd } },
      },
    };
    const service = new DeployService(db, {}, {}, queueManager() as any);
    return {
      service,
      db,
      deployQuery,
      deployPatch,
      buildQuery,
      githubDeploymentAdd,
      updatePullRequestActivityStream,
    };
  };

  const codefreshDeploy = (overrides: Record<string, unknown> = {}) => ({
    id: 5,
    buildId: 91,
    uuid: 'pipeline-env',
    githubRepositoryId: 42,
    branchName: 'main',
    sha: null,
    env: {},
    build: {
      id: 91,
      uuid: 'env',
      triggerType: 'github_pr',
      commentRuntimeEnv: {},
    },
    deployable: {
      name: 'pipeline',
      type: DeployTypes.CODEFRESH,
      repository: { fullName: 'org/repo' },
    },
    reload: jest.fn().mockResolvedValue(undefined),
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const sourceBuildDeploy = (): any => ({
    id: 17,
    buildId: 91,
    uuid: 'app-env',
    githubRepositoryId: 42,
    branchName: 'main',
    env: { KEEP: 'visible' },
    initEnv: {},
    dockerImage: 'old-image',
    build: {
      id: 91,
      uuid: 'env',
      namespace: 'env-env',
      isStatic: false,
      triggerType: 'github_pr',
      commentRuntimeEnv: {},
      commentInitEnv: {},
      enabledFeatures: [],
      pullRequest: { githubLogin: 'alice' },
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    },
    deployable: {
      name: 'app',
      type: DeployTypes.GITHUB,
      dockerfilePath: './Dockerfile',
      initDockerfilePath: null,
      env: {},
      ecr: 'org/app',
      builder: { engine: 'buildkit' },
      repository: { fullName: 'org/repo' },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    },
    reload: jest.fn().mockResolvedValue(undefined),
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCliDeploy.mockReset().mockResolvedValue(undefined);
    mockCodefreshDeploy.mockReset().mockResolvedValue('pipeline-1');
    mockWaitForCodefresh.mockReset().mockResolvedValue(undefined);
    mockCodefreshBuildImage.mockReset();
    mockCodefreshGetLogs.mockReset().mockResolvedValue('pipeline output');
    mockCodefreshGetRepositoryTag.mockReset().mockImplementation(({ ecrRepo, tag }) => `${ecrRepo}:${tag}`);
    mockCodefreshTagExists.mockReset();
    mockCodefreshTriggerPipeline.mockReset();
    mockCodefreshWaitForImage.mockReset();
    mockBuildWithNative.mockReset();
    mockCreateOrUpdateNamespace.mockReset().mockResolvedValue(undefined);
    mockExtractEnvVarsWithBuildDependencies.mockReset().mockReturnValue({});
    mockWaitForColumnValue.mockReset();
    mockTaggingGetResources.mockReset().mockResolvedValue({ ResourceTagMappingList: [] });
    mockRdsDescribeDBInstances.mockReset();
    mockRdsDescribeDBClusters.mockReset();
    mockGlobalConfigGetOrgChartName.mockReset().mockResolvedValue('org-chart');
    mockGlobalConfigGetAllConfigs.mockReset().mockResolvedValue({
      lifecycleDefaults: {
        buildPipeline: 'sample/build-image',
        deployCluster: 'test-cluster',
        ecrDomain: 'registry.example.test',
        ecrRegistry: 'sample-registry',
      },
      app_setup: { org: 'example-org' },
      buildDefaults: {},
    });
    mockDetermineChartType.mockReset().mockResolvedValue(ChartType.PUBLIC);
    (github.getSHAForBranch as jest.Mock).mockReset().mockResolvedValue('abcdef1234567890');
    (github.getShaForDeploy as jest.Mock).mockReset().mockResolvedValue('deploy-sha');
  });

  test('findOrCreateDeploys recovers an existing row from the fallback lookup without inserting a duplicate', async () => {
    const { service, db } = serviceHarness();
    const patch = jest.fn().mockResolvedValue(1);
    const existingDeploy = {
      id: 4,
      deployableId: 11,
      githubRepositoryId: 42,
      $query: jest.fn(() => ({ patch })),
    };
    const listQuery: any = {
      where: jest.fn(() => listQuery),
      withGraphFetched: jest.fn().mockResolvedValue([]),
    };
    db.models.Deploy = {
      query: jest.fn(() => listQuery),
      findOne: jest.fn().mockResolvedValue(existingDeploy),
      create: jest.fn(),
    };
    db.services.Deploy = { hostForDeployableDeploy: jest.fn(() => 'app.example.test') };
    const build: any = {
      id: 7,
      uuid: 'env',
      deployables: [
        { id: 11, name: 'app', repositoryId: 42, branchName: 'main', type: DeployTypes.DOCKER, defaultTag: 'latest' },
      ],
      deploys: [existingDeploy],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.findOrCreateDeploys({} as any, build)).resolves.toEqual([existingDeploy]);

    expect(db.models.Deploy.findOne).toHaveBeenCalledWith({ deployableId: 11, buildId: 7 });
    expect(db.models.Deploy.create).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({ deployableId: 11, uuid: 'app-env', publicUrl: 'app.example.test' })
    );
  });

  test('findOrCreateDeploys treats a failed fallback read as missing and creates the deploy', async () => {
    const { service, db } = serviceHarness();
    const patch = jest.fn().mockResolvedValue(1);
    const created = {
      id: 4,
      $query: jest.fn(() => ({ patch })),
      $setRelated: jest.fn(),
    };
    const listQuery: any = {
      where: jest.fn(() => listQuery),
      withGraphFetched: jest.fn().mockResolvedValue([]),
    };
    db.models.Deploy = {
      query: jest.fn(() => listQuery),
      findOne: jest.fn().mockRejectedValue(new Error('replica unavailable')),
      create: jest.fn().mockResolvedValue(created),
    };
    db.services.Deploy = { hostForDeployableDeploy: jest.fn(() => 'app.example.test') };
    const build: any = {
      id: 7,
      uuid: 'env',
      deployables: [
        {
          id: 11,
          name: 'app',
          repositoryId: 42,
          branchName: 'main',
          active: true,
          type: DeployTypes.DOCKER,
        },
      ],
      deploys: [created],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.findOrCreateDeploys({} as any, build)).resolves.toEqual([created]);

    expect(db.models.Deploy.create).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: 7, deployableId: 11, githubRepositoryId: 42, active: true })
    );
    expect(created.$setRelated).toHaveBeenCalledWith('deployable', build.deployables[0]);
    expect(created.$setRelated).toHaveBeenCalledWith('build', build);
  });

  test('findOrCreateDeploys contains one deploy patch failure and still returns the refreshed relation', async () => {
    const { service, db } = serviceHarness();
    const patchError = new Error('deploy patch unavailable');
    const existing = {
      id: 4,
      deployableId: 11,
      $query: jest.fn(() => ({ patch: jest.fn().mockRejectedValue(patchError) })),
    };
    const listQuery: any = {
      where: jest.fn(() => listQuery),
      withGraphFetched: jest.fn().mockResolvedValue([existing]),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    db.models.Deploy = { query: jest.fn(() => listQuery), findOne: jest.fn() };
    db.services.Deploy = { hostForDeployableDeploy: jest.fn(() => 'app.example.test') };
    const build: any = {
      id: 7,
      uuid: 'env',
      deployables: [{ id: 11, name: 'app', repositoryId: 42, branchName: 'main', type: DeployTypes.DOCKER }],
      deploys: [existing],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.findOrCreateDeploys({} as any, build)).resolves.toEqual([existing]);

    expect(mockLoggerError).toHaveBeenCalledWith({ error: patchError }, 'Deploy: create from deployables failed');
  });

  test('findOrCreateDeploys preserves the rest of an update when source SHA lookup fails', async () => {
    const { service, db } = serviceHarness();
    const patch = jest.fn().mockResolvedValue(1);
    const existing = { id: 4, deployableId: 11, $query: jest.fn(() => ({ patch })) };
    const listQuery: any = {
      where: jest.fn(() => listQuery),
      withGraphFetched: jest.fn().mockResolvedValue([existing]),
    };
    db.models.Deploy = { query: jest.fn(() => listQuery), findOne: jest.fn() };
    db.services.Deploy = { hostForDeployableDeploy: jest.fn(() => 'app.example.test') };
    (github.getShaForDeploy as jest.Mock).mockRejectedValue(new Error('github unavailable'));
    const build: any = {
      id: 7,
      uuid: 'env',
      triggerType: 'github_pr',
      deployables: [{ id: 11, name: 'app', repositoryId: 42, branchName: 'main', type: DeployTypes.GITHUB }],
      deploys: [existing],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await service.findOrCreateDeploys({} as any, build);

    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'app-env', branchName: 'main' }));
    expect(patch.mock.calls[0][0]).not.toHaveProperty('sha');
  });

  test('deployAurora returns an already-built endpoint without consulting AWS or running restore', async () => {
    const { service } = serviceHarness();
    const deploy: any = {
      id: 1,
      uuid: 'database-env',
      status: DeployStatus.BUILT,
      cname: 'database.example.test',
      build: { uuid: 'env' },
      deployable: { name: 'database', type: DeployTypes.AURORA_RESTORE },
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.deployAurora(deploy, 'run-1')).resolves.toBe(true);

    expect(mockTaggingGetResources).not.toHaveBeenCalled();
    expect(mockCliDeploy).not.toHaveBeenCalled();
  });

  test('deployAurora adopts an existing cluster endpoint without running restore', async () => {
    const { service, deployPatch } = serviceHarness();
    mockTaggingGetResources.mockResolvedValue({
      ResourceTagMappingList: [{ ResourceARN: 'arn:aws:rds:us-west-2:123:db:instance-1' }],
    });
    mockRdsDescribeDBInstances.mockResolvedValue({
      DBInstances: [{ Endpoint: { Address: 'instance.example.test' }, DBClusterIdentifier: 'cluster-1' }],
    });
    mockRdsDescribeDBClusters.mockResolvedValue({ DBClusters: [{ Endpoint: 'cluster.example.test' }] });
    const deploy: any = {
      id: 1,
      uuid: 'database-env',
      status: DeployStatus.PENDING,
      build: { uuid: 'env' },
      deployable: { name: 'database', type: DeployTypes.AURORA_RESTORE },
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.deployAurora(deploy, 'run-1')).resolves.toBe(true);

    expect(mockRdsDescribeDBInstances).toHaveBeenCalledWith({ DBInstanceIdentifier: 'instance-1' });
    expect(mockRdsDescribeDBClusters).toHaveBeenCalledWith({ DBClusterIdentifier: 'cluster-1' });
    expect(deployPatch).toHaveBeenCalledWith({ cname: 'cluster.example.test', status: DeployStatus.BUILT });
    expect(mockCliDeploy).not.toHaveBeenCalled();
  });

  test('deployAurora restores a missing database and publishes its instance endpoint', async () => {
    const { service, deployPatch } = serviceHarness();
    mockTaggingGetResources.mockResolvedValueOnce({ ResourceTagMappingList: [] }).mockResolvedValueOnce({
      ResourceTagMappingList: [{ ResourceARN: 'arn:aws:rds:us-west-2:123:db:instance-2' }],
    });
    mockRdsDescribeDBInstances.mockResolvedValue({ DBInstances: [{ Endpoint: { Address: 'instance.example.test' } }] });
    const deploy: any = {
      id: 1,
      uuid: 'database-env',
      status: DeployStatus.PENDING,
      build: { uuid: 'env' },
      deployable: { name: 'database', type: DeployTypes.AURORA_RESTORE },
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.deployAurora(deploy, 'run-1')).resolves.toBe(true);

    expect(mockCliDeploy).toHaveBeenCalledWith(deploy);
    expect(deployPatch).toHaveBeenCalledWith(expect.objectContaining({ status: DeployStatus.BUILDING }));
    expect(deployPatch).toHaveBeenCalledWith({ cname: 'instance.example.test' });
    expect(deployPatch).toHaveBeenLastCalledWith({ status: DeployStatus.BUILT });
  });

  test('deployAurora restores when AWS finds an instance before its endpoint is usable', async () => {
    const { service, deployPatch } = serviceHarness();
    mockTaggingGetResources
      .mockResolvedValueOnce({
        ResourceTagMappingList: [{ ResourceARN: 'arn:aws:rds:us-west-2:123:db:instance-starting' }],
      })
      .mockResolvedValueOnce({ ResourceTagMappingList: [] });
    mockRdsDescribeDBInstances.mockResolvedValueOnce({ DBInstances: [{}] });
    const deploy: any = {
      id: 1,
      uuid: 'database-env',
      status: DeployStatus.PENDING,
      build: { uuid: 'env' },
      deployable: { name: 'database', type: DeployTypes.AURORA_RESTORE },
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.deployAurora(deploy, 'run-1')).resolves.toBe(true);

    expect(mockRdsDescribeDBInstances).toHaveBeenCalledWith({ DBInstanceIdentifier: 'instance-starting' });
    expect(mockCliDeploy).toHaveBeenCalledWith(deploy);
    expect(deployPatch).toHaveBeenCalledWith(expect.objectContaining({ status: DeployStatus.BUILDING }));
    expect(deployPatch).not.toHaveBeenCalledWith(expect.objectContaining({ cname: expect.anything() }));
    expect(deployPatch).toHaveBeenLastCalledWith({ status: DeployStatus.BUILT });
  });

  test('deployAurora stops before restore when the fenced BUILDING write loses ownership', async () => {
    const { service, deployPatch } = serviceHarness();
    deployPatch.mockResolvedValueOnce(0);
    const deploy: any = {
      id: 1,
      uuid: 'database-env',
      status: DeployStatus.PENDING,
      build: { uuid: 'env' },
      deployable: { name: 'database', type: DeployTypes.AURORA_RESTORE },
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.deployAurora(deploy, 'run-1')).resolves.toBe(true);

    expect(mockCliDeploy).not.toHaveBeenCalled();
  });

  test('deployCLI dispatches supported service types and leaves unsupported types untouched', async () => {
    const { service } = serviceHarness();
    const aurora = jest.spyOn(service, 'deployAurora').mockResolvedValue(true);
    const codefresh = jest.spyOn(service, 'deployCodefresh').mockResolvedValue(true);
    const auroraDeploy = { deployable: { type: DeployTypes.AURORA_RESTORE } } as any;
    const codefreshDeployable = { deployable: { type: DeployTypes.CODEFRESH } } as any;

    await expect(service.deployCLI(auroraDeploy, 'run-1')).resolves.toBe(true);
    await expect(service.deployCLI(codefreshDeployable, 'run-2', 'sha', 42, 'main')).resolves.toBe(true);
    await expect(
      service.deployCLI({ deployable: { type: DeployTypes.DOCKER } } as any, 'run-3')
    ).resolves.toBeUndefined();
    await expect(service.deployCLI({ deployable: null } as any, 'run-4')).resolves.toBeUndefined();

    expect(aurora).toHaveBeenCalledWith(auroraDeploy, 'run-1');
    expect(codefresh).toHaveBeenCalledWith(codefreshDeployable, 'run-2', 'sha', 42, 'main');
  });

  test('hostForDeployableDeploy and acmARNForDeploy expose the stable routing fallbacks', () => {
    const { service } = serviceHarness();

    expect(
      service.hostForDeployableDeploy(
        { uuid: 'external-env', publicUrl: 'current.example.test' } as any,
        { type: DeployTypes.EXTERNAL_HTTP, defaultPublicUrl: 'default.example.test' } as any
      )
    ).toBe('current.example.test');
    expect(
      service.hostForDeployableDeploy(
        { uuid: 'external-env', publicUrl: null } as any,
        { type: DeployTypes.EXTERNAL_HTTP, defaultPublicUrl: 'default.example.test' } as any
      )
    ).toBe('default.example.test');
    expect(
      service.hostForDeployableDeploy(
        { uuid: 'app-env' } as any,
        {
          type: DeployTypes.DOCKER,
          host: 'example.test',
        } as any
      )
    ).toBe('app-env.example.test');
    expect(service.hostForDeployableDeploy({ uuid: 'app-env' } as any, { type: DeployTypes.DOCKER } as any)).toBe(
      undefined
    );
    expect(service.acmARNForDeploy({ deployable: { acmARN: 'arn:certificate' } } as any)).toBe('arn:certificate');
    expect(service.acmARNForDeploy({ deployable: null } as any)).toBeNull();
  });

  test('deployCodefresh treats an unchanged source and environment as built even when activity publication fails', async () => {
    const { service } = serviceHarness();
    const fullSha = 'abcdef1234567890';
    const deploy = codefreshDeploy({ sha: `${fullSha.substring(0, 7)}-${hash({})}` });
    const activityError = new Error('activity stream unavailable');
    jest.spyOn(service, 'patchAndUpdateActivityFeed').mockRejectedValue(activityError);

    await expect(service.deployCodefresh(deploy as any, 'run-1')).resolves.toBe(true);

    expect(mockCodefreshDeploy).not.toHaveBeenCalled();
    expect(mockWaitForCodefresh).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith({ error: activityError }, 'ActivityFeed: update failed');
  });

  test('deployCodefresh reports false without waiting when the pipeline cannot be triggered', async () => {
    const { service, deployPatch } = serviceHarness();
    const triggerError = new Error('codefresh unavailable');
    mockCodefreshDeploy.mockRejectedValue(triggerError);
    const deploy = codefreshDeploy();

    await expect(service.deployCodefresh(deploy as any, 'run-1')).resolves.toBe(false);

    expect(deployPatch).toHaveBeenCalledWith({
      buildLogs: null,
      buildPipelineId: null,
      buildOutput: null,
      deployPipelineId: null,
      deployOutput: null,
    });
    expect(mockWaitForCodefresh).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith({ error: triggerError }, 'Codefresh: build id missing');
  });

  test('deployCodefresh completes successfully even when both activity updates fail', async () => {
    const { service } = serviceHarness();
    const activityError = new Error('activity stream unavailable');
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockRejectedValue(activityError);
    const deploy = codefreshDeploy();

    await expect(service.deployCodefresh(deploy as any, 'run-1')).resolves.toBe(true);

    expect(mockCodefreshDeploy).toHaveBeenCalledWith(deploy, deploy.build, deploy.deployable, null);
    expect(mockWaitForCodefresh).toHaveBeenCalledWith('pipeline-1');
    expect(mockCodefreshGetLogs).toHaveBeenCalledWith('pipeline-1');
    expect(patchActivity).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
  });

  test('deployCodefresh resolves the configured branch when an API source ref targets another branch', async () => {
    const { service, deployPatch } = serviceHarness();
    const deploy = codefreshDeploy({
      env: null,
      build: {
        id: 91,
        uuid: 'env',
        triggerType: 'api',
        githubRepositoryId: 42,
        branchName: 'main',
        configSha: null,
        commentRuntimeEnv: { FROM_COMMENT: 'present' },
      },
    });

    await expect(
      service.deployCodefresh(deploy as any, 'run-1', 'root-push-sha', 42, 'feature/root-change')
    ).resolves.toBe(true);

    expect(github.getSHAForBranch).toHaveBeenCalledWith('main', 'org', 'repo');
    expect(mockCodefreshDeploy).toHaveBeenCalledWith(deploy, deploy.build, deploy.deployable, null);
    expect(mockWaitForCodefresh).toHaveBeenCalledWith('pipeline-1');
    expect(deployPatch).toHaveBeenLastCalledWith({
      status: DeployStatus.BUILT,
      sha: `abcdef1-${hash({ FROM_COMMENT: 'present' })}`,
      buildOutput: 'pipeline output',
      statusMessage: 'CI build completed',
    });
  });

  test('deployCodefresh publishes a stable terminal error when a triggered pipeline fails', async () => {
    const { service } = serviceHarness();
    const pipelineError = new Error('pipeline failed');
    mockWaitForCodefresh.mockRejectedValue(pipelineError);
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    const deploy = codefreshDeploy();

    await expect(service.deployCodefresh(deploy as any, 'run-1')).resolves.toBe(false);

    expect(patchActivity).toHaveBeenLastCalledWith(
      deploy,
      expect.objectContaining({ status: DeployStatus.ERROR, statusMessage: 'CI build failed' }),
      'run-1'
    );
  });

  test('patchAndUpdateActivityFeed queues public GitHub deployment state and still updates PR activity after queue failure', async () => {
    const { service, deployPatch, githubDeploymentAdd, updatePullRequestActivityStream } = serviceHarness();
    const queueError = new Error('github deployment queue unavailable');
    githubDeploymentAdd.mockRejectedValue(queueError);
    const pullRequest = { id: 55 };
    const build = {
      id: 91,
      kind: 'environment',
      githubDeployments: true,
      pullRequest,
    };
    const deploy: any = {
      id: 1,
      active: true,
      build,
      deployable: { name: 'app', type: DeployTypes.DOCKER, public: true },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      service.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.READY }, 'run-1', 42)
    ).resolves.toBeUndefined();

    expect(deployPatch).toHaveBeenCalledWith({ status: DeployStatus.READY });
    expect(githubDeploymentAdd).toHaveBeenCalledWith('deployment', {
      deployId: 1,
      action: 'create',
    });
    expect(updatePullRequestActivityStream).toHaveBeenCalledWith(
      build,
      [],
      pullRequest,
      null,
      true,
      true,
      null,
      true,
      42
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'GitHub deployment queue failed: deployId=1 error=github deployment queue unavailable'
    );
  });

  test('patchAndUpdateActivityFeed supplies the stable fallback message for an unexplained terminal failure', async () => {
    const { service, deployPatch, githubDeploymentAdd, updatePullRequestActivityStream } = serviceHarness();
    const deploy: any = {
      id: 1,
      build: { id: 91, kind: BuildKind.SANDBOX, githubDeployments: true, pullRequest: { id: 55 } },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await service.patchAndUpdateActivityFeed(deploy, { status: DeployStatus.BUILD_FAILED }, 'run-1');

    expect(deployPatch).toHaveBeenCalledWith({
      status: DeployStatus.BUILD_FAILED,
      statusMessage: 'Build failed. Check build logs for details.',
    });
    expect(githubDeploymentAdd).not.toHaveBeenCalled();
    expect(updatePullRequestActivityStream).not.toHaveBeenCalled();
  });

  test('buildImage delegates a private Helm chart to the source builder', async () => {
    const { service } = serviceHarness();
    mockDetermineChartType.mockResolvedValue(ChartType.LOCAL);
    const buildFromSource = jest.spyOn(service, 'buildImageForHelmAndGithub').mockResolvedValue(true);
    const deploy: any = {
      id: 1,
      uuid: 'chart-env',
      deployable: { type: DeployTypes.HELM },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.buildImage(deploy, 0, 'run-1')).resolves.toBe(true);

    expect(buildFromSource).toHaveBeenCalledWith(
      deploy,
      'run-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
  });

  test('buildImage records the resolved source SHA for a public Helm chart without building it', async () => {
    const { service } = serviceHarness();
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    const deploy: any = {
      id: 1,
      uuid: 'chart-env',
      githubRepositoryId: 42,
      branchName: 'main',
      build: { triggerType: 'github_pr' },
      deployable: {
        type: DeployTypes.HELM,
        repository: { fullName: 'org/charts' },
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.buildImage(deploy, 0, 'run-1')).resolves.toBe(true);

    expect(github.getSHAForBranch).toHaveBeenCalledWith('main', 'org', 'charts');
    expect(patchActivity).toHaveBeenCalledWith(
      deploy,
      {
        status: DeployStatus.BUILT,
        statusMessage: 'Helm chart does not need to be built',
        sha: 'abcdef1234567890',
      },
      'run-1'
    );
    expect(mockCodefreshBuildImage).not.toHaveBeenCalled();
  });

  test('buildImage keeps a public Helm chart usable when source SHA lookup fails', async () => {
    const { service } = serviceHarness();
    const sourceError = new Error('github unavailable');
    (github.getSHAForBranch as jest.Mock).mockRejectedValue(sourceError);
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    const deploy: any = {
      id: 1,
      uuid: 'chart-env',
      githubRepositoryId: 42,
      branchName: 'main',
      build: { triggerType: 'github_pr' },
      deployable: { type: DeployTypes.HELM, repository: { fullName: 'org/charts' } },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.buildImage(deploy, 0, 'run-1')).resolves.toBe(true);

    expect(patchActivity).toHaveBeenCalledWith(
      deploy,
      { status: DeployStatus.BUILT, statusMessage: 'Helm chart does not need to be built' },
      'run-1'
    );
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      'Could not get SHA for PUBLIC helm chart, continuing without it'
    );
  });

  test('buildImage returns false for an unrecognized deployable type without publishing status', async () => {
    const { service } = serviceHarness();
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    const deploy: any = {
      id: 1,
      uuid: 'unknown-env',
      deployable: { type: 'future-type' },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.buildImage(deploy, 0, 'run-1')).resolves.toBe(false);

    expect(patchActivity).not.toHaveBeenCalled();
  });

  test('buildImage rethrows authority-lock loss from Helm processing', async () => {
    const { service } = serviceHarness();
    const lockError = new AuthorityLockLostError('deploy-external-secrets.1');
    mockDetermineChartType.mockRejectedValue(lockError);
    const deploy: any = {
      id: 1,
      uuid: 'chart-env',
      deployable: { type: DeployTypes.HELM },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.buildImage(deploy, 0, 'run-1')).rejects.toBe(lockError);
  });

  test('buildImage fails closed when an execution error cannot be fenced by an authority read', async () => {
    const { service, deployQuery } = serviceHarness();
    const executionError = new Error('deploy graph unavailable');
    const authorityError = new Error('deploy authority unavailable');
    deployQuery.select.mockResolvedValueOnce({ id: 1 }).mockRejectedValueOnce(authorityError);
    const recordFailure = jest.spyOn(service, 'recordDeployFailure').mockResolvedValue(false);
    const deploy: any = {
      id: 1,
      buildId: 91,
      uuid: 'app-env',
      $fetchGraph: jest.fn().mockRejectedValue(executionError),
    };

    await expect(service.buildImage(deploy, 0, 'run-1', undefined, undefined, undefined, 7)).resolves.toBe(true);

    expect(recordFailure).not.toHaveBeenCalled();
    expect(executionError).not.toBe(authorityError);
  });

  test('buildImageForHelmAndGithub publishes READY for an external host without resolving source', async () => {
    const { service } = serviceHarness();
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    const deploy: any = {
      id: 1,
      uuid: 'external-env',
      branchName: null,
      build: { uuid: 'env' },
      deployable: { name: 'external' },
    };

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1')).resolves.toBeUndefined();

    expect(patchActivity).toHaveBeenCalledWith(deploy, { status: DeployStatus.READY }, 'run-1');
    expect(github.getSHAForBranch).not.toHaveBeenCalled();
  });

  test('buildImageForHelmAndGithub stops before registry calls when ECR configuration is incomplete', async () => {
    const { service } = serviceHarness();
    mockGlobalConfigGetAllConfigs.mockResolvedValue({
      lifecycleDefaults: { ecrDomain: null, ecrRegistry: null },
      app_setup: {},
      buildDefaults: {},
    });
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    const deployable = {
      name: 'app',
      type: DeployTypes.GITHUB,
      repository: { fullName: 'org/repo' },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const deploy: any = {
      id: 1,
      uuid: 'app-env',
      githubRepositoryId: 42,
      branchName: 'main',
      env: {},
      build: {
        uuid: 'env',
        triggerType: 'github_pr',
        commentRuntimeEnv: {},
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      },
      deployable,
    };

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1')).resolves.toBe(false);

    expect(patchActivity).toHaveBeenLastCalledWith(deploy, { status: DeployStatus.ERROR }, 'run-1');
    expect(mockCodefreshTagExists).not.toHaveBeenCalled();
    expect(mockCodefreshBuildImage).not.toHaveBeenCalled();
  });

  test('deployAurora continues with a fenced restore when AWS discovery is temporarily unavailable', async () => {
    const { service } = serviceHarness();
    const awsError = new Error('AWS discovery unavailable');
    mockTaggingGetResources.mockRejectedValue(awsError);
    const deploy: any = {
      id: 1,
      uuid: 'database-env',
      status: DeployStatus.PENDING,
      build: { uuid: 'env' },
      deployable: { name: 'database', type: DeployTypes.AURORA_RESTORE },
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.deployAurora(deploy, 'run-1')).resolves.toBe(true);

    expect(mockCliDeploy).toHaveBeenCalledWith(deploy);
    expect(mockLoggerDebug).toHaveBeenCalledWith({ error: awsError }, 'Aurora: check failed');
  });

  test('deployCodefresh stops before pipeline invocation when its ownership-clearing patch is stale', async () => {
    const { service, deployPatch } = serviceHarness();
    deployPatch.mockResolvedValueOnce(0);
    const deploy = codefreshDeploy();

    await expect(service.deployCodefresh(deploy as any, 'run-1')).resolves.toBe(true);

    expect(mockCodefreshDeploy).not.toHaveBeenCalled();
    expect(mockWaitForCodefresh).not.toHaveBeenCalled();
  });

  test('deployCodefresh records a source-resolution failure before invoking the pipeline', async () => {
    const { service } = serviceHarness();
    const deploy = codefreshDeploy({ branchName: null });
    const recordFailure = jest.spyOn(service, 'recordDeployFailure').mockResolvedValue(false);

    await expect(service.deployCodefresh(deploy as any, 'run-1')).resolves.toBe(false);

    expect(recordFailure).toHaveBeenCalledWith(
      deploy,
      'run-1',
      expect.objectContaining({
        status: DeployStatus.BUILD_FAILED,
        fallbackMessage: 'CI build failed.',
        error: expect.objectContaining({
          message:
            'Unable to resolve branch "the selected branch" in repository "org/repo". Verify the branch exists and the repository matches the selected service.',
        }),
      })
    );
    expect(mockCodefreshDeploy).not.toHaveBeenCalled();
  });

  test('buildImage contains an ordinary Helm classifier failure as a false image result', async () => {
    const { service } = serviceHarness();
    const classifierError = new Error('chart metadata unavailable');
    mockDetermineChartType.mockRejectedValue(classifierError);
    const deploy: any = {
      id: 1,
      uuid: 'chart-env',
      deployable: { type: DeployTypes.HELM },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.buildImage(deploy, 0, 'run-1')).resolves.toBe(false);

    expect(mockLoggerWarn).toHaveBeenCalledWith({ error: classifierError }, 'Helm: deployment processing failed');
  });

  test('syncServiceExternalSecrets returns an empty result without configured providers or secret references', async () => {
    const { service } = serviceHarness();
    const deploy = sourceBuildDeploy();
    const processSecrets = jest.spyOn(SecretProcessor.prototype, 'processEnvSecrets');

    try {
      await expect(
        (service as any).syncServiceExternalSecrets({
          deploy,
          serviceName: 'app',
          secretProviders: undefined,
          runUUID: 'run-1',
        })
      ).resolves.toEqual({ secretNames: [], buildSecretEnvKeys: new Set() });

      await expect(
        (service as any).syncServiceExternalSecrets({
          deploy,
          serviceName: 'app',
          secretProviders: { aws: { enabled: true } },
          runUUID: 'run-1',
        })
      ).resolves.toEqual({ secretNames: [], buildSecretEnvKeys: new Set() });

      expect(processSecrets).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    } finally {
      processSecrets.mockRestore();
    }
  });

  test('syncServiceExternalSecrets rejects conflicting build and init references for the same env key', async () => {
    const { service } = serviceHarness();
    const deploy = sourceBuildDeploy();
    deploy.env = { TOKEN: '{{aws:repo/build:TOKEN}}' };
    deploy.initEnv = { TOKEN: '{{aws:repo/init:TOKEN}}' };
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    const processSecrets = jest.spyOn(SecretProcessor.prototype, 'processEnvSecrets');

    try {
      await expect(
        (service as any).syncServiceExternalSecrets({
          deploy,
          serviceName: 'app',
          secretProviders: { aws: { enabled: true } },
          runUUID: 'run-1',
        })
      ).resolves.toBe(false);

      expect(patchActivity).toHaveBeenCalledWith(deploy, { status: DeployStatus.BUILD_FAILED }, 'run-1');
      expect(processSecrets).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    } finally {
      processSecrets.mockRestore();
    }
  });

  test('syncServiceExternalSecrets uses the BuildService mutation gate and stops when admission is lost', async () => {
    const { service, db } = serviceHarness();
    const deploy = sourceBuildDeploy();
    deploy.env = { TOKEN: '{{aws:repo/build:TOKEN}}' };
    const gate = jest.fn().mockResolvedValue({ admitted: false });
    db.services.BuildService = { withCurrentDeploySecretMutationLock: gate };
    const processSecrets = jest.spyOn(SecretProcessor.prototype, 'processEnvSecrets');

    try {
      await expect(
        (service as any).syncServiceExternalSecrets({
          deploy,
          serviceName: 'app',
          secretProviders: { aws: { enabled: true } },
          runUUID: 'run-1',
          expectedGeneration: 7,
        })
      ).resolves.toBe(false);

      expect(gate).toHaveBeenCalledWith(17, expect.any(Function), expect.any(Function));
      expect(processSecrets).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    } finally {
      processSecrets.mockRestore();
    }
  });

  test('syncServiceExternalSecrets returns processed build keys without waiting when no Kubernetes secret is expected', async () => {
    const { service } = serviceHarness();
    const deploy = sourceBuildDeploy();
    deploy.env = { TOKEN: '{{aws:repo/build:TOKEN}}' };
    const processSecrets = jest.spyOn(SecretProcessor.prototype, 'processEnvSecrets').mockResolvedValue({
      secretRefs: [{ envKey: 'TOKEN', provider: 'aws', path: 'repo/build', key: 'TOKEN' }],
      expectedKeysPerSecret: {},
      syncTokensPerSecret: {},
      warnings: ['provider used a deprecated field'],
    });
    const waitForSecretSync = jest.spyOn(SecretProcessor.prototype, 'waitForSecretSync');

    try {
      await expect(
        (service as any).syncServiceExternalSecrets({
          deploy,
          serviceName: 'app',
          secretProviders: { aws: { enabled: true } },
          runUUID: 'run-1',
          expectedGeneration: 7,
        })
      ).resolves.toEqual({ secretNames: [], buildSecretEnvKeys: new Set(['TOKEN']) });

      expect(waitForSecretSync).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Build: secret processing warnings service=app warnings=provider used a deprecated field'
      );
    } finally {
      processSecrets.mockRestore();
      waitForSecretSync.mockRestore();
    }
  });

  test('syncServiceExternalSecrets publishes BUILD_FAILED when provider convergence fails for the current run', async () => {
    const { service } = serviceHarness();
    const deploy = sourceBuildDeploy();
    deploy.env = { TOKEN: '{{aws:repo/build:TOKEN}}' };
    const syncError = new Error('external secret did not converge');
    const processSecrets = jest.spyOn(SecretProcessor.prototype, 'processEnvSecrets').mockResolvedValue({
      secretRefs: [{ envKey: 'TOKEN', provider: 'aws', path: 'repo/build', key: 'TOKEN' }],
      expectedKeysPerSecret: { 'app-aws-secrets': ['TOKEN'] },
      syncTokensPerSecret: { 'app-aws-secrets': 'sync-1' },
      warnings: [],
    });
    const waitForSecretSync = jest.spyOn(SecretProcessor.prototype, 'waitForSecretSync').mockRejectedValue(syncError);
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    try {
      await expect(
        (service as any).syncServiceExternalSecrets({
          deploy,
          serviceName: 'app',
          secretProviders: { aws: { enabled: true, secretSyncTimeout: 12 } },
          runUUID: 'run-1',
          expectedGeneration: 7,
        })
      ).resolves.toBe(false);

      expect(waitForSecretSync).toHaveBeenCalledWith({ 'app-aws-secrets': ['TOKEN'] }, 'env-env', 12000, {
        'app-aws-secrets': 'sync-1',
      });
      expect(patchActivity).toHaveBeenCalledWith(deploy, { status: DeployStatus.BUILD_FAILED }, 'run-1');
    } finally {
      processSecrets.mockRestore();
      waitForSecretSync.mockRestore();
    }
  });

  test('waitAndResolveForBuildDependentEnvVars waits, extracts matches, preserves ordering-only dependencies, and patches once', async () => {
    const { service, deployPatch } = serviceHarness();
    const dependentDeploy = { uuid: 'database-env' };
    const deploy = sourceBuildDeploy();
    deploy.build.deploys = [dependentDeploy as any];
    deploy.deployable.env = { DATABASE_URL: 'build:database' };
    mockExtractEnvVarsWithBuildDependencies.mockReturnValue({
      database: [
        { envKey: 'DATABASE_URL', pattern: 'postgres://[^\\s]+' },
        { envKey: 'ORDER_ONLY', pattern: '' },
        { envKey: 'NOT_FOUND', pattern: 'redis://[^\\s]+' },
      ],
    });
    mockWaitForColumnValue
      .mockResolvedValueOnce({ buildPipelineId: 'pipeline-db' })
      .mockResolvedValueOnce({ buildOutput: 'DATABASE_URL=postgres://db.example.test/app' });
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await service.waitAndResolveForBuildDependentEnvVars(deploy as any, { KEEP: 'visible' }, 'run-1');

    expect(patchActivity).toHaveBeenCalledWith(
      deploy,
      { status: DeployStatus.WAITING, statusMessage: 'Waiting for database-env to finish building.' },
      'run-1'
    );
    expect(mockWaitForColumnValue).toHaveBeenNthCalledWith(1, dependentDeploy, 'buildPipelineId');
    expect(mockWaitForColumnValue).toHaveBeenNthCalledWith(2, dependentDeploy, 'buildOutput', 240, 5000);
    expect(deployPatch).toHaveBeenLastCalledWith({
      env: {
        KEEP: 'visible',
        DATABASE_URL: 'postgres://db.example.test/app',
        ORDER_ONLY: '',
      },
    });
  });

  test.each([
    ['times out', undefined, 'Timed out waiting for build output from database-env'],
    ['has no logs', { buildOutput: null }, 'No output logs found for app-env'],
  ])('waitAndResolveForBuildDependentEnvVars rejects when dependency output %s', async (_case, output, message) => {
    const { service, deployPatch } = serviceHarness();
    const dependentDeploy = { uuid: 'database-env' };
    const deploy = sourceBuildDeploy();
    deploy.build.deploys = [dependentDeploy as any];
    mockExtractEnvVarsWithBuildDependencies.mockReturnValue({
      database: [{ envKey: 'DATABASE_URL', pattern: 'postgres://[^\\s]+' }],
    });
    mockWaitForColumnValue.mockResolvedValueOnce({ buildPipelineId: 'pipeline-db' }).mockResolvedValueOnce(output);
    jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await expect(
      service.waitAndResolveForBuildDependentEnvVars(deploy as any, { KEEP: 'visible' }, 'run-1')
    ).rejects.toThrow(message);

    expect(deployPatch).not.toHaveBeenCalled();
  });

  test('buildImageForHelmAndGithub contains a tag-patch database failure and completes the cached-image path', async () => {
    const { service, deployPatch } = serviceHarness();
    const tagPatchError = new Error('deploy tag patch unavailable');
    deployPatch.mockRejectedValue(tagPatchError);
    mockCodefreshTagExists.mockResolvedValue(true);
    const deploy = sourceBuildDeploy();
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1')).resolves.toBe(true);

    expect(mockLoggerWarn).toHaveBeenCalledWith({ error: tagPatchError }, 'Deploy: tag patch failed');
    expect(patchActivity).toHaveBeenLastCalledWith(deploy, { status: DeployStatus.BUILT }, 'run-1');
  });

  test('a cached native image tolerates nullable service and comment environments without scanning secrets', async () => {
    const { service, deployPatch } = serviceHarness();
    mockCodefreshTagExists.mockResolvedValue(true);
    mockGlobalConfigGetAllConfigs.mockResolvedValue({
      lifecycleDefaults: {
        buildPipeline: 'sample/build-image',
        deployCluster: 'test-cluster',
        ecrDomain: 'registry.example.test',
        ecrRegistry: 'sample-registry',
      },
      app_setup: { org: 'example-org' },
      buildDefaults: {},
      secretProviders: { aws: { enabled: true } },
    });
    const deploy = sourceBuildDeploy();
    deploy.env = null;
    deploy.initEnv = null;
    deploy.build.commentRuntimeEnv = null;
    deploy.build.commentInitEnv = null;
    const processSecrets = jest.spyOn(SecretProcessor.prototype, 'processEnvSecrets');

    try {
      await expect(service.buildImageForHelmAndGithub(deploy, 'run-1')).resolves.toBe(true);

      expect(mockCodefreshTagExists).toHaveBeenCalledWith(expect.objectContaining({ tag: `lfc-abcdef1-${hash({})}` }));
      expect(processSecrets).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
      expect(mockBuildWithNative).not.toHaveBeenCalled();
      expect(deployPatch).toHaveBeenCalledWith(
        expect.objectContaining({ status: DeployStatus.BUILT, statusMessage: 'Successfully built image' })
      );
      expect(deployPatch).toHaveBeenLastCalledWith({ status: DeployStatus.BUILT });
    } finally {
      processSecrets.mockRestore();
    }
  });

  test('native image builds exclude externally injected secret env keys while preserving ordinary build env', async () => {
    const { service } = serviceHarness();
    mockCodefreshTagExists.mockResolvedValue(false);
    mockBuildWithNative.mockResolvedValue({ success: true });
    const deploy = sourceBuildDeploy();
    deploy.env = {
      TOKEN: '{{aws:repo/build:TOKEN}}',
      KEEP: 'visible',
    };
    jest.spyOn(service, 'waitAndResolveForBuildDependentEnvVars').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'syncServiceExternalSecrets').mockResolvedValue({
      secretNames: ['app-aws-secrets'],
      buildSecretEnvKeys: new Set(['TOKEN']),
    });
    jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'patchDeployWithTag').mockResolvedValue(undefined);

    await expect(
      service.buildImageForHelmAndGithub(deploy, 'run-1', undefined, undefined, undefined, undefined, 'builder-sa')
    ).resolves.toBe(true);

    expect(mockBuildWithNative).toHaveBeenCalledWith(
      deploy,
      expect.objectContaining({
        envVars: { KEEP: 'visible' },
        secretRefs: ['app-aws-secrets'],
        secretEnvKeys: ['TOKEN'],
        serviceAccount: 'builder-sa',
      })
    );
  });

  test('a comment-only secret is scanned but excluded from native build env when the stored service env is null', async () => {
    const { service, deployPatch } = serviceHarness();
    mockCodefreshTagExists.mockResolvedValue(false);
    mockBuildWithNative.mockResolvedValue({ success: true });
    mockGlobalConfigGetAllConfigs.mockResolvedValue({
      lifecycleDefaults: {
        buildPipeline: 'sample/build-image',
        deployCluster: 'test-cluster',
        ecrDomain: 'registry.example.test',
        ecrRegistry: 'sample-registry',
      },
      app_setup: { org: 'example-org' },
      buildDefaults: {},
      secretProviders: { aws: { enabled: true } },
    });
    const deploy = sourceBuildDeploy();
    deploy.env = null;
    deploy.initEnv = null;
    deploy.build.commentRuntimeEnv = { TOKEN: '{{aws:repo/comment:TOKEN}}' };
    deploy.build.commentInitEnv = null;
    const processSecrets = jest.spyOn(SecretProcessor.prototype, 'processEnvSecrets').mockResolvedValue({
      secretRefs: [{ envKey: 'TOKEN', provider: 'aws', path: 'repo/comment', key: 'TOKEN' }],
      expectedKeysPerSecret: { 'app-aws-secrets': ['TOKEN'] },
      syncTokensPerSecret: { 'app-aws-secrets': 'sync-1' },
      warnings: [],
    });
    const waitForSecretSync = jest.spyOn(SecretProcessor.prototype, 'waitForSecretSync').mockResolvedValue(undefined);

    try {
      await expect(service.buildImageForHelmAndGithub(deploy, 'run-1')).resolves.toBe(true);

      expect(processSecrets).toHaveBeenCalledWith({
        env: { TOKEN: '{{aws:repo/comment:TOKEN}}' },
        serviceName: 'app',
        namespace: 'env-env',
        buildUuid: 'app-env',
      });
      expect(waitForSecretSync).toHaveBeenCalledWith({ 'app-aws-secrets': ['TOKEN'] }, 'env-env', 60000, {
        'app-aws-secrets': 'sync-1',
      });
      expect(mockBuildWithNative).toHaveBeenCalledWith(
        deploy,
        expect.objectContaining({
          envVars: {},
          secretRefs: ['app-aws-secrets'],
          secretEnvKeys: ['TOKEN'],
        })
      );
      expect(deployPatch).toHaveBeenCalledWith(
        expect.objectContaining({ status: DeployStatus.BUILT, statusMessage: 'Successfully built image' })
      );
    } finally {
      processSecrets.mockRestore();
      waitForSecretSync.mockRestore();
    }
  });

  test('a failed cold-image after-build does not publish a terminal result after deployment authority moves', async () => {
    const { service, deployQuery, deployPatch } = serviceHarness();
    let current = true;
    deployQuery.select.mockImplementation(async () => (current ? { id: 17 } : null));
    mockCodefreshTagExists.mockResolvedValue(false);
    mockBuildWithNative.mockResolvedValue({ success: true });
    mockCodefreshTriggerPipeline.mockResolvedValue('after-build-run');
    mockCodefreshWaitForImage.mockImplementation(async () => {
      current = false;
      return false;
    });
    const deploy = sourceBuildDeploy();
    deploy.deployable.afterBuildPipelineId = 'org/after-build';

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-cold')).resolves.toBe(true);

    expect(mockCodefreshTriggerPipeline).toHaveBeenCalledWith(
      'org/after-build',
      'cli',
      expect.objectContaining({ SOURCE_REVISION: 'abcdef1234567890', SOURCE_BRANCH: 'main' })
    );
    expect(mockCodefreshWaitForImage).toHaveBeenCalledWith('after-build-run');
    expect(deployPatch).not.toHaveBeenCalledWith(expect.objectContaining({ status: DeployStatus.BUILT }));
    expect(deployPatch).not.toHaveBeenCalledWith(expect.objectContaining({ status: DeployStatus.BUILD_FAILED }));
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'Image: after-build publication skipped reason=superseded result=failure'
    );
  });

  test('a failed cached-image after-build does not publish a terminal result after deployment authority moves', async () => {
    const { service, deployQuery, deployPatch } = serviceHarness();
    let current = true;
    deployQuery.select.mockImplementation(async () => (current ? { id: 17 } : null));
    mockCodefreshTagExists.mockResolvedValue(true);
    mockCodefreshTriggerPipeline.mockResolvedValue('after-build-run');
    mockCodefreshWaitForImage.mockImplementation(async () => {
      current = false;
      return false;
    });
    const deploy = sourceBuildDeploy();
    deploy.deployable.afterBuildPipelineId = 'org/after-build';

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-cached')).resolves.toBe(true);

    expect(mockBuildWithNative).not.toHaveBeenCalled();
    expect(mockCodefreshTriggerPipeline).toHaveBeenCalledWith(
      'org/after-build',
      'cli',
      expect.objectContaining({ SOURCE_REVISION: 'abcdef1234567890', SOURCE_BRANCH: 'main' })
    );
    expect(mockCodefreshWaitForImage).toHaveBeenCalledWith('after-build-run');
    expect(deployPatch).not.toHaveBeenCalledWith(expect.objectContaining({ status: DeployStatus.BUILT }));
    expect(deployPatch).not.toHaveBeenCalledWith(expect.objectContaining({ status: DeployStatus.BUILD_FAILED }));
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'Image: after-build publication skipped reason=superseded result=failure'
    );
  });

  test('native image build stops before the builder when external-secret mutation fails', async () => {
    const { service } = serviceHarness();
    mockCodefreshTagExists.mockResolvedValue(false);
    const deploy = sourceBuildDeploy();
    jest.spyOn(service, 'waitAndResolveForBuildDependentEnvVars').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'syncServiceExternalSecrets').mockResolvedValue(false);
    jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1')).resolves.toBe(false);

    expect(mockBuildWithNative).not.toHaveBeenCalled();
  });

  test('native image build stops after secret sync when deployment authority has moved', async () => {
    const { service } = serviceHarness();
    mockCodefreshTagExists.mockResolvedValue(false);
    const deploy = sourceBuildDeploy();
    jest.spyOn(service, 'waitAndResolveForBuildDependentEnvVars').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'syncServiceExternalSecrets').mockResolvedValue({
      secretNames: [],
      buildSecretEnvKeys: new Set(),
    });
    jest
      .spyOn(service as any, 'isDeploymentRunCurrent')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1', undefined, undefined, undefined, 7)).resolves.toBe(
      true
    );

    expect(mockBuildWithNative).not.toHaveBeenCalled();
  });

  test('source image build stops after dependency resolution when deployment authority has moved', async () => {
    const { service } = serviceHarness();
    mockCodefreshTagExists.mockResolvedValue(false);
    const deploy = sourceBuildDeploy();
    const waitForDependencies = jest
      .spyOn(service, 'waitAndResolveForBuildDependentEnvVars')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'isDeploymentRunCurrent').mockResolvedValue(false);
    jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1', undefined, undefined, undefined, 7)).resolves.toBe(
      true
    );

    expect(waitForDependencies).toHaveBeenCalled();
    expect(deploy.reload).not.toHaveBeenCalled();
    expect(mockBuildWithNative).not.toHaveBeenCalled();
  });

  test('a current failed native build persists bounded logs and publishes BUILD_FAILED', async () => {
    const { service, deployPatch } = serviceHarness();
    const logs = `discarded-${'x'.repeat(70_000)}`;
    mockCodefreshTagExists.mockResolvedValue(false);
    mockBuildWithNative.mockResolvedValue({ success: false, logs });
    const deploy = sourceBuildDeploy();
    jest.spyOn(service, 'waitAndResolveForBuildDependentEnvVars').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'syncServiceExternalSecrets').mockResolvedValue({
      secretNames: [],
      buildSecretEnvKeys: new Set(),
    });
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1')).resolves.toBe(false);

    expect(deployPatch).toHaveBeenCalledWith({ buildOutput: logs.slice(-65536) });
    expect(patchActivity).toHaveBeenLastCalledWith(deploy, { status: DeployStatus.BUILD_FAILED }, 'run-1');
  });

  test('a native result is ignored when authority moves between its two publication checks', async () => {
    const { service } = serviceHarness();
    mockCodefreshTagExists.mockResolvedValue(false);
    mockBuildWithNative.mockResolvedValue({ success: true });
    const deploy = sourceBuildDeploy();
    jest.spyOn(service, 'waitAndResolveForBuildDependentEnvVars').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'syncServiceExternalSecrets').mockResolvedValue({
      secretNames: [],
      buildSecretEnvKeys: new Set(),
    });
    jest
      .spyOn(service as any, 'isDeploymentRunCurrent')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    const patchTag = jest.spyOn(service as any, 'patchDeployWithTag').mockResolvedValue(undefined);

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1', undefined, undefined, undefined, 7)).resolves.toBe(
      true
    );

    expect(patchTag).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'Image: native result publication skipped reason=superseded result=success'
    );
  });

  test('a Codefresh image result is ignored when deployment authority moves during the pipeline wait', async () => {
    const { service, deployPatch } = serviceHarness();
    mockCodefreshTagExists.mockResolvedValue(false);
    mockCodefreshBuildImage.mockResolvedValue('build-1');
    mockCodefreshWaitForImage.mockResolvedValue(true);
    mockCodefreshGetLogs.mockResolvedValue('build logs');
    const deploy = sourceBuildDeploy();
    deploy.deployable.builder.engine = 'ci';
    jest.spyOn(service, 'waitAndResolveForBuildDependentEnvVars').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'isDeploymentRunCurrent')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1', undefined, undefined, undefined, 7)).resolves.toBe(
      true
    );

    expect(deployPatch).not.toHaveBeenCalledWith({ buildOutput: 'build logs' });
  });

  test('cached native image publication stops when external-secret sync fails or authority moves', async () => {
    const first = serviceHarness();
    mockCodefreshTagExists.mockResolvedValue(true);
    const failedSyncDeploy = sourceBuildDeploy();
    jest.spyOn(first.service as any, 'syncServiceExternalSecrets').mockResolvedValue(false);
    jest.spyOn(first.service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    const firstPatchTag = jest.spyOn(first.service as any, 'patchDeployWithTag').mockResolvedValue(undefined);

    await expect(first.service.buildImageForHelmAndGithub(failedSyncDeploy, 'run-1')).resolves.toBe(false);
    expect(firstPatchTag).not.toHaveBeenCalled();

    const second = serviceHarness();
    const staleDeploy = sourceBuildDeploy();
    jest.spyOn(second.service as any, 'syncServiceExternalSecrets').mockResolvedValue({
      secretNames: [],
      buildSecretEnvKeys: new Set(),
    });
    jest.spyOn(second.service as any, 'isDeploymentRunCurrent').mockResolvedValue(false);
    jest.spyOn(second.service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);
    const secondPatchTag = jest.spyOn(second.service as any, 'patchDeployWithTag').mockResolvedValue(undefined);

    await expect(
      second.service.buildImageForHelmAndGithub(staleDeploy, 'run-2', undefined, undefined, undefined, 7)
    ).resolves.toBe(true);
    expect(secondPatchTag).not.toHaveBeenCalled();
  });

  test('buildImageForHelmAndGithub rejects a source-backed service whose repository relation disappeared', async () => {
    const { service } = serviceHarness();
    const deploy = sourceBuildDeploy();
    deploy.deployable.repository = null;
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1')).rejects.toThrow(
      'Unable to resolve branch "main" in repository "the selected repository". Verify the branch exists and the repository matches the selected service.'
    );

    expect(patchActivity).toHaveBeenCalledWith(deploy, { status: DeployStatus.CLONING }, 'run-1');
    expect(mockCodefreshTagExists).not.toHaveBeenCalled();
  });

  test('syncServiceExternalSecrets fallback gate does not call the provider after ownership is stale', async () => {
    const { service, deployQuery } = serviceHarness();
    deployQuery.select.mockResolvedValue(null);
    const deploy = sourceBuildDeploy();
    deploy.env = { TOKEN: '{{aws:repo/build:TOKEN}}' };
    const processSecrets = jest.spyOn(SecretProcessor.prototype, 'processEnvSecrets');

    try {
      await expect(
        (service as any).syncServiceExternalSecrets({
          deploy,
          serviceName: 'app',
          secretProviders: { aws: { enabled: true } },
          runUUID: 'run-1',
          expectedGeneration: 7,
        })
      ).resolves.toBe(false);

      expect(processSecrets).not.toHaveBeenCalled();
    } finally {
      processSecrets.mockRestore();
    }
  });

  test('an after-build pipeline is not triggered when its initial fenced status patch is stale', async () => {
    const { service, deployPatch } = serviceHarness();
    deployPatch.mockResolvedValueOnce(0);
    mockCodefreshTagExists.mockResolvedValue(true);
    const deploy = sourceBuildDeploy();
    deploy.deployable.builder.engine = 'ci';
    deploy.deployable.afterBuildPipelineId = 'org/after-build';
    const patchActivity = jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await expect(service.buildImageForHelmAndGithub(deploy, 'run-1')).resolves.toBe(false);

    expect(mockCodefreshTriggerPipeline).not.toHaveBeenCalled();
    expect(patchActivity).toHaveBeenLastCalledWith(
      deploy,
      { status: DeployStatus.BUILD_FAILED, statusMessage: 'After-build pipeline failed.' },
      'run-1'
    );
  });

  test('dependency resolution leaves env unchanged when no build pipeline id materializes', async () => {
    const { service, deployPatch } = serviceHarness();
    const dependentDeploy = { uuid: 'database-env' };
    const deploy = sourceBuildDeploy();
    deploy.build.deploys = [dependentDeploy];
    mockExtractEnvVarsWithBuildDependencies.mockReturnValue({
      database: [{ envKey: 'DATABASE_URL', pattern: 'postgres://[^\\s]+' }],
    });
    mockWaitForColumnValue.mockResolvedValue({ buildPipelineId: null });
    jest.spyOn(service, 'patchAndUpdateActivityFeed').mockResolvedValue(undefined);

    await service.waitAndResolveForBuildDependentEnvVars(deploy, { KEEP: 'visible' }, 'run-1');

    expect(mockWaitForColumnValue).toHaveBeenCalledTimes(1);
    expect(deployPatch).toHaveBeenLastCalledWith({ env: { KEEP: 'visible' } });
  });

  test('findOrCreateDeploys stops before persistence when the build has not been assigned an id', async () => {
    const { service, db } = serviceHarness();
    const build: any = {
      uuid: 'transient-environment',
      deployables: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.findOrCreateDeploys({} as any, build)).resolves.toEqual([]);

    expect(build.$fetchGraph).toHaveBeenCalledWith('[deployables.[repository]]');
    expect(db.models.Deploy.query).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith('Deploy: build id missing for=findOrCreateDeploys');
  });

  test('deployAurora records a terminal error without calling AWS or CLI when its deployable relation is missing', async () => {
    const { service, deployPatch } = serviceHarness();
    const deploy: any = {
      id: 17,
      buildId: 91,
      uuid: 'database-environment',
      status: DeployStatus.PENDING,
      cname: null,
      build: {
        id: 91,
        uuid: 'environment',
        kind: BuildKind.SANDBOX,
        githubDeployments: false,
        pullRequest: null,
      },
      deployable: null,
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.deployAurora(deploy, 'run-1')).resolves.toBe(false);

    expect(deployPatch).toHaveBeenCalledWith({
      status: DeployStatus.ERROR,
      statusMessage: 'Aurora restore deployable is missing.',
    });
    expect(mockTaggingGetResources).not.toHaveBeenCalled();
    expect(mockRdsDescribeDBInstances).not.toHaveBeenCalled();
    expect(mockCliDeploy).not.toHaveBeenCalled();
  });

  test('buildImage publishes a source-free public Helm chart without consulting GitHub', async () => {
    const { service, deployPatch } = serviceHarness();
    const deploy: any = {
      id: 18,
      buildId: 91,
      uuid: 'public-chart-environment',
      branchName: null,
      tag: 'latest',
      build: {
        id: 91,
        kind: BuildKind.SANDBOX,
        githubDeployments: false,
        pullRequest: null,
      },
      deployable: {
        name: 'public-chart',
        type: DeployTypes.HELM,
        repository: null,
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    mockDetermineChartType.mockResolvedValue(ChartType.PUBLIC);

    await expect(service.buildImage(deploy, 0, 'run-1')).resolves.toBe(true);

    expect(deployPatch).toHaveBeenLastCalledWith({
      status: DeployStatus.BUILT,
      statusMessage: 'Helm chart does not need to be built',
    });
    expect(github.getSHAForBranch).not.toHaveBeenCalled();
    expect(github.getShaForDeploy).not.toHaveBeenCalled();
  });
});
