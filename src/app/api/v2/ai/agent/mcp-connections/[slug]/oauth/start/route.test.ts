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

const mockAuth = jest.fn();
const mockGetBySlugAndScope = jest.fn();
const mockGetDecryptedConnection = jest.fn();
const mockGetRequestUserIdentity = jest.fn();
const mockCreateFlow = jest.fn();
const mockInvalidateFlow = jest.fn();

jest.mock('@ai-sdk/mcp', () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

jest.mock('server/services/ai/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    getBySlugAndScope: (...args: unknown[]) => mockGetBySlugAndScope(...args),
  })),
}));

jest.mock('server/services/userMcpConnection', () => ({
  __esModule: true,
  default: {
    getDecryptedConnection: (...args: unknown[]) => mockGetDecryptedConnection(...args),
    upsertConnection: jest.fn(),
  },
}));

jest.mock('server/services/ai/mcp/oauthFlow', () => ({
  __esModule: true,
  default: {
    create: (...args: unknown[]) => mockCreateFlow(...args),
    invalidate: (...args: unknown[]) => mockInvalidateFlow(...args),
  },
}));

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { POST } from './route';

function makeRequest(
  url = 'http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/start?scope=global',
  origin = 'https://app.example.com'
) {
  return {
    headers: new Headers([
      ['x-request-id', 'req-test'],
      ['origin', origin],
    ]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('POST /api/v2/ai/agent/mcp-connections/[slug]/oauth/start', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetBySlugAndScope.mockResolvedValue({
      id: 7,
      slug: 'sample-oauth',
      scope: 'global',
      enabled: true,
      timeout: 30000,
      preset: 'oauth-http',
      transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp', headers: {} },
      sharedConfig: {},
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
        scope: 'sample.read',
      },
    } as const);
    mockGetDecryptedConnection.mockResolvedValue(null);
    mockCreateFlow.mockResolvedValue({
      flowId: 'flow-123',
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      slug: 'sample-oauth',
      scope: 'global',
      definitionFingerprint: 'sample-definition-fingerprint',
      appOrigin: 'https://app.example.com',
      createdAt: '2026-04-08T00:00:00.000Z',
    });
    mockInvalidateFlow.mockResolvedValue(undefined);
    mockAuth.mockImplementation(async (provider: { redirectToAuthorization: (url: URL) => Promise<void> }) => {
      await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
      return 'REDIRECT';
    });
  });

  it('starts OAuth using the AI SDK auth helper and returns the authorization URL', async () => {
    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();
    const provider = mockAuth.mock.calls[0]?.[0] as {
      redirectUrl: string;
      state: () => Promise<string>;
    };

    expect(response.status).toBe(200);
    expect(mockAuth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl: 'https://mcp.example.com/v1/mcp',
        scope: 'sample.read',
      })
    );
    expect(body.data).toEqual({
      status: 'REDIRECT',
      authorizationUrl: 'https://auth.example.com/authorize',
    });
    expect(mockCreateFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        slug: 'sample-oauth',
        scope: 'global',
        appOrigin: 'https://app.example.com',
      })
    );
    expect(provider.redirectUrl).toBe(
      'http://localhost:5001/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback'
    );
    await expect(provider.state()).resolves.toMatch(/^flow-123\./);
    expect(mockInvalidateFlow).not.toHaveBeenCalled();
  });

  it('invalidates the unused flow when authorization completes without redirecting', async () => {
    mockAuth.mockResolvedValueOnce('AUTHORIZED');

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      status: 'AUTHORIZED',
      authorizationUrl: null,
    });
    expect(mockInvalidateFlow).toHaveBeenCalledWith('flow-123');
  });

  it('drops stale saved client metadata when the persisted redirect URI no longer matches', async () => {
    mockGetDecryptedConnection.mockResolvedValueOnce({
      state: {
        type: 'oauth',
        tokens: {
          access_token: 'sample-access-token',
          token_type: 'bearer',
        },
        clientInformation: {
          client_id: 'sample-client',
          redirect_uris: [
            'http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?scope=global&flow=old-flow',
          ],
        },
        codeVerifier: 'stale-verifier',
        oauthState: 'old-flow.sample-state',
      },
      definitionFingerprint: 'sample-definition-fingerprint',
      stale: false,
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    });

    await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });

    const provider = mockAuth.mock.calls[0]?.[0] as {
      currentState: Record<string, unknown>;
    };

    expect(provider.currentState).toEqual({
      type: 'oauth',
      tokens: {
        access_token: 'sample-access-token',
        token_type: 'bearer',
      },
    });
  });
});
