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

jest.mock('server/models/ApiToken');
jest.mock('server/models/Repository');
jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getAllConfigs: async () => ({}) }) },
}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('server/services/authAudit', () => ({
  recordAuthAuditEvent: jest.fn(),
  recordAuthAuditEventInTransaction: jest.fn(),
}));
jest.mock('shared/config', () => ({ GITHUB_APP_INSTALLATION_ID: '100000' }));
jest.mock('server/lib/github', () => ({ getRepositoryByFullName: jest.fn() }));

import ApiTokenService, { isRepositoryAllowedById, PERSONAL_TOKEN_MAX_TTL_HOURS } from 'server/services/apiToken';
import ApiToken from 'server/models/ApiToken';
import Repository from 'server/models/Repository';
import { getRepositoryByFullName } from 'server/lib/github';
import { recordAuthAuditEventInTransaction } from 'server/services/authAudit';
import { BadRequestError } from 'server/lib/appError';

const mockRecordInTx = recordAuthAuditEventInTransaction as jest.Mock;

function makeQuery(result: any = undefined) {
  const q: any = {
    _result: result,
    select: jest.fn(() => q),
    where: jest.fn(() => q),
    whereRaw: jest.fn(() => q),
    whereNull: jest.fn(() => q),
    whereNotNull: jest.fn(() => q),
    whereIn: jest.fn(() => q),
    orderBy: jest.fn(() => q),
    forUpdate: jest.fn(() => q),
    patch: jest.fn(() => q),
    findById: jest.fn(),
    insertAndFetch: jest.fn(),
    patchAndFetchById: jest.fn(),
    page: jest.fn(async () => ({ results: q._result ?? [], total: (q._result ?? []).length })),
    resultSize: jest.fn(async () => 0),
    then: (resolve: any, reject: any) => Promise.resolve(q._result).then(resolve, reject),
  };
  return q;
}

let apiQuery: any;
let repoQuery: any;
let trx: any;

beforeEach(() => {
  jest.clearAllMocks();
  apiQuery = makeQuery();
  repoQuery = makeQuery([]);
  trx = { raw: jest.fn() };
  (ApiToken.query as jest.Mock) = jest.fn(() => apiQuery);
  (ApiToken.transaction as jest.Mock) = jest.fn(async (cb: any) => cb(trx));
  (Repository.query as jest.Mock) = jest.fn(() => repoQuery);
});

describe('assertUserTokenScopes (invariant 1)', () => {
  it('refuses a principal with neither user nor admin role', () => {
    expect(() => ApiTokenService.assertUserTokenScopes(['env:read'], [])).toThrow(
      expect.objectContaining({ httpStatus: 403, code: 'forbidden_scope' })
    );
  });

  it('rejects env:admin for a user owner and an admin owner alike', () => {
    for (const roles of [['user'], ['admin']]) {
      expect(() => ApiTokenService.assertUserTokenScopes(['env:admin'], roles)).toThrow(
        expect.objectContaining({ httpStatus: 403, code: 'forbidden_scope' })
      );
    }
  });

  it('allows read/write for eligible roles and dedupes', () => {
    expect(ApiTokenService.assertUserTokenScopes(['env:read', 'env:read', 'env:write'], ['user'])).toEqual([
      'env:read',
      'env:write',
    ]);
  });

  it('rejects an empty scope set', () => {
    expect(() => ApiTokenService.assertUserTokenScopes([], ['admin'])).toThrow(BadRequestError);
  });
});

describe('resolveRequestedExpiry (invariant 5)', () => {
  it('rejects past/invalid expiries, non-positive TTLs, and combining both fields', () => {
    expect(() =>
      ApiTokenService.resolveRequestedExpiry({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    ).toThrow(expect.objectContaining({ code: 'invalid_expiry' }));
    expect(() => ApiTokenService.resolveRequestedExpiry({ ttlHours: 0 })).toThrow(
      expect.objectContaining({ code: 'invalid_expiry' })
    );
    expect(() => ApiTokenService.resolveRequestedExpiry({ ttlHours: -5 })).toThrow(
      expect.objectContaining({ code: 'invalid_expiry' })
    );
    expect(() => ApiTokenService.resolveRequestedExpiry({ ttlHours: '24' as any })).toThrow(
      expect.objectContaining({ code: 'invalid_expiry' })
    );
    expect(() => ApiTokenService.resolveRequestedExpiry({ ttlHours: 1.5 })).toThrow(
      expect.objectContaining({ code: 'invalid_expiry' })
    );
    expect(() => ApiTokenService.resolveRequestedExpiry({ expiresAt: '2026-02-31T00:00:00Z' })).toThrow(
      expect.objectContaining({ code: 'invalid_expiry' })
    );
    expect(() =>
      ApiTokenService.resolveRequestedExpiry({
        ttlHours: 24,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_expiry' }));
  });

  it('converts ttlHours from the server clock and passes through a valid expiresAt', () => {
    const before = Date.now();
    const fromTtl = ApiTokenService.resolveRequestedExpiry({ ttlHours: 24 });
    const parsed = new Date(fromTtl as string).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before + 24 * 3_600_000 - 1000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000 + 1000);

    const within = new Date(Date.now() + 24 * 3_600_000).toISOString();
    expect(ApiTokenService.resolveRequestedExpiry({ expiresAt: within })).toBe(within);
  });

  it('returns null (non-expiring) when no expiry is provided', () => {
    expect(ApiTokenService.resolveRequestedExpiry({})).toBeNull();
  });

  it('caps Personal-key expiry at 720 hours while allowing omitted expiry', () => {
    const policy = { maxTtlHours: PERSONAL_TOKEN_MAX_TTL_HOURS };
    expect(ApiTokenService.resolveRequestedExpiry({}, policy)).toBeNull();
    expect(() => ApiTokenService.resolveRequestedExpiry({ ttlHours: 721 }, policy)).toThrow(
      expect.objectContaining({ code: 'invalid_expiry' })
    );
    expect(() =>
      ApiTokenService.resolveRequestedExpiry(
        { expiresAt: new Date(Date.now() + 721 * 3_600_000).toISOString() },
        policy
      )
    ).toThrow(expect.objectContaining({ code: 'invalid_expiry' }));
    expect(ApiTokenService.resolveRequestedExpiry({ ttlHours: 720 }, policy)).toEqual(expect.any(String));
  });

  it('rejects TTL arithmetic outside the supported date range', () => {
    expect(() => ApiTokenService.resolveRequestedExpiry({ ttlHours: Number.MAX_SAFE_INTEGER })).toThrow(
      expect.objectContaining({ code: 'invalid_expiry' })
    );
  });
});

describe('resolveRepositoryAccess', () => {
  it('rejects the legacy repositoryAllowlist field and missing/invalid modes', async () => {
    await expect(ApiTokenService.resolveRepositoryAccess({ repositoryAllowlist: ['org/repo'] })).rejects.toMatchObject({
      code: 'invalid_body',
    });
    await expect(ApiTokenService.resolveRepositoryAccess({})).rejects.toMatchObject({ code: 'invalid_body' });
    await expect(
      ApiTokenService.resolveRepositoryAccess({ repositoryAccess: { mode: 'bogus' } })
    ).rejects.toMatchObject({ code: 'invalid_body' });
  });

  it('persists null allowlists only for explicit all-repository access', async () => {
    await expect(ApiTokenService.resolveRepositoryAccess({ repositoryAccess: { mode: 'all' } })).resolves.toEqual({
      names: null,
      repoIds: null,
    });
  });

  it('rejects unknown repositoryAccess keys per mode (no silent widening or dropped fields)', async () => {
    await expect(
      ApiTokenService.resolveRepositoryAccess({ repositoryAccess: { mode: 'all', repositories: ['org/repo'] } })
    ).rejects.toMatchObject({ code: 'invalid_body' });
    await expect(
      ApiTokenService.resolveRepositoryAccess({
        repositoryAccess: { mode: 'selected', repositories: ['org/repo'], mod: 'all' },
      })
    ).rejects.toMatchObject({ code: 'invalid_body' });
  });

  it('rejects all-repository access when Personal-key policy requires a selection', async () => {
    await expect(
      ApiTokenService.resolveRepositoryAccess({ repositoryAccess: { mode: 'all' } }, { allowAll: false })
    ).rejects.toMatchObject({ code: 'invalid_repository_access' });
  });

  it('resolves selected repositories through the allowlist path', async () => {
    repoQuery._result = [{ fullName: 'Org/Repo', githubRepositoryId: 42 }];
    await expect(
      ApiTokenService.resolveRepositoryAccess({
        repositoryAccess: { mode: 'selected', repositories: ['Org/Repo'] },
      })
    ).resolves.toEqual({ names: ['org/repo'], repoIds: [42] });
    await expect(
      ApiTokenService.resolveRepositoryAccess({ repositoryAccess: { mode: 'selected', repositories: [] } })
    ).rejects.toMatchObject({ code: 'invalid_allowlist' });
  });
});

describe('resolveRepositoryAllowlist (invariant 10)', () => {
  it('rejects empty, oversized, malformed, and non-string allowlists', async () => {
    await expect(ApiTokenService.resolveRepositoryAllowlist([])).rejects.toMatchObject({ code: 'invalid_allowlist' });
    await expect(ApiTokenService.resolveRepositoryAllowlist(['noslash'])).rejects.toMatchObject({
      code: 'invalid_allowlist',
    });
    await expect(ApiTokenService.resolveRepositoryAllowlist([123 as any])).rejects.toMatchObject({
      code: 'invalid_allowlist',
    });
    await expect(
      ApiTokenService.resolveRepositoryAllowlist(Array.from({ length: 51 }, (_, i) => `org/repo-${i}`))
    ).rejects.toMatchObject({ code: 'invalid_allowlist' });
  });

  it('normalizes, dedupes, and resolves to onboarded repo ids without touching GitHub', async () => {
    repoQuery._result = [{ fullName: 'Org/Repo', githubRepositoryId: 42 }];
    const result = await ApiTokenService.resolveRepositoryAllowlist(['Org/Repo', 'org/repo']);
    expect(result).toEqual({ names: ['org/repo'], repoIds: [42] });
    expect(repoQuery.whereRaw).toHaveBeenCalledWith('lower("fullName") = ANY(?)', [['org/repo']]);
    expect(getRepositoryByFullName).not.toHaveBeenCalled();
  });

  it('resolves a not-yet-onboarded repository through GitHub so a scoped key can onboard it', async () => {
    repoQuery._result = [{ fullName: 'Org/Repo', githubRepositoryId: 42 }];
    (getRepositoryByFullName as jest.Mock).mockResolvedValue({ data: { id: 7 } });
    const result = await ApiTokenService.resolveRepositoryAllowlist(['Org/Repo', 'org/new-repo']);
    expect(result).toEqual({ names: ['org/repo', 'org/new-repo'], repoIds: [42, 7] });
    expect(getRepositoryByFullName).toHaveBeenCalledTimes(1);
    expect(getRepositoryByFullName).toHaveBeenCalledWith('org/new-repo', 100000);
  });

  it('rejects a repository GitHub cannot see (no latent authority for unresolvable names)', async () => {
    repoQuery._result = [];
    (getRepositoryByFullName as jest.Mock).mockRejectedValue(
      new Error('Repository not found or GitHub App cannot access it: org/ghost')
    );
    await expect(ApiTokenService.resolveRepositoryAllowlist(['org/ghost'])).rejects.toMatchObject({
      httpStatus: 400,
      code: 'repo_not_found',
    });
  });

  it('rejects a GitHub response without a stable repository id', async () => {
    repoQuery._result = [];
    (getRepositoryByFullName as jest.Mock).mockResolvedValue({ data: {} });
    await expect(ApiTokenService.resolveRepositoryAllowlist(['org/weird'])).rejects.toMatchObject({
      httpStatus: 400,
      code: 'repo_not_found',
    });
  });

  it('propagates non-404 GitHub failures instead of masking them as bad requests', async () => {
    repoQuery._result = [];
    (getRepositoryByFullName as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(ApiTokenService.resolveRepositoryAllowlist(['org/down'])).rejects.toThrow('boom');
  });
});

describe('assertServiceTokenScopes', () => {
  it('rejects env:admin on newly issued service keys', () => {
    expect(() => ApiTokenService.assertServiceTokenScopes(['env:write', 'env:admin'])).toThrow(
      expect.objectContaining({ httpStatus: 403, code: 'forbidden_scope' })
    );
  });

  it('allows read/write', () => {
    expect(ApiTokenService.assertServiceTokenScopes(['env:read', 'env:write'])).toEqual(['env:read', 'env:write']);
  });
});

describe('parseTokenId (strict id parsing)', () => {
  it.each(['5abc', '-5', '0', '5.5', ' 5', '5 ', '+5', '', 'policy', '9007199254740993'])('rejects %p', (raw) => {
    expect(() => ApiTokenService.parseTokenId(raw as string)).toThrow(
      expect.objectContaining({ code: 'invalid_token_id' })
    );
  });

  it('accepts a plain positive integer', () => {
    expect(ApiTokenService.parseTokenId('5')).toBe(5);
  });
});

describe('tokenKind / tokenStatus (derived response fields)', () => {
  it('returns the persisted kind', () => {
    expect(ApiTokenService.tokenKind({ kind: 'service' } as any)).toBe('service');
    expect(ApiTokenService.tokenKind({ kind: 'personal' } as any)).toBe('personal');
  });

  it('derives status with revoked taking precedence over expired', () => {
    expect(ApiTokenService.tokenStatus({ revokedAt: 'now', expiresAt: null } as any)).toBe('revoked');
    expect(
      ApiTokenService.tokenStatus({ revokedAt: null, expiresAt: new Date(Date.now() - 1000).toISOString() } as any)
    ).toBe('expired');
    expect(
      ApiTokenService.tokenStatus({ revokedAt: null, expiresAt: new Date(Date.now() + 1000).toISOString() } as any)
    ).toBe('active');
    expect(ApiTokenService.tokenStatus({ revokedAt: null, expiresAt: null } as any)).toBe('active');
  });
});

describe('listTokens filters', () => {
  it('filters kind=service to null owners and kind=personal to owned rows', async () => {
    await ApiTokenService.listTokens({ kind: 'service' });
    expect(apiQuery.whereNull).toHaveBeenCalledWith('ownerUserId');

    jest.clearAllMocks();
    apiQuery = makeQuery();
    (ApiToken.query as jest.Mock) = jest.fn(() => apiQuery);
    await ApiTokenService.listTokens({ kind: 'personal' });
    expect(apiQuery.whereNotNull).toHaveBeenCalledWith('ownerUserId');
  });

  it('searches by name/prefix/owner fields', async () => {
    await ApiTokenService.listTokens({ search: 'CI' });
    expect(apiQuery.where).toHaveBeenCalled();
  });

  it('escapes LIKE metacharacters so search terms match literally', async () => {
    const w: any = {};
    w.whereRaw = jest.fn(() => w);
    w.orWhereRaw = jest.fn(() => w);
    apiQuery.where.mockImplementation((arg: any) => {
      if (typeof arg === 'function') arg(w);
      return apiQuery;
    });

    await ApiTokenService.listTokens({ search: 'my_key %50\\' });

    const like = '%my\\_key \\%50\\\\%';
    expect(w.whereRaw).toHaveBeenCalledWith('LOWER("name") LIKE ?', [like]);
    expect(w.orWhereRaw).toHaveBeenCalledWith('LOWER("tokenPrefix") LIKE ?', [like]);
  });

  it('paginates the real service query and returns pagination metadata', async () => {
    apiQuery.page.mockResolvedValue({ results: [{ id: 2 }], total: 11 });

    await expect(
      ApiTokenService.listTokensPaginated({ kind: 'service', search: 'ci' }, { page: 2, limit: 10 })
    ).resolves.toEqual({
      data: [{ id: 2 }],
      metadata: { current: 2, total: 2, items: 11, limit: 10 },
    });
    expect(apiQuery.whereNull).toHaveBeenCalledWith('ownerUserId');
    expect(apiQuery.page).toHaveBeenCalledWith(1, 10);
  });
});

describe('issueUserToken (invariant 2)', () => {
  it('stamps the owner from identity, lowercasing email/username', async () => {
    apiQuery.insertAndFetch.mockImplementation(async (attrs: any) => ({ id: 3, ...attrs }));
    const { token, record } = await ApiTokenService.issueUserToken({
      name: 'ci',
      scopes: ['env:write'],
      repositoryAllowlist: ['org/repo'],
      repositoryAllowlistRepoIds: [42],
      expiresAt: '2026-08-01T00:00:00.000Z',
      owner: {
        userId: 'sub-1',
        githubUsername: null,
        email: 'Alice@Corp.COM',
        preferredUsername: 'Alice',
        displayName: ' Alice Doe ',
        roleAtIssue: 'user',
      },
    });
    expect(token).toMatch(/^lfc_pat_[a-f0-9]{40}$/);
    expect(apiQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'personal',
        ownerUserId: 'sub-1',
        ownerEmail: 'alice@corp.com',
        ownerPreferredUsername: 'alice',
        ownerDisplayName: 'Alice Doe',
        ownerRoleAtIssue: 'user',
        repositoryAllowlistRepoIds: [42],
        createdBy: 'sub-1',
        expiresAt: '2026-08-01T00:00:00.000Z',
      })
    );
    expect(record.ownerUserId).toBe('sub-1');
  });

  it('refuses a mint once the owner is at the active-key cap', async () => {
    apiQuery.resultSize.mockResolvedValueOnce(10);
    await expect(
      ApiTokenService.issueUserToken({
        name: 'ci',
        scopes: ['env:read'],
        repositoryAllowlist: null,
        repositoryAllowlistRepoIds: null,
        expiresAt: null,
        owner: {
          userId: 'sub-1',
          githubUsername: null,
          email: null,
          preferredUsername: null,
          displayName: null,
          roleAtIssue: 'user',
        },
      })
    ).rejects.toThrow(expect.objectContaining({ httpStatus: 403, code: 'personal_token_limit' }));
    expect(apiQuery.insertAndFetch).not.toHaveBeenCalled();
  });

  it('serializes the cap check with the insert: per-owner advisory lock, then count, all inside the mint transaction', async () => {
    apiQuery.insertAndFetch.mockImplementation(async (attrs: any) => ({ id: 3, ...attrs }));
    await ApiTokenService.issueUserToken({
      name: 'ci',
      scopes: ['env:read'],
      repositoryAllowlist: null,
      repositoryAllowlistRepoIds: null,
      expiresAt: null,
      owner: {
        userId: 'sub-1',
        githubUsername: null,
        email: null,
        preferredUsername: null,
        displayName: null,
        roleAtIssue: 'user',
      },
    });
    expect(trx.raw).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), [
      'api_token:personal_cap:sub-1',
    ]);
    expect(ApiToken.query).toHaveBeenCalledWith(trx);
    const lockAt = trx.raw.mock.invocationCallOrder[0];
    const countAt = apiQuery.resultSize.mock.invocationCallOrder[0];
    const insertAt = apiQuery.insertAndFetch.mock.invocationCallOrder[0];
    expect(lockAt).toBeLessThan(countAt);
    expect(countAt).toBeLessThan(insertAt);
  });
});

describe('revokeOwnedToken (invariant 6, no-leak)', () => {
  it('returns null for a missing token or one owned by someone else', async () => {
    apiQuery.findById.mockResolvedValueOnce(undefined);
    expect(await ApiTokenService.revokeOwnedToken(1, 'sub-1')).toBeNull();

    apiQuery.findById.mockResolvedValueOnce({ id: 1, ownerUserId: 'sub-2', revokedAt: null });
    expect(await ApiTokenService.revokeOwnedToken(1, 'sub-1')).toBeNull();
    expect(apiQuery.patchAndFetchById).not.toHaveBeenCalled();
  });

  it('revokes an owned token, stamping revokedBy = owner', async () => {
    apiQuery.findById.mockResolvedValueOnce({ id: 1, ownerUserId: 'sub-1', revokedAt: null });
    apiQuery.patchAndFetchById.mockResolvedValueOnce({ id: 1, revokedAt: 'now' });
    const revoked = await ApiTokenService.revokeOwnedToken(1, 'sub-1');
    expect(revoked).toEqual({ id: 1, revokedAt: 'now' });
    expect(apiQuery.patchAndFetchById).toHaveBeenCalledWith(1, {
      revokedAt: expect.any(String),
      revokedBy: 'sub-1',
      revokeReason: 'manual',
    });
    expect(apiQuery.forUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns the locked terminal row without overwriting or double-auditing it', async () => {
    const alreadyRevoked = {
      id: 1,
      kind: 'personal',
      scopes: ['env:read'],
      ownerUserId: 'sub-1',
      revokedAt: '2026-01-01T00:00:00Z',
      revokedBy: 'first-actor',
    };
    apiQuery.findById.mockResolvedValueOnce(alreadyRevoked);

    await expect(ApiTokenService.revokeOwnedToken(1, 'sub-1')).resolves.toBe(alreadyRevoked);

    expect(apiQuery.patchAndFetchById).not.toHaveBeenCalled();
    expect(mockRecordInTx).not.toHaveBeenCalled();
  });
});

describe('revokeByOwnerIdentifier (invariant 12)', () => {
  it('refuses 409 when an identifier resolves to more than one owner', async () => {
    apiQuery._result = [
      { id: 1, ownerUserId: 'sub-1', revokedAt: null },
      { id: 2, ownerUserId: 'sub-2', revokedAt: null },
    ];
    await expect(
      ApiTokenService.revokeByOwnerIdentifier('ownerEmail', 'shared@corp.com', 'admin-1')
    ).rejects.toMatchObject({ httpStatus: 409, code: 'ambiguous_owner' });
  });

  it('lowercases the email selector and revokes the single owner’s active tokens', async () => {
    apiQuery._result = [
      { id: 1, ownerUserId: 'sub-1', revokedAt: null },
      { id: 2, ownerUserId: 'sub-1', revokedAt: 'already' },
    ];
    const { count } = await ApiTokenService.revokeByOwnerIdentifier('ownerEmail', 'Alice@Corp.com', 'admin-1');
    expect(apiQuery.where).toHaveBeenCalledWith('ownerEmail', 'alice@corp.com');
    expect(count).toBe(1);
    expect(apiQuery.whereIn).toHaveBeenCalledWith('id', [1]);
    expect(apiQuery.patch).toHaveBeenCalledWith(expect.objectContaining({ revokedBy: 'admin-1' }));
  });

  it('does not lowercase the sub selector', async () => {
    apiQuery._result = [];
    await ApiTokenService.revokeByOwnerIdentifier('ownerUserId', 'SUB-Mixed', 'admin-1');
    expect(apiQuery.where).toHaveBeenCalledWith('ownerUserId', 'SUB-Mixed');
  });
});

describe('revokeAllUserTokens (invariant, surgical kill)', () => {
  it('revokes every owner-set active token', async () => {
    apiQuery._result = [{ id: 1 }, { id: 2 }];
    const { count } = await ApiTokenService.revokeAllUserTokens('admin-1');
    expect(apiQuery.whereNotNull).toHaveBeenCalledWith('ownerUserId');
    expect(apiQuery.whereNull).toHaveBeenCalledWith('revokedAt');
    expect(count).toBe(2);
    expect(apiQuery.whereIn).toHaveBeenCalledWith('id', [1, 2]);
    expect(apiQuery.forUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite or audit when another revoker won after the discovery query', async () => {
    const discovery = makeQuery([{ id: 1, ownerUserId: 'sub-1', revokedAt: null }]);
    const locked = makeQuery([]);
    (ApiToken.query as jest.Mock).mockReset().mockReturnValueOnce(discovery).mockReturnValue(locked);

    await expect(ApiTokenService.revokeAllUserTokens('second-admin')).resolves.toEqual({ count: 0 });

    expect(locked.forUpdate).toHaveBeenCalledTimes(1);
    expect(locked.patch).not.toHaveBeenCalled();
    expect(mockRecordInTx).not.toHaveBeenCalled();
  });
});

describe('isRepositoryAllowedById (invariant 10, F4)', () => {
  it('allows everything when no id-allowlist (org tokens)', () => {
    expect(isRepositoryAllowedById(null, 42)).toBe(true);
    expect(isRepositoryAllowedById(undefined, 42)).toBe(true);
  });

  it('fails closed on an explicit empty id-allowlist', () => {
    expect(isRepositoryAllowedById([], 42)).toBe(false);
    expect(isRepositoryAllowedById([], null)).toBe(false);
  });

  it('enforces membership by id and rejects a null repo id', () => {
    expect(isRepositoryAllowedById([42, 7], 42)).toBe(true);
    expect(isRepositoryAllowedById([42], 99)).toBe(false);
    expect(isRepositoryAllowedById([42], null)).toBe(false);
  });
});
