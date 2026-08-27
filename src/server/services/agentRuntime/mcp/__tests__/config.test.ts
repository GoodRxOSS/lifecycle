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

const mockConnect = jest.fn();
const mockListTools = jest.fn();
const mockClose = jest.fn();
const mockListMaskedStatesByScopes = jest.fn();
const mockListDecryptedConnectionsByScopes = jest.fn();
const mockUpsertConnection = jest.fn();

jest.mock('../client', () => ({
  McpClientManager: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    close: mockClose,
  })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('server/services/userMcpConnection', () => ({
  __esModule: true,
  default: {
    listMaskedStatesByScopes: (...args: unknown[]) => mockListMaskedStatesByScopes(...args),
    listDecryptedConnectionsByScopes: (...args: unknown[]) => mockListDecryptedConnectionsByScopes(...args),
    upsertConnection: (...args: unknown[]) => mockUpsertConnection(...args),
  },
}));

jest.mock('server/models/McpServerConfig', () => {
  const mockModel: any = {
    query: jest.fn(),
    softDelete: jest.fn(),
  };
  return { __esModule: true, default: mockModel };
});

import McpServerConfig from 'server/models/McpServerConfig';
import type { RequestUserIdentity } from 'server/lib/get-user';
import {
  McpConfigService,
  redactMcpConfigSecrets,
  redactSharedConfigSecrets,
  sanitizeMcpErrorMessage,
  sanitizeMcpResult,
} from '../config';
import type { McpServerConfigRecord } from '../types';

const MockModel = McpServerConfig as any;

function makeQueryResult(firstResult?: unknown) {
  const first = jest.fn().mockResolvedValue(firstResult);
  const whereNull = jest.fn().mockReturnValue({ first });
  const where = jest.fn().mockReturnValue({ whereNull });
  const insert = jest.fn();
  const patchAndFetchById = jest.fn();

  MockModel.query.mockReturnValue({
    where,
    insert,
    patchAndFetchById,
  });

  return {
    where,
    whereNull,
    first,
    insert,
    patchAndFetchById,
  };
}

const SHARED_TOOL = { name: 'sharedTool', inputSchema: {} };
const USER_TOOL = { name: 'userTool', inputSchema: {} };
const USER_IDENTITY: RequestUserIdentity = {
  userId: 'sample-user',
  githubUsername: 'sample-user',
  preferredUsername: 'sample-user',
  email: 'sample-user@example.com',
  firstName: 'Sample',
  lastName: 'User',
  displayName: 'Sample User',
  gitUserName: 'Sample User',
  gitUserEmail: 'sample-user@example.com',
  roles: ['user'],
};

function configRecord(overrides: Partial<McpServerConfigRecord> = {}): McpServerConfigRecord {
  return {
    id: 1,
    slug: 'sample-connector',
    name: 'Sample connector',
    description: 'Connector description',
    scope: 'global',
    preset: null,
    transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp', headers: {} },
    sharedConfig: {},
    authConfig: { mode: 'none' },
    enabled: true,
    timeout: 30000,
    sharedDiscoveredTools: [SHARED_TOOL],
    createdAt: '2026-04-06T15:00:00.000Z',
    updatedAt: '2026-04-06T16:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function queueListQuery(result: McpServerConfigRecord[]) {
  const whereNull = jest.fn().mockResolvedValue(result);
  const where = jest.fn().mockReturnValue({ whereNull });
  MockModel.query.mockReturnValueOnce({ where });
  return { where, whereNull };
}

function queueFindQuery(result?: McpServerConfigRecord) {
  const first = jest.fn().mockResolvedValue(result);
  const whereNull = jest.fn().mockReturnValue({ first });
  const where = jest.fn().mockReturnValue({ whereNull });
  MockModel.query.mockReturnValueOnce({ where });
  return { where, whereNull, first };
}

describe('McpConfigService', () => {
  let service: McpConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    MockModel.query.mockReset();
    MockModel.softDelete.mockReset();
    mockConnect.mockReset();
    mockListTools.mockReset();
    mockClose.mockReset();
    mockListMaskedStatesByScopes.mockReset();
    mockListDecryptedConnectionsByScopes.mockReset();
    mockUpsertConnection.mockReset();
    service = new McpConfigService();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue([{ name: 'inspectItem', inputSchema: {} }]);
    mockClose.mockResolvedValue(undefined);
    mockListMaskedStatesByScopes.mockResolvedValue(new Map());
    mockListDecryptedConnectionsByScopes.mockResolvedValue(new Map());
  });

  describe('redactSharedConfigSecrets', () => {
    it('redacts all shared config value sections before returning config records', () => {
      const result = redactSharedConfigSecrets({
        sharedConfig: {
          headers: { Authorization: 'Bearer sample-token' },
          query: { api_key: 'sample-query-token' },
          env: { SAMPLE_API_TOKEN: 'sample-env-token' },
          defaultArgs: { token: 'sample-arg-token' },
        },
      });

      expect(result.sharedConfig).toEqual({
        headers: { Authorization: '******' },
        query: { api_key: '******' },
        env: { SAMPLE_API_TOKEN: '******' },
        defaultArgs: { token: '******' },
      });
    });
  });

  describe('redactMcpConfigSecrets', () => {
    it('redacts HTTP transport headers before returning config records', () => {
      const result = redactMcpConfigSecrets({
        transport: {
          type: 'http',
          url: 'https://mcp.example.com/v1/mcp?api_key=sample-query-token&workspace=sample-workspace',
          headers: { Authorization: 'Bearer sample-token' },
        },
      });

      expect(result.transport).toEqual({
        type: 'http',
        url: 'https://mcp.example.com/v1/mcp?api_key=******&workspace=******',
        headers: { Authorization: '******' },
      });
    });

    it('redacts stdio transport env before returning config records', () => {
      const result = redactMcpConfigSecrets({
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'sample-mcp-server'],
          env: { SAMPLE_API_TOKEN: 'sample-token' },
        },
      });

      expect(result.transport).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'sample-mcp-server'],
        env: { SAMPLE_API_TOKEN: '******' },
      });
    });
  });

  describe('public secret-hygiene exports', () => {
    it('keeps the config-module sanitizer aliases behaviorally available', () => {
      expect(sanitizeMcpErrorMessage(new Error('safe message'))).toBe('safe message');
      expect(sanitizeMcpResult({ status: 'safe' })).toEqual({ status: 'safe' });
    });
  });

  describe('create', () => {
    it('creates a shared connector definition with transport and shared discovered tools', async () => {
      const { insert } = makeQueryResult(undefined);
      const inserted = { id: 1, slug: 'sample-connector' };
      insert.mockResolvedValue(inserted);

      const result = await service.create({
        slug: 'sample-connector',
        name: 'Sample connector',
        scope: 'global',
        transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
      });

      expect(result).toEqual(inserted);
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'sample-connector',
          transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp', headers: {} },
          sharedDiscoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
        })
      );
    });

    it('redacts shared secrets from shared discovery validation errors', async () => {
      makeQueryResult(undefined);
      mockConnect.mockRejectedValueOnce(
        new Error(
          'connect failed Authorization=Bearer header-secret query=query/secret+value encoded=query%2Fsecret%2Bvalue env=env-secret arg=arg-secret'
        )
      );

      await expect(
        service.create({
          slug: 'sample-connector',
          name: 'Sample connector',
          scope: 'global',
          transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
          sharedConfig: {
            headers: { Authorization: 'Bearer header-secret' },
            query: { api_key: 'query/secret+value' },
            env: { SAMPLE_API_TOKEN: 'env-secret' },
            defaultArgs: { token: 'arg-secret' },
          },
        })
      ).rejects.toThrow(
        'MCP server connectivity validation failed: connect failed Authorization=****** query=****** encoded=****** env=****** arg=******'
      );
    });

    it('defers shared discovery for connectors that require user configuration', async () => {
      const { insert } = makeQueryResult(undefined);
      const inserted = { id: 1, slug: 'sample-connector' };
      insert.mockResolvedValue(inserted);
      mockConnect.mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'));

      await service.create({
        slug: 'sample-connector',
        name: 'Sample connector',
        scope: 'global',
        transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
        authConfig: {
          mode: 'user-fields',
          schema: {
            fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' }],
            bindings: [{ target: 'header', key: 'Authorization', fieldKey: 'apiToken', format: 'bearer' }],
          },
        },
      });

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          sharedDiscoveredTools: [],
        })
      );
    });

    it('does not persist shared discovered tools for user-auth connectors even when anonymous discovery succeeds', async () => {
      const { insert } = makeQueryResult(undefined);
      const inserted = { id: 1, slug: 'sample-connector' };
      insert.mockResolvedValue(inserted);
      mockListTools.mockResolvedValue([{ name: 'anonymousTool', inputSchema: {} }]);

      await service.create({
        slug: 'sample-connector',
        name: 'Sample connector',
        scope: 'global',
        transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
        authConfig: {
          mode: 'user-fields',
          schema: {
            fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' }],
            bindings: [{ target: 'header', key: 'Authorization', fieldKey: 'apiToken', format: 'bearer' }],
          },
        },
      });

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          sharedDiscoveredTools: [],
        })
      );
    });
  });

  describe('resolveServersForRepo', () => {
    it('uses per-user discovered tools for connectors that require a user connection', async () => {
      const globalConfig = {
        slug: 'sample-connector',
        name: 'Sample connector',
        scope: 'global',
        transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp', headers: {} },
        sharedConfig: {},
        authConfig: {
          mode: 'user-fields',
          schema: {
            fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' }],
            bindings: [{ target: 'header', key: 'Authorization', fieldKey: 'apiToken', format: 'bearer' }],
          },
        },
        timeout: 30000,
        sharedDiscoveredTools: [{ name: 'sharedTool', inputSchema: {} }],
      };

      MockModel.query
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([globalConfig]),
          }),
        })
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([]),
          }),
        });

      mockListDecryptedConnectionsByScopes.mockResolvedValue(
        new Map([
          [
            'global:sample-connector',
            {
              state: {
                type: 'fields',
                values: { apiToken: 'sample-token' },
              },
              discoveredTools: [{ name: 'userTool', inputSchema: {} }],
              validationError: null,
              validatedAt: '2026-04-06T16:00:00.000Z',
              updatedAt: '2026-04-06T16:00:00.000Z',
            },
          ],
        ])
      );

      const result = await service.resolveServersForRepo('example-org/example-repo', undefined, {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any);

      expect(result).toEqual([
        expect.objectContaining({
          slug: 'sample-connector',
          discoveredTools: [{ name: 'userTool', inputSchema: {} }],
          transport: {
            type: 'http',
            url: 'https://mcp.example.com/v1/mcp',
            headers: { Authorization: 'Bearer sample-token' },
          },
        }),
      ]);
    });

    it('omits connectors that require user configuration when no user connection exists', async () => {
      const globalConfig = {
        slug: 'sample-connector',
        name: 'Sample connector',
        scope: 'global',
        transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp', headers: {} },
        sharedConfig: {},
        authConfig: {
          mode: 'user-fields',
          schema: {
            fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' }],
            bindings: [{ target: 'header', key: 'Authorization', fieldKey: 'apiToken', format: 'bearer' }],
          },
        },
        timeout: 30000,
        sharedDiscoveredTools: [{ name: 'sharedTool', inputSchema: {} }],
      };

      MockModel.query
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([globalConfig]),
          }),
        })
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([]),
          }),
        });

      mockListDecryptedConnectionsByScopes.mockResolvedValue(new Map());

      const result = await service.resolveServersForRepo('example-org/example-repo', undefined, {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any);

      expect(result).toEqual([]);
    });

    it('persists refreshed OAuth tokens through the resolved auth provider', async () => {
      const globalConfig = {
        slug: 'sample-oauth',
        name: 'Sample OAuth',
        scope: 'global',
        transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp', headers: {} },
        sharedConfig: {},
        authConfig: {
          mode: 'oauth',
          provider: 'generic-oauth2.1',
          scope: 'sample.read',
        },
        timeout: 30000,
        sharedDiscoveredTools: [],
      };
      const discoveredTools = [{ name: 'userTool', inputSchema: {} }];

      MockModel.query
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([globalConfig]),
          }),
        })
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([]),
          }),
        });

      mockListDecryptedConnectionsByScopes.mockResolvedValue(
        new Map([
          [
            'global:sample-oauth',
            {
              state: {
                type: 'oauth',
                tokens: {
                  access_token: 'expired-access-token',
                  refresh_token: 'sample-refresh-token',
                  token_type: 'Bearer',
                },
                clientInformation: {
                  client_id: 'sample-client-id',
                  client_secret: 'sample-client-secret',
                },
              },
              discoveredTools,
              validationError: null,
              validatedAt: '2026-04-06T16:00:00.000Z',
              updatedAt: '2026-04-06T16:00:00.000Z',
            },
          ],
        ])
      );

      const result = await service.resolveServersForRepo('example-org/example-repo', undefined, {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any);
      const authProvider = result[0]?.transport.type === 'http' ? result[0].transport.authProvider : undefined;

      expect(authProvider).toBeDefined();
      await expect(authProvider?.tokens()).resolves.toMatchObject({
        access_token: 'expired-access-token',
        refresh_token: 'sample-refresh-token',
      });

      await authProvider?.saveTokens({
        access_token: 'fresh-access-token',
        refresh_token: 'sample-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });

      expect(mockUpsertConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'sample-user',
          ownerGithubUsername: 'sample-user',
          scope: 'global',
          slug: 'sample-oauth',
          discoveredTools,
          validationError: null,
          validatedAt: '2026-04-06T16:00:00.000Z',
          state: expect.objectContaining({
            type: 'oauth',
            tokens: expect.objectContaining({
              access_token: 'fresh-access-token',
              refresh_token: 'sample-refresh-token',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          }),
        })
      );
    });
  });

  describe('resolveSessionPodServersForRepo', () => {
    it('returns only stdio connectors and preserves compiled per-user env bindings', async () => {
      const stdioConfig = {
        slug: 'sample-stdio',
        name: 'Sample stdio',
        scope: 'global',
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'sample-mcp-server', '--stdio'],
          env: {},
        },
        sharedConfig: {},
        authConfig: {
          mode: 'user-fields',
          schema: {
            fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' }],
            bindings: [{ target: 'env', key: 'SAMPLE_API_TOKEN', fieldKey: 'apiToken' }],
          },
        },
        timeout: 45000,
        sharedDiscoveredTools: [],
      };
      const httpConfig = {
        slug: 'sample-http',
        name: 'Sample HTTP',
        scope: 'global',
        transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp', headers: {} },
        sharedConfig: {},
        authConfig: { mode: 'none' },
        timeout: 30000,
        sharedDiscoveredTools: [{ name: 'listIssues', inputSchema: {} }],
      };

      MockModel.query
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([stdioConfig, httpConfig]),
          }),
        })
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([]),
          }),
        });

      mockListDecryptedConnectionsByScopes.mockResolvedValue(
        new Map([
          [
            'global:sample-stdio',
            {
              state: {
                type: 'fields',
                values: { apiToken: 'sample-api-token' },
              },
              discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
              validationError: null,
              validatedAt: '2026-04-06T16:00:00.000Z',
              updatedAt: '2026-04-06T16:00:00.000Z',
            },
          ],
        ])
      );

      const result = await service.resolveSessionPodServersForRepo('example-org/example-repo', undefined, {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any);

      expect(result).toEqual([
        {
          slug: 'sample-stdio',
          name: 'Sample stdio',
          scope: 'global',
          transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'sample-mcp-server', '--stdio'],
            env: {
              SAMPLE_API_TOKEN: 'sample-api-token',
            },
          },
          timeout: 45000,
          defaultArgs: {},
          env: {
            SAMPLE_API_TOKEN: 'sample-api-token',
          },
          discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
        },
      ]);
    });
  });

  describe('update', () => {
    it('preserves redacted shared config secrets when updating a connector', async () => {
      const existing = {
        id: 1,
        slug: 'sample-connector',
        name: 'Sample connector',
        scope: 'global',
        description: 'Original description',
        preset: null,
        transport: {
          type: 'http',
          url: 'https://mcp.example.com/v1/mcp?api_key=transport-query-secret&workspace=sample-workspace',
          headers: {
            Authorization: 'Bearer transport-token',
          },
        },
        sharedConfig: {
          headers: {
            Authorization: 'Bearer top-secret-token',
          },
          query: {
            api_key: 'top-secret-query-token',
          },
          env: {
            SAMPLE_API_TOKEN: 'top-secret-env-token',
          },
          defaultArgs: {
            token: 'top-secret-arg-token',
          },
        },
        authConfig: { mode: 'none' },
        enabled: true,
        timeout: 30000,
        sharedDiscoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      };
      const patchAndFetchById = jest.fn().mockResolvedValue({
        ...existing,
        description: 'Updated description',
      });

      MockModel.query
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockReturnValue({
              first: jest.fn().mockResolvedValue(existing),
            }),
          }),
        })
        .mockReturnValueOnce({
          patchAndFetchById,
        });

      const result = await service.update('sample-connector', 'global', {
        description: 'Updated description',
        transport: {
          type: 'http',
          url: 'https://mcp.example.com/v1/mcp?api_key=******&workspace=sample-workspace',
          headers: {
            Authorization: '******',
          },
        },
        sharedConfig: {
          headers: {
            Authorization: '******',
          },
          query: {
            api_key: '******',
          },
          env: {
            SAMPLE_API_TOKEN: '******',
          },
          defaultArgs: {
            token: '******',
          },
        },
      });

      expect(result).toEqual({
        ...existing,
        description: 'Updated description',
      });
      expect(mockConnect).not.toHaveBeenCalled();
      expect(patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          description: 'Updated description',
          transport: {
            type: 'http',
            url: 'https://mcp.example.com/v1/mcp?api_key=transport-query-secret&workspace=sample-workspace',
            headers: {
              Authorization: 'Bearer transport-token',
            },
          },
          sharedConfig: expect.objectContaining({
            headers: {
              Authorization: 'Bearer top-secret-token',
            },
            query: {
              api_key: 'top-secret-query-token',
            },
            env: {
              SAMPLE_API_TOKEN: 'top-secret-env-token',
            },
            defaultArgs: {
              token: 'top-secret-arg-token',
            },
          }),
        })
      );
    });

    it('requires transport secrets to be re-entered when the connector target changes', async () => {
      const existing = {
        id: 1,
        slug: 'sample-connector',
        name: 'Sample connector',
        scope: 'global',
        description: 'Original description',
        preset: null,
        transport: {
          type: 'http',
          url: 'https://mcp.example.com/v1/mcp?api_key=transport-query-secret',
          headers: {
            Authorization: 'Bearer transport-token',
          },
        },
        sharedConfig: {},
        authConfig: { mode: 'none' },
        enabled: true,
        timeout: 30000,
        sharedDiscoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      };
      const patchAndFetchById = jest.fn();

      MockModel.query.mockReturnValueOnce({
        where: jest.fn().mockReturnValue({
          whereNull: jest.fn().mockReturnValue({
            first: jest.fn().mockResolvedValue(existing),
          }),
        }),
      });

      await expect(
        service.update('sample-connector', 'global', {
          transport: {
            type: 'http',
            url: 'https://other.example.com/v1/mcp?api_key=******',
            headers: {
              Authorization: '******',
            },
          },
        })
      ).rejects.toThrow('Re-enter MCP transport secrets when changing the MCP transport target');

      expect(mockConnect).not.toHaveBeenCalled();
      expect(patchAndFetchById).not.toHaveBeenCalled();
    });

    it('requires shared secrets to be re-entered when the connector target changes', async () => {
      const existing = {
        id: 1,
        slug: 'sample-connector',
        name: 'Sample connector',
        scope: 'global',
        description: 'Original description',
        preset: null,
        transport: {
          type: 'http',
          url: 'https://mcp.example.com/v1/mcp',
          headers: {},
        },
        sharedConfig: {
          headers: {
            Authorization: 'Bearer shared-token',
          },
        },
        authConfig: { mode: 'none' },
        enabled: true,
        timeout: 30000,
        sharedDiscoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      };
      const patchAndFetchById = jest.fn();

      MockModel.query.mockReturnValueOnce({
        where: jest.fn().mockReturnValue({
          whereNull: jest.fn().mockReturnValue({
            first: jest.fn().mockResolvedValue(existing),
          }),
        }),
      });

      await expect(
        service.update('sample-connector', 'global', {
          transport: {
            type: 'http',
            url: 'https://other.example.com/v1/mcp',
            headers: {},
          },
        })
      ).rejects.toThrow('Re-enter MCP shared secrets when changing the MCP transport target');

      expect(mockConnect).not.toHaveBeenCalled();
      expect(patchAndFetchById).not.toHaveBeenCalled();
    });

    it('requires transport secrets to be re-entered when the connector transport type changes', async () => {
      const existing = {
        id: 1,
        slug: 'sample-connector',
        name: 'Sample connector',
        scope: 'global',
        description: 'Original description',
        preset: null,
        transport: {
          type: 'http',
          url: 'https://mcp.example.com/v1/mcp?api_key=transport-query-secret',
          headers: {},
        },
        sharedConfig: {},
        authConfig: { mode: 'none' },
        enabled: true,
        timeout: 30000,
        sharedDiscoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      };
      const patchAndFetchById = jest.fn();

      MockModel.query.mockReturnValueOnce({
        where: jest.fn().mockReturnValue({
          whereNull: jest.fn().mockReturnValue({
            first: jest.fn().mockResolvedValue(existing),
          }),
        }),
      });

      await expect(
        service.update('sample-connector', 'global', {
          transport: {
            type: 'stdio',
            command: 'sample-mcp',
            args: ['--stdio'],
            env: {
              SAMPLE_API_TOKEN: '******',
            },
          },
        })
      ).rejects.toThrow('Re-enter MCP transport secrets when changing the MCP transport target');

      expect(mockConnect).not.toHaveBeenCalled();
      expect(patchAndFetchById).not.toHaveBeenCalled();
    });

    it('preserves redacted stdio transport env secrets when updating a connector', async () => {
      const existing = {
        id: 1,
        slug: 'sample-stdio',
        name: 'Sample stdio',
        scope: 'global',
        description: 'Original description',
        preset: null,
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'sample-mcp-server'],
          env: {
            SAMPLE_API_TOKEN: 'top-secret-env-token',
          },
        },
        sharedConfig: {},
        authConfig: { mode: 'none' },
        enabled: true,
        timeout: 30000,
        sharedDiscoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      };
      const patchAndFetchById = jest.fn().mockResolvedValue({
        ...existing,
        description: 'Updated description',
      });

      MockModel.query
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockReturnValue({
              first: jest.fn().mockResolvedValue(existing),
            }),
          }),
        })
        .mockReturnValueOnce({
          patchAndFetchById,
        });

      await service.update('sample-stdio', 'global', {
        description: 'Updated description',
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'sample-mcp-server'],
          env: {
            SAMPLE_API_TOKEN: '******',
          },
        },
      });

      expect(mockConnect).not.toHaveBeenCalled();
      expect(patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          description: 'Updated description',
          transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'sample-mcp-server'],
            env: {
              SAMPLE_API_TOKEN: 'top-secret-env-token',
            },
          },
        })
      );
    });
  });

  describe('definition queries', () => {
    it('applies repository definitions over matching global slugs while preserving unrelated globals', async () => {
      const globalOverride = configRecord({ id: 1, slug: 'shared', name: 'Global shared' });
      const globalOnly = configRecord({ id: 2, slug: 'global-only', name: 'Global only' });
      const repositoryOverride = configRecord({
        id: 3,
        slug: 'shared',
        name: 'Repository shared',
        scope: 'goodrx/lifecycle',
      });
      const globalQuery = queueListQuery([globalOverride, globalOnly]);
      const repositoryQuery = queueListQuery([repositoryOverride]);

      const result = await service.listEffectiveDefinitions('goodrx/lifecycle');

      expect(result).toEqual([repositoryOverride, globalOnly]);
      expect(globalQuery.where).toHaveBeenCalledWith({ scope: 'global', enabled: true });
      expect(repositoryQuery.where).toHaveBeenCalledWith({ scope: 'goodrx/lifecycle', enabled: true });
      expect(globalQuery.whereNull).toHaveBeenCalledWith('deletedAt');
      expect(repositoryQuery.whereNull).toHaveBeenCalledWith('deletedAt');
    });

    it('queries global-only definitions, arbitrary scopes, and normalizes a missing lookup to undefined', async () => {
      const globalConfig = configRecord();
      const globalQuery = queueListQuery([globalConfig]);

      await expect(service.listEffectiveDefinitions()).resolves.toEqual([globalConfig]);
      expect(globalQuery.where).toHaveBeenCalledWith({ scope: 'global', enabled: true });

      const scopedQuery = queueListQuery([globalConfig]);
      await expect(service.listByScope('goodrx/lifecycle')).resolves.toEqual([globalConfig]);
      expect(scopedQuery.where).toHaveBeenCalledWith({ scope: 'goodrx/lifecycle' });
      expect(scopedQuery.whereNull).toHaveBeenCalledWith('deletedAt');

      const findQuery = queueFindQuery(undefined);
      await expect(service.getBySlugAndScope('missing', 'global')).resolves.toBeUndefined();
      expect(findQuery.where).toHaveBeenCalledWith({ slug: 'missing', scope: 'global' });
      expect(findQuery.whereNull).toHaveBeenCalledWith('deletedAt');
    });
  });

  describe('create validation and defaults', () => {
    it.each(['', '-leading', 'trailing-', 'Uppercase', 'a'.repeat(101)])(
      'rejects the syntactically invalid slug %j before querying or connecting',
      async (slug) => {
        await expect(
          service.create({
            slug,
            name: 'Invalid connector',
            scope: 'global',
            transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
          })
        ).rejects.toThrow('must be 1-100 lowercase alphanumeric characters or hyphens');
        expect(MockModel.query).not.toHaveBeenCalled();
        expect(mockConnect).not.toHaveBeenCalled();
      }
    );

    it.each(['lifecycle', 'workspace-core', 'sandbox', 'workspace'])(
      'rejects the built-in namespace slug %s before querying or connecting',
      async (slug) => {
        await expect(
          service.create({
            slug,
            name: 'Reserved connector',
            scope: 'global',
            transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
          })
        ).rejects.toThrow('this name is reserved for built-in tools');
        expect(MockModel.query).not.toHaveBeenCalled();
        expect(mockConnect).not.toHaveBeenCalled();
      }
    );

    it('rejects a duplicate active definition without attempting discovery or insertion', async () => {
      const existing = configRecord();
      const { insert } = makeQueryResult(existing);

      await expect(
        service.create({
          slug: existing.slug,
          name: existing.name,
          scope: existing.scope,
          transport: existing.transport,
        })
      ).rejects.toThrow("MCP server config with slug 'sample-connector' already exists in scope 'global'");
      expect(mockConnect).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    });

    it('accepts the maximum slug boundary and applies preset auth plus explicit persistence fields', async () => {
      const { insert } = makeQueryResult(undefined);
      const inserted = configRecord({ id: 9, slug: 'a'.repeat(100), enabled: false, timeout: 45000 });
      insert.mockResolvedValue(inserted);

      await expect(
        service.create({
          slug: 'a'.repeat(100),
          name: 'Preset connector',
          scope: 'goodrx/lifecycle',
          description: 'Repository connector',
          preset: 'stdio-api-token',
          transport: { type: 'stdio', command: 'npx', args: ['-y', 'sample-mcp'] },
          sharedConfig: { env: { SHARED_REGION: 'us-west-2' } },
          enabled: false,
          timeout: 45000,
        })
      ).resolves.toEqual(inserted);

      expect(mockConnect).not.toHaveBeenCalled();
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'a'.repeat(100),
          description: 'Repository connector',
          preset: 'stdio-api-token',
          enabled: false,
          timeout: 45000,
          transport: { type: 'stdio', command: 'npx', args: ['-y', 'sample-mcp'], env: {} },
          sharedConfig: {
            headers: {},
            query: {},
            env: { SHARED_REGION: 'us-west-2' },
            defaultArgs: {},
          },
          authConfig: expect.objectContaining({ mode: 'user-fields' }),
          sharedDiscoveredTools: [],
        })
      );
    });
  });

  describe('update and delete outcomes', () => {
    it('reports a missing update without querying for a patch or starting discovery', async () => {
      queueFindQuery(undefined);

      await expect(service.update('missing', 'global', { name: 'Renamed' })).rejects.toThrow(
        "MCP server config 'missing' not found in scope 'global'"
      );
      expect(MockModel.query).toHaveBeenCalledTimes(1);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('revalidates changed connection inputs and persists normalized explicit fields and tools', async () => {
      const existing = configRecord({ description: null });
      queueFindQuery(existing);
      const patchAndFetchById = jest.fn().mockResolvedValue({ ...existing, name: 'Renamed connector' });
      MockModel.query.mockReturnValueOnce({ patchAndFetchById });
      mockListTools.mockResolvedValue([{ name: 'changedTool', inputSchema: {} }]);

      await service.update(existing.slug, existing.scope, {
        name: 'Renamed connector',
        description: 'Changed definition',
        preset: 'custom-http',
        transport: {
          type: 'http',
          url: 'https://other.example.com/mcp',
          headers: { 'X-Shared': 'transport-header' },
        },
        sharedConfig: {
          headers: { Authorization: 'Bearer fresh-shared-secret' },
          query: { region: 'west' },
          env: { SHARED_REGION: 'west' },
          defaultArgs: { organization: 'goodrx' },
        },
        authConfig: { mode: 'none' },
        enabled: false,
        timeout: 15000,
      });

      expect(mockConnect).toHaveBeenCalledWith(
        {
          type: 'http',
          url: 'https://other.example.com/mcp?region=west',
          headers: { 'X-Shared': 'transport-header', Authorization: 'Bearer fresh-shared-secret' },
        },
        5000
      );
      expect(patchAndFetchById).toHaveBeenCalledWith(
        existing.id,
        expect.objectContaining({
          name: 'Renamed connector',
          description: 'Changed definition',
          preset: 'custom-http',
          enabled: false,
          timeout: 15000,
          authConfig: { mode: 'none' },
          sharedDiscoveredTools: [{ name: 'changedTool', inputSchema: {} }],
        })
      );
    });

    it('revalidates an auth-only change and defers shared discovery for the new user connection', async () => {
      const existing = configRecord();
      queueFindQuery(existing);
      const patchAndFetchById = jest.fn().mockResolvedValue(existing);
      MockModel.query.mockReturnValueOnce({ patchAndFetchById });
      const userAuth = {
        mode: 'user-fields' as const,
        schema: {
          fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' as const }],
          bindings: [
            {
              target: 'header' as const,
              key: 'Authorization',
              fieldKey: 'apiToken',
              format: 'bearer' as const,
            },
          ],
        },
      };

      await service.update(existing.slug, existing.scope, { authConfig: userAuth });

      expect(mockConnect).not.toHaveBeenCalled();
      expect(patchAndFetchById).toHaveBeenCalledWith(
        existing.id,
        expect.objectContaining({ authConfig: userAuth, sharedDiscoveredTools: [] })
      );
    });

    it('preserves an existing preset and null description on an otherwise unchanged update', async () => {
      const existing = configRecord({ preset: 'custom-http', description: null });
      queueFindQuery(existing);
      const patchAndFetchById = jest.fn().mockResolvedValue(existing);
      MockModel.query.mockReturnValueOnce({ patchAndFetchById });

      await expect(service.update(existing.slug, existing.scope, {})).resolves.toEqual(existing);

      expect(mockConnect).not.toHaveBeenCalled();
      expect(patchAndFetchById).toHaveBeenCalledWith(
        existing.id,
        expect.objectContaining({ preset: 'custom-http', description: null })
      );
    });

    it('requires redacted submitted shared secrets to be re-entered when the target changes', async () => {
      const existing = configRecord({ sharedConfig: {} });
      queueFindQuery(existing);

      await expect(
        service.update(existing.slug, existing.scope, {
          transport: { type: 'http', url: 'https://other.example.com/mcp', headers: {} },
          sharedConfig: { headers: { Authorization: '******' } },
        })
      ).rejects.toThrow('Re-enter MCP shared secrets when changing the MCP transport target');
      expect(MockModel.query).toHaveBeenCalledTimes(1);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('soft-deletes a found definition and reports a missing delete', async () => {
      const existing = configRecord();
      queueFindQuery(existing);
      await expect(service.delete(existing.slug, existing.scope)).resolves.toBeUndefined();
      expect(MockModel.softDelete).toHaveBeenCalledWith(existing.id);

      queueFindQuery(undefined);
      await expect(service.delete('missing', 'global')).rejects.toThrow(
        "MCP server config 'missing' not found in scope 'global'"
      );
      expect(MockModel.softDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe('listEnabledConnectionsForUser', () => {
    it('returns redacted user and shared connector projections with state-specific tools', async () => {
      const userConfig = configRecord({
        id: 1,
        slug: 'user-connector',
        preset: 'api-token-header',
        transport: {
          type: 'http',
          url: 'https://mcp.example.com/mcp?workspace=private-workspace',
          headers: { 'X-Transport-Token': 'private-transport-token' },
        },
        sharedConfig: { headers: { 'X-Shared-Token': 'private-shared-token' } },
        authConfig: {
          mode: 'user-fields',
          schema: {
            fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' }],
            bindings: [{ target: 'header', key: 'Authorization', fieldKey: 'apiToken', format: 'bearer' }],
          },
        },
      });
      const sharedConfig = configRecord({
        id: 2,
        slug: 'shared-connector',
        name: 'Shared connector',
        description: null,
        preset: null,
        transport: { type: 'stdio', command: 'sample-mcp', env: { SHARED_TOKEN: 'private-env-token' } },
        sharedConfig: {},
        authConfig: { mode: 'none' },
        sharedDiscoveredTools: [SHARED_TOOL],
      });
      queueListQuery([userConfig, sharedConfig]);
      queueListQuery([]);
      mockListMaskedStatesByScopes.mockResolvedValue(
        new Map([
          [
            'global:user-connector',
            {
              configured: true,
              stale: true,
              configuredFieldKeys: ['apiToken'],
              validationError: 'Token expired',
              validatedAt: '2026-04-06T16:00:00.000Z',
              updatedAt: '2026-04-06T17:00:00.000Z',
              discoveredTools: [USER_TOOL],
            },
          ],
        ])
      );

      const result = await service.listEnabledConnectionsForUser('goodrx/lifecycle', USER_IDENTITY);

      expect(mockListMaskedStatesByScopes).toHaveBeenCalledWith(
        'sample-user',
        ['global', 'goodrx/lifecycle'],
        'sample-user',
        expect.any(Map)
      );
      const fingerprints = mockListMaskedStatesByScopes.mock.calls[0][3] as Map<string, string>;
      expect([...fingerprints.keys()]).toEqual(['global:user-connector', 'global:shared-connector']);
      expect(result).toEqual([
        expect.objectContaining({
          slug: 'user-connector',
          preset: 'api-token-header',
          connectionRequired: true,
          configured: true,
          stale: true,
          configuredFieldKeys: ['apiToken'],
          validationError: 'Token expired',
          validatedAt: '2026-04-06T16:00:00.000Z',
          updatedAt: '2026-04-06T17:00:00.000Z',
          discoveredTools: [USER_TOOL],
          sharedDiscoveredTools: [],
          transport: {
            type: 'http',
            url: 'https://mcp.example.com/mcp?workspace=******',
            headers: { 'X-Transport-Token': '******' },
          },
          sharedConfig: {
            headers: { 'X-Shared-Token': '******' },
          },
        }),
        expect.objectContaining({
          slug: 'shared-connector',
          description: null,
          preset: null,
          connectionRequired: false,
          configured: false,
          stale: false,
          configuredFieldKeys: [],
          validationError: null,
          validatedAt: null,
          updatedAt: null,
          discoveredTools: [SHARED_TOOL],
          sharedDiscoveredTools: [SHARED_TOOL],
          transport: { type: 'stdio', command: 'sample-mcp', env: { SHARED_TOKEN: '******' } },
        }),
      ]);
    });

    it('uses only the global scope and exposes an unconfigured user connector when no repository is provided', async () => {
      const unconfigured = configRecord({
        slug: 'unconfigured',
        authConfig: {
          mode: 'user-fields',
          schema: {
            fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' }],
            bindings: [{ target: 'header', key: 'Authorization', fieldKey: 'apiToken', format: 'bearer' }],
          },
        },
      });
      queueListQuery([unconfigured]);

      await expect(service.listEnabledConnectionsForUser(undefined, USER_IDENTITY)).resolves.toEqual([
        expect.objectContaining({
          slug: 'unconfigured',
          connectionRequired: true,
          configured: false,
          discoveredTools: [],
          sharedDiscoveredTools: [],
        }),
      ]);

      expect(mockListMaskedStatesByScopes).toHaveBeenCalledWith(
        'sample-user',
        ['global'],
        'sample-user',
        expect.any(Map)
      );
      expect(MockModel.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('server resolution partitions', () => {
    it('resolves shared connectors, compiles shared values, filters disabled slugs, and omits empty tools', async () => {
      const disabled = configRecord({ id: 1, slug: 'disabled' });
      const runnable = configRecord({
        id: 2,
        slug: 'runnable',
        sharedConfig: {
          headers: { Authorization: 'Bearer shared-token' },
          query: { region: 'west' },
          env: { SHARED_REGION: 'west' },
          defaultArgs: { organization: 'goodrx' },
        },
        sharedDiscoveredTools: [SHARED_TOOL],
      });
      const emptyTools = configRecord({ id: 3, slug: 'empty-tools', sharedDiscoveredTools: [] });
      queueListQuery([disabled, runnable, emptyTools]);

      const result = await service.resolveServers(undefined, ['disabled']);

      expect(result).toEqual([
        {
          scope: 'global',
          slug: 'runnable',
          name: 'Sample connector',
          transport: {
            type: 'http',
            url: 'https://mcp.example.com/v1/mcp?region=west',
            headers: { Authorization: 'Bearer shared-token' },
          },
          timeout: 30000,
          defaultArgs: { organization: 'goodrx' },
          env: { SHARED_REGION: 'west' },
          discoveredTools: [SHARED_TOOL],
        },
      ]);
      expect(mockListDecryptedConnectionsByScopes).not.toHaveBeenCalled();
      expect(MockModel.query).toHaveBeenCalledTimes(1);
    });

    it('omits user-field connectors with the wrong state, empty values, or no validated tools', async () => {
      const userAuth = {
        mode: 'user-fields' as const,
        schema: {
          fields: [{ key: 'apiToken', label: 'API token', required: true, inputType: 'password' as const }],
          bindings: [
            {
              target: 'header' as const,
              key: 'Authorization',
              fieldKey: 'apiToken',
              format: 'bearer' as const,
            },
          ],
        },
      };
      const wrongState = configRecord({ id: 1, slug: 'wrong-state', authConfig: userAuth });
      const emptyValues = configRecord({ id: 2, slug: 'empty-values', authConfig: userAuth });
      const emptyTools = configRecord({ id: 3, slug: 'empty-user-tools', authConfig: userAuth });
      queueListQuery([wrongState, emptyValues, emptyTools]);
      mockListDecryptedConnectionsByScopes.mockResolvedValue(
        new Map([
          ['global:wrong-state', { state: { type: 'oauth' }, discoveredTools: [USER_TOOL] }],
          ['global:empty-values', { state: { type: 'fields', values: {} }, discoveredTools: [USER_TOOL] }],
          [
            'global:empty-user-tools',
            { state: { type: 'fields', values: { apiToken: 'sample-token' } }, discoveredTools: [] },
          ],
        ])
      );

      await expect(service.resolveServers(undefined, undefined, USER_IDENTITY)).resolves.toEqual([]);
    });

    it('omits OAuth connectors without identity, with the wrong state, or without validated tools', async () => {
      const oauthConfig = {
        mode: 'oauth' as const,
        provider: 'generic-oauth2.1' as const,
        clientName: 'Lifecycle MCP',
      };
      const noIdentity = configRecord({ id: 1, slug: 'no-identity', authConfig: oauthConfig });
      queueListQuery([noIdentity]);

      await expect(service.resolveServers()).resolves.toEqual([]);
      expect(mockListDecryptedConnectionsByScopes).not.toHaveBeenCalled();

      const missingState = configRecord({ id: 2, slug: 'missing-oauth-state', authConfig: oauthConfig });
      const wrongState = configRecord({ id: 3, slug: 'wrong-oauth-state', authConfig: oauthConfig });
      const emptyTools = configRecord({ id: 4, slug: 'empty-oauth-tools', authConfig: oauthConfig });
      queueListQuery([missingState, wrongState, emptyTools]);
      mockListDecryptedConnectionsByScopes.mockResolvedValue(
        new Map([
          [
            'global:wrong-oauth-state',
            { state: { type: 'fields', values: { token: 'sample' } }, discoveredTools: [USER_TOOL] },
          ],
          [
            'global:empty-oauth-tools',
            {
              state: { type: 'oauth', tokens: { access_token: 'token', token_type: 'Bearer' } },
              discoveredTools: [],
              validatedAt: null,
              validationError: null,
            },
          ],
        ])
      );

      await expect(service.resolveServers(undefined, undefined, USER_IDENTITY)).resolves.toEqual([]);
    });
  });

  describe('discovery and synchronization', () => {
    it('uses the default validation timeout and always closes a successful discovery client', async () => {
      const transport = { type: 'http' as const, url: 'https://mcp.example.com/mcp', headers: {} };

      await expect(service.discoverTools(transport)).resolves.toEqual([{ name: 'inspectItem', inputSchema: {} }]);

      expect(mockConnect).toHaveBeenCalledWith(transport, 5000);
      expect(mockListTools).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('closes the discovery client when listing tools fails', async () => {
      const listingError = new Error('protocol list-tools failed');
      mockListTools.mockRejectedValue(listingError);

      await expect(
        service.discoverTools({ type: 'http', url: 'https://mcp.example.com/mcp', headers: {} }, 1200)
      ).rejects.toBe(listingError);
      expect(mockConnect).toHaveBeenCalledWith({ type: 'http', url: 'https://mcp.example.com/mcp', headers: {} }, 1200);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('refreshes shared discovery with the configured timeout and persists changed tool names', async () => {
      const config = configRecord({ sharedDiscoveredTools: [{ name: 'oldTool', inputSchema: {} }], timeout: 9000 });
      const patchAndFetchById = jest.fn().mockResolvedValue(config);
      MockModel.query.mockReturnValueOnce({ patchAndFetchById });
      mockListTools.mockResolvedValue([USER_TOOL]);

      await expect(service.refreshSharedDiscoveredTools(config)).resolves.toEqual([USER_TOOL]);

      expect(mockConnect).toHaveBeenCalledWith(config.transport, 9000);
      expect(patchAndFetchById).toHaveBeenCalledWith(config.id, { sharedDiscoveredTools: [USER_TOOL] });
    });

    it('does not write when synchronized tool names are unchanged regardless of ordering', async () => {
      const config = configRecord({
        sharedDiscoveredTools: [
          { name: 'beta', inputSchema: { old: true } },
          { name: 'alpha', inputSchema: {} },
        ],
      });

      await service.syncSharedDiscoveredTools(config, [
        { name: 'alpha', inputSchema: { changed: true } },
        { name: 'beta', inputSchema: {} },
      ]);

      expect(MockModel.query).not.toHaveBeenCalled();
    });
  });
});
