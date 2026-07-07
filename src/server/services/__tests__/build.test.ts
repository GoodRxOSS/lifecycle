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
}));

jest.mock('server/lib/kubernetes', () => ({
  generateManifest: (...args: any[]) => mockGenerateManifest(...args),
  applyManifests: (...args: any[]) => mockApplyManifests(...args),
  waitForPodReady: (...args: any[]) => mockWaitForPodReady(...args),
  createOrUpdateNamespace: jest.fn(),
}));

jest.mock('server/lib/kubernetes/common/serviceAccount', () => ({
  ensureServiceAccountForJob: jest.fn().mockResolvedValue('default'),
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

import BuildService, { computeIdempotencyRequestDigest, assertIdempotentReplayAllowed } from '../build';
import { BuildKind, BuildStatus, DeployTypes } from 'shared/constants';
import * as github from 'server/lib/github';

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
        add: mockQueueAdd,
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

  function createAllowlistHarness() {
    const recorder: any = {
      orWhereIn: jest.fn().mockReturnThis(),
      orWhereExists: jest.fn().mockReturnThis(),
    };
    const query: any = {
      select: jest.fn(() => query),
      where: jest.fn((arg: any) => {
        if (typeof arg === 'function') arg(recorder);
        return query;
      }),
      whereNotIn: jest.fn(() => query),
      modify: jest.fn((callback: (builder: any) => void) => {
        callback(query);
        return query;
      }),
      withGraphFetched: jest.fn(() => query),
      modifyGraph: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      page: jest.fn().mockResolvedValue({ results: [], total: 0 }),
    };
    const pullRequestChain: any = {
      joinRelated: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
    };
    const repositoryChain: any = {
      whereColumn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
    };
    const models = {
      Build: {
        query: jest.fn(() => query),
        relatedQuery: jest.fn(() => pullRequestChain),
      },
      Repository: {
        query: jest.fn(() => repositoryChain),
      },
    };
    const buildService = new BuildService({ models } as any, {} as any, {} as any, createQueueManager() as any);
    return { buildService, recorder, models, pullRequestChain, repositoryChain };
  }

  test('scopes the listing to an id-bound repository allowlist', async () => {
    const { buildService, recorder, models, pullRequestChain } = createAllowlistHarness();

    await buildService.getAllBuilds('', undefined, '', { page: 1, limit: 25 }, ['org/repo'], [42]);

    expect(recorder.orWhereIn).toHaveBeenCalledWith('builds.githubRepositoryId', [42]);
    expect(models.Build.relatedQuery).toHaveBeenCalledWith('pullRequest');
    expect(pullRequestChain.joinRelated).toHaveBeenCalledWith('repository');
    expect(pullRequestChain.whereIn).toHaveBeenCalledWith('repository.githubRepositoryId', [42]);
    expect(models.Repository.query).not.toHaveBeenCalled();
  });

  test('scopes the listing to a legacy name-only allowlist via lowercased EXISTS predicates', async () => {
    const { buildService, recorder, pullRequestChain, repositoryChain } = createAllowlistHarness();

    await buildService.getAllBuilds('', undefined, '', { page: 1, limit: 25 }, ['Org/Repo'], null);

    expect(recorder.orWhereExists).toHaveBeenCalledTimes(2);
    expect(repositoryChain.whereColumn).toHaveBeenCalledWith(
      'repositories.githubRepositoryId',
      'builds.githubRepositoryId'
    );
    expect(repositoryChain.whereRaw).toHaveBeenCalledWith('LOWER("fullName") = ANY(?)', [['org/repo']]);
    expect(pullRequestChain.whereRaw).toHaveBeenCalledWith('LOWER("fullName") = ANY(?)', [['org/repo']]);
  });

  test('an explicit empty id-allowlist matches nothing instead of listing everything', async () => {
    const { buildService, recorder } = createAllowlistHarness();

    await buildService.getAllBuilds('', undefined, '', { page: 1, limit: 25 }, null, []);

    expect(recorder.orWhereIn).toHaveBeenCalledWith('builds.githubRepositoryId', []);
  });

  test('an explicit empty name-allowlist matches nothing instead of listing everything', async () => {
    const { buildService, repositoryChain } = createAllowlistHarness();

    await buildService.getAllBuilds('', undefined, '', { page: 1, limit: 25 }, [], null);

    expect(repositoryChain.whereRaw).toHaveBeenCalledWith('LOWER("fullName") = ANY(?)', [[]]);
  });

  test('applies no repository filter for unrestricted principals', async () => {
    const { buildService, recorder, models } = createAllowlistHarness();

    await buildService.getAllBuilds('', undefined, '', { page: 1, limit: 25 }, null, null);

    expect(recorder.orWhereIn).not.toHaveBeenCalled();
    expect(recorder.orWhereExists).not.toHaveBeenCalled();
    expect(models.Repository.query).not.toHaveBeenCalled();
  });

  test('selects comment env columns when loading a build by UUID', async () => {
    const build = {
      uuid: 'sample-build',
      commentRuntimeEnv: { FEATURE_ENABLED: 'true' },
      commentInitEnv: { MIGRATION_ENABLED: 'true' },
    };
    const query: any = {
      findOne: jest.fn(() => query),
      whereNull: jest.fn(() => query),
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
      whereNull: jest.fn(() => query),
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
    expect(serviceOverrideQuery.withGraphFetched).toHaveBeenCalledWith('[environment, deploys.[deployable]]');
    expect(mockGetServiceOverrideStates).toHaveBeenCalledWith(buildForServiceOverrides.deploys);
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

  test('does not abort teardown status progress when webhook notification enqueue fails', async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    const webhookAdd = jest.fn().mockRejectedValue(new Error('redis unavailable'));
    const buildService = new BuildService(
      {
        services: {
          Webhook: { webhookQueue: { add: webhookAdd } },
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
      kind: BuildKind.ENVIRONMENT,
      deploys: [],
      pullRequest: null,
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(() => ({ patch })),
    };

    await expect(
      buildService.updateStatusAndComment(build as any, BuildStatus.TEARING_DOWN, 'run-1', true, true)
    ).resolves.toBeUndefined();

    expect(patch).toHaveBeenCalledWith({
      status: BuildStatus.TEARING_DOWN,
      statusMessage: '',
    });
    expect(webhookAdd).toHaveBeenCalledTimes(1);
  });
});

describe('BuildService destroyBuildEnvironment', () => {
  function createQueueManager() {
    return {
      registerQueue: jest.fn(() => ({
        add: mockQueueAdd,
        process: jest.fn(),
        on: jest.fn(),
      })),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('queues build cleanup for worker processing', async () => {
    const build = {
      id: 42,
      uuid: 'sample-build',
      isStatic: false,
      status: BuildStatus.DEPLOYED,
    };
    const whereNull = jest.fn().mockResolvedValue(build);
    const buildQuery = { findOne: jest.fn(() => ({ whereNull })) };
    const buildService = new BuildService(
      {
        models: {
          Build: {
            query: jest.fn(() => buildQuery),
          },
        },
      } as any,
      {} as any,
      {} as any,
      createQueueManager() as any
    );
    const deleteBuild = jest.spyOn(buildService, 'deleteBuild').mockResolvedValue(undefined);

    const result = await buildService.destroyBuildEnvironment('sample-build');

    expect(buildQuery.findOne).toHaveBeenCalledWith({ uuid: 'sample-build' });
    expect(deleteBuild).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'delete',
      expect.objectContaining({
        buildId: 42,
        buildUuid: 'sample-build',
        reason: 'manual_destroy',
        teardownRunUUID: expect.any(String),
      }),
      {
        jobId: 'build-delete-42-authoritative',
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
      }
    );
    expect(result).toEqual({
      status: 'success',
      message: 'Build sample-build teardown has been queued',
    });
  });

  test('does not clean up missing builds', async () => {
    const buildQuery = {
      findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(null) })),
    };
    const deployQuery = {
      where: jest.fn(),
    };
    const buildService = new BuildService(
      {
        models: {
          Build: {
            query: jest.fn(() => buildQuery),
          },
          Deploy: {
            query: jest.fn(() => deployQuery),
          },
        },
      } as any,
      {} as any,
      {} as any,
      createQueueManager() as any
    );
    const deleteBuild = jest.spyOn(buildService, 'deleteBuild').mockResolvedValue(undefined);

    await expect(buildService.destroyBuildEnvironment('missing-build')).resolves.toEqual({
      status: 'not_found',
      message: 'Build not found for missing-build or is static environment.',
    });

    expect(deleteBuild).not.toHaveBeenCalled();
    expect(deployQuery.where).not.toHaveBeenCalled();
  });

  test('does not clean up static environments', async () => {
    const build = {
      id: 42,
      uuid: 'static-build',
      isStatic: true,
      status: BuildStatus.DEPLOYED,
    };
    const buildQuery = {
      findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(build) })),
    };
    const deployQuery = {
      where: jest.fn(),
    };
    const buildService = new BuildService(
      {
        models: {
          Build: {
            query: jest.fn(() => buildQuery),
          },
          Deploy: {
            query: jest.fn(() => deployQuery),
          },
        },
      } as any,
      {} as any,
      {} as any,
      createQueueManager() as any
    );
    const deleteBuild = jest.spyOn(buildService, 'deleteBuild').mockResolvedValue(undefined);

    await expect(buildService.destroyBuildEnvironment('static-build')).resolves.toEqual({
      status: 'not_found',
      message: 'Build not found for static-build or is static environment.',
    });

    expect(deleteBuild).not.toHaveBeenCalled();
    expect(deployQuery.where).not.toHaveBeenCalled();
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
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any);

  test('feature flag off leaves stale deployables untouched', async () => {
    createService([{ id: 1, name: 'old-api' }]);
    mockIsFeatureEnabled.mockResolvedValue(false);

    await (buildService as any).reconcileDeletedDeployables({ id: 10, uuid: 'build-1' } as any, {
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

  test('stale-deploy lookup does not eager-load the removed Deploy.service relation', async () => {
    createService([{ id: 1, name: 'old-api' }], [{ id: 77, uuid: 'old-api-build-1', deployableId: 1 }]);

    await (buildService as any).reconcileDeletedDeployables(createBuild(), {
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [{ name: 'api', source: 'yaml', reconcileEligible: true }],
    });

    // Deploy.service was removed with the legacy DB-config path; eager-loading it here would
    // make Objection reject the query with "unknown relation service", breaking stale-service cleanup.
    expect(deployQuery.withGraphFetched).toHaveBeenCalledWith('[build, deployable]');
    const graphArg = deployQuery.withGraphFetched.mock.calls[0][0];
    expect(graphArg).not.toContain('service');
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

  test('branch-filtered reconciliation leaves same-repository deployables on other branches untouched', async () => {
    const staleMainDeploy = { id: 81, uuid: 'main-old-build-1', deployableId: 6 };
    createService(
      [
        { id: 6, name: 'main-old', resolvedFromRepositoryId: targetRepoId, branchName: 'main' },
        { id: 7, name: 'stable-old', resolvedFromRepositoryId: targetRepoId, branchName: 'stable' },
      ],
      [staleMainDeploy]
    );

    await (buildService as any).reconcileDeletedDeployables(
      createBuild(),
      {
        canReconcile: true,
        deployables: [],
        reconcileEligibleDeployables: [
          {
            name: 'main-new',
            source: 'yaml',
            reconcileEligible: true,
            resolvedFromRepositoryId: targetRepoId,
            branchName: 'main',
          },
          {
            name: 'stable-old',
            source: 'yaml',
            reconcileEligible: true,
            resolvedFromRepositoryId: targetRepoId,
            branchName: 'stable',
          },
        ],
      },
      targetRepoId,
      'main'
    );

    expect(mockCleanupDeploy).toHaveBeenCalledTimes(1);
    expect(mockCleanupDeploy).toHaveBeenCalledWith(staleMainDeploy, { mode: 'service' });
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [6] });
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
      { id: 10, uuid: 'build-1' } as any,
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

  test('cleanup failures retain database rows for a retry without failing the run', async () => {
    createService([{ id: 1, name: 'old-api' }], [{ id: 77, uuid: 'old-api-build-1', deployableId: 1 }]);
    mockCleanupDeploy.mockRejectedValue(new Error('targeted cleanup failed'));
    const build = createBuild();

    await expect(
      (buildService as any).reconcileDeletedDeployables(build as any, {
        canReconcile: true,
        deployables: [],
        reconcileEligibleDeployables: [],
      })
    ).resolves.toBeUndefined();

    expect(mockCleanupDeploy).toHaveBeenCalledTimes(1);
    expect(mockDeleteServiceRows).not.toHaveBeenCalled();
    expect(build.$fetchGraph).toHaveBeenCalledWith('[deployables, deploys]');
  });

  test('a partial cleanup failure deletes only the successfully cleaned rows', async () => {
    createService(
      [
        { id: 1, name: 'old-api' },
        { id: 2, name: 'old-worker' },
      ],
      [
        { id: 77, uuid: 'old-api-build-1', deployableId: 1 },
        { id: 78, uuid: 'old-worker-build-1', deployableId: 2 },
      ]
    );
    mockCleanupDeploy.mockImplementation(async (deploy: any) => {
      if (deploy.deployableId === 1) throw new Error('targeted cleanup failed');
      return true;
    });
    const build = createBuild();

    await (buildService as any).reconcileDeletedDeployables(build as any, {
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [],
    });

    expect(mockCleanupDeploy).toHaveBeenCalledTimes(2);
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [2] });
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

    expect(upsertDeployables).toHaveBeenCalledWith(
      10,
      'build-1',
      build.pullRequest,
      environment,
      build,
      targetRepoId,
      undefined,
      undefined
    );
    expect(reconcileDeletedDeployables).not.toHaveBeenCalled();
    expect(upsertWebhooksWithYaml).toHaveBeenCalledWith(build, build.pullRequest, null);
  });
});

describe('BuildService queue fingerprinting', () => {
  let buildService: BuildService;
  let mockBuildQuery: any;
  let mockBuildQueueAdd: jest.Mock;
  let mockResolveQueueAdd: jest.Mock;
  let mockBuildQueueGetJob: jest.Mock;

  const createMockBuild = (overrides: any = {}) =>
    ({
      id: 1,
      commentRuntimeEnv: { FEATURE_FLAG: 'on' },
      commentInitEnv: {},
      pullRequest: { latestCommit: 'abcdef123456', status: 'open', deployOnUpdate: true },
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
        },
      ],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any);

  beforeEach(() => {
    jest.clearAllMocks();

    mockBuildQueueAdd = jest.fn().mockResolvedValue(undefined);
    mockResolveQueueAdd = jest.fn().mockResolvedValue(undefined);
    mockBuildQueueGetJob = jest.fn().mockResolvedValue(undefined);

    mockBuildQuery = {
      findOne: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
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
    (buildService as any).buildQueue = { add: mockBuildQueueAdd, getJob: mockBuildQueueGetJob };
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

  test('appends triggerRef to the resolve dedupe key so distinct triggers get distinct keys', async () => {
    const build = createMockBuild();
    mockBuildQuery.withGraphFetched.mockResolvedValue(build);

    const expectedFingerprint = await buildService.computeBuildRequestFingerprint(build, 100);

    await buildService.enqueueResolveAndDeployBuild({
      buildId: 1,
      githubRepositoryId: 100,
      triggerRef: 'commit-a',
    });
    await buildService.enqueueResolveAndDeployBuild({
      buildId: 1,
      githubRepositoryId: 100,
      triggerRef: 'commit-b',
    });

    const firstKey = mockResolveQueueAdd.mock.calls[0][2].deduplication.id;
    const secondKey = mockResolveQueueAdd.mock.calls[1][2].deduplication.id;

    expect(firstKey).toBe(`resolve:1:${expectedFingerprint}:commit-a`);
    expect(secondKey).toBe(`resolve:1:${expectedFingerprint}:commit-b`);
    expect(firstKey).not.toBe(secondKey);
    // The trigger is forwarded into the job payload so the resolve step can hand it to the build step.
    expect(mockResolveQueueAdd.mock.calls[0][1]).toEqual(expect.objectContaining({ triggerRef: 'commit-a' }));
  });

  test('keeps the exact source repository, branch, and ref in the resolve queue payload', async () => {
    const build = createMockBuild();
    mockBuildQuery.withGraphFetched.mockResolvedValue(build);

    await buildService.enqueueResolveAndDeployBuild({
      buildId: 1,
      githubRepositoryId: 100,
      sourceGithubRepositoryId: 100,
      sourceBranch: 'Feature/X',
      sourceRef: 'commit-a',
      triggerRef: 'commit-a',
    });

    expect(mockResolveQueueAdd).toHaveBeenCalledWith(
      'resolve-deploy',
      expect.objectContaining({
        githubRepositoryId: 100,
        sourceGithubRepositoryId: 100,
        sourceBranch: 'Feature/X',
        sourceRef: 'commit-a',
      }),
      expect.any(Object)
    );
  });

  test('keeps the dedupe key commit-agnostic when no triggerRef is provided', async () => {
    const build = createMockBuild();
    mockBuildQuery.withGraphFetched.mockResolvedValue(build);

    const expectedFingerprint = await buildService.computeBuildRequestFingerprint(build, 100);

    await buildService.enqueueResolveAndDeployBuild({ buildId: 1, githubRepositoryId: 100 });

    expect(mockResolveQueueAdd.mock.calls[0][2].deduplication.id).toBe(`resolve:1:${expectedFingerprint}`);
    expect(mockResolveQueueAdd.mock.calls[0][1]).not.toHaveProperty('triggerRef');
  });

  test('the same triggerRef yields the same build job id so genuine duplicates still coalesce', async () => {
    const build = createMockBuild();
    mockBuildQuery.withGraphFetched.mockResolvedValue(build);

    const expectedFingerprint = await buildService.computeBuildRequestFingerprint(build, 100);

    await buildService.enqueueBuildJob({ buildId: 1, githubRepositoryId: 100, triggerRef: 'commit-a' });
    await buildService.enqueueBuildJob({ buildId: 1, githubRepositoryId: 100, triggerRef: 'commit-a' });

    expect(mockBuildQueueAdd.mock.calls[0][2].jobId).toBe(`build:1:${expectedFingerprint}:commit-a`);
    expect(mockBuildQueueAdd.mock.calls[1][2].jobId).toBe(mockBuildQueueAdd.mock.calls[0][2].jobId);
  });

  test('logs a dedupe skip when a matching build job already exists', async () => {
    const build = createMockBuild();
    mockBuildQuery.withGraphFetched.mockResolvedValue(build);
    mockBuildQueueGetJob.mockResolvedValue({ id: 'existing' });

    const expectedFingerprint = await buildService.computeBuildRequestFingerprint(build, 100);

    await buildService.enqueueBuildJob({ buildId: 1, githubRepositoryId: 100, triggerRef: 'commit-a' });

    expect(mockBuildQueueGetJob).toHaveBeenCalledWith(`build:1:${expectedFingerprint}:commit-a`);
    // add() is still invoked; it is a no-op when the job already exists.
    expect(mockBuildQueueAdd).toHaveBeenCalled();
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
        status: 'open',
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

  test('forwards queue identity and immutable source refs from resolve to build', async () => {
    const build = createMockBuild({
      id: 1449,
      uuid: 'good-dev-0',
      pullRequest: {
        latestCommit: 'abcdef123456',
        status: 'open',
        deployOnUpdate: true,
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    });
    mockBuildQuery.findOne.mockResolvedValue(build);
    const enqueueBuildJob = jest.spyOn(buildService, 'enqueueBuildJob').mockResolvedValue(undefined as any);

    await buildService.processResolveAndDeployBuildQueue({
      id: '42',
      data: {
        buildId: 1449,
        githubRepositoryId: 425935548,
        triggerRef: 'head-commit-sha',
        sourceRef: 'head-commit-sha',
        sourceGithubRepositoryId: 425935548,
        sourceBranch: 'Main',
      },
    });

    expect(enqueueBuildJob).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerRef: 'head-commit-sha',
        sourceRef: 'head-commit-sha',
        sourceGithubRepositoryId: 425935548,
        sourceBranch: 'Main',
        triggerSequence: '42',
      })
    );
  });

  test('rethrows build enqueue failures so the resolve job retry budget is used', async () => {
    const build = createMockBuild({ id: 1449, uuid: 'good-dev-0' });
    mockBuildQuery.findOne.mockResolvedValue(build);
    jest.spyOn(buildService, 'enqueueBuildJob').mockRejectedValue(new Error('redis unavailable'));

    await expect(
      buildService.processResolveAndDeployBuildQueue({ id: '43', data: { buildId: 1449, triggerRef: 'sha' } })
    ).rejects.toThrow('redis unavailable');
  });

  test('rejects an out-of-order trigger after a newer sequence claimed the same build/source scope', async () => {
    const values = new Map<string, string>();
    (buildService as any).redis = {
      get: jest.fn(async (key: string) => values.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        values.set(key, value);
        return 'OK';
      }),
    };

    await expect((buildService as any).claimTriggerSequence(7, 100, 'main', '102')).resolves.toBe(true);
    await expect((buildService as any).claimTriggerSequence(7, 100, 'main', '101')).resolves.toBe(false);
    await expect((buildService as any).claimTriggerSequence(7, 100, 'stable', '101')).resolves.toBe(true);
    await expect((buildService as any).claimTriggerSequence(7, 200, 'main', '101')).resolves.toBe(true);
    await expect((buildService as any).claimTriggerSequence(7, 100, 'main', '102')).resolves.toBe(true);

    expect(values).toEqual(
      new Map([
        ['build-deployment-sequence.resolve_and_deploy_test.7.100.main', '102'],
        ['build-deployment-sequence.resolve_and_deploy_test.7.100.stable', '101'],
        ['build-deployment-sequence.resolve_and_deploy_test.7.200.main', '101'],
      ])
    );
    for (const call of ((buildService as any).redis.set as jest.Mock).mock.calls) {
      expect(call.slice(2)).toEqual(['EX', 7 * 24 * 60 * 60]);
    }
  });

  test('keeps the delivered ref when it is still the live branch head', async () => {
    const whereNull = jest.fn().mockResolvedValue({ githubRepositoryId: 100, fullName: 'org/repo' });
    const findOne = jest.fn(() => ({ whereNull }));
    (buildService as any).db.models.Repository = { query: jest.fn(() => ({ findOne })) };
    (github.getSHAForBranch as jest.Mock).mockResolvedValue('newest-sha');

    await expect((buildService as any).resolveEffectiveSourceRef(100, 'Feature/X', 'newest-sha')).resolves.toBe(
      'newest-sha'
    );

    expect(findOne).toHaveBeenCalledWith({ githubRepositoryId: 100 });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
    expect(github.getSHAForBranch).toHaveBeenCalledWith('Feature/X', 'org', 'repo');
  });

  test('converges a stale delivered ref to the live branch head instead of dropping the push', async () => {
    const whereNull = jest.fn().mockResolvedValue({ githubRepositoryId: 100, fullName: 'org/repo' });
    (buildService as any).db.models.Repository = {
      query: jest.fn(() => ({ findOne: jest.fn(() => ({ whereNull })) })),
    };
    (github.getSHAForBranch as jest.Mock).mockResolvedValue('newest-sha');

    await expect((buildService as any).resolveEffectiveSourceRef(100, 'Feature/X', 'older-sha')).resolves.toBe(
      'newest-sha'
    );
  });

  test('fails open to the delivered ref on head-check, repository, or lookup failures', async () => {
    const whereNull = jest
      .fn()
      .mockResolvedValueOnce({ githubRepositoryId: 100, fullName: 'org/repo' })
      .mockResolvedValueOnce(undefined);
    (buildService as any).db.models.Repository = {
      query: jest.fn(() => ({ findOne: jest.fn(() => ({ whereNull })) })),
    };
    (github.getSHAForBranch as jest.Mock).mockRejectedValue(new Error('GitHub unavailable'));

    await expect((buildService as any).resolveEffectiveSourceRef(100, 'main', 'sha')).resolves.toBe('sha');
    await expect((buildService as any).resolveEffectiveSourceRef(100, 'main', 'sha')).resolves.toBe('sha');
    await expect((buildService as any).resolveEffectiveSourceRef(100, undefined, 'sha')).resolves.toBe('sha');

    const databaseError = new Error('database unavailable');
    (buildService as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: jest.fn().mockRejectedValue(databaseError) })),
      })),
    };
    await expect((buildService as any).resolveEffectiveSourceRef(100, 'main', 'sha')).resolves.toBe('sha');
  });
});

describe('idempotency digest + replay authorization (D12)', () => {
  const caught = (fn: () => void): any => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return null;
  };

  const baseInput = () => ({
    repositoryFullName: 'Org/Repo',
    branch: 'main',
    services: [
      { name: 'web', active: true },
      { name: 'api', active: false, branchOrExternalUrl: 'feature/x' },
    ],
    env: { B: '2', A: '1' },
  });

  it('is stable across service order and env key order', () => {
    const a = computeIdempotencyRequestDigest(baseInput() as any);
    const reordered = {
      repositoryFullName: 'Org/Repo',
      branch: 'main',
      services: [
        { name: 'api', active: false, branchOrExternalUrl: 'feature/x' },
        { name: 'web', active: true },
      ],
      env: { A: '1', B: '2' },
    };
    expect(computeIdempotencyRequestDigest(reordered as any)).toBe(a);
  });

  it('normalizes the repository full name (case-insensitive)', () => {
    const a = computeIdempotencyRequestDigest(baseInput() as any);
    expect(computeIdempotencyRequestDigest({ ...baseInput(), repositoryFullName: 'org/repo' } as any)).toBe(a);
  });

  it('changes when a semantic field changes', () => {
    const a = computeIdempotencyRequestDigest(baseInput() as any);
    expect(computeIdempotencyRequestDigest({ ...baseInput(), branch: 'develop' } as any)).not.toBe(a);
    expect(computeIdempotencyRequestDigest({ ...baseInput(), sha: 'deadbeef' } as any)).not.toBe(a);
  });

  it('normalizes omitted initEnv to the env values persisted by create', () => {
    const a = computeIdempotencyRequestDigest(baseInput() as any);
    expect(computeIdempotencyRequestDigest({ ...baseInput(), initEnv: baseInput().env } as any)).toBe(a);
    expect(computeIdempotencyRequestDigest({ ...baseInput(), initEnv: { A: 'different' } } as any)).not.toBe(a);
  });

  it('ignores auth/attribution fields and the idempotency key itself', () => {
    const a = computeIdempotencyRequestDigest(baseInput() as any);
    const withAttribution = {
      ...baseInput(),
      idempotencyKey: 'req-123',
      createdByUserId: 'user-9',
      createdByTokenId: 42,
      createdBy: 'someone',
      createdByGithubLogin: 'octo',
    };
    expect(computeIdempotencyRequestDigest(withAttribution as any)).toBe(a);
  });

  const digest = 'a'.repeat(64);

  it('409s when the same key is replayed with a different request body', () => {
    const error = caught(() =>
      assertIdempotentReplayAllowed({ idempotencyRequestDigest: digest, githubRepositoryId: 1 }, 'b'.repeat(64), null)
    );
    expect(error).toMatchObject({ httpStatus: 409, code: 'idempotency_conflict' });
  });

  it('returns the stored build (does not throw) when the digest matches', () => {
    expect(
      caught(() =>
        assertIdempotentReplayAllowed({ idempotencyRequestDigest: digest, githubRepositoryId: 1 }, digest, null)
      )
    ).toBeNull();
  });

  it('403s a repo-constrained principal whose allowlist excludes the stored build', () => {
    const error = caught(() =>
      assertIdempotentReplayAllowed({ idempotencyRequestDigest: digest, githubRepositoryId: 7 }, digest, [1, 2])
    );
    expect(error).toMatchObject({ httpStatus: 403, code: 'forbidden_repository' });
  });

  it('allows a repo-constrained principal whose allowlist includes the stored build', () => {
    expect(
      caught(() =>
        assertIdempotentReplayAllowed({ idempotencyRequestDigest: digest, githubRepositoryId: 7 }, digest, [7, 9])
      )
    ).toBeNull();
  });

  it('allows an unconstrained session (null authorizedRepoIds)', () => {
    expect(
      caught(() =>
        assertIdempotentReplayAllowed({ idempotencyRequestDigest: digest, githubRepositoryId: 7 }, digest, null)
      )
    ).toBeNull();
  });

  it('skips the conflict check when the stored digest is null (pre-feature build)', () => {
    expect(
      caught(() =>
        assertIdempotentReplayAllowed({ idempotencyRequestDigest: null, githubRepositoryId: 7 }, digest, null)
      )
    ).toBeNull();
  });
});
