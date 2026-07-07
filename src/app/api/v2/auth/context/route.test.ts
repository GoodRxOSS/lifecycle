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

import { NextRequest } from 'next/server';
import type { Principal } from 'server/lib/principal';

const mockResolvePrincipal = jest.fn();
const mockCheckApiKeyRateLimit = jest.fn();

jest.mock('server/lib/principal', () => ({
  __esModule: true,
  resolvePrincipal: (...args: unknown[]) => mockResolvePrincipal(...args),
}));

jest.mock('server/services/authRateLimit', () => ({
  __esModule: true,
  DEFAULT_RATE_LIMIT_PER_MINUTE: 600,
  checkApiKeyRateLimit: (...args: unknown[]) => mockCheckApiKeyRateLimit(...args),
}));

import { GET } from './route';

const SECRET_EMAIL = 'owner-secret@example.com';

const identityWithSecrets = {
  userId: 'kc-owner-1',
  githubUsername: 'octocat',
  preferredUsername: 'octo',
  email: SECRET_EMAIL,
  firstName: 'Octo',
  lastName: 'Cat',
  displayName: 'Octo Cat',
  gitUserName: 'Octo Cat',
  gitUserEmail: SECRET_EMAIL,
  roles: [],
};

function makeRequest() {
  return {
    headers: new Headers([['x-request-id', 'req-authctx']]),
    nextUrl: new URL('http://localhost/api/v2/auth/context'),
  } as unknown as NextRequest;
}

function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, out));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      collectKeys(child, out);
    }
  }
  return out;
}

const personalKeyPrincipal: Principal = {
  kind: 'personal_key',
  authMethod: 'api_key',
  userId: 'kc-owner-1',
  actor: 'kc-owner-1',
  roles: [],
  scopes: ['env:read', 'env:write'],
  tokenId: 42,
  repositoryAllowlist: ['example-org/api'],
  repositoryAllowlistRepoIds: [7, 9],
  identity: identityWithSecrets,
};

describe('GET /api/v2/auth/context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckApiKeyRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  });

  it('returns only non-secret context for a personal key and leaks no token, email, or identity', async () => {
    mockResolvePrincipal.mockResolvedValue(personalKeyPrincipal);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      principal: { kind: 'personal_key', id: 'kc-owner-1' },
      authMethod: 'api_key',
      scopes: ['env:read', 'env:write'],
      repositories: { mode: 'selected', repositoryIds: [7, 9], repositoryNames: ['example-org/api'] },
      tokenId: 42,
    });

    const keys = collectKeys(body);
    for (const forbidden of ['token', 'tokenHash', 'tokenPrefix', 'prefix', 'hash', 'email', 'identity']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    // tokenId is the metadata id, not the secret — it is allowed.
    expect(keys.has('tokenId')).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET_EMAIL);
  });

  it('is served no-store', async () => {
    mockResolvePrincipal.mockResolvedValue(personalKeyPrincipal);
    const response = await GET(makeRequest());
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('reports a service key as an ownerless actor with all-repositories access', async () => {
    mockResolvePrincipal.mockResolvedValue({
      kind: 'service_key',
      authMethod: 'api_key',
      userId: null,
      actor: 'token:ci-bot',
      roles: [],
      scopes: ['env:read'],
      tokenId: 7,
      repositoryAllowlist: null,
      repositoryAllowlistRepoIds: null,
      identity: null,
    } as Principal);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      principal: { kind: 'service_key', id: 'token:ci-bot' },
      authMethod: 'api_key',
      scopes: ['env:read'],
      repositories: { mode: 'all', repositoryIds: [], repositoryNames: [] },
      tokenId: 7,
    });
    expect(mockCheckApiKeyRateLimit).toHaveBeenCalledTimes(1);
  });

  it('reports a legacy name-only key as selected with its repository names', async () => {
    mockResolvePrincipal.mockResolvedValue({
      ...personalKeyPrincipal,
      repositoryAllowlist: ['example-org/legacy'],
      repositoryAllowlistRepoIds: null,
    });

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.repositories).toEqual({
      mode: 'selected',
      repositoryIds: [],
      repositoryNames: ['example-org/legacy'],
    });
  });

  it('reports an unscoped session without spending the key rate limit', async () => {
    mockResolvePrincipal.mockResolvedValue({
      kind: 'user',
      authMethod: 'session',
      userId: 'kc-user-9',
      actor: 'kc-user-9',
      roles: ['user'],
      scopes: null,
      tokenId: null,
      repositoryAllowlist: null,
      repositoryAllowlistRepoIds: null,
      identity: { ...identityWithSecrets, userId: 'kc-user-9', roles: ['user'] },
    } as Principal);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      principal: { kind: 'user', id: 'kc-user-9' },
      authMethod: 'session',
      scopes: null,
      repositories: { mode: 'all', repositoryIds: [], repositoryNames: [] },
      tokenId: null,
    });
    expect(mockCheckApiKeyRateLimit).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(SECRET_EMAIL);
  });
});
