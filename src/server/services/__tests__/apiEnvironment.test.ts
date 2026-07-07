/**
 * Copyright 2026 GoodRx, Inc.
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
const mockGetApiEnvironmentsConfig = jest.fn();
const mockGetYamlFileContent = jest.fn();
const mockApplyServiceOverrides = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: jest.fn() },
}));
jest.mock('server/lib/tracer', () => ({
  Tracer: { getInstance: jest.fn(() => ({ initialize: jest.fn() })) },
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  updateLogContext: jest.fn(),
  LogStage: {},
}));
jest.mock('server/lib/kubernetes', () => ({
  generateManifest: jest.fn(),
  applyManifests: jest.fn(),
  waitForPodReady: jest.fn(),
  createOrUpdateNamespace: jest.fn(),
  deleteBuild: jest.fn(),
  deleteNamespace: jest.fn(),
}));
jest.mock('server/lib/kubernetes/common/serviceAccount', () => ({
  ensureServiceAccountForJob: jest.fn().mockResolvedValue('default'),
}));
const mockGetYamlFileContentFromBranch = jest.fn();
const mockListBranchesForRepo = jest.fn();
jest.mock('server/lib/github', () => ({
  getYamlFileContent: (...args: any[]) => mockGetYamlFileContent(...args),
  getYamlFileContentFromBranch: (...args: any[]) => mockGetYamlFileContentFromBranch(...args),
  listBranchesForRepo: (...args: any[]) => mockListBranchesForRepo(...args),
  getSHAForBranch: jest.fn(),
  getPullRequest: jest.fn(),
}));
jest.mock('server/lib/helm', () => ({ uninstallHelmReleases: jest.fn() }));
jest.mock('server/lib/helm/utils', () => ({ ingressBannerSnippet: jest.fn(() => '') }));
jest.mock('server/lib/cli', () => ({ deployBuild: jest.fn(), deleteBuild: jest.fn() }));
jest.mock('server/lib/buildEnvVariables', () => ({
  BuildEnvironmentVariables: jest.fn().mockImplementation(() => ({ resolve: jest.fn().mockResolvedValue({}) })),
}));
jest.mock('server/lib/dependencyGraph', () => ({ generateGraph: jest.fn() }));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args),
      isFeatureEnabled: jest.fn(),
    })),
  },
}));
jest.mock('server/services/apiAccessConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getApiEnvironmentsConfig: (...args: any[]) => mockGetApiEnvironmentsConfig(...args),
    })),
  },
}));
jest.mock('server/services/deployCleanup', () =>
  jest.fn().mockImplementation(() => ({ cleanupDeploy: jest.fn(), deleteServiceRows: jest.fn() }))
);
jest.mock('server/services/deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ patchAndUpdateActivityFeed: jest.fn() })),
}));
jest.mock('server/services/webhook', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ upsertWebhooksWithYaml: jest.fn() })),
}));
jest.mock('server/services/override', () => ({
  __esModule: true,
  isBranchOrExternalUrlEditable: (type?: string) => ['github', 'helm', 'externalHTTP'].includes(type ?? ''),
  default: jest.fn().mockImplementation(() => ({
    applyServiceOverrides: (...args: any[]) => mockApplyServiceOverrides(...args),
    getServiceOverrideStates: jest.fn().mockResolvedValue([]),
  })),
}));
jest.mock('server/services/agentPrewarm', () =>
  jest.fn().mockImplementation(() => ({ queueBuildPrewarm: jest.fn().mockResolvedValue(undefined) }))
);
jest.mock('server/lib/fastly', () => jest.fn().mockImplementation(() => ({ getServiceDashboardUrl: jest.fn() })));
jest.mock('server/models', () => ({
  Build: class {},
  Deploy: class {},
  Environment: class {},
  Repository: class {},
}));
const mockPaginate = jest.fn();
jest.mock('server/lib/paginate', () => ({
  paginate: (...args: any[]) => mockPaginate(...args),
  getPaginationParamsFromURL: jest.fn(),
}));

import { UniqueViolationError } from 'objection';
import BuildService from '../build';
import { BuildStatus, DeployStatus } from 'shared/constants';

const uniqueViolation = () => Object.create(UniqueViolationError.prototype);

const API_CONFIG = {
  api_environments: { enabled: true, defaultTtlHours: 72, maxTtlHours: 336, extensionHours: 24 },
};

const NOW = new Date('2026-07-07T12:00:00Z');

function makeService({
  repository = { id: 11, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: 5 },
  environment = { id: 5 },
  existingIdempotent = null as any,
  createdBuild = null as any,
} = {}) {
  const buildCreate = jest.fn(async (attrs: any) => createdBuild ?? { id: 99, ...attrs });
  const buildFindOneChain = { whereNull: jest.fn().mockResolvedValue(existingIdempotent) };
  const models = {
    Build: {
      create: buildCreate,
      transact: jest.fn(async (callback: (trx: object) => Promise<unknown>) => callback({})),
      query: jest.fn(() => ({
        findOne: jest.fn(() => buildFindOneChain),
        findById: jest.fn(),
        patchAndFetchById: jest.fn(async (_id: number, patch: any) => ({ uuid: 'x', ...patch })),
        patch: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        whereNotNull: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
      })),
    },
    Repository: {
      query: jest.fn(() => ({
        whereRaw: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(repository),
        findOne: jest.fn().mockResolvedValue(repository),
      })),
    },
    Environment: { query: jest.fn(() => ({ findById: jest.fn().mockResolvedValue(environment) })) },
    Deploy: { query: jest.fn() },
    Deployable: { query: jest.fn() },
  };
  const services = {
    Deploy: { findOrCreateDeploys: jest.fn() },
  };
  const queueAdd = jest.fn();
  const queueManager = {
    registerQueue: jest.fn(() => ({ add: queueAdd })),
    registerWorker: jest.fn(),
  };
  const service = new BuildService({ models, services } as any, {} as any, {} as any, queueManager as any);
  return { service, models, services, queueAdd, buildCreate };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Runtime jest supports the config-object form; the bundled @types/jest predates it.
  (jest.useFakeTimers as any)({ now: NOW });
  mockGetAllConfigs.mockResolvedValue(API_CONFIG);
  mockGetApiEnvironmentsConfig.mockResolvedValue(API_CONFIG.api_environments);
  mockGetYamlFileContent.mockResolvedValue({ environment: { defaultServices: [{ name: 'app' }] } });
});

afterEach(() => {
  jest.useRealTimers();
});

const validInput = {
  repositoryFullName: 'org/repo',
  branch: 'main',
};

describe('createApiEnvironment', () => {
  it('refuses when the api_environments flag is off', async () => {
    mockGetApiEnvironmentsConfig.mockResolvedValue({ ...API_CONFIG.api_environments, enabled: false });
    const { service } = makeService();

    await expect(service.createApiEnvironment(validInput)).rejects.toMatchObject({
      httpStatus: 403,
      code: 'api_environments_disabled',
    });
  });

  it('404s a repository that is not onboarded or soft-deleted, matching case-insensitively', async () => {
    const { service, models } = makeService();
    const whereRaw = jest.fn().mockReturnThis();
    (models.Repository.query as jest.Mock).mockReturnValue({
      whereRaw,
      whereNull: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(undefined),
    });

    await expect(service.createApiEnvironment({ ...validInput, repositoryFullName: 'Org/Repo' })).rejects.toMatchObject(
      { code: 'repo_not_onboarded' }
    );
    expect(whereRaw).toHaveBeenCalledWith('lower("fullName") = ?', ['org/repo']);
  });

  it('rejects ambiguous environments when the repo has no default', async () => {
    const { service } = makeService({
      repository: { id: 1, githubRepositoryId: 42, fullName: 'org/repo', defaultEnvId: null } as any,
    });

    await expect(service.createApiEnvironment(validInput)).rejects.toMatchObject({ code: 'env_ambiguous' });
  });

  it('does not restore the removed classic/full-yaml environment gate', async () => {
    const { service, buildCreate } = makeService({
      environment: { id: 5, classicModeOnly: true, enableFullYaml: false } as any,
    });

    await expect(service.createApiEnvironment(validInput)).resolves.toMatchObject({ replayed: false });
    expect(buildCreate.mock.calls[0][0]).not.toHaveProperty('enableFullYaml');
  });

  it('rejects secret references in env overrides', async () => {
    const { service } = makeService();

    await expect(
      service.createApiEnvironment({ ...validInput, env: { TOKEN: '{{vault:prod/secret:token}}' } })
    ).rejects.toMatchObject({ httpStatus: 422, code: 'override_not_allowed' });
  });

  it('rejects non-string env values that could smuggle nested secret references', async () => {
    const { service } = makeService();

    await expect(
      service.createApiEnvironment({
        ...validInput,
        env: { GROUP: { KEY: '{{vault:prod/db:password}}' } } as any,
      })
    ).rejects.toMatchObject({ httpStatus: 422, code: 'override_not_allowed' });
    await expect(
      service.createApiEnvironment({
        ...validInput,
        initEnv: { LIST: ['{{vault:prod/db:password}}'] } as any,
      })
    ).rejects.toMatchObject({ httpStatus: 422, code: 'override_not_allowed' });
  });

  it('maps lifecycle.yaml fetch failures to config_invalid', async () => {
    mockGetYamlFileContent.mockRejectedValue(new Error('Config file not found'));
    const { service } = makeService();

    await expect(service.createApiEnvironment(validInput)).rejects.toMatchObject({
      httpStatus: 422,
      code: 'config_invalid',
    });
  });

  it('creates without a wired services registry (web runtime wires db.services lazily)', async () => {
    const { service, queueAdd, buildCreate } = makeService();
    (service.db as any).services = undefined;

    const { replayed } = await service.createApiEnvironment(validInput);

    expect(replayed).toBe(false);
    expect(buildCreate).toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalled();
  });

  it('creates a queued PR-less build and enqueues the environment-create job', async () => {
    const { service, queueAdd, buildCreate } = makeService();

    const { build, replayed } = await service.createApiEnvironment({
      ...validInput,
      sha: 'abc123',
      env: { FOO: 'bar' },
      services: [{ name: 'app', active: true }],
      autoTrack: false,
      idempotencyKey: 'idem-1',
      createdByTokenId: 7,
    });

    expect(replayed).toBe(false);
    expect(buildCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BuildStatus.QUEUED,
        triggerType: 'api',
        githubRepositoryId: 42,
        branchName: 'main',
        configSha: 'abc123',
        deployEnabled: true,
        githubDeployments: false,
        autoTrack: false,
        idempotencyKey: 'token:7:idem-1',
        createdByTokenId: 7,
        commentRuntimeEnv: { FOO: 'bar' },
        expiresAt: new Date(NOW.getTime() + 72 * 3600 * 1000).toISOString(),
      })
    );
    const created = buildCreate.mock.calls[0][0];
    expect(created.namespace).toBe(`env-${created.uuid}`);
    expect(created.uuid).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{6}$/);
    expect(queueAdd).toHaveBeenCalledWith(
      'environment-create',
      expect.objectContaining({ buildId: build.id, serviceOverrides: [{ name: 'app', active: true }] }),
      { jobId: `env-create-${build.id}` }
    );
  });

  it('rejects autoTrack for an immutable create-time source', async () => {
    const { service, buildCreate } = makeService();

    await expect(service.createApiEnvironment({ ...validInput, sha: 'abc123', autoTrack: true })).rejects.toMatchObject(
      { httpStatus: 422, code: 'auto_track_pinned_source' }
    );
    expect(buildCreate).not.toHaveBeenCalled();
  });

  it('caps the requested ttl at maxTtlHours', async () => {
    const { service, buildCreate } = makeService();

    await service.createApiEnvironment({ ...validInput, ttlHours: 10_000 });

    expect(buildCreate).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: new Date(NOW.getTime() + 336 * 3600 * 1000).toISOString() })
    );
  });

  it('replays an existing environment for a known idempotency key without inserting', async () => {
    const existing = { id: 42, uuid: 'existing-env-abcdef', status: 'deployed' };
    const { service, models, buildCreate, queueAdd } = makeService({ existingIdempotent: existing });
    const findOne = jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(existing) }));
    (models.Build.query as jest.Mock).mockReturnValue({ findOne });

    const { build, replayed } = await service.createApiEnvironment({
      ...validInput,
      idempotencyKey: 'idem-1',
      createdByTokenId: 7,
    });

    expect(replayed).toBe(true);
    expect(build).toBe(existing);
    expect(findOne).toHaveBeenCalledWith({ idempotencyKey: 'token:7:idem-1' });
    expect(buildCreate).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('replays an accepted key before mutable config and GitHub validation can fail', async () => {
    const existing = { id: 42, uuid: 'existing-env-abcdef', status: BuildStatus.DEPLOYED };
    const { service, models, buildCreate } = makeService();
    (models.Build.query as jest.Mock).mockReturnValue({
      findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(existing) })),
    });
    mockGetApiEnvironmentsConfig.mockRejectedValue(new Error('global config unavailable'));
    mockGetYamlFileContent.mockRejectedValue(new Error('github unavailable'));

    await expect(service.createApiEnvironment({ ...validInput, idempotencyKey: 'idem-1' })).resolves.toEqual({
      build: existing,
      replayed: true,
    });

    expect(mockGetApiEnvironmentsConfig).not.toHaveBeenCalled();
    expect(mockGetYamlFileContent).not.toHaveBeenCalled();
    expect(buildCreate).not.toHaveBeenCalled();
  });

  it('re-enqueues the create job when replaying a build stranded in queued', async () => {
    const stranded = { id: 42, uuid: 'stuck-env-abcdef', status: BuildStatus.QUEUED };
    const { service, models, queueAdd } = makeService();
    (models.Build.query as jest.Mock).mockReturnValue({
      findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(stranded) })),
    });

    const { replayed } = await service.createApiEnvironment({ ...validInput, idempotencyKey: 'idem-1' });

    expect(replayed).toBe(true);
    expect(queueAdd).toHaveBeenCalledWith('environment-create', expect.objectContaining({ buildId: 42 }), {
      jobId: 'env-create-42',
    });
  });

  it('surfaces a stranded replay enqueue failure instead of returning a false success', async () => {
    const stranded = { id: 42, uuid: 'stuck-env-abcdef', status: BuildStatus.QUEUED };
    const { service, models, queueAdd } = makeService();
    (models.Build.query as jest.Mock).mockReturnValue({
      findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(stranded) })),
    });
    queueAdd.mockRejectedValue(new Error('redis unavailable'));

    await expect(service.createApiEnvironment({ ...validInput, idempotencyKey: 'idem-1' })).rejects.toThrow(
      'redis unavailable'
    );
  });

  it('scopes idempotency keys per creator so another caller cannot replay them', async () => {
    const { service, models, buildCreate } = makeService();
    const findOne = jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(null) }));
    (models.Build.query as jest.Mock).mockReturnValue({ findOne });
    buildCreate.mockImplementation(async (attrs: any) => ({ id: 1, ...attrs }));

    await service.createApiEnvironment({ ...validInput, idempotencyKey: 'idem-1', createdBy: 'user-a' });

    expect(findOne).toHaveBeenCalledWith({ idempotencyKey: 'user:user-a:idem-1' });
    expect(buildCreate).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'user:user-a:idem-1' }));
  });

  it('409s a vanity name conflict', async () => {
    const { service, buildCreate } = makeService();
    buildCreate.mockRejectedValue(uniqueViolation());

    await expect(service.createApiEnvironment({ ...validInput, name: 'taken-name-123456' })).rejects.toMatchObject({
      httpStatus: 409,
      code: 'name_conflict',
    });
  });

  it('retries haikunator uuid collisions', async () => {
    const { service, buildCreate } = makeService();
    buildCreate
      .mockRejectedValueOnce(uniqueViolation())
      .mockImplementation(async (attrs: any) => ({ id: 1, ...attrs }));

    const { build } = await service.createApiEnvironment(validInput);

    expect(buildCreate).toHaveBeenCalledTimes(2);
    expect(build.id).toBe(1);
  });

  it('rejects invalid vanity name formats', async () => {
    const { service } = makeService();

    await expect(service.createApiEnvironment({ ...validInput, name: 'Bad_Name!' })).rejects.toMatchObject({
      code: 'invalid_name',
    });
  });
});

describe('listRepositoryBranches', () => {
  it('returns branches and defaultBranch for an onboarded repo', async () => {
    const { service } = makeService();
    mockListBranchesForRepo.mockResolvedValue({ branches: ['main', 'dev'], defaultBranch: 'main' });

    await expect(service.listRepositoryBranches('org/repo')).resolves.toEqual({
      branches: ['main', 'dev'],
      defaultBranch: 'main',
    });
    expect(mockListBranchesForRepo).toHaveBeenCalledWith('org/repo');
  });

  it('404s a repository that is not onboarded', async () => {
    const { service, models } = makeService();
    (models.Repository.query as jest.Mock).mockReturnValue({
      whereRaw: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    });

    await expect(service.listRepositoryBranches('org/missing')).rejects.toMatchObject({
      httpStatus: 404,
      code: 'repo_not_onboarded',
    });
    expect(mockListBranchesForRepo).not.toHaveBeenCalled();
  });

  it('400s a malformed repository fullName', async () => {
    const { service } = makeService();
    await expect(service.listRepositoryBranches('no-slash')).rejects.toMatchObject({ code: 'invalid_repository' });
  });
});

describe('previewEnvironmentConfig', () => {
  const YAML = `
services:
  - name: web
    github:
      repository: org/web
  - name: chart
    helm:
      chart:
        name: postgres
  - name: cache
    docker:
      image: redis
environment:
  defaultServices:
    - name: web
    - name: chart
  optionalServices:
    - name: cache
`;

  it('classifies default/optional services with type-derived editability', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockResolvedValue(YAML);

    const result = await service.previewEnvironmentConfig('org/repo', 'main');

    expect(typeof result.valid).toBe('boolean');
    expect(result.services).toEqual([
      {
        name: 'web',
        type: 'github',
        defaultActive: true,
        editable: true,
        branchRepository: 'org/web',
        branchConfigurationRepository: null,
        effectiveBranch: 'main',
      },
      {
        name: 'chart',
        type: 'helm',
        defaultActive: true,
        editable: true,
        branchRepository: null,
        branchConfigurationRepository: null,
        effectiveBranch: 'main',
      },
      { name: 'cache', type: 'docker', defaultActive: false, editable: false },
    ]);
    expect(mockGetYamlFileContentFromBranch).toHaveBeenCalledWith('org/repo', 'main');
  });

  it('reports invalid without services when the yaml cannot be read', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockRejectedValue(new Error('Config file not found'));

    await expect(service.previewEnvironmentConfig('org/repo', 'main')).resolves.toEqual({
      valid: false,
      error: expect.stringContaining('lifecycle.yaml'),
      services: [],
    });
  });

  it('falls back to all catalog services when the environment lists no services', async () => {
    const { service } = makeService();
    mockGetYamlFileContentFromBranch.mockResolvedValue(`
services:
  - name: only
    github:
      repository: org/only
`);

    const result = await service.previewEnvironmentConfig('org/repo', 'feature');
    expect(result.services).toEqual([
      {
        name: 'only',
        type: 'github',
        defaultActive: true,
        editable: true,
        branchRepository: 'org/only',
        branchConfigurationRepository: null,
        effectiveBranch: 'feature',
      },
    ]);
  });

  it('400s a missing branch and 404s a non-onboarded repo', async () => {
    const { service, models } = makeService();
    await expect(service.previewEnvironmentConfig('org/repo', '  ')).rejects.toMatchObject({ code: 'invalid_branch' });

    (models.Repository.query as jest.Mock).mockReturnValue({
      whereRaw: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    });
    await expect(service.previewEnvironmentConfig('org/missing', 'main')).rejects.toMatchObject({
      code: 'repo_not_onboarded',
    });
  });
});

describe('extendApiEnvironment', () => {
  const lockedBuildQuery = (build: any, patchAndFetchById = jest.fn()) => {
    const lock: any = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockResolvedValue(build),
    };
    return { findOne: jest.fn(() => lock), patchAndFetchById, lock };
  };

  it('404s non-API environments', async () => {
    const { service, models } = makeService();
    (models.Build.query as jest.Mock).mockReturnValue(lockedBuildQuery({ uuid: 'x', triggerType: 'github_pr' }));

    await expect(service.extendApiEnvironment('x')).rejects.toMatchObject({ code: 'env_not_found' });
  });

  it('extends from the current lease with the configured hours', async () => {
    const current = new Date(NOW.getTime() + 10 * 3600 * 1000);
    const patchAndFetchById = jest.fn(async (_id: number, patch: any) => ({ uuid: 'x', ...patch }));
    const { service, models } = makeService();
    const query = lockedBuildQuery(
      { id: 9, uuid: 'x', triggerType: 'api', expiresAt: current.toISOString() },
      patchAndFetchById
    );
    (models.Build.query as jest.Mock).mockReturnValue(query);

    const result = await service.extendApiEnvironment('x', null, 9);

    expect(query.findOne).toHaveBeenCalledWith({ uuid: 'x', id: 9 });
    expect(patchAndFetchById).toHaveBeenCalledWith(9, {
      expiresAt: new Date(current.getTime() + 24 * 3600 * 1000).toISOString(),
    });
    expect(query.lock.forUpdate).toHaveBeenCalled();
    expect(models.Build.transact).toHaveBeenCalledTimes(1);
    expect(result.expiresAt).toBe(new Date(current.getTime() + 24 * 3600 * 1000).toISOString());
  });

  it.each([BuildStatus.TEARING_DOWN, BuildStatus.TORN_DOWN])(
    '409s a %s environment without touching the lease',
    async (status) => {
      const patchAndFetchById = jest.fn();
      const { service, models } = makeService();
      (models.Build.query as jest.Mock).mockReturnValue(
        lockedBuildQuery({ id: 9, uuid: 'x', triggerType: 'api', status }, patchAndFetchById)
      );

      await expect(service.extendApiEnvironment('x')).rejects.toMatchObject({
        httpStatus: 409,
        code: 'env_tearing_down',
      });
      expect(patchAndFetchById).not.toHaveBeenCalled();
    }
  );
});

describe('sweepExpiredApiEnvironments', () => {
  const sweepChains = (expired: any[], stuck: any[] = []) => {
    const expiredChain: any = {
      where: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockResolvedValue(expired),
    };
    const stuckChain: any = {
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockResolvedValue(stuck),
    };
    return { expiredChain, stuckChain };
  };

  it('enqueues deletion only for expired live API builds', async () => {
    const expired = [
      { id: 1, uuid: 'old-env-111111' },
      { id: 2, uuid: 'old-env-222222' },
    ];
    const { expiredChain, stuckChain } = sweepChains(expired);
    const { service, models } = makeService();
    (models.Build.query as jest.Mock).mockReturnValueOnce(expiredChain).mockReturnValueOnce(stuckChain);
    const enqueue = jest.spyOn(service, 'enqueueBuildDeletion').mockResolvedValue();

    const result = await service.sweepExpiredApiEnvironments();

    expect(expiredChain.where).toHaveBeenCalledWith('triggerType', 'api');
    expect(expiredChain.whereNotNull).toHaveBeenCalledWith('expiresAt');
    expect(expiredChain.where).toHaveBeenCalledWith('expiresAt', '<=', NOW.toISOString());
    expect(expiredChain.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(expiredChain.whereNotIn).toHaveBeenCalledWith('status', [BuildStatus.TORN_DOWN, BuildStatus.TEARING_DOWN]);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(expired[0], 'lease_expired');
    expect(result).toEqual({ expired: 2, stuckTeardowns: 0, enqueued: 2 });
  });

  it('keeps sweeping after one enqueue fails', async () => {
    const expired = [
      { id: 1, uuid: 'old-env-111111' },
      { id: 2, uuid: 'old-env-222222' },
    ];
    const { expiredChain, stuckChain } = sweepChains(expired);
    const { service, models } = makeService();
    (models.Build.query as jest.Mock).mockReturnValueOnce(expiredChain).mockReturnValueOnce(stuckChain);
    const enqueue = jest
      .spyOn(service, 'enqueueBuildDeletion')
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue();

    const result = await service.sweepExpiredApiEnvironments();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenLastCalledWith(expired[1], 'lease_expired');
    expect(result).toEqual({ expired: 2, stuckTeardowns: 0, enqueued: 1 });
  });

  it('re-enqueues teardown for API builds stuck in tearing_down beyond the grace window', async () => {
    const stuck = [{ id: 9, uuid: 'stuck-env-999999' }];
    const { expiredChain, stuckChain } = sweepChains([], stuck);
    const { service, models } = makeService();
    (models.Build.query as jest.Mock).mockReturnValueOnce(expiredChain).mockReturnValueOnce(stuckChain);
    const enqueue = jest.spyOn(service, 'enqueueBuildDeletion').mockResolvedValue();

    const result = await service.sweepExpiredApiEnvironments();

    expect(stuckChain.where).toHaveBeenCalledWith('triggerType', 'api');
    expect(stuckChain.whereIn).toHaveBeenCalledWith('status', [BuildStatus.TEARING_DOWN, BuildStatus.TORN_DOWN]);
    expect(stuckChain.where).toHaveBeenCalledWith(
      'updatedAt',
      '<=',
      new Date(NOW.getTime() - 15 * 60 * 1000).toISOString()
    );
    expect(stuckChain.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(stuck[0], 'teardown_stuck');
    expect(result).toEqual({ expired: 0, stuckTeardowns: 1, enqueued: 1 });
  });
});

describe('enqueueBuildDeletion', () => {
  it('dedupes all teardown requests per build and carries a stable ownership token', async () => {
    const { service, queueAdd } = makeService();
    const build = { id: 7, uuid: 'api-env-123456', status: BuildStatus.DEPLOYED } as any;

    await service.enqueueBuildDeletion(build, 'api_delete');

    expect(queueAdd).toHaveBeenCalledWith(
      'delete',
      expect.objectContaining({
        buildId: 7,
        buildUuid: 'api-env-123456',
        reason: 'api_delete',
        teardownRunUUID: 'build-teardown-7',
      }),
      expect.objectContaining({ jobId: 'build-delete-7-authoritative', attempts: 3 })
    );
  });

  it('reuses the persisted owner token when retrying a stuck teardown', async () => {
    const { service, queueAdd } = makeService();
    const build = {
      id: 7,
      uuid: 'api-env-123456',
      status: BuildStatus.TEARING_DOWN,
      runUUID: 'teardown-owner',
    } as any;

    await service.enqueueBuildDeletion(build, 'teardown_stuck');

    expect(queueAdd).toHaveBeenCalledWith(
      'delete',
      expect.objectContaining({ teardownRunUUID: 'teardown-owner' }),
      expect.objectContaining({ jobId: 'build-delete-7-authoritative' })
    );
  });

  it('does not coalesce conditional PR cleanup with an authoritative destroy', async () => {
    const { service, queueAdd } = makeService();
    const build = { id: 7, uuid: 'pr-env-123456', status: BuildStatus.DEPLOYED } as any;

    await service.enqueueBuildDeletion(build, 'pull_request_closed');
    await service.enqueueBuildDeletion(build, 'manual_destroy');

    expect(queueAdd.mock.calls.map((call) => call[2].jobId)).toEqual([
      expect.stringMatching(/^build-delete-7-conditional-/),
      'build-delete-7-authoritative',
    ]);
    expect(queueAdd.mock.calls.map((call) => call[1].teardownRunUUID)).toEqual([
      'build-teardown-7',
      'build-teardown-7',
    ]);
  });

  it('never reuses a conditional jobId so a fresh close always enqueues teardown', async () => {
    const { service, queueAdd } = makeService();
    const build = { id: 7, uuid: 'pr-env-123456', status: BuildStatus.DEPLOYED } as any;

    await service.enqueueBuildDeletion(build, 'pull_request_closed');
    await service.enqueueBuildDeletion(build, 'pull_request_closed');

    const jobIds = queueAdd.mock.calls.map((call) => call[2].jobId);
    expect(jobIds[0]).toMatch(/^build-delete-7-conditional-/);
    expect(jobIds[1]).toMatch(/^build-delete-7-conditional-/);
    expect(jobIds[0]).not.toBe(jobIds[1]);
  });

  it('is a no-op when the PR has no build row', async () => {
    const { service, queueAdd } = makeService();

    await expect(service.enqueueBuildDeletion(null as any, 'deploy_disabled')).resolves.toBeUndefined();

    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('deleteBuild still deletes the namespace and completes teardown when a cleanup step fails', async () => {
    const { service } = makeService();
    const k8s = jest.requireMock('server/lib/kubernetes');
    const cli = jest.requireMock('server/lib/cli');
    const helm = jest.requireMock('server/lib/helm');
    k8s.deleteBuild.mockRejectedValue(new Error('destroy pipeline missing'));
    cli.deleteBuild.mockResolvedValue(undefined);
    helm.uninstallHelmReleases.mockResolvedValue(undefined);
    k8s.deleteNamespace.mockResolvedValue(undefined);

    const build: any = {
      id: 7,
      uuid: 'pr-env-123456',
      namespace: 'env-pr-env-123456',
      status: BuildStatus.TEARING_DOWN,
      pullRequestId: 55,
      runUUID: 'teardown-7',
      idempotencyKey: null,
      deploys: [],
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(() => ({ patch: jest.fn().mockResolvedValue(undefined) })),
    };
    const statusUpdate = jest.spyOn(service, 'updateStatusAndComment').mockResolvedValue(undefined as any);

    await service.deleteBuild(build, { deploymentLockAlreadyHeld: true, runUUID: 'teardown-7', rethrow: true });

    expect(k8s.deleteNamespace).toHaveBeenCalledWith('env-pr-env-123456');
    expect(statusUpdate).toHaveBeenCalledWith(build, BuildStatus.TORN_DOWN, 'teardown-7', true, true);
  });
});

describe('requestApiEnvironmentDeletion', () => {
  function makeDeletionRequestService(current: any) {
    const { service, models, queueAdd } = makeService();
    const claimPatch = jest.fn(async (patch: any) => Object.assign(current, patch));
    current.$query = jest.fn(() => ({ patch: claimPatch }));
    const lockedQuery: any = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockResolvedValue(current),
    };
    const findOne = jest.fn(() => lockedQuery);
    (models.Build.query as jest.Mock).mockReturnValue({ findOne });
    return { service, queueAdd, claimPatch, lockedQuery, findOne };
  }

  it('claims teardown and closes the deploy gate under an exact-id row lock before enqueueing', async () => {
    const current: any = {
      id: 7,
      uuid: 'api-env-123456',
      kind: 'environment',
      status: BuildStatus.DEPLOYED,
      deployEnabled: true,
      pullRequestId: null,
    };
    const { service, queueAdd, claimPatch, lockedQuery, findOne } = makeDeletionRequestService(current);

    const result = await service.requestApiEnvironmentDeletion('api-env-123456', 7);

    expect(findOne).toHaveBeenCalledWith({ id: 7, uuid: 'api-env-123456' });
    expect(lockedQuery.where).toHaveBeenCalledWith('kind', 'environment');
    expect(lockedQuery.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(lockedQuery.forUpdate).toHaveBeenCalled();
    expect(claimPatch).toHaveBeenCalledWith({
      status: BuildStatus.TEARING_DOWN,
      runUUID: 'build-teardown-7',
      deployEnabled: false,
    });
    expect(claimPatch.mock.invocationCallOrder[0]).toBeLessThan(queueAdd.mock.invocationCallOrder[0]);
    expect(queueAdd).toHaveBeenCalledWith(
      'delete',
      expect.objectContaining({ buildId: 7, teardownRunUUID: current.runUUID }),
      expect.objectContaining({ jobId: 'build-delete-7-authoritative', attempts: 3 })
    );
    expect(result).toBe(current);
  });

  it('converges a waiting TTL job and a later API delete on the same row-backed owner', async () => {
    const current: any = {
      id: 7,
      uuid: 'api-env-123456',
      kind: 'environment',
      status: BuildStatus.DEPLOYED,
      deployEnabled: true,
      pullRequestId: null,
    };
    const { service, queueAdd, claimPatch } = makeDeletionRequestService(current);

    await service.enqueueBuildDeletion({ ...current }, 'lease_expired');
    await service.requestApiEnvironmentDeletion('api-env-123456', 7);

    expect(claimPatch).toHaveBeenCalledWith(
      expect.objectContaining({ status: BuildStatus.TEARING_DOWN, runUUID: 'build-teardown-7' })
    );
    expect(queueAdd.mock.calls.map((call) => call[1].teardownRunUUID)).toEqual([
      'build-teardown-7',
      'build-teardown-7',
    ]);
  });

  it.each([BuildStatus.TEARING_DOWN, BuildStatus.TORN_DOWN])(
    'reuses the persisted teardown owner when the exact row is already %s',
    async (status) => {
      const current: any = {
        id: 7,
        uuid: 'api-env-123456',
        kind: 'environment',
        status,
        runUUID: 'existing-owner',
        deployEnabled: false,
        pullRequestId: null,
      };
      const { service, queueAdd, claimPatch } = makeDeletionRequestService(current);

      await service.requestApiEnvironmentDeletion('api-env-123456', 7);

      expect(claimPatch).not.toHaveBeenCalled();
      expect(queueAdd).toHaveBeenCalledWith(
        'delete',
        expect.objectContaining({ teardownRunUUID: 'existing-owner' }),
        expect.objectContaining({ jobId: 'build-delete-7-authoritative' })
      );
    }
  );

  it('serializes a concurrent redeploy so teardown ownership cannot be overwritten', async () => {
    const current: any = {
      id: 7,
      uuid: 'api-env-123456',
      kind: 'environment',
      status: BuildStatus.DEPLOYED,
      deployEnabled: true,
      pullRequestId: null,
      deploys: [],
    };
    const { service, models } = makeService();
    let releaseClaim!: () => void;
    const claimCanFinish = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimStarted!: () => void;
    const claimDidStart = new Promise<void>((resolve) => {
      claimStarted = resolve;
    });
    current.$query = jest.fn(() => ({
      patch: jest.fn(async (patch: any) => {
        claimStarted();
        await claimCanFinish;
        Object.assign(current, patch);
      }),
    }));
    const chain: any = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockResolvedValue(current),
      withGraphFetched: jest.fn().mockImplementation(async () => current),
    };
    (models.Build.query as jest.Mock).mockReturnValue({ findOne: jest.fn(() => chain) });

    let lockTail = Promise.resolve();
    (service as any).redlock = {
      lock: jest.fn(async () => {
        const prior = lockTail;
        let releaseLock!: () => void;
        lockTail = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        await prior;
        const lock: any = {
          unlock: jest.fn(async () => releaseLock()),
          extend: jest.fn(async () => lock),
        };
        return lock;
      }),
    };
    const enqueueResolve = jest.spyOn(service as any, 'enqueueResolveAndDeployBuild').mockResolvedValue(undefined);

    const deletion = service.requestApiEnvironmentDeletion(current.uuid, current.id);
    await claimDidStart;
    const redeploy = service.redeployBuild(current.uuid, current.id);
    releaseClaim();

    await expect(deletion).resolves.toBe(current);
    await expect(redeploy).resolves.toMatchObject({ status: 'tearing_down' });
    expect(enqueueResolve).not.toHaveBeenCalled();
    expect(current).toMatchObject({ status: BuildStatus.TEARING_DOWN, deployEnabled: false });
  });
});

describe('handleApiEnvironmentCreateFailure', () => {
  it('ignores non-final attempts', async () => {
    const { service, models } = makeService();
    await service.handleApiEnvironmentCreateFailure(
      { attemptsMade: 1, opts: { attempts: 3 }, data: { buildId: 5 } } as any,
      new Error('boom')
    );
    expect(models.Build.query).not.toHaveBeenCalled();
  });

  it('patches queued/pending builds to error after the final attempt', async () => {
    const whereIn = jest.fn().mockResolvedValue(1);
    const where = jest.fn(() => ({ whereIn }));
    const patch = jest.fn(() => ({ where }));
    const { service, models } = makeService();
    (models.Build.query as jest.Mock).mockReturnValue({ patch });

    await service.handleApiEnvironmentCreateFailure(
      { attemptsMade: 3, opts: { attempts: 3 }, data: { buildId: 5 } } as any,
      new Error('boom')
    );

    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({ status: BuildStatus.ERROR, statusMessage: expect.stringContaining('boom') })
    );
    expect(where).toHaveBeenCalledWith({ id: 5 });
    expect(whereIn).toHaveBeenCalledWith('status', [BuildStatus.QUEUED, BuildStatus.PENDING]);
  });
});

describe('processApiEnvironmentCreateQueue', () => {
  const jobFor = (overrides: any = null) => ({
    data: { buildId: 7, buildUuid: 'happy-env-123456', serviceOverrides: overrides },
  });

  function makeProcessService(deployables: any[], deploys: any[], graphDeploys: any[] = deploys) {
    const build: any = {
      id: 7,
      uuid: 'happy-env-123456',
      deletedAt: null,
      deployEnabled: true,
      pullRequest: null,
      environment: { id: 5 },
      $query: jest.fn(() => ({ patch: jest.fn() })),
      $setRelated: jest.fn(),
    };
    // The PENDING claim resolves 0 rows once the build reads as torn down, mirroring the conditional patch.
    const claim = {
      where: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereNull: jest
        .fn()
        .mockImplementation(async () =>
          build.status === BuildStatus.TORN_DOWN || build.status === BuildStatus.TEARING_DOWN ? 0 : 1
        ),
    };
    const { service, models, services } = makeService();
    (models.Build.query as jest.Mock).mockReturnValue({
      findById: jest.fn(() => ({
        withGraphFetched: jest.fn().mockResolvedValue(build),
      })),
      patch: jest.fn(() => claim),
    });
    (models.Deployable.query as jest.Mock) = jest.fn(() => ({ where: jest.fn().mockResolvedValue(deployables) }));
    (models as any).Deploy = {
      query: jest.fn(() => ({
        where: jest.fn(() => ({ withGraphFetched: jest.fn().mockResolvedValue(graphDeploys) })),
      })),
    };
    (services.Deploy.findOrCreateDeploys as jest.Mock).mockResolvedValue(deploys);
    const importYaml = jest.spyOn(service as any, 'importYamlConfigFile').mockResolvedValue(undefined);
    const recordFailure = jest
      .spyOn(service as any, 'recordBuildFailure')
      .mockResolvedValue(undefined) as jest.SpyInstance;
    const updateStatus = jest
      .spyOn(service as any, 'updateStatusAndComment')
      .mockResolvedValue(undefined) as jest.SpyInstance;
    const enqueueResolve = jest
      .spyOn(service as any, 'enqueueResolveAndDeployBuild')
      .mockResolvedValue(undefined) as jest.SpyInstance;
    return { service, services, build, claim, importYaml, recordFailure, updateStatus, enqueueResolve };
  }

  it('marks the build errored when yaml import produces no deployables (7A)', async () => {
    const { service, recordFailure, enqueueResolve } = makeProcessService([], []);

    await service.processApiEnvironmentCreateQueue(jobFor());

    expect(recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      BuildStatus.ERROR,
      expect.anything(),
      expect.any(Error),
      expect.stringContaining('no services')
    );
    expect(enqueueResolve).not.toHaveBeenCalled();
  });

  it('records a terminal error when the environment relation is missing instead of stranding the build in queued', async () => {
    const { service, build, recordFailure, importYaml, enqueueResolve } = makeProcessService([{ id: 10 }], [{ id: 1 }]);
    build.environment = null;

    await service.processApiEnvironmentCreateQueue(jobFor());

    expect(recordFailure).toHaveBeenCalledWith(
      build,
      BuildStatus.ERROR,
      null,
      expect.any(Error),
      expect.stringContaining('missing')
    );
    expect(importYaml).not.toHaveBeenCalled();
    expect(enqueueResolve).not.toHaveBeenCalled();
  });

  it('marks the build errored when deployables produce no deploys', async () => {
    const { service, recordFailure, enqueueResolve } = makeProcessService([{ id: 10 }], []);

    await service.processApiEnvironmentCreateQueue(jobFor());

    expect(recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      BuildStatus.ERROR,
      expect.anything(),
      expect.any(Error),
      expect.stringContaining('No deploys')
    );
    expect(enqueueResolve).not.toHaveBeenCalled();
  });

  it('applies service overrides with deployable-graph-loaded deploys, marks pending, and chains resolve-and-deploy', async () => {
    const deploys = [{ id: 1 }];
    // findOrCreateDeploys returns bare deploys; the override path must receive the graph-loaded set.
    const graphDeploys = [{ id: 1, deployable: { name: 'app' } }];
    const { service, build, updateStatus, enqueueResolve } = makeProcessService([{ id: 10 }], deploys, graphDeploys);

    await service.processApiEnvironmentCreateQueue(jobFor([{ name: 'app', active: true }]));

    expect(mockApplyServiceOverrides).toHaveBeenCalledWith(
      expect.objectContaining({
        build,
        deploys: graphDeploys,
        pullRequest: null,
        serviceOverrides: [{ name: 'app', active: true }],
        enqueueRedeploy: false,
      })
    );
    expect(updateStatus).toHaveBeenCalledWith(build, BuildStatus.PENDING, expect.any(String), true, true);
    expect(enqueueResolve).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: 7, triggerRef: expect.any(String) })
    );
  });

  it('skips the deploy chain when deploys are paused', async () => {
    const { service, build, enqueueResolve, updateStatus } = makeProcessService([{ id: 10 }], [{ id: 1 }]);
    build.deployEnabled = false;

    await service.processApiEnvironmentCreateQueue(jobFor());

    expect(updateStatus).toHaveBeenCalled();
    expect(enqueueResolve).not.toHaveBeenCalled();
  });

  it('rethrows unexpected failures so BullMQ retries', async () => {
    const { service, importYaml } = makeProcessService([{ id: 10 }], [{ id: 1 }]);
    importYaml.mockRejectedValue(new Error('transient'));

    await expect(service.processApiEnvironmentCreateQueue(jobFor())).rejects.toThrow('transient');
  });

  it('aborts before PENDING when a DELETE tears the build down mid-run', async () => {
    const { service, services, build, claim, updateStatus, enqueueResolve } = makeProcessService(
      [{ id: 10 }],
      [{ id: 1 }]
    );
    (services.Deploy.findOrCreateDeploys as jest.Mock).mockImplementation(async () => {
      build.status = BuildStatus.TORN_DOWN;
      return [{ id: 1 }];
    });

    await service.processApiEnvironmentCreateQueue(jobFor());

    expect(claim.whereNotIn).toHaveBeenCalledWith('status', [BuildStatus.TORN_DOWN, BuildStatus.TEARING_DOWN]);
    expect(claim.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(updateStatus).not.toHaveBeenCalled();
    expect(enqueueResolve).not.toHaveBeenCalled();
  });

  it('does not overwrite teardown ownership when DELETE wins between the entry read and run claim', async () => {
    const { service, build, claim, importYaml, updateStatus, enqueueResolve } = makeProcessService(
      [{ id: 10 }],
      [{ id: 1 }]
    );
    claim.whereNull.mockImplementationOnce(async () => {
      build.status = BuildStatus.TEARING_DOWN;
      build.runUUID = 'delete-owner';
      return 0;
    });

    await service.processApiEnvironmentCreateQueue(jobFor());

    expect(build.runUUID).toBe('delete-owner');
    expect(importYaml).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(enqueueResolve).not.toHaveBeenCalled();
  });

  it('skips a missing or already-deleted build at entry', async () => {
    const { service, models } = makeService();
    (models.Build.query as jest.Mock).mockReturnValue({
      findById: jest.fn(() => ({ withGraphFetched: jest.fn().mockResolvedValue(undefined) })),
    });
    const importYaml = jest.spyOn(service as any, 'importYamlConfigFile').mockResolvedValue(undefined);

    await expect(
      service.processApiEnvironmentCreateQueue({ data: { buildId: 7, buildUuid: 'x', serviceOverrides: null } })
    ).resolves.toBeUndefined();
    expect(importYaml).not.toHaveBeenCalled();
  });

  it('skips a build already torn down at entry without claiming a runUUID', async () => {
    const { service, build, importYaml } = makeProcessService([{ id: 10 }], [{ id: 1 }]);
    build.status = BuildStatus.TORN_DOWN;

    await service.processApiEnvironmentCreateQueue(jobFor());

    expect(build.$query).not.toHaveBeenCalled();
    expect(importYaml).not.toHaveBeenCalled();
  });

  it('skips a soft-deleted build at entry', async () => {
    const { service, build, importYaml } = makeProcessService([{ id: 10 }], [{ id: 1 }]);
    build.deletedAt = NOW.toISOString();

    await service.processApiEnvironmentCreateQueue(jobFor());

    expect(build.$query).not.toHaveBeenCalled();
    expect(importYaml).not.toHaveBeenCalled();
  });
});

describe('applyApiEnvironmentPatch', () => {
  const overrideMock = () => ({
    applyBuildConfigPatch: jest.fn(),
    applyServiceOverrides: jest.fn(),
    validateServiceOverrides: jest.fn(async (_build, _deploys, services) => services),
  });

  const apiBuild = () =>
    ({
      id: 1,
      uuid: 'api-env-123456',
      triggerType: 'api',
      pullRequest: null,
      deploys: [],
      $query: jest.fn(() => ({ patch: jest.fn() })),
    } as any);

  const allowMutableBuild = (models: any, current: any) => {
    const lock = {
      whereNull: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockResolvedValue(current),
    };
    const findById = jest.fn(() => lock);
    (models.Build.query as jest.Mock).mockReturnValue({ findById });
    return { findById, lock };
  };

  it('rejects secret references in patch.env and patch.initEnv without touching the build', async () => {
    const { service } = makeService();
    const override = overrideMock();
    const build = apiBuild();

    await expect(
      service.applyApiEnvironmentPatch(build, override as any, { env: { T: '{{vault:prod/x:y}}' } })
    ).rejects.toMatchObject({ httpStatus: 422, code: 'override_not_allowed' });
    await expect(
      service.applyApiEnvironmentPatch(build, override as any, { initEnv: { T: '{{aws:secret}}' } })
    ).rejects.toMatchObject({ httpStatus: 422, code: 'override_not_allowed' });

    expect(build.$query).not.toHaveBeenCalled();
    expect(override.applyBuildConfigPatch).not.toHaveBeenCalled();
    expect(override.applyServiceOverrides).not.toHaveBeenCalled();
  });

  it('rejects non-string patch env values without touching the build', async () => {
    const { service } = makeService();
    const override = overrideMock();
    const build = apiBuild();

    await expect(
      service.applyApiEnvironmentPatch(build, override as any, {
        env: { GROUP: { KEY: '{{vault:prod/db:password}}' } } as any,
      })
    ).rejects.toMatchObject({ httpStatus: 422, code: 'override_not_allowed' });

    expect(build.$query).not.toHaveBeenCalled();
    expect(override.applyBuildConfigPatch).not.toHaveBeenCalled();
  });

  it('rejects deployEnabled/autoTrack on PR-triggered builds with a stable code', async () => {
    const { service } = makeService();
    const override = overrideMock();
    const prBuild = { ...apiBuild(), triggerType: 'github_pr', pullRequest: { deployOnUpdate: true } };

    await expect(
      service.applyApiEnvironmentPatch(prBuild, override as any, { deployEnabled: false })
    ).rejects.toMatchObject({ httpStatus: 422, code: 'invalid_field_for_trigger' });
    await expect(service.applyApiEnvironmentPatch(prBuild, override as any, { autoTrack: true })).rejects.toMatchObject(
      { httpStatus: 422, code: 'invalid_field_for_trigger' }
    );
  });

  it('rejects enabling autoTrack on a source-pinned API environment', async () => {
    const { service } = makeService();
    const override = overrideMock();
    const build = { ...apiBuild(), configSha: 'abc123' };

    await expect(service.applyApiEnvironmentPatch(build, override as any, { autoTrack: true })).rejects.toMatchObject({
      httpStatus: 422,
      code: 'auto_track_pinned_source',
    });
    expect(build.$query).not.toHaveBeenCalled();
  });

  it('patches API-build toggles and routes env/services through OverrideService', async () => {
    const { service, models } = makeService();
    const override = overrideMock();
    const patchFn = jest.fn();
    const build = apiBuild();
    allowMutableBuild(models, build);
    build.$query = jest.fn(() => ({ patch: patchFn }));
    build.deploys = [{ id: 9 }];

    await service.applyApiEnvironmentPatch(build, override as any, {
      deployEnabled: false,
      env: { A: 'b' },
      services: [{ name: 'app', active: false }],
    });

    expect(patchFn).toHaveBeenCalledWith(
      expect.objectContaining({ deployEnabled: false, runUUID: expect.any(String) })
    );
    expect(override.applyBuildConfigPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        build,
        patch: { commentRuntimeEnv: { A: 'b' } },
        enqueueRedeploy: false,
        trx: expect.anything(),
      })
    );
    expect(override.applyServiceOverrides).toHaveBeenCalledWith(
      expect.objectContaining({
        build,
        deploys: [{ id: 9 }],
        serviceOverrides: [{ name: 'app', active: false }],
        enqueueRedeploy: false,
        trx: expect.anything(),
      })
    );
  });

  it('serializes a pause behind the same lock used by manifest apply and teardown', async () => {
    const { service, models } = makeService();
    const override = overrideMock();
    const build = apiBuild();
    allowMutableBuild(models, build);
    const patchFn = jest.fn().mockResolvedValue(undefined);
    build.$query = jest.fn(() => ({ patch: patchFn }));
    let grantLock!: (lock: any) => void;
    const lockGranted = new Promise<any>((resolve) => {
      grantLock = resolve;
    });
    const unlock = jest.fn().mockResolvedValue(undefined);
    (service as any).redlock = { lock: jest.fn(() => lockGranted) };

    const pause = service.applyApiEnvironmentPatch(build, override as any, { deployEnabled: false });
    await Promise.resolve();
    expect(patchFn).not.toHaveBeenCalled();

    grantLock({ unlock, extend: jest.fn() });
    await pause;

    expect((service as any).redlock.lock).toHaveBeenCalledWith('build-deployment.1', 15 * 60 * 1000);
    expect(patchFn).toHaveBeenCalledWith(
      expect.objectContaining({ deployEnabled: false, runUUID: expect.any(String) })
    );
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it('prevalidates all service overrides before opening the write transaction', async () => {
    const { service, models } = makeService();
    const override = overrideMock();
    override.validateServiceOverrides.mockRejectedValue(new Error('missing service'));
    const build = apiBuild();
    build.deploys = [{ id: 9 }];

    await expect(
      service.applyApiEnvironmentPatch(build, override as any, {
        deployEnabled: false,
        services: [{ name: 'missing', active: false }],
      })
    ).rejects.toThrow('missing service');

    expect(models.Build.transact).not.toHaveBeenCalled();
    expect(build.$query).not.toHaveBeenCalled();
  });

  it('commits combined config and service changes before enqueueing exactly one redeploy', async () => {
    const { service, models } = makeService();
    const override = overrideMock();
    const build = apiBuild();
    allowMutableBuild(models, build);
    build.deployEnabled = true;
    build.deploys = [{ id: 9 }];
    const enqueue = jest.spyOn(service, 'enqueueResolveAndDeployBuild').mockResolvedValue(undefined as any);

    await service.applyApiEnvironmentPatch(build, override as any, {
      env: { A: 'b' },
      services: [{ name: 'app', active: false }],
    });

    expect(override.applyBuildConfigPatch).toHaveBeenCalledWith(
      expect.objectContaining({ enqueueRedeploy: false, trx: expect.anything() })
    );
    expect(override.applyServiceOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ enqueueRedeploy: false, trx: expect.anything() })
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ buildId: 1, triggerRef: expect.any(String) }));
  });

  it.each([BuildStatus.TEARING_DOWN, BuildStatus.TORN_DOWN])(
    '409s without mutation or enqueue when the authorized build becomes %s',
    async (status) => {
      const { service, models } = makeService();
      const override = overrideMock();
      const build = apiBuild();
      allowMutableBuild(models, { ...build, status });
      const enqueue = jest.spyOn(service, 'enqueueResolveAndDeployBuild').mockResolvedValue(undefined as any);

      await expect(service.applyApiEnvironmentPatch(build, override as any, { env: { A: 'b' } })).rejects.toMatchObject(
        { httpStatus: 409, code: 'env_tearing_down' }
      );

      expect(build.$query).not.toHaveBeenCalled();
      expect(override.applyBuildConfigPatch).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    }
  );

  it('404s without mutation when the authorized build was released before the transaction lock', async () => {
    const { service, models } = makeService();
    const override = overrideMock();
    const build = apiBuild();
    allowMutableBuild(models, undefined);

    await expect(
      service.applyApiEnvironmentPatch(build, override as any, { deployEnabled: false })
    ).rejects.toMatchObject({ httpStatus: 404, code: 'env_not_found' });

    expect(build.$query).not.toHaveBeenCalled();
  });
});

describe('processApiEnvironmentCreateQueue config errors', () => {
  it('records CONFIG_ERROR terminally instead of retrying on validation failures', async () => {
    const { ValidationError } = jest.requireActual('server/lib/yamlConfigValidator');
    const build: any = {
      id: 7,
      uuid: 'happy-env-123456',
      deletedAt: null,
      deployEnabled: true,
      pullRequest: null,
      environment: { id: 5 },
      $query: jest.fn(() => ({ patch: jest.fn() })),
      $setRelated: jest.fn(),
    };
    const { service, models } = makeService();
    const claim = {
      where: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockResolvedValue(1),
    };
    (models.Build.query as jest.Mock).mockReturnValue({
      findById: jest.fn(() => ({ withGraphFetched: jest.fn().mockResolvedValue(build) })),
      patch: jest.fn(() => claim),
    });
    jest
      .spyOn(service as any, 'importYamlConfigFile')
      .mockRejectedValue(new ValidationError('yaml invalid', [] as any));
    const recordFailure = jest.spyOn(service as any, 'recordBuildFailure').mockResolvedValue(undefined);
    const enqueueResolve = jest.spyOn(service as any, 'enqueueResolveAndDeployBuild').mockResolvedValue(undefined);

    await expect(
      service.processApiEnvironmentCreateQueue({ data: { buildId: 7, buildUuid: build.uuid, serviceOverrides: null } })
    ).resolves.toBeUndefined();

    expect(recordFailure).toHaveBeenCalledWith(
      build,
      BuildStatus.CONFIG_ERROR,
      expect.any(String),
      expect.anything(),
      'Lifecycle configuration failed validation.'
    );
    expect(enqueueResolve).not.toHaveBeenCalled();
  });
});

describe('listEnvironments and getEnvironmentDetail serialization', () => {
  const listChain = () => {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereExists: jest.fn().mockReturnThis(),
      whereNotExists: jest.fn().mockReturnThis(),
      modify: jest.fn().mockImplementation(function (this: any, fn: any) {
        fn(this);
        return this;
      }),
      withGraphFetched: jest.fn().mockReturnThis(),
      modifyGraph: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
    };
    return chain;
  };

  it('serializes PR and API builds with coalesced identity and caps the page size', async () => {
    const prBuild = {
      id: 1,
      uuid: 'pr-env-111111',
      deletedAt: null,
      status: 'deployed',
      namespace: 'env-pr-env-111111',
      triggerType: 'github_pr',
      branchName: null,
      githubRepositoryId: null,
      pullRequest: {
        fullName: 'org/repo',
        branchName: 'feature-1',
        deployOnUpdate: true,
        pullRequestNumber: 12,
        title: 't',
        githubLogin: 'alice',
        status: 'open',
        repository: { githubRepositoryId: 42 },
      },
    };
    const apiBuild = {
      id: 2,
      uuid: 'api-env-222222',
      deletedAt: '2026-07-21T02:21:55.141Z',
      status: 'torn_down',
      namespace: 'env-api-env-222222',
      triggerType: 'api',
      branchName: 'main',
      githubRepositoryId: 42,
      deployEnabled: true,
      expiresAt: 'later',
      pullRequest: null,
    };
    const { service, models } = makeService();
    const chain = listChain();
    (models.Build.query as jest.Mock).mockReturnValue(chain);
    (models.Build as any).relatedQuery = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
    }));
    (models.Repository.query as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockResolvedValue([{ githubRepositoryId: 42, fullName: 'org/repo' }]),
    });
    const deploySummaryChain: any = {
      alias: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockResolvedValue([
        { buildId: 1, status: DeployStatus.READY, deployableName: 'app' },
        { buildId: 1, status: DeployStatus.BUILT, deployableName: 'app' },
        { buildId: 1, status: DeployStatus.BUILT, deployableName: 'worker' },
        { buildId: 2, status: DeployStatus.DEPLOYED, deployableName: 'app' },
      ]),
    };
    (models.Deploy.query as jest.Mock).mockReturnValue(deploySummaryChain);
    mockPaginate.mockResolvedValue({ data: [prBuild, apiBuild], metadata: { page: 1 } });

    const { data } = await service.listEnvironments({
      excludeStatuses: '',
      pagination: { page: 1, limit: 5000 } as any,
    });

    expect(mockPaginate).toHaveBeenCalledWith(expect.anything(), { page: 1, limit: 100 });
    expect(chain.select.mock.calls[0]).toEqual(expect.arrayContaining(['builds.deletedAt']));
    expect(data[0]).toMatchObject({
      uuid: 'pr-env-111111',
      deletedAt: null,
      trigger: 'github_pr',
      repository: 'org/repo',
      branch: 'feature-1',
      deployEnabled: true,
      activeServiceCount: 2,
      hasReadyActiveService: true,
      pullRequest: { number: 12, author: 'alice' },
    });
    expect(data[1]).toMatchObject({
      uuid: 'api-env-222222',
      deletedAt: '2026-07-21T02:21:55.141Z',
      trigger: 'api',
      repository: 'org/repo',
      branch: 'main',
      deployEnabled: true,
      expiresAt: 'later',
      activeServiceCount: 1,
      hasReadyActiveService: false,
      pullRequest: null,
    });
  });

  it('scopes the listing to the token repositoryAllowlist via lowercased EXISTS predicates', async () => {
    const { service, models } = makeService();
    const recorder: any = {
      orWhereRaw: jest.fn().mockReturnThis(),
      orWhereExists: jest.fn().mockReturnThis(),
    };
    const chain = listChain();
    chain.where = jest.fn().mockImplementation(function (this: any, arg: any) {
      if (typeof arg === 'function') arg(recorder);
      return this;
    });
    (models.Build.query as jest.Mock).mockReturnValue(chain);
    const prWhereRaw = jest.fn().mockReturnThis();
    (models.Build as any).relatedQuery = jest.fn(() => ({ whereRaw: prWhereRaw }));
    const repoWhereColumn = jest.fn().mockReturnThis();
    const repoWhereRaw = jest.fn().mockReturnThis();
    (models.Repository.query as jest.Mock).mockReturnValue({
      whereColumn: repoWhereColumn,
      whereNull: jest.fn().mockReturnThis(),
      whereRaw: repoWhereRaw,
      select: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
    });
    mockPaginate.mockResolvedValue({ data: [], metadata: { page: 1 } });

    await service.listEnvironments({ repositoryAllowlist: ['Org/Repo'] });

    expect(recorder.orWhereExists).toHaveBeenCalledTimes(2);
    expect(repoWhereColumn).toHaveBeenCalledWith('repositories.githubRepositoryId', 'builds.githubRepositoryId');
    expect(repoWhereRaw).toHaveBeenCalledWith('LOWER("fullName") = ANY(?)', [['org/repo']]);
    expect((models.Build as any).relatedQuery).toHaveBeenCalledWith('pullRequest');
    expect(prWhereRaw).toHaveBeenCalledWith('LOWER("fullName") = ANY(?)', [['org/repo']]);
  });

  it('matches the search term across build columns, the source repo, and PR fields via lowercased LIKEs', async () => {
    const { service, models } = makeService();
    const recorder: any = {
      orWhereRaw: jest.fn().mockReturnThis(),
      orWhereExists: jest.fn().mockReturnThis(),
    };
    const chain = listChain();
    chain.where = jest.fn().mockImplementation(function (this: any, arg: any) {
      if (typeof arg === 'function') arg(recorder);
      return this;
    });
    (models.Build.query as jest.Mock).mockReturnValue(chain);
    const prRecorder: any = { whereRaw: jest.fn().mockReturnThis(), orWhereRaw: jest.fn().mockReturnThis() };
    (models.Build as any).relatedQuery = jest.fn(() => ({
      where: jest.fn().mockImplementation(function (this: any, fn: any) {
        fn(prRecorder);
        return this;
      }),
    }));
    const repoWhereRaw = jest.fn().mockReturnThis();
    (models.Repository.query as jest.Mock).mockReturnValue({
      whereColumn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereRaw: repoWhereRaw,
    });
    mockPaginate.mockResolvedValue({ data: [], metadata: { page: 1 } });

    await service.listEnvironments({ search: '  FEA ' });

    expect(recorder.orWhereRaw).toHaveBeenCalledWith('LOWER(builds."uuid") LIKE ?', ['%fea%']);
    expect(recorder.orWhereRaw).toHaveBeenCalledWith('LOWER(builds."namespace") LIKE ?', ['%fea%']);
    expect(recorder.orWhereRaw).toHaveBeenCalledWith('LOWER(builds."branchName") LIKE ?', ['%fea%']);
    expect(recorder.orWhereRaw).toHaveBeenCalledWith('LOWER(builds."createdByGithubLogin") LIKE ?', ['%fea%']);
    expect(recorder.orWhereExists).toHaveBeenCalledTimes(2);
    expect(repoWhereRaw).toHaveBeenCalledWith('LOWER("fullName") LIKE ?', ['%fea%']);
    expect(prRecorder.whereRaw).toHaveBeenCalledWith('LOWER("title") LIKE ?', ['%fea%']);
    expect(prRecorder.orWhereRaw).toHaveBeenCalledWith('LOWER("fullName") LIKE ?', ['%fea%']);
    expect(prRecorder.orWhereRaw).toHaveBeenCalledWith('LOWER("githubLogin") LIKE ?', ['%fea%']);
    expect(prRecorder.orWhereRaw).toHaveBeenCalledWith('LOWER("branchName") LIKE ?', ['%fea%']);
  });

  it('hides deleted rows when torn_down is excluded by default or explicitly', async () => {
    const { service, models } = makeService();
    const chain = listChain();
    (models.Build.query as jest.Mock).mockReturnValue(chain);
    mockPaginate.mockResolvedValue({ data: [], metadata: { page: 1 } });

    await service.listEnvironments({});
    expect(chain.whereNull).toHaveBeenCalledWith('builds.deletedAt');
    expect(chain.whereNotIn).toHaveBeenCalledWith('builds.status', ['torn_down']);

    chain.whereNull.mockClear();
    chain.whereNotIn.mockClear();
    await service.listEnvironments({ excludeStatuses: 'torn_down, error' });
    expect(chain.whereNull).toHaveBeenCalledWith('builds.deletedAt');
    expect(chain.whereNotIn).toHaveBeenCalledWith('builds.status', ['torn_down', 'error']);
  });

  it.each([
    { excludeStatuses: '', excludedStatuses: [] },
    { excludeStatuses: 'error', excludedStatuses: ['error'] },
  ])(
    'includes only torn_down deleted rows when exclude="$excludeStatuses" allows torn_down',
    async ({ excludeStatuses, excludedStatuses }) => {
      const { service, models } = makeService();
      const deletedPredicate: any = {
        whereNotNull: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
      };
      const visibilityPredicate: any = {
        whereNull: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockImplementation((fn: any) => {
          fn(deletedPredicate);
          return visibilityPredicate;
        }),
      };
      const chain = listChain();
      chain.where = jest.fn().mockImplementation(function (this: any, value: any) {
        if (typeof value === 'function') value(visibilityPredicate);
        return this;
      });
      (models.Build.query as jest.Mock).mockReturnValue(chain);
      mockPaginate.mockResolvedValue({ data: [], metadata: { page: 1 } });

      await service.listEnvironments({ excludeStatuses });

      expect(chain.whereNull).not.toHaveBeenCalledWith('builds.deletedAt');
      expect(visibilityPredicate.whereNull).toHaveBeenCalledWith('builds.deletedAt');
      expect(deletedPredicate.whereNotNull).toHaveBeenCalledWith('builds.deletedAt');
      expect(deletedPredicate.where).toHaveBeenCalledWith('builds.status', BuildStatus.TORN_DOWN);
      if (excludedStatuses.length > 0) {
        expect(chain.whereNotIn).toHaveBeenCalledWith('builds.status', excludedStatuses);
      } else {
        expect(chain.whereNotIn).not.toHaveBeenCalled();
      }
    }
  );

  it('filters ready active named services before pagination when requested', async () => {
    const { service, models } = makeService();
    const chain = listChain();
    const readyServiceQuery: any = {
      select: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      whereColumn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
    };
    (models.Build.query as jest.Mock).mockReturnValue(chain);
    (models.Deploy.query as jest.Mock).mockReturnValue(readyServiceQuery);
    mockPaginate.mockResolvedValue({ data: [], metadata: { page: 1, items: 0 } });

    await service.listEnvironments({ hasReadyActiveService: true });

    expect(readyServiceQuery.select).toHaveBeenCalledWith('deploys.id');
    expect(readyServiceQuery.joinRelated).toHaveBeenCalledWith('deployable');
    expect(readyServiceQuery.whereColumn).toHaveBeenCalledWith('deploys.buildId', 'builds.id');
    expect(readyServiceQuery.where).toHaveBeenCalledWith('deploys.active', true);
    expect(readyServiceQuery.where).toHaveBeenCalledWith('deploys.status', DeployStatus.READY);
    expect(readyServiceQuery.whereNotNull).toHaveBeenCalledWith('deployable.name');
    expect(chain.whereExists).toHaveBeenCalledWith(readyServiceQuery);
  });

  it('resolves the detail repository for PR-less builds via the source join key', async () => {
    const { service } = makeService();
    mockGetAllConfigs.mockResolvedValue({
      ...API_CONFIG,
      domainDefaults: { http: '127.0.0.1.nip.io', grpc: '127.0.0.1.nip.io' },
    });
    jest.spyOn(service, 'getBuildByUUID').mockResolvedValue({
      uuid: 'api-env-222222',
      status: 'deployed',
      namespace: 'env-api-env-222222',
      triggerType: 'api',
      branchName: 'main',
      githubRepositoryId: 42,
      deployEnabled: true,
      configSha: 'abc',
      pullRequest: null,
      deploys: [
        {
          deployable: { name: 'app' },
          status: 'building',
          active: true,
          branchName: 'main',
          publicUrl: 'app-api-env-222222.127.0.0.1.nip.io',
          sha: 's',
        },
      ],
    } as any);
    const { Repository: RepositoryMock } = jest.requireMock('server/models');
    (RepositoryMock as any).query = jest.fn(() => ({
      findOne: jest.fn(() => ({
        whereNull: jest.fn().mockResolvedValue({ fullName: 'org/repo' }),
      })),
    }));

    const detail = await service.getEnvironmentDetail('api-env-222222');

    expect(service.getBuildByUUID).toHaveBeenCalledWith('api-env-222222', { liveOnly: true });
    expect(detail).toMatchObject({
      repository: 'org/repo',
      configSha: 'abc',
      activeServiceCount: 1,
      hasReadyActiveService: false,
      statusUrl: '/api/v2/environments/api-env-222222',
      services: [
        expect.objectContaining({
          name: 'app',
          status: 'building',
          publicUrl: 'app-api-env-222222.127.0.0.1.nip.io',
          publicHref: 'http://app-api-env-222222.127.0.0.1.nip.io',
        }),
      ],
    });
  });
});

describe('getBuildByUUID soft-delete semantics', () => {
  const detailChain = (row: any) => {
    const chain: any = {
      findOne: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockReturnThis(),
      modifyGraph: jest.fn().mockReturnThis(),
      then: (resolve: any, reject: any) => Promise.resolve(row).then(resolve, reject),
    };
    return chain;
  };

  function makeDetailService() {
    const { service, models } = makeService();
    jest.spyOn(service as any, 'attachServiceOverrideStateToDeploys').mockResolvedValue(undefined);
    return { service, models };
  }

  it('filters to live rows by default and allows an explicit tombstone lookup', async () => {
    const { service, models } = makeDetailService();
    const chain = detailChain({ uuid: 'x', deletedAt: null, deploys: [] });
    (models.Build.query as jest.Mock).mockReturnValue(chain);

    await service.getBuildByUUID('x');
    expect(chain.findOne).toHaveBeenCalledWith({ uuid: 'x' });
    expect(chain.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(chain.select.mock.calls[0]).toEqual(expect.arrayContaining(['deletedAt']));

    chain.whereNull.mockClear();
    await service.getBuildByUUID('x', { liveOnly: false });
    expect(chain.whereNull).not.toHaveBeenCalled();
  });

  it('can bind a live uuid lookup to the previously authorized build id', async () => {
    const { service, models } = makeDetailService();
    const chain = detailChain({ id: 7, uuid: 'x', deletedAt: null, deploys: [] });
    (models.Build.query as jest.Mock).mockReturnValue(chain);

    await service.getBuildByUUID('x', { liveOnly: true, expectedBuildId: 7 });

    expect(chain.findOne).toHaveBeenCalledWith({ uuid: 'x', id: 7 });
    expect(chain.whereNull).toHaveBeenCalledWith('deletedAt');
  });

  it('adds a public href to hydrated deploys without changing the stored host', async () => {
    const { service, models } = makeDetailService();
    const build = {
      id: 7,
      uuid: 'api-env-222222',
      deletedAt: null,
      deploys: [{ publicUrl: 'app-api-env-222222.127.0.0.1.nip.io' }],
    };
    const chain = detailChain(build);
    (models.Build.query as jest.Mock).mockReturnValue(chain);
    mockGetAllConfigs.mockResolvedValue({
      ...API_CONFIG,
      domainDefaults: { http: '127.0.0.1.nip.io', grpc: '127.0.0.1.nip.io' },
    });

    await expect(service.getBuildByUUID('api-env-222222')).resolves.toBe(build);

    expect(build.deploys[0]).toEqual({
      publicUrl: 'app-api-env-222222.127.0.0.1.nip.io',
      publicHref: 'http://app-api-env-222222.127.0.0.1.nip.io',
    });
  });

  it('keeps hydrated build details available when public href config lookup fails', async () => {
    const { service, models } = makeDetailService();
    const build = {
      id: 7,
      uuid: 'api-env-222222',
      deletedAt: null,
      deploys: [{ publicUrl: 'app.example.com' }],
    };
    const chain = detailChain(build);
    (models.Build.query as jest.Mock).mockReturnValue(chain);
    mockGetAllConfigs.mockRejectedValueOnce(new Error('config unavailable'));

    await expect(service.getBuildByUUID('api-env-222222')).resolves.toBe(build);

    expect(build.deploys[0]).toEqual({
      publicUrl: 'app.example.com',
      publicHref: 'https://app.example.com',
    });
  });

  it('prefers the live successor when the unfiltered lookup lands on a tombstone', async () => {
    const { service, models } = makeDetailService();
    const dead = { uuid: 'x', deletedAt: '2026-07-01T00:00:00Z', deploys: [] };
    const live = { uuid: 'x', deletedAt: null, deploys: [] };
    (models.Build.query as jest.Mock).mockReturnValueOnce(detailChain(dead)).mockReturnValueOnce(detailChain(live));

    await expect(service.getBuildByUUID('x', { liveOnly: false })).resolves.toBe(live);
  });

  it('returns the tombstone when no live row shares the uuid', async () => {
    const { service, models } = makeDetailService();
    const dead = { uuid: 'x', deletedAt: '2026-07-01T00:00:00Z', deploys: [] };
    (models.Build.query as jest.Mock)
      .mockReturnValueOnce(detailChain(dead))
      .mockReturnValueOnce(detailChain(undefined));

    await expect(service.getBuildByUUID('x', { liveOnly: false })).resolves.toBe(dead);
  });
});

describe('redeploy and destroy uuid liveness', () => {
  it('redeployBuild resolves only live builds', async () => {
    const { service, models } = makeService();
    const build = {
      id: 4,
      uuid: 'x',
      status: BuildStatus.DEPLOYED,
      deployEnabled: true,
      pullRequest: null,
      pullRequestId: null,
      deploys: [],
    };
    const whereNull = jest.fn(() => ({ withGraphFetched: jest.fn().mockResolvedValue(build) }));
    const findOne = jest.fn(() => ({ whereNull }));
    (models.Build.query as jest.Mock).mockReturnValue({ findOne });
    const enqueueResolve = jest.spyOn(service as any, 'enqueueResolveAndDeployBuild').mockResolvedValue(undefined);

    const result = await service.redeployBuild('x', 4);

    expect(findOne).toHaveBeenCalledWith({ uuid: 'x', id: 4 });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
    expect(enqueueResolve).toHaveBeenCalledWith(expect.objectContaining({ buildId: 4 }));
    expect(result).toMatchObject({ status: 'success' });
  });

  it.each([BuildStatus.TEARING_DOWN, BuildStatus.TORN_DOWN])(
    'redeployBuild rejects an exact-id build that became %s before enqueue',
    async (status) => {
      const { service, models } = makeService();
      const build = {
        id: 4,
        uuid: 'x',
        status,
        deployEnabled: true,
        pullRequest: null,
        pullRequestId: null,
        deploys: [],
      };
      const whereNull = jest.fn(() => ({ withGraphFetched: jest.fn().mockResolvedValue(build) }));
      (models.Build.query as jest.Mock).mockReturnValue({ findOne: jest.fn(() => ({ whereNull })) });
      const enqueueResolve = jest.spyOn(service as any, 'enqueueResolveAndDeployBuild').mockResolvedValue(undefined);

      await expect(service.redeployBuild('x', 4)).resolves.toMatchObject({ status: 'tearing_down' });

      expect(enqueueResolve).not.toHaveBeenCalled();
    }
  );

  it('redeployBuild reports not_found when the exact authorized row was released', async () => {
    const { service, models } = makeService();
    const whereNull = jest.fn(() => ({ withGraphFetched: jest.fn().mockResolvedValue(undefined) }));
    (models.Build.query as jest.Mock).mockReturnValue({ findOne: jest.fn(() => ({ whereNull })) });
    const enqueueResolve = jest.spyOn(service as any, 'enqueueResolveAndDeployBuild').mockResolvedValue(undefined);

    await expect(service.redeployBuild('x', 4)).resolves.toMatchObject({ status: 'not_found' });
    expect(enqueueResolve).not.toHaveBeenCalled();
  });

  it('redeployServiceFromBuild binds the authorized live row id', async () => {
    const { service, models } = makeService();
    const deploy = {
      id: 9,
      deployable: { name: 'app', repositoryId: 1 },
      $query: jest.fn(() => ({ patchAndFetch: jest.fn().mockResolvedValue(undefined) })),
    };
    const live = {
      id: 4,
      uuid: 'x',
      deletedAt: null,
      status: BuildStatus.DEPLOYED,
      deployEnabled: true,
      pullRequest: null,
      pullRequestId: null,
      deploys: [deploy],
    };
    const withGraphFetched = jest.fn().mockResolvedValue(live);
    const whereNull = jest.fn(() => ({ withGraphFetched }));
    const findOne = jest.fn(() => ({ whereNull }));
    (models.Build.query as jest.Mock).mockReturnValue({ findOne });
    const enqueueResolve = jest.spyOn(service as any, 'enqueueResolveAndDeployBuild').mockResolvedValue(undefined);

    const result = await service.redeployServiceFromBuild('x', 'app', 4);

    expect(findOne).toHaveBeenCalledWith({ uuid: 'x', id: 4 });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
    expect(enqueueResolve).toHaveBeenCalledWith(expect.objectContaining({ buildId: 4 }));
    expect(result).toMatchObject({ status: 'success' });
  });

  it('redeployBuild rechecks the API deploy gate after acquiring the exact-id lock', async () => {
    const { service, models } = makeService();
    const paused = {
      id: 4,
      uuid: 'x',
      status: BuildStatus.DEPLOYED,
      deployEnabled: false,
      pullRequest: null,
      pullRequestId: null,
      deploys: [],
    };
    const whereNull = jest.fn(() => ({ withGraphFetched: jest.fn().mockResolvedValue(paused) }));
    (models.Build.query as jest.Mock).mockReturnValue({ findOne: jest.fn(() => ({ whereNull })) });
    const enqueueResolve = jest.spyOn(service as any, 'enqueueResolveAndDeployBuild').mockResolvedValue(undefined);

    await expect(service.redeployBuild('x', 4)).resolves.toMatchObject({ status: 'deploy_disabled' });
    expect(enqueueResolve).not.toHaveBeenCalled();
  });

  it('redeployServiceFromBuild rechecks the PR label gate after acquiring the exact-id lock', async () => {
    const { service, models } = makeService();
    const disabled = {
      id: 4,
      uuid: 'x',
      status: BuildStatus.DEPLOYED,
      pullRequestId: 55,
      pullRequest: { status: 'open', deployOnUpdate: false },
      deploys: [],
    };
    const whereNull = jest.fn(() => ({ withGraphFetched: jest.fn().mockResolvedValue(disabled) }));
    (models.Build.query as jest.Mock).mockReturnValue({ findOne: jest.fn(() => ({ whereNull })) });
    const enqueueResolve = jest.spyOn(service as any, 'enqueueResolveAndDeployBuild').mockResolvedValue(undefined);

    await expect(service.redeployServiceFromBuild('x', 'app', 4)).resolves.toMatchObject({
      status: 'deploy_disabled',
    });
    expect(enqueueResolve).not.toHaveBeenCalled();
  });

  it('destroyBuildEnvironment binds the authorized live row id', async () => {
    const { service, models, queueAdd } = makeService();
    const live = { id: 2, uuid: 'x', deletedAt: null, isStatic: false };
    const whereNull = jest.fn().mockResolvedValue(live);
    const findOne = jest.fn(() => ({ whereNull }));
    (models.Build.query as jest.Mock).mockReturnValue({ findOne });

    const result = await service.destroyBuildEnvironment('x', 2);

    expect(findOne).toHaveBeenCalledWith({ uuid: 'x', id: 2 });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
    expect(queueAdd).toHaveBeenCalledWith(
      'delete',
      expect.objectContaining({
        buildId: 2,
        buildUuid: 'x',
        reason: 'manual_destroy',
        teardownRunUUID: expect.any(String),
      }),
      expect.objectContaining({ jobId: 'build-delete-2-authoritative', attempts: 3 })
    );
    expect(result).toMatchObject({ status: 'success' });
  });

  it('destroyBuildEnvironment not_founds a uuid held only by tombstones', async () => {
    const { service, models, queueAdd } = makeService();
    (models.Build.query as jest.Mock).mockReturnValue({
      findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(undefined) })),
    });

    const result = await service.destroyBuildEnvironment('x');

    expect(result).toMatchObject({ status: 'not_found' });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('invokeWebhooksForBuild does not fall through to a successor after the authorized row is released', async () => {
    const { service, models } = makeService();
    const whereNull = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn(() => ({ whereNull }));
    (models.Build.query as jest.Mock).mockReturnValue({ findOne });

    await expect(service.invokeWebhooksForBuild('x', 4)).resolves.toMatchObject({ status: 'not_found' });

    expect(findOne).toHaveBeenCalledWith({ uuid: 'x', id: 4 });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
  });

  it('getWebhooksForBuild does not read a successor after the authorized row is released', async () => {
    const { service, models } = makeService();
    const whereNull = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn(() => ({ whereNull }));
    const select = jest.fn(() => ({ findOne }));
    (models.Build.query as jest.Mock).mockReturnValue({ select });

    await expect(service.getWebhooksForBuild('x', 4)).resolves.toMatchObject({ status: 'not_found' });

    expect(findOne).toHaveBeenCalledWith({ uuid: 'x', id: 4 });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
  });
});

describe('processDeleteQueue', () => {
  const deleteJob = (reason?: string) => ({ data: { buildId: 3, buildUuid: 'x', reason } });

  function makeDeleteQueueService(build: any) {
    const { service, models } = makeService();
    if (build) {
      Object.assign(build, {
        kind: build.kind ?? 'environment',
        triggerType: build.triggerType ?? 'api',
        pullRequestId: build.pullRequestId ?? null,
        status: build.status ?? BuildStatus.DEPLOYED,
      });
    }
    const claimPatch = jest.fn(async (patch: any) => Object.assign(build, patch));
    if (build && !build.$query) build.$query = jest.fn(() => ({ patch: claimPatch }));
    const expiryLock: any = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockResolvedValue(build),
    };
    (models.Build.query as jest.Mock).mockReturnValue({
      findById: jest.fn(() => expiryLock),
      findOne: jest.fn().mockResolvedValue(build),
    });
    const deleteBuild = jest.fn().mockResolvedValue(undefined);
    (service.db.services as any).BuildService = { deleteBuild };
    return { service, deleteBuild, expiryLock, claimPatch };
  }

  it('skips a lease_expired deletion when the lease was extended after enqueue', async () => {
    const build = { id: 3, uuid: 'x', expiresAt: new Date(NOW.getTime() + 3600 * 1000).toISOString() };
    const { service, deleteBuild } = makeDeleteQueueService(build);

    await service.processDeleteQueue(deleteJob('lease_expired'));

    expect(deleteBuild).not.toHaveBeenCalled();
  });

  it('deletes a lease_expired build whose lease is still expired', async () => {
    const build = { id: 3, uuid: 'x', expiresAt: new Date(NOW.getTime() - 1000).toISOString() };
    const { service, deleteBuild, expiryLock, claimPatch } = makeDeleteQueueService(build);

    await service.processDeleteQueue(deleteJob('lease_expired'));

    expect(expiryLock.forUpdate).toHaveBeenCalled();
    expect(claimPatch).toHaveBeenCalledWith(
      expect.objectContaining({ status: BuildStatus.TEARING_DOWN, deployEnabled: false, runUUID: expect.any(String) })
    );
    expect(deleteBuild).toHaveBeenCalledWith(
      build,
      expect.objectContaining({ rethrow: true, runUUID: expect.any(String) })
    );
  });

  it('serializes an expiry claim ahead of a concurrent extension so teardown wins cleanly', async () => {
    const sharedBuild: any = {
      id: 3,
      uuid: 'x',
      kind: 'environment',
      triggerType: 'api',
      status: BuildStatus.DEPLOYED,
      expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    };
    let releaseExpiryLock!: () => void;
    const expiryLockReleased = new Promise<void>((resolve) => {
      releaseExpiryLock = resolve;
    });
    let expiryLockAcquired!: () => void;
    const expiryLockWasAcquired = new Promise<void>((resolve) => {
      expiryLockAcquired = resolve;
    });

    const { service, models } = makeService();
    let transactionTail = Promise.resolve<unknown>(undefined);
    (models.Build.transact as jest.Mock).mockImplementation((callback: (trx: object) => Promise<unknown>) => {
      const transaction = transactionTail.then(() => callback({}));
      transactionTail = transaction.then(
        () => undefined,
        () => undefined
      );
      return transaction;
    });

    sharedBuild.$query = jest.fn(() => ({
      patch: jest.fn(async (patch: any) => Object.assign(sharedBuild, patch)),
    }));
    const deleteLock: any = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      forUpdate: jest.fn(async () => {
        expiryLockAcquired();
        await expiryLockReleased;
        return sharedBuild;
      }),
    };
    const extensionLock: any = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockResolvedValue(sharedBuild),
    };
    (models.Build.query as jest.Mock).mockImplementation(() => ({
      findById: jest.fn(() => deleteLock),
      findOne: jest.fn(() => extensionLock),
      patchAndFetchById: jest.fn(),
    }));
    const deleteBuild = jest.fn().mockResolvedValue(undefined);
    (service.db.services as any).BuildService = { deleteBuild };

    const deletion = service.processDeleteQueue(deleteJob('lease_expired'));
    await expiryLockWasAcquired;
    const extension = service.extendApiEnvironment('x');
    releaseExpiryLock();

    await expect(deletion).resolves.toBeUndefined();
    await expect(extension).rejects.toMatchObject({ code: 'env_tearing_down' });
    expect(deleteBuild).toHaveBeenCalledWith(
      sharedBuild,
      expect.objectContaining({ rethrow: true, runUUID: expect.any(String) })
    );
  });

  it('scopes the lease-extension guard to lease_expired deletions', async () => {
    const build = { id: 3, uuid: 'x', expiresAt: new Date(NOW.getTime() + 3600 * 1000).toISOString() };
    const { service, deleteBuild } = makeDeleteQueueService(build);

    await service.processDeleteQueue(deleteJob('api_delete'));

    expect(deleteBuild).toHaveBeenCalledWith(
      build,
      expect.objectContaining({ rethrow: true, runUUID: expect.any(String) })
    );
  });

  it('skips a stale PR close deletion after the PR is open and deploy-enabled again', async () => {
    const build = {
      id: 3,
      uuid: 'x',
      pullRequestId: 44,
      pullRequest: { status: 'open', deployOnUpdate: true },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const { service, deleteBuild, claimPatch } = makeDeleteQueueService(build);

    await service.processDeleteQueue(deleteJob('pull_request_closed'));

    expect(build.$fetchGraph).toHaveBeenCalledWith('pullRequest', expect.objectContaining({ transaction: {} }));
    expect(claimPatch).not.toHaveBeenCalled();
    expect(deleteBuild).not.toHaveBeenCalled();
  });

  it('keeps a manual destroy authoritative after a PR is re-enabled', async () => {
    const build = {
      id: 3,
      uuid: 'x',
      pullRequestId: 44,
      pullRequest: { status: 'open', deployOnUpdate: true },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const { service, deleteBuild, claimPatch } = makeDeleteQueueService(build);

    await service.processDeleteQueue(deleteJob('manual_destroy'));

    expect(claimPatch).toHaveBeenCalledWith({ runUUID: expect.any(String) });
    expect(deleteBuild).toHaveBeenCalled();
  });

  it('skips a duplicate worker that does not own an in-progress teardown', async () => {
    const build = {
      id: 3,
      uuid: 'x',
      status: BuildStatus.TEARING_DOWN,
      runUUID: 'teardown-owner',
      expiresAt: null,
    };
    const { service, deleteBuild, claimPatch } = makeDeleteQueueService(build);

    await service.processDeleteQueue({
      id: 'duplicate-job',
      data: {
        buildId: 3,
        buildUuid: 'x',
        reason: 'api_delete',
        teardownRunUUID: 'different-owner',
      },
    });

    expect(claimPatch).not.toHaveBeenCalled();
    expect(deleteBuild).not.toHaveBeenCalled();
  });

  it('lets only one concurrent delete job clean up before the vanity name can be reused', async () => {
    const sharedBuild: any = {
      id: 3,
      uuid: 'same-name-123456',
      namespace: 'env-same-name-123456',
      kind: 'environment',
      triggerType: 'api',
      pullRequestId: null,
      status: BuildStatus.DEPLOYED,
      runUUID: 'deploy-owner',
      deletedAt: null,
    };
    const { service, models } = makeService();
    let transactionTail = Promise.resolve<unknown>(undefined);
    (models.Build.transact as jest.Mock).mockImplementation((callback: (trx: object) => Promise<unknown>) => {
      const transaction = transactionTail.then(() => callback({}));
      transactionTail = transaction.then(
        () => undefined,
        () => undefined
      );
      return transaction;
    });
    sharedBuild.$query = jest.fn(() => ({
      patch: jest.fn(async (patch: any) => Object.assign(sharedBuild, patch)),
    }));
    const lock: any = {
      whereNull: jest.fn().mockReturnThis(),
      forUpdate: jest.fn(async () => (sharedBuild.deletedAt ? undefined : sharedBuild)),
    };
    (models.Build.query as jest.Mock).mockImplementation(() => ({ findById: jest.fn(() => lock) }));

    let finishCleanup!: () => void;
    const cleanupCanFinish = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let cleanupStarted!: () => void;
    const cleanupDidStart = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const deleteBuild = jest.fn(async () => {
      cleanupStarted();
      await cleanupCanFinish;
      sharedBuild.deletedAt = NOW.toISOString();
    });
    (service.db.services as any).BuildService = { deleteBuild };

    const first = service.processDeleteQueue({
      id: 'first',
      data: {
        buildId: 3,
        buildUuid: sharedBuild.uuid,
        reason: 'api_delete',
        teardownRunUUID: 'first-owner',
      },
      opts: { attempts: 3 },
    });
    await cleanupDidStart;
    const duplicate = service.processDeleteQueue({
      id: 'second',
      data: {
        buildId: 3,
        buildUuid: sharedBuild.uuid,
        reason: 'api_delete',
        teardownRunUUID: 'second-owner',
      },
      opts: { attempts: 3 },
    });

    await expect(duplicate).resolves.toBeUndefined();
    finishCleanup();
    await expect(first).resolves.toBeUndefined();

    const successor = { uuid: sharedBuild.uuid, namespace: sharedBuild.namespace };
    expect(successor.uuid).toBe('same-name-123456');
    expect(deleteBuild).toHaveBeenCalledTimes(1);
  });

  it('resolves without deleting when the build is missing', async () => {
    const { service, deleteBuild } = makeDeleteQueueService(undefined);

    await expect(service.processDeleteQueue(deleteJob('lease_expired'))).resolves.toBeUndefined();
    expect(deleteBuild).not.toHaveBeenCalled();
  });

  it('rethrows teardown failures for jobs enqueued with a retry budget', async () => {
    const build = { id: 3, uuid: 'x', expiresAt: null };
    const { service, deleteBuild } = makeDeleteQueueService(build);
    deleteBuild.mockRejectedValue(new Error('namespace delete failed'));

    await expect(
      service.processDeleteQueue({
        data: { buildId: 3, buildUuid: 'x', reason: 'api_delete' },
        opts: { attempts: 3 },
      })
    ).rejects.toThrow('namespace delete failed');
  });

  it('keeps log-and-drop for legacy delete jobs without a retry budget', async () => {
    const build = { id: 3, uuid: 'x', expiresAt: null };
    const { service, deleteBuild } = makeDeleteQueueService(build);
    deleteBuild.mockRejectedValue(new Error('namespace delete failed'));

    await expect(service.processDeleteQueue({ data: { buildId: 3, buildUuid: 'x' } })).resolves.toBeUndefined();
  });
});

describe('deleteBuild teardown ownership', () => {
  function makeTeardownBuild(overrides: any = {}) {
    const patch = jest.fn().mockResolvedValue(1);
    const build: any = {
      id: 7,
      uuid: 'api-env-123456',
      namespace: 'env-api-env-123456',
      status: 'deployed',
      runUUID: 'run-before',
      pullRequestId: null,
      idempotencyKey: 'token:7:k1',
      deployEnabled: true,
      githubDeployments: false,
      deploys: [],
      reload: jest.fn().mockResolvedValue(undefined),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(() => ({ patch })),
      ...overrides,
    };
    return { build, patch };
  }

  function makeTeardownService() {
    const { service } = makeService();
    const updateStatus = jest
      .spyOn(service as any, 'updateStatusAndComment')
      .mockResolvedValue(undefined) as jest.SpyInstance;
    return { service, updateStatus };
  }

  it('closes the deploy gate and takes runUUID ownership before tearing down a PR-less build', async () => {
    const { service, updateStatus } = makeTeardownService();
    const { build, patch } = makeTeardownBuild();

    await service.deleteBuild(build);

    const ownership = patch.mock.calls.find(([p]) => p.deployEnabled === false);
    expect(ownership).toBeDefined();
    expect(ownership![0].runUUID).toEqual(expect.any(String));
    expect(ownership![0].runUUID).not.toBe('run-before');
    expect(updateStatus).toHaveBeenCalledWith(build, BuildStatus.TEARING_DOWN, ownership![0].runUUID, true, true);
    expect(updateStatus).toHaveBeenCalledWith(build, BuildStatus.TORN_DOWN, ownership![0].runUUID, true, true);
  });

  it('releases the idempotency key on teardown', async () => {
    const { service } = makeTeardownService();
    const { build, patch } = makeTeardownBuild();

    await service.deleteBuild(build);

    expect(patch).toHaveBeenCalledWith({ idempotencyKey: null });
  });

  it('does not patch a key release when the key is already null', async () => {
    const { service } = makeTeardownService();
    const { build, patch } = makeTeardownBuild({ idempotencyKey: null });

    await service.deleteBuild(build);

    expect(patch).not.toHaveBeenCalledWith({ idempotencyKey: null });
  });

  it('leaves PR builds untouched: no gate flip, no runUUID bump', async () => {
    const { service, updateStatus } = makeTeardownService();
    const { build, patch } = makeTeardownBuild({ pullRequestId: 55, idempotencyKey: null });

    await service.deleteBuild(build);

    expect(patch.mock.calls.some(([p]) => 'deployEnabled' in p || 'runUUID' in p)).toBe(false);
    expect(updateStatus).toHaveBeenCalledWith(build, BuildStatus.TEARING_DOWN, 'run-before', true, true);
  });

  it('soft-deletes torn-down API environments so the vanity uuid is released', async () => {
    const { service } = makeTeardownService();
    const { build, patch } = makeTeardownBuild({ kind: 'environment', triggerType: 'api' });

    await service.deleteBuild(build);

    expect(patch).toHaveBeenCalledWith({ idempotencyKey: null, deletedAt: expect.any(String) });
  });

  it('does not soft-delete sandbox clones that inherit triggerType=api', async () => {
    const { service } = makeTeardownService();
    const { build, patch } = makeTeardownBuild({ kind: 'sandbox', triggerType: 'api', idempotencyKey: null });

    await service.deleteBuild(build);

    expect(patch.mock.calls.some(([p]) => 'deletedAt' in p)).toBe(false);
  });

  it('completes teardown through namespace deletion when an infrastructure cleanup step fails', async () => {
    const { service, updateStatus } = makeTeardownService();
    const { build } = makeTeardownBuild({ kind: 'environment', triggerType: 'api' });
    const kubernetes = jest.requireMock('server/lib/kubernetes');
    kubernetes.deleteBuild.mockRejectedValueOnce(new Error('cleanup failed'));

    await expect(service.deleteBuild(build, { rethrow: true })).resolves.toBeUndefined();

    expect(kubernetes.deleteNamespace).toHaveBeenCalledWith('env-api-env-123456');
    expect(updateStatus).toHaveBeenCalledWith(build, BuildStatus.TORN_DOWN, expect.any(String), true, true);
  });

  it('rethrows namespace deletion failures before marking teardown complete', async () => {
    const { service, updateStatus } = makeTeardownService();
    const { build, patch } = makeTeardownBuild({ kind: 'environment', triggerType: 'api' });
    const kubernetes = jest.requireMock('server/lib/kubernetes');
    kubernetes.deleteNamespace.mockRejectedValueOnce(new Error('namespace delete failed'));

    await expect(service.deleteBuild(build, { rethrow: true })).rejects.toThrow('namespace delete failed');

    expect(updateStatus).not.toHaveBeenCalledWith(build, BuildStatus.TORN_DOWN, expect.any(String), true, true);
    expect(patch.mock.calls.some(([value]) => value.deletedAt != null)).toBe(false);
  });

  it('retries identity release after cleanup already reached torn_down', async () => {
    const { service } = makeTeardownService();
    const { build, patch } = makeTeardownBuild({
      status: BuildStatus.TORN_DOWN,
      kind: 'environment',
      triggerType: 'api',
    });
    patch.mockRejectedValueOnce(new Error('identity release failed')).mockResolvedValueOnce(1);

    await expect(service.deleteBuild(build, { rethrow: true })).rejects.toThrow('identity release failed');
    await expect(service.deleteBuild(build, { rethrow: true })).resolves.toBeUndefined();

    expect(patch).toHaveBeenLastCalledWith({ idempotencyKey: null, deletedAt: expect.any(String) });
  });

  it('swallows teardown failures unless the caller opts into rethrow', async () => {
    const { service } = makeTeardownService();
    const { build } = makeTeardownBuild();
    build.reload.mockRejectedValue(new Error('db down'));

    await expect(service.deleteBuild(build)).resolves.toBeUndefined();
    await expect(service.deleteBuild(build, { rethrow: true })).rejects.toThrow('db down');
  });
});

describe('deploy pipeline torn-down guards', () => {
  const pipelineBuild = (overrides: any = {}) => ({
    id: 7,
    uuid: 'api-env-123456',
    status: BuildStatus.TORN_DOWN,
    deletedAt: null,
    deployEnabled: true,
    pullRequest: null,
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  function makePipelineService(build: any) {
    const { service, models } = makeService();
    (models.Build.query as jest.Mock).mockReturnValue({ findOne: jest.fn().mockResolvedValue(build) });
    return { service };
  }

  it('processResolveAndDeployBuildQueue skips torn-down PR-less builds', async () => {
    const build = pipelineBuild();
    const { service } = makePipelineService(build);
    const enqueueBuildJob = jest.spyOn(service as any, 'enqueueBuildJob').mockResolvedValue(undefined);

    await service.processResolveAndDeployBuildQueue({ data: { buildId: 7 } });

    expect(enqueueBuildJob).not.toHaveBeenCalled();
  });

  it('processResolveAndDeployBuildQueue lets a re-enabled open PR recreate a torn-down build', async () => {
    const build = pipelineBuild({
      pullRequestId: 55,
      pullRequest: { status: 'open', deployOnUpdate: true, $fetchGraph: jest.fn() },
    });
    const { service } = makePipelineService(build);
    const enqueueBuildJob = jest.spyOn(service as any, 'enqueueBuildJob').mockResolvedValue(undefined);

    await service.processResolveAndDeployBuildQueue({ data: { buildId: 7 } });

    expect(enqueueBuildJob).toHaveBeenCalled();
  });

  it('processBuildQueue skips torn-down PR-less builds before importing yaml', async () => {
    const build = pipelineBuild({ status: BuildStatus.TEARING_DOWN });
    const { service } = makePipelineService(build);
    const importYaml = jest.spyOn(service as any, 'importYamlConfigFile').mockResolvedValue(undefined);
    const resolveAndDeploy = jest.fn().mockResolvedValue(undefined);
    (service.db.services as any).BuildService = { resolveAndDeployBuild: resolveAndDeploy };

    await service.processBuildQueue({ data: { buildId: 7 } });

    expect(importYaml).not.toHaveBeenCalled();
    expect(resolveAndDeploy).not.toHaveBeenCalled();
  });

  it('processBuildQueue lets a re-enabled open PR reclaim and recreate a torn-down build', async () => {
    const build = pipelineBuild({
      pullRequestId: 55,
      pullRequest: { status: 'open', deployOnUpdate: true, $fetchGraph: jest.fn() },
    });
    const { service } = makePipelineService(build);
    jest.spyOn(service as any, 'importYamlConfigFile').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'claimDeploymentRun').mockResolvedValue('recreate-run');
    jest.spyOn(service as any, 'isDeploymentRunCurrent').mockResolvedValue(true);
    const resolveAndDeploy = jest.spyOn(service, 'resolveAndDeployBuild').mockResolvedValue(build);

    await service.processBuildQueue({ data: { buildId: 7 } });

    expect(resolveAndDeploy).toHaveBeenCalledWith(
      build,
      true,
      undefined,
      undefined,
      expect.objectContaining({
        deploymentLockAlreadyHeld: true,
        runAlreadyClaimed: true,
        runUUID: 'recreate-run',
      })
    );
  });

  it.each([
    { pullRequest: { status: 'open', deployOnUpdate: false }, label: 'label-disabled' },
    { pullRequest: { status: 'closed', deployOnUpdate: true }, label: 'closed' },
  ])('processBuildQueue fails closed for a $label PR', async ({ pullRequest }) => {
    const build = pipelineBuild({
      status: BuildStatus.DEPLOYED,
      pullRequestId: 55,
      pullRequest: { ...pullRequest, $fetchGraph: jest.fn() },
    });
    const { service } = makePipelineService(build);
    const importYaml = jest.spyOn(service as any, 'importYamlConfigFile').mockResolvedValue(undefined);

    await service.processBuildQueue({ data: { buildId: 7 } });

    expect(importYaml).not.toHaveBeenCalled();
  });
});

describe('serialized build setup and deploy workers', () => {
  it('serializes YAML import through deploy completion for distinct triggers on one build', async () => {
    const { service } = makeService();
    const build: any = {
      id: 7,
      uuid: 'pr-env-123456',
      status: BuildStatus.DEPLOYED,
      pullRequestId: 55,
      pullRequest: { status: 'open', deployOnUpdate: true },
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(service as any, 'loadBuildDeploymentAuthority').mockResolvedValue(build);
    jest
      .spyOn(service as any, 'claimDeploymentRun')
      .mockImplementation(async (_build: any, requested: string) => requested);
    jest.spyOn(service as any, 'isDeploymentRunCurrent').mockResolvedValue(true);
    const importYaml = jest.spyOn(service as any, 'importYamlConfigFile').mockResolvedValue(undefined);

    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const resolveAndDeploy = jest
      .spyOn(service, 'resolveAndDeployBuild')
      .mockImplementation(async (_build, _enabled, _repo, sourceRef) => {
        if (sourceRef === 'sha-a') {
          firstStarted();
          await firstCanFinish;
        }
        return build;
      });

    let lockTail = Promise.resolve<unknown>(undefined);
    jest.spyOn(service, 'withBuildDeploymentLock').mockImplementation((_buildId, action) => {
      const run = lockTail.then(action);
      lockTail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    });

    const first = service.processBuildQueue({
      data: { buildId: 7, runUUID: 'run-a', triggerRef: 'sha-a', sourceRef: 'sha-a' },
    });
    await firstDidStart;
    const second = service.processBuildQueue({
      data: { buildId: 7, runUUID: 'run-b', triggerRef: 'sha-b', sourceRef: 'sha-b' },
    });

    await Promise.resolve();
    expect(importYaml).toHaveBeenCalledTimes(1);
    expect(resolveAndDeploy).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(importYaml.mock.calls.map((call) => (call[3] as { sourceRef?: string } | undefined)?.sourceRef)).toEqual([
      'sha-a',
      'sha-b',
    ]);
    expect(resolveAndDeploy.mock.calls.map((call) => call[3])).toEqual(['sha-a', 'sha-b']);
  });

  it('skips a delayed older trigger before YAML import after a newer sequence claimed the scope', async () => {
    const { service } = makeService();
    const build: any = {
      id: 7,
      uuid: 'pr-env-123456',
      status: BuildStatus.DEPLOYED,
      pullRequestId: 55,
      pullRequest: { status: 'open', deployOnUpdate: true },
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(service as any, 'loadBuildDeploymentAuthority').mockResolvedValue(build);
    jest.spyOn(service as any, 'resolveEffectiveSourceRef').mockResolvedValue('old-sha');
    jest.spyOn(service as any, 'claimTriggerSequence').mockResolvedValue(false);
    const claimRun = jest.spyOn(service as any, 'claimDeploymentRun');
    const importYaml = jest.spyOn(service as any, 'importYamlConfigFile');

    await service.processBuildQueue({
      data: {
        buildId: 7,
        githubRepositoryId: 42,
        sourceGithubRepositoryId: 42,
        sourceBranch: 'main',
        triggerSequence: '101',
        triggerRef: 'old-sha',
        sourceRef: 'old-sha',
      },
    });

    expect(claimRun).not.toHaveBeenCalled();
    expect(importYaml).not.toHaveBeenCalled();
  });

  it('converges a stale pushed source to the live branch head instead of dropping the push', async () => {
    const { service } = makeService();
    const build: any = {
      id: 7,
      uuid: 'api-env-123456',
      status: BuildStatus.DEPLOYED,
      deployEnabled: true,
      deletedAt: null,
      pullRequest: null,
      pullRequestId: null,
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(service as any, 'loadBuildDeploymentAuthority').mockResolvedValue(build);
    const resolveRef = jest.spyOn(service as any, 'resolveEffectiveSourceRef').mockResolvedValue('newest-sha');
    const claimSequence = jest.spyOn(service as any, 'claimTriggerSequence').mockResolvedValue(true);
    jest.spyOn(service as any, 'claimDeploymentRun').mockResolvedValue('run-1');
    jest.spyOn(service as any, 'isDeploymentRunCurrent').mockResolvedValue(true);
    const importYaml = jest.spyOn(service as any, 'importYamlConfigFile').mockResolvedValue(undefined);
    const resolveAndDeploy = jest.spyOn(service, 'resolveAndDeployBuild').mockResolvedValue(build);

    await service.processBuildQueue({
      data: {
        buildId: 7,
        sourceGithubRepositoryId: 42,
        sourceBranch: 'Main',
        sourceRef: 'older-sha',
        triggerSequence: '101',
      },
    });

    expect(resolveRef).toHaveBeenCalledWith(42, 'Main', 'older-sha');
    expect(claimSequence).toHaveBeenCalled();
    expect(importYaml).toHaveBeenCalledWith(
      build.environment,
      build,
      undefined,
      expect.objectContaining({ sourceRef: 'newest-sha', sourceBranch: 'Main' })
    );
    expect(resolveAndDeploy).toHaveBeenCalledWith(build, true, undefined, 'newest-sha', expect.any(Object));
  });

  it('rethrows lock acquisition failures so BullMQ retries instead of dropping the trigger', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'withBuildDeploymentLock').mockRejectedValue(new Error('lock acquisition timed out'));

    await expect(service.processBuildQueue({ data: { buildId: 7 } })).rejects.toThrow('lock acquisition timed out');
  });

  it('re-reads PR authority under the setup lock before importing YAML', async () => {
    const { service } = makeService();
    const build: any = {
      id: 7,
      uuid: 'pr-env-123456',
      status: BuildStatus.QUEUED,
      pullRequestId: 55,
      pullRequest: { status: 'closed', deployOnUpdate: true },
    };
    jest.spyOn(service as any, 'findOrCreateBuild').mockResolvedValue(build);
    jest.spyOn(service as any, 'loadBuildDeploymentAuthority').mockResolvedValue(build);
    const lock = jest.spyOn(service, 'withBuildDeploymentLock');
    const importYaml = jest.spyOn(service as any, 'importYamlConfigFile').mockResolvedValue(undefined);

    await service.createBuild({ id: 5 } as any, { pullRequestId: 55, repositoryId: 1 }, {} as any);

    expect(lock).toHaveBeenCalledWith(7, expect.any(Function));
    expect(importYaml).not.toHaveBeenCalled();
  });

  it('keeps no-label setup valid for an open PR while deployment itself remains gated', () => {
    const { service } = makeService();
    expect(
      (service as any).buildSetupBlockReason({
        status: BuildStatus.QUEUED,
        pullRequestId: 55,
        pullRequest: { status: 'open', deployOnUpdate: false },
      })
    ).toBeNull();
    expect(
      (service as any).deploymentBlockReason({
        status: BuildStatus.QUEUED,
        pullRequestId: 55,
        pullRequest: { status: 'open', deployOnUpdate: false },
      })
    ).toBe('deploy_disabled');
  });
});

describe('resolveAndDeployBuild teardown-ownership abort', () => {
  function makeDeployRunService(
    currentRow: (patchedRunUUID: string | null) => any,
    { claimResult = 1 }: { claimResult?: number } = {}
  ) {
    const { service, models, services } = makeService();
    let patchedRunUUID: string | null = null;
    const build: any = {
      id: 7,
      uuid: 'api-env-123456',
      namespace: 'env-api-env-123456',
      branchName: 'main',
      configSha: 'abc',
      githubRepositoryId: 42,
      pullRequest: null,
      pullRequestId: null,
      status: BuildStatus.DEPLOYED,
      deletedAt: null,
      deployEnabled: true,
      environment: { id: 5 },
      $query: jest.fn(() => ({
        patch: jest.fn(async (p: any) => {
          if (p?.runUUID) patchedRunUUID = p.runUUID;
        }),
      })),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $setRelated: jest.fn(),
    };
    const claimChain: any = {
      where: jest.fn(() => claimChain),
      whereNotIn: jest.fn(() => claimChain),
      whereNull: jest.fn(() => claimChain),
      then: (resolve: any, reject: any) => Promise.resolve(claimResult).then(resolve, reject),
    };
    const claimPatch = jest.fn((p: any) => {
      if (p?.runUUID && claimResult > 0) patchedRunUUID = p.runUUID;
      return claimChain;
    });
    (models.Build.query as jest.Mock).mockReturnValue({
      findById: jest.fn(() => ({
        select: jest.fn(async () => {
          const current: any = {
            id: build.id,
            pullRequestId: build.pullRequestId,
            status: build.status,
            deletedAt: build.deletedAt,
            deployEnabled: build.deployEnabled,
            ...currentRow(patchedRunUUID),
          };
          current.$fetchGraph = jest.fn(async () => {
            current.pullRequest = build.pullRequest;
          });
          return current;
        }),
      })),
      patch: claimPatch,
    });
    const { Repository: RepositoryMock } = jest.requireMock('server/models');
    (RepositoryMock as any).query = jest.fn(() => ({
      findOne: jest.fn(() => ({
        whereNull: jest.fn().mockResolvedValue({ fullName: 'org/repo' }),
      })),
    }));
    (services.Deploy.findOrCreateDeploys as jest.Mock).mockResolvedValue([{ id: 1 }]);
    (service.db.services as any).BuildService = service;
    jest.spyOn(service as any, 'markConfigurationsAsBuilt').mockResolvedValue(undefined);
    const updateStatus = jest
      .spyOn(service as any, 'updateStatusAndComment')
      .mockResolvedValue(undefined) as jest.SpyInstance;
    const buildImages = jest.spyOn(service as any, 'buildImages').mockResolvedValue(true) as jest.SpyInstance;
    jest.spyOn(service as any, 'deployCLIServices').mockResolvedValue(true);
    const applyManifests = jest
      .spyOn(service as any, 'generateAndApplyManifests')
      .mockResolvedValue(true) as jest.SpyInstance;
    const recordFailure = jest
      .spyOn(service as any, 'recordBuildFailure')
      .mockResolvedValue(undefined) as jest.SpyInstance;
    return { service, build, claimChain, claimPatch, buildImages, applyManifests, updateStatus, recordFailure };
  }

  it('aborts the manifest apply when teardown took runUUID ownership mid-flight', async () => {
    const { service, build, applyManifests, recordFailure, updateStatus } = makeDeployRunService(() => ({
      runUUID: 'teardown-owner',
      status: BuildStatus.TEARING_DOWN,
    }));

    await service.resolveAndDeployBuild(build, true);

    expect(applyManifests).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalledWith(build, BuildStatus.DEPLOYED, expect.any(String), true, true);
  });

  it('aborts the manifest apply when an API environment is paused mid-run', async () => {
    const { service, build, applyManifests, recordFailure } = makeDeployRunService((patchedRunUUID) => ({
      runUUID: patchedRunUUID,
      status: BuildStatus.DEPLOYING,
      deployEnabled: false,
    }));

    await service.resolveAndDeployBuild(build, true);

    expect(applyManifests).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('applies manifests when the run still owns the build', async () => {
    const { service, build, applyManifests, updateStatus } = makeDeployRunService((patchedRunUUID) => ({
      runUUID: patchedRunUUID,
      status: 'deploying',
    }));

    await service.resolveAndDeployBuild(build, true);

    expect(applyManifests).toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(build, BuildStatus.DEPLOYED, expect.any(String), true, true);
  });

  it('rechecks ownership inside the apply lock when teardown starts during manifest deployment', async () => {
    let ownershipReads = 0;
    const { service, build, applyManifests, updateStatus, recordFailure } = makeDeployRunService((patchedRunUUID) => {
      ownershipReads++;
      return ownershipReads >= 5
        ? { runUUID: 'teardown-owner', status: BuildStatus.TEARING_DOWN, deployEnabled: false }
        : { runUUID: patchedRunUUID, status: BuildStatus.DEPLOYING, deployEnabled: true, deletedAt: null };
    });
    const unlock = jest.fn().mockResolvedValue(undefined);
    (service as any).redlock = {
      lock: jest.fn().mockResolvedValue({ unlock, extend: jest.fn() }),
    };
    applyManifests.mockResolvedValue(true);

    await service.resolveAndDeployBuild(build, true);

    expect(applyManifests).toHaveBeenCalledTimes(1);
    expect((service as any).redlock.lock).toHaveBeenCalledWith('build-deployment.7', 15 * 60 * 1000);
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(updateStatus).not.toHaveBeenCalledWith(build, BuildStatus.DEPLOYED, expect.any(String), true, true);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('aborts the whole run when teardown completed before the ownership claim', async () => {
    const { service, build, claimChain, buildImages, applyManifests, updateStatus, recordFailure } =
      makeDeployRunService(() => ({ runUUID: 'irrelevant', status: BuildStatus.TORN_DOWN }), { claimResult: 0 });

    await service.resolveAndDeployBuild(build, true);

    expect(claimChain.whereNotIn).toHaveBeenCalledWith('status', [BuildStatus.TEARING_DOWN, BuildStatus.TORN_DOWN]);
    expect(claimChain.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(claimChain.where).toHaveBeenCalledWith('deployEnabled', true);
    expect(buildImages).not.toHaveBeenCalled();
    expect(applyManifests).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('claims PR builds conditionally and honors current open/label authority', async () => {
    const { service, build, claimChain, claimPatch, applyManifests } = makeDeployRunService((patchedRunUUID) => ({
      runUUID: patchedRunUUID,
      status: BuildStatus.DEPLOYING,
    }));
    build.pullRequestId = 55;
    build.pullRequest = {
      branchName: 'feature-1',
      fullName: 'org/repo',
      latestCommit: 'sha-1',
      status: 'open',
      deployOnUpdate: true,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    build.branchName = null;
    build.githubRepositoryId = null;

    await service.resolveAndDeployBuild(build, true);

    expect(claimPatch).toHaveBeenCalledWith({ runUUID: expect.any(String) });
    expect(claimChain.where).not.toHaveBeenCalledWith('deployEnabled', true);
    expect(applyManifests).toHaveBeenCalled();
  });
});

describe('recordBuildFailure teardown ownership', () => {
  function makeFailureService(claimResult: number) {
    const { service, models } = makeService();
    const claimChain: any = {
      where: jest.fn(() => claimChain),
      whereNotIn: jest.fn(() => claimChain),
      whereNull: jest.fn(() => claimChain),
      then: (resolve: any, reject: any) => Promise.resolve(claimResult).then(resolve, reject),
    };
    const claimPatch = jest.fn(() => claimChain);
    (models.Build.query as jest.Mock).mockReturnValue({ patch: claimPatch });
    const updateStatus = jest
      .spyOn(service as any, 'updateStatusAndComment')
      .mockResolvedValue(undefined) as jest.SpyInstance;
    return { service, claimPatch, updateStatus };
  }

  const failingBuild = (overrides: any = {}) => ({
    id: 7,
    uuid: 'api-env-123456',
    runUUID: 'stale-run',
    pullRequestId: null,
    $query: jest.fn(() => ({ patch: jest.fn() })),
    ...overrides,
  });

  it('skips the failure record when teardown owns a PR-less build', async () => {
    const { service, updateStatus } = makeFailureService(0);
    const build = failingBuild();

    await (service as any).recordBuildFailure(build, BuildStatus.ERROR, 'new-run', new Error('boom'), 'fallback');

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('records the failure when the PR-less claim succeeds', async () => {
    const { service, updateStatus } = makeFailureService(1);
    const build = failingBuild();

    await (service as any).recordBuildFailure(build, BuildStatus.ERROR, 'new-run', new Error('boom'), 'fallback');

    expect(updateStatus).toHaveBeenCalledWith(build, BuildStatus.ERROR, 'new-run', true, true, expect.any(Error));
  });

  it('re-stamps PR builds unconditionally', async () => {
    const { service, claimPatch, updateStatus } = makeFailureService(0);
    const patch = jest.fn();
    const build = failingBuild({ pullRequestId: 55, $query: jest.fn(() => ({ patch })) });

    await (service as any).recordBuildFailure(build, BuildStatus.ERROR, 'new-run', new Error('boom'), 'fallback');

    expect(patch).toHaveBeenCalledWith({ runUUID: 'new-run' });
    expect(claimPatch).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalled();
  });
});

describe('generateAndApplyManifests namespace TTL exclusion', () => {
  const k8sMock = jest.requireMock('server/lib/kubernetes');

  function makeManifestService() {
    const { service } = makeService();
    (service as any).ingressService = { ingressManifestQueue: { add: jest.fn() } };
    jest.spyOn(service as any, 'updateDeploysImageDetails').mockResolvedValue(undefined);
    const { Deploy: DeployMock } = jest.requireMock('server/models');
    (DeployMock as any).query = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue([]),
    }));
    return service;
  }

  const manifestBuild = (overrides: any = {}) => ({
    id: 7,
    uuid: 'api-env-123456',
    namespace: 'env-api-env-123456',
    isStatic: false,
    kind: 'environment',
    triggerType: 'api',
    pullRequest: null,
    $query: jest.fn(() => ({ patch: jest.fn() })),
    ...overrides,
  });

  it('opts API builds out of namespace-label TTL', async () => {
    const service = makeManifestService();
    const build = manifestBuild();

    await service.generateAndApplyManifests({ build, githubRepositoryId: null, namespace: build.namespace });

    expect(k8sMock.createOrUpdateNamespace).toHaveBeenCalledWith(expect.objectContaining({ ttl: false }));
  });

  it('leaves PR-build namespace TTL labeling unchanged', async () => {
    const service = makeManifestService();
    const build = manifestBuild({ triggerType: 'github_pr', pullRequest: { id: 1 } });

    await service.generateAndApplyManifests({ build, githubRepositoryId: null, namespace: build.namespace });

    const arg = k8sMock.createOrUpdateNamespace.mock.calls.at(-1)[0];
    expect(arg).not.toHaveProperty('ttl');
  });
});
