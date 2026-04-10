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

jest.mock('server/services/ai/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    getBySlugAndScope: (...args: unknown[]) => mockGetBySlugAndScope(...args),
    discoverTools: (...args: unknown[]) => mockDiscoverTools(...args),
  })),
}));

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
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { DELETE, PUT } from './route';
import { buildMcpDefinitionFingerprint } from 'server/services/ai/mcp/connectionConfig';
import type { McpAuthConfig, McpTransportConfig } from 'server/services/ai/mcp/types';

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
    mockDiscoverTools.mockRejectedValue(new Error('HTTP 401 Unauthorized'));

    const response = await PUT(makeRequest({ values: { apiToken: 'invalid-token' } }), {
      params: Promise.resolve({ slug: 'sample-connector' }),
    });

    expect(response.status).toBe(422);
    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveredTools: [],
        validationError: 'HTTP 401 Unauthorized',
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'HTTP 401 Unauthorized' },
    });
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
});
