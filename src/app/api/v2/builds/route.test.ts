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
const mockGetAllBuilds = jest.fn();

jest.mock('server/lib/principal', () => ({
  __esModule: true,
  resolvePrincipal: (...args: unknown[]) => mockResolvePrincipal(...args),
}));

jest.mock('server/services/authRateLimit', () => ({
  __esModule: true,
  DEFAULT_RATE_LIMIT_PER_MINUTE: 600,
  checkApiKeyRateLimit: (...args: unknown[]) => mockCheckApiKeyRateLimit(...args),
}));

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getAllBuilds: (...args: unknown[]) => mockGetAllBuilds(...args),
  })),
}));

import { GET } from './route';

const scopedKeyPrincipal: Principal = {
  kind: 'service_key',
  authMethod: 'api_key',
  userId: null,
  actor: 'token:ci',
  roles: [],
  scopes: ['env:read'],
  tokenId: 7,
  repositoryAllowlist: ['org/repo'],
  repositoryAllowlistRepoIds: [42],
  identity: null,
};

const sessionPrincipal: Principal = {
  kind: 'user',
  authMethod: 'session',
  userId: 'kc-user-1',
  actor: 'kc-user-1',
  roles: ['user'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: {
    userId: 'kc-user-1',
    githubUsername: 'octocat',
    preferredUsername: 'octo',
    email: 'octo@example.com',
    firstName: null,
    lastName: null,
    displayName: 'Octo',
    gitUserName: 'Octo',
    gitUserEmail: 'octo@example.com',
    roles: [],
  },
};

const request = (url = 'http://localhost/api/v2/builds') => new NextRequest(url, { method: 'GET' });

describe('GET /api/v2/builds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckApiKeyRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mockGetAllBuilds.mockResolvedValue({ data: [], paginationMetadata: { page: 1 } });
  });

  it('threads the key repository allowlist into the listing query', async () => {
    mockResolvePrincipal.mockResolvedValue(scopedKeyPrincipal);

    const res = await GET(request('http://localhost/api/v2/builds?exclude=torn_down&search=foo'));

    expect(res.status).toBe(200);
    expect(mockGetAllBuilds).toHaveBeenCalledWith('torn_down', '', 'foo', expect.any(Object), ['org/repo'], [42]);
  });

  it('leaves session listings unscoped', async () => {
    mockResolvePrincipal.mockResolvedValue(sessionPrincipal);

    const res = await GET(request('http://localhost/api/v2/builds?my_envs=true'));

    expect(res.status).toBe(200);
    expect(mockGetAllBuilds).toHaveBeenCalledWith('', 'octocat', undefined, expect.any(Object), null, null);
  });
});
