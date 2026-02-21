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
import { fetchGitHubBrokerToken, resolveRequestGitHubToken } from '../githubToken';

const mockGetGithubClientToken = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    warn: jest.fn(),
  }),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getGithubClientToken: mockGetGithubClientToken,
    }),
  },
}));

describe('githubToken', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;
  const originalIssuer = process.env.KEYCLOAK_ISSUER;
  const originalInternalIssuer = process.env.KEYCLOAK_ISSUER_INTERNAL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KEYCLOAK_ISSUER = 'https://keycloak.example.com/realms/test';
    delete process.env.KEYCLOAK_ISSUER_INTERNAL;
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env.ENABLE_AUTH = originalEnableAuth;
    process.env.KEYCLOAK_ISSUER = originalIssuer;
    process.env.KEYCLOAK_ISSUER_INTERNAL = originalInternalIssuer;
    global.fetch = originalFetch;
  });

  it('returns the cached GitHub app token when auth is disabled', async () => {
    process.env.ENABLE_AUTH = 'false';
    mockGetGithubClientToken.mockResolvedValue('ghs_cached_app_token');

    const token = await resolveRequestGitHubToken(new NextRequest('http://localhost/api'));

    expect(mockGetGithubClientToken).toHaveBeenCalledTimes(1);
    expect(token).toBe('ghs_cached_app_token');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns null when auth is disabled and cached GitHub app token lookup fails', async () => {
    process.env.ENABLE_AUTH = 'false';
    mockGetGithubClientToken.mockRejectedValue(new Error('cache unavailable'));

    const token = await resolveRequestGitHubToken(new NextRequest('http://localhost/api'));

    expect(mockGetGithubClientToken).toHaveBeenCalledTimes(1);
    expect(token).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches broker token from Keycloak when auth is enabled', async () => {
    process.env.ENABLE_AUTH = 'true';
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({ access_token: 'gho_broker_token' })),
    });

    const token = await resolveRequestGitHubToken(
      new NextRequest('http://localhost/api', {
        headers: {
          authorization: 'Bearer keycloak-access-token',
        },
      })
    );

    expect(global.fetch).toHaveBeenCalledWith('https://keycloak.example.com/realms/test/broker/github/token', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer keycloak-access-token',
      },
    });
    expect(token).toBe('gho_broker_token');
  });

  it('prefers the internal issuer when it is configured', async () => {
    process.env.ENABLE_AUTH = 'true';
    process.env.KEYCLOAK_ISSUER_INTERNAL = 'http://keycloak.internal/realms/test';
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({ access_token: 'gho_internal_token' })),
    });

    const token = await resolveRequestGitHubToken(
      new NextRequest('http://localhost/api', {
        headers: {
          authorization: 'Bearer keycloak-access-token',
        },
      })
    );

    expect(global.fetch).toHaveBeenCalledWith('http://keycloak.internal/realms/test/broker/github/token', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer keycloak-access-token',
      },
    });
    expect(token).toBe('gho_internal_token');
  });

  it('parses query string token responses from Keycloak', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('access_token=gho_query_token&expires_in=300'),
    });

    await expect(fetchGitHubBrokerToken('keycloak-access-token')).resolves.toBe('gho_query_token');
  });

  it('returns null when auth is enabled but no bearer token is present', async () => {
    process.env.ENABLE_AUTH = 'true';

    await expect(resolveRequestGitHubToken(new NextRequest('http://localhost/api'))).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
