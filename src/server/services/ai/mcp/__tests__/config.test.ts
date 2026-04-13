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
import { McpConfigService } from '../config';

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

describe('McpConfigService', () => {
  let service: McpConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new McpConfigService();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue([{ name: 'inspectItem', inputSchema: {} }]);
    mockClose.mockResolvedValue(undefined);
    mockListMaskedStatesByScopes.mockResolvedValue(new Map());
    mockListDecryptedConnectionsByScopes.mockResolvedValue(new Map());
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
  });

  describe('resolveSessionPodServersForRepo', () => {
    it('returns only stdio connectors and preserves compiled per-user env bindings', async () => {
      const stdioConfig = {
        slug: 'figma',
        name: 'Figma',
        scope: 'global',
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'figma-developer-mcp', '--stdio'],
          env: {},
        },
        sharedConfig: {},
        authConfig: {
          mode: 'user-fields',
          schema: {
            fields: [{ key: 'figmaToken', label: 'Figma token', required: true, inputType: 'password' }],
            bindings: [{ target: 'env', key: 'FIGMA_API_KEY', fieldKey: 'figmaToken' }],
          },
        },
        timeout: 45000,
        sharedDiscoveredTools: [],
      };
      const httpConfig = {
        slug: 'jira',
        name: 'Jira',
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
            'global:figma',
            {
              state: {
                type: 'fields',
                values: { figmaToken: 'figma-pat-token' },
              },
              discoveredTools: [{ name: 'get_design_context', inputSchema: {} }],
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
          slug: 'figma',
          name: 'Figma',
          transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'figma-developer-mcp', '--stdio'],
            env: {
              FIGMA_API_KEY: 'figma-pat-token',
            },
          },
          timeout: 45000,
          defaultArgs: {},
          env: {
            FIGMA_API_KEY: 'figma-pat-token',
          },
          discoveredTools: [{ name: 'get_design_context', inputSchema: {} }],
        },
      ]);
    });
  });

  describe('update', () => {
    it('preserves redacted shared header secrets when updating a connector', async () => {
      const existing = {
        id: 1,
        slug: 'sample-connector',
        name: 'Sample connector',
        scope: 'global',
        description: 'Original description',
        preset: null,
        transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp', headers: {} },
        sharedConfig: {
          headers: {
            Authorization: 'Bearer top-secret-token',
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
        sharedConfig: {
          headers: {
            Authorization: '******',
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
          sharedConfig: expect.objectContaining({
            headers: {
              Authorization: 'Bearer top-secret-token',
            },
          }),
        })
      );
    });
  });
});
