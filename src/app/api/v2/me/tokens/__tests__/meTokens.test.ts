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

jest.mock('server/services/apiToken', () => {
  const actual = jest.requireActual('server/services/apiToken');
  return {
    __esModule: true,
    ...actual,
    default: {
      assertManagementAllowed: actual.default.assertManagementAllowed,
      validateScopes: actual.default.validateScopes,
      assertUserTokenScopes: actual.default.assertUserTokenScopes,
      resolveRequestedExpiry: actual.default.resolveRequestedExpiry,
      resolveRepositoryAccess: actual.default.resolveRepositoryAccess,
      parseTokenId: actual.default.parseTokenId,
      tokenKind: actual.default.tokenKind,
      tokenStatus: actual.default.tokenStatus,
      resolveRepositoryAllowlist: jest.fn(),
      issueUserToken: jest.fn(),
      listTokensByOwner: jest.fn(),
      revokeOwnedToken: jest.fn(),
    },
  };
});
jest.mock('server/services/globalConfig', () => {
  const getAllConfigs = jest.fn();
  return {
    __esModule: true,
    default: { getInstance: () => ({ getAllConfigs }) },
    __getConfig: getAllConfigs,
  };
});
jest.mock('server/services/apiAccessConfig', () => {
  const getApiKeysConfig = jest.fn();
  return {
    __esModule: true,
    default: { getInstance: () => ({ getApiKeysConfig }) },
    __getApiKeysConfig: getApiKeysConfig,
  };
});
jest.mock('server/lib/get-user', () => ({
  requireRequestUserIdentity: jest.fn(),
  getRequestUserIdentity: jest.fn(),
  getUser: jest.fn(),
}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { NextRequest } from 'next/server';
import ApiTokenService from 'server/services/apiToken';
import { requireRequestUserIdentity, getRequestUserIdentity } from 'server/lib/get-user';
import { GET as listMine, POST as issueMine } from 'src/app/api/v2/me/tokens/route';
import { DELETE as revokeMine } from 'src/app/api/v2/me/tokens/[id]/route';
import { GET as getPolicy } from 'src/app/api/v2/me/tokens/policy/route';

const mockGetConfig = (jest.requireMock('server/services/globalConfig') as any).__getConfig as jest.Mock;
const mockGetApiKeysConfig = (jest.requireMock('server/services/apiAccessConfig') as any)
  .__getApiKeysConfig as jest.Mock;
const mockRequireIdentity = requireRequestUserIdentity as jest.Mock;
const mockGetIdentity = getRequestUserIdentity as jest.Mock;
const mockResolveAllowlist = ApiTokenService.resolveRepositoryAllowlist as jest.Mock;
const mockIssueUserToken = ApiTokenService.issueUserToken as jest.Mock;
const mockListByOwner = ApiTokenService.listTokensByOwner as jest.Mock;
const mockRevokeOwned = ApiTokenService.revokeOwnedToken as jest.Mock;

const originalEnableAuth = process.env.ENABLE_AUTH;
const USER = { userId: 'sub-1', roles: ['user'], githubUsername: 'octo', email: 'a@corp.com', preferredUsername: 'a' };

const request = (method: string, body?: unknown, path = '/api/v2/me/tokens') =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const futureIso = (hoursAhead: number) => new Date(Date.now() + hoursAhead * 3_600_000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_AUTH = 'true';
  mockGetConfig.mockResolvedValue({ api_keys: { issuanceEnabled: true } });
  mockGetApiKeysConfig.mockResolvedValue({ issuanceEnabled: true, personalAuthEnabled: true });
  mockRequireIdentity.mockReturnValue(USER);
  mockGetIdentity.mockReturnValue(USER);
});

afterEach(() => {
  process.env.ENABLE_AUTH = originalEnableAuth;
});

const validBody = (over: Record<string, unknown> = {}) => ({
  name: 'ci',
  scopes: ['env:write'],
  expiresAt: futureIso(24),
  repositoryAccess: { mode: 'selected', repositories: ['org/repo'] },
  ...over,
});

describe('POST /api/v2/me/tokens', () => {
  it('403s when ENABLE_AUTH is off (no fail-open minting)', async () => {
    delete process.env.ENABLE_AUTH;
    const res = await issueMine(request('POST', validBody()));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('auth_required');
    expect(mockIssueUserToken).not.toHaveBeenCalled();
  });

  it('403s issuance with api_keys_disabled when issuance is off', async () => {
    mockGetConfig.mockResolvedValue({ api_keys: { issuanceEnabled: false } });
    const res = await issueMine(request('POST', validBody()));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('api_keys_disabled');
    expect(mockIssueUserToken).not.toHaveBeenCalled();
  });

  it('403s a role-less principal at the wrapper before the handler runs', async () => {
    mockRequireIdentity.mockReturnValue({ ...USER, roles: [] });
    mockGetIdentity.mockReturnValue({ ...USER, roles: [] });
    const res = await issueMine(request('POST', validBody()));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden_role');
    expect(mockIssueUserToken).not.toHaveBeenCalled();
  });

  it('403s a request for env:admin', async () => {
    const res = await issueMine(request('POST', validBody({ scopes: ['env:admin'] })));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden_scope');
  });

  it('400s when both ttlHours and expiresAt are provided', async () => {
    const res = await issueMine(request('POST', validBody({ ttlHours: 24 })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_expiry');
  });

  it("400s an unknown body field instead of silently minting (a typo'd expiry never becomes non-expiring)", async () => {
    const res = await issueMine(request('POST', validBody({ expiresAt: undefined, expiresInHours: 24 })));
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('invalid_body');
    expect(error.message).toContain('expiresInHours');
    expect(mockIssueUserToken).not.toHaveBeenCalled();
  });

  it('400s repositoryAccess extras: mode "all" with a repositories list never silently widens access', async () => {
    const res = await issueMine(
      request('POST', validBody({ repositoryAccess: { mode: 'all', repositories: ['org/repo'] } }))
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(mockIssueUserToken).not.toHaveBeenCalled();
  });

  it('accepts ttlHours instead of expiresAt (server-clock expiry)', async () => {
    mockResolveAllowlist.mockResolvedValue({ names: ['org/repo'], repoIds: [42] });
    mockIssueUserToken.mockResolvedValue({
      token: `lfc_${'a'.repeat(40)}`,
      record: { id: 9, name: 'ci', tokenPrefix: 'lfc_aaaaaaaa', scopes: ['env:write'], ownerUserId: 'sub-1' },
    });
    const res = await issueMine(request('POST', validBody({ expiresAt: undefined, ttlHours: 24 })));
    expect(res.status).toBe(201);
    const requested = mockIssueUserToken.mock.calls[0][0];
    const delta = new Date(requested.expiresAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(23 * 3_600_000);
    expect(delta).toBeLessThanOrEqual(24 * 3_600_000 + 1000);
  });

  it('accepts an omitted expiry as an explicit non-expiring Personal key', async () => {
    mockResolveAllowlist.mockResolvedValue({ names: ['org/repo'], repoIds: [42] });
    mockIssueUserToken.mockResolvedValue({
      token: `lfc_${'a'.repeat(40)}`,
      record: { id: 9, name: 'ci', tokenPrefix: 'lfc_aaaaaaaa', scopes: ['env:write'], ownerUserId: 'sub-1' },
    });
    const res = await issueMine(request('POST', validBody({ expiresAt: undefined })));
    expect(res.status).toBe(201);
    expect(mockIssueUserToken).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: null }));
  });

  it('rejects a TTL above the Personal-key ceiling', async () => {
    const over = await issueMine(request('POST', validBody({ expiresAt: undefined, ttlHours: 721 })));
    expect(over.status).toBe(400);
    expect((await over.json()).error.code).toBe('invalid_expiry');
    expect(mockIssueUserToken).not.toHaveBeenCalled();
  });

  it('accepts explicit all-repository access for Personal keys', async () => {
    mockIssueUserToken.mockResolvedValue({
      token: `lfc_${'a'.repeat(40)}`,
      record: {
        id: 9,
        name: 'ci',
        tokenPrefix: 'lfc_aaaaaaaa',
        scopes: ['env:write'],
        repositoryAllowlist: null,
        repositoryAllowlistRepoIds: null,
        ownerUserId: 'sub-1',
      },
    });
    const res = await issueMine(request('POST', validBody({ repositoryAccess: { mode: 'all' } })));
    expect(res.status).toBe(201);
    expect(mockResolveAllowlist).not.toHaveBeenCalled();
    expect(mockIssueUserToken).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryAllowlist: null, repositoryAllowlistRepoIds: null })
    );
  });

  it('400s the legacy repositoryAllowlist field and a missing repositoryAccess', async () => {
    const legacy = await issueMine(
      request('POST', validBody({ repositoryAccess: undefined, repositoryAllowlist: ['org/repo'] }))
    );
    expect(legacy.status).toBe(400);
    expect((await legacy.json()).error.code).toBe('invalid_body');

    const missing = await issueMine(request('POST', validBody({ repositoryAccess: undefined })));
    expect(missing.status).toBe(400);
    expect(mockIssueUserToken).not.toHaveBeenCalled();
  });

  it('mints an owner-stamped token, returns plaintext once with no-store headers', async () => {
    mockResolveAllowlist.mockResolvedValue({ names: ['org/repo'], repoIds: [42] });
    mockIssueUserToken.mockResolvedValue({
      token: `lfc_${'a'.repeat(40)}`,
      record: {
        id: 9,
        name: 'ci',
        tokenPrefix: 'lfc_aaaaaaaa',
        tokenHash: 'SECRET',
        kind: 'personal',
        scopes: ['env:write'],
        repositoryAllowlist: ['org/repo'],
        ownerGithubUsername: 'octo',
        ownerUserId: 'sub-1',
      },
    });

    const res = await issueMine(request('POST', validBody()));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(body.data.token).toBe(`lfc_${'a'.repeat(40)}`);
    expect(body.data.kind).toBe('personal');
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(mockIssueUserToken).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ['env:write'],
        repositoryAllowlistRepoIds: [42],
        owner: expect.objectContaining({ userId: 'sub-1', roleAtIssue: 'user', email: 'a@corp.com' }),
      })
    );
  });
});

describe('GET /api/v2/me/tokens', () => {
  it('lists only the caller’s tokens with derived kind/status', async () => {
    mockListByOwner.mockResolvedValue([
      {
        id: 1,
        name: 'ci',
        tokenHash: 'SECRET',
        kind: 'personal',
        ownerUserId: 'sub-1',
        revokedAt: null,
        expiresAt: null,
      },
    ]);
    const res = await listMine(request('GET'));
    expect(res.status).toBe(200);
    expect(mockListByOwner).toHaveBeenCalledWith('sub-1');
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ kind: 'personal', status: 'active' });
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it('remains available while key issuance is off (owners can always inspect existing keys)', async () => {
    mockGetConfig.mockResolvedValue({ api_keys: { issuanceEnabled: false } });
    mockListByOwner.mockResolvedValue([]);
    const res = await listMine(request('GET'));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v2/me/tokens/policy', () => {
  it('reports creation enabled for a user-role caller', async () => {
    const res = await getPolicy(request('GET', undefined, '/api/v2/me/tokens/policy'));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      enabled: true,
      issuanceEnabled: true,
      authenticationEnabled: true,
      canCreate: true,
      allowedScopes: ['env:read', 'env:write', 'sites:read', 'sites:write', 'repos:read', 'repos:write'],
      defaultTtlHours: 168,
      maxTtlHours: 720,
      allowNoExpiration: true,
      allowAllRepositories: true,
      repositoryAllowlistRequired: false,
    });
    expect(typeof data.serverTime).toBe('string');
    expect(data.enabled).toBe(data.issuanceEnabled);
  });

  it('reports canCreate=false when the flag is off or the caller is role-less', async () => {
    mockGetApiKeysConfig.mockResolvedValue({ issuanceEnabled: false, personalAuthEnabled: true });
    let res = await getPolicy(request('GET', undefined, '/api/v2/me/tokens/policy'));
    expect((await res.json()).data).toMatchObject({
      enabled: false,
      issuanceEnabled: false,
      authenticationEnabled: true,
      canCreate: false,
    });

    mockGetApiKeysConfig.mockResolvedValue({ issuanceEnabled: true, personalAuthEnabled: false });
    mockRequireIdentity.mockReturnValue({ ...USER, roles: [] });
    res = await getPolicy(request('GET', undefined, '/api/v2/me/tokens/policy'));
    const data = (await res.json()).data;
    expect(data).toMatchObject({
      enabled: true,
      issuanceEnabled: true,
      authenticationEnabled: false,
      canCreate: false,
    });
    expect(data.enabled).toBe(data.issuanceEnabled);
  });
});

describe('DELETE /api/v2/me/tokens/{id}', () => {
  const del = (id: string) =>
    revokeMine(new NextRequest(`http://localhost/api/v2/me/tokens/${id}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id }),
    });

  it('404s a token the caller does not own (no existence leak)', async () => {
    mockRevokeOwned.mockResolvedValue(null);
    const res = await del('5');
    expect(res.status).toBe(404);
    expect(mockRevokeOwned).toHaveBeenCalledWith(5, 'sub-1');
  });

  it('200s revoking an owned token', async () => {
    mockRevokeOwned.mockResolvedValue({ id: 5, revokedAt: 'now' });
    const res = await del('5');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: 5, revokedAt: 'now' });
  });

  it('remains available while key issuance is off (owners can always clean up)', async () => {
    mockGetConfig.mockResolvedValue({ api_keys: { issuanceEnabled: false } });
    mockRevokeOwned.mockResolvedValue({ id: 5, revokedAt: 'now' });
    const res = await del('5');
    expect(res.status).toBe(200);
  });

  it.each(['5abc', '-5', '0', '5.5'])('400s malformed id %p without touching the service', async (bad) => {
    const res = await del(bad as string);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_token_id');
    expect(mockRevokeOwned).not.toHaveBeenCalled();
  });
});
