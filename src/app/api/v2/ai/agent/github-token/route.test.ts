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

jest.mock('server/lib/get-user', () => ({
  getUser: jest.fn(),
  getRequestUserIdentity: jest.fn(),
}));

jest.mock('server/lib/agentSession/githubToken', () => ({
  fetchGitHubAuthenticatedUser: jest.fn(),
  resolveRequestGitHubUserToken: jest.fn(),
}));

import { fetchGitHubAuthenticatedUser, resolveRequestGitHubUserToken } from 'server/lib/agentSession/githubToken';
import { getRequestUserIdentity, getUser } from 'server/lib/get-user';
import { GET } from './route';

const mockGetUser = getUser as jest.Mock;
const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockResolveRequestGitHubUserToken = resolveRequestGitHubUserToken as jest.Mock;
const mockFetchGitHubAuthenticatedUser = fetchGitHubAuthenticatedUser as jest.Mock;

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/github-token'),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/agent/github-token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockReturnValue({
      sub: 'user-123',
      realm_access: {
        roles: ['admin'],
      },
    });
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'user-123',
      githubUsername: 'sample-user',
    });
  });

  it('returns 401 when no user is available', async () => {
    mockGetUser.mockReturnValue(null);
    mockGetRequestUserIdentity.mockReturnValue(null);

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when the user is not an admin', async () => {
    mockGetUser.mockReturnValue({
      sub: 'user-123',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockResolveRequestGitHubUserToken).not.toHaveBeenCalled();
    expect(mockFetchGitHubAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('returns a safe failed check when no GitHub token can be fetched', async () => {
    mockResolveRequestGitHubUserToken.mockResolvedValue({
      githubUsername: 'sample-user',
      githubToken: null,
    });

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      keycloakGithubUsername: 'sample-user',
      tokenFetched: false,
      tokenUsable: false,
      githubUserId: null,
      githubLogin: null,
      matchesKeycloakUsername: null,
      githubStatus: null,
      scopes: [],
      rateLimitRemaining: null,
    });
    expect(mockFetchGitHubAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('probes GitHub and reports a usable token without returning the token', async () => {
    mockResolveRequestGitHubUserToken.mockResolvedValue({
      githubUsername: 'sample-user',
      githubToken: 'gho_secret_token',
    });
    mockFetchGitHubAuthenticatedUser.mockResolvedValue({
      ok: true,
      id: 12_345,
      login: 'sample-user',
      status: 200,
      scopes: ['read:user'],
      rateLimitRemaining: '57',
    });

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFetchGitHubAuthenticatedUser).toHaveBeenCalledWith('gho_secret_token');
    expect(JSON.stringify(body)).not.toContain('gho_secret_token');
    expect(body.data).toEqual({
      keycloakGithubUsername: 'sample-user',
      tokenFetched: true,
      tokenUsable: true,
      githubUserId: 12_345,
      githubLogin: 'sample-user',
      matchesKeycloakUsername: true,
      githubStatus: 200,
      scopes: ['read:user'],
      rateLimitRemaining: '57',
    });
  });
});
