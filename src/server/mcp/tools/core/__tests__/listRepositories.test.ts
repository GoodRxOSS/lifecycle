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

const mockRepositoryQuery = jest.fn();
const mockServiceQuery = jest.fn();
const mockEnvironmentQuery = jest.fn();
const mockListOnboardedRepositories = jest.fn();
const mockListBranchesForRepo = jest.fn();

jest.mock('server/models/Repository', () => ({
  __esModule: true,
  default: { query: () => mockRepositoryQuery() },
}));

jest.mock('server/models/Service', () => ({
  __esModule: true,
  default: { query: () => mockServiceQuery() },
}));

jest.mock('server/models/Environment', () => ({
  __esModule: true,
  default: { query: () => mockEnvironmentQuery() },
}));

jest.mock('server/services/repository', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    listOnboardedRepositories: (...args: unknown[]) => mockListOnboardedRepositories(...args),
  })),
}));

jest.mock('server/lib/github', () => ({
  listBranchesForRepo: (...args: unknown[]) => mockListBranchesForRepo(...args),
}));

import { AppError } from 'server/lib/appError';
import type { Principal } from 'server/lib/principal';
import RepositoryService, { type RepositoryResponse } from 'server/services/repository';
import type { McpJsonObject, McpToolContext } from '../../../contracts';
import { McpExecutionError } from '../../../errors';
import { compileMcpJsonValidator } from '../../../schemaValidator';
import {
  createListRepositoriesToolDefinition,
  defaultFindRepository,
  defaultListRepositoryEnvironments,
  listRepositoriesInputSchema,
  listRepositoriesOutputSchema,
  mapCoreToolError,
  safeCoreText,
  type CoreRepositoryRecord,
  type ListRepositoriesToolDependencies,
} from '../listRepositories';

const mockRepositoryServiceConstructor = RepositoryService as unknown as jest.Mock;

const originalEncryptionKey = process.env.ENCRYPTION_KEY;

const principal: Principal = {
  kind: 'user',
  authMethod: 'oauth',
  userId: 'repository-user',
  actor: 'repository-user',
  roles: ['user'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: ['goodrx/example'],
  repositoryAllowlistRepoIds: [7],
  identity: null,
};

const context: McpToolContext = {
  principal,
  requestId: 'list-repositories-request',
  signal: new AbortController().signal,
  audit: { annotate: jest.fn() },
};

function repositoryResponse(id: number, fullName: string, defaultEnvId: number | null = null): RepositoryResponse {
  return {
    id,
    githubRepositoryId: id + 100,
    githubInstallationId: 17,
    ownerId: 3,
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    defaultEnvId,
    onboarded: true,
  };
}

function serviceQuery(rows: Array<{ environmentId: number }>) {
  const chain: Record<string, jest.Mock> = {};
  chain.alias = jest.fn(() => chain);
  chain.join = jest.fn(() => chain);
  chain.distinct = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.whereNull = jest.fn(() => chain);
  chain.whereNotNull = jest.fn().mockResolvedValue(rows);
  return chain;
}

async function callHandler(
  dependencies: ListRepositoriesToolDependencies,
  input: McpJsonObject
): Promise<McpJsonObject> {
  return createListRepositoriesToolDefinition(dependencies).handler(input, context);
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '8'.repeat(64);
});

afterAll(() => {
  if (originalEncryptionKey === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRepositoryQuery.mockReset();
  mockServiceQuery.mockReset();
  mockEnvironmentQuery.mockReset();
  mockListOnboardedRepositories.mockReset();
  mockListBranchesForRepo.mockReset();
});

describe('tool contract and list mode', () => {
  it('declares a read-only repository-discovery contract with closed list/detail inputs', () => {
    const definition = createListRepositoriesToolDefinition({
      listOnboardedRepositories: jest.fn(),
      findRepository: jest.fn(),
      listBranches: jest.fn(),
      listRepositoryEnvironments: jest.fn(),
      nowSeconds: () => 1_000,
    });

    expect(definition).toMatchObject({
      name: 'list_repositories',
      capabilityId: 'understand-environments',
      access: 'read',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: listRepositoriesInputSchema,
      outputSchema: listRepositoriesOutputSchema,
    });
  });

  it('accepts documented limit boundaries and rejects invalid limits and repository names', () => {
    const validate = compileMcpJsonValidator(listRepositoriesInputSchema);

    expect(validate({ request: { mode: 'list', limit: 1 } })).toBe(true);
    expect(validate({ request: { mode: 'list', limit: 100 } })).toBe(true);
    expect(validate({ request: { mode: 'detail', repository: 'goodrx/example' } })).toBe(true);

    for (const invalid of [
      { request: { mode: 'list', limit: 0 } },
      { request: { mode: 'list', limit: 101 } },
      { request: { mode: 'list', limit: 1.5 } },
      { request: { mode: 'list', q: 'x'.repeat(101) } },
      { request: { mode: 'detail', repository: 'missing-slash' } },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });

  it('uses default filters and limits and passes the current unrestricted repository scope', async () => {
    const listOnboardedRepositories = jest.fn().mockResolvedValue({
      repositories: [repositoryResponse(1, 'goodrx/example', 9)],
      pagination: { current: 1, total: 1, items: 1, limit: 25 },
    });

    const output = await callHandler({ listOnboardedRepositories }, { request: { mode: 'list' } });

    expect(listOnboardedRepositories).toHaveBeenCalledWith({
      query: '',
      page: 1,
      limit: 25,
      allowedGithubRepositoryIds: null,
      allowedRepositoryFullNames: null,
    });
    expect(output).toEqual({
      result: {
        mode: 'list',
        repositories: [{ fullName: 'goodrx/example', hasDefaultEnvironment: true }],
      },
    });
  });

  it('normalizes search, advances a filter-bound cursor, and omits a cursor on the final page', async () => {
    const listOnboardedRepositories = jest
      .fn()
      .mockResolvedValueOnce({
        repositories: [repositoryResponse(1, 'goodrx/example')],
        pagination: { current: 1, total: 2, items: 2, limit: 10 },
      })
      .mockResolvedValueOnce({
        repositories: [repositoryResponse(2, 'goodrx/example-api', 12)],
        pagination: { current: 2, total: 2, items: 2, limit: 10 },
      });
    const dependencies = { listOnboardedRepositories, nowSeconds: () => 1_000 };

    const first = await callHandler(dependencies, {
      request: { mode: 'list', q: '  ExAmPlE ', limit: 10 },
    });
    const firstResult = first.result as McpJsonObject;
    expect(typeof firstResult.nextCursor).toBe('string');
    expect(listOnboardedRepositories).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ query: 'example', page: 1, limit: 10 })
    );

    const second = await callHandler(dependencies, {
      request: { mode: 'list', q: 'example', limit: 10, cursor: firstResult.nextCursor },
    });
    expect(listOnboardedRepositories).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query: 'example', page: 2, limit: 10 })
    );
    expect(second).toEqual({
      result: {
        mode: 'list',
        repositories: [{ fullName: 'goodrx/example-api', hasDefaultEnvironment: true }],
      },
    });

    await expect(
      callHandler(dependencies, {
        request: { mode: 'list', q: 'different', limit: 10, cursor: firstResult.nextCursor },
      })
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
    expect(listOnboardedRepositories).toHaveBeenCalledTimes(2);
  });

  it('uses the default repository service and clock when dependencies are omitted', async () => {
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mockListOnboardedRepositories.mockResolvedValue({
      repositories: [repositoryResponse(1, 'goodrx/default-service')],
      pagination: { current: 1, total: 2, items: 2, limit: 25 },
    });

    try {
      const output = await createListRepositoriesToolDefinition().handler({ request: { mode: 'list' } }, context);

      expect(mockRepositoryServiceConstructor).toHaveBeenCalledTimes(1);
      expect(mockListOnboardedRepositories).toHaveBeenCalledWith({
        query: '',
        page: 1,
        limit: 25,
        allowedGithubRepositoryIds: null,
        allowedRepositoryFullNames: null,
      });
      expect(typeof (output.result as McpJsonObject).nextCursor).toBe('string');
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe('detail mode', () => {
  it('bounds branch and environment results while retaining a missing default branch', async () => {
    const repository: CoreRepositoryRecord = {
      githubRepositoryId: 7,
      fullName: 'goodrx/example',
      defaultEnvId: null,
    };
    const findRepository = jest.fn().mockResolvedValue(repository);
    const branches = Array.from({ length: 105 }, (_, index) => `branch-${String(index).padStart(3, '0')}`);
    const listBranches = jest.fn().mockResolvedValue({ branches, defaultBranch: 'trunk' });
    const listRepositoryEnvironments = jest.fn().mockResolvedValue(
      Array.from({ length: 105 }, (_, index) => ({
        environmentConfigId: index + 1,
        name: index === 0 ? '\u001b[31mproduction\u001b[0m' : `environment-${String(index).padStart(3, '0')}`,
        isDefault: false,
      }))
    );

    const output = await callHandler(
      { findRepository, listBranches, listRepositoryEnvironments },
      { request: { mode: 'detail', repository: 'goodrx/example' } }
    );
    const detail = (output.result as McpJsonObject).repository as McpJsonObject;

    expect(findRepository).toHaveBeenCalledWith('goodrx/example');
    expect(listBranches).toHaveBeenCalledWith('goodrx/example');
    expect(listRepositoryEnvironments).toHaveBeenCalledWith(repository);
    expect(detail).toMatchObject({
      fullName: 'goodrx/example',
      defaultBranch: 'trunk',
      hasDefaultEnvironment: false,
    });
    expect(detail.environments).toHaveLength(100);
    expect((detail.environments as McpJsonObject[])[0]).toMatchObject({ name: 'production' });
    expect(detail.branches).toHaveLength(101);
    expect((detail.branches as string[]).slice(-1)).toEqual(['trunk']);
    expect(detail.branches).not.toContain('branch-100');
  });

  it('returns an empty default branch when GitHub has no default branch', async () => {
    const output = await callHandler(
      {
        findRepository: async () => ({ githubRepositoryId: 7, fullName: 'goodrx/example', defaultEnvId: null }),
        listBranches: async () => ({ branches: ['main'], defaultBranch: null }),
        listRepositoryEnvironments: async () => [],
      },
      { request: { mode: 'detail', repository: 'goodrx/example' } }
    );

    expect((output.result as McpJsonObject).repository).toMatchObject({
      defaultBranch: '',
      branches: ['main'],
    });
  });

  it('does not query branches or environments when the repository is not onboarded', async () => {
    const listBranches = jest.fn();
    const listRepositoryEnvironments = jest.fn();

    await expect(
      callHandler(
        { findRepository: async () => null, listBranches, listRepositoryEnvironments },
        { request: { mode: 'detail', repository: 'goodrx/missing' } }
      )
    ).rejects.toMatchObject({ code: 'repo_not_onboarded' });

    expect(listBranches).not.toHaveBeenCalled();
    expect(listRepositoryEnvironments).not.toHaveBeenCalled();
  });
});

describe('error mapping and text safety', () => {
  it('preserves MCP errors and maps recognized application errors with optional details', () => {
    const mcpError = new McpExecutionError('invalid_cursor', 'Start the list again.');
    expect(mapCoreToolError(mcpError)).toBe(mcpError);

    const appError = new AppError({
      httpStatus: 404,
      code: 'env_not_found',
      message: 'The environment was destroyed.',
      details: { kind: 'destroyed', destroyedAt: '2026-08-01T00:00:00.000Z' },
    });
    expect(mapCoreToolError(appError)).toMatchObject({
      code: 'env_not_found',
      message: 'The environment was destroyed.',
      details: { kind: 'destroyed', destroyedAt: '2026-08-01T00:00:00.000Z' },
    });

    const withoutDetails = new AppError({
      httpStatus: 503,
      code: 'upstream_unavailable',
      message: 'GitHub is unavailable.',
    });
    expect(mapCoreToolError(withoutDetails)).toMatchObject({
      code: 'upstream_unavailable',
      message: 'GitHub is unavailable.',
      details: undefined,
    });
  });

  it.each([
    ['an unrecognized application error', new AppError({ httpStatus: 404, code: 'not_found', message: 'missing' })],
    ['an ordinary error', new Error('database details must not escape')],
  ])('maps %s to a stable internal error', (_label, error) => {
    expect(mapCoreToolError(error)).toMatchObject({
      code: 'internal_error',
      message: 'Lifecycle could not complete this request. Ask an administrator for help.',
    });
  });

  it('maps dependency failures through the handler and stops later detail calls', async () => {
    const listBranches = jest.fn();
    const listRepositoryEnvironments = jest.fn();
    const upstreamError = new AppError({
      httpStatus: 503,
      code: 'upstream_unavailable',
      message: 'Repository lookup unavailable.',
    });

    await expect(
      callHandler(
        {
          findRepository: () => Promise.reject(upstreamError),
          listBranches,
          listRepositoryEnvironments,
        },
        { request: { mode: 'detail', repository: 'goodrx/example' } }
      )
    ).rejects.toMatchObject({ code: 'upstream_unavailable', message: 'Repository lookup unavailable.' });
    expect(listBranches).not.toHaveBeenCalled();
    expect(listRepositoryEnvironments).not.toHaveBeenCalled();
  });

  it('normalizes control sequences and respects UTF-8 byte bounds', () => {
    expect(safeCoreText('\u001b[31mhello\u001b[0m', 5)).toBe('hello');
    expect(Buffer.byteLength(safeCoreText('ééé', 5), 'utf8')).toBeLessThanOrEqual(5);
    expect(safeCoreText(null, 10)).toBe('');
  });
});

describe('default repository adapters', () => {
  it('normalizes repository lookup and shapes active records', async () => {
    const first = jest.fn().mockResolvedValue({
      githubRepositoryId: 7,
      fullName: 'GoodRx/Example',
      defaultEnvId: 3,
    });
    const whereNull = jest.fn().mockReturnValue({ first });
    const whereRaw = jest.fn().mockReturnValue({ whereNull });
    mockRepositoryQuery.mockReturnValueOnce({ whereRaw });

    await expect(defaultFindRepository('  GOODRX/EXAMPLE  ')).resolves.toEqual({
      githubRepositoryId: 7,
      fullName: 'GoodRx/Example',
      defaultEnvId: 3,
    });
    expect(whereRaw).toHaveBeenCalledWith('lower("fullName") = ?', ['goodrx/example']);
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
  });

  it('returns null when no active repository matches', async () => {
    const first = jest.fn().mockResolvedValue(null);
    const whereNull = jest.fn().mockReturnValue({ first });
    const whereRaw = jest.fn().mockReturnValue({ whereNull });
    mockRepositoryQuery.mockReturnValueOnce({ whereRaw });

    await expect(defaultFindRepository('goodrx/missing')).resolves.toBeNull();
  });

  it('preserves a null default environment on an active repository', async () => {
    const first = jest.fn().mockResolvedValue({
      githubRepositoryId: 7,
      fullName: 'goodrx/example',
      defaultEnvId: null,
    });
    const whereNull = jest.fn().mockReturnValue({ first });
    mockRepositoryQuery.mockReturnValueOnce({ whereRaw: jest.fn().mockReturnValue({ whereNull }) });

    await expect(defaultFindRepository('goodrx/example')).resolves.toEqual({
      githubRepositoryId: 7,
      fullName: 'goodrx/example',
      defaultEnvId: null,
    });
  });

  it('returns early without an environment query when no memberships or default exist', async () => {
    mockServiceQuery.mockReturnValueOnce(serviceQuery([])).mockReturnValueOnce(serviceQuery([]));

    await expect(
      defaultListRepositoryEnvironments({
        githubRepositoryId: 7,
        fullName: 'goodrx/example',
        defaultEnvId: null,
      })
    ).resolves.toEqual([]);

    expect(mockServiceQuery).toHaveBeenCalledTimes(2);
    expect(mockEnvironmentQuery).not.toHaveBeenCalled();
  });

  it('deduplicates membership ids, includes the default, sorts it first, and caps results at 100', async () => {
    const defaultMemberships = Array.from({ length: 59 }, (_, index) => ({ environmentId: index + 2 }));
    const optionalMemberships = [
      { environmentId: 2 },
      ...Array.from({ length: 43 }, (_, index) => ({ environmentId: index + 61 })),
    ];
    mockServiceQuery
      .mockReturnValueOnce(serviceQuery(defaultMemberships))
      .mockReturnValueOnce(serviceQuery(optionalMemberships));
    const whereIn = jest
      .fn()
      .mockImplementation(async (_column: string, ids: number[]) =>
        [...ids]
          .reverse()
          .map((id) => ({ id, name: id === 1 ? 'Default' : `Environment ${String(id).padStart(3, '0')}` }))
      );
    mockEnvironmentQuery.mockReturnValue({ whereIn });

    const result = await defaultListRepositoryEnvironments({
      githubRepositoryId: 7,
      fullName: 'goodrx/example',
      defaultEnvId: 1,
    });

    const queriedIds = whereIn.mock.calls[0][1] as number[];
    expect(new Set(queriedIds).size).toBe(queriedIds.length);
    expect(queriedIds).toContain(1);
    expect(queriedIds.filter((id) => id === 2)).toHaveLength(1);
    expect(result).toHaveLength(100);
    expect(result[0]).toEqual({ environmentConfigId: 1, name: 'Default', isDefault: true });
    expect(result[1]).toEqual({ environmentConfigId: 2, name: 'Environment 002', isDefault: false });
  });

  it('sorts the default environment first when the database returns it last', async () => {
    mockServiceQuery.mockReturnValueOnce(serviceQuery([{ environmentId: 2 }])).mockReturnValueOnce(serviceQuery([]));
    mockEnvironmentQuery.mockReturnValue({
      whereIn: jest.fn().mockResolvedValue([
        { id: 2, name: 'Development' },
        { id: 1, name: 'Production' },
      ]),
    });

    await expect(
      defaultListRepositoryEnvironments({
        githubRepositoryId: 7,
        fullName: 'goodrx/example',
        defaultEnvId: 1,
      })
    ).resolves.toEqual([
      { environmentConfigId: 1, name: 'Production', isDefault: true },
      { environmentConfigId: 2, name: 'Development', isDefault: false },
    ]);
  });
});
