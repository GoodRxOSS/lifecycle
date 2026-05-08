/**
 * Copyright 2026 Lifecycle contributors
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

const mockDeployQuery = jest.fn();
const mockGenerateManifest = jest.fn();
const mockApplyManifests = jest.fn();
const mockWaitForPodReady = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockIsFeatureEnabled = jest.fn();
const mockQueueAdd = jest.fn();
const mockCleanupDeploy = jest.fn();
const mockDeleteServiceRows = jest.fn();
const mockGetServiceOverrideStates = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: {
    getConnection: jest.fn(),
  },
}));

jest.mock('server/lib/tracer', () => ({
  Tracer: {
    getInstance: jest.fn(() => ({
      initialize: jest.fn(),
    })),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  updateLogContext: jest.fn(),
  LogStage: {},
}));

jest.mock('shared/config', () => ({
  TMP_PATH: '/tmp',
  QUEUE_NAMES: {
    DELETE_QUEUE: 'delete_queue_test',
    BUILD_QUEUE: 'build_queue_test',
    RESOLVE_AND_DEPLOY: 'resolve_and_deploy_test',
    BUILD_CLEANUP_QUEUE: 'build_cleanup_test',
    BUILD_REQUEST_QUEUE: 'build_request_test',
    DEPLOY_CLEANUP: 'deploy_cleanup_test',
    GLOBAL_CONFIG_CACHE_REFRESH: 'global-config-refresh',
    GITHUB_CLIENT_TOKEN_CACHE_REFRESH: 'github-client-token-refresh',
    INGRESS_MANIFEST_QUEUE: 'ingress-manifest',
    AGENT_PREWARM_QUEUE: 'agent-prewarm',
  },
}));

jest.mock('server/models', () => ({
  Build: class {},
  Deploy: {
    query: () => mockDeployQuery(),
  },
  Environment: class {},
  Service: class {},
  BuildServiceOverride: class {},
}));

jest.mock('server/lib/kubernetes', () => ({
  generateManifest: (...args: any[]) => mockGenerateManifest(...args),
  applyManifests: (...args: any[]) => mockApplyManifests(...args),
  waitForPodReady: (...args: any[]) => mockWaitForPodReady(...args),
  createOrUpdateNamespace: jest.fn(),
  createOrUpdateServiceAccount: jest.fn(),
}));

jest.mock('server/lib/github', () => ({
  createGitDeployment: jest.fn(),
  updateGitDeploymentStatus: jest.fn(),
  getPullRequest: jest.fn(),
  getSHAForBranch: jest.fn(),
  getYamlFileContentFromBranch: jest.fn(),
}));

jest.mock('server/lib/helm', () => ({
  uninstallHelmReleases: jest.fn(),
}));

jest.mock('server/lib/helm/utils', () => ({
  ingressBannerSnippet: jest.fn(() => ''),
}));

jest.mock('server/lib/buildEnvVariables', () => ({
  BuildEnvironmentVariables: jest.fn().mockImplementation(() => ({
    resolve: jest.fn().mockResolvedValue({}),
  })),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args),
      isFeatureEnabled: (...args: any[]) => mockIsFeatureEnabled(...args),
    })),
  },
}));

jest.mock('server/services/deployCleanup', () =>
  jest.fn().mockImplementation(() => ({
    cleanupDeploy: (...args: any[]) => mockCleanupDeploy(...args),
    deleteServiceRows: (...args: any[]) => mockDeleteServiceRows(...args),
  }))
);

jest.mock('server/services/deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    patchAndUpdateActivityFeed: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('server/services/webhook', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    upsertWebhooksWithYaml: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('server/services/override', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getServiceOverrideStates: (...args: any[]) => mockGetServiceOverrideStates(...args),
  })),
}));

jest.mock('server/lib/fastly', () =>
  jest.fn().mockImplementation(() => ({
    getServiceDashboardUrl: jest.fn(),
  }))
);

import BuildService from '../build';
import { BuildKind, BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';

function createThenableQuery(result: any[] = []) {
  const query: any = {
    where: jest.fn(() => query),
    whereIn: jest.fn(() => query),
    whereNot: jest.fn(() => query),
    whereNotNull: jest.fn(() => query),
    delete: jest.fn().mockResolvedValue(result.length),
    then: (resolve: (value: any[]) => void, reject: (reason: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

describe('BuildService build response queries', () => {
  function createQueueManager() {
    return {
      registerQueue: jest.fn(() => ({
        add: jest.fn(),
        process: jest.fn(),
        on: jest.fn(),
      })),
    };
  }

  test('selects comment env columns when listing builds', async () => {
    const build = {
      uuid: 'sample-build',
      commentRuntimeEnv: { FEATURE_ENABLED: 'true' },
      commentInitEnv: { MIGRATION_ENABLED: 'true' },
    };
    const query: any = {
      select: jest.fn(() => query),
      where: jest.fn(() => query),
      whereNotIn: jest.fn(() => query),
      modify: jest.fn((callback: (builder: any) => void) => {
        callback(query);
        return query;
      }),
      withGraphFetched: jest.fn(() => query),
      modifyGraph: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      page: jest.fn().mockResolvedValue({ results: [build], total: 1 }),
    };
    const buildService = new BuildService(
      {
        models: {
          Build: {
            query: jest.fn(() => query),
          },
        },
      } as any,
      {} as any,
      {} as any,
      createQueueManager() as any
    );

    const result = await buildService.getAllBuilds('', undefined, '', { page: 1, limit: 25 });

    expect(result.data).toEqual([build]);
    expect(query.select.mock.calls[0]).toEqual(expect.arrayContaining(['commentRuntimeEnv', 'commentInitEnv']));
  });

  test('selects comment env columns when loading a build by UUID', async () => {
    const build = {
      uuid: 'sample-build',
      commentRuntimeEnv: { FEATURE_ENABLED: 'true' },
      commentInitEnv: { MIGRATION_ENABLED: 'true' },
    };
    const query: any = {
      findOne: jest.fn(() => query),
      select: jest.fn(() => query),
      withGraphFetched: jest.fn(() => query),
      modifyGraph: jest.fn(() => query),
      then: (resolve: (value: any) => void, reject: (reason: unknown) => void) =>
        Promise.resolve(build).then(resolve, reject),
    };
    const buildService = new BuildService(
      {
        models: {
          Build: {
            query: jest.fn(() => query),
          },
        },
      } as any,
      {} as any,
      {} as any,
      createQueueManager() as any
    );

    await expect(buildService.getBuildByUUID('sample-build')).resolves.toBe(build);

    expect(query.findOne).toHaveBeenCalledWith({ uuid: 'sample-build' });
    expect(query.select.mock.calls[0]).toEqual(expect.arrayContaining(['commentRuntimeEnv', 'commentInitEnv']));
  });

  test('attaches service override edit state to deploys when loading a build by UUID', async () => {
    const build = {
      id: 10,
      uuid: 'sample-build',
      deploys: [
        {
          uuid: 'api-sample-build',
          deployable: { name: 'api' },
        },
        {
          uuid: 'internal-sample-build',
          deployable: { name: 'internal' },
        },
      ],
    };
    const buildForServiceOverrides = {
      id: 10,
      uuid: 'sample-build',
      deploys: [{ uuid: 'api-sample-build' }],
    };
    const query: any = {
      findOne: jest.fn(() => query),
      select: jest.fn(() => query),
      withGraphFetched: jest.fn(() => query),
      modifyGraph: jest.fn(() => query),
      then: (resolve: (value: any) => void, reject: (reason: unknown) => void) =>
        Promise.resolve(build).then(resolve, reject),
    };
    const serviceOverrideQuery: any = {
      findOne: jest.fn(() => serviceOverrideQuery),
      select: jest.fn(() => serviceOverrideQuery),
      withGraphFetched: jest.fn(() => serviceOverrideQuery),
      then: (resolve: (value: any) => void, reject: (reason: unknown) => void) =>
        Promise.resolve(buildForServiceOverrides).then(resolve, reject),
    };
    const buildService = new BuildService(
      {
        models: {
          Build: {
            query: jest.fn().mockReturnValueOnce(query).mockReturnValueOnce(serviceOverrideQuery),
          },
        },
      } as any,
      {} as any,
      {} as any,
      createQueueManager() as any
    );
    mockGetServiceOverrideStates.mockResolvedValueOnce([
      {
        name: 'api',
        active: true,
        branchOrExternalUrl: 'feature/api',
        status: 'deployed',
        statusMessage: null,
        updatedAt: '2026-05-08T12:00:00.000Z',
        group: 'default',
        editable: true,
      },
    ]);

    await expect(buildService.getBuildByUUID('sample-build')).resolves.toBe(build);

    expect(serviceOverrideQuery.findOne).toHaveBeenCalledWith({ id: 10 });
    expect(serviceOverrideQuery.withGraphFetched).toHaveBeenCalledWith(
      '[environment.[defaultServices, optionalServices], deploys.[service, deployable]]'
    );
    expect(mockGetServiceOverrideStates).toHaveBeenCalledWith(
      buildForServiceOverrides,
      buildForServiceOverrides.deploys
    );
    expect(build.deploys).toEqual([
      {
        uuid: 'api-sample-build',
        deployable: { name: 'api' },
        serviceOverride: {
          name: 'api',
          branchOrExternalUrl: 'feature/api',
          group: 'default',
          editable: true,
        },
      },
      {
        uuid: 'internal-sample-build',
        deployable: { name: 'internal' },
        serviceOverride: null,
      },
    ]);
  });
});

describe('BuildService failure boundaries', () => {
  let buildService: BuildService;
  let recordDeployFailure: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    recordDeployFailure = jest.fn();
    const queueManager = {
      registerQueue: jest.fn(() => ({
        add: mockQueueAdd,
        process: jest.fn(),
        on: jest.fn(),
      })),
    };
    buildService = new BuildService(
      {
        services: {
          Deploy: {
            recordDeployFailure,
          },
        },
      } as any,
      {} as any,
      {} as any,
      queueManager as any
    );
    (buildService as any).ingressService = {
      ingressManifestQueue: {
        add: mockQueueAdd,
      },
    };
    mockGetAllConfigs.mockResolvedValue({ serviceAccount: { name: 'sample-service-account' } });
  });

  test('classic manifest failures stay build-scoped when no deploy can be identified', async () => {
    const deploys = [
      {
        id: 1,
        active: true,
        uuid: 'sample-api',
        status: DeployStatus.BUILT,
        service: { type: DeployTypes.GITHUB, name: 'sample-api' },
      },
      {
        id: 2,
        active: true,
        uuid: 'sample-worker',
        status: DeployStatus.BUILT,
        service: { type: DeployTypes.DOCKER, name: 'sample-worker' },
      },
    ];
    const query = {
      where: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue(deploys),
    };
    const rolloutError = new Error('Pods for build not ready after 15 minutes');
    mockDeployQuery.mockReturnValue(query);
    mockGenerateManifest.mockReturnValue('apiVersion: apps/v1\nkind: Deployment\n');
    mockApplyManifests.mockResolvedValue([]);
    mockWaitForPodReady.mockRejectedValue(rolloutError);

    await expect(
      buildService.generateAndApplyManifests({
        build: {
          id: 123,
          uuid: 'sample-build',
          runUUID: 'run-1',
          namespace: 'sample-namespace',
          enableFullYaml: false,
          $query: jest.fn(() => ({
            patch: jest.fn().mockResolvedValue(undefined),
          })),
        } as any,
        githubRepositoryId: null,
        namespace: 'sample-namespace',
      })
    ).rejects.toThrow(rolloutError);

    expect(recordDeployFailure).not.toHaveBeenCalled();
  });
});

describe('BuildService status updates', () => {
  test('updates only build status fields', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    const buildService = new BuildService(
      {
        services: {
          Webhook: {
            webhookQueue: {
              add: jest.fn(),
            },
          },
        },
      } as any,
      {} as any,
      {} as any,
      {
        registerQueue: jest.fn(() => ({
          add: mockQueueAdd,
          process: jest.fn(),
          on: jest.fn(),
        })),
      } as any
    );
    const build = {
      id: 1,
      uuid: 'sample-build',
      runUUID: 'run-1',
      kind: BuildKind.SANDBOX,
      deploys: [],
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(() => ({ patch })),
    };

    await buildService.updateStatusAndComment(build as any, BuildStatus.DEPLOYED, 'run-1', true, true);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({
      status: BuildStatus.DEPLOYED,
      statusMessage: '',
    });
  });
});

describe('BuildService stale deploy reconciliation', () => {
  let buildService: BuildService;
  let deployableQuery: any;
  let deployQuery: any;
  const targetRepoId = 1001;
  const otherRepoId = 2002;

  const createService = (existingDeployables: any[] = [], staleDeploys: any[] = []) => {
    deployableQuery = createThenableQuery(existingDeployables);
    deployQuery = {
      where: jest.fn(() => deployQuery),
      whereIn: jest.fn(() => deployQuery),
      withGraphFetched: jest.fn().mockResolvedValue(staleDeploys),
    };

    buildService = new BuildService(
      {
        models: {
          Deployable: {
            query: jest.fn().mockReturnValueOnce(deployableQuery),
          },
          Deploy: {
            query: jest.fn().mockReturnValueOnce(deployQuery),
          },
        },
      } as any,
      {} as any,
      {} as any,
      {
        registerQueue: jest.fn(() => ({
          add: jest.fn(),
          process: jest.fn(),
          on: jest.fn(),
        })),
      } as any
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockCleanupDeploy.mockResolvedValue(true);
    mockDeleteServiceRows.mockResolvedValue(undefined);
  });

  const createBuild = (overrides: any = {}) =>
    ({
      id: 10,
      uuid: 'build-1',
      enableFullYaml: true,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any);

  test('feature flag off leaves stale deployables untouched', async () => {
    createService([{ id: 1, name: 'old-api' }]);
    mockIsFeatureEnabled.mockResolvedValue(false);

    await (buildService as any).reconcileDeletedDeployables({ id: 10, uuid: 'build-1', enableFullYaml: true } as any, {
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [{ name: 'api', source: 'yaml', reconcileEligible: true }],
    });

    expect((buildService as any).db.models.Deployable.query).not.toHaveBeenCalled();
    expect(mockCleanupDeploy).not.toHaveBeenCalled();
    expect(mockDeleteServiceRows).not.toHaveBeenCalled();
  });

  test('cleans stale YAML-owned deployables and deletes deploy/deployable rows', async () => {
    const staleDeploy = { id: 77, uuid: 'old-api-build-1', deployableId: 1 };
    createService(
      [
        { id: 1, name: 'old-api' },
        { id: 2, name: 'api' },
      ],
      [staleDeploy]
    );
    const build = createBuild();

    await (buildService as any).reconcileDeletedDeployables(build as any, {
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [{ name: 'api', source: 'yaml', reconcileEligible: true }],
    });

    expect(mockCleanupDeploy).toHaveBeenCalledWith(staleDeploy, { mode: 'service' });
    expect(deployQuery.whereIn).toHaveBeenCalledWith('deployableId', [1]);
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [1] });
    expect(build.$fetchGraph).toHaveBeenCalledWith('[deployables, deploys]');
  });

  test('treats renamed YAML services as deleted old service plus created new service', async () => {
    const staleDeploy = { id: 78, uuid: 'worker-old-build-1', deployableId: 3 };
    createService(
      [
        { id: 2, name: 'api', resolvedFromRepositoryId: targetRepoId },
        { id: 3, name: 'worker-old', resolvedFromRepositoryId: targetRepoId },
      ],
      [staleDeploy]
    );
    const build = createBuild();

    await (buildService as any).reconcileDeletedDeployables(build, {
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [
        { name: 'api', source: 'yaml', reconcileEligible: true, resolvedFromRepositoryId: targetRepoId },
        { name: 'worker-new', source: 'yaml', reconcileEligible: true, resolvedFromRepositoryId: targetRepoId },
      ],
    });

    expect(mockCleanupDeploy).toHaveBeenCalledTimes(1);
    expect(mockCleanupDeploy).toHaveBeenCalledWith(staleDeploy, { mode: 'service' });
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [3] });
    expect(build.$fetchGraph).toHaveBeenCalledWith('[deployables, deploys]');
  });

  test('repo-filtered reconciliation removes only deployables from the triggering repository scope', async () => {
    const staleDeploy = { id: 79, uuid: 'target-old-build-1', deployableId: 4 };
    createService([{ id: 4, name: 'target-old', resolvedFromRepositoryId: targetRepoId }], [staleDeploy]);
    const build = createBuild();

    await (buildService as any).reconcileDeletedDeployables(
      build,
      {
        canReconcile: true,
        deployables: [],
        reconcileEligibleDeployables: [
          { name: 'target-new', source: 'yaml', reconcileEligible: true, resolvedFromRepositoryId: targetRepoId },
          { name: 'other-service', source: 'yaml', reconcileEligible: true, resolvedFromRepositoryId: otherRepoId },
        ],
      },
      targetRepoId
    );

    expect(deployableQuery.where).toHaveBeenCalledWith('resolvedFromRepositoryId', targetRepoId);
    expect(deployableQuery.whereNotNull).toHaveBeenCalledWith('resolvedFromRepositoryId');
    expect(mockCleanupDeploy).toHaveBeenCalledWith(staleDeploy, { mode: 'service' });
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [4] });
  });

  test('full reconciliation can delete YAML-owned deployables with null repository ownership', async () => {
    const staleDeploy = { id: 80, uuid: 'external-cache-build-1', deployableId: 5 };
    createService([{ id: 5, name: 'external-cache', resolvedFromRepositoryId: null }], [staleDeploy]);
    const build = createBuild();

    await (buildService as any).reconcileDeletedDeployables(build, {
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [{ name: 'api', source: 'yaml', reconcileEligible: true }],
    });

    expect(mockCleanupDeploy).toHaveBeenCalledWith(staleDeploy, { mode: 'service' });
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [5] });
  });

  test('repo-filtered reconciliation excludes ambiguous null repository ownership', async () => {
    createService([], []);

    await (buildService as any).reconcileDeletedDeployables(
      { id: 10, uuid: 'build-1', enableFullYaml: true } as any,
      {
        canReconcile: true,
        deployables: [],
        reconcileEligibleDeployables: [],
      },
      123
    );

    expect(deployableQuery.where).toHaveBeenCalledWith('resolvedFromRepositoryId', 123);
    expect(deployableQuery.whereNotNull).toHaveBeenCalledWith('resolvedFromRepositoryId');
    expect(mockCleanupDeploy).not.toHaveBeenCalled();
    expect(mockDeleteServiceRows).not.toHaveBeenCalled();
  });

  test('skips cleanup when YAML import did not resolve the authoritative config scope', async () => {
    createService([{ id: 1, name: 'old-api' }], [{ id: 77, uuid: 'old-api-build-1', deployableId: 1 }]);

    await (buildService as any).reconcileDeletedDeployables(createBuild(), {
      canReconcile: false,
      deployables: [],
      reconcileEligibleDeployables: [],
    });

    expect((buildService as any).db.models.Deployable.query).not.toHaveBeenCalled();
    expect(mockCleanupDeploy).not.toHaveBeenCalled();
    expect(mockDeleteServiceRows).not.toHaveBeenCalled();
  });

  test('stale lookup is scoped to YAML-owned non-configuration deployables', async () => {
    createService([], []);

    await (buildService as any).reconcileDeletedDeployables(createBuild(), {
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [],
    });

    expect(deployableQuery.where).toHaveBeenCalledWith({
      buildId: 10,
      buildUUID: 'build-1',
      reconcileEligible: true,
      source: 'yaml',
    });
    expect(deployableQuery.whereNot).toHaveBeenCalledWith('type', DeployTypes.CONFIGURATION);
  });

  test('cleanup errors are logged but database rows are still deleted', async () => {
    createService([{ id: 1, name: 'old-api' }], [{ id: 77, uuid: 'old-api-build-1', deployableId: 1 }]);
    mockCleanupDeploy.mockRejectedValue(new Error('targeted cleanup failed'));
    const build = createBuild();

    await (buildService as any).reconcileDeletedDeployables(build as any, {
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [],
    });

    expect(mockCleanupDeploy).toHaveBeenCalledTimes(1);
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [1] });
    expect(build.$fetchGraph).toHaveBeenCalledWith('[deployables, deploys]');
  });

  test('service redeploy YAML import skips stale reconciliation', async () => {
    const upsertDeployables = jest.fn().mockResolvedValue({
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [{ name: 'api', source: 'yaml', reconcileEligible: true }],
    });
    const upsertWebhooksWithYaml = jest.fn().mockResolvedValue(undefined);
    const reconcileDeletedDeployables = jest.fn();
    const queueManager = {
      registerQueue: jest.fn(() => ({
        add: jest.fn(),
        process: jest.fn(),
        on: jest.fn(),
      })),
    };
    buildService = new BuildService(
      {
        services: {
          Deployable: { upsertDeployables },
          Webhook: { upsertWebhooksWithYaml },
        },
      } as any,
      {} as any,
      {} as any,
      queueManager as any
    );
    (buildService as any).reconcileDeletedDeployables = reconcileDeletedDeployables;

    const build = createBuild({ pullRequest: { id: 20 } });
    const environment = { id: 30 };

    await (buildService as any).importYamlConfigFile(environment, build, targetRepoId, {
      skipDeletedServiceReconciliation: true,
    });

    expect(upsertDeployables).toHaveBeenCalledWith(10, 'build-1', build.pullRequest, environment, build, targetRepoId);
    expect(reconcileDeletedDeployables).not.toHaveBeenCalled();
    expect(upsertWebhooksWithYaml).toHaveBeenCalledWith(build, build.pullRequest);
  });
});

describe('BuildService queue fingerprinting', () => {
  let buildService: BuildService;
  let mockBuildQuery: any;
  let mockBuildQueueAdd: jest.Mock;
  let mockResolveQueueAdd: jest.Mock;

  const createMockBuild = (overrides: any = {}) =>
    ({
      id: 1,
      enableFullYaml: true,
      commentRuntimeEnv: { FEATURE_FLAG: 'on' },
      commentInitEnv: {},
      pullRequest: { latestCommit: 'abcdef123456' },
      deploys: [
        {
          id: 11,
          uuid: 'api-deploy',
          githubRepositoryId: 100,
          branchName: 'feature-branch',
          active: true,
          publicUrl: 'https://example.test/api',
          env: { API_URL: 'https://api.test' },
          initEnv: { INIT_MODE: 'warm' },
          deployable: { name: 'api', commentBranchName: null },
          service: { name: 'api' },
        },
        {
          id: 22,
          uuid: 'worker-deploy',
          githubRepositoryId: 200,
          branchName: 'feature-branch',
          active: true,
          publicUrl: 'https://example.test/worker',
          env: { QUEUE: 'jobs' },
          initEnv: {},
          deployable: { name: 'worker', commentBranchName: 'worker-override' },
          service: { name: 'worker' },
        },
      ],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any);

  beforeEach(() => {
    jest.clearAllMocks();

    mockBuildQueueAdd = jest.fn().mockResolvedValue(undefined);
    mockResolveQueueAdd = jest.fn().mockResolvedValue(undefined);

    mockBuildQuery = {
      findOne: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn(),
    };

    const queueManager = {
      registerQueue: jest.fn(() => ({
        add: jest.fn(),
        process: jest.fn(),
        on: jest.fn(),
      })),
    };

    buildService = new BuildService(
      {
        models: {
          Build: {
            query: jest.fn(() => mockBuildQuery),
          },
        },
        services: {},
      } as any,
      {} as any,
      {} as any,
      queueManager as any
    );
    (buildService as any).buildQueue = { add: mockBuildQueueAdd };
    (buildService as any).resolveAndDeployBuildQueue = { add: mockResolveQueueAdd };
  });

  test('changes fingerprint when comment runtime env changes', async () => {
    const baseBuild = createMockBuild();
    const changedBuild = createMockBuild({
      commentRuntimeEnv: { FEATURE_FLAG: 'off' },
    });

    const baseFingerprint = await buildService.computeBuildRequestFingerprint(baseBuild);
    const changedFingerprint = await buildService.computeBuildRequestFingerprint(changedBuild);

    expect(baseFingerprint).not.toEqual(changedFingerprint);
  });

  test('changes fingerprint when static mode changes', async () => {
    const previewBuild = createMockBuild({
      isStatic: false,
    });
    const staticBuild = createMockBuild({
      isStatic: true,
    });

    const previewFingerprint = await buildService.computeBuildRequestFingerprint(previewBuild);
    const staticFingerprint = await buildService.computeBuildRequestFingerprint(staticBuild);

    expect(previewFingerprint).not.toEqual(staticFingerprint);
  });

  test('changes fingerprint when repository filter changes', async () => {
    const build = createMockBuild();

    const apiFingerprint = await buildService.computeBuildRequestFingerprint(build, 100);
    const workerFingerprint = await buildService.computeBuildRequestFingerprint(build, 200);

    expect(apiFingerprint).not.toEqual(workerFingerprint);
  });

  test('enqueues resolve queue with deduplication derived from the current build fingerprint', async () => {
    const build = createMockBuild();
    mockBuildQuery.withGraphFetched.mockResolvedValue(build);

    const expectedFingerprint = await buildService.computeBuildRequestFingerprint(build, 100);

    await buildService.enqueueResolveAndDeployBuild({
      buildId: 1,
      githubRepositoryId: 100,
      correlationId: 'corr-1',
    });

    expect(mockResolveQueueAdd).toHaveBeenCalledWith(
      'resolve-deploy',
      expect.objectContaining({
        buildId: 1,
        githubRepositoryId: 100,
        correlationId: 'corr-1',
      }),
      expect.objectContaining({
        deduplication: {
          id: `resolve:1:${expectedFingerprint}`,
          ttl: 30000,
        },
      })
    );
  });

  test('enqueues build queue with a deterministic job id derived from the current build fingerprint', async () => {
    const build = createMockBuild();
    mockBuildQuery.withGraphFetched.mockResolvedValue(build);

    const expectedFingerprint = await buildService.computeBuildRequestFingerprint(build, 100);

    await buildService.enqueueBuildJob({
      buildId: 1,
      githubRepositoryId: 100,
      correlationId: 'corr-2',
    });

    expect(mockBuildQueueAdd).toHaveBeenCalledWith(
      'build',
      expect.objectContaining({
        buildId: 1,
        githubRepositoryId: 100,
        correlationId: 'corr-2',
      }),
      expect.objectContaining({
        jobId: `build:1:${expectedFingerprint}`,
      })
    );
  });

  test('service redeploy queues scoped build without deleted-service reconciliation', async () => {
    const patchAndFetch = jest.fn().mockResolvedValue(undefined);
    const deploy = {
      id: 33,
      uuid: 'pdm-db-good-dev-0',
      githubRepositoryId: 425935548,
      deployable: {
        name: 'pdm-db',
        repositoryId: 425935548,
      },
      $query: jest.fn(() => ({ patchAndFetch })),
    };
    const build = createMockBuild({
      id: 1449,
      uuid: 'good-dev-0',
      deploys: [deploy],
    });
    mockBuildQuery.withGraphFetched.mockResolvedValue(build);

    await buildService.redeployServiceFromBuild('good-dev-0', 'pdm-db');

    expect(mockResolveQueueAdd).toHaveBeenCalledWith(
      'resolve-deploy',
      expect.objectContaining({
        buildId: 1449,
        githubRepositoryId: 425935548,
        skipDeletedServiceReconciliation: true,
      }),
      expect.any(Object)
    );
    expect(patchAndFetch).toHaveBeenCalledWith({
      runUUID: expect.any(String),
    });
  });

  test('resolve queue preserves deleted-service reconciliation skip flag for service redeploys', async () => {
    const build = createMockBuild({
      id: 1449,
      uuid: 'good-dev-0',
      pullRequest: {
        latestCommit: 'abcdef123456',
        deployOnUpdate: true,
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    });
    mockBuildQuery.findOne.mockResolvedValue(build);
    const enqueueBuildJob = jest.spyOn(buildService, 'enqueueBuildJob').mockResolvedValue(undefined as any);

    await buildService.processResolveAndDeployBuildQueue({
      data: {
        buildId: 1449,
        githubRepositoryId: 425935548,
        skipDeletedServiceReconciliation: true,
      },
    });

    expect(enqueueBuildJob).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: 1449,
        githubRepositoryId: 425935548,
        skipDeletedServiceReconciliation: true,
      })
    );
  });
});
