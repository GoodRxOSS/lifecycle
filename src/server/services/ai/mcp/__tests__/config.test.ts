/**
 * Copyright 2025 GoodRx, Inc.
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

const mockMcpConnect = jest.fn();
const mockMcpListTools = jest.fn();
const mockMcpClose = jest.fn();

jest.mock('../client', () => ({
  McpClientManager: jest.fn().mockImplementation(() => ({
    connect: mockMcpConnect,
    listTools: mockMcpListTools,
    close: mockMcpClose,
  })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('server/models/McpServerConfig', () => {
  const mockModel: any = {
    query: jest.fn(),
    softDelete: jest.fn(),
  };
  return { __esModule: true, default: mockModel };
});

import { McpConfigService } from '../config';
import McpServerConfig from 'server/models/McpServerConfig';

const MockModel = McpServerConfig as any;

function setupQueryChain(opts: { firstResult?: any } = {}) {
  const mockFirst = jest.fn().mockResolvedValue(opts.firstResult);
  const mockWhereNull = jest.fn().mockReturnValue({ first: mockFirst });
  const mockWhere = jest.fn().mockReturnValue({ whereNull: mockWhereNull });
  const mockInsert = jest.fn();
  const mockPatchAndFetchById = jest.fn();
  MockModel.query.mockReturnValue({
    where: mockWhere,
    insert: mockInsert,
    patchAndFetchById: mockPatchAndFetchById,
  });
  return { mockFirst, mockWhereNull, mockWhere, mockInsert, mockPatchAndFetchById };
}

describe('McpConfigService', () => {
  let service: McpConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new McpConfigService();
    mockMcpConnect.mockResolvedValue(undefined);
    mockMcpListTools.mockResolvedValue([{ name: 't', inputSchema: {} }]);
    mockMcpClose.mockResolvedValue(undefined);
  });

  describe('create', () => {
    it('creates valid config with cached tools', async () => {
      const { mockInsert } = setupQueryChain({ firstResult: undefined });
      const inserted = { id: 1, slug: 'my-server' };
      mockInsert.mockResolvedValue(inserted);

      const result = await service.create({
        slug: 'my-server',
        name: 'My Server',
        url: 'https://example.com/mcp',
        scope: 'global',
      });

      expect(result).toEqual(inserted);
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'my-server',
          cachedTools: [{ name: 't', inputSchema: {} }],
        })
      );
    });

    it('rejects invalid slug', async () => {
      await expect(
        service.create({ slug: '-bad-slug', name: 'Bad', url: 'https://x.com', scope: 'global' })
      ).rejects.toThrow('Invalid slug');
    });

    it('rejects duplicate slug', async () => {
      setupQueryChain({ firstResult: { id: 1, slug: 'my-server' } });
      await expect(
        service.create({ slug: 'my-server', name: 'My Server', url: 'https://x.com', scope: 'global' })
      ).rejects.toThrow('already exists');
    });

    it('throws when connectivity fails', async () => {
      setupQueryChain({ firstResult: undefined });
      mockMcpConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(
        service.create({ slug: 'my-server', name: 'My Server', url: 'https://x.com', scope: 'global' })
      ).rejects.toThrow('connectivity validation failed');
    });
  });

  describe('delete', () => {
    it('soft deletes existing config', async () => {
      setupQueryChain({ firstResult: { id: 1, slug: 'my-server' } });
      await service.delete('my-server', 'global');
      expect(MockModel.softDelete).toHaveBeenCalledWith(1);
    });

    it('throws when not found', async () => {
      setupQueryChain({ firstResult: undefined });
      await expect(service.delete('missing', 'global')).rejects.toThrow('not found');
    });
  });

  describe('resolveServersForRepo', () => {
    it('merges global and repo configs', async () => {
      const globalConfig = {
        slug: 'g1',
        name: 'G1',
        url: 'http://g',
        headers: {},
        envVars: {},
        timeout: 30000,
        cachedTools: [],
      };
      const repoConfig = {
        slug: 'r1',
        name: 'R1',
        url: 'http://r',
        headers: {},
        envVars: {},
        timeout: 30000,
        cachedTools: [],
      };

      MockModel.query
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([globalConfig]),
          }),
        })
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([repoConfig]),
          }),
        });

      const result = await service.resolveServersForRepo('org/repo');
      expect(result).toHaveLength(2);
      expect(result[0].slug).toBe('g1');
      expect(result[1].slug).toBe('r1');
    });

    it('excludes disabled slugs', async () => {
      const globalConfig1 = {
        slug: 'enabled',
        name: 'E',
        url: 'http://e',
        headers: {},
        envVars: {},
        timeout: 30000,
        cachedTools: [],
      };
      const globalConfig2 = {
        slug: 'disabled-one',
        name: 'D',
        url: 'http://d',
        headers: {},
        envVars: {},
        timeout: 30000,
        cachedTools: [],
      };

      MockModel.query
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([globalConfig1, globalConfig2]),
          }),
        })
        .mockReturnValueOnce({
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn().mockResolvedValue([]),
          }),
        });

      const result = await service.resolveServersForRepo('org/repo', ['disabled-one']);
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('enabled');
    });
  });

  describe('update', () => {
    it('revalidates connectivity when url changes', async () => {
      const { mockPatchAndFetchById } = setupQueryChain({
        firstResult: { id: 1, slug: 'my-server', url: 'http://old.com', headers: {} },
      });
      mockPatchAndFetchById.mockResolvedValue({ id: 1, slug: 'my-server', url: 'http://new.com' });

      await service.update('my-server', 'global', { url: 'http://new.com' });

      expect(mockMcpConnect).toHaveBeenCalled();
      expect(mockPatchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ url: 'http://new.com', cachedTools: expect.any(Array) })
      );
    });
  });
});
