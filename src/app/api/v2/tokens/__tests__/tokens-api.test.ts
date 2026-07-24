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
      assertServiceTokenScopes: actual.default.assertServiceTokenScopes.bind(actual.default),
      resolveRequestedExpiry: actual.default.resolveRequestedExpiry,
      resolveRepositoryAccess: actual.default.resolveRepositoryAccess,
      parseTokenId: actual.default.parseTokenId,
      tokenKind: actual.default.tokenKind,
      tokenStatus: actual.default.tokenStatus,
      resolveRepositoryAllowlist: jest.fn(),
      issueToken: jest.fn(),
      listTokens: jest.fn(),
      listTokensPaginated: jest.fn(),
      revokeToken: jest.fn(),
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
jest.mock('server/lib/get-user', () => {
  const getUser = jest.fn();
  const toIdentity = (req: unknown) => {
    const payload = getUser(req) as { sub?: string; realm_access?: { roles?: string[] } } | null;
    return payload ? { userId: payload.sub, roles: payload.realm_access?.roles ?? [] } : null;
  };
  return {
    __esModule: true,
    getUser,
    getRequestUserIdentity: jest.fn(toIdentity),
    requireRequestUserIdentity: jest.fn(toIdentity),
  };
});
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { NextRequest } from 'next/server';
import ApiTokenService from 'server/services/apiToken';
import { BadRequestError } from 'server/lib/appError';
import { getUser } from 'server/lib/get-user';
import { GET as listTokens, POST as issueToken } from 'src/app/api/v2/tokens/route';
import { DELETE as revokeToken } from 'src/app/api/v2/tokens/[id]/route';

const mockGetConfig = (jest.requireMock('server/services/globalConfig') as any).__getConfig as jest.Mock;
const mockGetUser = getUser as jest.Mock;
const mockIssueToken = ApiTokenService.issueToken as jest.Mock;
const mockListTokens = ApiTokenService.listTokens as jest.Mock;
const mockListTokensPaginated = ApiTokenService.listTokensPaginated as jest.Mock;
const mockRevokeToken = ApiTokenService.revokeToken as jest.Mock;
const mockResolveAllowlist = ApiTokenService.resolveRepositoryAllowlist as jest.Mock;

const originalEnableAuth = process.env.ENABLE_AUTH;

const request = (method: string, body?: unknown, query = '') =>
  new NextRequest(`http://localhost/api/v2/tokens${query}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const validCreate = (over: Record<string, unknown> = {}) => ({
  name: 'ci',
  scopes: ['env:write'],
  repositoryAccess: { mode: 'selected', repositories: ['org/repo'] },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ sub: 'admin-1', realm_access: { roles: ['admin'] } });
  mockGetConfig.mockResolvedValue({ api_keys: { issuanceEnabled: true } });
});

afterEach(() => {
  process.env.ENABLE_AUTH = originalEnableAuth;
  jest.clearAllMocks();
});

describe('token management is admin-only', () => {
  beforeEach(() => {
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'user-1', realm_access: { roles: ['user'] } });
  });

  it('403s GET for non-admin users', async () => {
    const res = await listTokens(request('GET'));

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('Forbidden: insufficient permissions');
    expect(mockListTokens).not.toHaveBeenCalled();
  });

  it('403s POST for non-admin users without minting', async () => {
    const res = await issueToken(request('POST', validCreate()));

    expect(res.status).toBe(403);
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('403s DELETE for non-admin users without revoking', async () => {
    const res = await revokeToken(request('DELETE'), { params: Promise.resolve({ id: '5' }) });

    expect(res.status).toBe(403);
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });

  it('401s when no user identity is present', async () => {
    mockGetUser.mockReturnValue(null);

    const res = await listTokens(request('GET'));

    expect(res.status).toBe(401);
    expect(mockListTokens).not.toHaveBeenCalled();
  });
});

describe('token management refuses the ENABLE_AUTH fail-open', () => {
  beforeEach(() => {
    delete process.env.ENABLE_AUTH;
  });

  it('403s POST with auth_required and never mints a token, even with a spoofed x-user admin', async () => {
    const req = new NextRequest('http://localhost/api/v2/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'spoofed' },
      body: JSON.stringify(validCreate()),
    });

    const res = await issueToken(req);

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('auth_required');
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('403s GET and DELETE with auth_required', async () => {
    const listRes = await listTokens(request('GET'));
    expect(listRes.status).toBe(403);
    expect(mockListTokens).not.toHaveBeenCalled();

    const delRes = await revokeToken(request('DELETE'), { params: Promise.resolve({ id: '5' }) });
    expect(delRes.status).toBe(403);
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });
});

describe('service key issuance with ENABLE_AUTH=true', () => {
  beforeEach(() => {
    process.env.ENABLE_AUTH = 'true';
  });

  it('403s issuance with api_keys_disabled while issuance is off', async () => {
    mockGetConfig.mockResolvedValue({ api_keys: { issuanceEnabled: false } });
    const res = await issueToken(request('POST', validCreate()));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('api_keys_disabled');
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('400s a missing or non-JSON body instead of 500ing', async () => {
    const req = new NextRequest('http://localhost/api/v2/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{',
    });
    const res = await issueToken(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it("400s an unknown body field instead of silently minting (a typo'd expiry never becomes non-expiring)", async () => {
    const res = await issueToken(request('POST', validCreate({ expiresInHours: 24 })));
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('invalid_body');
    expect(error.message).toContain('expiresInHours');
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('requires explicit repositoryAccess and rejects the legacy repositoryAllowlist field', async () => {
    const missing = await issueToken(request('POST', validCreate({ repositoryAccess: undefined })));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('invalid_body');

    const legacy = await issueToken(
      request('POST', { name: 'ci', scopes: ['env:write'], repositoryAllowlist: ['org/repo'] })
    );
    expect(legacy.status).toBe(400);
    expect((await legacy.json()).error.code).toBe('invalid_body');

    mockResolveAllowlist.mockRejectedValueOnce(
      new BadRequestError('repositoryAllowlist must be a non-empty array of repositories.', 'invalid_allowlist')
    );
    const emptySelected = await issueToken(
      request('POST', validCreate({ repositoryAccess: { mode: 'selected', repositories: [] } }))
    );
    expect(emptySelected.status).toBe(400);
    expect((await emptySelected.json()).error.code).toBe('invalid_allowlist');
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('rejects env:admin on new service keys', async () => {
    const res = await issueToken(request('POST', validCreate({ scopes: ['env:admin'] })));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden_scope');
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('issues a selected-mode key with normalized, id-bound repositories and no-store headers', async () => {
    mockResolveAllowlist.mockResolvedValue({ names: ['org/repo'], repoIds: [42] });
    mockIssueToken.mockResolvedValue({
      token: `lfc_${'a'.repeat(40)}`,
      record: {
        id: 1,
        name: 'ci',
        tokenPrefix: 'lfc_aaaaaaaa',
        tokenHash: 'SECRET_HASH',
        kind: 'service',
        scopes: ['env:write'],
        repositoryAllowlist: ['org/repo'],
        repositoryAllowlistRepoIds: [42],
        ownerUserId: null,
        createdBy: 'admin-1',
        revokedAt: null,
        expiresAt: null,
      },
    });

    const res = await issueToken(request('POST', validCreate()));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(body.data.token).toBe(`lfc_${'a'.repeat(40)}`);
    expect(body.data.kind).toBe('service');
    expect(body.data.status).toBe('active');
    expect(JSON.stringify(body)).not.toContain('SECRET_HASH');
    expect(mockResolveAllowlist).toHaveBeenCalledWith(['org/repo']);
    expect(mockIssueToken).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ci',
        scopes: ['env:write'],
        repositoryAllowlist: ['org/repo'],
        repositoryAllowlistRepoIds: [42],
        expiresAt: null,
        createdBy: 'admin-1',
      })
    );
  });

  it('issues an all-repositories key with a null allowlist (explicit mode only)', async () => {
    mockIssueToken.mockResolvedValue({
      token: `lfc_${'b'.repeat(40)}`,
      record: { id: 2, name: 'ci', tokenPrefix: 'lfc_bbbbbbbb', scopes: ['env:read'], ownerUserId: null },
    });
    const res = await issueToken(
      request('POST', validCreate({ repositoryAccess: { mode: 'all' }, scopes: ['env:read'] }))
    );
    expect(res.status).toBe(201);
    expect(mockResolveAllowlist).not.toHaveBeenCalled();
    expect(mockIssueToken).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryAllowlist: null, repositoryAllowlistRepoIds: null })
    );
  });

  it('accepts ttlHours for a finite expiry', async () => {
    mockResolveAllowlist.mockResolvedValue({ names: ['org/repo'], repoIds: [42] });
    mockIssueToken.mockResolvedValue({
      token: `lfc_${'c'.repeat(40)}`,
      record: { id: 3, name: 'ci', tokenPrefix: 'lfc_cccccccc', scopes: ['env:write'], ownerUserId: null },
    });
    const res = await issueToken(request('POST', validCreate({ ttlHours: 24 })));
    expect(res.status).toBe(201);
    const { expiresAt } = mockIssueToken.mock.calls[0][0];
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('token listing and revocation with ENABLE_AUTH=true', () => {
  beforeEach(() => {
    process.env.ENABLE_AUTH = 'true';
  });

  it('remains available while key issuance is off (oversight is never dark)', async () => {
    mockGetConfig.mockResolvedValue({ api_keys: { issuanceEnabled: false } });
    mockListTokens.mockResolvedValue([]);
    const res = await listTokens(request('GET'));
    expect(res.status).toBe(200);

    mockRevokeToken.mockResolvedValue({ id: 5, revokedAt: 'now' });
    const del = await revokeToken(request('DELETE'), { params: Promise.resolve({ id: '5' }) });
    expect(del.status).toBe(200);
  });

  it('serializes owner metadata and derived kind/status, never tokenHash', async () => {
    mockListTokens.mockResolvedValue([
      {
        id: 1,
        name: 'ci',
        tokenPrefix: 'lfc_aaaaaaaa',
        tokenHash: 'SECRET_HASH',
        kind: 'personal',
        scopes: ['env:read'],
        repositoryAllowlist: null,
        ownerUserId: 'sub-9',
        ownerEmail: 'a@corp.com',
        ownerPreferredUsername: 'alice',
        ownerRoleAtIssue: 'user',
        createdBy: 'sub-9',
        revokedBy: null,
        revokedAt: null,
        expiresAt: null,
      },
    ]);

    const res = await listTokens(request('GET'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0]).toMatchObject({
      kind: 'personal',
      status: 'active',
      ownerEmail: 'a@corp.com',
      ownerPreferredUsername: 'alice',
      createdBy: 'sub-9',
    });
    expect(JSON.stringify(body)).not.toContain('SECRET_HASH');
  });

  it('passes kind/status/search filters through and 400s invalid values', async () => {
    mockListTokens.mockResolvedValue([]);
    await listTokens(request('GET', undefined, '?kind=service&status=active&search=ci'));
    expect(mockListTokens).toHaveBeenCalledWith({ kind: 'service', status: 'active', search: 'ci' });

    const bad = await listTokens(request('GET', undefined, '?kind=bogus'));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('invalid_query');
  });

  it('returns pagination metadata when page/limit are provided', async () => {
    mockListTokensPaginated.mockResolvedValue({
      data: [],
      metadata: { current: 1, total: 0, items: 0, limit: 10 },
    });
    const res = await listTokens(request('GET', undefined, '?page=1&limit=10'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.metadata.pagination).toEqual({ current: 1, total: 0, items: 0, limit: 10 });
    expect(mockListTokensPaginated).toHaveBeenCalledWith(
      { kind: null, status: null, search: null },
      expect.objectContaining({ page: 1, limit: 10 })
    );
  });

  it.each(['?page=1abc', '?page=0', '?page=-1', '?limit=0', '?limit=101', '?limit=2.5'])(
    '400s invalid pagination %p without querying tokens',
    async (query) => {
      const res = await listTokens(request('GET', undefined, query));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_query');
      expect(mockListTokensPaginated).not.toHaveBeenCalled();
      expect(mockListTokens).not.toHaveBeenCalled();
    }
  );

  it('revokes a token by id recording the revoking admin, and 404s an unknown id', async () => {
    mockRevokeToken.mockResolvedValueOnce({ id: 5, revokedAt: 'now' });
    const ok = await revokeToken(request('DELETE'), { params: Promise.resolve({ id: '5' }) });
    expect(ok.status).toBe(200);
    expect(mockRevokeToken).toHaveBeenCalledWith(5, 'admin-1');

    mockRevokeToken.mockResolvedValueOnce(null);
    const missing = await revokeToken(request('DELETE'), { params: Promise.resolve({ id: '9' }) });
    expect(missing.status).toBe(404);
  });

  it.each(['5abc', '-5', '0', '5.5'])('400s malformed id %p without touching the service', async (bad) => {
    const res = await revokeToken(request('DELETE'), { params: Promise.resolve({ id: bad as string }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_token_id');
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });
});
