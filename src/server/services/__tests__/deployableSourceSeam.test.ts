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

const mockFetchLifecycleConfigByRepository = jest.fn();
const mockFetchLifecycleConfig = jest.fn();
const mockResolveRepository = jest.fn();
const mockResolveExactEnvironmentService = jest.fn();
const mockRepositoryFindOne = jest.fn();
const mockRepositoryWhereNull = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: jest.fn() },
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
jest.mock('server/models', () => ({
  Build: class {},
  Deploy: class {},
  Environment: class {},
  PullRequest: class {},
  Repository: {
    query: () => ({
      findOne: (...args: any[]) => {
        mockRepositoryFindOne(...args);
        return { whereNull: mockRepositoryWhereNull };
      },
    }),
  },
}));
jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfigByRepository: (...args: any[]) => mockFetchLifecycleConfigByRepository(...args),
  fetchLifecycleConfig: (...args: any[]) => mockFetchLifecycleConfig(...args),
  resolveRepository: (...args: any[]) => mockResolveRepository(...args),
  resolveExactEnvironmentService: (...args: any[]) => mockResolveExactEnvironmentService(...args),
  getDeployingServicesByName: jest.fn(),
}));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(() => ({ getAllConfigs: jest.fn().mockResolvedValue({}) })) },
}));

import DeployableService from '../deployable';

const makeService = () => {
  const db = { models: {}, services: { PullRequest: { updatePullRequestBranchName: jest.fn() } } };
  return new DeployableService(db as any, {} as any, {} as any, { registerQueue: jest.fn() } as any);
};

afterEach(() => jest.clearAllMocks());

describe('deployable source seam (PR vs API build)', () => {
  it('resolves lifecycle.yaml from the PR repository and branch for PR builds', async () => {
    const service = makeService();
    const repository = { githubRepositoryId: 42, fullName: 'org/repo' };
    const pullRequest: any = {
      branchName: 'feature-1',
      repository,
      build: { deploys: [], environment: { id: 5 } },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    mockFetchLifecycleConfigByRepository.mockResolvedValue(null);

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(new Map(), 1, 'uuid-1', pullRequest, {
      id: 1,
    });

    expect(pullRequest.$fetchGraph).toHaveBeenCalledWith('[build.[deploys.[deployable], environment], repository]');
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'feature-1');
    expect(mockRepositoryFindOne).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('resolves lifecycle.yaml from the build source columns for PR-less builds', async () => {
    const service = makeService();
    const repository = { githubRepositoryId: 42, fullName: 'org/repo' };
    mockRepositoryWhereNull.mockResolvedValue(repository);
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      pullRequest: null,
      deploys: [],
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    mockFetchLifecycleConfigByRepository.mockResolvedValue(null);

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(new Map(), 9, 'uuid-9', null, build);

    expect(build.$fetchGraph).toHaveBeenCalledWith('[deploys.[deployable], environment]');
    expect(mockRepositoryFindOne).toHaveBeenCalledWith({ githubRepositoryId: 42 });
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'main');
    expect(result).toBe(false);
  });

  it('uses the stored config SHA for an explicitly pinned API environment', async () => {
    const service = makeService();
    const repository = { githubRepositoryId: 42, fullName: 'org/repo' };
    mockRepositoryWhereNull.mockResolvedValue(repository);
    mockFetchLifecycleConfigByRepository.mockResolvedValue(null);
    const build: any = {
      id: 9,
      triggerType: 'api',
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'create-sha',
      deploys: [],
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await (service as any).updateOrCreateDeployableUsingYamlConfig(new Map(), 9, 'uuid-9', null, build);

    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'create-sha');
  });

  it('uses the pushed source ref for a later auto-track run', async () => {
    const service = makeService();
    const repository = { githubRepositoryId: 42, fullName: 'org/repo' };
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(repository) })),
      })),
    };
    mockRepositoryWhereNull.mockResolvedValue(repository);
    mockFetchLifecycleConfigByRepository.mockResolvedValue(null);
    const build: any = {
      id: 9,
      triggerType: 'api',
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'create-sha',
      deploys: [],
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      42,
      'push-sha',
      'main'
    );

    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'push-sha');
  });

  it('does not use a dependency push SHA to fetch the root API lifecycle config', async () => {
    const service = makeService();
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({
          whereNull: jest.fn().mockResolvedValue({ githubRepositoryId: 99, fullName: 'org/dependency' }),
        })),
      })),
    };
    const repository = { githubRepositoryId: 42, fullName: 'org/repo' };
    mockRepositoryWhereNull.mockResolvedValue(repository);
    mockFetchLifecycleConfigByRepository.mockResolvedValue(null);
    const build: any = {
      id: 9,
      triggerType: 'api',
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-config-sha',
      deploys: [],
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      99,
      'dependency-push-sha',
      'main'
    );

    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'root-config-sha');
  });

  it('fetches a targeted dependency config at the same pushed SHA used for its code', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    const dependencyRepository = { githubRepositoryId: 99, fullName: 'org/dependency' };
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(dependencyRepository) })),
      })),
    };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository
      .mockResolvedValueOnce({
        environment: {
          defaultServices: [{ name: 'dependency-api', repository: 'org/dependency', branch: 'main' }],
          optionalServices: [],
        },
        services: [],
      })
      .mockResolvedValueOnce({ services: [{ name: 'dependency-api' }] });
    mockResolveRepository.mockResolvedValue(dependencyRepository);
    mockResolveExactEnvironmentService.mockReturnValue({
      service: { name: 'dependency-api' },
      requiredServices: [],
    });
    jest.spyOn(service, 'updateOrCreateDeployableAttributesUsingYAMLConfig').mockResolvedValue(undefined);
    const build: any = {
      id: 9,
      triggerType: 'github_pr',
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-config-sha',
      deploys: [],
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      99,
      'dependency-push-sha',
      'main'
    );

    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(rootRepository, 'root-config-sha');
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(dependencyRepository, 'dependency-push-sha');
    expect(service.updateOrCreateDeployableAttributesUsingYAMLConfig).toHaveBeenCalledWith(
      expect.any(Map),
      9,
      'uuid-9',
      expect.objectContaining({ name: 'dependency-api' }),
      99,
      'main',
      true,
      null,
      build
    );
  });

  it('pins a root full-scope import to the delivered source SHA independently of its target selector', async () => {
    const service = makeService();
    const repository = { githubRepositoryId: 42, fullName: 'org/root' };
    mockFetchLifecycleConfigByRepository.mockResolvedValue(null);
    const build: any = {
      id: 9,
      triggerType: 'github_pr',
      githubRepositoryId: 42,
      branchName: 'main',
      deploys: [],
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const pullRequest: any = {
      branchName: 'main',
      repository,
      build,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      pullRequest,
      build,
      undefined,
      'root-push-sha',
      'main',
      42
    );

    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(repository, 'root-push-sha');
  });

  it('targets a same-repository dependency by its exact effective branch and preserves the configured branch', async () => {
    const service = makeService();
    const repository = { githubRepositoryId: 42, fullName: 'org/repo' };
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(repository) })),
      })),
    };
    mockRepositoryWhereNull.mockResolvedValue(repository);
    mockFetchLifecycleConfigByRepository
      .mockResolvedValueOnce({
        environment: {
          defaultServices: [
            { name: 'stable-api', repository: 'org/repo', branch: 'main' },
            { name: 'release-api', repository: 'org/repo', branch: 'release' },
          ],
          optionalServices: [],
        },
        services: [],
      })
      .mockResolvedValueOnce({ services: [{ name: 'stable-api' }] });
    mockResolveRepository.mockResolvedValue(repository);
    mockResolveExactEnvironmentService.mockReturnValue({
      service: { name: 'stable-api' },
      requiredServices: [],
    });
    jest.spyOn(service, 'updateOrCreateDeployableAttributesUsingYAMLConfig').mockResolvedValue(undefined);
    const build: any = {
      id: 9,
      triggerType: 'api',
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-config-sha',
      deploys: [{ deployable: { name: 'stable-api', commentBranchName: 'stable' } }],
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      42,
      'stable-push-sha',
      'stable'
    );

    expect(result).toBe(true);
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenNthCalledWith(1, repository, 'root-config-sha');
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenNthCalledWith(2, repository, 'stable-push-sha');
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledTimes(2);
    expect(service.updateOrCreateDeployableAttributesUsingYAMLConfig).toHaveBeenCalledWith(
      expect.any(Map),
      9,
      'uuid-9',
      expect.objectContaining({ name: 'stable-api' }),
      42,
      'stable',
      true,
      null,
      build
    );
  });

  it('records an unresolvable dependency repository instead of vetoing reconciliation', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository.mockResolvedValue({
      environment: {
        defaultServices: [{ name: 'archived-dep', repository: 'org/archived', branch: 'main' }],
        optionalServices: [],
      },
      services: [],
    });
    mockResolveRepository.mockResolvedValue({
      githubRepositoryId: 77,
      fullName: 'org/archived',
      deletedAt: '2026-01-01T00:00:00Z',
    });
    const build: any = {
      id: 9,
      triggerType: 'github_pr',
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-config-sha',
      deploys: [],
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const unresolvedServiceNames = new Set<string>();
    const unresolvedRepositoryIds = new Set<number>();

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      undefined,
      null,
      null,
      undefined,
      unresolvedServiceNames,
      unresolvedRepositoryIds
    );

    expect(result).toBe(true);
    expect(Array.from(unresolvedServiceNames)).toEqual(['archived-dep']);
    expect(Array.from(unresolvedRepositoryIds)).toEqual([77]);
  });

  it('records the repository when a remote service fails exact-name resolution', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    const dependencyRepository = { githubRepositoryId: 99, fullName: 'org/dependency' };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository
      .mockResolvedValueOnce({
        environment: {
          defaultServices: [{ name: 'dependency-api', repository: 'org/dependency', branch: 'main' }],
          optionalServices: [],
        },
        services: [],
      })
      .mockResolvedValueOnce({ services: [{ name: 'renamed-api' }] });
    mockResolveRepository.mockResolvedValue(dependencyRepository);
    mockResolveExactEnvironmentService.mockReturnValue(null);
    const build: any = {
      id: 9,
      triggerType: 'github_pr',
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-config-sha',
      deploys: [],
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const unresolvedServiceNames = new Set<string>();
    const unresolvedRepositoryIds = new Set<number>();

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      undefined,
      null,
      null,
      undefined,
      unresolvedServiceNames,
      unresolvedRepositoryIds
    );

    expect(result).toBe(true);
    expect(Array.from(unresolvedServiceNames)).toEqual(['dependency-api']);
    // The `requires:` recursion never ran, so the repository must be protected too.
    expect(Array.from(unresolvedRepositoryIds)).toEqual([99]);
  });

  it('records a legacy serviceId reference instead of vetoing reconciliation', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(rootRepository) })),
      })),
    };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository.mockResolvedValue({
      environment: {
        defaultServices: [{ name: 'legacy-db-service', serviceId: 47 }, { name: 'api' }],
        optionalServices: [],
      },
      services: [{ name: 'api' }],
    });
    mockResolveExactEnvironmentService.mockReturnValue({ service: { name: 'api' }, requiredServices: [] });
    jest.spyOn(service, 'updateOrCreateDeployableAttributesUsingYAMLConfig').mockResolvedValue(undefined);
    const build: any = {
      id: 9,
      triggerType: 'github_pr',
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-config-sha',
      deploys: [],
      environment: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const unresolvedServiceNames = new Set<string>();

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      42,
      null,
      'main',
      42,
      unresolvedServiceNames,
      new Set<number>()
    );

    expect(result).toBe(true);
    expect(Array.from(unresolvedServiceNames)).toEqual(['legacy-db-service']);
  });

  it('fails closed before YAML import when the targeted repository has no live row', async () => {
    const service = makeService();
    const filterWhereNull = jest.fn().mockResolvedValue(undefined);
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: filterWhereNull })),
      })),
    };
    const build: any = {
      id: 9,
      triggerType: 'api',
      githubRepositoryId: 42,
      branchName: 'main',
      deploys: [],
      $fetchGraph: jest.fn(),
    };

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      99,
      'dependency-sha',
      'main'
    );

    expect(result).toBe(false);
    expect(filterWhereNull).toHaveBeenCalledWith('deletedAt');
    expect(build.$fetchGraph).not.toHaveBeenCalled();
    expect(mockFetchLifecycleConfigByRepository).not.toHaveBeenCalled();
  });

  it('returns false without fetching when neither a PR nor a build is available', async () => {
    const service = makeService();

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      1,
      'uuid-1',
      null,
      undefined
    );

    expect(result).toBe(false);
    expect(mockFetchLifecycleConfigByRepository).not.toHaveBeenCalled();
  });

  it('skips the fatal branch and upserts when a PR-less build carries source columns', async () => {
    const service = makeService();
    const yamlConfig = jest.spyOn(service as any, 'updateOrCreateDeployableUsingYamlConfig').mockResolvedValue(true);
    const upsert = jest.spyOn(service as any, 'upsertDeployablesWithDatabase').mockResolvedValue([{ id: 1 }]);
    const build: any = { id: 9, githubRepositoryId: 42, branchName: 'main' };

    const result = await service.upsertDeployables(9, 'uuid-9', null, { name: 'env' } as any, build);

    expect(yamlConfig).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
    expect(result.deployables).toHaveLength(1);
    expect(result.canReconcile).toBe(true);
  });

  it('keeps the fatal no-op for builds with neither PR nor source columns', async () => {
    const service = makeService();
    const upsert = jest.spyOn(service as any, 'upsertDeployablesWithDatabase');
    const build: any = { id: 9, githubRepositoryId: null, branchName: null };

    const result = await service.upsertDeployables(9, 'uuid-9', null, { name: 'env' } as any, build);

    expect(upsert).not.toHaveBeenCalled();
    expect(result.deployables).toHaveLength(0);
    expect(result.canReconcile).toBe(false);
  });

  it('fails closed when the targeted repository lookup itself fails', async () => {
    const service = makeService();
    const lookupError = new Error('repository database unavailable');
    const filterWhereNull = jest.fn().mockRejectedValueOnce(lookupError);
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: filterWhereNull })),
      })),
    };
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-sha',
      $fetchGraph: jest.fn(),
    };

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      99,
      'dependency-sha',
      'main'
    );

    expect(result).toBe(false);
    expect(filterWhereNull).toHaveBeenCalledWith('deletedAt');
    expect(build.$fetchGraph).not.toHaveBeenCalled();
    expect(mockFetchLifecycleConfigByRepository).not.toHaveBeenCalled();
  });

  it('skips remote YAML outside the targeted repository without resolving or fetching it', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    const filterRepository = { githubRepositoryId: 99, fullName: 'org/target' };
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(filterRepository) })),
      })),
    };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository.mockResolvedValueOnce({
      environment: {
        defaultServices: [{ name: 'other-api', repository: 'org/other', branch: 'main' }],
        optionalServices: [],
      },
      services: [],
    });
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-sha',
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      99,
      'target-sha',
      'main'
    );

    expect(result).toBe(false);
    expect(mockResolveRepository).not.toHaveBeenCalled();
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledTimes(1);
  });

  it('fails targeted attribution when the named target repository is no longer resolvable', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    const filterRepository = { githubRepositoryId: 99, fullName: 'org/target' };
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(filterRepository) })),
      })),
    };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository.mockResolvedValueOnce({
      environment: {
        defaultServices: [{ name: 'target-api', repository: 'org/target', branch: 'main' }],
        optionalServices: [],
      },
      services: [],
    });
    mockResolveRepository.mockResolvedValueOnce(null);
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-sha',
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const unresolvedServiceNames = new Set<string>();

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      99,
      'target-sha',
      'main',
      99,
      unresolvedServiceNames,
      new Set<number>()
    );

    expect(result).toBe(false);
    expect(Array.from(unresolvedServiceNames)).toEqual(['target-api']);
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledTimes(1);
  });

  it('protects a remote service and repository when its lifecycle YAML cannot be read', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    const dependencyRepository = { githubRepositoryId: 99, fullName: 'org/dependency' };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository
      .mockResolvedValueOnce({
        environment: {
          defaultServices: [{ name: 'dependency-api', repository: 'org/dependency', branch: 'main' }],
          optionalServices: [],
        },
        services: [],
      })
      .mockResolvedValueOnce(null);
    mockResolveRepository.mockResolvedValueOnce(dependencyRepository);
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-sha',
      deploys: [{ uuid: 'deploy-1', deployable: { name: 'dependency-api' } }],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const unresolvedServiceNames = new Set<string>();
    const unresolvedRepositoryIds = new Set<number>();

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      undefined,
      null,
      null,
      undefined,
      unresolvedServiceNames,
      unresolvedRepositoryIds
    );

    expect(result).toBe(true);
    expect(Array.from(unresolvedServiceNames)).toEqual(['dependency-api']);
    expect(Array.from(unresolvedRepositoryIds)).toEqual([99]);
    expect(mockResolveExactEnvironmentService).not.toHaveBeenCalled();
  });

  it('uses main when a remote service omits its branch', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    const dependencyRepository = { githubRepositoryId: 99, fullName: 'org/dependency' };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository
      .mockResolvedValueOnce({
        environment: {
          defaultServices: [{ name: 'dependency-api', repository: 'org/dependency' }],
          optionalServices: [],
        },
        services: [],
      })
      .mockResolvedValueOnce({ services: [{ name: 'dependency-api' }] });
    mockResolveRepository.mockResolvedValueOnce(dependencyRepository);
    mockResolveExactEnvironmentService.mockReturnValueOnce({
      service: { name: 'dependency-api' },
      requiredServices: [],
    });
    const attributeSpy = jest
      .spyOn(service, 'updateOrCreateDeployableAttributesUsingYAMLConfig')
      .mockResolvedValueOnce(undefined);
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-sha',
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(new Map(), 9, 'uuid-9', null, build);

    expect(result).toBe(true);
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenNthCalledWith(2, dependencyRepository, 'main');
    expect(attributeSpy).toHaveBeenCalledWith(
      expect.any(Map),
      9,
      'uuid-9',
      expect.objectContaining({ name: 'dependency-api' }),
      99,
      'main',
      true,
      null,
      build
    );
  });

  it('preserves an attribution error raised while materializing a resolved service', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository.mockResolvedValueOnce({
      environment: {
        defaultServices: [{ name: 'api' }],
        optionalServices: [],
      },
      services: [{ name: 'api' }],
    });
    mockResolveExactEnvironmentService.mockReturnValueOnce({
      service: { name: 'api' },
      requiredServices: [],
    });
    const attributionError = new Error('attribute resolution failed');
    jest.spyOn(service, 'updateOrCreateDeployableAttributesUsingYAMLConfig').mockRejectedValueOnce(attributionError);
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-sha',
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      (service as any).updateOrCreateDeployableUsingYamlConfig(new Map(), 9, 'uuid-9', null, build)
    ).rejects.toBe(attributionError);

    expect(service.updateOrCreateDeployableAttributesUsingYAMLConfig).toHaveBeenCalledTimes(1);
  });

  it('uses a persisted comment branch override for a service defined in the root YAML', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository.mockResolvedValueOnce({
      environment: {
        defaultServices: [{ name: 'api' }],
        optionalServices: [],
      },
      services: [{ name: 'api' }],
    });
    mockResolveExactEnvironmentService.mockReturnValueOnce({
      service: { name: 'api' },
      requiredServices: [],
    });
    const attributeSpy = jest
      .spyOn(service, 'updateOrCreateDeployableAttributesUsingYAMLConfig')
      .mockResolvedValueOnce(undefined);
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-sha',
      deploys: [{ deployable: { name: 'api', commentBranchName: 'release-candidate' } }],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(new Map(), 9, 'uuid-9', null, build);

    expect(result).toBe(true);
    expect(attributeSpy).toHaveBeenCalledWith(
      expect.any(Map),
      9,
      'uuid-9',
      expect.objectContaining({ name: 'api' }),
      42,
      'release-candidate',
      true,
      null,
      build
    );
  });

  it('skips a root service when a targeted update is for another effective branch', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(rootRepository) })),
      })),
    };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository.mockResolvedValueOnce({
      environment: {
        defaultServices: [{ name: 'api' }],
        optionalServices: [],
      },
      services: [{ name: 'api' }],
    });
    const attributeSpy = jest.spyOn(service, 'updateOrCreateDeployableAttributesUsingYAMLConfig');
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-sha',
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      42,
      'release-sha',
      'release'
    );

    expect(result).toBe(false);
    expect(attributeSpy).not.toHaveBeenCalled();
  });

  it('marks a targeted root import reconciliable when it consumes the delivered source ref', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(rootRepository) })),
      })),
    };
    mockFetchLifecycleConfigByRepository.mockResolvedValueOnce({
      environment: { defaultServices: [], optionalServices: [] },
      services: [],
    });
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const pullRequest: any = {
      branchName: 'main',
      repository: rootRepository,
      build,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      pullRequest,
      build,
      42,
      'root-push-sha',
      'main',
      42
    );

    expect(result).toBe(true);
    expect(mockFetchLifecycleConfigByRepository).toHaveBeenCalledWith(rootRepository, 'root-push-sha');
  });

  it('imports legacy top-level services when the environment lists no default or optional services', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    const legacyService = { name: 'legacy-api' };
    const generatedAttributes = {
      name: 'legacy-api',
      type: 'github',
      source: 'yaml',
      reconcileEligible: true,
      branchName: 'main',
    };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository.mockResolvedValueOnce({
      services: [legacyService],
    });
    const generateSpy = jest
      .spyOn(service as any, 'generateAttributesFromYamlConfig')
      .mockResolvedValueOnce(generatedAttributes);
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-sha',
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const deployableServices = new Map();

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      deployableServices,
      9,
      'uuid-9',
      null,
      build
    );

    expect(result).toBe(true);
    expect(generateSpy).toHaveBeenCalledWith(9, 'uuid-9', 42, 'main', legacyService, true, null, build);
    expect(deployableServices.get('legacy-api')).toEqual(generatedAttributes);
  });

  it('does not import legacy root services for a different targeted repository', async () => {
    const service = makeService();
    const rootRepository = { githubRepositoryId: 42, fullName: 'org/root' };
    const filterRepository = { githubRepositoryId: 99, fullName: 'org/dependency' };
    (service as any).db.models.Repository = {
      query: jest.fn(() => ({
        findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(filterRepository) })),
      })),
    };
    mockRepositoryWhereNull.mockResolvedValue(rootRepository);
    mockFetchLifecycleConfigByRepository.mockResolvedValueOnce({
      environment: { defaultServices: [], optionalServices: [] },
      services: [{ name: 'legacy-api' }],
    });
    const generateSpy = jest.spyOn(service as any, 'generateAttributesFromYamlConfig');
    const build: any = {
      id: 9,
      githubRepositoryId: 42,
      branchName: 'main',
      configSha: 'root-sha',
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(
      new Map(),
      9,
      'uuid-9',
      null,
      build,
      99,
      'dependency-sha',
      'main'
    );

    expect(result).toBe(false);
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it('returns false without a YAML read when the build source repository or ref is incomplete', async () => {
    const service = makeService();
    const build: any = {
      id: 9,
      githubRepositoryId: null,
      branchName: null,
      configSha: null,
      deploys: [],
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };

    const result = await (service as any).updateOrCreateDeployableUsingYamlConfig(new Map(), 9, 'uuid-9', null, build);

    expect(result).toBe(false);
    expect(build.$fetchGraph).toHaveBeenCalledWith('[deploys.[deployable], environment]');
    expect(mockFetchLifecycleConfigByRepository).not.toHaveBeenCalled();
  });

  it('updates a missing PR branch and returns reconciliation metadata from the resolved YAML set', async () => {
    const service = makeService();
    const updateBranchName = (service as any).db.services.PullRequest.updatePullRequestBranchName as jest.Mock;
    const pullRequest: any = { branchName: null };
    const persistedDeployable = { id: 1, name: 'api' };
    const yamlSpy = jest
      .spyOn(service as any, 'updateOrCreateDeployableUsingYamlConfig')
      .mockImplementationOnce(async (deployableServices, ...args) => {
        const unresolvedServiceNames = args[8] as Set<string>;
        const unresolvedRepositoryIds = args[9] as Set<number>;
        deployableServices.set('api', {
          name: 'api',
          source: undefined,
          reconcileEligible: true,
          resolvedFromRepositoryId: 42,
          branchName: 'main',
          commentBranchName: 'release',
        });
        deployableServices.set('configuration', {
          name: 'configuration',
          source: 'yaml',
          reconcileEligible: false,
        });
        unresolvedServiceNames.add('unresolved-api');
        unresolvedRepositoryIds.add(99);
        return true;
      });
    const databaseUpsert = jest
      .spyOn(service as any, 'upsertDeployablesWithDatabase')
      .mockResolvedValueOnce([persistedDeployable]);

    const result = await service.upsertDeployables(9, 'uuid-9', pullRequest, { name: 'env' } as any, undefined, 42);

    expect(updateBranchName).toHaveBeenCalledWith(pullRequest);
    expect(yamlSpy).toHaveBeenCalled();
    expect(databaseUpsert).toHaveBeenCalledWith('uuid-9', 9, [
      expect.objectContaining({ name: 'api' }),
      expect.objectContaining({ name: 'configuration' }),
    ]);
    expect(result).toEqual({
      deployables: [persistedDeployable],
      canReconcile: true,
      filterGithubRepositoryId: 42,
      unresolvedServiceNames: ['unresolved-api'],
      unresolvedRepositoryIds: [99],
      reconcileEligibleDeployables: [
        {
          name: 'api',
          source: 'yaml',
          reconcileEligible: true,
          resolvedFromRepositoryId: 42,
          branchName: 'release',
        },
      ],
    });
  });

  it('preserves YAML import errors and does not attempt database writes', async () => {
    const service = makeService();
    const importError = new Error('root lifecycle YAML unavailable');
    jest.spyOn(service as any, 'updateOrCreateDeployableUsingYamlConfig').mockRejectedValueOnce(importError);
    const databaseUpsert = jest.spyOn(service as any, 'upsertDeployablesWithDatabase');
    const pullRequest: any = { branchName: 'feature' };

    await expect(service.upsertDeployables(9, 'uuid-9', pullRequest, { name: 'env' } as any)).rejects.toBe(importError);

    expect(databaseUpsert).not.toHaveBeenCalled();
  });

  it('updates existing deployables, creates missing rows, and isolates per-row database failures', async () => {
    const service = makeService();
    const patchExisting = jest.fn().mockResolvedValue(1);
    const patchFailure = jest.fn().mockRejectedValueOnce(new Error('patch failed'));
    const existing = { id: 1, name: 'existing', $query: () => ({ patch: patchExisting }) };
    const existingWithPatchFailure = {
      id: 3,
      name: 'patch-failure',
      $query: () => ({ patch: patchFailure }),
    };
    const searchResults = [
      Promise.resolve(existing),
      Promise.reject(new Error('search failed')),
      Promise.resolve(existingWithPatchFailure),
      Promise.resolve(undefined),
    ];
    const query = jest.fn(() => {
      const first = jest.fn().mockReturnValue(searchResults.shift());
      const builder: any = {
        where: jest.fn(() => builder),
        first,
      };
      return builder;
    });
    const created = { id: 2, name: 'created' };
    const create = jest.fn().mockResolvedValueOnce(created).mockRejectedValueOnce(new Error('create failed'));
    (service as any).db.models.Deployable = { query, create };
    const attributes = [
      { name: 'existing', buildUUID: 'uuid-9', buildId: 9 },
      { name: 'search-failure', buildUUID: 'uuid-9', buildId: 9 },
      { name: 'patch-failure', buildUUID: 'uuid-9', buildId: 9 },
      { name: 'create-failure', buildUUID: 'uuid-9', buildId: 9 },
    ];

    const result = await (service as any).upsertDeployablesWithDatabase('uuid-9', 9, attributes);

    expect(patchExisting).toHaveBeenCalledWith(attributes[0]);
    expect(patchFailure).toHaveBeenCalledWith(attributes[2]);
    expect(create).toHaveBeenNthCalledWith(1, attributes[1]);
    expect(create).toHaveBeenNthCalledWith(2, attributes[3]);
    expect(result).toEqual([existing, created, existingWithPatchFailure]);

    await expect((service as any).upsertDeployablesWithDatabase('uuid-9', 9, [])).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
