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
const mockGenerateGraph = jest.fn().mockResolvedValue({});
const mockAcceptDeploymentIntent = jest.fn().mockResolvedValue({
  accepted: true,
  generation: 1,
  scopeKey: 'all',
});

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

jest.mock('server/lib/deploymentReconciliation/mailbox', () => {
  const actual = jest.requireActual('server/lib/deploymentReconciliation/mailbox');
  return {
    ...actual,
    acceptDeploymentIntent: (...args: any[]) => mockAcceptDeploymentIntent(...args),
  };
});

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
    DEPLOYMENT_RECONCILIATION: 'deployment_reconciliation_test',
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
  compareCommits: jest.fn(),
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

jest.mock('server/lib/dependencyGraph', () => ({
  generateGraph: (...args: any[]) => mockGenerateGraph(...args),
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
import { BuildKind, BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';
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
  const statusQuery = (affectedRows = 1) => {
    const query: any = {
      patch: jest.fn(() => query),
      where: jest.fn(() => query),
      whereNull: jest.fn(() => query),
      then: (resolve: (value: number) => void, reject: (reason: unknown) => void) =>
        Promise.resolve(affectedRows).then(resolve, reject),
    };
    return query;
  };

  test('updates only build status fields', async () => {
    const query = statusQuery();
    const buildService = new BuildService(
      {
        models: { Build: { query: jest.fn(() => query) } },
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
      deploys: undefined,
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await buildService.updateStatusAndComment(build as any, BuildStatus.DEPLOYED, 'run-1', true, true);

    expect(query.patch).toHaveBeenCalledTimes(1);
    expect(query.patch).toHaveBeenCalledWith({
      status: BuildStatus.DEPLOYED,
      statusMessage: '',
    });
    expect(query.where).toHaveBeenCalledWith({ id: 1, runUUID: 'run-1' });
  });

  test('does not abort teardown status progress when webhook notification enqueue fails', async () => {
    const query = statusQuery();
    const webhookAdd = jest.fn().mockRejectedValue(new Error('redis unavailable'));
    const buildService = new BuildService(
      {
        models: { Build: { query: jest.fn(() => query) } },
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
    };

    await expect(
      buildService.updateStatusAndComment(build as any, BuildStatus.TEARING_DOWN, 'run-1', true, true)
    ).resolves.toBeUndefined();

    expect(query.patch).toHaveBeenCalledWith({
      status: BuildStatus.TEARING_DOWN,
      statusMessage: '',
    });
    expect(webhookAdd).toHaveBeenCalledTimes(1);
  });

  test('does not publish after a newer desired generation takes ownership', async () => {
    const query = statusQuery(0);
    const webhookAdd = jest.fn();
    const activityUpdate = jest.fn();
    const buildService = new BuildService(
      {
        models: { Build: { query: jest.fn(() => query) } },
        services: {
          ActivityStream: { updatePullRequestActivityStream: activityUpdate },
          Webhook: { webhookQueue: { add: webhookAdd } },
        },
      } as any,
      {} as any,
      {} as any,
      {
        registerQueue: jest.fn(() => ({ add: mockQueueAdd, process: jest.fn(), on: jest.fn() })),
      } as any
    );
    const build = {
      id: 1,
      uuid: 'sample-build',
      runUUID: 'run-a',
      status: BuildStatus.DEPLOYING,
      kind: BuildKind.ENVIRONMENT,
      deploys: [],
      pullRequest: { repository: {} },
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await buildService.updateStatusAndComment(build as any, BuildStatus.DEPLOYED, 'run-a', true, true, null, 2);

    expect(query.where).toHaveBeenCalledWith('desiredGeneration', 2);
    expect(build.status).toBe(BuildStatus.DEPLOYING);
    expect(activityUpdate).not.toHaveBeenCalled();
    expect(webhookAdd).not.toHaveBeenCalled();
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

describe('BuildService getEnvironmentsToBuild', () => {
  const createService = (foundEnvironment: any) =>
    new BuildService(
      {
        models: {
          Environment: {
            findOne: jest.fn().mockResolvedValue(foundEnvironment),
            // Phase 1 removed Environment.relationMappings.services. The old else-branch called
            // Environment.find().withGraphJoined('services'), which throws UnknownRelationError.
            find: jest.fn(() => {
              throw new Error('Environment.find() must not be called: the DB-service lookup was removed');
            }),
          },
        },
      } as any,
      {} as any,
      {} as any,
      {
        registerQueue: jest.fn(() => ({ add: jest.fn(), process: jest.fn(), on: jest.fn() })),
      } as any
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns the environment for a known environmentId', async () => {
    const environment = { id: 7 };
    const service = createService(environment);

    await expect((service as any).getEnvironmentsToBuild(7)).resolves.toEqual([environment]);
  });

  test('returns empty for a null environmentId instead of querying the removed services relation', async () => {
    const service = createService(undefined);

    await expect((service as any).getEnvironmentsToBuild(null)).resolves.toEqual([]);
    expect((service as any).db.models.Environment.find).not.toHaveBeenCalled();
  });

  test('returns empty when the environment is missing rather than a list holding undefined', async () => {
    const service = createService(undefined);

    // toStrictEqual: toEqual treats [undefined] as [], which would hide the old push-undefined behaviour.
    await expect((service as any).getEnvironmentsToBuild(99)).resolves.toStrictEqual([]);
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

  test('a false cleanup result retains database rows for a retry', async () => {
    createService([{ id: 1, name: 'old-api' }], [{ id: 77, uuid: 'old-api-build-1', deployableId: 1 }]);
    mockCleanupDeploy.mockResolvedValue(false);

    await (buildService as any).reconcileDeletedDeployables(createBuild(), {
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [],
    });

    expect(mockDeleteServiceRows).not.toHaveBeenCalled();
  });

  test('runs only stale native teardown through the current generation promotion gate', async () => {
    const staleDeploy = { id: 77, uuid: 'old-api-build-1', deployableId: 1 };
    createService([{ id: 1, name: 'old-api' }], [staleDeploy]);
    const nativeAction = jest.fn().mockResolvedValue(['native-clean']);
    mockCleanupDeploy.mockImplementation(async (_deploy: any, options: any) => {
      await options.nativeMutationGate(nativeAction);
      return true;
    });
    const promotion = jest
      .spyOn(buildService, 'withCurrentBuildPromotionLock')
      .mockImplementation(async (_buildId, _isCurrent, action) => ({ admitted: true, value: await action() }));
    jest.spyOn(buildService as any, 'isDeploymentRunCurrent').mockResolvedValue(true);

    await (buildService as any).reconcileDeletedDeployables(
      createBuild(),
      { canReconcile: true, deployables: [], reconcileEligibleDeployables: [] },
      undefined,
      undefined,
      'run-c',
      3
    );

    expect(promotion).toHaveBeenCalledWith(10, expect.any(Function), nativeAction);
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [1] });
  });

  test('does not delete stale rows when native teardown loses generation authority', async () => {
    createService([{ id: 1, name: 'old-api' }], [{ id: 77, uuid: 'old-api-build-1', deployableId: 1 }]);
    mockCleanupDeploy.mockImplementation(async (_deploy: any, options: any) => {
      await options.nativeMutationGate(async () => true);
      return true;
    });
    jest.spyOn(buildService, 'withCurrentBuildPromotionLock').mockResolvedValue({ admitted: false });

    await expect(
      (buildService as any).reconcileDeletedDeployables(
        createBuild(),
        { canReconcile: true, deployables: [], reconcileEligibleDeployables: [] },
        undefined,
        undefined,
        'run-c',
        3
      )
    ).rejects.toThrow('Deployment generation was superseded');
    expect(mockDeleteServiceRows).not.toHaveBeenCalled();
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
      undefined,
      targetRepoId
    );
    expect(reconcileDeletedDeployables).not.toHaveBeenCalled();
    expect(upsertWebhooksWithYaml).toHaveBeenCalledWith(build, build.pullRequest, null);
  });
});
describe('BuildService deployment reconciliation', () => {
  const queueManager = () => ({
    registerQueue: jest.fn(() => ({ add: jest.fn(), process: jest.fn(), on: jest.fn() })),
  });

  const createBuild = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    uuid: 'sample-build',
    status: BuildStatus.DEPLOYED,
    deployEnabled: true,
    pullRequest: { latestCommit: 'abcdef123456', status: 'open', deployOnUpdate: true },
    deploys: [],
    ...overrides,
  });

  const serviceHarness = () => {
    const buildQuery: any = {
      findOne: jest.fn(() => buildQuery),
      findById: jest.fn(() => buildQuery),
      select: jest.fn(() => buildQuery),
      whereRaw: jest.fn(() => buildQuery),
      where: jest.fn(() => buildQuery),
      whereNull: jest.fn(() => buildQuery),
      orderBy: jest.fn(() => buildQuery),
      limit: jest.fn().mockResolvedValue([]),
      withGraphFetched: jest.fn(),
    };
    const service = new BuildService(
      { models: { Build: { query: jest.fn(() => buildQuery) } }, services: {} } as any,
      {} as any,
      {} as any,
      queueManager() as any
    );
    const add = jest.fn().mockResolvedValue(undefined);
    (service as any).deploymentReconciliationQueue = { add };
    return { service, buildQuery, add };
  };

  const reconciliationWorkerHarness = () => {
    const { service } = serviceHarness();
    const failure = new Error('reconciliation infrastructure failed');
    const claim = {
      generation: 7,
      token: 'run-current',
      dirty: [{ scopeKey: 'all', intent: { type: 'all', requestId: 'run-current', gen: 7 } }],
    };
    const build = createBuild({ id: 1, runUUID: claim.token });

    jest
      .spyOn(service as any, 'tryWithDeploymentGenerationLock')
      .mockImplementation(async (_buildId, _generation, action) => action());
    const claimReconciliation = jest.spyOn(service as any, 'claimDeploymentReconciliation').mockResolvedValue(claim);
    const withDeploymentLock = jest
      .spyOn(service as any, 'withCurrentBuildDeploymentLock')
      .mockImplementation(async (_buildId, _isCurrent, action) => ({ admitted: true, value: await action() }));
    const loadBuild = jest.spyOn(service as any, 'loadBuildDeploymentAuthority').mockResolvedValue(build);
    jest.spyOn(service as any, 'claimDeploymentRun').mockResolvedValue(claim.token);
    jest.spyOn(service as any, 'deploymentReconciliationScopes').mockImplementation(() => {
      throw failure;
    });
    const isCurrent = jest.spyOn(service as any, 'isDeploymentRunCurrent').mockResolvedValue(true);
    const recordFailure = jest.spyOn(service as any, 'recordBuildFailure').mockResolvedValue(undefined);
    const markObserved = jest.spyOn(service as any, 'markDeploymentReconciliationObserved').mockResolvedValue(true);

    const job = (attemptsMade: number) => ({
      data: { buildId: 1, generation: claim.generation },
      attemptsMade,
      opts: { attempts: 10 },
    });

    return {
      service,
      failure,
      claim,
      build,
      claimReconciliation,
      withDeploymentLock,
      loadBuild,
      isCurrent,
      recordFailure,
      markObserved,
      job,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAcceptDeploymentIntent.mockResolvedValue({ accepted: true, generation: 1, scopeKey: 'all' });
  });

  const deploymentScopeHarness = (buildImagesResult: boolean) => {
    const { service } = serviceHarness();
    const build = createBuild({ id: 1, runUUID: 'run-current', namespace: 'env-sample' });
    jest.spyOn(service as any, 'isDeploymentRunCurrent').mockResolvedValue(true);
    const buildImages = jest.spyOn(service as any, 'buildImages').mockResolvedValue(buildImagesResult);
    jest.spyOn(service as any, 'deployCLIServices').mockResolvedValue(true);
    const updateStatus = jest.spyOn(service as any, 'updateStatusAndComment').mockResolvedValue(undefined);
    const applyManifests = jest.spyOn(service as any, 'generateAndApplyManifests').mockResolvedValue(true);
    const preparation = {
      build,
      runUUID: 'run-current',
      githubRepositoryId: 100,
      sourceGithubRepositoryId: 100,
      sourceRef: 'commit-a',
      sourceBranch: 'main',
    };
    return { service, preparation, buildImages, updateStatus, applyManifests };
  };

  test('a failed image phase reports ERROR and never reaches manifest apply', async () => {
    const { service, preparation, buildImages, updateStatus, applyManifests } = deploymentScopeHarness(false);

    const result = await (service as any).executeDeploymentScope(preparation, 7);

    expect(result).toEqual({ status: BuildStatus.ERROR });
    expect(buildImages).toHaveBeenCalledTimes(1);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(applyManifests).not.toHaveBeenCalled();
  });

  test('a successful image phase proceeds to manifest apply and reports DEPLOYED', async () => {
    const { service, preparation, applyManifests } = deploymentScopeHarness(true);

    const result = await (service as any).executeDeploymentScope(preparation, 7);

    expect(result).toEqual({ status: BuildStatus.DEPLOYED });
    expect(applyManifests).toHaveBeenCalledTimes(1);
  });

  test('signals only the exact durable generation accepted by the mailbox', async () => {
    const { service, add } = serviceHarness();

    await service.enqueueResolveAndDeployBuild({ buildId: 1, githubRepositoryId: 100 });

    expect(add).toHaveBeenCalledWith('reconcile', { buildId: 1, generation: 1 }, { jobId: 'reconcile-1-1' });
  });

  test('uses different queue identities for successive desired generations', async () => {
    const { service, add } = serviceHarness();
    mockAcceptDeploymentIntent
      .mockResolvedValueOnce({ accepted: true, generation: 8, scopeKey: 'repository:100' })
      .mockResolvedValueOnce({ accepted: true, generation: 9, scopeKey: 'repository:100' });

    await service.enqueueResolveAndDeployBuild({ buildId: 1, githubRepositoryId: 100 });
    await service.enqueueResolveAndDeployBuild({ buildId: 1, githubRepositoryId: 100 });

    expect(add.mock.calls[0][2]).toEqual({ jobId: 'reconcile-1-8' });
    expect(add.mock.calls[1][2]).toEqual({ jobId: 'reconcile-1-9' });
  });

  test('accepts a tracked push as repository-selective work with its delivered SHA floor', async () => {
    const { service } = serviceHarness();

    await service.enqueueResolveAndDeployBuild({
      buildId: 1,
      githubRepositoryId: 100,
      sourceGithubRepositoryId: 100,
      sourceBranch: 'main',
      sourceRef: 'commit-c',
      sourceBeforeRef: 'commit-b',
      runUUID: 'request-c',
    });

    expect(mockAcceptDeploymentIntent).toHaveBeenCalledWith(1, {
      type: 'source',
      requestId: 'request-c',
      target: 'repository',
      githubRepositoryId: 100,
      branch: 'main',
      sha: 'commit-c',
      beforeSha: 'commit-b',
    });
  });

  test('uses distinct execution tokens when two source scopes reference the same SHA', async () => {
    const { service } = serviceHarness();
    mockAcceptDeploymentIntent
      .mockResolvedValueOnce({ accepted: true, generation: 1, scopeKey: 'source:100:main' })
      .mockResolvedValueOnce({ accepted: true, generation: 2, scopeKey: 'source:100:release' });

    await service.enqueueResolveAndDeployBuild({
      buildId: 1,
      githubRepositoryId: 100,
      sourceGithubRepositoryId: 100,
      sourceBranch: 'main',
      sourceRef: 'shared-sha',
    });
    await service.enqueueResolveAndDeployBuild({
      buildId: 1,
      githubRepositoryId: 100,
      sourceGithubRepositoryId: 100,
      sourceBranch: 'release',
      sourceRef: 'shared-sha',
    });

    const first = mockAcceptDeploymentIntent.mock.calls[0][1];
    const second = mockAcceptDeploymentIntent.mock.calls[1][1];
    expect(first.sha).toBe('shared-sha');
    expect(second.sha).toBe('shared-sha');
    expect(first.requestId).not.toBe(second.requestId);
  });

  test('keeps root-source provenance while requesting a full-scope pass', async () => {
    const { service } = serviceHarness();

    await service.enqueueResolveAndDeployBuild({
      buildId: 1,
      sourceGithubRepositoryId: 100,
      sourceBranch: 'main',
      sourceRef: 'commit-c',
      runUUID: 'request-c',
    });

    expect(mockAcceptDeploymentIntent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: 'source',
        requestId: 'request-c',
        target: 'all',
        githubRepositoryId: 100,
        sha: 'commit-c',
      })
    );
  });

  test('does not signal a source SHA already present in the mailbox', async () => {
    const { service, add } = serviceHarness();
    mockAcceptDeploymentIntent.mockResolvedValueOnce({
      accepted: false,
      generation: 7,
      scopeKey: 'source:100:main',
    });

    await service.enqueueResolveAndDeployBuild({
      buildId: 1,
      githubRepositoryId: 100,
      sourceGithubRepositoryId: 100,
      sourceBranch: 'main',
      sourceRef: 'commit-c',
    });

    expect(add).not.toHaveBeenCalled();
  });

  test('the recovery sweep re-signals durable pending work', async () => {
    const { service, buildQuery, add } = serviceHarness();
    buildQuery.limit.mockResolvedValueOnce([{ id: 7, desiredGeneration: '3' }]);

    await service.enqueuePendingDeploymentReconciliations();

    expect(add).toHaveBeenCalledWith('reconcile', { buildId: 7, generation: 3 }, { jobId: 'reconcile-7-3' });
  });

  test('service redeploy uses the effective source repository and leaves row ownership to the worker', async () => {
    const { service, buildQuery, add } = serviceHarness();
    const directPatch = jest.fn();
    const clicked = {
      id: 33,
      uuid: 'pdm-db-sample-build',
      githubRepositoryId: 425935548,
      deployable: {
        name: 'pdm-db',
        resolvedFromRepositoryId: 425935548,
        repositoryId: 100,
      },
      $query: directPatch,
    };
    buildQuery.withGraphFetched.mockResolvedValue(
      createBuild({
        id: 1449,
        uuid: 'good-dev-0',
        deploys: [
          clicked,
          {
            id: 34,
            githubRepositoryId: 425935548,
            deployable: { name: 'pdm-api', resolvedFromRepositoryId: 425935548 },
          },
          { id: 35, githubRepositoryId: 999, deployable: { name: 'unrelated', resolvedFromRepositoryId: 999 } },
        ],
      })
    );

    await service.redeployServiceFromBuild('good-dev-0', 'pdm-db');

    expect(mockAcceptDeploymentIntent).toHaveBeenCalledWith(
      1449,
      expect.objectContaining({ type: 'repository', githubRepositoryId: 425935548 })
    );
    expect(add).toHaveBeenCalledWith('reconcile', { buildId: 1449, generation: 1 }, { jobId: 'reconcile-1449-1' });
    expect(directPatch).not.toHaveBeenCalled();
  });

  test('service redeploy rejects a service without a source repository identity', async () => {
    const { service, buildQuery, add } = serviceHarness();
    buildQuery.withGraphFetched.mockResolvedValue(
      createBuild({
        deploys: [
          {
            id: 33,
            githubRepositoryId: null,
            deployable: { name: 'pdm-db', resolvedFromRepositoryId: null, repositoryId: null },
          },
        ],
      })
    );

    await expect(service.redeployServiceFromBuild('sample-build', 'pdm-db')).rejects.toThrow(
      'Cannot redeploy pdm-db: source repository is unknown.'
    );
    expect(add).not.toHaveBeenCalled();
  });

  test('repository redeploy bulk-claims every Deploy from that repository without a service-id predicate', async () => {
    const deployClaim: any = {
      patch: jest.fn(() => deployClaim),
      where: jest.fn(() => deployClaim),
      then: (resolve: (value: number) => void, reject: (reason: unknown) => void) =>
        Promise.resolve(2).then(resolve, reject),
    };
    const deploys = [
      { id: 11, githubRepositoryId: 42, branchName: 'main' },
      { id: 12, githubRepositoryId: 42, branchName: 'release' },
      { id: 13, githubRepositoryId: 99, branchName: 'main' },
    ];
    const findOrCreateDeploys = jest.fn().mockResolvedValue(deploys);
    const service = new BuildService(
      {
        models: { Deploy: { query: jest.fn(() => deployClaim) } },
        services: { Deploy: { findOrCreateDeploys } },
      } as any,
      {} as any,
      {} as any,
      queueManager() as any
    );
    jest.spyOn(service as any, 'isDeploymentRunCurrent').mockResolvedValue(true);
    jest.spyOn(service, 'markConfigurationsAsBuilt').mockResolvedValue(undefined);
    jest.spyOn(service, 'updateStatusAndComment').mockResolvedValue(undefined);
    mockGenerateGraph.mockRejectedValueOnce(new Error('graph omitted from scope assertion'));
    const build: any = {
      id: 4,
      uuid: 'large-static',
      runUUID: 'run-c',
      environment: { id: 7 },
      pullRequest: {
        fullName: 'org/root',
        branchName: 'main',
        latestCommit: 'root-sha',
        repository: { githubRepositoryId: 1 },
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $setRelated: jest.fn(),
    };

    await (service as any).prepareDeploymentScope(build, 42, undefined, {
      runUUID: 'run-c',
    });

    expect(deployClaim.patch).toHaveBeenCalledWith({ runUUID: 'run-c' });
    expect(deployClaim.where).toHaveBeenCalledWith({ buildId: 4 });
    expect(deployClaim.where).toHaveBeenCalledWith('githubRepositoryId', 42);
    expect(deployClaim.where).not.toHaveBeenCalledWith('branchName', expect.anything());
    expect(deployClaim.where).not.toHaveBeenCalledWith('id', expect.anything());
    expect(deploys.map((deploy: any) => deploy.runUUID)).toEqual(['run-c', 'run-c', undefined]);
  });

  test('a stale B signal cannot claim or execute C mailbox contents', async () => {
    const row = {
      desiredGeneration: 3,
      observedGeneration: 0,
      acceptedRefs: {
        'source:100:main': {
          type: 'source',
          requestId: 'request-c',
          target: 'repository',
          githubRepositoryId: 100,
          branch: 'main',
          sha: 'commit-c',
          gen: 3,
        },
      },
    };
    const query: any = {
      findById: jest.fn(() => query),
      whereNull: jest.fn().mockResolvedValue(row),
    };
    const service = new BuildService(
      { models: { Build: { query: jest.fn(() => query) } } } as any,
      {} as any,
      {} as any,
      queueManager() as any
    );

    await expect((service as any).claimDeploymentReconciliation(1, 2)).resolves.toBeNull();
    await expect((service as any).claimDeploymentReconciliation(1, 3)).resolves.toEqual({
      generation: 3,
      token: 'request-c',
      dirty: [
        {
          scopeKey: 'source:100:main',
          intent: row.acceptedRefs['source:100:main'],
        },
      ],
    });
  });

  test('repository-scoped work stays selective while a root-source intent remains full-scope', () => {
    const { service } = serviceHarness();
    const scopes = (service as any).deploymentReconciliationScopes([
      {
        scopeKey: 'source:100:main',
        intent: {
          type: 'source',
          requestId: 'repo-c',
          target: 'repository',
          githubRepositoryId: 100,
          branch: 'main',
          sha: 'commit-c',
          gen: 1,
        },
      },
      {
        scopeKey: 'source:200:main',
        intent: {
          type: 'source',
          requestId: 'root-d',
          target: 'all',
          githubRepositoryId: 200,
          branch: 'main',
          sha: 'commit-d',
          gen: 2,
        },
      },
    ]);

    // The full pass runs first, then the delivered repo SHA is re-applied as a
    // selective floor so a lagging live-head read cannot roll C back to B.
    expect(scopes).toEqual([
      {
        githubRepositoryId: null,
        sourceGithubRepositoryId: 200,
        sourceRef: 'commit-d',
        sourceBeforeRef: undefined,
        sourceBranch: 'main',
      },
      {
        githubRepositoryId: 100,
        sourceGithubRepositoryId: 100,
        sourceRef: 'commit-c',
        sourceBeforeRef: undefined,
        sourceBranch: 'main',
      },
    ]);
  });

  test('manual full redeploy cannot erase an older delivered repository SHA', () => {
    const { service } = serviceHarness();
    const scopes = (service as any).deploymentReconciliationScopes([
      {
        scopeKey: 'source:100:main',
        intent: {
          type: 'source',
          requestId: 'repo-c',
          target: 'repository',
          githubRepositoryId: 100,
          branch: 'main',
          sha: 'commit-c',
          gen: 1,
        },
      },
      { scopeKey: 'all', intent: { type: 'all', requestId: 'manual-all', gen: 2 } },
    ]);

    expect(scopes).toEqual([
      { githubRepositoryId: null },
      {
        githubRepositoryId: 100,
        sourceGithubRepositoryId: 100,
        sourceRef: 'commit-c',
        sourceBeforeRef: undefined,
        sourceBranch: 'main',
      },
    ]);
  });

  test('starts the newest repository source before retained work for another repository', () => {
    const { service } = serviceHarness();
    const scopes = (service as any).deploymentReconciliationScopes([
      {
        scopeKey: 'source:100:main',
        intent: {
          type: 'source',
          requestId: 'repo-a',
          target: 'repository',
          githubRepositoryId: 100,
          branch: 'main',
          sha: 'commit-a',
          gen: 1,
        },
      },
      {
        scopeKey: 'source:200:main',
        intent: {
          type: 'source',
          requestId: 'repo-b',
          target: 'repository',
          githubRepositoryId: 200,
          branch: 'main',
          sha: 'commit-b',
          gen: 2,
        },
      },
    ]);

    expect(scopes.map((scope) => scope.githubRepositoryId)).toEqual([200, 100]);
  });

  test('different generations use different execution locks so C does not wait for A', async () => {
    let releaseA!: () => void;
    let signalAStarted!: () => void;
    const aHeld = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const aStarted = new Promise<void>((resolve) => {
      signalAStarted = resolve;
    });
    const lock = jest.fn(async () => ({ unlock: jest.fn().mockResolvedValue(undefined), extend: jest.fn() }));
    const service = new BuildService({} as any, {} as any, { lock } as any, queueManager() as any);

    const a = (service as any).tryWithDeploymentGenerationLock(1, 1, async () => {
      signalAStarted();
      await aHeld;
    });
    await aStarted;

    let cRan = false;
    await (service as any).tryWithDeploymentGenerationLock(1, 3, async () => {
      cRan = true;
    });

    expect(cRan).toBe(true);
    expect(lock.mock.calls.map(([resource]) => resource)).toEqual(['build-reconcile.1.1', 'build-reconcile.1.3']);
    releaseA();
    await a;
  });

  test('a superseded image phase cannot enter deployment rollout', async () => {
    const { service } = serviceHarness();
    const build = createBuild({ id: 1, runUUID: 'run-a' });
    const isCurrent = jest
      .spyOn(service as any, 'isDeploymentRunCurrent')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    jest.spyOn(service, 'buildImages').mockResolvedValue(true);
    jest.spyOn(service, 'deployCLIServices').mockResolvedValue(true);
    const updateStatus = jest.spyOn(service, 'updateStatusAndComment').mockResolvedValue(undefined);
    const applyManifests = jest.spyOn(service, 'generateAndApplyManifests').mockResolvedValue(true);

    const result = await (service as any).executeDeploymentScope(
      {
        build,
        runUUID: 'run-a',
        githubRepositoryId: 100,
        sourceGithubRepositoryId: 100,
        sourceRef: 'commit-a',
        sourceBranch: 'main',
      },
      7
    );

    expect(result).toBeNull();
    expect(isCurrent).toHaveBeenCalledTimes(2);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(applyManifests).not.toHaveBeenCalled();
  });

  test('leaves the latest generation pending while PR teardown is in progress', async () => {
    const { service, build, markObserved, job } = reconciliationWorkerHarness();
    build.status = BuildStatus.TEARING_DOWN;

    await expect(service.processDeploymentReconciliationQueue(job(0))).resolves.toBeUndefined();

    expect((service as any).claimDeploymentRun).not.toHaveBeenCalled();
    expect((service as any).deploymentReconciliationScopes).not.toHaveBeenCalled();
    expect(markObserved).not.toHaveBeenCalled();
  });

  test('retries an intermediate generic reconciliation failure without publishing a terminal error', async () => {
    const { service, failure, recordFailure, markObserved, job } = reconciliationWorkerHarness();

    await expect(service.processDeploymentReconciliationQueue(job(0))).rejects.toBe(failure);

    expect(recordFailure).not.toHaveBeenCalled();
    expect(markObserved).not.toHaveBeenCalled();
  });

  test('publishes and observes one fenced generic failure on the final queue attempt', async () => {
    const { service, failure, build, claim, recordFailure, markObserved, job } = reconciliationWorkerHarness();

    await expect(service.processDeploymentReconciliationQueue(job(9))).resolves.toBeUndefined();

    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(
      build,
      BuildStatus.ERROR,
      claim.token,
      failure,
      'Build queue processing failed.',
      claim.generation
    );
    expect(markObserved).toHaveBeenCalledTimes(1);
    expect(markObserved).toHaveBeenCalledWith(1, claim.generation, claim.token);
  });

  test('rethrows a still-current generic failure that happens before the run becomes active', async () => {
    const { service, failure, loadBuild, recordFailure, markObserved, job } = reconciliationWorkerHarness();
    loadBuild.mockRejectedValueOnce(failure);

    await expect(service.processDeploymentReconciliationQueue(job(0))).rejects.toBe(failure);

    expect(recordFailure).not.toHaveBeenCalled();
    expect(markObserved).not.toHaveBeenCalled();
  });

  test('claims the token to publish and observe a pre-active failure only on its final attempt', async () => {
    const { service, failure, build, claim, withDeploymentLock, loadBuild, recordFailure, markObserved, job } =
      reconciliationWorkerHarness();
    loadBuild.mockRejectedValueOnce(failure);

    await expect(service.processDeploymentReconciliationQueue(job(9))).resolves.toBeUndefined();

    expect(withDeploymentLock).toHaveBeenCalledTimes(2);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(
      build,
      BuildStatus.ERROR,
      claim.token,
      failure,
      'Build queue processing failed.',
      claim.generation
    );
    expect(markObserved).toHaveBeenCalledWith(1, claim.generation, claim.token);
  });

  test('does not mistake an authority-read failure for proof that a failed pass is stale', async () => {
    const { service, failure, isCurrent, recordFailure, markObserved, job } = reconciliationWorkerHarness();
    const authorityError = new Error('authority read unavailable');
    isCurrent.mockRejectedValueOnce(authorityError);

    await expect(service.processDeploymentReconciliationQueue(job(0))).rejects.toBe(authorityError);

    expect(recordFailure).not.toHaveBeenCalled();
    expect(markObserved).not.toHaveBeenCalled();
    expect(failure).not.toBe(authorityError);
  });

  test('never regresses an accepted SHA to a lagging or divergent live branch head', async () => {
    const repositoryQuery: any = {
      findOne: jest.fn(() => repositoryQuery),
      whereNull: jest.fn().mockResolvedValue({ fullName: 'org/service' }),
    };
    const service = new BuildService(
      { models: { Repository: { query: jest.fn(() => repositoryQuery) } } } as any,
      {} as any,
      {} as any,
      queueManager() as any
    );
    (github.getSHAForBranch as jest.Mock).mockResolvedValue('older-head');
    (github.compareCommits as jest.Mock).mockResolvedValue('behind');

    await expect(
      (service as any).resolveCurrentSourceRef({
        githubRepositoryId: 42,
        sourceGithubRepositoryId: 42,
        sourceBranch: 'main',
        sourceRef: 'commit-c',
        sourceBeforeRef: 'commit-b',
      })
    ).resolves.toBe('commit-c');
  });

  test('may advance an accepted SHA only when GitHub proves the live head is its descendant', async () => {
    const repositoryQuery: any = {
      findOne: jest.fn(() => repositoryQuery),
      whereNull: jest.fn().mockResolvedValue({ fullName: 'org/service' }),
    };
    const service = new BuildService(
      { models: { Repository: { query: jest.fn(() => repositoryQuery) } } } as any,
      {} as any,
      {} as any,
      queueManager() as any
    );
    (github.getSHAForBranch as jest.Mock).mockResolvedValue('commit-d');
    (github.compareCommits as jest.Mock).mockResolvedValue('ahead');

    await expect(
      (service as any).resolveCurrentSourceRef({
        githubRepositoryId: 42,
        sourceGithubRepositoryId: 42,
        sourceBranch: 'main',
        sourceRef: 'commit-c',
      })
    ).resolves.toBe('commit-d');
    expect(github.compareCommits).toHaveBeenCalledWith({
      fullName: 'org/service',
      base: 'commit-c',
      head: 'commit-d',
    });
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

describe('BuildService focused changed-line coverage', () => {
  const queueManager = () => ({
    registerQueue: jest.fn(() => ({
      add: jest.fn().mockResolvedValue(undefined),
      process: jest.fn(),
      on: jest.fn(),
    })),
  });

  const serviceWith = (db: Record<string, unknown>) =>
    new BuildService(db as any, {} as any, {} as any, queueManager() as any);

  const deployQuery = (deploys: any[]) => {
    const query: any = {
      where: jest.fn(() => query),
      withGraphFetched: jest.fn().mockResolvedValue(deploys),
    };
    return query;
  };

  beforeEach(() => {
    mockDeployQuery.mockReset();
    mockGetAllConfigs.mockResolvedValue({ serviceAccount: { name: 'builder' } });
  });

  test('uses default pagination when a legacy caller omits pagination', async () => {
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
      page: jest.fn().mockResolvedValue({ results: [], total: 0 }),
    };
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });

    await (service as any).getAllBuilds('', undefined, '', undefined);

    expect(query.page).toHaveBeenCalledWith(0, 25);
  });

  test('executes the deploy graph projection for build detail hydration', async () => {
    const graphSelect = jest.fn();
    const build = { id: 10, uuid: 'detail', deploys: [] };
    const query: any = {
      findOne: jest.fn(() => query),
      whereNull: jest.fn(() => query),
      select: jest.fn(() => query),
      withGraphFetched: jest.fn(() => query),
      modifyGraph: jest.fn((_name: string, callback: (builder: any) => void) => {
        callback({ select: graphSelect });
        return query;
      }),
      then: (resolve: (value: any) => void, reject: (reason: unknown) => void) =>
        Promise.resolve(build).then(resolve, reject),
    };
    const overrideQuery: any = {
      findOne: jest.fn(() => overrideQuery),
      select: jest.fn(() => overrideQuery),
      withGraphFetched: jest.fn(() => overrideQuery),
      then: (resolve: (value: any) => void, reject: (reason: unknown) => void) =>
        Promise.resolve({ ...build, deploys: [] }).then(resolve, reject),
    };
    const service = serviceWith({
      models: { Build: { query: jest.fn().mockReturnValueOnce(query).mockReturnValueOnce(overrideQuery) } },
    });
    mockGetServiceOverrideStates.mockResolvedValueOnce([]);
    mockGetAllConfigs.mockResolvedValueOnce({ domainDefaults: {} });

    await service.getBuildByUUID('detail');

    expect(graphSelect).toHaveBeenCalledWith(
      'id',
      'buildId',
      'uuid',
      'status',
      'statusMessage',
      'active',
      'devMode',
      'cname',
      'deployableId',
      'branchName',
      'deployPipelineId',
      'githubRepositoryId',
      'runUUID',
      'publicUrl',
      'dockerImage',
      'buildLogs',
      'createdAt',
      'updatedAt',
      'sha',
      'initDockerImage',
      'env',
      'initEnv'
    );
    expect(graphSelect).toHaveBeenCalledWith(
      'name',
      'type',
      'dockerfilePath',
      'requires',
      'deploymentDependsOn',
      'dependsOnDeployableName',
      'builder',
      'ecr',
      'grpc',
      'hostPortMapping'
    );
  });

  test('builds every supported image type and ignores inactive and unsupported deploys', async () => {
    const makeDeploy = (uuid: string, type: DeployTypes, active = true) => ({
      id: uuid,
      uuid,
      active,
      deployable: { type },
      $query: jest.fn(() => ({ patchAndFetch: jest.fn().mockResolvedValue(undefined) })),
    });
    const deploys = [
      makeDeploy('docker', DeployTypes.DOCKER),
      makeDeploy('github', DeployTypes.GITHUB),
      makeDeploy('helm', DeployTypes.HELM),
      makeDeploy('external', DeployTypes.EXTERNAL_HTTP),
      makeDeploy('inactive', DeployTypes.DOCKER, false),
    ];
    mockDeployQuery.mockReturnValue(deployQuery(deploys));
    const buildImage = jest.fn().mockResolvedValue(true);
    const mutationQuery: any = {
      patch: jest.fn(() => mutationQuery),
      where: jest.fn().mockResolvedValue(1),
    };
    const service = serviceWith({
      models: { Deploy: { query: jest.fn(() => mutationQuery) } },
      services: { Deploy: { buildImage } },
    });

    await expect(service.buildImages({ id: 4 } as any, 'build-run')).resolves.toBe(true);

    expect(buildImage.mock.calls.map(([deploy]) => deploy.uuid)).toEqual(['docker', 'github', 'helm']);
  });

  test('keeps every static execution lane scoped to the changed repository and branch', async () => {
    const imageQuery = deployQuery([]);
    const cliQuery = deployQuery([]);
    const manifestQuery = deployQuery([]);
    mockDeployQuery.mockReturnValueOnce(imageQuery).mockReturnValueOnce(cliQuery).mockReturnValueOnce(manifestQuery);
    const service = serviceWith({ services: { Deploy: { buildImage: jest.fn(), deployCLI: jest.fn() } } });
    jest.spyOn(service as any, 'isDeploymentRunCurrent').mockResolvedValue(true);
    jest.spyOn(service as any, 'updateDeploysImageDetails').mockResolvedValue(undefined);
    const build = {
      id: 4,
      uuid: 'large-static',
      namespace: 'env-large-static',
      kind: BuildKind.SANDBOX,
      isStatic: true,
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    } as any;

    await service.buildImages(build, 'run-c', 42, 'sha-c', 'main');
    await service.deployCLIServices(build, 'run-c', 42, 'sha-c', 'main');
    await service.generateAndApplyManifests({
      build,
      runUUID: 'run-c',
      expectedGeneration: 3,
      githubRepositoryId: 42,
      sourceBranch: 'main',
      namespace: build.namespace,
    });

    for (const query of [imageQuery, cliQuery, manifestQuery]) {
      expect(query.where).toHaveBeenCalledWith({
        buildId: 4,
        runUUID: 'run-c',
        githubRepositoryId: 42,
        branchName: 'main',
      });
    }
  });

  test('treats a retained targeted scope with no remaining Deploy rows as a successful no-op', async () => {
    mockDeployQuery.mockReturnValue(deployQuery([]));
    const service = serviceWith({ services: { Deploy: { deployCLI: jest.fn() } } });
    const build = { id: 4, $fetchGraph: jest.fn().mockResolvedValue(undefined) };

    await expect(service.deployCLIServices(build as any, 'run-c', 42, 'sha-c', 'main')).resolves.toBe(true);
  });

  test('fails image and CLI processing cleanly for a loaded deploy missing its deployable', async () => {
    const missing = { uuid: 'missing', active: true };
    mockDeployQuery.mockReturnValue(deployQuery([{ uuid: 'inactive', active: false }, missing]));
    const service = serviceWith({ services: { Deploy: { buildImage: jest.fn(), deployCLI: jest.fn() } } });

    await expect(service.buildImages({ id: 4 } as any, 'build-run')).resolves.toBe(false);
    await expect(
      service.deployCLIServices({ id: 4, $fetchGraph: jest.fn().mockResolvedValue(undefined) } as any, 'build-run')
    ).resolves.toBe(false);
  });

  test('deploys only active CLI services and records an individual CLI failure', async () => {
    const cliSuccess = {
      uuid: 'cli-success',
      active: true,
      runUUID: 'run-success',
      deployable: { type: DeployTypes.CODEFRESH },
    };
    const cliFailure = {
      uuid: 'cli-failure',
      active: true,
      runUUID: null,
      deployable: { type: DeployTypes.AURORA_RESTORE },
    };
    const ignored = {
      uuid: 'docker',
      active: true,
      deployable: { type: DeployTypes.DOCKER },
    };
    mockDeployQuery.mockReturnValue(deployQuery([cliSuccess, cliFailure, ignored]));
    const failure = new Error('cli failed');
    const deployCLI = jest.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(failure);
    const recordDeployFailure = jest.fn().mockResolvedValue(false);
    const service = serviceWith({ services: { Deploy: { deployCLI, recordDeployFailure } } });
    const build = { id: 4, runUUID: 'build-run', $fetchGraph: jest.fn().mockResolvedValue(undefined) };

    await expect(service.deployCLIServices(build as any, 'build-run')).resolves.toBe(false);

    expect(deployCLI).toHaveBeenCalledTimes(2);
    expect(recordDeployFailure).toHaveBeenCalledWith(cliFailure, 'build-run', {
      status: DeployStatus.ERROR,
      error: failure,
      fallbackMessage: 'CLI deploy failed.',
    });
  });

  test('filters inactive manifests and rejects a loaded active deploy missing its deployable', async () => {
    mockDeployQuery.mockReturnValue(
      deployQuery([
        { uuid: 'inactive', active: false },
        { uuid: 'missing', active: true },
      ])
    );
    const service = serviceWith({});
    const build = {
      id: 4,
      uuid: 'manifest',
      namespace: 'env-manifest',
      kind: BuildKind.SANDBOX,
      $query: jest.fn(),
    };

    await expect(
      service.generateAndApplyManifests({
        build: build as any,
        githubRepositoryId: null,
        namespace: build.namespace,
      })
    ).rejects.toThrow('Deployable not found for deploy missing');
  });

  test('accepts a loaded active configuration deploy in manifest filtering', async () => {
    const deploy = {
      uuid: 'config',
      active: true,
      deployable: { type: DeployTypes.CONFIGURATION },
      $query: jest.fn(() => ({ patch: jest.fn() })),
    };
    mockDeployQuery.mockReturnValue(deployQuery([deploy]));
    const service = serviceWith({});
    jest.spyOn(service as any, 'updateDeploysImageDetails').mockResolvedValue(undefined);
    const enqueueIngress = jest.spyOn(service as any, 'enqueueIngressManifest').mockResolvedValue(undefined);
    const build = {
      id: 4,
      uuid: 'manifest',
      namespace: 'env-manifest',
      kind: BuildKind.SANDBOX,
      $query: jest.fn(),
    };

    await expect(
      service.generateAndApplyManifests({
        build: build as any,
        githubRepositoryId: null,
        namespace: build.namespace,
      })
    ).resolves.toBe(true);
    expect(enqueueIngress).toHaveBeenCalledWith(4, undefined, undefined);

    enqueueIngress.mockClear();
    await expect(
      service.generateAndApplyManifests({
        build: build as any,
        githubRepositoryId: null,
        namespace: build.namespace,
        enqueueIngress: false,
      })
    ).resolves.toBe(true);
    expect(enqueueIngress).not.toHaveBeenCalled();
  });

  test('covers empty and scoped running-image updates', async () => {
    const service = serviceWith({});
    await expect(
      (service as any).updateDeploysImageDetails({
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        deploys: undefined,
      })
    ).resolves.toBeUndefined();

    const deployUpdate: any = {
      patch: jest.fn(() => deployUpdate),
      where: jest.fn(() => deployUpdate),
      then: (resolve: (value: number) => void, reject: (reason: unknown) => void) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const scopedService = serviceWith({ models: { Deploy: { query: jest.fn(() => deployUpdate) } } });
    await (scopedService as any).updateDeploysImageDetails(
      {
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        deploys: [
          {
            githubRepositoryId: 42,
            branchName: 'main',
            dockerImage: 'image:v1',
            id: 9,
          },
        ],
      },
      'build-run',
      42,
      'main'
    );
    expect(deployUpdate.patch).toHaveBeenCalledWith({ isRunningLatest: true, runningImage: 'image:v1' });
    expect(deployUpdate.where).toHaveBeenCalledWith({ id: 9 });
    expect(deployUpdate.where).toHaveBeenCalledWith('runUUID', 'build-run');
  });

  test('resolves direct build environments and no longer derives them from the repository', async () => {
    const direct = { id: 5 };
    const repositoryQuery: any = {
      withGraphJoined: jest.fn(() => repositoryQuery),
      where: jest.fn().mockResolvedValue([{ id: 6 }]),
    };
    const service = serviceWith({
      models: {
        Environment: {
          findOne: jest.fn().mockResolvedValue(direct),
          find: jest.fn(() => repositoryQuery),
        },
      },
    });

    await expect((service as any).getEnvironmentsToBuild(5)).resolves.toEqual([direct]);

    // The repository-derived lookup joined Environment.services, a relation removed with the
    // legacy DB-config path. It is only reachable when the repository has no defaultEnvId, in
    // which case no environment could match anyway, so the lookup is gone rather than repaired.
    await expect((service as any).getEnvironmentsToBuild(undefined)).resolves.toStrictEqual([]);
    expect(repositoryQuery.withGraphJoined).not.toHaveBeenCalled();
  });

  test('creates missing PR builds with and without a root repository identity', async () => {
    const createHarness = (repositoryId?: number) => {
      const buildQuery: any = {
        where: jest.fn(() => buildQuery),
        whereNull: jest.fn(() => buildQuery),
        first: jest.fn().mockResolvedValue(undefined),
      };
      const repositoryQuery: any = {
        findById: jest.fn(() => repositoryQuery),
        select: jest.fn().mockResolvedValue(repositoryId == null ? undefined : { githubRepositoryId: 42 }),
      };
      const buildCreate = jest.fn(async (attributes: Record<string, unknown>) => ({ id: 77, ...attributes }));
      const service = serviceWith({
        models: {
          Build: { query: jest.fn(() => buildQuery), create: buildCreate },
          Repository: { query: jest.fn(() => repositoryQuery) },
        },
      });
      return { service, buildCreate };
    };
    const environment = { id: 5 };
    const options = {
      pullRequestId: 12,
      repositoryBranchName: 'feature',
      repositoryId: 9,
    };
    const withRepository = createHarness(9);
    const withoutRepository = createHarness();

    await expect(
      (withRepository.service as any).findOrCreateBuild(environment, options, {
        environment: { enabledFeatures: ['x'], githubDeployments: true },
      })
    ).resolves.toMatchObject({ id: 77, githubRepositoryId: 42 });
    expect(withRepository.buildCreate).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepositoryId: 42, githubDeployments: true })
    );

    await expect(
      (withoutRepository.service as any).findOrCreateBuild(
        environment,
        { ...options, repositoryId: undefined },
        undefined
      )
    ).resolves.toMatchObject({ id: 77, githubRepositoryId: null });
    expect(withoutRepository.buildCreate).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepositoryId: null, githubDeployments: false })
    );
  });

  test('serializes current deploy ids and non-null service URLs', async () => {
    const summaryQuery: any = {
      alias: jest.fn(() => summaryQuery),
      select: jest.fn(() => summaryQuery),
      joinRelated: jest.fn(() => summaryQuery),
      whereIn: jest.fn(() => summaryQuery),
      where: jest.fn(() => summaryQuery),
      whereNotNull: jest.fn().mockResolvedValue([
        {
          buildId: 7,
          status: DeployStatus.READY,
          publicUrl: 'app.example.test',
          deployableName: 'app',
          deployableType: DeployTypes.DOCKER,
        },
      ]),
    };
    const service = serviceWith({
      models: { Deploy: { query: jest.fn(() => summaryQuery) } },
    });
    const summaries = await (service as any).resolveEnvironmentServiceSummaries([{ id: 7 }]);
    const serialized = (service as any).serializeEnvironmentSummary(
      {
        id: 7,
        uuid: 'api-env-123456',
        runUUID: 'deploy-run-7',
        status: BuildStatus.DEPLOYED,
        namespace: 'env-api-env-123456',
        triggerType: 'api',
        branchName: 'main',
        githubRepositoryId: 42,
        deployEnabled: true,
        pullRequest: null,
        deploys: [],
      },
      new Map([[42, 'org/repo']]),
      summaries
    );

    expect(serialized).toMatchObject({
      currentDeployId: 'deploy-run-7',
      ready: true,
      phase: 'ready',
    });
  });

  test('produces ingress configurations for host, path, and default port mappings', async () => {
    const hostForDeployableDeploy = jest.fn(() => 'service.example.test');
    const service = serviceWith({ services: { Deploy: { hostForDeployableDeploy } } });
    const deploy = (uuid: string, deployable: Record<string, unknown>) => ({
      uuid,
      active: true,
      deployable: {
        public: true,
        type: DeployTypes.DOCKER,
        port: '8080',
        ...deployable,
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    });
    const host = deploy('host', { hostPortMapping: { admin: '9090' } });
    const path = deploy('path', { pathPortMapping: { '/api': 8081 } });
    const fallback = deploy('fallback', {});
    const build = {
      deploys: [host, path, fallback],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.domainsAndCertificatesForBuild(build as any, true)).resolves.toEqual([
      expect.objectContaining({ host: 'admin-service.example.test', pathPortMapping: { '/': 9090 } }),
      expect.objectContaining({ host: 'service.example.test', pathPortMapping: { '/api': 8081 } }),
      expect.objectContaining({ host: 'service.example.test', pathPortMapping: { '/': 8080 } }),
    ]);
    await expect(
      service.domainsAndCertificatesForBuild(
        { $fetchGraph: jest.fn().mockResolvedValue(undefined), deploys: undefined } as any,
        true
      )
    ).resolves.toEqual([]);
    await expect(service.domainsAndCertificatesForBuild(null as any, true)).resolves.toEqual([]);
  });
});
