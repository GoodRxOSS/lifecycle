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
mockRedisClient();

jest.mock('server/lib/github', () => ({
  getRepositoryByFullName: jest.fn(),
  listInstallationRepositories: jest.fn(),
}));

import * as github from 'server/lib/github';
import RepositoryService, {
  githubInstalledRepositoriesCacheKey,
  githubOnboardedRepositoryCacheKey,
} from 'server/services/repository';
import { GITHUB_API_CACHE_EXPIRATION_SECONDS } from 'shared/constants';

class RepositoryQuery {
  private filters: Array<(row: any) => boolean> = [];
  private sortBy: { field: string; direction: string } | null = null;

  constructor(private readonly rows: any[]) {}

  where(criteria: Record<string, unknown> | string, value?: unknown) {
    if (typeof criteria === 'string') {
      this.filters.push((row) => row[criteria] === value);
      return this;
    }

    this.filters.push((row) => Object.entries(criteria).every(([key, expected]) => row[key] === expected));
    return this;
  }

  whereNull(field: string) {
    this.filters.push((row) => row[field] == null);
    return this;
  }

  whereRaw(sql: string, values: string[]) {
    const value = values[0];
    if (sql.includes('like')) {
      const query = value.replace(/%/g, '').toLowerCase();
      this.filters.push((row) => String(row.fullName).toLowerCase().includes(query));
    } else if (sql.includes('=')) {
      this.filters.push((row) => String(row.fullName).toLowerCase() === value.toLowerCase());
    }
    return this;
  }

  orderBy(field: string, direction: string) {
    this.sortBy = { field, direction };
    return this;
  }

  async page(pageIndex: number, pageSize: number) {
    const rows = this.filteredRows();
    const start = pageIndex * pageSize;
    return {
      results: rows.slice(start, start + pageSize),
      total: rows.length,
    };
  }

  async first() {
    return this.filteredRows()[0];
  }

  then(resolve: (value: any[]) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve(this.filteredRows()).then(resolve, reject);
  }

  private filteredRows() {
    const rows = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (!this.sortBy) return rows;
    const sortBy = this.sortBy;

    return [...rows].sort((a, b) => {
      const compared = String(a[sortBy.field]).localeCompare(String(b[sortBy.field]));
      return sortBy.direction === 'desc' ? -compared : compared;
    });
  }
}

function createRepository(overrides: Record<string, unknown> = {}) {
  const repository: any = {
    id: 1,
    githubRepositoryId: 12,
    githubInstallationId: 34,
    ownerId: 56,
    fullName: 'example-org/example-repo',
    htmlUrl: 'https://github.com/example-org/example-repo',
    defaultEnvId: 78,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };

  repository.patchAndFetch = jest.fn(async (patch) => {
    Object.assign(repository, patch);
    return repository;
  });
  repository.$query = jest.fn(() => ({
    patchAndFetch: repository.patchAndFetch,
  }));

  return repository;
}

function createInstalledRepository(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    name: 'example-repo',
    full_name: 'example-org/example-repo',
    html_url: 'https://github.com/example-org/example-repo',
    private: true,
    archived: false,
    disabled: false,
    visibility: 'private',
    default_branch: 'main',
    updated_at: '2026-01-01T00:00:00.000Z',
    pushed_at: '2026-01-01T00:00:00.000Z',
    owner: {
      id: 56,
      login: 'example-org',
    },
    ...overrides,
  };
}

describe('RepositoryService', () => {
  let service: RepositoryService;
  let repositories: any[];
  let db: any;
  let redis: any;

  beforeEach(() => {
    repositories = [];
    db = {
      models: {
        Environment: {
          findOne: jest.fn(async () => null),
          create: jest.fn(async (input) => ({ id: 78, ...input })),
        },
        Repository: {
          create: jest.fn(async (input) => {
            const repository = createRepository({
              id: repositories.length + 1,
              ...input,
            });
            repositories.push(repository);
            return repository;
          }),
          query: jest.fn(() => new RepositoryQuery(repositories)),
        },
      },
    };

    const store = new Map<string, string>();
    redis = {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      del: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      store,
    };

    service = new RepositoryService(db, redis, {} as any);
    jest.clearAllMocks();
  });

  describe('listOnboardedRepositories', () => {
    test('returns only non-deleted repository rows', async () => {
      repositories.push(
        createRepository({ id: 1, fullName: 'example-org/api' }),
        createRepository({ id: 2, fullName: 'example-org/legacy-api', deletedAt: '2026-01-01T00:00:00.000Z' })
      );

      const result = await service.listOnboardedRepositories({ query: 'api', page: 1, limit: 25 });

      expect(result.repositories).toEqual([
        expect.objectContaining({
          id: 1,
          fullName: 'example-org/api',
          onboarded: true,
          deletedAt: null,
        }),
      ]);
      expect(result.pagination).toEqual({
        current: 1,
        total: 1,
        items: 1,
        limit: 25,
      });
    });
  });

  describe('listInstalledRepositories', () => {
    test('returns installed GitHub repositories annotated with onboarded state', async () => {
      redis.store.set(
        githubInstalledRepositoriesCacheKey(34),
        JSON.stringify({
          installationId: 34,
          fetchedAt: '2026-01-01T00:00:00.000Z',
          repositories: [
            {
              githubRepositoryId: 12,
              ownerId: 56,
              ownerLogin: 'example-org',
              name: 'api',
              fullName: 'example-org/api',
              htmlUrl: 'https://github.com/example-org/api',
              private: true,
              archived: false,
              disabled: false,
              visibility: 'private',
              defaultBranch: 'main',
              updatedAt: '2026-01-01T00:00:00.000Z',
              pushedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              githubRepositoryId: 13,
              ownerId: 56,
              ownerLogin: 'example-org',
              name: 'web',
              fullName: 'example-org/web',
              htmlUrl: 'https://github.com/example-org/web',
              private: true,
              archived: false,
              disabled: false,
              visibility: 'private',
              defaultBranch: 'main',
              updatedAt: '2026-01-01T00:00:00.000Z',
              pushedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      );
      repositories.push(createRepository({ githubRepositoryId: 13, fullName: 'example-org/web' }));

      const result = await service.listInstalledRepositories({
        installationId: 34,
        onboarded: false,
        query: 'api',
      });

      expect(result.repositories).toEqual([
        expect.objectContaining({
          githubRepositoryId: 12,
          fullName: 'example-org/api',
          onboarded: false,
        }),
      ]);
      expect(github.listInstallationRepositories).not.toHaveBeenCalled();
    });

    test('writes the installed cache after all GitHub pages are fetched', async () => {
      const firstPage = Array.from({ length: 100 }, (_, index) =>
        createInstalledRepository({
          id: index + 1,
          name: `repo-${index + 1}`,
          full_name: `example-org/repo-${index + 1}`,
        })
      );
      const secondPage = [
        createInstalledRepository({
          id: 101,
          name: 'repo-101',
          full_name: 'example-org/repo-101',
        }),
      ];

      (github.listInstallationRepositories as jest.Mock)
        .mockResolvedValueOnce({ data: { total_count: 101, repositories: firstPage } })
        .mockResolvedValueOnce({ data: { total_count: 101, repositories: secondPage } });

      const result = await service.listInstalledRepositories({ installationId: 34 });
      const cached = JSON.parse(redis.store.get(githubInstalledRepositoriesCacheKey(34)));

      expect(github.listInstallationRepositories).toHaveBeenCalledTimes(2);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(result.repositories).toHaveLength(25);
      expect(cached.repositories).toHaveLength(101);
      expect(cached.repositories[100]).toEqual(
        expect.objectContaining({
          githubRepositoryId: 101,
          fullName: 'example-org/repo-101',
        })
      );
    });
  });

  describe('onboardRepository', () => {
    test('fetches GitHub metadata and creates an active repository row', async () => {
      (github.getRepositoryByFullName as jest.Mock).mockResolvedValue({
        data: createInstalledRepository(),
      });

      const result = await service.onboardRepository('https://github.com/Example-Org/Example-Repo.git', 34);

      expect(github.getRepositoryByFullName).toHaveBeenCalledWith('example-org/example-repo', 34);
      expect(db.models.Environment.findOne).toHaveBeenCalledWith({ name: 'example-repo' });
      expect(db.models.Environment.create).toHaveBeenCalledWith({
        name: 'example-repo',
        uuid: 'example-repo',
        enableFullYaml: true,
        autoDeploy: false,
      });
      expect(db.models.Repository.create).toHaveBeenCalledWith({
        githubRepositoryId: 12,
        githubInstallationId: 34,
        ownerId: 56,
        fullName: 'example-org/example-repo',
        htmlUrl: 'https://github.com/example-org/example-repo',
        defaultEnvId: 78,
        deletedAt: null,
      });
      expect(redis.set).toHaveBeenCalledWith(
        githubOnboardedRepositoryCacheKey(34, 12),
        JSON.stringify({
          onboarded: true,
          repositoryId: 1,
          githubRepositoryId: 12,
          githubInstallationId: 34,
          fullName: 'example-org/example-repo',
        }),
        'EX',
        GITHUB_API_CACHE_EXPIRATION_SECONDS
      );
      expect(result).toEqual({
        repository: expect.objectContaining({
          id: 1,
          fullName: 'example-org/example-repo',
          onboarded: true,
          deletedAt: null,
        }),
        created: true,
      });
    });

    test('uses an environment service bound to the same database dependency', async () => {
      (github.getRepositoryByFullName as jest.Mock).mockResolvedValue({
        data: createInstalledRepository(),
      });
      db.models.Environment = {
        findOne: jest.fn(async () => null),
        create: jest.fn(async (input) => ({ id: 79, ...input })),
      };
      service = new RepositoryService(db, redis, {} as any);

      const result = await service.onboardRepository('example-org/example-repo', 34);

      expect(db.models.Environment.findOne).toHaveBeenCalledWith({ name: 'example-repo' });
      expect(db.models.Environment.create).toHaveBeenCalledWith({
        name: 'example-repo',
        uuid: 'example-repo',
        enableFullYaml: true,
        autoDeploy: false,
      });
      expect(db.models.Repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fullName: 'example-org/example-repo',
          defaultEnvId: 79,
        })
      );
      expect(result.created).toBe(true);
    });

    test('undeletes and refreshes an existing soft-deleted repository row', async () => {
      const repository = createRepository({
        id: 7,
        fullName: 'example-org/old-name',
        deletedAt: '2026-01-01T00:00:00.000Z',
      });
      repositories.push(repository);
      (github.getRepositoryByFullName as jest.Mock).mockResolvedValue({
        data: createInstalledRepository(),
      });

      const result = await service.onboardRepository('example-org/example-repo', 34);

      expect(db.models.Repository.create).not.toHaveBeenCalled();
      expect(repository.patchAndFetch).toHaveBeenCalledWith({
        fullName: 'example-org/example-repo',
        deletedAt: null,
      });
      expect(result.created).toBe(false);
      expect(result.repository).toEqual(
        expect.objectContaining({
          id: 7,
          fullName: 'example-org/example-repo',
          onboarded: true,
          deletedAt: null,
        })
      );
    });
  });

  describe('removeRepository', () => {
    test('soft deletes the active row and writes a short-lived negative cache entry', async () => {
      const repository = createRepository({ id: 7, fullName: 'example-org/api' });
      repositories.push(repository);

      const result = await service.removeRepository('Example-Org/API', 34);

      expect(repository.patchAndFetch).toHaveBeenCalledWith({
        deletedAt: expect.any(String),
      });
      expect(redis.set).toHaveBeenCalledWith(
        githubOnboardedRepositoryCacheKey(34, 12),
        JSON.stringify({ onboarded: false }),
        'EX',
        60
      );
      expect(result).toEqual(
        expect.objectContaining({
          id: 7,
          fullName: 'example-org/api',
          onboarded: false,
          deletedAt: expect.any(String),
        })
      );
    });
  });

  describe('isRepositoryOnboarded', () => {
    test('uses a cached negative membership result without querying the database', async () => {
      redis.store.set(githubOnboardedRepositoryCacheKey(34, 12), JSON.stringify({ onboarded: false }));

      const result = await service.isRepositoryOnboarded(34, 12);

      expect(result).toBe(false);
      expect(db.models.Repository.query).not.toHaveBeenCalled();
    });

    test('falls back to the database and writes a positive membership cache', async () => {
      repositories.push(createRepository({ id: 7 }));

      const result = await service.isRepositoryOnboarded(34, 12);

      expect(result).toBe(true);
      expect(redis.set).toHaveBeenCalledWith(
        githubOnboardedRepositoryCacheKey(34, 12),
        JSON.stringify({
          onboarded: true,
          repositoryId: 7,
          githubRepositoryId: 12,
          githubInstallationId: 34,
          fullName: 'example-org/example-repo',
        }),
        'EX',
        GITHUB_API_CACHE_EXPIRATION_SECONDS
      );
    });

    test('falls back to the database and writes a negative membership cache', async () => {
      const result = await service.isRepositoryOnboarded(34, 12);

      expect(result).toBe(false);
      expect(redis.set).toHaveBeenCalledWith(
        githubOnboardedRepositoryCacheKey(34, 12),
        JSON.stringify({ onboarded: false }),
        'EX',
        60
      );
    });
  });

  describe('syncRepositoryRename', () => {
    test('updates the active row and patches installed and onboarded caches when present', async () => {
      const repository = createRepository({ id: 7, fullName: 'example-org/old-name' });
      repositories.push(repository);
      redis.store.set(
        githubInstalledRepositoriesCacheKey(34),
        JSON.stringify({
          installationId: 34,
          fetchedAt: '2026-01-01T00:00:00.000Z',
          repositories: [
            {
              githubRepositoryId: 12,
              ownerId: 56,
              ownerLogin: 'example-org',
              name: 'old-name',
              fullName: 'example-org/old-name',
              htmlUrl: 'https://github.com/example-org/old-name',
              private: true,
              archived: false,
              disabled: false,
              visibility: 'private',
              defaultBranch: 'main',
              updatedAt: '2026-01-01T00:00:00.000Z',
              pushedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      );
      redis.store.set(
        githubOnboardedRepositoryCacheKey(34, 12),
        JSON.stringify({
          onboarded: true,
          repositoryId: 7,
          githubRepositoryId: 12,
          githubInstallationId: 34,
          fullName: 'example-org/old-name',
        })
      );

      const result = await service.syncRepositoryRename({
        githubRepositoryId: 12,
        githubInstallationId: 34,
        ownerId: 56,
        ownerLogin: 'example-org',
        name: 'new-name',
        fullName: 'example-org/new-name',
        htmlUrl: 'https://github.com/example-org/new-name',
      });
      const installedCache = JSON.parse(redis.store.get(githubInstalledRepositoriesCacheKey(34)));
      const onboardedCache = JSON.parse(redis.store.get(githubOnboardedRepositoryCacheKey(34, 12)));

      expect(result).toEqual(
        expect.objectContaining({
          id: 7,
          fullName: 'example-org/new-name',
        })
      );
      expect(installedCache.repositories[0]).toEqual(
        expect.objectContaining({
          name: 'new-name',
          fullName: 'example-org/new-name',
          htmlUrl: 'https://github.com/example-org/new-name',
        })
      );
      expect(onboardedCache).toEqual({
        onboarded: true,
        repositoryId: 7,
        githubRepositoryId: 12,
        githubInstallationId: 34,
        fullName: 'example-org/new-name',
      });
    });
  });
});
