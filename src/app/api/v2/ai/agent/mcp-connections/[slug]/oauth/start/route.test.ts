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
const mockDiscoverOAuthProtectedResourceMetadata = jest.fn();
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

jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverOAuthProtectedResourceMetadata: (...args: unknown[]) => mockDiscoverOAuthProtectedResourceMetadata(...args),
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
  origin: string | null = 'https://app.example.com',
  referer?: string
) {
  const headers = new Headers([['x-request-id', 'req-test']]);
  if (origin !== null) {
    headers.set('origin', origin);
  }
  if (referer !== undefined) {
    headers.set('referer', referer);
  }
  return {
    headers,
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

function makeOAuthConfig(overrides: Record<string, unknown> = {}) {
  return {
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
    },
    ...overrides,
  };
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
      },
    } as const);
    mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValue({
      resource: 'https://mcp.example.com/v1/mcp',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['sample.read'],
    });
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
      'http://127.0.0.1:5001/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback'
    );
    await expect(provider.state()).resolves.toMatch(/^flow-123\./);
    expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith('https://mcp.example.com/v1/mcp');
    expect(mockInvalidateFlow).not.toHaveBeenCalled();
  });

  it('derives OAuth scopes from the MCP server instead of administrator overrides', async () => {
    mockGetBySlugAndScope.mockResolvedValueOnce({
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
      },
    } as const);
    mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
      resource: 'https://mcp.example.com/v1/mcp',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['sample.read', 'offline_access'],
    });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });

    expect(response.status).toBe(200);
    expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith('https://mcp.example.com/v1/mcp');
    const provider = mockAuth.mock.calls[0]?.[0] as {
      clientMetadata: { scope?: string };
    };
    expect(provider.clientMetadata.scope).toBe('sample.read offline_access');
    expect(mockAuth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl: 'https://mcp.example.com/v1/mcp',
        scope: 'sample.read offline_access',
      })
    );
  });

  it('fails before authorization when protected-resource metadata identifies a different resource', async () => {
    mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
      resource: 'https://mcp.example.com/',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['sample.read'],
    });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });

    expect(response.status).toBe(422);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockCreateFlow).not.toHaveBeenCalled();
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
    mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
      resource: 'https://mcp.example.com/v1/mcp?api_key=query/secret+value',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['sample.read'],
    });

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

  it('reuses a locally registered portless client instead of triggering needless registration', async () => {
    const registeredRedirectUri = 'http://127.0.0.1/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback';
    const clientInformation = {
      client_id: 'sample-client',
      redirect_uris: [registeredRedirectUri],
    };
    mockGetDecryptedConnection.mockResolvedValueOnce({
      state: {
        type: 'oauth',
        clientInformation,
      },
      definitionFingerprint: 'sample-definition-fingerprint',
      stale: false,
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    });
    mockAuth.mockImplementationOnce(
      async (provider: {
        clientInformation: () => Promise<typeof clientInformation | undefined>;
        redirectToAuthorization: (url: URL) => Promise<void>;
      }) => {
        await expect(provider.clientInformation()).resolves.toEqual(clientInformation);
        await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
        return 'REDIRECT';
      }
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const provider = mockAuth.mock.calls[0]?.[0] as {
      currentState: Record<string, unknown>;
      clientMetadata: { redirect_uris: string[] };
    };

    expect(response.status).toBe(200);
    expect(provider.currentState).toEqual({
      type: 'oauth',
      clientInformation,
    });
    expect(provider.clientMetadata.redirect_uris).toEqual([registeredRedirectUri]);
  });

  it('requires authentication before looking up the MCP definition', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });

    expect(response.status).toBe(401);
    expect(mockGetBySlugAndScope).not.toHaveBeenCalled();
    expect(mockCreateFlow).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing', config: null },
    { label: 'disabled', config: makeOAuthConfig({ enabled: false }) },
  ])('returns 404 when the MCP definition is $label', async ({ config }) => {
    mockGetBySlugAndScope.mockResolvedValueOnce(config);

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe("Enabled MCP connection 'sample-oauth' not found in scope 'global'");
    expect(mockGetDecryptedConnection).not.toHaveBeenCalled();
    expect(mockCreateFlow).not.toHaveBeenCalled();
  });

  it('rejects an MCP definition that does not use OAuth', async () => {
    mockGetBySlugAndScope.mockResolvedValueOnce(
      makeOAuthConfig({ authConfig: { mode: 'api_key', header: 'authorization' } })
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe("MCP connection 'sample-oauth' does not use OAuth");
    expect(mockGetDecryptedConnection).not.toHaveBeenCalled();
    expect(mockCreateFlow).not.toHaveBeenCalled();
  });

  it('rejects a stdio OAuth definition before metadata discovery', async () => {
    mockGetBySlugAndScope.mockResolvedValueOnce(
      makeOAuthConfig({ transport: { type: 'stdio', command: 'sample-mcp', args: [] } })
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe("OAuth MCP connection 'sample-oauth' must use an HTTP or SSE transport");
    expect(mockDiscoverOAuthProtectedResourceMetadata).not.toHaveBeenCalled();
    expect(mockCreateFlow).not.toHaveBeenCalled();
  });

  it('drops incompatible saved client metadata when no access token can be preserved', async () => {
    mockGetDecryptedConnection.mockResolvedValueOnce({
      state: {
        type: 'oauth',
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

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const provider = mockAuth.mock.calls[0]?.[0] as { currentState: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(provider.currentState).toEqual({ type: 'oauth' });
  });

  it.each([
    {
      label: 'an invalid origin',
      request: () => makeRequest(undefined, 'not a URL'),
      expectedOrigin: null,
    },
    {
      label: 'no origin or referer',
      request: () => makeRequest(undefined, null),
      expectedOrigin: null,
    },
    {
      label: 'a valid referer when origin is absent',
      request: () => makeRequest(undefined, null, 'https://referer.example.com/path?q=1'),
      expectedOrigin: 'https://referer.example.com',
    },
    {
      label: 'an invalid referer when origin is absent',
      request: () => makeRequest(undefined, null, 'not a URL'),
      expectedOrigin: null,
    },
  ])('records $label as the callback app origin', async ({ request, expectedOrigin }) => {
    const response = await POST(request(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });

    expect(response.status).toBe(200);
    expect(mockCreateFlow).toHaveBeenCalledWith(expect.objectContaining({ appOrigin: expectedOrigin }));
  });

  it('defaults an omitted scope query parameter to global', async () => {
    const response = await POST(
      makeRequest('http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/start'),
      { params: Promise.resolve({ slug: 'sample-oauth' }) }
    );

    expect(response.status).toBe(200);
    expect(mockGetBySlugAndScope).toHaveBeenCalledWith('sample-oauth', 'global');
    expect(mockCreateFlow).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global' }));
  });

  it.each([
    {
      label: 'an empty authorization-server list',
      metadata: {
        resource: 'https://mcp.example.com/v1/mcp',
        authorization_servers: [],
        scopes_supported: ['sample.read'],
      },
    },
    {
      label: 'no authorization-server field',
      metadata: {
        resource: 'https://mcp.example.com/v1/mcp',
        scopes_supported: ['sample.read'],
      },
    },
  ])('rejects protected-resource metadata with $label', async ({ metadata }) => {
    mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce(metadata);

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.message).toContain('does not advertise an authorization server');
    expect(mockCreateFlow).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('allows protected-resource metadata to omit advertised scopes', async () => {
    mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
      resource: 'https://mcp.example.com/v1/mcp',
      authorization_servers: ['https://auth.example.com'],
    });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });

    expect(response.status).toBe(200);
    expect(mockAuth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ serverUrl: 'https://mcp.example.com/v1/mcp', scope: undefined })
    );
  });

  it('normalizes a non-Error metadata-discovery failure', async () => {
    mockDiscoverOAuthProtectedResourceMetadata.mockRejectedValueOnce({ reason: 'network unavailable' });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.message).toContain('invalid protected-resource metadata');
    expect(mockCreateFlow).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('supports OAuth metadata discovery for SSE MCP definitions', async () => {
    mockGetBySlugAndScope.mockResolvedValueOnce(
      makeOAuthConfig({
        preset: 'oauth-sse',
        transport: { type: 'sse', url: 'https://mcp.example.com/v1/events', headers: {} },
        sharedConfig: undefined,
      })
    );
    mockDiscoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
      resource: 'https://mcp.example.com/v1/events',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['sample.read'],
    });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });

    expect(response.status).toBe(200);
    expect(mockDiscoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith('https://mcp.example.com/v1/events');
    expect(mockAuth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ serverUrl: 'https://mcp.example.com/v1/events' })
    );
  });

  it('stores a sanitized validation error when silent reconnect tool discovery rejects', async () => {
    mockAuth.mockResolvedValueOnce('AUTHORIZED');
    mockGetDecryptedConnection.mockResolvedValueOnce({
      state: {
        type: 'oauth',
        tokens: { access_token: 'sample-access-token', token_type: 'bearer' },
        codeVerifier: 'sample-verifier',
        oauthState: 'flow-123.sample-state',
      },
      definitionFingerprint: 'sample-definition-fingerprint',
      stale: false,
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    });
    mockDiscoverTools.mockRejectedValueOnce(
      new Error('Discovery failed token sample-access-token verifier sample-verifier state flow-123.sample-state')
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.message).toBe('Discovery failed token ****** verifier ****** state ******');
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveredTools: [],
        validationError: 'Discovery failed token ****** verifier ****** state ******',
      })
    );
  });
});
