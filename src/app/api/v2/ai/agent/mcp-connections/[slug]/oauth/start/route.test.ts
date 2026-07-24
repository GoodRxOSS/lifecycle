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
const mockDiscoverTools = jest.fn();
const mockGetDecryptedConnection = jest.fn();
const mockUpsertConnection = jest.fn();
const mockGetRequestUserIdentity = jest.fn();
const mockCreateFlow = jest.fn();
const mockInvalidateFlow = jest.fn();

jest.mock('@ai-sdk/mcp', () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

jest.mock('server/services/agentRuntime/mcp/config', () => {
  const actual = jest.requireActual('server/services/agentRuntime/mcp/config');
  return {
    __esModule: true,
    ...actual,
    McpConfigService: jest.fn().mockImplementation(() => ({
      getBySlugAndScope: (...args: unknown[]) => mockGetBySlugAndScope(...args),
      discoverTools: (...args: unknown[]) => mockDiscoverTools(...args),
    })),
  };
});

jest.mock('server/services/userMcpConnection', () => ({
  __esModule: true,
  default: {
    getDecryptedConnection: (...args: unknown[]) => mockGetDecryptedConnection(...args),
    upsertConnection: (...args: unknown[]) => mockUpsertConnection(...args),
  },
}));

jest.mock('server/services/agentRuntime/mcp/oauthFlow', () => ({
  __esModule: true,
  default: {
    create: (...args: unknown[]) => mockCreateFlow(...args),
    invalidate: (...args: unknown[]) => mockInvalidateFlow(...args),
  },
}));

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
  // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
  requireRequestUserIdentity: (...args: unknown[]) => {
    const id = mockGetRequestUserIdentity(...args);
    if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return id;
  },
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
      roles: ['user'],
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
    mockDiscoverTools.mockResolvedValue([{ name: 'sampleTool', inputSchema: {} }]);
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

  it('re-discovers tools when a silent AUTHORIZED reconnect finds an empty tool set', async () => {
    mockAuth.mockResolvedValueOnce('AUTHORIZED');
    mockGetDecryptedConnection.mockResolvedValueOnce({
      state: {
        type: 'oauth',
        tokens: { access_token: 'sample-access-token', token_type: 'bearer' },
      },
      definitionFingerprint: 'sample-definition-fingerprint',
      stale: false,
      discoveredTools: [],
      validationError: 'MCP validation failed for sample-oauth: server returned 0 tools',
      validatedAt: null,
      updatedAt: null,
    });
    mockDiscoverTools.mockResolvedValueOnce([{ name: 'searchDocs', inputSchema: {} }]);

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ status: 'AUTHORIZED', authorizationUrl: null });
    expect(mockDiscoverTools).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.example.com/v1/mcp' }),
      30000
    );
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'sample-oauth',
        scope: 'global',
        discoveredTools: [{ name: 'searchDocs', inputSchema: {} }],
        validationError: null,
      })
    );
  });

  it('keeps the connection marked broken when re-discovery still returns 0 tools', async () => {
    mockAuth.mockResolvedValueOnce('AUTHORIZED');
    mockGetDecryptedConnection.mockResolvedValueOnce({
      state: {
        type: 'oauth',
        tokens: { access_token: 'sample-access-token', token_type: 'bearer' },
      },
      definitionFingerprint: 'sample-definition-fingerprint',
      stale: false,
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    });
    mockDiscoverTools.mockResolvedValueOnce([]);

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.message).toContain('server returned 0 tools');
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveredTools: [],
        validationError: expect.stringContaining('server returned 0 tools'),
      })
    );
  });

  it('skips re-discovery when the stored connection already has tools', async () => {
    mockAuth.mockResolvedValueOnce('AUTHORIZED');
    mockGetDecryptedConnection.mockResolvedValueOnce({
      state: {
        type: 'oauth',
        tokens: { access_token: 'sample-access-token', token_type: 'bearer' },
      },
      definitionFingerprint: 'sample-definition-fingerprint',
      stale: false,
      discoveredTools: [{ name: 'searchDocs', inputSchema: {} }],
      validationError: null,
      validatedAt: '2026-04-08T00:00:00.000Z',
      updatedAt: null,
    });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });

    expect(response.status).toBe(200);
    expect(mockDiscoverTools).not.toHaveBeenCalled();
    expect(mockUpsertConnection).not.toHaveBeenCalled();
  });

  it('redacts MCP secrets when OAuth authorization setup fails', async () => {
    mockGetBySlugAndScope.mockResolvedValueOnce({
      id: 7,
      slug: 'sample-oauth',
      scope: 'global',
      enabled: true,
      timeout: 30000,
      preset: 'oauth-http',
      transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp?api_key=query/secret+value', headers: {} },
      sharedConfig: {
        headers: { Authorization: 'Bearer shared-header-secret' },
      },
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
        scope: 'sample.read',
      },
    } as const);
    mockAuth.mockRejectedValueOnce(
      new Error(
        'OAuth start failed Authorization=Bearer shared-header-secret query=query/secret+value encoded=query%2Fsecret%2Bvalue'
      )
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(mockInvalidateFlow).toHaveBeenCalledWith('flow-123');
    expect(body.error.message).toBe('OAuth start failed Authorization=****** query=****** encoded=******');
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
          redirect_uris: ['https://old.example.test/oauth/callback'],
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
