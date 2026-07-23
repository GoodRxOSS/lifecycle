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
});
