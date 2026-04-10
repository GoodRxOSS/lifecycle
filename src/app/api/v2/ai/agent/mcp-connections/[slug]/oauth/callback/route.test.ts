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

jest.mock('server/services/ai/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    getBySlugAndScope: (...args: unknown[]) => mockGetBySlugAndScope(...args),
    discoverTools: (...args: unknown[]) => mockDiscoverTools(...args),
  })),
}));

jest.mock('server/services/userMcpConnection', () => ({
  __esModule: true,
  default: {
    getDecryptedConnection: (...args: unknown[]) => mockGetDecryptedConnection(...args),
    upsertConnection: (...args: unknown[]) => mockUpsertConnection(...args),
  },
}));

jest.mock('server/services/ai/mcp/oauthFlow', () => ({
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
import { buildMcpDefinitionFingerprint } from 'server/services/ai/mcp/connectionConfig';

function makeRequest(
  url = 'http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?code=sample-code&state=flow-123.sample-state'
) {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/agent/mcp-connections/[slug]/oauth/callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const connectorConfig = {
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
    } as const;
    const definitionFingerprint = buildMcpDefinitionFingerprint({
      preset: connectorConfig.preset,
      transport: connectorConfig.transport,
      sharedConfig: connectorConfig.sharedConfig,
      authConfig: connectorConfig.authConfig,
    });
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
        scope: 'sample.read',
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

  it('accepts legacy in-flight callbacks that still use the flow query parameter', async () => {
    const response = await GET(
      makeRequest(
        'http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?scope=global&flow=flow-123&code=sample-code&state=legacy-state'
      ),
      {
        params: Promise.resolve({ slug: 'sample-oauth' }),
      }
    );

    expect(response.status).toBe(200);
    expect(mockConsumeFlow).toHaveBeenCalledWith('flow-123');
    expect(mockAuth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        callbackState: 'legacy-state',
      })
    );
  });
});
