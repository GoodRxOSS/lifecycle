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

const mockGetBySlugAndScope = jest.fn();
const mockDiscoverTools = jest.fn();
const mockUpsertConnection = jest.fn();
const mockDeleteConnection = jest.fn();
const mockGetMaskedState = jest.fn();
const mockGetRequestUserIdentity = jest.fn();

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
    upsertConnection: (...args: unknown[]) => mockUpsertConnection(...args),
    deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
    getMaskedState: (...args: unknown[]) => mockGetMaskedState(...args),
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

import { DELETE, PUT } from './route';
import { buildMcpDefinitionFingerprint } from 'server/services/agentRuntime/mcp/connectionConfig';
import type { McpAuthConfig, McpTransportConfig } from 'server/services/agentRuntime/mcp/types';

function makeRequest(
  body: unknown,
  url = 'http://localhost/api/v2/ai/agent/mcp-connections/sample-connector?scope=global'
) {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
    json: async () => body,
  } as unknown as NextRequest;
}

describe('MCP user connection route', () => {
  const connectorConfig: {
    id: number;
    slug: string;
    scope: string;
    enabled: boolean;
    timeout: number;
    transport: McpTransportConfig;
    sharedConfig: Record<string, never>;
    authConfig: McpAuthConfig;
  } = {
    id: 7,
    slug: 'sample-connector',
    scope: 'global',
    enabled: true,
    timeout: 30000,
    transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp', headers: {} },
    sharedConfig: {},
    authConfig: {
      mode: 'user-fields',
      schema: {
        fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' }],
        bindings: [{ target: 'header', key: 'Authorization', fieldKey: 'apiToken', format: 'bearer' }],
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      roles: ['user'],
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetBySlugAndScope.mockResolvedValue(connectorConfig);
    mockDiscoverTools.mockResolvedValue([{ name: 'inspectItem', inputSchema: {} }]);
    mockUpsertConnection.mockResolvedValue(undefined);
    mockDeleteConnection.mockResolvedValue(true);
    mockGetMaskedState.mockResolvedValue({
      slug: 'sample-connector',
      scope: 'global',
      authMode: 'fields',
      configured: true,
      stale: false,
      configuredFieldKeys: ['apiToken'],
      validatedAt: '2026-04-06T18:00:00.000Z',
      validationError: null,
      discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      updatedAt: '2026-04-06T18:00:00.000Z',
    });
  });

  it.each([
    ['PUT', PUT],
    ['DELETE', DELETE],
  ])('rejects unauthenticated %s requests before reading connection state', async (_method, handler) => {
    mockGetRequestUserIdentity.mockReturnValue(undefined);

    const response = await handler(makeRequest({ values: { apiToken: 'sample-token' } }), {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });

    expect(response.status).toBe(401);
    expect(mockGetBySlugAndScope).not.toHaveBeenCalled();
    expect(mockUpsertConnection).not.toHaveBeenCalled();
    expect(mockDeleteConnection).not.toHaveBeenCalled();
  });

  it('maps malformed JSON to an error without reading or changing the connection', async () => {
    const request = makeRequest(undefined);
    request.json = jest.fn().mockRejectedValue(new SyntaxError('Unexpected end of JSON input'));

    const response = await PUT(request, {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });

    expect(response.status).toBe(500);
    expect(mockGetBySlugAndScope).not.toHaveBeenCalled();
    expect(mockDiscoverTools).not.toHaveBeenCalled();
    expect(mockUpsertConnection).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['disabled', { ...connectorConfig, enabled: false }],
  ])('404s when the shared MCP definition is %s', async (_label, config) => {
    mockGetBySlugAndScope.mockResolvedValue(config);

    const response = await PUT(
      makeRequest(
        { values: { apiToken: 'sample-token' } },
        'http://localhost/api/v2/ai/agent/mcp-connections/sample-connector?scope=owner%2Frepo'
      ),
      { params: Promise.resolve({ slug: 'sample-connector' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      request_id: 'req-test',
      data: null,
      error: { message: "Enabled MCP connection 'sample-connector' not found in scope 'owner/repo'" },
    });
    expect(mockGetBySlugAndScope).toHaveBeenCalledWith('sample-connector', 'owner/repo');
    expect(mockDiscoverTools).not.toHaveBeenCalled();
    expect(mockUpsertConnection).not.toHaveBeenCalled();
  });

  it.each([
    [
      'OAuth',
      { mode: 'oauth', provider: 'generic-oauth2.1' },
      "MCP connection 'sample-connector' uses OAuth. Start the OAuth flow instead of saving raw values.",
    ],
    [
      'no per-user authentication',
      { mode: 'none' },
      "MCP connection 'sample-connector' does not accept per-user field configuration",
    ],
  ] as const)('rejects raw values when the shared definition uses %s', async (_label, authConfig, message) => {
    mockGetBySlugAndScope.mockResolvedValue({ ...connectorConfig, authConfig });

    const response = await PUT(makeRequest({ values: { apiToken: 'sample-token' } }), {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(message);
    expect(mockDiscoverTools).not.toHaveBeenCalled();
    expect(mockUpsertConnection).not.toHaveBeenCalled();
  });

  it('rejects a null body when the shared field schema requires a value', async () => {
    const response = await PUT(makeRequest(null), {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Missing required MCP connection field 'API token'");
    expect(mockDiscoverTools).not.toHaveBeenCalled();
    expect(mockUpsertConnection).not.toHaveBeenCalled();
  });

  it('stores a per-user connection with the current definition fingerprint and discovered tools', async () => {
    const response = await PUT(makeRequest({ values: { apiToken: 'sample-token' } }), {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockDiscoverTools).toHaveBeenCalledWith(
      {
        type: 'http',
        url: 'https://mcp.example.com/v1/mcp',
        headers: { Authorization: 'Bearer sample-token' },
      },
      30000
    );
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        scope: 'global',
        slug: 'sample-connector',
        state: { type: 'fields', values: { apiToken: 'sample-token' } },
        definitionFingerprint: buildMcpDefinitionFingerprint({
          preset: null,
          transport: connectorConfig.transport,
          sharedConfig: connectorConfig.sharedConfig,
          authConfig: connectorConfig.authConfig,
        }),
        discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
        validationError: null,
      })
    );
    expect(body.data).toEqual(
      expect.objectContaining({
        configured: true,
        stale: false,
        configuredFieldKeys: ['apiToken'],
      })
    );
  });

  it('stores validation errors on the user connection without mutating shared discovery', async () => {
    mockDiscoverTools.mockRejectedValue(
      new Error('HTTP 401 Unauthorized for Authorization Bearer invalid-token and token invalid-token')
    );

    const response = await PUT(makeRequest({ values: { apiToken: 'invalid-token' } }), {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveredTools: [],
        validationError: 'HTTP 401 Unauthorized for Authorization ****** and token ******',
      })
    );
    expect(body.error.message).toBe('HTTP 401 Unauthorized for Authorization ****** and token ******');
    expect(body.error.message).not.toContain('invalid-token');
  });

  it('stores a validation error when discovery returns no tools', async () => {
    mockDiscoverTools.mockResolvedValue([]);

    const response = await PUT(makeRequest({ values: { apiToken: 'sample-token' } }), {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.message).toBe('MCP validation failed for sample-connector: server returned 0 tools');
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { type: 'fields', values: { apiToken: 'sample-token' } },
        discoveredTools: [],
        validationError: 'MCP validation failed for sample-connector: server returned 0 tools',
      })
    );
    expect(mockGetMaskedState).not.toHaveBeenCalled();
  });

  it('uses an empty shared configuration when the definition omits one', async () => {
    mockGetBySlugAndScope.mockResolvedValue({ ...connectorConfig, sharedConfig: undefined });

    const response = await PUT(
      makeRequest(
        { values: { apiToken: 'sample-token' } },
        'http://localhost/api/v2/ai/agent/mcp-connections/sample-connector'
      ),
      { params: Promise.resolve({ slug: 'sample-connector' }) }
    );

    expect(response.status).toBe(200);
    expect(mockGetBySlugAndScope).toHaveBeenCalledWith('sample-connector', 'global');
    expect(mockDiscoverTools).toHaveBeenCalledWith(
      {
        type: 'http',
        url: 'https://mcp.example.com/v1/mcp',
        headers: { Authorization: 'Bearer sample-token' },
      },
      30000
    );
  });

  it('maps a masked-state lookup failure after saving the validated connection', async () => {
    mockGetMaskedState.mockRejectedValue(new Error('state unavailable'));

    const response = await PUT(makeRequest({ values: { apiToken: 'sample-token' } }), {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });

    expect(response.status).toBe(500);
    expect(mockUpsertConnection).toHaveBeenCalledWith(expect.objectContaining({ validationError: null }));
  });

  it('deletes the current user connection and returns the empty state', async () => {
    mockGetMaskedState.mockResolvedValueOnce({
      slug: 'sample-connector',
      scope: 'global',
      authMode: 'fields',
      configured: false,
      stale: false,
      configuredFieldKeys: [],
      validatedAt: null,
      validationError: null,
      discoveredTools: [],
      updatedAt: null,
    });

    const response = await DELETE(makeRequest(undefined), {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockDeleteConnection).toHaveBeenCalledWith('sample-user', 'global', 'sample-connector', 'sample-user');
    expect(body.data).toEqual(
      expect.objectContaining({
        configured: false,
        discoveredTools: [],
      })
    );
  });

  it('defaults delete scope to global and returns none auth state when the shared definition is absent', async () => {
    mockGetBySlugAndScope.mockResolvedValue(undefined);
    mockGetMaskedState.mockResolvedValue({
      slug: 'sample-connector',
      scope: 'global',
      authMode: 'none',
      configured: false,
      stale: false,
      configuredFieldKeys: [],
      validatedAt: null,
      validationError: null,
      discoveredTools: [],
      updatedAt: null,
    });

    const response = await DELETE(
      makeRequest(undefined, 'http://localhost/api/v2/ai/agent/mcp-connections/sample-connector'),
      { params: Promise.resolve({ slug: 'sample-connector' }) }
    );

    expect(response.status).toBe(200);
    expect(mockGetBySlugAndScope).toHaveBeenCalledWith('sample-connector', 'global');
    expect(mockDeleteConnection).toHaveBeenCalledWith('sample-user', 'global', 'sample-connector', 'sample-user');
    expect(mockGetMaskedState).toHaveBeenCalledWith(
      'sample-user',
      'global',
      'sample-connector',
      'sample-user',
      undefined,
      'none'
    );
  });

  it('does not read masked state when deleting the connection fails', async () => {
    mockDeleteConnection.mockRejectedValue(new Error('delete unavailable'));

    const response = await DELETE(makeRequest(undefined), {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });

    expect(response.status).toBe(500);
    expect(mockGetMaskedState).not.toHaveBeenCalled();
  });
});
