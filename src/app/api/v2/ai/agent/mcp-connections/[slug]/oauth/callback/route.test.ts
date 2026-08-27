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
const mockConsumeFlow = jest.fn();

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
  extractMcpOAuthFlowId: (state: string | null | undefined) => {
    if (!state) {
      return null;
    }

    const separatorIndex = state.indexOf('.');
    return separatorIndex > 0 ? state.slice(0, separatorIndex) : null;
  },
  default: {
    consume: (...args: unknown[]) => mockConsumeFlow(...args),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { GET } from './route';
import { buildMcpDefinitionFingerprint } from 'server/services/agentRuntime/mcp/connectionConfig';

function makeRequest(
  url = 'http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?code=sample-code&state=flow-123.sample-state'
) {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

function makeConnectorConfig(overrides: Record<string, unknown> = {}) {
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
      scope: 'sample.read',
    },
    ...overrides,
  };
}

function definitionFingerprintFor(config: ReturnType<typeof makeConnectorConfig>): string {
  return buildMcpDefinitionFingerprint({
    preset: config.preset as string,
    transport: config.transport as never,
    sharedConfig: config.sharedConfig as never,
    authConfig: config.authConfig as never,
  });
}

describe('GET /api/v2/ai/agent/mcp-connections/[slug]/oauth/callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const connectorConfig = makeConnectorConfig();
    const definitionFingerprint = definitionFingerprintFor(connectorConfig);
    mockGetBySlugAndScope.mockResolvedValue(connectorConfig);
    mockConsumeFlow.mockResolvedValue({
      flowId: 'flow-123',
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      slug: 'sample-oauth',
      scope: 'global',
      definitionFingerprint,
      appOrigin: 'https://app.example.com',
      createdAt: '2026-04-08T00:00:00.000Z',
    });
    mockGetDecryptedConnection.mockResolvedValue({
      state: {
        type: 'oauth',
        codeVerifier: 'sample-code-verifier',
        oauthState: 'flow-123.sample-state',
      },
      definitionFingerprint,
      stale: false,
      discoveredTools: [{ name: 'existingTool', inputSchema: {} }],
      validationError: null,
      validatedAt: '2026-04-07T00:00:00.000Z',
      updatedAt: '2026-04-07T00:00:00.000Z',
    });
    mockDiscoverTools.mockResolvedValue([{ name: 'inspectItem', inputSchema: {} }]);
    mockAuth.mockImplementation(async (provider: { saveTokens: (tokens: any) => Promise<void> }) => {
      await provider.saveTokens({
        access_token: 'sample-access-token',
        token_type: 'bearer',
      });
      return 'AUTHORIZED';
    });
  });

  it('completes OAuth, discovers tools, and stores the per-user oauth connection state', async () => {
    const response = await GET(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(mockAuth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl: 'https://mcp.example.com/v1/mcp',
        authorizationCode: 'sample-code',
        callbackState: 'flow-123.sample-state',
      })
    );
    expect(mockDiscoverTools).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'http',
        url: 'https://mcp.example.com/v1/mcp',
      }),
      30000
    );
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'sample-oauth',
        scope: 'global',
        discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
        validationError: null,
      })
    );
    const persistedState = mockUpsertConnection.mock.calls[mockUpsertConnection.mock.calls.length - 1]?.[0]?.state;
    expect(persistedState).toMatchObject({
      type: 'oauth',
      tokens: expect.objectContaining({
        access_token: 'sample-access-token',
      }),
    });
    expect(persistedState).not.toHaveProperty('codeVerifier');
    expect(persistedState).not.toHaveProperty('oauthState');
    expect(html).toContain('Connection complete');
    expect(html).toContain('lfc-mcp-oauth-complete');
    expect(html).toContain('https://app.example.com');
  });

  it('redacts OAuth and token secrets from failed discovery output', async () => {
    mockDiscoverTools.mockRejectedValueOnce(
      new Error(
        'Discovery failed for code sample-code token sample-access-token state flow-123.sample-state verifier sample-code-verifier'
      )
    );

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const html = await response.text();
    const persisted = mockUpsertConnection.mock.calls[mockUpsertConnection.mock.calls.length - 1]?.[0];

    expect(response.status).toBe(422);
    expect(persisted).toEqual(
      expect.objectContaining({
        slug: 'sample-oauth',
        scope: 'global',
        discoveredTools: [],
        validationError: 'Discovery failed for code ****** token ****** state ****** verifier ******',
      })
    );
    expect(html).toContain('Discovery failed for code ****** token ****** state ****** verifier ******');
    expect(html).not.toContain('sample-code');
    expect(html).not.toContain('sample-access-token');
    expect(html).not.toContain('flow-123.sample-state');
    expect(html).not.toContain('sample-code-verifier');
  });

  it('treats OAuth discovery that returns 0 tools as a failed connection', async () => {
    mockDiscoverTools.mockResolvedValueOnce([]);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const html = await response.text();
    const persisted = mockUpsertConnection.mock.calls[mockUpsertConnection.mock.calls.length - 1]?.[0];

    expect(response.status).toBe(422);
    expect(persisted).toEqual(
      expect.objectContaining({
        slug: 'sample-oauth',
        scope: 'global',
        discoveredTools: [],
        validationError: 'MCP validation failed for sample-oauth: server returned 0 tools',
      })
    );
    expect(html).toContain('Connection failed');
  });

  it('rejects expired or reused flows before completing OAuth', async () => {
    mockConsumeFlow.mockResolvedValueOnce(null);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const html = await response.text();

    expect(response.status).toBe(410);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockUpsertConnection).not.toHaveBeenCalled();
    expect(html).toContain('Connection expired');
  });

  it('rejects callbacks that do not match the original MCP request', async () => {
    const response = await GET(
      makeRequest(
        'http://localhost/api/v2/ai/agent/mcp-connections/other-oauth/oauth/callback?code=sample-code&state=flow-123.sample-state'
      ),
      {
        params: Promise.resolve({ slug: 'other-oauth' }),
      }
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'sample-oauth',
        scope: 'global',
        validationError: 'Connection callback did not match the original MCP request.',
      })
    );
    const persistedState = mockUpsertConnection.mock.calls[mockUpsertConnection.mock.calls.length - 1]?.[0]?.state;
    expect(persistedState).not.toHaveProperty('codeVerifier');
    expect(persistedState).not.toHaveProperty('oauthState');
    expect(html).toContain('Connection failed');
  });

  it('clears pending verifier and state when OAuth completion fails', async () => {
    mockAuth.mockRejectedValueOnce(new Error('OAuth exchange failed'));

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'sample-oauth',
        scope: 'global',
        validationError: 'OAuth exchange failed',
      })
    );
    const persistedState = mockUpsertConnection.mock.calls[mockUpsertConnection.mock.calls.length - 1]?.[0]?.state;
    expect(persistedState).toMatchObject({
      type: 'oauth',
    });
    expect(persistedState).not.toHaveProperty('codeVerifier');
    expect(persistedState).not.toHaveProperty('oauthState');
    expect(html).toContain('OAuth exchange failed');
  });

  it('rejects callbacks that do not carry the flow id in OAuth state', async () => {
    const response = await GET(
      makeRequest(
        'http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?code=sample-code&state=legacy-state'
      ),
      {
        params: Promise.resolve({ slug: 'sample-oauth' }),
      }
    );

    expect(response.status).toBe(410);
    expect(mockConsumeFlow).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('rejects callbacks with no OAuth state', async () => {
    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?code=sample-code'),
      { params: Promise.resolve({ slug: 'sample-oauth' }) }
    );

    expect(response.status).toBe(410);
    expect(mockConsumeFlow).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing', config: null },
    { label: 'disabled', config: makeConnectorConfig({ enabled: false }) },
  ])('rejects a callback when its MCP definition is $label', async ({ config }) => {
    mockGetBySlugAndScope.mockResolvedValueOnce(config);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const html = await response.text();

    expect(response.status).toBe(404);
    expect(html).toContain('Enabled MCP connection &#39;sample-oauth&#39; was not found.');
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ validationError: "Enabled MCP connection 'sample-oauth' was not found." })
    );
  });

  it('rejects a callback when the MCP definition no longer uses OAuth', async () => {
    mockGetBySlugAndScope.mockResolvedValueOnce(
      makeConnectorConfig({ authConfig: { mode: 'api_key', header: 'authorization' } })
    );

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain('does not use OAuth');
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ validationError: "MCP connection 'sample-oauth' does not use OAuth." })
    );
  });

  it('rejects an OAuth callback for a stdio transport before token exchange', async () => {
    mockGetBySlugAndScope.mockResolvedValueOnce(
      makeConnectorConfig({ transport: { type: 'stdio', command: 'sample-mcp', args: [] } })
    );

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain('must use HTTP or SSE transport');
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('expires a callback when the MCP definition changed during authorization', async () => {
    mockConsumeFlow.mockResolvedValueOnce({
      flowId: 'flow-123',
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      slug: 'sample-oauth',
      scope: 'global',
      definitionFingerprint: 'stale-definition-fingerprint',
      appOrigin: 'https://app.example.com',
      createdAt: '2026-04-08T00:00:00.000Z',
    });

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ slug: 'sample-oauth' }),
    });
    const html = await response.text();

    expect(response.status).toBe(409);
    expect(html).toContain('This MCP changed while sign-in was in progress.');
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        definitionFingerprint: 'stale-definition-fingerprint',
        validationError: 'This MCP changed while sign-in was in progress. Start the connection again.',
      })
    );
  });

  it('persists a provider-declared OAuth error and safely escapes it in the callback page', async () => {
    mockGetDecryptedConnection.mockResolvedValue({
      state: {
        type: 'oauth',
        codeVerifier: 'sample-code-verifier',
        oauthState: 'flow-123.sample-state',
      },
      definitionFingerprint: 'sample-definition-fingerprint',
      stale: false,
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    });
    const oauthError = encodeURIComponent('<script>&"\'');

    const response = await GET(
      makeRequest(
        `http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?error=${oauthError}&state=flow-123.sample-state`
      ),
      { params: Promise.resolve({ slug: 'sample-oauth' }) }
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain('OAuth provider returned: &lt;script&gt;&amp;&quot;&#39;');
    expect(html).toContain('OAuth provider returned: \\u003cscript>&\\"\'');
    expect(html).not.toContain('OAuth provider returned: <script>');
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        validationError: 'OAuth provider returned: <script>&"\'',
        validatedAt: expect.any(String),
      })
    );
  });

  it('rejects a callback without an authorization code', async () => {
    const response = await GET(
      makeRequest(
        'http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?state=flow-123.sample-state'
      ),
      { params: Promise.resolve({ slug: 'sample-oauth' }) }
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain('Missing OAuth authorization code.');
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ validationError: 'Missing OAuth authorization code.' })
    );
  });

  it('does not create a connection row while clearing a failure when no OAuth state exists', async () => {
    mockGetDecryptedConnection.mockResolvedValueOnce(null);

    const response = await GET(
      makeRequest(
        'http://localhost/api/v2/ai/agent/mcp-connections/other-oauth/oauth/callback?code=sample-code&state=flow-123.sample-state'
      ),
      { params: Promise.resolve({ slug: 'other-oauth' }) }
    );

    expect(response.status).toBe(400);
    expect(mockUpsertConnection).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('supports SSE OAuth definitions with no saved connection state or shared config', async () => {
    const connectorConfig = makeConnectorConfig({
      preset: 'oauth-sse',
      transport: { type: 'sse', url: 'https://mcp.example.com/v1/events', headers: {} },
      sharedConfig: undefined,
    });
    const definitionFingerprint = definitionFingerprintFor(connectorConfig);
    mockGetBySlugAndScope.mockResolvedValueOnce(connectorConfig);
    mockConsumeFlow.mockResolvedValueOnce({
      flowId: 'flow-123',
      userId: 'sample-user',
      ownerGithubUsername: null,
      slug: 'sample-oauth',
      scope: 'global',
      definitionFingerprint,
      appOrigin: 'https://app.example.com',
      createdAt: '2026-04-08T00:00:00.000Z',
    });
    mockGetDecryptedConnection.mockResolvedValueOnce(null);

    const response = await GET(
      makeRequest(
        'http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?code=sample-code&state=flow-123.sample-state'
      ),
      { params: Promise.resolve({ slug: 'sample-oauth' }) }
    );

    expect(response.status).toBe(200);
    expect(mockAuth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ serverUrl: 'https://mcp.example.com/v1/events' })
    );
    expect(mockDiscoverTools).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sse', url: 'https://mcp.example.com/v1/events' }),
      30000
    );
  });
});
