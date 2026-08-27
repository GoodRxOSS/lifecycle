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
const mockRepositoryQuery = jest.fn();
const mockGenerateManifest = jest.fn();
const mockGenerateDeployManifest = jest.fn();
const mockApplyManifests = jest.fn();
const mockWaitForPodReady = jest.fn();
const mockDeleteKubernetesBuild = jest.fn();
const mockDeleteNamespace = jest.fn();
const mockDeleteCliBuild = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockIsFeatureEnabled = jest.fn();
const mockQueueAdd = jest.fn();
const mockCleanupDeploy = jest.fn();
const mockDeleteServiceRows = jest.fn();
const mockGetServiceOverrideStates = jest.fn();
const mockGenerateGraph = jest.fn().mockResolvedValue({});
const mockWebhookQueueAdd = jest.fn();
const mockGetYamlFileContent = jest.fn();
const mockResolveEnvironmentServices = jest.fn();
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
    fatal: jest.fn(),
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
    API_ENV_CREATE: 'api_env_create_test',
    API_ENV_EXPIRY: 'api_env_expiry_test',
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
  Repository: {
    query: (...args: any[]) => mockRepositoryQuery(...args),
  },
}));

jest.mock('server/models/yaml', () => {
  const actual = jest.requireActual('server/models/yaml');
  return {
    ...actual,
    resolveEnvironmentServices: (...args: any[]) => mockResolveEnvironmentServices(...args),
  };
});

jest.mock('server/lib/kubernetes', () => ({
  generateManifest: (...args: any[]) => mockGenerateManifest(...args),
  generateDeployManifest: (...args: any[]) => mockGenerateDeployManifest(...args),
  applyManifests: (...args: any[]) => mockApplyManifests(...args),
  waitForPodReady: (...args: any[]) => mockWaitForPodReady(...args),
  createOrUpdateNamespace: jest.fn(),
  deleteBuild: (...args: any[]) => mockDeleteKubernetesBuild(...args),
  deleteNamespace: (...args: any[]) => mockDeleteNamespace(...args),
}));

jest.mock('server/lib/cli', () => ({
  deleteBuild: (...args: any[]) => mockDeleteCliBuild(...args),
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
  getYamlFileContent: (...args: any[]) => mockGetYamlFileContent(...args),
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
    webhookQueue: { add: (...args: any[]) => mockWebhookQueueAdd(...args) },
  })),
}));

jest.mock('server/services/override', () => ({
  __esModule: true,
  isBranchOrExternalUrlEditable: (type?: string) => ['github', 'helm', 'externalHTTP'].includes(type ?? ''),
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
import { ingressBannerSnippet } from 'server/lib/helm/utils';
import { ParsingError, YamlConfigParser } from 'server/lib/yamlConfigParser';
import { ValidationError, YamlConfigValidator } from 'server/lib/yamlConfigValidator';
import { DeploymentManager, DeploymentSupersededError } from 'server/lib/deploymentManager/deploymentManager';
import { UniqueViolationError } from 'objection';
import AgentPrewarmService from 'server/services/agentPrewarm';
import { AuthorityLockLostError } from 'server/lib/authorityLock';
import { LifecycleError } from 'server/lib/errors';

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
      whereRaw: jest.fn(() => query),
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

  test('never reaps a service whose YAML could not be resolved', async () => {
    createService(
      [
        { id: 1, name: 'unreadable-dep', resolvedFromRepositoryId: targetRepoId },
        { id: 3, name: 'worker-old', resolvedFromRepositoryId: targetRepoId },
      ],
      [{ id: 78, uuid: 'worker-old-build-1', deployableId: 3 }]
    );
    const build = createBuild();

    await (buildService as any).reconcileDeletedDeployables(build, {
      canReconcile: true,
      deployables: [],
      unresolvedServiceNames: ['unreadable-dep'],
      unresolvedRepositoryIds: [],
      reconcileEligibleDeployables: [
        { name: 'worker-new', source: 'yaml', reconcileEligible: true, resolvedFromRepositoryId: targetRepoId },
      ],
    });

    // 'unreadable-dep' is absent from the expected set only because its config could not be read.
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [3] });
  });

  test('never reaps deployables owned by a repository whose YAML could not be read', async () => {
    createService(
      [
        { id: 5, name: 'dep-child', resolvedFromRepositoryId: otherRepoId },
        { id: 3, name: 'worker-old', resolvedFromRepositoryId: targetRepoId },
      ],
      [{ id: 78, uuid: 'worker-old-build-1', deployableId: 3 }]
    );
    const build = createBuild();

    await (buildService as any).reconcileDeletedDeployables(build, {
      canReconcile: true,
      deployables: [],
      unresolvedServiceNames: [],
      unresolvedRepositoryIds: [otherRepoId],
      reconcileEligibleDeployables: [
        { name: 'worker-new', source: 'yaml', reconcileEligible: true, resolvedFromRepositoryId: targetRepoId },
      ],
    });

    // 'requires:' children of an unreadable repository are never enumerated, so they must be protected.
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [3] });
  });

  test('an unresolved dependency no longer blocks reaping the rest of the environment', async () => {
    const staleDeploy = { id: 78, uuid: 'worker-old-build-1', deployableId: 3 };
    createService([{ id: 3, name: 'worker-old', resolvedFromRepositoryId: targetRepoId }], [staleDeploy]);
    const build = createBuild();

    await (buildService as any).reconcileDeletedDeployables(build, {
      canReconcile: true,
      deployables: [],
      unresolvedServiceNames: ['unrelated-archived-dep'],
      unresolvedRepositoryIds: [otherRepoId],
      reconcileEligibleDeployables: [
        { name: 'worker-new', source: 'yaml', reconcileEligible: true, resolvedFromRepositoryId: targetRepoId },
      ],
    });

    expect(mockCleanupDeploy).toHaveBeenCalledWith(staleDeploy, { mode: 'service' });
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [3] });
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

  test('does not let an ineligible reconciliation candidate mask a stale YAML-owned service', async () => {
    createService([{ id: 1, name: 'old-api' }], [{ id: 77, uuid: 'old-api-build-1', deployableId: 1 }]);
    mockCleanupDeploy.mockResolvedValue(true);

    await (buildService as any).reconcileDeletedDeployables(createBuild(), {
      canReconcile: true,
      deployables: [],
      reconcileEligibleDeployables: [
        { id: 1, name: 'old-api', reconcileEligible: false, source: 'yaml' },
        { id: 2, name: 'manual-api', reconcileEligible: true, source: 'manual' },
      ],
    });

    expect(mockCleanupDeploy).toHaveBeenCalledTimes(1);
    expect(mockDeleteServiceRows).toHaveBeenCalledWith({ buildId: 10, deployableIds: [1] });
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
      .mockImplementation(async (_buildId, isCurrent, action) => {
        expect(await isCurrent()).toBe(true);
        return { admitted: true, value: await action() };
      });
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
      .mockImplementation(async (...args: any[]) => (args[2] as () => Promise<unknown>)());
    const claimReconciliation = jest.spyOn(service as any, 'claimDeploymentReconciliation').mockResolvedValue(claim);
    const withDeploymentLock = jest
      .spyOn(service as any, 'withCurrentBuildDeploymentLock')
      .mockImplementation(async (...args: any[]) => {
        const isCurrent = args[1] as () => Promise<boolean>;
        const action = args[2] as () => Promise<unknown>;
        expect(await isCurrent()).toBe(true);
        return { admitted: true, value: await action() };
      });
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

  test('uses the legacy trigger ref as the immutable source when a tracked push omits sourceRef', async () => {
    const { service } = serviceHarness();

    await service.enqueueResolveAndDeployBuild({
      buildId: 1,
      githubRepositoryId: 100,
      triggerRef: 'legacy-delivered-sha',
      sourceGithubRepositoryId: 100,
      sourceBranch: 'main',
      runUUID: 'legacy-request',
    });

    expect(mockAcceptDeploymentIntent).toHaveBeenCalledWith(1, {
      type: 'source',
      requestId: 'legacy-request',
      target: 'repository',
      githubRepositoryId: 100,
      branch: 'main',
      sha: 'legacy-delivered-sha',
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

  test('rejects accepted work when the build disappeared at the mailbox boundary', async () => {
    const { service, add } = serviceHarness();
    mockAcceptDeploymentIntent.mockResolvedValueOnce(null);

    await expect(service.enqueueResolveAndDeployBuild({ buildId: 1 })).rejects.toThrow(
      'Build 1 was not found while accepting deployment work'
    );

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
    const lock = jest.fn(async (_resource: string) => ({
      unlock: jest.fn().mockResolvedValue(undefined),
      extend: jest.fn(),
    }));
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

  test('retries a still-current authority-lock loss without publishing terminal failure', async () => {
    const { service, recordFailure, markObserved, job } = reconciliationWorkerHarness();
    const lockError = new AuthorityLockLostError('build-deployment.1');
    jest.spyOn(service as any, 'deploymentReconciliationScopes').mockImplementation(() => {
      throw lockError;
    });

    await expect(service.processDeploymentReconciliationQueue(job(0))).rejects.toBe(lockError);

    expect(recordFailure).not.toHaveBeenCalled();
    expect(markObserved).not.toHaveBeenCalled();
  });

  test('ignores a reconciliation failure after generation authority has moved on', async () => {
    const { service, recordFailure, markObserved, isCurrent, job } = reconciliationWorkerHarness();
    isCurrent.mockResolvedValue(false);

    await expect(service.processDeploymentReconciliationQueue(job(0))).resolves.toBeUndefined();

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

  test('rethrows a still-current final failure when its terminal write cannot be confirmed', async () => {
    const { service, failure, job } = reconciliationWorkerHarness();
    jest.spyOn(service as any, 'recordFinalDeploymentReconciliationFailure').mockResolvedValue(false);

    await expect(service.processDeploymentReconciliationQueue(job(9))).rejects.toBe(failure);
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

  test('deployment scope fails closed when an execution error cannot be fenced by an authority read', async () => {
    const executionError = new Error('image builder unavailable');
    const authorityError = new Error('build authority unavailable');
    const buildQuery: any = {
      findById: jest.fn(() => buildQuery),
      select: jest.fn().mockRejectedValue(authorityError),
    };
    const service = new BuildService(
      { models: { Build: { query: jest.fn(() => buildQuery) } } } as any,
      {} as any,
      {} as any,
      queueManager() as any
    );
    const build = createBuild({ id: 1, runUUID: 'run-current', namespace: 'env-sample' });
    jest.spyOn(service, 'buildImages').mockRejectedValue(executionError);
    jest.spyOn(service, 'deployCLIServices').mockResolvedValue(true);
    const updateStatus = jest.spyOn(service as any, 'updateStatusAndComment').mockResolvedValue(undefined);
    const applyManifests = jest.spyOn(service as any, 'generateAndApplyManifests').mockResolvedValue(true);

    await expect(
      (service as any).executeDeploymentScope(
        {
          build,
          runUUID: 'run-current',
          githubRepositoryId: 100,
          sourceGithubRepositoryId: 100,
          sourceRef: 'commit-a',
          sourceBranch: 'main',
        },
        7
      )
    ).resolves.toBeNull();

    expect(buildQuery.select).toHaveBeenCalledWith(
      'id',
      'runUUID',
      'status',
      'deployEnabled',
      'deletedAt',
      'pullRequestId',
      'desiredGeneration'
    );
    expect(updateStatus).not.toHaveBeenCalled();
    expect(applyManifests).not.toHaveBeenCalled();
    expect(executionError).not.toBe(authorityError);
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

  it('digests environment and rollout options independently while normalizing an omitted service activity', () => {
    const base = {
      repositoryFullName: 'org/repo',
      branch: 'main',
      services: [{ name: 'api' }],
    };
    const baseDigest = computeIdempotencyRequestDigest(base);

    expect(computeIdempotencyRequestDigest({ ...base, services: [{ name: 'api', active: undefined }] })).toBe(
      baseDigest
    );
    expect(computeIdempotencyRequestDigest({ ...base, environmentId: 17 })).not.toBe(baseDigest);
    expect(computeIdempotencyRequestDigest({ ...base, deployEnabled: false })).not.toBe(baseDigest);
    expect(computeIdempotencyRequestDigest({ ...base, trackDefaultBranches: true })).not.toBe(baseDigest);
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
    mockRepositoryQuery.mockReset();
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

  test('resolves direct and repository-derived build environments', async () => {
    const direct = { id: 5 };
    const related = [{ id: 6 }];
    const repositoryQuery: any = {
      withGraphJoined: jest.fn(() => repositoryQuery),
      where: jest.fn().mockResolvedValue(related),
    };
    const service = serviceWith({
      models: {
        Environment: {
          findOne: jest.fn().mockResolvedValue(direct),
          find: jest.fn(() => repositoryQuery),
        },
      },
    });

    await expect((service as any).getEnvironmentsToBuild(5, 9)).resolves.toEqual([direct]);
    await expect((service as any).getEnvironmentsToBuild(undefined, 9)).resolves.toEqual(related);
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

describe('BuildService uncovered public behavior', () => {
  const mockedGetLogger = jest.requireMock('server/lib/logger').getLogger as jest.Mock;
  const defaultGetLoggerImplementation = mockedGetLogger.getMockImplementation();

  const queueManager = () => ({
    registerQueue: jest.fn(() => ({
      add: mockQueueAdd,
      process: jest.fn(),
      on: jest.fn(),
    })),
  });

  const serviceWith = (db: Record<string, any>, redlock: Record<string, any> = {}) =>
    new BuildService(db as any, {} as any, redlock as any, queueManager() as any);

  const lookupQuery = <T>(result: T) => {
    const query: any = {
      select: jest.fn(() => query),
      findOne: jest.fn(() => query),
      findById: jest.fn(() => query),
      where: jest.fn(() => query),
      whereRaw: jest.fn(() => query),
      whereNull: jest.fn(() => query),
      whereNot: jest.fn(() => query),
      whereNotIn: jest.fn(() => query),
      whereNotNull: jest.fn(() => query),
      whereIn: jest.fn(() => query),
      withGraphFetched: jest.fn(() => query),
      modifyGraph: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      limit: jest.fn(() => query),
      then: (resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return query;
  };

  const capturingLogger = () => {
    const logger = {
      error: jest.fn(),
      fatal: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };
    mockedGetLogger.mockReturnValue(logger);
    return logger;
  };

  const contendedAuthorityRedlock = (waitError: Error) => {
    const acquiredLock = {
      extend: jest.fn(),
      unlock: jest.fn().mockResolvedValue(undefined),
    };
    const lockWithOptions = jest
      .fn()
      .mockImplementationOnce(async () => {
        jest.setSystemTime(60_000);
        throw waitError;
      })
      .mockResolvedValue(acquiredLock);
    return {
      acquiredLock,
      lockWithOptions,
      redlock: { lock: jest.fn(), lockWithOptions },
    };
  };

  const publicReconciliationHarness = (
    options: {
      intent?: Record<string, unknown>;
      repository?: { fullName: string } | null;
      mailboxResult?: (read: number, build: any) => any;
      loadResult?: (read: number, build: any) => any;
      authorityResult?: (read: number, build: any) => any;
      onYamlImported?: (build: any) => void;
      onDeploysAssociated?: (build: any) => void;
      onGraphGenerated?: (build: any) => void;
      yamlFailure?: unknown;
      onLockAcquired?: (resource: string, build: any) => void;
      deploys?: any[];
    } = {}
  ) => {
    const intent =
      options.intent ?? ({ type: 'all', requestId: 'run-generation-3', gen: 3 } as Record<string, unknown>);
    const scopeKey = intent.type === 'source' ? 'source:42:main' : 'all';
    const build: any = {
      id: 7,
      uuid: 'stateful-reconciliation',
      namespace: 'env-stateful-reconciliation',
      kind: BuildKind.SANDBOX,
      status: BuildStatus.DEPLOYED,
      statusMessage: '',
      runUUID: 'prior-run',
      deployEnabled: true,
      deletedAt: null,
      pullRequestId: null,
      pullRequest: null,
      environment: { id: 5 },
      githubRepositoryId: 42,
      branchName: 'main',
      desiredGeneration: 3,
      observedGeneration: 2,
      acceptedRefs: { [scopeKey]: intent },
      deploys: [],
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $setRelated: jest.fn((_relation: string, related: any[]) => {
        build.deploys = related;
      }),
    };
    let mailboxReads = 0;
    let loadReads = 0;
    let authorityReads = 0;
    const buildPatch = jest.fn();
    const mutationFor = (value: Record<string, unknown>) => {
      const mutation: any = {
        where: jest.fn(() => mutation),
        whereNull: jest.fn(() => mutation),
        whereNotIn: jest.fn(() => mutation),
        then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) => {
          buildPatch(value);
          Object.assign(build, value);
          return Promise.resolve(1).then(resolve, reject);
        },
      };
      return mutation;
    };
    const BuildModel = {
      query: jest.fn(() => {
        let lookup: 'id' | 'one' | null = null;
        let projectedAuthority = false;
        const query: any = {
          findById: jest.fn(() => {
            lookup = 'id';
            return query;
          }),
          findOne: jest.fn(() => {
            lookup = 'one';
            return query;
          }),
          select: jest.fn(() => {
            projectedAuthority = true;
            return query;
          }),
          where: jest.fn(() => query),
          whereNull: jest.fn(() => query),
          patch: jest.fn((value: Record<string, unknown>) => mutationFor(value)),
          then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) => {
            let result: any = build;
            if (projectedAuthority) {
              authorityReads += 1;
              result = options.authorityResult ? options.authorityResult(authorityReads, build) : build;
            } else if (lookup === 'one') {
              loadReads += 1;
              result = options.loadResult ? options.loadResult(loadReads, build) : build;
            } else if (lookup === 'id') {
              mailboxReads += 1;
              result = options.mailboxResult ? options.mailboxResult(mailboxReads, build) : build;
            }
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return query;
      }),
    };
    const deployMutation: any = {
      patch: jest.fn(() => deployMutation),
      where: jest.fn(() => deployMutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const importedDeployQuery: any = {
      where: jest.fn(() => importedDeployQuery),
      withGraphFetched: jest.fn().mockResolvedValue([]),
    };
    mockDeployQuery.mockReturnValue(importedDeployQuery);
    const upsertDeployables = jest.fn(async () => {
      if ('yamlFailure' in options) throw options.yamlFailure;
      return { canReconcile: false };
    });
    const upsertWebhooksWithYaml = jest.fn(async () => {
      options.onYamlImported?.(build);
    });
    const findOrCreateDeploys = jest.fn(async () => {
      options.onDeploysAssociated?.(build);
      return options.deploys ?? [];
    });
    if (options.onGraphGenerated) {
      mockGenerateGraph.mockImplementation(async () => {
        options.onGraphGenerated?.(build);
        return {};
      });
    }
    const repositoryQuery: any = {
      findOne: jest.fn(() => repositoryQuery),
      whereNull: jest.fn().mockResolvedValue(options.repository ?? null),
    };
    const redlock = options.onLockAcquired
      ? {
          lock: jest.fn(async (resource: string) => {
            options.onLockAcquired?.(resource, build);
            return { extend: jest.fn(), unlock: jest.fn().mockResolvedValue(undefined) };
          }),
        }
      : {};
    const service = serviceWith(
      {
        models: {
          Build: BuildModel,
          Deploy: { query: jest.fn(() => deployMutation) },
          Repository: { query: jest.fn(() => repositoryQuery) },
        },
        services: {
          Deployable: { upsertDeployables },
          Deploy: { findOrCreateDeploys },
          Webhook: {
            upsertWebhooksWithYaml,
            webhookQueue: { add: jest.fn().mockResolvedValue(undefined) },
          },
        },
      },
      redlock
    );
    const job = {
      data: { buildId: 7, generation: 3 },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any;
    return {
      service,
      job,
      build,
      buildPatch,
      upsertDeployables,
      upsertWebhooksWithYaml,
      findOrCreateDeploys,
      repositoryQuery,
      deployMutation,
      redlock,
      reads: () => ({ mailboxReads, loadReads, authorityReads }),
    };
  };

  const passOneContentionRetry = async (lockWithOptions: jest.Mock) => {
    for (let iteration = 0; iteration < 25 && lockWithOptions.mock.calls.length === 0; iteration += 1) {
      await Promise.resolve();
    }
    expect(lockWithOptions).toHaveBeenCalledTimes(1);
    await (jest as any).advanceTimersByTimeAsync(250);
  };

  beforeEach(() => {
    mockDeployQuery.mockReset();
    mockRepositoryQuery.mockReset();
    mockQueueAdd.mockReset().mockResolvedValue(undefined);
    mockWebhookQueueAdd.mockReset().mockResolvedValue(undefined);
    mockAcceptDeploymentIntent.mockReset().mockResolvedValue({
      accepted: true,
      generation: 1,
      scopeKey: 'all',
    });
    mockGetAllConfigs.mockReset().mockResolvedValue({ serviceAccount: { name: 'builder' } });
    mockIsFeatureEnabled.mockReset().mockResolvedValue(false);
    mockGenerateGraph.mockReset().mockResolvedValue({});
    mockGetYamlFileContent.mockReset();
    mockResolveEnvironmentServices.mockReset();
    (github.getSHAForBranch as jest.Mock).mockReset();
    (github.compareCommits as jest.Mock).mockReset();
    mockGenerateManifest.mockReset();
    mockGenerateDeployManifest.mockReset();
    mockDeleteKubernetesBuild.mockReset().mockResolvedValue(undefined);
    mockDeleteNamespace.mockReset().mockResolvedValue(undefined);
    mockDeleteCliBuild.mockReset().mockResolvedValue(undefined);
    (github.getYamlFileContentFromBranch as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (defaultGetLoggerImplementation) {
      mockedGetLogger.mockImplementation(defaultGetLoggerImplementation);
    } else {
      mockedGetLogger.mockReset();
    }
  });

  test('cleanupBuilds queues only closed or explicitly disabled pull-request environments and continues after failure', async () => {
    const closed = {
      id: 1,
      pullRequest: { status: 'closed', deployOnUpdate: true, repository: { id: 11 } },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const disabled = {
      id: 2,
      pullRequest: { status: 'open', deployOnUpdate: false, repository: { id: 12 } },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const active = {
      id: 3,
      pullRequest: { status: 'open', deployOnUpdate: true, repository: { id: 13 } },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const repositoryMissing = {
      id: 4,
      pullRequest: { status: 'closed', deployOnUpdate: false, repository: null },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const unreadable = {
      id: 5,
      pullRequest: null,
      $fetchGraph: jest.fn().mockRejectedValue(new Error('relation load failed')),
    };
    const lifecycleEnabledForPullRequest = jest.fn(async (pullRequest) => pullRequest !== disabled.pullRequest);
    const enqueueBuildDeletion = jest
      .fn()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValueOnce(undefined);
    const service = serviceWith({
      services: {
        PullRequest: { lifecycleEnabledForPullRequest },
        BuildService: { enqueueBuildDeletion },
      },
    });
    jest
      .spyOn(service, 'activeBuilds')
      .mockResolvedValue([closed, disabled, active, repositoryMissing, unreadable] as any);

    await expect(service.cleanupBuilds()).resolves.toBeUndefined();

    expect(enqueueBuildDeletion).toHaveBeenCalledTimes(2);
    expect(enqueueBuildDeletion).toHaveBeenNthCalledWith(1, closed, 'pull_request_inactive_sweep');
    expect(enqueueBuildDeletion).toHaveBeenNthCalledWith(2, disabled, 'pull_request_inactive_sweep');
    expect(lifecycleEnabledForPullRequest).not.toHaveBeenCalledWith(repositoryMissing.pullRequest);
  });

  test('cleanupBuilds ignores a non-PR environment after loading its authority graph', async () => {
    const build = {
      id: 7,
      pullRequest: null,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const lifecycleEnabledForPullRequest = jest.fn();
    const enqueueBuildDeletion = jest.fn();
    const service = serviceWith({
      services: {
        PullRequest: { lifecycleEnabledForPullRequest },
        BuildService: { enqueueBuildDeletion },
      },
    });
    jest.spyOn(service, 'activeBuilds').mockResolvedValue([build] as any);

    await expect(service.cleanupBuilds()).resolves.toBeUndefined();

    expect(build.$fetchGraph).toHaveBeenCalledWith('pullRequest.[repository]');
    expect(lifecycleEnabledForPullRequest).not.toHaveBeenCalled();
    expect(enqueueBuildDeletion).not.toHaveBeenCalled();
  });

  test('activeBuilds applies the environment and live-status scope before graph hydration', async () => {
    const builds = [{ id: 1 }, { id: 2 }];
    const query = lookupQuery(builds);
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });

    await expect(service.activeBuilds()).resolves.toBe(builds);

    expect(query.where).toHaveBeenCalledWith('kind', BuildKind.ENVIRONMENT);
    expect(query.whereNot).toHaveBeenCalledWith('status', 'torn_down');
    expect(query.whereNot).toHaveBeenCalledWith('status', 'pending');
    expect(query.withGraphFetched).toHaveBeenCalledWith('deploys.[deployable.[repository]]');
  });

  test('getAllBuilds applies author and normalized search predicates and projects every response graph', async () => {
    const build = { id: 7, uuid: 'matching-build' };
    const searchPredicate: any = {
      orWhereRaw: jest.fn().mockReturnThis(),
      orWhereExists: jest.fn().mockReturnThis(),
    };
    const pullRequestPredicate: any = {
      where: jest.fn().mockImplementation(function (this: any, arg: any) {
        if (typeof arg === 'function') arg(this);
        return this;
      }),
      whereRaw: jest.fn().mockReturnThis(),
      orWhereRaw: jest.fn().mockReturnThis(),
    };
    const graphSelect = jest.fn();
    const query: any = {
      select: jest.fn(() => query),
      where: jest.fn().mockImplementation((arg: any) => {
        if (typeof arg === 'function') arg(searchPredicate);
        return query;
      }),
      whereExists: jest.fn(() => query),
      whereNotIn: jest.fn(() => query),
      modify: jest.fn((callback: (builder: any) => void) => {
        callback(query);
        return query;
      }),
      withGraphFetched: jest.fn(() => query),
      modifyGraph: jest.fn((_path: string, callback: (builder: any) => void) => {
        callback({ select: graphSelect });
        return query;
      }),
      orderBy: jest.fn(() => query),
      page: jest.fn().mockResolvedValue({ results: [build], total: 1 }),
    };
    const BuildModel = {
      query: jest.fn(() => query),
      relatedQuery: jest.fn(() => pullRequestPredicate),
    };
    const service = serviceWith({ models: { Build: BuildModel } });

    await expect(
      service.getAllBuilds('pending, error', 'alice', '  Feature ', { page: 2, limit: 10 })
    ).resolves.toMatchObject({ data: [build] });

    expect(query.whereNotIn).toHaveBeenCalledWith('status', ['pending', 'error']);
    expect(query.whereExists).toHaveBeenCalledWith(pullRequestPredicate);
    expect(pullRequestPredicate.where).toHaveBeenCalledWith('githubLogin', 'alice');
    expect(searchPredicate.orWhereRaw).toHaveBeenCalledWith('LOWER("uuid") LIKE ?', ['%feature%']);
    expect(searchPredicate.orWhereRaw).toHaveBeenCalledWith('LOWER("namespace") LIKE ?', ['%feature%']);
    expect(pullRequestPredicate.whereRaw).toHaveBeenCalledWith('LOWER("title") LIKE ?', ['%feature%']);
    expect(pullRequestPredicate.orWhereRaw).toHaveBeenCalledWith('LOWER("fullName") LIKE ?', ['%feature%']);
    expect(pullRequestPredicate.orWhereRaw).toHaveBeenCalledWith('LOWER("githubLogin") LIKE ?', ['%feature%']);
    expect(graphSelect).toHaveBeenCalled();
    expect(query.page).toHaveBeenCalledWith(1, 10);
  });

  test('getAllBuilds omits search predicates when the optional search term is absent', async () => {
    const searchPredicate = { orWhereRaw: jest.fn(), orWhereExists: jest.fn() };
    const query: any = {
      select: jest.fn(() => query),
      where: jest.fn().mockImplementation((arg: any) => {
        if (typeof arg === 'function') arg(searchPredicate);
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
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });

    await expect(service.getAllBuilds('', undefined, undefined)).resolves.toMatchObject({ data: [] });

    expect(searchPredicate.orWhereRaw).not.toHaveBeenCalled();
    expect(searchPredicate.orWhereExists).not.toHaveBeenCalled();
    expect(query.page).toHaveBeenCalledWith(0, 25);
  });

  test('listEnvironments applies trigger, token, negative-readiness, and human ownership filters before paging', async () => {
    const ownerPredicate: any = {
      orWhere: jest.fn().mockReturnThis(),
      orWhereExists: jest.fn().mockReturnThis(),
    };
    const readyQuery: any = {
      select: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      whereColumn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
    };
    const pullRequestQuery: any = { where: jest.fn().mockReturnThis() };
    const graphSelect = jest.fn();
    const query: any = {
      select: jest.fn(() => query),
      where: jest.fn().mockImplementation((...args: any[]) => {
        if (typeof args[0] === 'function') args[0](ownerPredicate);
        return query;
      }),
      whereNull: jest.fn(() => query),
      whereNotIn: jest.fn(() => query),
      whereNotExists: jest.fn(() => query),
      modify: jest.fn((callback: (builder: any) => void) => {
        callback(query);
        return query;
      }),
      withGraphFetched: jest.fn(() => query),
      modifyGraph: jest.fn((_path: string, callback: (builder: any) => void) => {
        callback({ select: graphSelect });
        return query;
      }),
      orderBy: jest.fn(() => query),
      page: jest.fn().mockResolvedValue({ results: [], total: 0 }),
    };
    const service = serviceWith({
      models: {
        Build: { query: jest.fn(() => query), relatedQuery: jest.fn(() => pullRequestQuery) },
        Deploy: { query: jest.fn(() => readyQuery) },
      },
    });

    await service.listEnvironments({
      trigger: 'api',
      createdByTokenId: 9,
      hasReadyActiveService: false,
      ownerUserId: 'user-1',
      githubLogin: 'alice',
      pagination: { page: 0, limit: Number.NaN },
    });

    expect(query.where).toHaveBeenCalledWith('builds.triggerType', 'api');
    expect(query.where).toHaveBeenCalledWith('builds.createdByTokenId', 9);
    expect(query.whereNotExists).toHaveBeenCalledWith(readyQuery);
    expect(ownerPredicate.orWhere).toHaveBeenCalledWith('builds.createdByUserId', 'user-1');
    expect(ownerPredicate.orWhereExists).toHaveBeenCalledWith(pullRequestQuery);
    expect(pullRequestQuery.where).toHaveBeenCalledWith('githubLogin', 'alice');
    expect(query.page).toHaveBeenCalledWith(0, 25);
    expect(graphSelect).toHaveBeenCalled();
  });

  test('listEnvironments can scope a PR-only human and include ready-service rows', async () => {
    const readyQuery: any = {
      select: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      whereColumn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
    };
    const pullRequestQuery: any = { where: jest.fn().mockReturnThis() };
    const query: any = {
      select: jest.fn(() => query),
      where: jest.fn(() => query),
      whereNull: jest.fn(() => query),
      whereNotIn: jest.fn(() => query),
      whereExists: jest.fn(() => query),
      modify: jest.fn((callback: (builder: any) => void) => {
        callback(query);
        return query;
      }),
      withGraphFetched: jest.fn(() => query),
      modifyGraph: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      page: jest.fn().mockResolvedValue({ results: [], total: 0 }),
    };
    const service = serviceWith({
      models: {
        Build: { query: jest.fn(() => query), relatedQuery: jest.fn(() => pullRequestQuery) },
        Deploy: { query: jest.fn(() => readyQuery) },
      },
    });

    await service.listEnvironments({ githubLogin: 'alice', hasReadyActiveService: true });

    expect(query.whereExists).toHaveBeenCalledWith(pullRequestQuery);
    expect(query.whereExists).toHaveBeenCalledWith(readyQuery);
  });

  test('listEnvironments preserves explicit status, tracking, and human-owner fields', async () => {
    const build = {
      id: 7,
      uuid: 'explicit-summary',
      status: BuildStatus.ERROR,
      statusMessage: 'deployment failed',
      namespace: 'env-explicit-summary',
      deployEnabled: true,
      autoTrack: true,
      createdByGithubLogin: 'api-owner',
      createdByUserId: 'user-7',
      pullRequest: null,
      githubRepositoryId: null,
    };
    const buildQuery: any = {
      select: jest.fn(() => buildQuery),
      where: jest.fn(() => buildQuery),
      whereNull: jest.fn(() => buildQuery),
      whereNotIn: jest.fn(() => buildQuery),
      modify: jest.fn((callback: (builder: any) => void) => {
        callback(buildQuery);
        return buildQuery;
      }),
      withGraphFetched: jest.fn(() => buildQuery),
      modifyGraph: jest.fn(() => buildQuery),
      orderBy: jest.fn(() => buildQuery),
      page: jest.fn().mockResolvedValue({ results: [build], total: 1 }),
    };
    const summaryQuery: any = {
      alias: jest.fn(() => summaryQuery),
      select: jest.fn(() => summaryQuery),
      joinRelated: jest.fn(() => summaryQuery),
      whereIn: jest.fn(() => summaryQuery),
      where: jest.fn(() => summaryQuery),
      whereNotNull: jest.fn().mockResolvedValue([]),
    };
    const service = serviceWith({
      models: {
        Build: { query: jest.fn(() => buildQuery) },
        Deploy: { query: jest.fn(() => summaryQuery) },
      },
    });

    await expect(service.listEnvironments({})).resolves.toMatchObject({
      data: [
        expect.objectContaining({
          statusMessage: 'deployment failed',
          autoTrack: true,
          author: 'api-owner',
          createdByUserId: 'user-7',
        }),
      ],
    });
  });

  test('getEnvironmentDetail returns null without performing detail enrichment when the build is gone', async () => {
    const service = serviceWith({});
    jest.spyOn(service, 'getBuildByUUID').mockResolvedValue(null);

    await expect(service.getEnvironmentDetail('missing', 42)).resolves.toBeNull();
    expect(service.getBuildByUUID).toHaveBeenCalledWith('missing', { liveOnly: true, expectedBuildId: 42 });
  });

  test('getEnvironmentDetail exposes stable defaults for a sparse API environment and service', async () => {
    const build: any = {
      id: 7,
      uuid: 'sparse-api-env',
      status: BuildStatus.PENDING,
      namespace: 'env-sparse-api-env',
      deployEnabled: false,
      pullRequest: null,
      githubRepositoryId: null,
      deploys: [
        {
          active: true,
          status: DeployStatus.PENDING,
          deployable: null,
        },
      ],
    };
    const service = serviceWith({});
    jest.spyOn(service, 'getBuildByUUID').mockResolvedValue(build);

    await expect(service.getEnvironmentDetail('sparse-api-env')).resolves.toMatchObject({
      uuid: 'sparse-api-env',
      status: BuildStatus.PENDING,
      statusMessage: null,
      trigger: 'github_pr',
      repository: null,
      isStatic: false,
      deployEnabled: false,
      autoTrack: false,
      activeServiceCount: 0,
      hasReadyActiveService: false,
      ready: false,
      currentDeployId: null,
      author: null,
      createdByUserId: null,
      pullRequest: null,
      configSha: null,
      trackDefaultBranches: false,
      services: [
        {
          name: null,
          status: DeployStatus.PENDING,
          statusMessage: null,
          active: true,
          branch: null,
          publicUrl: null,
          publicHref: null,
          sha: null,
        },
      ],
      statusUrl: '/api/v2/environments/sparse-api-env',
    });
  });

  test('getEnvironmentDetail preserves PR repository, tracking, and service failure details', async () => {
    const build: any = {
      id: 7,
      uuid: 'pr-detail',
      status: BuildStatus.ERROR,
      statusMessage: 'build failed',
      namespace: 'env-pr-detail',
      deployEnabled: true,
      trackDefaultBranches: true,
      pullRequest: {
        fullName: 'org/repo',
        githubLogin: 'alice',
        pullRequestNumber: 42,
        title: 'Feature',
        status: 'open',
      },
      deploys: [
        {
          active: true,
          status: DeployStatus.ERROR,
          statusMessage: 'image failed',
          deployable: { name: 'api', type: DeployTypes.DOCKER },
        },
      ],
    };
    const service = serviceWith({});
    jest.spyOn(service, 'getBuildByUUID').mockResolvedValue(build);

    await expect(service.getEnvironmentDetail('pr-detail')).resolves.toMatchObject({
      repository: 'org/repo',
      trackDefaultBranches: true,
      author: 'alice',
      services: [expect.objectContaining({ name: 'api', statusMessage: 'image failed' })],
    });
    expect(mockRepositoryQuery).not.toHaveBeenCalled();
  });

  test('getBuildByUUID returns a missing deployable relation with a null override state', async () => {
    const detailDeploy: any = { id: 11, uuid: 'orphaned-relation', deployable: null };
    const snapshotDeploy: any = { id: 11, uuid: 'orphaned-relation', deployable: null };
    const build: any = { id: 7, uuid: 'relation-race', deploys: [detailDeploy] };
    const detailQuery = lookupQuery(build);
    const snapshotQuery = lookupQuery({ id: 7, uuid: 'relation-race', environmentId: 5, deploys: [snapshotDeploy] });
    const service = serviceWith({
      models: { Build: { query: jest.fn().mockReturnValueOnce(detailQuery).mockReturnValueOnce(snapshotQuery) } },
    });
    mockGetServiceOverrideStates.mockResolvedValueOnce([]);

    await expect(service.getBuildByUUID('relation-race')).resolves.toBe(build);

    expect(mockGetServiceOverrideStates).toHaveBeenCalledWith([snapshotDeploy]);
    expect(detailDeploy.serviceOverride).toBeNull();
    expect(snapshotDeploy).not.toHaveProperty('serviceOverride');
  });

  test.each([
    ['returns the live successor', { id: 8, uuid: 'reused-name', deletedAt: null, deploys: [] }, 8],
    ['falls back to the tombstone', null, 7],
  ])('getBuildByUUID with liveOnly=false %s', async (_case, liveSuccessor, expectedId) => {
    const tombstone = { id: 7, uuid: 'reused-name', deletedAt: new Date(), deploys: [] };
    const tombstoneQuery = lookupQuery(tombstone);
    const liveQuery = lookupQuery(liveSuccessor);
    const overrideSnapshotQuery = lookupQuery(null);
    const query = jest
      .fn()
      .mockReturnValueOnce(tombstoneQuery)
      .mockReturnValueOnce(liveQuery)
      .mockReturnValueOnce(overrideSnapshotQuery);
    const service = serviceWith({ models: { Build: { query } } });

    await expect(service.getBuildByUUID('reused-name', { liveOnly: false })).resolves.toMatchObject({
      id: expectedId,
    });

    expect(tombstoneQuery.whereNull).not.toHaveBeenCalled();
    expect(liveQuery.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(mockGetServiceOverrideStates).not.toHaveBeenCalled();
  });

  test('getBuildByUUID returns the hydrated build when its override snapshot disappears concurrently', async () => {
    const build = { id: 7, uuid: 'override-race', deploys: [{ deployable: { name: 'app' } }] };
    const detail = lookupQuery(build);
    const disappeared = lookupQuery(null);
    const service = serviceWith({
      models: {
        Build: { query: jest.fn().mockReturnValueOnce(detail).mockReturnValueOnce(disappeared) },
      },
    });

    await expect(service.getBuildByUUID('override-race')).resolves.toBe(build);
    expect(mockGetServiceOverrideStates).not.toHaveBeenCalled();
    expect(build.deploys[0]).not.toHaveProperty('serviceOverride');
  });

  test.each([
    ['missing build', null, { status: 'not_found' }],
    [
      'tearing-down build',
      { id: 1, uuid: 'env', status: BuildStatus.TEARING_DOWN, deployEnabled: true, deploys: [] },
      { status: 'tearing_down' },
    ],
    [
      'disabled build',
      { id: 1, uuid: 'env', status: BuildStatus.DEPLOYED, deployEnabled: false, deploys: [] },
      { status: 'deploy_disabled' },
    ],
  ])('redeployServiceFromBuild reports the %s state without queueing', async (_case, build, expected) => {
    const query = lookupQuery(build);
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });
    jest.spyOn(service, 'enqueueResolveAndDeployBuild');

    await expect(service.redeployServiceFromBuild('env', 'app')).resolves.toMatchObject(expected);
    expect(service.enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  test('redeployServiceFromBuild rejects an unknown service without accepting mailbox work', async () => {
    const build = { id: 1, uuid: 'env', status: BuildStatus.DEPLOYED, deployEnabled: true, deploys: [] };
    const query = lookupQuery(build);
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });
    jest.spyOn(service, 'enqueueResolveAndDeployBuild');

    await expect(service.redeployServiceFromBuild('env', 'missing')).rejects.toThrow(
      'Deployable missing not found for env.'
    );
    expect(service.enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  test('processApiEnvironmentExpiryQueue reports work and setup installs the stable ten-minute repeat', async () => {
    const service = serviceWith({});
    jest
      .spyOn(service, 'sweepExpiredApiEnvironments')
      .mockResolvedValue({ expired: 2, stuckTeardowns: 1, enqueued: 2 });
    const add = jest.fn().mockResolvedValue(undefined);
    (service as any).apiEnvironmentExpiryQueue = { add };

    await expect(service.processApiEnvironmentExpiryQueue()).resolves.toEqual({
      expired: 2,
      stuckTeardowns: 1,
      enqueued: 2,
    });
    await service.setupApiEnvironmentExpiryJob();

    expect(add).toHaveBeenCalledWith(
      'api-env-expiry',
      {},
      {
        jobId: 'api-env-expiry',
        repeat: { every: 10 * 60 * 1000 },
      }
    );
  });

  test('processApiEnvironmentExpiryQueue stays quiet while still returning an empty sweep result', async () => {
    const service = serviceWith({});
    jest
      .spyOn(service, 'sweepExpiredApiEnvironments')
      .mockResolvedValue({ expired: 0, stuckTeardowns: 0, enqueued: 0 });

    await expect(service.processApiEnvironmentExpiryQueue()).resolves.toEqual({
      expired: 0,
      stuckTeardowns: 0,
      enqueued: 0,
    });
  });

  test('invokeWebhooksForBuild distinguishes no configuration from a queued invocation', async () => {
    const withoutWebhooks = { id: 1, uuid: 'env', webhooksYaml: null };
    const withWebhooks = { id: 2, uuid: 'env-2', webhooksYaml: [{ type: 'command' }] };
    const BuildModel = {
      query: jest
        .fn()
        .mockImplementationOnce(() => lookupQuery(withoutWebhooks))
        .mockImplementationOnce(() => lookupQuery(withWebhooks)),
    };
    const service = serviceWith({ models: { Build: BuildModel } });

    await expect(service.invokeWebhooksForBuild('env')).resolves.toMatchObject({ status: 'no_content' });
    await expect(service.invokeWebhooksForBuild('env-2', 2)).resolves.toMatchObject({ status: 'success' });

    expect(mockWebhookQueueAdd).toHaveBeenCalledWith(
      'webhook',
      expect.objectContaining({ buildId: 2, correlationId: expect.stringContaining('api-webhook-invoke-') })
    );
  });

  test('getWebhooksForBuild returns newest-first invocation history for the exact live build', async () => {
    const buildQuery = lookupQuery({ id: 8 });
    const history = [{ id: 2 }, { id: 1 }];
    const historyQuery: any = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue(history),
    };
    const service = serviceWith({
      models: {
        Build: { query: jest.fn(() => buildQuery) },
        WebhookInvocations: { query: jest.fn(() => historyQuery) },
      },
    });

    await expect(service.getWebhooksForBuild('env', 8)).resolves.toEqual({ status: 'success', data: history });
    expect(buildQuery.findOne).toHaveBeenCalledWith({ uuid: 'env', id: 8 });
    expect(historyQuery.where).toHaveBeenCalledWith('buildId', 8);
    expect(historyQuery.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
  });

  test('getWebhooksForBuild resolves a live build by UUID when no expected id is supplied', async () => {
    const buildQuery = lookupQuery({ id: 8 });
    const historyQuery: any = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([]),
    };
    const service = serviceWith({
      models: {
        Build: { query: jest.fn(() => buildQuery) },
        WebhookInvocations: { query: jest.fn(() => historyQuery) },
      },
    });

    await expect(service.getWebhooksForBuild('env')).resolves.toEqual({ status: 'success', data: [] });

    expect(buildQuery.findOne).toHaveBeenCalledWith({ uuid: 'env' });
    expect(buildQuery.whereNull).toHaveBeenCalledWith('deletedAt');
  });

  test('validateLifecycleSchema returns validator output and converts fetch or parse failures to invalid', async () => {
    (github.getYamlFileContentFromBranch as jest.Mock)
      .mockResolvedValueOnce('version: 1.0.0')
      .mockRejectedValueOnce(new Error('GitHub unavailable'));
    const config = { version: '1.0.0' };
    const parse = jest.spyOn(YamlConfigParser.prototype, 'parseYamlConfigFromString').mockReturnValue(config as any);
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockReturnValue(true);
    const service = serviceWith({});

    await expect(service.validateLifecycleSchema('org/repo', 'main')).resolves.toEqual({ valid: true });
    await expect(service.validateLifecycleSchema('org/repo', 'broken')).resolves.toEqual({ valid: false });

    expect(parse).toHaveBeenCalledWith('version: 1.0.0');
    expect(validate).toHaveBeenCalledWith('1.0.0', config);
    parse.mockRestore();
    validate.mockRestore();
  });

  test('validateLifecycleSchema treats an empty YAML document as invalid', async () => {
    (github.getYamlFileContentFromBranch as jest.Mock).mockResolvedValue('');
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate');
    const service = serviceWith({});

    await expect(service.validateLifecycleSchema('org/repo', 'empty')).resolves.toEqual({ valid: false });

    expect(validate).toHaveBeenCalledWith(undefined, undefined);
    validate.mockRestore();
  });

  test('getNamespace validates its selector, filters UUID lookups to live rows, and reports missing builds', async () => {
    const byId = lookupQuery({ id: 7, namespace: 'env-seven' });
    const byUuid = lookupQuery(undefined);
    const BuildModel = {
      query: jest
        .fn()
        .mockImplementationOnce(() => byId)
        .mockImplementationOnce(() => byUuid),
    };
    const service = serviceWith({ models: { Build: BuildModel } });

    await expect(service.getNamespace({})).rejects.toThrow('Either "id" or "uuid" must be provided.');
    await expect(service.getNamespace({ id: 7 })).resolves.toBe('env-seven');
    await expect(service.getNamespace({ uuid: 'missing' })).rejects.toThrow(
      '[BUILD missing] Build not found when looking for namespace'
    );

    expect(byId.findOne).toHaveBeenCalledWith({ id: 7 });
    expect(byId.whereNull).not.toHaveBeenCalled();
    expect(byUuid.findOne).toHaveBeenCalledWith({ uuid: 'missing' });
    expect(byUuid.whereNull).toHaveBeenCalledWith('deletedAt');
  });

  test('getNamespace identifies a missing numeric build in its public error', async () => {
    const query = lookupQuery(undefined);
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });

    await expect(service.getNamespace({ id: 77 })).rejects.toThrow(
      '[BUILD 77] Build not found when looking for namespace'
    );

    expect(query.findOne).toHaveBeenCalledWith({ id: 77 });
    expect(query.whereNull).not.toHaveBeenCalled();
  });

  test('domainsAndCertificatesForBuild merges environment-lens banner annotations', async () => {
    (ingressBannerSnippet as jest.Mock).mockReturnValueOnce({ metadata: { annotations: { banner: 'enabled' } } });
    const hostForDeployableDeploy = jest.fn(() => 'app.example.test');
    const deploy = {
      uuid: 'deploy-1',
      active: true,
      deployable: {
        public: true,
        type: DeployTypes.DOCKER,
        port: '8080',
        envLens: true,
        ipWhitelist: [],
        ingressAnnotations: { existing: 'kept' },
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const build = { deploys: [deploy], $fetchGraph: jest.fn().mockResolvedValue(undefined) };
    const service = serviceWith({ services: { Deploy: { hostForDeployableDeploy } } });

    await expect(service.domainsAndCertificatesForBuild(build as any, false)).resolves.toEqual([
      expect.objectContaining({ ingressAnnotations: { existing: 'kept', banner: 'enabled' } }),
    ]);
  });

  test('domainsAndCertificatesForBuild supports GitHub services with empty environment-lens annotations', async () => {
    (ingressBannerSnippet as jest.Mock).mockReturnValueOnce({ metadata: {} });
    const hostForDeployableDeploy = jest.fn(() => 'github.example.test');
    const deploy = {
      uuid: 'github-service',
      active: true,
      deployable: {
        public: true,
        type: DeployTypes.GITHUB,
        port: '8080',
        envLens: true,
        ipWhitelist: [],
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const service = serviceWith({ services: { Deploy: { hostForDeployableDeploy } } });

    await expect(
      service.domainsAndCertificatesForBuild(
        { deploys: [deploy], $fetchGraph: jest.fn().mockResolvedValue(undefined) } as any,
        false
      )
    ).resolves.toEqual([expect.objectContaining({ host: 'github.example.test', ingressAnnotations: {} })]);
  });

  test('domainsAndCertificatesForBuild treats an environment-lens snippet without metadata as empty annotations', async () => {
    (ingressBannerSnippet as jest.Mock).mockReturnValueOnce({});
    const deploy = {
      uuid: 'metadata-free-banner',
      active: true,
      deployable: {
        public: true,
        type: DeployTypes.DOCKER,
        port: '8080',
        envLens: true,
        ipWhitelist: [],
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const service = serviceWith({
      services: { Deploy: { hostForDeployableDeploy: jest.fn(() => 'banner.example.test') } },
    });

    await expect(
      service.domainsAndCertificatesForBuild(
        { deploys: [deploy], $fetchGraph: jest.fn().mockResolvedValue(undefined) } as any,
        false
      )
    ).resolves.toEqual([expect.objectContaining({ ingressAnnotations: {} })]);
  });

  test('active ingress configuration flattens build results and configurationsForBuildId honors allServices', async () => {
    const first = { id: 1, $fetchGraph: jest.fn().mockResolvedValue(undefined) };
    const second = { id: 2, $fetchGraph: jest.fn().mockResolvedValue(undefined) };
    const BuildModel = { findOne: jest.fn().mockResolvedValue(first) };
    const service = serviceWith({ models: { Build: BuildModel } });
    jest.spyOn(service, 'activeBuilds').mockResolvedValue([first, second] as any);
    const configurations = jest
      .spyOn(service, 'domainsAndCertificatesForBuild')
      .mockResolvedValueOnce([{ host: 'one' }] as any)
      .mockResolvedValueOnce([null, { host: 'two' }] as any)
      .mockResolvedValueOnce([{ host: 'all' }] as any);

    await expect(service.activeDomainsAndCertificatesForIngress()).resolves.toEqual([{ host: 'one' }, { host: 'two' }]);
    await expect(service.configurationsForBuildId(1, true)).resolves.toEqual([{ host: 'all' }]);

    expect(BuildModel.findOne).toHaveBeenCalledWith({ id: 1 });
    expect(first.$fetchGraph).toHaveBeenCalledWith('deploys.[deployable.[repository]]');
    expect(configurations).toHaveBeenLastCalledWith(first, true);
  });

  test('configurationsForBuildId returns no configurations when the build disappeared', async () => {
    const BuildModel = { findOne: jest.fn().mockResolvedValue(undefined) };
    const service = serviceWith({ models: { Build: BuildModel } });
    const domains = jest.spyOn(service, 'domainsAndCertificatesForBuild');

    await expect(service.configurationsForBuildId(404)).resolves.toEqual([]);

    expect(BuildModel.findOne).toHaveBeenCalledWith({ id: 404 });
    expect(domains).toHaveBeenCalledWith(undefined, false);
  });

  test('createBuildAndDeploys no-ops with no matching environments and creates every matching environment otherwise', async () => {
    const emptyFind: any = {
      withGraphJoined: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
    };
    const populatedFind: any = {
      withGraphJoined: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
    };
    const EnvironmentModel = {
      find: jest.fn().mockReturnValueOnce(emptyFind).mockReturnValueOnce(populatedFind),
    };
    const service = serviceWith({ models: { Environment: EnvironmentModel } });
    const createBuild = jest.spyOn(service, 'createBuild').mockResolvedValue(undefined);
    const request = {
      repositoryId: 42,
      repositoryBranchName: 'main',
      installationId: 5,
      pullRequestId: 7,
    } as any;

    await service.createBuildAndDeploys(request);
    expect(createBuild).not.toHaveBeenCalled();

    await service.createBuildAndDeploys(request);
    expect(createBuild).toHaveBeenCalledTimes(2);
    expect(createBuild).toHaveBeenNthCalledWith(1, { id: 1 }, request, undefined);
    expect(createBuild).toHaveBeenNthCalledWith(2, { id: 2 }, request, undefined);
  });

  test('createBuildAndDeploys contains one environment creation failure after attempting the batch', async () => {
    const find: any = {
      withGraphJoined: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
    };
    const service = serviceWith({ models: { Environment: { find: jest.fn(() => find) } } });
    const createError = new Error('build create failed');
    const createBuild = jest
      .spyOn(service, 'createBuild')
      .mockRejectedValueOnce(createError)
      .mockResolvedValueOnce(undefined);

    await expect(
      service.createBuildAndDeploys({ repositoryId: 42, repositoryBranchName: 'main', pullRequestId: 7 } as any)
    ).resolves.toBeUndefined();
    expect(createBuild).toHaveBeenCalledTimes(2);
  });

  test('updateStatusAndComment publishes PR activity without letting an activity failure block webhook notification', async () => {
    const activityError = new Error('activity unavailable');
    const updatePullRequestActivityStream = jest.fn().mockRejectedValue(activityError);
    const webhookAdd = jest.fn().mockResolvedValue(undefined);
    const patchQuery: any = {
      patch: jest.fn(() => patchQuery),
      where: jest.fn(() => patchQuery),
      whereNull: jest.fn(() => patchQuery),
      then: (resolve: (value: number) => unknown) => Promise.resolve(1).then(resolve),
    };
    const deploys = [
      {
        uuid: 'app',
        active: true,
        status: DeployStatus.ERROR,
        statusMessage: 'image failed',
        deployable: { name: 'app' },
      },
    ];
    const build: any = {
      id: 1,
      uuid: 'env',
      kind: BuildKind.ENVIRONMENT,
      status: BuildStatus.PENDING,
      deploys,
      pullRequest: { repository: { id: 9 } },
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const service = serviceWith({
      models: { Build: { query: jest.fn(() => patchQuery) } },
      services: {
        ActivityStream: { updatePullRequestActivityStream },
        Webhook: { webhookQueue: { add: webhookAdd } },
      },
    });

    await expect(
      service.updateStatusAndComment(build, BuildStatus.ERROR, 'run-1', true, true)
    ).resolves.toBeUndefined();

    expect(patchQuery.patch).toHaveBeenCalledWith({
      status: BuildStatus.ERROR,
      statusMessage: 'Build failed because app: image failed',
    });
    expect(updatePullRequestActivityStream).toHaveBeenCalled();
    expect(webhookAdd).toHaveBeenCalledWith('webhook', expect.objectContaining({ buildId: 1 }));
  });

  test('updateStatusAndComment persists the stable generic failure message when no service explains the error', async () => {
    const patchQuery: any = {
      patch: jest.fn(() => patchQuery),
      where: jest.fn(() => patchQuery),
      whereNull: jest.fn(() => patchQuery),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const build: any = {
      id: 1,
      uuid: 'failed-build',
      kind: BuildKind.SANDBOX,
      status: BuildStatus.BUILDING,
      deploys: [],
      pullRequest: null,
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const service = serviceWith({ models: { Build: { query: jest.fn(() => patchQuery) } } });

    await service.updateStatusAndComment(build, BuildStatus.ERROR, 'run-1', true, true);

    expect(patchQuery.patch).toHaveBeenCalledWith({
      status: BuildStatus.ERROR,
      statusMessage: 'Build failed. Check service status messages for details.',
    });
  });

  test.each([
    [
      'configuration failure without an Error',
      BuildStatus.CONFIG_ERROR,
      [],
      null,
      'Lifecycle configuration failed validation.',
    ],
    ['unexpected failure with an empty Error', BuildStatus.ERROR, [], new Error(), 'Build failed unexpectedly.'],
    [
      'failed service without a status message',
      BuildStatus.ERROR,
      [
        {
          uuid: 'worker',
          active: true,
          status: DeployStatus.BUILD_FAILED,
          statusMessage: '',
          deployable: { name: 'worker' },
        },
      ],
      null,
      `Build failed because worker: ${DeployStatus.BUILD_FAILED}`,
    ],
  ])(
    'updateStatusAndComment preserves the public fallback for %s',
    async (_case, status, deploys, error, expectedMessage) => {
      const patchQuery: any = {
        patch: jest.fn(() => patchQuery),
        where: jest.fn(() => patchQuery),
        whereNull: jest.fn(() => patchQuery),
        then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(1).then(resolve, reject),
      };
      const build: any = {
        id: 1,
        uuid: 'fallback-build',
        kind: BuildKind.SANDBOX,
        status: BuildStatus.BUILDING,
        deploys,
        pullRequest: null,
        reload: jest.fn().mockResolvedValue(undefined),
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };
      const service = serviceWith({ models: { Build: { query: jest.fn(() => patchQuery) } } });

      await service.updateStatusAndComment(build, status, 'run-1', true, true, error);

      expect(patchQuery.patch).toHaveBeenCalledWith({ status, statusMessage: expectedMessage });
      expect(build).toMatchObject({ status, statusMessage: expectedMessage });
      expect(mockWebhookQueueAdd).not.toHaveBeenCalled();
    }
  );

  test('markConfigurationsAsBuilt updates only matching configuration deploys and contains database failures', async () => {
    const matching = {
      id: 1,
      uuid: 'config-main',
      githubRepositoryId: 42,
      branchName: 'main',
      deployable: { type: DeployTypes.CONFIGURATION },
    };
    const otherBranch = {
      id: 2,
      uuid: 'config-other',
      githubRepositoryId: 42,
      branchName: 'other',
      deployable: { type: DeployTypes.CONFIGURATION },
    };
    const nonConfig = { id: 3, deployable: { type: DeployTypes.DOCKER } };
    const patchQuery: any = {
      patch: jest.fn(() => patchQuery),
      where: jest.fn().mockResolvedValue(1),
    };
    const build: any = {
      deploys: [matching, otherBranch, nonConfig],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const service = serviceWith({ models: { Deploy: { query: jest.fn(() => patchQuery) } } });

    await service.markConfigurationsAsBuilt(build, 'run-1', 42, 'main');

    expect(patchQuery.patch).toHaveBeenCalledWith({ status: DeployStatus.BUILT });
    expect(patchQuery.where).toHaveBeenCalledWith({ id: 1, runUUID: 'run-1' });
    expect(patchQuery.where).not.toHaveBeenCalledWith({ id: 2, runUUID: 'run-1' });

    build.$fetchGraph.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.markConfigurationsAsBuilt(build, 'run-1')).resolves.toBeUndefined();
  });

  test('markConfigurationsAsBuilt avoids a write when the build has no matching configuration deploy', async () => {
    const deployQuery = jest.fn();
    const build: any = {
      deploys: [{ id: 3, deployable: { type: DeployTypes.DOCKER } }],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const service = serviceWith({ models: { Deploy: { query: deployQuery } } });

    await service.markConfigurationsAsBuilt(build, 'run-1');

    expect(build.$fetchGraph).toHaveBeenCalledWith({ deploys: { deployable: true } });
    expect(deployQuery).not.toHaveBeenCalled();
  });

  test('withBuildDeploymentLock falls back without Redlock and releases an acquired lock after the action', async () => {
    const action = jest.fn().mockResolvedValue('done');
    const withoutLock = serviceWith({});

    await expect(withoutLock.withBuildDeploymentLock(1, action)).resolves.toBe('done');

    const unlock = jest.fn().mockResolvedValue(undefined);
    const lock = jest.fn().mockResolvedValue({ unlock, extend: jest.fn() });
    const withLock = serviceWith({}, { lock });
    await expect(withLock.withBuildDeploymentLock(2, action)).resolves.toBe('done');
    expect(lock).toHaveBeenCalledWith('build-deployment.2', 15 * 60 * 1000);
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  test('withBuildDeploymentLock surfaces renewal loss while containing lock-release failure', async () => {
    jest.useFakeTimers();
    const renewalFailure = new Error('lock renewal failed');
    const extend = jest.fn().mockRejectedValue(renewalFailure);
    const unlock = jest.fn().mockRejectedValue(new Error('lock release failed'));
    const lock = jest.fn().mockResolvedValue({ extend, unlock });
    const service = serviceWith({}, { lock });
    const action = jest.fn(async () => {
      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
      await Promise.resolve();
      return 'done';
    });

    await expect(service.withBuildDeploymentLock(7, action)).rejects.toBe(renewalFailure);

    expect(extend).toHaveBeenCalledWith(15 * 60 * 1000);
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  test('enqueuePendingDeploymentReconciliations wraps the cursor and contains an individual signal failure', async () => {
    const first = lookupQuery([{ id: 5, desiredGeneration: 2 }]);
    const afterCursor = lookupQuery([]);
    const wrapped = lookupQuery([{ id: 2, desiredGeneration: 3 }]);
    const BuildModel = {
      query: jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(afterCursor).mockReturnValueOnce(wrapped),
    };
    const service = serviceWith({ models: { Build: BuildModel } });
    const add = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('queue unavailable'));
    (service as any).deploymentReconciliationQueue = { add };

    await service.enqueuePendingDeploymentReconciliations();
    await expect(service.enqueuePendingDeploymentReconciliations()).resolves.toBeUndefined();

    expect(first.where).toHaveBeenCalledWith('id', '>', 0);
    expect(afterCursor.where).toHaveBeenCalledWith('id', '>', 5);
    expect(wrapped.where).toHaveBeenCalledWith('id', '>', 0);
    expect(add).toHaveBeenNthCalledWith(1, 'reconcile', expect.objectContaining({ buildId: 5, generation: 2 }), {
      jobId: 'reconcile-5-2',
    });
    expect(add).toHaveBeenNthCalledWith(2, 'reconcile', expect.objectContaining({ buildId: 2, generation: 3 }), {
      jobId: 'reconcile-2-3',
    });
  });

  test('setupDeploymentReconciliationSweep runs immediately, repeats, and contains both failures', async () => {
    jest.useFakeTimers();
    const service = serviceWith({});
    const sweep = jest
      .spyOn(service, 'enqueuePendingDeploymentReconciliations')
      .mockRejectedValueOnce(new Error('initial failure'))
      .mockRejectedValueOnce(new Error('interval failure'));

    const timer = service.setupDeploymentReconciliationSweep(1000);
    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(sweep).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });

  test('setupDeploymentReconciliationSweep uses the five-second default interval', async () => {
    jest.useFakeTimers();
    const service = serviceWith({});
    const sweep = jest.spyOn(service, 'enqueuePendingDeploymentReconciliations').mockResolvedValue(undefined);

    const timer = service.setupDeploymentReconciliationSweep();
    await Promise.resolve();
    expect(sweep).toHaveBeenCalledTimes(1);

    await (jest as any).advanceTimersByTimeAsync(4_999);
    expect(sweep).toHaveBeenCalledTimes(1);
    await (jest as any).advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });

  test('deployment reconciliation rejects malformed jobs and both legacy queue adapters accept durable work', async () => {
    const service = serviceWith({});
    const add = jest.fn().mockResolvedValue(undefined);
    (service as any).deploymentReconciliationQueue = { add };

    await expect(service.processDeploymentReconciliationQueue({ data: { buildId: 0 } } as any)).rejects.toThrow(
      'buildId and generation are required'
    );

    await service.processBuildQueue({ data: { buildId: 7, runUUID: 'legacy-build' } } as any);
    await service.processResolveAndDeployBuildQueue({ data: { buildId: 8, githubRepositoryId: 42 } } as any);

    expect(mockAcceptDeploymentIntent).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith('reconcile', expect.objectContaining({ buildId: 7, generation: 1 }), {
      jobId: 'reconcile-7-1',
    });
    expect(add).toHaveBeenCalledWith('reconcile', expect.objectContaining({ buildId: 8, generation: 1 }), {
      jobId: 'reconcile-8-1',
    });
  });

  test('legacy queue adapters stop without signaling when the build disappeared during mailbox acceptance', async () => {
    mockAcceptDeploymentIntent.mockResolvedValueOnce(null);
    const service = serviceWith({});
    const add = jest.fn();
    (service as any).deploymentReconciliationQueue = { add };

    await expect(service.processBuildQueue({ data: { buildId: 7 } } as any)).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();
  });

  test('deleteBuild is idempotent for a missing input and stops when queued teardown ownership was lost', async () => {
    const service = serviceWith({});
    await expect(service.deleteBuild(null as any)).resolves.toBeUndefined();

    const build: any = {
      id: 7,
      uuid: 'env',
      pullRequestId: 1,
      runUUID: 'new-owner',
      reload: jest.fn().mockResolvedValue(undefined),
    };
    await expect(
      service.deleteBuild(build, {
        deploymentLockAlreadyHeld: true,
        runUUID: 'stale-owner',
      } as any)
    ).resolves.toBeUndefined();
    expect(build.reload).toHaveBeenCalledTimes(1);
  });

  test('createBuild claims an open PR build before importing configuration and publishing pending status', async () => {
    const mutation: any = {
      where: jest.fn(() => mutation),
      whereNull: jest.fn(() => mutation),
      whereNotIn: jest.fn(() => mutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const deploys = [{ id: 11, uuid: 'app', active: true, deployable: { name: 'app' } }];
    const build: any = {
      id: 7,
      uuid: 'pr-env-123456',
      kind: BuildKind.ENVIRONMENT,
      status: BuildStatus.QUEUED,
      deletedAt: null,
      runUUID: null,
      pullRequestId: 55,
      pullRequest: {
        status: 'open',
        deployOnUpdate: true,
        fullName: 'org/repo',
        branchName: 'feature',
        repository: { id: 2, githubRepositoryId: 42 },
      },
      deploys: [],
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $setRelated: jest.fn((_relation: string, related: any[]) => {
        build.deploys = related;
      }),
    };
    const buildQuery: any = {
      where: jest.fn(() => buildQuery),
      whereNull: jest.fn(() => buildQuery),
      first: jest.fn().mockResolvedValue(build),
      findOne: jest.fn().mockResolvedValue(build),
      patch: jest.fn(() => mutation),
    };
    const upsertDeployables = jest.fn().mockResolvedValue({ canReconcile: false });
    const findOrCreateDeploys = jest.fn().mockResolvedValue(deploys);
    const upsertWebhooksWithYaml = jest.fn().mockRejectedValue(new Error('webhook import unavailable'));
    const updatePullRequestActivityStream = jest.fn().mockResolvedValue(undefined);
    const webhookAdd = jest.fn().mockResolvedValue(undefined);
    const service = serviceWith({
      models: { Build: { query: jest.fn(() => buildQuery), create: jest.fn() } },
      services: {
        Deployable: { upsertDeployables },
        Deploy: { findOrCreateDeploys },
        Webhook: { upsertWebhooksWithYaml, webhookQueue: { add: webhookAdd } },
        ActivityStream: { updatePullRequestActivityStream },
      },
    });

    await expect(
      service.createBuild(
        { id: 5 } as any,
        { pullRequestId: 55, repositoryId: 2, repositoryBranchName: 'feature' },
        {} as any
      )
    ).resolves.toBeUndefined();

    const ownershipPatch = buildQuery.patch.mock.calls.find(([value]) => value.runUUID != null);
    expect(ownershipPatch).toBeDefined();
    expect(upsertDeployables).toHaveBeenCalledWith(
      7,
      'pr-env-123456',
      build.pullRequest,
      { id: 5 },
      build,
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(findOrCreateDeploys).toHaveBeenCalledWith({ id: 5 }, build);
    expect(build.$setRelated).toHaveBeenCalledWith('deploys', deploys);
    expect(buildQuery.patch).toHaveBeenCalledWith({ status: BuildStatus.PENDING, statusMessage: '' });
    expect(updatePullRequestActivityStream).toHaveBeenCalledTimes(1);
    expect(webhookAdd).toHaveBeenCalledWith('webhook', expect.objectContaining({ buildId: 7 }));
  });

  test('createBuild contains an invalid PR-less invocation before any build is inserted', async () => {
    const create = jest.fn();
    const service = serviceWith({ models: { Build: { create } } });

    await expect(
      service.createBuild({ id: 5 } as any, { repositoryId: 2, repositoryBranchName: 'main' }, undefined)
    ).resolves.toBeUndefined();

    expect(create).not.toHaveBeenCalled();
  });

  test.each([
    ['PR authority closes under the setup lock', 'closed', 1],
    ['the setup ownership patch affects no row', 'open', 0],
  ])('createBuild stops before YAML import when %s', async (_case, actionStatus, claimedRows) => {
    const openBuild: any = {
      id: 7,
      uuid: 'setup-race',
      status: BuildStatus.QUEUED,
      deletedAt: null,
      pullRequestId: 55,
      pullRequest: { status: 'open', deployOnUpdate: true },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const closedBuild = { ...openBuild, pullRequest: { status: actionStatus, deployOnUpdate: true } };
    const authorities = [openBuild, openBuild, closedBuild, closedBuild];
    const mutation: any = {
      where: jest.fn(() => mutation),
      whereNull: jest.fn(() => mutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(claimedRows).then(resolve, reject),
    };
    const query: any = {
      where: jest.fn(() => query),
      whereNull: jest.fn(() => query),
      first: jest.fn().mockResolvedValue(openBuild),
      findOne: jest.fn(async () => authorities.shift() ?? closedBuild),
      patch: jest.fn(() => mutation),
    };
    const upsertDeployables = jest.fn();
    const service = serviceWith({
      models: { Build: { query: jest.fn(() => query) } },
      services: { Deployable: { upsertDeployables } },
    });

    await service.createBuild(
      { id: 5 } as any,
      { pullRequestId: 55, repositoryId: 2, repositoryBranchName: 'feature' },
      {} as any
    );

    expect(upsertDeployables).not.toHaveBeenCalled();
    expect(query.patch).toHaveBeenCalledTimes(actionStatus === 'open' ? 1 : 0);
  });

  test.each([
    ['configuration parse', new ParsingError('invalid lifecycle yaml'), BuildStatus.CONFIG_ERROR],
    ['configuration validation', new ValidationError('invalid lifecycle schema'), BuildStatus.CONFIG_ERROR],
    ['unexpected import', new Error('deployable storage unavailable'), BuildStatus.ERROR],
  ])(
    'createBuild records a fenced %s failure without attempting deploy creation',
    async (_case, importError, status) => {
      const mutation: any = {
        where: jest.fn(() => mutation),
        whereNull: jest.fn(() => mutation),
        whereNotIn: jest.fn(() => mutation),
        patch: jest.fn(() => mutation),
        then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(1).then(resolve, reject),
      };
      const build: any = {
        id: 7,
        uuid: 'failing-pr-build',
        kind: BuildKind.SANDBOX,
        status: BuildStatus.QUEUED,
        deletedAt: null,
        runUUID: null,
        pullRequestId: 55,
        pullRequest: { status: 'open', deployOnUpdate: true, repository: { githubRepositoryId: 42 } },
        deploys: [],
        reload: jest.fn().mockResolvedValue(undefined),
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };
      const buildQuery: any = {
        where: jest.fn(() => buildQuery),
        whereNull: jest.fn(() => buildQuery),
        first: jest.fn().mockResolvedValue(build),
        findOne: jest.fn().mockResolvedValue(build),
        patch: jest.fn((value: Record<string, unknown>) => {
          mutation.patch(value);
          return mutation;
        }),
      };
      const findOrCreateDeploys = jest.fn();
      const service = serviceWith({
        models: { Build: { query: jest.fn(() => buildQuery) } },
        services: {
          Deployable: { upsertDeployables: jest.fn().mockRejectedValue(importError) },
          Deploy: { findOrCreateDeploys },
          Webhook: { webhookQueue: { add: jest.fn().mockResolvedValue(undefined) } },
        },
      });

      await expect(
        service.createBuild(
          { id: 5 } as any,
          { pullRequestId: 55, repositoryId: 2, repositoryBranchName: 'feature' },
          {} as any
        )
      ).resolves.toBeUndefined();

      expect(findOrCreateDeploys).not.toHaveBeenCalled();
      expect(mutation.patch).toHaveBeenCalledWith({ status, statusMessage: importError.message });
      expect(build.status).toBe(status);
    }
  );

  test('createBuild fails closed when an import error cannot be fenced by an authority read', async () => {
    const importError = new Error('deployable storage unavailable');
    const authorityError = new Error('build authority unavailable');
    const mutation: any = {
      where: jest.fn(() => mutation),
      whereNull: jest.fn(() => mutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const build: any = {
      id: 7,
      uuid: 'authority-read-failure',
      kind: BuildKind.SANDBOX,
      status: BuildStatus.QUEUED,
      deletedAt: null,
      runUUID: null,
      pullRequestId: 55,
      pullRequest: { status: 'open', deployOnUpdate: true, repository: { githubRepositoryId: 42 } },
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    let authorityReads = 0;
    const buildQuery: any = {
      where: jest.fn(() => buildQuery),
      whereNull: jest.fn(() => buildQuery),
      first: jest.fn().mockResolvedValue(build),
      findOne: jest.fn(async () => {
        authorityReads += 1;
        if (authorityReads === 5) throw authorityError;
        return build;
      }),
      patch: jest.fn(() => mutation),
    };
    const findOrCreateDeploys = jest.fn();
    const service = serviceWith({
      models: { Build: { query: jest.fn(() => buildQuery) } },
      services: {
        Deployable: { upsertDeployables: jest.fn().mockRejectedValue(importError) },
        Deploy: { findOrCreateDeploys },
      },
    });

    await expect(
      service.createBuild(
        { id: 5 } as any,
        { pullRequestId: 55, repositoryId: 2, repositoryBranchName: 'feature' },
        {} as any
      )
    ).resolves.toBeUndefined();

    expect(authorityReads).toBe(6);
    expect(findOrCreateDeploys).not.toHaveBeenCalled();
    expect(buildQuery.patch).toHaveBeenCalledTimes(1);
    expect(buildQuery.patch).not.toHaveBeenCalledWith(expect.objectContaining({ status: expect.anything() }));
    expect(build.status).toBe(BuildStatus.QUEUED);
    expect(importError).not.toBe(authorityError);
  });

  test('buildImages prepares native build infrastructure and passes the fenced service account to the builder', async () => {
    const deploy = {
      id: 11,
      uuid: 'native-app',
      active: true,
      deployable: { type: DeployTypes.DOCKER, builder: { engine: 'buildkit' } },
    };
    const deployRead: any = {
      where: jest.fn(() => deployRead),
      withGraphFetched: jest.fn().mockResolvedValue([deploy]),
    };
    mockDeployQuery.mockReturnValue(deployRead);
    const mutation: any = {
      patch: jest.fn(() => mutation),
      where: jest.fn(() => mutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const current = {
      id: 7,
      runUUID: 'run-native',
      status: BuildStatus.PENDING,
      deployEnabled: true,
      deletedAt: null,
      pullRequestId: null,
      desiredGeneration: 4,
    };
    const currentQuery = lookupQuery(current);
    const buildImage = jest.fn().mockResolvedValue(true);
    const service = serviceWith({
      models: {
        Build: { query: jest.fn(() => currentQuery) },
        Deploy: { query: jest.fn(() => mutation) },
      },
      services: { Deploy: { buildImage } },
    });
    const build: any = {
      ...current,
      uuid: 'native-build',
      namespace: 'env-native-build',
      isStatic: false,
      pullRequest: null,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.buildImages(build, 'run-native', null, 'sha-a', 'main', 4)).resolves.toBe(true);

    const kubernetes = jest.requireMock('server/lib/kubernetes');
    expect(kubernetes.createOrUpdateNamespace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'env-native-build', waitForReady: true })
    );
    expect(buildImage).toHaveBeenCalledWith(deploy, 0, 'run-native', 'sha-a', null, 'main', 4, 'default');
  });

  test('generateAndApplyManifests persists current deploy and legacy manifests behind native mutation gates', async () => {
    const deploy: any = {
      id: 11,
      uuid: 'app',
      active: true,
      githubRepositoryId: 42,
      branchName: 'main',
      dockerImage: 'image:v1',
      deployable: {
        name: 'app',
        type: DeployTypes.DOCKER,
        deploymentDependsOn: [],
      },
    };
    const deployRead: any = {
      where: jest.fn(() => deployRead),
      withGraphFetched: jest.fn().mockResolvedValue([deploy]),
    };
    mockDeployQuery.mockReturnValue(deployRead);
    const mutation: any = {
      patch: jest.fn(() => mutation),
      where: jest.fn(() => mutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const build: any = {
      id: 7,
      uuid: 'manifest-build',
      namespace: 'env-manifest-build',
      kind: BuildKind.SANDBOX,
      runUUID: 'run-manifest',
      status: BuildStatus.PENDING,
      deployEnabled: true,
      deletedAt: null,
      pullRequestId: null,
      desiredGeneration: 4,
      isStatic: false,
      pullRequest: null,
      deploys: [deploy],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const buildQuery: any = {
      findById: jest.fn(() => buildQuery),
      select: jest.fn(() => buildQuery),
      patch: jest.fn(() => mutation),
      then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(build).then(resolve, reject),
    };
    const service = serviceWith({
      models: {
        Build: { query: jest.fn(() => buildQuery) },
        Deploy: { query: jest.fn(() => mutation) },
      },
    });
    mockGenerateDeployManifest.mockReturnValue('kind: Deployment\n');
    mockGenerateManifest.mockReturnValue('kind: List\n');
    const deployManifests = jest
      .spyOn(DeploymentManager.prototype, 'deploy')
      .mockImplementation(async function (this: any) {
        expect(await this.options.isCurrent()).toBe(true);
        await this.options.nativeMutationGate(async () => undefined);
        await this.options.nativeSecretMutationGate(deploy, async () => undefined);
      });

    await expect(
      service.generateAndApplyManifests({
        build,
        runUUID: 'run-manifest',
        expectedGeneration: 4,
        githubRepositoryId: 42,
        sourceBranch: 'main',
        namespace: build.namespace,
      })
    ).resolves.toBe(true);

    expect(mutation.patch).toHaveBeenCalledWith({ manifest: 'kind: Deployment\n' });
    expect(buildQuery.patch).toHaveBeenCalledWith({ manifest: 'kind: List\n' });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'manifest',
      expect.objectContaining({ buildId: 7, runUUID: 'run-manifest', expectedGeneration: 4 })
    );
    expect(deploy.manifest).toBe('kind: Deployment\n');
    deployManifests.mockRestore();
  });

  test('generateAndApplyManifests refuses to publish ingress after generation authority changes', async () => {
    const build: any = {
      id: 7,
      uuid: 'stale-manifest-build',
      namespace: 'env-stale-manifest-build',
      kind: BuildKind.SANDBOX,
      runUUID: 'run-current',
      status: BuildStatus.PENDING,
      deployEnabled: true,
      deletedAt: null,
      pullRequestId: null,
      desiredGeneration: 4,
      isStatic: false,
      pullRequest: null,
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    let authorityReads = 0;
    const BuildModel = {
      query: jest.fn(() => {
        authorityReads += 1;
        const authority = authorityReads <= 3 ? build : { ...build, runUUID: 'newer-run' };
        return lookupQuery(authority);
      }),
    };
    const noDeploys: any = {
      where: jest.fn(() => noDeploys),
      withGraphFetched: jest.fn().mockResolvedValue([]),
    };
    mockDeployQuery.mockReturnValue(noDeploys);
    const service = serviceWith({ models: { Build: BuildModel } });

    await expect(
      service.generateAndApplyManifests({
        build,
        runUUID: 'run-current',
        expectedGeneration: 4,
        githubRepositoryId: null,
        namespace: build.namespace,
      })
    ).rejects.toThrow('Deployment generation was superseded');

    expect(mockQueueAdd).not.toHaveBeenCalledWith('manifest', expect.anything());
  });

  test('generateAndApplyManifests continues when environment prewarm queueing fails', async () => {
    const prewarmFailure = new Error('prewarm queue unavailable');
    const queueBuildPrewarm = jest
      .spyOn(AgentPrewarmService.prototype, 'queueBuildPrewarm')
      .mockRejectedValue(prewarmFailure);
    const noDeploys: any = {
      where: jest.fn(() => noDeploys),
      withGraphFetched: jest.fn().mockResolvedValue([]),
    };
    mockDeployQuery.mockReturnValue(noDeploys);
    const build: any = {
      id: 7,
      uuid: 'prewarm-build',
      namespace: 'env-prewarm-build',
      kind: BuildKind.ENVIRONMENT,
      triggerType: 'api',
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const service = serviceWith({});

    await expect(
      service.generateAndApplyManifests({
        build,
        githubRepositoryId: null,
        namespace: build.namespace,
        enqueueIngress: false,
      })
    ).resolves.toBe(true);

    expect(queueBuildPrewarm).toHaveBeenCalledWith('prewarm-build');
    queueBuildPrewarm.mockRestore();
  });

  test('deleteBuild queues provider and ingress cleanup for every torn-down GitHub deployment', async () => {
    const mutation: any = {
      patch: jest.fn(() => mutation),
      where: jest.fn(() => mutation),
      whereNull: jest.fn(() => mutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const githubAdd = jest.fn().mockResolvedValue(undefined);
    const deployPatch = jest.fn().mockResolvedValue(undefined);
    const deploy = { id: 11, $query: jest.fn(() => ({ patch: deployPatch })) };
    const build: any = {
      id: 7,
      uuid: 'delete-build',
      namespace: 'env-delete-build',
      kind: BuildKind.SANDBOX,
      status: BuildStatus.DEPLOYED,
      runUUID: 'old-run',
      pullRequestId: null,
      pullRequest: null,
      deployEnabled: true,
      githubDeployments: true,
      deploys: [deploy],
      idempotencyKey: null,
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(() => ({ patch: jest.fn().mockResolvedValue(1) })),
    };
    const service = serviceWith({
      models: {
        Build: { query: jest.fn(() => mutation) },
        Deploy: { query: jest.fn(() => mutation) },
      },
      services: {
        GithubService: { githubDeploymentQueue: { add: githubAdd } },
        Ingress: { ingressCleanupQueue: {} },
        Webhook: { webhookQueue: { add: jest.fn().mockResolvedValue(undefined) } },
      },
    });

    await expect(service.deleteBuild(build)).resolves.toBeUndefined();

    expect(deployPatch).toHaveBeenCalledWith({ status: DeployStatus.TORN_DOWN });
    expect(githubAdd).toHaveBeenCalledWith('deployment', expect.objectContaining({ deployId: 11, action: 'delete' }));
    expect(mockDeleteNamespace).toHaveBeenCalledWith('env-delete-build');
    expect(mockQueueAdd).toHaveBeenCalledWith('cleanup', expect.objectContaining({ buildId: 7 }));
    expect(build.status).toBe(BuildStatus.TORN_DOWN);
  });

  test('createApiEnvironment rejects malformed source, missing environment, invalid YAML, and insert failures at their boundaries', async () => {
    const apiConfig = { enabled: true, defaultTtlHours: 72, maxTtlHours: 336, extensionHours: 24 };
    const malformedService = serviceWith({});
    jest.spyOn(malformedService, 'getApiEnvironmentsConfig').mockResolvedValue(apiConfig);

    await expect(
      malformedService.createApiEnvironment({ repositoryFullName: 'missing-slash', branch: 'main' })
    ).rejects.toMatchObject({ code: 'invalid_repository' });
    await expect(
      malformedService.createApiEnvironment({ repositoryFullName: 'org/repo', branch: '   ' })
    ).rejects.toMatchObject({ code: 'invalid_branch' });

    const repository = { id: 2, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 };
    const repositoryQuery: any = {
      whereRaw: jest.fn(() => repositoryQuery),
      whereNull: jest.fn(() => repositoryQuery),
      first: jest.fn().mockResolvedValue(repository),
    };
    const missingEnvironmentService = serviceWith({
      models: {
        Repository: { query: jest.fn(() => repositoryQuery) },
        Environment: { query: jest.fn(() => ({ findById: jest.fn().mockResolvedValue(null) })) },
      },
    });
    jest.spyOn(missingEnvironmentService, 'getApiEnvironmentsConfig').mockResolvedValue(apiConfig);
    await expect(
      missingEnvironmentService.createApiEnvironment({ repositoryFullName: 'org/repo', branch: 'main' })
    ).rejects.toMatchObject({ code: 'env_not_found' });

    const environment = { id: 5 };
    const createService = (create: jest.Mock) => {
      const service = serviceWith({
        models: {
          Repository: { query: jest.fn(() => repositoryQuery) },
          Environment: { query: jest.fn(() => ({ findById: jest.fn().mockResolvedValue(environment) })) },
          Build: { create },
        },
      });
      jest.spyOn(service, 'getApiEnvironmentsConfig').mockResolvedValue(apiConfig);
      return service;
    };
    const config = { version: '1.0.0', environment: {} };
    mockGetYamlFileContent.mockResolvedValue(config);
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockImplementationOnce(() => {
      throw new Error('schema mismatch');
    });
    await expect(
      createService(jest.fn()).createApiEnvironment({ repositoryFullName: 'org/repo', branch: 'main' })
    ).rejects.toMatchObject({ code: 'config_invalid', message: expect.stringContaining('schema mismatch') });

    validate.mockReturnValue(true);
    const insertFailure = new Error('database unavailable');
    await expect(
      createService(jest.fn().mockRejectedValue(insertFailure)).createApiEnvironment({
        repositoryFullName: 'org/repo',
        branch: 'main',
        name: 'insert-failure-123456',
      })
    ).rejects.toBe(insertFailure);

    const collision = Object.create(UniqueViolationError.prototype);
    const collidingCreate = jest.fn().mockRejectedValue(collision);
    await expect(
      createService(collidingCreate).createApiEnvironment({ repositoryFullName: 'org/repo', branch: 'main' })
    ).rejects.toMatchObject({ code: 'name_conflict' });
    expect(collidingCreate).toHaveBeenCalledTimes(3);
    validate.mockRestore();
  });

  test('createApiEnvironment persists explicit ownership, environment, and rollout options', async () => {
    const apiConfig = { enabled: true, defaultTtlHours: 72, maxTtlHours: 336, extensionHours: 24 };
    const repository = { id: 2, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 };
    const repositoryQuery: any = {
      whereRaw: jest.fn(() => repositoryQuery),
      whereNull: jest.fn(() => repositoryQuery),
      first: jest.fn().mockResolvedValue(repository),
    };
    const findById = jest.fn().mockResolvedValue({ id: 9 });
    const create = jest.fn().mockResolvedValue({ id: 7 });
    const service = serviceWith({
      models: {
        Repository: { query: jest.fn(() => repositoryQuery) },
        Environment: { query: jest.fn(() => ({ findById })) },
        Build: { create },
      },
    });
    jest.spyOn(service, 'getApiEnvironmentsConfig').mockResolvedValue(apiConfig);
    mockGetYamlFileContent.mockResolvedValue({ environment: { enabledFeatures: ['agent'] } });
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockReturnValue(true);
    const input = {
      repositoryFullName: 'org/repo',
      branch: 'main',
      environmentId: 9,
      name: 'explicit-api-env',
      services: [{ name: 'api' }],
      env: { RUNTIME: 'enabled' },
      initEnv: { INIT: 'enabled' },
      deployEnabled: false,
      trackDefaultBranches: true,
      createdByUserId: 'user-7',
      createdByGithubLogin: 'alice',
    };

    await expect(service.createApiEnvironment(input)).resolves.toMatchObject({
      replayed: false,
      build: expect.objectContaining({ id: 7, environmentId: 9, deployEnabled: false }),
    });

    expect(findById).toHaveBeenCalledWith(9);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 9,
        enabledFeatures: JSON.stringify(['agent']),
        trackDefaultBranches: true,
        deployEnabled: false,
        createdByUserId: 'user-7',
        createdByGithubLogin: 'alice',
        commentRuntimeEnv: { RUNTIME: 'enabled' },
        commentInitEnv: { INIT: 'enabled' },
      })
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'environment-create',
      expect.objectContaining({ buildId: 7, serviceOverrides: [{ name: 'api' }] }),
      { jobId: 'env-create-7' }
    );
    validate.mockRestore();
  });

  test('createApiEnvironment defaults enabled features when valid lifecycle YAML omits environment settings', async () => {
    const repository = { id: 2, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 };
    const repositoryQuery: any = {
      whereRaw: jest.fn(() => repositoryQuery),
      whereNull: jest.fn(() => repositoryQuery),
      first: jest.fn().mockResolvedValue(repository),
    };
    const create = jest.fn().mockResolvedValue({ id: 7 });
    const service = serviceWith({
      models: {
        Repository: { query: jest.fn(() => repositoryQuery) },
        Environment: { query: jest.fn(() => ({ findById: jest.fn().mockResolvedValue({ id: 5 }) })) },
        Build: { create },
      },
    });
    jest
      .spyOn(service, 'getApiEnvironmentsConfig')
      .mockResolvedValue({ enabled: true, defaultTtlHours: 72, maxTtlHours: 336, extensionHours: 24 });
    mockGetYamlFileContent.mockResolvedValue({ version: '1.0.0', services: [] });
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockReturnValue(true);

    await expect(
      service.createApiEnvironment({ repositoryFullName: 'org/repo', branch: 'main', name: 'no-env-settings' })
    ).resolves.toMatchObject({ replayed: false, build: expect.objectContaining({ id: 7 }) });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ enabledFeatures: '[]' }));
    validate.mockRestore();
  });

  test('createApiEnvironment re-enqueues service overrides for both collision and direct idempotent replays', async () => {
    const apiConfig = { enabled: true, defaultTtlHours: 72, maxTtlHours: 336, extensionHours: 24 };
    const input = {
      repositoryFullName: 'org/repo',
      branch: 'main',
      name: 'idempotent-api-env',
      idempotencyKey: 'request-7',
      createdByUserId: 'user-7',
      services: [{ name: 'api', active: false }],
    };
    const existing = {
      id: 7,
      uuid: 'idempotent-api-env',
      status: BuildStatus.QUEUED,
      githubRepositoryId: 42,
      idempotencyRequestDigest: computeIdempotencyRequestDigest(input),
    };
    const repository = { id: 2, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 };
    const repositoryQuery: any = {
      whereRaw: jest.fn(() => repositoryQuery),
      whereNull: jest.fn(() => repositoryQuery),
      first: jest.fn().mockResolvedValue(repository),
    };
    const collision = Object.create(UniqueViolationError.prototype);
    let storedBuild: typeof existing | null = null;
    const BuildModel = {
      query: jest.fn(() => lookupQuery(storedBuild)),
      create: jest.fn(async () => {
        storedBuild = existing;
        throw collision;
      }),
    };
    const service = serviceWith({
      models: {
        Build: BuildModel,
        Repository: { query: jest.fn(() => repositoryQuery) },
        Environment: { query: jest.fn(() => ({ findById: jest.fn().mockResolvedValue({ id: 5 }) })) },
      },
    });
    jest.spyOn(service, 'getApiEnvironmentsConfig').mockResolvedValue(apiConfig);
    mockGetYamlFileContent.mockResolvedValue({ environment: {} });
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockReturnValue(true);

    await expect(service.createApiEnvironment(input)).resolves.toEqual({ build: existing, replayed: true });
    await expect(service.createApiEnvironment(input)).resolves.toEqual({ build: existing, replayed: true });

    expect(BuildModel.create).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    for (const queueCall of [1, 2]) {
      expect(mockQueueAdd).toHaveBeenNthCalledWith(
        queueCall,
        'environment-create',
        expect.objectContaining({ buildId: 7, serviceOverrides: [{ name: 'api', active: false }] }),
        { jobId: 'env-create-7' }
      );
    }
    validate.mockRestore();
  });

  test.each([
    ['configuration read', 'Unable to read lifecycle.yaml from org/repo@main: unknown error'],
    ['configuration validation', 'lifecycle.yaml failed validation: unknown error'],
  ])('createApiEnvironment reports the exact unknown message for a non-Error %s failure', async (mode, message) => {
    const apiConfig = { enabled: true, defaultTtlHours: 72, maxTtlHours: 336, extensionHours: 24 };
    const repository = { id: 2, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 };
    const repositoryQuery: any = {
      whereRaw: jest.fn(() => repositoryQuery),
      whereNull: jest.fn(() => repositoryQuery),
      first: jest.fn().mockResolvedValue(repository),
    };
    const service = serviceWith({
      models: {
        Repository: { query: jest.fn(() => repositoryQuery) },
        Environment: { query: jest.fn(() => ({ findById: jest.fn().mockResolvedValue({ id: 5 }) })) },
      },
    });
    jest.spyOn(service, 'getApiEnvironmentsConfig').mockResolvedValue(apiConfig);
    const schemaFailure: unknown = 'schema rejected';
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockReturnValue(true);
    if (mode === 'configuration read') {
      mockGetYamlFileContent.mockRejectedValue('transport closed');
    } else {
      mockGetYamlFileContent.mockResolvedValue({ environment: {} });
      validate.mockImplementation(() => {
        throw schemaFailure;
      });
    }

    await expect(
      service.createApiEnvironment({ repositoryFullName: 'org/repo', branch: 'main' })
    ).rejects.toMatchObject({ code: 'config_invalid', message });

    validate.mockRestore();
  });

  test('handleApiEnvironmentCreateFailure contains a failed terminal-state backstop patch', async () => {
    const patchFailure = new Error('database unavailable');
    const logger = capturingLogger();
    const query: any = {
      patch: jest.fn(() => query),
      where: jest.fn(() => query),
      whereIn: jest.fn(() => query),
      then: (_resolve: (value: number) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.reject(patchFailure).catch(reject),
    };
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });

    await expect(
      service.handleApiEnvironmentCreateFailure(
        { attemptsMade: 3, opts: { attempts: 3 }, data: { buildId: 7 } } as any,
        new Error('create failed')
      )
    ).resolves.toBeUndefined();

    expect(query.patch).toHaveBeenCalledWith({
      status: BuildStatus.ERROR,
      statusMessage: 'Environment creation failed after 3 attempts: create failed',
    });
    expect(query.where).toHaveBeenCalledWith({ id: 7 });
    expect(query.whereIn).toHaveBeenCalledWith('status', [BuildStatus.QUEUED, BuildStatus.PENDING]);
    expect(logger.error).toHaveBeenCalledWith(
      { error: patchFailure },
      'Environment: failed-handler patch failed buildId=7'
    );
  });

  test('handleApiEnvironmentCreateFailure leaves an intermediate retry non-terminal', async () => {
    const query = jest.fn();
    const service = serviceWith({ models: { Build: { query } } });

    await expect(
      service.handleApiEnvironmentCreateFailure(
        { attemptsMade: 1, opts: { attempts: 3 }, data: { buildId: 7 } } as any,
        new Error('create failed')
      )
    ).resolves.toBeUndefined();

    expect(query).not.toHaveBeenCalled();
  });

  test('previewEnvironmentConfig exposes every unresolved-service reason as stable user-facing text', async () => {
    const repository = { id: 2, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 };
    const repositoryQuery: any = {
      whereRaw: jest.fn(() => repositoryQuery),
      whereNull: jest.fn(() => repositoryQuery),
      first: jest.fn().mockResolvedValue(repository),
    };
    const service = serviceWith({ models: { Repository: { query: jest.fn(() => repositoryQuery) } } });
    jest
      .spyOn(service, 'getApiEnvironmentsConfig')
      .mockResolvedValue({ enabled: true, defaultTtlHours: 72, maxTtlHours: 336, extensionHours: 24 });
    const config = {
      version: '1.0.0',
      environment: { defaultServices: [{ name: 'remote', repository: 'org/remote' }] },
      services: [],
    };
    const parse = jest.spyOn(YamlConfigParser.prototype, 'parseYamlConfigFromBranch').mockResolvedValue(config as any);
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockReturnValue(true);
    const reasons = [
      'repo_not_onboarded',
      'config_unavailable',
      'invalid_lifecycle_yaml',
      'service_name_missing',
      'max_references_exceeded',
      'future_reason',
    ];
    mockResolveEnvironmentServices.mockResolvedValue({
      services: [],
      unresolved: reasons.map((reason, index) => ({
        name: `service-${index}`,
        repository: 'org/remote',
        branch: 'main',
        status: 'unresolved',
        reason,
      })),
      truncated: false,
    });

    await expect(service.previewEnvironmentConfig('org/repo', 'main')).resolves.toMatchObject({
      valid: true,
      unresolved: [
        expect.objectContaining({ reason: 'Repository is not onboarded in Lifecycle.' }),
        expect.objectContaining({ reason: 'lifecycle.yaml was not found or is empty at this branch.' }),
        expect.objectContaining({ reason: 'lifecycle.yaml is invalid.' }),
        expect.objectContaining({ reason: 'Service reference is missing a name.' }),
        expect.objectContaining({ reason: 'Service resolution exceeded the maximum reference count.' }),
        expect.objectContaining({ reason: 'Service could not be resolved.' }),
      ],
    });
    expect(mockResolveEnvironmentServices).toHaveBeenCalledWith(
      expect.objectContaining({ rootRepository: repository, rootBranch: 'main', rootConfig: config })
    );
    parse.mockRestore();
    validate.mockRestore();
  });

  test('previewEnvironmentConfig reports an optional service-id reference as unsupported', async () => {
    const repository = { id: 2, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 };
    const repositoryQuery: any = {
      whereRaw: jest.fn(() => repositoryQuery),
      whereNull: jest.fn(() => repositoryQuery),
      first: jest.fn().mockResolvedValue(repository),
    };
    const service = serviceWith({ models: { Repository: { query: jest.fn(() => repositoryQuery) } } });
    jest
      .spyOn(service, 'getApiEnvironmentsConfig')
      .mockResolvedValue({ enabled: false, defaultTtlHours: 72, maxTtlHours: 336, extensionHours: 24 });
    const config = {
      version: '1.0.0',
      environment: { optionalServices: [{ name: 'remote', repository: 'org/remote', serviceId: 9 }] },
    };
    const parse = jest.spyOn(YamlConfigParser.prototype, 'parseYamlConfigFromBranch').mockResolvedValue(config as any);
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockReturnValue(true);
    const unresolved = {
      key: 'issue:org/repo@main:remote:service_id_not_supported',
      originalName: 'remote',
      name: 'remote',
      type: null,
      defaultActive: false,
      repository: 'org/repo',
      branch: 'main',
      resolvedFromRepositoryId: null,
      status: 'unresolved',
      reason: 'service_id_not_supported',
    };
    mockResolveEnvironmentServices.mockResolvedValue({
      services: [unresolved],
      unresolved: [unresolved],
      pending: [],
      truncated: false,
    });

    await expect(service.previewEnvironmentConfig('org/repo', 'main')).resolves.toEqual({
      valid: true,
      complete: true,
      pending: [],
      truncated: false,
      services: [
        {
          name: 'remote',
          type: null,
          defaultActive: false,
          editable: false,
          repository: 'org/repo',
          resolvedFromRepositoryId: null,
          status: 'unresolved',
          reason: 'serviceId references in lifecycle.yaml are no longer supported.',
        },
      ],
      unresolved: [
        {
          name: 'remote',
          repository: 'org/repo',
          branch: 'main',
          status: 'unresolved',
          reason: 'serviceId references in lifecycle.yaml are no longer supported.',
        },
      ],
    });

    expect(mockResolveEnvironmentServices).toHaveBeenCalledTimes(1);
    parse.mockRestore();
    validate.mockRestore();
  });

  test('previewEnvironmentConfig returns an empty legacy catalog when service arrays are omitted', async () => {
    const repository = { id: 2, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 };
    const repositoryQuery: any = {
      whereRaw: jest.fn(() => repositoryQuery),
      whereNull: jest.fn(() => repositoryQuery),
      first: jest.fn().mockResolvedValue(repository),
    };
    const service = serviceWith({ models: { Repository: { query: jest.fn(() => repositoryQuery) } } });
    const parse = jest
      .spyOn(YamlConfigParser.prototype, 'parseYamlConfigFromBranch')
      .mockResolvedValue({ version: '1.0.0', environment: {} } as any);
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockReturnValue(true);

    await expect(service.previewEnvironmentConfig('org/repo', 'main')).resolves.toEqual({
      valid: true,
      services: [],
    });

    expect(mockResolveEnvironmentServices).not.toHaveBeenCalled();
    parse.mockRestore();
    validate.mockRestore();
  });

  test('previewEnvironmentConfig uses a matching reference branch for a catalog service', async () => {
    const repository = { id: 2, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 };
    const repositoryQuery: any = {
      whereRaw: jest.fn(() => repositoryQuery),
      whereNull: jest.fn(() => repositoryQuery),
      first: jest.fn().mockResolvedValue(repository),
    };
    const service = serviceWith({ models: { Repository: { query: jest.fn(() => repositoryQuery) } } });
    const config = {
      version: '1.0.0',
      environment: {
        defaultServices: [{ name: 'remote', repository: 'org/remote', branch: 'feature' }],
      },
      services: [{ name: 'remote', github: { repository: 'org/remote', branchName: 'main' } }],
    };
    const parse = jest.spyOn(YamlConfigParser.prototype, 'parseYamlConfigFromBranch').mockResolvedValue(config as any);
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockReturnValue(false);

    await expect(service.previewEnvironmentConfig('org/repo', 'main')).resolves.toEqual({
      valid: false,
      services: [
        expect.objectContaining({
          name: 'remote',
          branchRepository: 'org/remote',
          branchConfigurationRepository: 'org/remote',
          effectiveBranch: 'feature',
        }),
      ],
    });

    parse.mockRestore();
    validate.mockRestore();
  });

  test('requestApiEnvironmentDeletion leaves an already-disabled deploy gate unchanged while claiming teardown', async () => {
    const patch = jest.fn().mockResolvedValue(1);
    const current: any = {
      id: 7,
      uuid: 'disabled-api-env',
      kind: BuildKind.ENVIRONMENT,
      triggerType: 'api',
      status: BuildStatus.DEPLOYED,
      deployEnabled: false,
      pullRequestId: null,
      $query: jest.fn(() => ({ patch })),
    };
    const lockedQuery: any = {
      findOne: jest.fn(() => lockedQuery),
      where: jest.fn(() => lockedQuery),
      whereNull: jest.fn(() => lockedQuery),
      forUpdate: jest.fn().mockResolvedValue(current),
    };
    const BuildModel = {
      transact: jest.fn(async (callback: (trx: object) => unknown) => callback({ transaction: true })),
      query: jest.fn(() => lockedQuery),
    };
    const service = serviceWith({ models: { Build: BuildModel } });

    await expect(service.requestApiEnvironmentDeletion('disabled-api-env', 7)).resolves.toBe(current);

    expect(patch).toHaveBeenCalledWith({
      status: BuildStatus.TEARING_DOWN,
      runUUID: 'build-teardown-7',
    });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'delete',
      expect.objectContaining({ buildId: 7, teardownRunUUID: 'build-teardown-7' }),
      expect.objectContaining({ jobId: 'build-delete-7-authoritative' })
    );
  });

  test('deleteBuild logs a Lifecycle error message without rethrowing by default', async () => {
    const logger = capturingLogger();
    const failure = new LifecycleError('lifecycle-env', null, 'cleanup failed');
    const build: any = {
      id: 7,
      uuid: 'lifecycle-env',
      reload: jest.fn().mockRejectedValue(failure),
    };
    const service = serviceWith({});

    await expect(service.deleteBuild(build, { deploymentLockAlreadyHeld: true })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith({ error: '[lifecycle-env] cleanup failed' }, 'Build: delete failed');
  });

  test.each([
    [
      'lease extended after the sweep read',
      'lease_expired',
      {
        kind: BuildKind.ENVIRONMENT,
        triggerType: 'api',
        status: BuildStatus.DEPLOYED,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        kind: BuildKind.ENVIRONMENT,
        triggerType: 'api',
        status: BuildStatus.DEPLOYED,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    [
      'another teardown owner won',
      'manual_destroy',
      { status: BuildStatus.TEARING_DOWN, runUUID: 'build-teardown-7' },
      { status: BuildStatus.TEARING_DOWN, runUUID: 'other-owner' },
    ],
    [
      'pull request authority returned',
      'pull_request_closed',
      { pullRequestId: 55, pullRequest: { status: 'closed', deployOnUpdate: true } },
      { pullRequestId: 55, pullRequest: { status: 'open', deployOnUpdate: true } },
    ],
    [
      'stuck-teardown ownership changed',
      'teardown_stuck',
      { pullRequestId: 55, runUUID: 'build-teardown-7', pullRequest: { status: 'closed', deployOnUpdate: true } },
      { pullRequestId: 55, runUUID: 'other-owner', pullRequest: { status: 'closed', deployOnUpdate: true } },
    ],
    ['the row disappeared', 'manual_destroy', {}, null],
  ])('processDeleteQueue does not clean up when %s', async (_case, reason, initialOverrides, lockedOverrides) => {
    const base = {
      id: 7,
      uuid: 'delete-race',
      deletedAt: null,
      status: BuildStatus.DEPLOYED,
      runUUID: 'build-teardown-7',
      pullRequestId: null,
      pullRequest: null,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(() => ({ patch: jest.fn().mockResolvedValue(1) })),
    };
    const initial = { ...base, ...(initialOverrides as object) };
    const locked = lockedOverrides == null ? null : { ...base, ...(lockedOverrides as object) };
    const queryFor = (result: any) => {
      const query: any = {
        findOne: jest.fn(() => query),
        findById: jest.fn(() => query),
        whereNull: jest.fn(() => query),
        forUpdate: jest.fn(() => query),
        then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return query;
    };
    const deleteBuild = jest.fn().mockResolvedValue(undefined);
    const BuildModel = {
      transact: jest.fn(async (callback: (trx: object) => unknown) => callback({ transaction: true })),
      query: jest.fn((trx?: object) => queryFor(trx ? locked : initial)),
    };
    const service = serviceWith({
      models: { Build: BuildModel },
      services: { BuildService: { deleteBuild } },
    });

    await expect(
      service.processDeleteQueue({
        data: { buildId: 7, buildUuid: 'delete-race', reason, teardownRunUUID: 'build-teardown-7' },
      } as any)
    ).resolves.toBeUndefined();

    expect(deleteBuild).not.toHaveBeenCalled();
    if (locked) expect(locked.$query).not.toHaveBeenCalled();
  });

  test.each([
    ['before cleanup starts', 2, false],
    ['after cleanup finishes', 3, true],
  ])('deleteBuild retains identity when teardown ownership changes %s', async (_case, loseOnReload, cleaned) => {
    const mutation: any = {
      patch: jest.fn(() => mutation),
      where: jest.fn(() => mutation),
      whereNull: jest.fn(() => mutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    let reloads = 0;
    const build: any = {
      id: 7,
      uuid: 'ownership-race',
      namespace: 'env-ownership-race',
      kind: BuildKind.SANDBOX,
      status: BuildStatus.DEPLOYED,
      runUUID: 'teardown-owner',
      pullRequestId: 55,
      pullRequest: { status: 'closed', deployOnUpdate: false },
      githubDeployments: false,
      deploys: [],
      idempotencyKey: 'retained-key',
      reload: jest.fn(async () => {
        reloads += 1;
        if (reloads === loseOnReload) build.runUUID = 'new-owner';
      }),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(() => ({ patch: jest.fn().mockResolvedValue(1) })),
    };
    const service = serviceWith({
      models: {
        Build: { query: jest.fn(() => mutation) },
        Deploy: { query: jest.fn(() => mutation) },
      },
      services: { Webhook: { webhookQueue: { add: jest.fn().mockResolvedValue(undefined) } } },
    });

    await service.deleteBuild(build, {
      deploymentLockAlreadyHeld: true,
      runUUID: 'teardown-owner',
      reason: 'pull_request_closed',
    } as any);

    expect(mockDeleteNamespace).toHaveBeenCalledTimes(cleaned ? 1 : 0);
    expect(mutation.patch).not.toHaveBeenCalledWith(expect.objectContaining({ status: BuildStatus.TORN_DOWN }));
    expect(build.$query.mock.results.flatMap(({ value }) => value.patch.mock.calls)).not.toContainEqual([
      { idempotencyKey: null },
    ]);
  });

  test('deployment reconciliation rejects corrupt persisted generations before mutation', async () => {
    const corrupt = { desiredGeneration: 'not-a-number', observedGeneration: 0, acceptedRefs: {} };
    const query = lookupQuery(corrupt);
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });

    await expect(
      service.processDeploymentReconciliationQueue({ data: { buildId: 7, generation: 3 } } as any)
    ).rejects.toThrow('Build 7 has invalid deployment generations');
  });

  test.each([
    ['the claim patch loses its row', 0, false],
    ['authority changes immediately after the claim', 1, true],
  ])('deployment reconciliation stops before configuration when %s', async (_case, claimedRows, staleAfterClaim) => {
    const build: any = {
      id: 7,
      uuid: 'claim-race',
      status: BuildStatus.DEPLOYED,
      deployEnabled: true,
      deletedAt: null,
      pullRequestId: null,
      pullRequest: null,
      desiredGeneration: 3,
      observedGeneration: 2,
      acceptedRefs: { all: { type: 'all', requestId: 'run-generation-3', gen: 3 } },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const stale = { ...build, runUUID: 'newer-run' };
    const mutation: any = {
      patch: jest.fn(() => mutation),
      where: jest.fn(() => mutation),
      whereNull: jest.fn(() => mutation),
      whereNotIn: jest.fn(() => mutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(claimedRows).then(resolve, reject),
    };
    const BuildModel = {
      query: jest.fn(() => {
        let authorityProjection = false;
        const query: any = {
          findById: jest.fn(() => query),
          findOne: jest.fn(() => query),
          select: jest.fn(() => {
            authorityProjection = true;
            return query;
          }),
          whereNull: jest.fn(() => query),
          patch: jest.fn(() => mutation),
          then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(authorityProjection && staleAfterClaim ? stale : build).then(resolve, reject),
        };
        return query;
      }),
    };
    const upsertDeployables = jest.fn();
    const service = serviceWith({
      models: { Build: BuildModel },
      services: { Deployable: { upsertDeployables } },
    });

    await expect(
      service.processDeploymentReconciliationQueue({ data: { buildId: 7, generation: 3 } } as any)
    ).resolves.toBeUndefined();

    expect(upsertDeployables).not.toHaveBeenCalled();
  });

  test('deployment reconciliation observes disabled builds without importing or deploying them', async () => {
    const build: any = {
      id: 7,
      uuid: 'disabled-build',
      status: BuildStatus.DEPLOYED,
      deployEnabled: false,
      deletedAt: null,
      pullRequestId: null,
      desiredGeneration: 3,
      observedGeneration: 2,
      acceptedRefs: { all: { type: 'all', requestId: 'run-generation-3', gen: 3 } },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const mutation: any = {
      patch: jest.fn(() => mutation),
      where: jest.fn(() => mutation),
      whereNull: jest.fn(() => mutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const query: any = {
      findById: jest.fn(() => query),
      findOne: jest.fn(() => query),
      whereNull: jest.fn(() => query),
      patch: jest.fn(() => mutation),
      then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(build).then(resolve, reject),
    };
    const upsertDeployables = jest.fn();
    const service = serviceWith({
      models: { Build: { query: jest.fn(() => query) } },
      services: { Deployable: { upsertDeployables } },
    });

    await service.processDeploymentReconciliationQueue({ data: { buildId: 7, generation: 3 } } as any);

    expect(query.patch).toHaveBeenCalledWith({ observedGeneration: 3 });
    expect(upsertDeployables).not.toHaveBeenCalled();
  });

  test('deployment reconciliation records and observes a claimed configuration parse failure', async () => {
    const parseError = new ParsingError('invalid lifecycle yaml');
    const build: any = {
      id: 7,
      uuid: 'invalid-config-build',
      namespace: 'env-invalid-config-build',
      kind: BuildKind.SANDBOX,
      status: BuildStatus.DEPLOYED,
      statusMessage: '',
      runUUID: 'prior-run',
      deployEnabled: true,
      deletedAt: null,
      pullRequestId: null,
      pullRequest: null,
      environment: { id: 5 },
      desiredGeneration: 3,
      observedGeneration: 2,
      acceptedRefs: { all: { type: 'all', requestId: 'run-generation-3', gen: 3 } },
      deploys: [],
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const buildMutation: any = {
      where: jest.fn(() => buildMutation),
      whereNull: jest.fn(() => buildMutation),
      whereNotIn: jest.fn(() => buildMutation),
      patch: jest.fn(() => buildMutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const BuildModel = {
      query: jest.fn(() => {
        const query: any = {
          findById: jest.fn(() => query),
          findOne: jest.fn(() => query),
          select: jest.fn(() => query),
          whereNull: jest.fn(() => query),
          patch: jest.fn((value: Record<string, unknown>) => {
            buildMutation.patch(value);
            return buildMutation;
          }),
          then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(build).then(resolve, reject),
        };
        return query;
      }),
    };
    const upsertDeployables = jest.fn().mockRejectedValue(parseError);
    const findOrCreateDeploys = jest.fn();
    const service = serviceWith({
      models: { Build: BuildModel },
      services: {
        Deployable: { upsertDeployables },
        Deploy: { findOrCreateDeploys },
        Webhook: { webhookQueue: { add: jest.fn() } },
      },
    });

    await expect(
      service.processDeploymentReconciliationQueue({
        data: { buildId: 7, generation: 3 },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any)
    ).resolves.toBeUndefined();

    expect(upsertDeployables).toHaveBeenCalledTimes(1);
    expect(findOrCreateDeploys).not.toHaveBeenCalled();
    expect(buildMutation.patch).toHaveBeenCalledWith({
      status: BuildStatus.CONFIG_ERROR,
      statusMessage: 'invalid lifecycle yaml',
    });
    expect(buildMutation.patch).toHaveBeenCalledWith({ observedGeneration: 3 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('processDeploymentReconciliationQueue carries one durable generation through rollout and observation', async () => {
    const build: any = {
      id: 7,
      uuid: 'reconciled-build',
      namespace: 'env-reconciled-build',
      kind: BuildKind.SANDBOX,
      status: BuildStatus.DEPLOYED,
      statusMessage: '',
      runUUID: 'prior-run',
      deployEnabled: true,
      deletedAt: null,
      pullRequestId: null,
      pullRequest: null,
      environment: { id: 5 },
      desiredGeneration: 3,
      observedGeneration: 2,
      acceptedRefs: {
        'repository:42': {
          type: 'repository',
          requestId: 'run-generation-3',
          githubRepositoryId: 42,
          gen: 3,
        },
      },
      deploys: [],
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $setRelated: jest.fn((_relation: string, related: any[]) => {
        build.deploys = related;
      }),
    };
    const buildMutation: any = {
      where: jest.fn(() => buildMutation),
      whereNull: jest.fn(() => buildMutation),
      whereNotIn: jest.fn(() => buildMutation),
      patch: jest.fn(() => buildMutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const buildQuery: any = {
      findById: jest.fn(() => buildQuery),
      findOne: jest.fn(() => buildQuery),
      select: jest.fn(() => buildQuery),
      whereNull: jest.fn(() => buildQuery),
      patch: jest.fn((value: Record<string, unknown>) => {
        buildMutation.patch(value);
        return buildMutation;
      }),
      then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(build).then(resolve, reject),
    };
    const deployMutation: any = {
      patch: jest.fn(() => deployMutation),
      where: jest.fn(() => deployMutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const noDeploys: any = {
      where: jest.fn(() => noDeploys),
      withGraphFetched: jest.fn().mockResolvedValue([]),
    };
    mockDeployQuery.mockReturnValue(noDeploys);
    const upsertDeployables = jest.fn().mockResolvedValue({ canReconcile: false });
    const findOrCreateDeploys = jest.fn().mockResolvedValue([]);
    const upsertWebhooksWithYaml = jest.fn().mockResolvedValue(undefined);
    const service = serviceWith({
      models: {
        Build: { query: jest.fn(() => buildQuery) },
        Deploy: { query: jest.fn(() => deployMutation) },
      },
      services: {
        Deployable: { upsertDeployables },
        Deploy: { findOrCreateDeploys },
        Webhook: {
          upsertWebhooksWithYaml,
          webhookQueue: { add: jest.fn().mockResolvedValue(undefined) },
        },
      },
    });

    await expect(
      service.processDeploymentReconciliationQueue({
        data: { buildId: 7, generation: 3 },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any)
    ).resolves.toBeUndefined();

    expect(upsertDeployables).toHaveBeenCalledWith(
      7,
      'reconciled-build',
      null,
      build.environment,
      build,
      42,
      undefined,
      undefined,
      42
    );
    expect(findOrCreateDeploys).toHaveBeenCalledWith(build.environment, build, 42, undefined, undefined, 42);
    expect(buildMutation.patch.mock.calls.map(([value]) => value.status).filter(Boolean)).toEqual([
      BuildStatus.PENDING,
      BuildStatus.BUILDING,
      BuildStatus.DEPLOYING,
      BuildStatus.DEPLOYED,
    ]);
    expect(buildMutation.patch).toHaveBeenCalledWith({ observedGeneration: 3 });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'manifest',
      expect.objectContaining({ buildId: 7, runUUID: 'run-generation-3', expectedGeneration: 3 })
    );
    expect(build).toMatchObject({ runUUID: 'run-generation-3', status: BuildStatus.DEPLOYED });
  });

  test('deployment reconciliation propagates an accepted root-source SHA through YAML and rollout', async () => {
    const intent = {
      type: 'source',
      requestId: 'run-generation-3',
      target: 'all',
      githubRepositoryId: 42,
      branch: 'main',
      sha: 'commit-c',
      beforeSha: 'commit-b',
      gen: 3,
    };
    (github.getSHAForBranch as jest.Mock).mockResolvedValue('commit-c');
    const harness = publicReconciliationHarness({ intent, repository: { fullName: 'org/repo' } });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(github.getSHAForBranch).toHaveBeenCalledWith('main', 'org', 'repo');
    expect(github.compareCommits).not.toHaveBeenCalled();
    expect(harness.upsertDeployables).toHaveBeenCalledWith(
      7,
      'stateful-reconciliation',
      null,
      harness.build.environment,
      harness.build,
      undefined,
      'commit-c',
      'main',
      42
    );
    expect(harness.upsertWebhooksWithYaml).toHaveBeenCalledWith(harness.build, null, 'commit-c');
    expect(harness.findOrCreateDeploys).toHaveBeenCalledWith(
      harness.build.environment,
      harness.build,
      undefined,
      'commit-c',
      'main',
      42
    );
    expect(harness.buildPatch).toHaveBeenCalledWith({ observedGeneration: 3 });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'manifest',
      expect.objectContaining({ buildId: 7, runUUID: 'run-generation-3', expectedGeneration: 3 })
    );
  });

  test('deployment reconciliation keeps the accepted source when its repository was removed', async () => {
    const intent = {
      type: 'source',
      requestId: 'run-generation-3',
      target: 'all',
      githubRepositoryId: 42,
      branch: 'main',
      sha: 'commit-c',
      gen: 3,
    };
    const harness = publicReconciliationHarness({ intent, repository: null });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(harness.repositoryQuery.findOne).toHaveBeenCalledWith({ githubRepositoryId: 42 });
    expect(github.getSHAForBranch).not.toHaveBeenCalled();
    expect(harness.upsertDeployables).toHaveBeenCalledWith(
      7,
      'stateful-reconciliation',
      null,
      harness.build.environment,
      harness.build,
      undefined,
      'commit-c',
      'main',
      42
    );
    expect(harness.buildPatch).toHaveBeenCalledWith({ observedGeneration: 3 });
  });

  test('deployment reconciliation scopes a source update to the matching repository and branch', async () => {
    const matching = { id: 11, githubRepositoryId: 42, branchName: 'main' };
    const otherBranch = { id: 12, githubRepositoryId: 42, branchName: 'release' };
    const otherRepository = { id: 13, githubRepositoryId: 99, branchName: 'main' };
    const harness = publicReconciliationHarness({
      intent: {
        type: 'source',
        requestId: 'run-generation-3',
        target: 'repository',
        githubRepositoryId: 42,
        branch: 'main',
        sha: 'commit-c',
        gen: 3,
      },
      repository: null,
      deploys: [matching, otherBranch, otherRepository],
    });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(harness.findOrCreateDeploys).toHaveBeenCalledWith(
      harness.build.environment,
      harness.build,
      42,
      'commit-c',
      'main',
      42
    );
    expect(harness.deployMutation.where).toHaveBeenCalledWith('githubRepositoryId', 42);
    expect(harness.deployMutation.where).toHaveBeenCalledWith('branchName', 'main');
    expect(matching).toHaveProperty('runUUID', 'run-generation-3');
    expect(otherBranch).not.toHaveProperty('runUUID');
    expect(otherRepository).not.toHaveProperty('runUUID');
    expect(harness.buildPatch).toHaveBeenCalledWith({ observedGeneration: 3 });
  });

  test('deployment reconciliation stops when its mailbox generation is observed during lock acquisition', async () => {
    const acquiredResources: string[] = [];
    const harness = publicReconciliationHarness({
      onLockAcquired: (resource, build) => {
        acquiredResources.push(resource);
        if (resource === 'build-deployment.7') build.observedGeneration = 3;
      },
    });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(harness.buildPatch).not.toHaveBeenCalled();
    expect(harness.upsertDeployables).not.toHaveBeenCalled();
    expect(harness.build.$fetchGraph).not.toHaveBeenCalled();
    expect(acquiredResources).toEqual(['build-reconcile.7.3', 'build-deployment.7']);
  });

  test('deployment reconciliation stops when authority moves after configuration-lock admission', async () => {
    const harness = publicReconciliationHarness({
      authorityResult: (read, build) => (read >= 4 ? { ...build, runUUID: 'newer-run' } : build),
    });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(harness.upsertDeployables).not.toHaveBeenCalled();
    expect(harness.findOrCreateDeploys).not.toHaveBeenCalled();
    expect(harness.buildPatch.mock.calls.map(([value]) => value.status).filter(Boolean)).toEqual([BuildStatus.PENDING]);
    expect(harness.buildPatch).not.toHaveBeenCalledWith({ observedGeneration: 3 });
  });

  test('deployment reconciliation stops when the build disappears after its mailbox claim', async () => {
    const harness = publicReconciliationHarness({ loadResult: () => null });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(harness.buildPatch).not.toHaveBeenCalled();
    expect(harness.upsertDeployables).not.toHaveBeenCalled();
    expect(harness.build.$fetchGraph).not.toHaveBeenCalled();
  });

  test('deployment reconciliation stops after YAML import when another run takes authority', async () => {
    let current = true;
    const harness = publicReconciliationHarness({
      authorityResult: (_read, build) => (current ? build : { ...build, runUUID: 'newer-run' }),
      onYamlImported: () => {
        current = false;
      },
    });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(harness.upsertDeployables).toHaveBeenCalledTimes(1);
    expect(harness.upsertWebhooksWithYaml).toHaveBeenCalledTimes(1);
    expect(harness.findOrCreateDeploys).not.toHaveBeenCalled();
    expect(harness.buildPatch.mock.calls.map(([value]) => value.status).filter(Boolean)).toEqual([BuildStatus.PENDING]);
    expect(harness.buildPatch).not.toHaveBeenCalledWith({ observedGeneration: 3 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('deployment reconciliation stops after deploy association when another run takes authority', async () => {
    let current = true;
    const harness = publicReconciliationHarness({
      authorityResult: (_read, build) => (current ? build : { ...build, runUUID: 'newer-run' }),
      onDeploysAssociated: () => {
        current = false;
      },
    });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(harness.upsertDeployables).toHaveBeenCalledTimes(1);
    expect(harness.findOrCreateDeploys).toHaveBeenCalledTimes(1);
    expect(harness.build.$setRelated).toHaveBeenCalledWith('deploys', []);
    expect(harness.buildPatch.mock.calls.map(([value]) => value.status).filter(Boolean)).toEqual([BuildStatus.PENDING]);
    expect(harness.buildPatch).not.toHaveBeenCalledWith({ observedGeneration: 3 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('deployment reconciliation stops before execution when authority moves after graph generation', async () => {
    let current = true;
    const harness = publicReconciliationHarness({
      authorityResult: (_read, build) => (current ? build : { ...build, runUUID: 'newer-run' }),
      onGraphGenerated: () => {
        current = false;
      },
    });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(harness.findOrCreateDeploys).toHaveBeenCalledTimes(1);
    expect(harness.buildPatch.mock.calls.map(([value]) => value.status).filter(Boolean)).toEqual([
      BuildStatus.PENDING,
      BuildStatus.BUILDING,
    ]);
    expect(harness.buildPatch).not.toHaveBeenCalledWith({ observedGeneration: 3 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('deployment reconciliation stops before execution when authority moves after the configuration lock releases', async () => {
    const harness = publicReconciliationHarness({
      authorityResult: (read, build) => (read >= 8 ? { ...build, runUUID: 'newer-run' } : build),
    });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(harness.upsertDeployables).toHaveBeenCalledTimes(1);
    expect(harness.findOrCreateDeploys).toHaveBeenCalledTimes(1);
    expect(harness.buildPatch.mock.calls.map(([value]) => value.status).filter(Boolean)).toEqual([
      BuildStatus.PENDING,
      BuildStatus.BUILDING,
    ]);
    expect(harness.buildPatch).not.toHaveBeenCalledWith({ observedGeneration: 3 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('deployment reconciliation stops after scope execution when authority moves before publication', async () => {
    const harness = publicReconciliationHarness({
      authorityResult: (read, build) => (read >= 16 ? { ...build, runUUID: 'newer-run' } : build),
    });

    await expect(harness.service.processDeploymentReconciliationQueue(harness.job)).resolves.toBeUndefined();

    expect(harness.upsertDeployables).toHaveBeenCalledTimes(1);
    expect(harness.findOrCreateDeploys).toHaveBeenCalledTimes(1);
    expect(harness.buildPatch.mock.calls.map(([value]) => value.status).filter(Boolean)).toEqual([
      BuildStatus.PENDING,
      BuildStatus.BUILDING,
      BuildStatus.DEPLOYING,
    ]);
    expect(harness.buildPatch).not.toHaveBeenCalledWith({ observedGeneration: 3 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('deployment reconciliation treats omitted queue attempt metadata as one final attempt', async () => {
    const failure = new Error('deployable import unavailable');
    const harness = publicReconciliationHarness({ yamlFailure: failure });

    await expect(
      harness.service.processDeploymentReconciliationQueue({ data: harness.job.data } as any)
    ).resolves.toBeUndefined();

    expect(harness.upsertDeployables).toHaveBeenCalledTimes(1);
    expect(harness.findOrCreateDeploys).not.toHaveBeenCalled();
    expect(harness.buildPatch).toHaveBeenCalledWith({
      status: BuildStatus.ERROR,
      statusMessage: 'deployable import unavailable',
    });
    expect(harness.buildPatch).toHaveBeenCalledWith({ observedGeneration: 3 });
  });

  test('deployment reconciliation reacquires authority to publish a final pre-active read failure', async () => {
    const failure = new Error('build authority read unavailable');
    let databaseRecovered = false;
    const harness = publicReconciliationHarness({
      loadResult: (_read, build) => {
        if (!databaseRecovered) {
          databaseRecovered = true;
          throw failure;
        }
        return build;
      },
    });

    await expect(
      harness.service.processDeploymentReconciliationQueue({ data: harness.job.data } as any)
    ).resolves.toBeUndefined();

    expect(harness.upsertDeployables).not.toHaveBeenCalled();
    expect(harness.buildPatch).toHaveBeenCalledWith({
      status: BuildStatus.ERROR,
      statusMessage: 'build authority read unavailable',
    });
    expect(harness.buildPatch).toHaveBeenCalledWith({ observedGeneration: 3 });
  });

  test('deployment reconciliation contains a pre-active failure when the build is deleted before reclaim', async () => {
    const failure = new Error('build authority read unavailable');
    let readFailed = false;
    let deleted = false;
    const harness = publicReconciliationHarness({
      mailboxResult: (_read, build) => (deleted ? null : build),
      loadResult: (_read, build) => {
        if (!readFailed) {
          readFailed = true;
          throw failure;
        }
        return deleted ? null : build;
      },
      onLockAcquired: (resource, build) => {
        if (resource === 'build-deployment.7' && readFailed) {
          deleted = true;
          build.deletedAt = new Date().toISOString();
        }
      },
    });

    await expect(
      harness.service.processDeploymentReconciliationQueue({ data: harness.job.data } as any)
    ).resolves.toBeUndefined();

    expect(deleted).toBe(true);
    expect(harness.upsertDeployables).not.toHaveBeenCalled();
    expect(harness.buildPatch).not.toHaveBeenCalledWith(expect.objectContaining({ status: BuildStatus.ERROR }));
    expect(harness.buildPatch).not.toHaveBeenCalledWith({ observedGeneration: 3 });
  });

  test.each([
    ['before YAML import', 4, 0, 0],
    ['after YAML import', 5, 1, 0],
    ['after deploy association', 6, 1, 1],
  ])(
    'createBuild stops %s when post-claim setup authority moves to another run',
    async (_stage, loseAuthorityOnRead, expectedImports, expectedDeployLookups) => {
      const mutation: any = {
        where: jest.fn(() => mutation),
        whereNull: jest.fn(() => mutation),
        then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(1).then(resolve, reject),
      };
      const deploys = [{ id: 11, uuid: 'app' }];
      const build: any = {
        id: 7,
        uuid: 'post-claim-race',
        kind: BuildKind.SANDBOX,
        status: BuildStatus.QUEUED,
        deletedAt: null,
        runUUID: null,
        pullRequestId: 55,
        pullRequest: { status: 'open', deployOnUpdate: true },
        deploys: [],
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
        $setRelated: jest.fn((_relation: string, related: any[]) => {
          build.deploys = related;
        }),
      };
      const supersedingBuild: any = {
        ...build,
        runUUID: 'new-run-owner',
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };
      let authorityReads = 0;
      const buildQuery: any = {
        where: jest.fn(() => buildQuery),
        whereNull: jest.fn(() => buildQuery),
        first: jest.fn().mockResolvedValue(build),
        findOne: jest.fn(async () => {
          authorityReads += 1;
          return authorityReads >= loseAuthorityOnRead ? supersedingBuild : build;
        }),
        patch: jest.fn(() => mutation),
      };
      const upsertDeployables = jest.fn().mockResolvedValue({ canReconcile: false });
      const findOrCreateDeploys = jest.fn().mockResolvedValue(deploys);
      const upsertWebhooksWithYaml = jest.fn().mockResolvedValue(undefined);
      const service = serviceWith({
        models: { Build: { query: jest.fn(() => buildQuery) } },
        services: {
          Deployable: { upsertDeployables },
          Deploy: { findOrCreateDeploys },
          Webhook: { upsertWebhooksWithYaml },
        },
      });

      await expect(
        service.createBuild(
          { id: 5 } as any,
          { pullRequestId: 55, repositoryId: 2, repositoryBranchName: 'feature' },
          {} as any
        )
      ).resolves.toBeUndefined();

      expect(upsertDeployables).toHaveBeenCalledTimes(expectedImports);
      expect(upsertWebhooksWithYaml).toHaveBeenCalledTimes(expectedImports);
      expect(findOrCreateDeploys).toHaveBeenCalledTimes(expectedDeployLookups);
      expect(build.$setRelated).toHaveBeenCalledTimes(expectedDeployLookups);
      expect(buildQuery.patch).toHaveBeenCalledTimes(1);
      expect(buildQuery.patch).not.toHaveBeenCalledWith(expect.objectContaining({ status: expect.anything() }));
    }
  );

  test('createBuild records a fenced failure when deploy discovery returns no result', async () => {
    const mutation: any = {
      patch: jest.fn(() => mutation),
      where: jest.fn(() => mutation),
      whereNull: jest.fn(() => mutation),
      whereNotIn: jest.fn(() => mutation),
      then: (resolve: (value: number) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const build: any = {
      id: 7,
      uuid: 'missing-deploy-result',
      kind: BuildKind.SANDBOX,
      status: BuildStatus.QUEUED,
      deletedAt: null,
      runUUID: null,
      pullRequestId: 55,
      pullRequest: { status: 'open', deployOnUpdate: true },
      deploys: [],
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $setRelated: jest.fn(),
    };
    const buildQuery: any = {
      where: jest.fn(() => buildQuery),
      whereNull: jest.fn(() => buildQuery),
      first: jest.fn().mockResolvedValue(build),
      findOne: jest.fn().mockResolvedValue(build),
      patch: jest.fn((value: Record<string, unknown>) => {
        mutation.patch(value);
        return mutation;
      }),
    };
    const findOrCreateDeploys = jest.fn().mockResolvedValue(null);
    const service = serviceWith({
      models: { Build: { query: jest.fn(() => buildQuery) } },
      services: {
        Deployable: { upsertDeployables: jest.fn().mockResolvedValue({ canReconcile: false }) },
        Deploy: { findOrCreateDeploys },
        Webhook: {
          upsertWebhooksWithYaml: jest.fn().mockResolvedValue(undefined),
          webhookQueue: { add: jest.fn().mockResolvedValue(undefined) },
        },
      },
    });

    await expect(
      service.createBuild(
        { id: 5 } as any,
        { pullRequestId: 55, repositoryId: 2, repositoryBranchName: 'feature' },
        {} as any
      )
    ).resolves.toBeUndefined();

    const failureMessage = '[BUILD 7] [5] Unable to find or create deploys by using build and environment.';
    expect(findOrCreateDeploys).toHaveBeenCalledTimes(1);
    expect(build.$setRelated).not.toHaveBeenCalled();
    expect(mutation.patch).toHaveBeenCalledWith({ status: BuildStatus.ERROR, statusMessage: failureMessage });
    expect(build).toMatchObject({ status: BuildStatus.ERROR, statusMessage: failureMessage });
  });

  test('buildImages rejects a native build before infrastructure mutation when the run is superseded', async () => {
    const deploy = {
      id: 11,
      uuid: 'superseded-native-app',
      active: true,
      deployable: { type: DeployTypes.DOCKER, builder: { engine: 'buildkit' } },
    };
    const deployRead: any = {
      where: jest.fn(() => deployRead),
      withGraphFetched: jest.fn().mockResolvedValue([deploy]),
    };
    mockDeployQuery.mockReturnValue(deployRead);
    const supersedingBuild = {
      id: 7,
      runUUID: 'new-run',
      status: BuildStatus.PENDING,
      deployEnabled: true,
      deletedAt: null,
      pullRequestId: null,
      desiredGeneration: 5,
    };
    const currentQuery = lookupQuery(supersedingBuild);
    const buildImage = jest.fn();
    const service = serviceWith({
      models: { Build: { query: jest.fn(() => currentQuery) } },
      services: { Deploy: { buildImage } },
    });
    const build: any = {
      id: 7,
      uuid: 'superseded-native-build',
      namespace: 'env-superseded-native-build',
      runUUID: 'old-run',
      desiredGeneration: 4,
      isStatic: false,
      pullRequest: null,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(service.buildImages(build, 'old-run', null, 'sha-a', 'main', 4)).rejects.toBeInstanceOf(
      DeploymentSupersededError
    );

    const kubernetes = jest.requireMock('server/lib/kubernetes');
    expect(kubernetes.createOrUpdateNamespace).not.toHaveBeenCalled();
    expect(buildImage).not.toHaveBeenCalled();
  });

  test('generateAndApplyManifests rejects a superseded run before namespace or deploy reads', async () => {
    const supersedingBuild = {
      id: 7,
      runUUID: 'new-run',
      status: BuildStatus.PENDING,
      deployEnabled: true,
      deletedAt: null,
      pullRequestId: null,
      desiredGeneration: 5,
    };
    const currentQuery = lookupQuery(supersedingBuild);
    const service = serviceWith({ models: { Build: { query: jest.fn(() => currentQuery) } } });
    const build: any = {
      id: 7,
      uuid: 'superseded-manifest-build',
      namespace: 'env-superseded-manifest-build',
      kind: BuildKind.SANDBOX,
      runUUID: 'old-run',
      desiredGeneration: 4,
      isStatic: false,
      pullRequest: null,
    };

    await expect(
      service.generateAndApplyManifests({
        build,
        runUUID: 'old-run',
        expectedGeneration: 4,
        githubRepositoryId: null,
        namespace: build.namespace,
      })
    ).rejects.toBeInstanceOf(DeploymentSupersededError);

    const kubernetes = jest.requireMock('server/lib/kubernetes');
    expect(kubernetes.createOrUpdateNamespace).not.toHaveBeenCalled();
    expect(mockDeployQuery).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('handleApiEnvironmentCreateFailure ignores an exhausted malformed job without a build id', async () => {
    const query = jest.fn();
    const service = serviceWith({ models: { Build: { query } } });

    await expect(
      service.handleApiEnvironmentCreateFailure(
        { attemptsMade: 3, opts: { attempts: 3 }, data: {} } as any,
        new Error('create failed')
      )
    ).resolves.toBeUndefined();

    expect(query).not.toHaveBeenCalled();
  });

  test('processDeploymentReconciliationQueue treats a missing build as an idempotent no-op', async () => {
    const buildQuery = lookupQuery(null);
    const BuildModel = { query: jest.fn(() => buildQuery) };
    const service = serviceWith({ models: { Build: BuildModel } });

    await expect(
      service.processDeploymentReconciliationQueue({ data: { buildId: 7, generation: 3 } } as any)
    ).resolves.toBeUndefined();

    expect(BuildModel.query).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('createApiEnvironment does not retry a generated name after a non-unique insert failure', async () => {
    const apiConfig = { enabled: true, defaultTtlHours: 72, maxTtlHours: 336, extensionHours: 24 };
    const repository = { id: 2, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 };
    const repositoryQuery: any = {
      whereRaw: jest.fn(() => repositoryQuery),
      whereNull: jest.fn(() => repositoryQuery),
      first: jest.fn().mockResolvedValue(repository),
    };
    const environment = { id: 5 };
    const insertFailure = new Error('database unavailable');
    const create = jest.fn().mockRejectedValue(insertFailure);
    const service = serviceWith({
      models: {
        Repository: { query: jest.fn(() => repositoryQuery) },
        Environment: { query: jest.fn(() => ({ findById: jest.fn().mockResolvedValue(environment) })) },
        Build: { create },
      },
    });
    jest.spyOn(service, 'getApiEnvironmentsConfig').mockResolvedValue(apiConfig);
    mockGetYamlFileContent.mockResolvedValue({ version: '1.0.0', environment: {} });
    const validate = jest.spyOn(YamlConfigValidator.prototype, 'validate').mockReturnValue(true);

    await expect(service.createApiEnvironment({ repositoryFullName: 'org/repo', branch: 'main' })).rejects.toBe(
      insertFailure
    );

    expect(create).toHaveBeenCalledTimes(1);
    validate.mockRestore();
  });

  test('processDeleteQueue stops before cleanup when teardown ownership changes after the deletion claim', async () => {
    const logger = capturingLogger();
    const initial: any = {
      id: 7,
      uuid: 'promotion-race-build',
      deletedAt: null,
      status: BuildStatus.DEPLOYED,
      runUUID: 'prior-run',
      pullRequestId: null,
      pullRequest: null,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const claimPatch = jest.fn().mockResolvedValue(1);
    const claimed: any = {
      ...initial,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(() => ({ patch: claimPatch })),
    };
    const superseded: any = {
      ...initial,
      status: BuildStatus.TEARING_DOWN,
      runUUID: 'new-teardown-owner',
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const authorityQuery = (result: any) => {
      const query: any = {
        findOne: jest.fn(() => query),
        findById: jest.fn(() => query),
        whereNull: jest.fn(() => query),
        forUpdate: jest.fn(() => query),
        then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return query;
    };
    let claimFinished = false;
    const BuildModel = {
      transact: jest.fn(async (callback: (trx: object) => unknown) => {
        const result = await callback({ transaction: true });
        claimFinished = true;
        return result;
      }),
      query: jest.fn((trx?: object) => authorityQuery(trx ? claimed : claimFinished ? superseded : initial)),
    };
    const deleteBuild = jest.fn().mockResolvedValue(undefined);
    const service = serviceWith({
      models: { Build: BuildModel },
      services: { BuildService: { deleteBuild } },
    });

    await expect(
      service.processDeleteQueue({
        data: {
          buildId: 7,
          buildUuid: 'promotion-race-build',
          reason: 'manual_destroy',
          teardownRunUUID: 'build-teardown-7',
        },
      } as any)
    ).resolves.toBeUndefined();

    expect(claimPatch).toHaveBeenCalledWith({
      runUUID: 'build-teardown-7',
      status: BuildStatus.TEARING_DOWN,
      deployEnabled: false,
    });
    expect(deleteBuild).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Build: delete skipped reason=teardown_authority_lost');
  });

  test.each([
    {
      name: 'build promotion',
      resource: 'build-promotion.41',
      ttlMs: 15 * 60 * 1000,
      warning: 'Build promotion: waiting for admitted native mutation',
      context: (error: Error) => ({ error, buildId: 41 }),
      run: (service: BuildService, isCurrent: () => Promise<boolean>, action: () => Promise<string>) =>
        service.withCurrentBuildPromotionLock(41, isCurrent, action),
    },
    {
      name: 'deploy secret mutation',
      resource: 'deploy-external-secrets.73',
      ttlMs: 2 * 60 * 1000,
      warning: 'Deploy secrets: waiting for current resource writer',
      context: (error: Error) => ({ error, deployId: 73 }),
      run: (service: BuildService, isCurrent: () => Promise<boolean>, action: () => Promise<string>) =>
        service.withCurrentDeploySecretMutationLock(73, isCurrent, action),
    },
  ])('$name lock reports sustained contention, retries, and runs the admitted action once', async (scenario) => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const waitError = new Error(`${scenario.name} is contended`);
    const logger = capturingLogger();
    const { acquiredLock, lockWithOptions, redlock } = contendedAuthorityRedlock(waitError);
    const service = serviceWith({}, redlock);
    const isCurrent = jest.fn().mockResolvedValue(true);
    const action = jest.fn().mockResolvedValue('completed');

    const result = scenario.run(service, isCurrent, action);
    await passOneContentionRetry(lockWithOptions);

    await expect(result).resolves.toEqual({ admitted: true, value: 'completed' });
    expect(lockWithOptions).toHaveBeenCalledTimes(2);
    expect(lockWithOptions).toHaveBeenNthCalledWith(1, scenario.resource, scenario.ttlMs, {
      retryCount: 4,
      retryDelay: 1000,
      retryJitter: 200,
    });
    expect(redlock.lock).not.toHaveBeenCalled();
    expect(isCurrent).toHaveBeenCalledTimes(5);
    expect(action).toHaveBeenCalledTimes(1);
    expect(lockWithOptions.mock.invocationCallOrder[1]).toBeLessThan(action.mock.invocationCallOrder[0]);
    expect(acquiredLock.unlock).toHaveBeenCalledTimes(1);
    expect(mockedGetLogger).toHaveBeenCalledWith(scenario.context(waitError));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(scenario.warning);
  });

  test('generateAndApplyManifests reports deployment-lock contention before preparing the current run', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const waitError = new Error('configuration mutation is still running');
    const logger = capturingLogger();
    const { acquiredLock, lockWithOptions, redlock } = contendedAuthorityRedlock(waitError);
    const noDeploys: any = {
      where: jest.fn(() => noDeploys),
      withGraphFetched: jest.fn().mockResolvedValue([]),
    };
    mockDeployQuery.mockReturnValue(noDeploys);
    const build: any = {
      id: 7,
      uuid: 'contended-manifest-build',
      namespace: 'env-contended-manifest-build',
      kind: BuildKind.SANDBOX,
      runUUID: 'run-contended-manifest',
      status: BuildStatus.PENDING,
      deployEnabled: true,
      deletedAt: null,
      pullRequestId: null,
      desiredGeneration: 4,
      isStatic: false,
      pullRequest: null,
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const currentBuildQuery = lookupQuery(build);
    const service = serviceWith({ models: { Build: { query: jest.fn(() => currentBuildQuery) } } }, redlock);

    const result = service.generateAndApplyManifests({
      build,
      runUUID: 'run-contended-manifest',
      expectedGeneration: 4,
      githubRepositoryId: null,
      namespace: build.namespace,
      enqueueIngress: false,
    });
    await passOneContentionRetry(lockWithOptions);

    await expect(result).resolves.toBe(true);
    expect(lockWithOptions).toHaveBeenCalledTimes(2);
    expect(lockWithOptions).toHaveBeenNthCalledWith(1, 'build-deployment.7', 15 * 60 * 1000, {
      retryCount: 4,
      retryDelay: 1000,
      retryJitter: 200,
    });
    expect(redlock.lock).not.toHaveBeenCalled();
    expect(acquiredLock.unlock).toHaveBeenCalledTimes(1);
    expect(mockedGetLogger).toHaveBeenCalledWith({ error: waitError, buildId: 7 });
    expect(logger.warn).toHaveBeenCalledWith('Build reconciliation: waiting for configuration mutation');
    const kubernetes = jest.requireMock('server/lib/kubernetes');
    expect(kubernetes.createOrUpdateNamespace).toHaveBeenCalledTimes(1);
    expect(kubernetes.createOrUpdateNamespace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'env-contended-manifest-build' })
    );
    expect(build.$fetchGraph).toHaveBeenCalledWith('deploys');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('processDeleteQueue reports deployment-lock contention and honors authority lost before the deletion claim', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const waitError = new Error('deployment mutation is still running');
    const logger = capturingLogger();
    const { acquiredLock, lockWithOptions, redlock } = contendedAuthorityRedlock(waitError);
    const initial: any = {
      id: 7,
      uuid: 'contended-delete-build',
      deletedAt: null,
      status: BuildStatus.DEPLOYED,
      runUUID: 'build-teardown-7',
      pullRequestId: 55,
      pullRequest: { status: 'closed', deployOnUpdate: true },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const locked: any = {
      ...initial,
      runUUID: 'new-teardown-owner',
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(),
    };
    const deletionQuery = (result: any) => {
      const query: any = {
        findOne: jest.fn(() => query),
        findById: jest.fn(() => query),
        whereNull: jest.fn(() => query),
        forUpdate: jest.fn(() => query),
        then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return query;
    };
    const deleteBuild = jest.fn().mockResolvedValue(undefined);
    const BuildModel = {
      transact: jest.fn(async (callback: (trx: object) => unknown) => callback({ transaction: true })),
      query: jest.fn((trx?: object) => deletionQuery(trx ? locked : initial)),
    };
    const service = serviceWith(
      {
        models: { Build: BuildModel },
        services: { BuildService: { deleteBuild } },
      },
      redlock
    );

    const result = service.processDeleteQueue({
      data: {
        buildId: 7,
        buildUuid: 'contended-delete-build',
        reason: 'teardown_stuck',
        teardownRunUUID: 'build-teardown-7',
      },
    } as any);
    await passOneContentionRetry(lockWithOptions);

    await expect(result).resolves.toBeUndefined();
    expect(lockWithOptions).toHaveBeenCalledTimes(2);
    expect(lockWithOptions).toHaveBeenNthCalledWith(1, 'build-deployment.7', 15 * 60 * 1000, {
      retryCount: 4,
      retryDelay: 1000,
      retryJitter: 200,
    });
    expect(redlock.lock).not.toHaveBeenCalled();
    expect(acquiredLock.unlock).toHaveBeenCalledTimes(1);
    expect(mockedGetLogger).toHaveBeenCalledWith({ error: waitError, buildId: 7 });
    expect(logger.warn).toHaveBeenCalledWith('Build deletion: waiting for deployment mutation');
    expect(BuildModel.transact).toHaveBeenCalledTimes(1);
    expect(locked.$query).not.toHaveBeenCalled();
    expect(deleteBuild).not.toHaveBeenCalled();
  });

  test('getBuildByUUID treats an options object without liveOnly as a live-row lookup', async () => {
    const query = lookupQuery(null);
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });

    await expect(service.getBuildByUUID('live-default', {})).resolves.toBeNull();

    expect(query.findOne).toHaveBeenCalledWith({ uuid: 'live-default' });
    expect(query.whereNull).toHaveBeenCalledWith('deletedAt');
  });

  test.each(['lookup fails', 'configuration omits domain defaults'])(
    'getBuildByUUID still derives HTTPS public links when domain-default %s',
    async (mode) => {
      const configError = new Error('global configuration unavailable');
      const detailDeploy: any = { id: 11, publicUrl: 'app.example.test', deployable: { name: 'app' } };
      const snapshotDeploy = { id: 11, deployable: { name: 'app' } };
      const build: any = {
        id: 7,
        uuid: 'public-link-fallback',
        deploys: [detailDeploy],
      };
      const detailQuery = lookupQuery(build);
      const overrideSnapshotQuery = lookupQuery({
        id: 7,
        uuid: 'public-link-fallback',
        environmentId: 5,
        deploys: [snapshotDeploy],
      });
      const service = serviceWith({
        models: {
          Build: {
            query: jest.fn().mockReturnValueOnce(detailQuery).mockReturnValueOnce(overrideSnapshotQuery),
          },
        },
      });
      if (mode === 'lookup fails') {
        mockGetAllConfigs.mockRejectedValueOnce(configError);
      } else {
        mockGetAllConfigs.mockResolvedValueOnce({});
      }
      mockGetServiceOverrideStates.mockResolvedValueOnce([]);

      await expect(service.getBuildByUUID('public-link-fallback')).resolves.toBe(build);

      expect(detailDeploy.publicHref).toBe('https://app.example.test');
      expect(detailDeploy.serviceOverride).toBeNull();
      expect(mockGetServiceOverrideStates).toHaveBeenCalledWith([snapshotDeploy]);
    }
  );

  test('getEnvironmentDetail returns a null repository when a PR-less source repository was removed', async () => {
    const repositoryQuery = lookupQuery(undefined);
    mockRepositoryQuery.mockReturnValue(repositoryQuery);
    const build: any = {
      id: 7,
      uuid: 'removed-repository',
      status: BuildStatus.DEPLOYED,
      namespace: 'env-removed-repository',
      triggerType: 'api',
      githubRepositoryId: 42,
      deployEnabled: true,
      deploys: [],
      pullRequest: null,
    };
    const service = serviceWith({});
    jest.spyOn(service, 'getBuildByUUID').mockResolvedValue(build);

    await expect(service.getEnvironmentDetail('removed-repository')).resolves.toMatchObject({ repository: null });

    expect(repositoryQuery.findOne).toHaveBeenCalledWith({ githubRepositoryId: 42 });
  });

  test('redeployBuild accepts an enabled API environment without requiring an expected id', async () => {
    const build: any = {
      id: 7,
      uuid: 'api-environment',
      status: BuildStatus.DEPLOYED,
      deployEnabled: true,
      pullRequestId: null,
      pullRequest: null,
      deploys: [],
    };
    const query = lookupQuery(build);
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });

    const result = await service.redeployBuild('api-environment');

    expect(result).toEqual({
      status: 'success',
      message: 'Redeploy for build api-environment has been queued',
      deployId: expect.any(String),
    });
    expect(query.findOne).toHaveBeenCalledWith({ uuid: 'api-environment' });
    expect(mockAcceptDeploymentIntent).toHaveBeenCalledWith(7, {
      type: 'all',
      requestId: result.status === 'success' ? result.deployId : expect.any(String),
    });
    expect(mockQueueAdd).toHaveBeenCalledWith('reconcile', { buildId: 7, generation: 1 }, { jobId: 'reconcile-7-1' });
  });

  test('redeployBuild does not enqueue work for a closed pull-request environment', async () => {
    const build: any = {
      id: 8,
      uuid: 'closed-pr-environment',
      status: BuildStatus.DEPLOYED,
      deployEnabled: true,
      pullRequestId: 55,
      pullRequest: { status: 'closed', deployOnUpdate: true },
      deploys: [],
    };
    const query = lookupQuery(build);
    const service = serviceWith({ models: { Build: { query: jest.fn(() => query) } } });

    await expect(service.redeployBuild('closed-pr-environment')).resolves.toEqual({
      status: 'deploy_disabled',
      message: 'Deploys are disabled for build closed-pr-environment; enable deploys before redeploying.',
    });

    expect(mockAcceptDeploymentIntent).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
