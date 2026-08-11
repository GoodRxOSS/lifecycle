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
import { DeployStatus, DeployTypes } from 'shared/constants';
import { ChartType } from 'server/lib/nativeHelm';
import * as github from 'server/lib/github';
import { SecretProcessor } from 'server/services/secretProcessor';

mockRedisClient();

const mockCliDeploy = jest.fn();
const mockCodefreshDeploy = jest.fn();
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
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockGetLogger = jest.fn(() => ({
  error: jest.fn(),
  info: mockLoggerInfo,
  warn: mockLoggerWarn,
  debug: jest.fn(),
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
  waitForCodefresh: jest.fn(),
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
