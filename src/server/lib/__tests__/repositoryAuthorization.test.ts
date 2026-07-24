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

jest.mock('server/models/Repository');
jest.mock('server/lib/buildSource', () => {
  const resolveBuildSourceRepository = jest.fn();
  return { resolveBuildSourceRepository, __resolve: resolveBuildSourceRepository };
});
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  assertBuildRepositoryAllowed,
  assertNamedRepositoryAllowed,
  assertRepositoryAllowed,
} from 'server/lib/repositoryAuthorization';
import type { Principal } from 'server/lib/principal';
import Repository from 'server/models/Repository';

const mockResolveRepo = (jest.requireMock('server/lib/buildSource') as any).__resolve as jest.Mock;

const principalWith = (
  repositoryAllowlist: string[] | null,
  repositoryAllowlistRepoIds: number[] | null = null
): Principal => ({
  kind: 'service_key',
  authMethod: 'api_key',
  userId: null,
  actor: 'token:ci',
  roles: [],
  scopes: ['env:write'],
  tokenId: 1,
  repositoryAllowlist,
  repositoryAllowlistRepoIds,
  identity: null,
});

afterEach(() => jest.clearAllMocks());

describe('assertRepositoryAllowed', () => {
  it('allows any repository without an allowlist and enforces one when present', () => {
    expect(() => assertRepositoryAllowed(principalWith(null), 'org/repo')).not.toThrow();
    expect(() => assertRepositoryAllowed(principalWith(['org/repo']), 'org/repo')).not.toThrow();
    expect(() => assertRepositoryAllowed(principalWith(['org/other']), 'org/repo')).toThrow(
      expect.objectContaining({ code: 'forbidden_repository', httpStatus: 403 })
    );
  });
});

describe('assertBuildRepositoryAllowed (name-bound)', () => {
  it('is a no-op without an allowlist and never resolves the build source', async () => {
    await expect(assertBuildRepositoryAllowed(principalWith(null), {} as any)).resolves.toBeUndefined();
    expect(mockResolveRepo).not.toHaveBeenCalled();
  });

  it('uses the PR repository without a lookup for PR builds', async () => {
    const build = { pullRequest: { fullName: 'org/allowed', repository: { fullName: 'org/allowed' } } } as any;
    await expect(assertBuildRepositoryAllowed(principalWith(['org/allowed']), build)).resolves.toBeUndefined();
    expect(mockResolveRepo).not.toHaveBeenCalled();
  });

  it('resolves the source repository for PR-less builds and enforces the allowlist', async () => {
    mockResolveRepo.mockResolvedValue({ fullName: 'org/allowed' });
    const build = { pullRequest: null } as any;

    await expect(assertBuildRepositoryAllowed(principalWith(['org/allowed']), build)).resolves.toBeUndefined();
    await expect(assertBuildRepositoryAllowed(principalWith(['org/other']), build)).rejects.toMatchObject({
      code: 'forbidden_repository',
      httpStatus: 403,
    });
  });

  it('fails closed when a repo-scoped token targets a build with no resolvable source', async () => {
    mockResolveRepo.mockResolvedValue(null);
    const build = { pullRequest: null } as any;

    await expect(assertBuildRepositoryAllowed(principalWith(['org/allowed']), build)).rejects.toMatchObject({
      code: 'forbidden_repository',
      httpStatus: 403,
    });
  });
});

describe('assertBuildRepositoryAllowed by repo id (F4)', () => {
  const idAuth = (repoIds: number[]) => principalWith(['org/repo'], repoIds);

  it('allows a build whose source repo id is in the token id-allowlist', async () => {
    await expect(
      assertBuildRepositoryAllowed(idAuth([42]), { githubRepositoryId: 42, pullRequest: null } as any)
    ).resolves.toBeUndefined();
    expect(mockResolveRepo).not.toHaveBeenCalled();
  });

  it('rejects a build whose source repo id is not allowlisted', async () => {
    await expect(
      assertBuildRepositoryAllowed(idAuth([42]), { githubRepositoryId: 99, pullRequest: null } as any)
    ).rejects.toMatchObject({ httpStatus: 403, code: 'forbidden_repository' });
  });

  it('resolves the source repo id for PR-less builds without a direct column', async () => {
    mockResolveRepo.mockResolvedValue({ githubRepositoryId: 42 });
    await expect(
      assertBuildRepositoryAllowed(idAuth([42]), { githubRepositoryId: null, pullRequest: null } as any)
    ).resolves.toBeUndefined();
  });
});

describe('assertNamedRepositoryAllowed (P0.7: identity beats the mutable name)', () => {
  const idBound = (repoIds: number[] | null, names: string[] | null = ['org/repo']) => principalWith(names, repoIds);

  const mockRepoLookup = (row: { fullName: string; githubRepositoryId: number } | null) => {
    const query: any = {
      whereRaw: jest.fn(() => query),
      whereNull: jest.fn(() => query),
      first: jest.fn(async () => row),
    };
    (Repository.query as jest.Mock) = jest.fn(() => query);
    return query;
  };

  it('allows an id-bound token to target its repository under a new name after rename', async () => {
    mockRepoLookup({ fullName: 'org/renamed', githubRepositoryId: 42 });
    await expect(assertNamedRepositoryAllowed(idBound([42]), 'org/renamed')).resolves.toBeUndefined();
  });

  it('rejects name reuse: the stored name now resolving to a different repository id', async () => {
    mockRepoLookup({ fullName: 'org/repo', githubRepositoryId: 999 });
    await expect(assertNamedRepositoryAllowed(idBound([42]), 'org/repo')).rejects.toMatchObject({
      httpStatus: 403,
      code: 'forbidden_repository',
    });
  });

  it('rejects a soft-deleted or never-onboarded target for id-bound tokens', async () => {
    mockRepoLookup(null);
    await expect(assertNamedRepositoryAllowed(idBound([42]), 'org/ghost')).rejects.toMatchObject({
      httpStatus: 403,
      code: 'forbidden_repository',
    });
  });

  it('falls back to name comparison for legacy name-only tokens', async () => {
    const query = mockRepoLookup(null);
    await expect(assertNamedRepositoryAllowed(idBound(null, ['org/repo']), 'org/repo')).resolves.toBeUndefined();
    await expect(assertNamedRepositoryAllowed(idBound(null, ['org/repo']), 'org/other')).rejects.toMatchObject({
      httpStatus: 403,
      code: 'forbidden_repository',
    });
    expect(query.first).not.toHaveBeenCalled();
  });

  it('passes through unrestricted tokens without a lookup', async () => {
    const query = mockRepoLookup(null);
    await expect(assertNamedRepositoryAllowed(idBound(null, null), 'any/repo')).resolves.toBeUndefined();
    expect(query.first).not.toHaveBeenCalled();
  });
});

describe('malformed empty allowlists fail closed instead of widening to all repositories', () => {
  it('denies direct, build-scoped, and name-targeted checks', async () => {
    expect(() => assertRepositoryAllowed(principalWith([]), 'org/repo')).toThrow(
      expect.objectContaining({ httpStatus: 403, code: 'forbidden_repository' })
    );

    await expect(
      assertBuildRepositoryAllowed(principalWith(null, []), { githubRepositoryId: 42, pullRequest: null } as any)
    ).rejects.toMatchObject({ httpStatus: 403, code: 'forbidden_repository' });

    const build = { pullRequest: { fullName: 'org/repo', repository: { fullName: 'org/repo' } } } as any;
    await expect(assertBuildRepositoryAllowed(principalWith([], null), build)).rejects.toMatchObject({
      httpStatus: 403,
      code: 'forbidden_repository',
    });

    const query: any = {
      whereRaw: jest.fn(() => query),
      whereNull: jest.fn(() => query),
      first: jest.fn(async () => ({ fullName: 'org/repo', githubRepositoryId: 42 })),
    };
    (Repository.query as jest.Mock) = jest.fn(() => query);
    await expect(assertNamedRepositoryAllowed(principalWith(null, []), 'org/repo')).rejects.toMatchObject({
      httpStatus: 403,
      code: 'forbidden_repository',
    });
  });
});
