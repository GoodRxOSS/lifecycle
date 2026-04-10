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

jest.mock('server/services/aiAgentConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getEffectiveConfig: jest.fn().mockResolvedValue({
        providers: [
          { name: 'anthropic', enabled: true },
          { name: 'openai', enabled: true },
          { name: 'gemini', enabled: false },
        ],
      }),
    })),
  },
}));

jest.mock('server/services/userApiKey', () => ({
  __esModule: true,
  default: {
    getMaskedKey: jest.fn(async (_userId: string, provider: string) =>
      provider === 'anthropic' ? { provider, maskedKey: 'sk-ant...1234', updatedAt: '2026-04-05T12:00:00.000Z' } : null
    ),
  },
}));

const mockListEnabledConnectionsForUser = jest.fn();

jest.mock('server/services/ai/mcp/config', () => ({
  __esModule: true,
  McpConfigService: jest.fn().mockImplementation(() => ({
    listEnabledConnectionsForUser: (...args: unknown[]) => mockListEnabledConnectionsForUser(...args),
  })),
}));

import AgentSettingsService from 'server/services/agent/SettingsService';

describe('AgentSettingsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListEnabledConnectionsForUser.mockResolvedValue([
      {
        slug: 'sample-connector',
        name: 'Sample connector',
        description: 'Tools for the connected platform',
        scope: 'example-org/example-repo',
        preset: 'api-token-header',
        transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
        sharedConfig: {},
        authConfig: {
          mode: 'user-fields',
          schema: {
            fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' }],
            bindings: [{ target: 'header', key: 'Authorization', fieldKey: 'apiToken', format: 'bearer' }],
          },
        },
        connectionRequired: true,
        configured: true,
        stale: false,
        configuredFieldKeys: ['apiToken'],
        validationError: null,
        validatedAt: '2026-04-05T12:30:00.000Z',
        updatedAt: '2026-04-05T12:30:00.000Z',
        discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
        sharedDiscoveredTools: [],
      },
    ]);
  });

  it('returns provider states and per-user MCP connection state for the current user', async () => {
    const result = await AgentSettingsService.getSettingsSnapshot(
      {
        userId: 'sample-user',
        githubUsername: 'sample-user',
        preferredUsername: 'sample-user',
        email: 'sample-user@example.com',
        firstName: 'Sample',
        lastName: 'User',
        displayName: 'Sample User',
        gitUserName: 'Sample User',
        gitUserEmail: 'sample-user@example.com',
      },
      'example-org/example-repo'
    );

    expect(result).toEqual({
      providers: [
        {
          provider: 'anthropic',
          hasKey: true,
          maskedKey: 'sk-ant...1234',
          updatedAt: '2026-04-05T12:00:00.000Z',
        },
        {
          provider: 'openai',
          hasKey: false,
        },
      ],
      mcpConnections: [
        expect.objectContaining({
          slug: 'sample-connector',
          configured: true,
          configuredFieldKeys: ['apiToken'],
        }),
      ],
    });
  });
});
