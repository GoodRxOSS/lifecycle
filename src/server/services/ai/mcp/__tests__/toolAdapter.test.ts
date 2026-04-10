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

const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockCallTool = jest.fn();
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock('../client', () => ({
  McpClientManager: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    callTool: mockCallTool,
    close: mockClose,
  })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { MCPToolAdapter, createMcpTools } from '../toolAdapter';
import { ToolSafetyLevel } from '../../types/tool';
import { MCP_ERROR_CODES, type ResolvedMcpServer } from '../types';

describe('MCPToolAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('produces a namespaced tool name', () => {
      const adapter = new MCPToolAdapter(
        'sample-server',
        { name: 'inspectItem', inputSchema: { type: 'object' } },
        { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
        {},
        30000
      );

      expect(adapter.name).toBe('mcp__sample-server__inspectItem');
    });

    it('maps destructive annotations to DANGEROUS', () => {
      const adapter = new MCPToolAdapter(
        'sample-server',
        { name: 'removeItem', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
        { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
        {},
        30000
      );

      expect(adapter.safetyLevel).toBe(ToolSafetyLevel.DANGEROUS);
      expect(adapter.description).toMatch(/^\[DANGEROUS\]/);
    });

    it('maps read-only annotations to SAFE', () => {
      const adapter = new MCPToolAdapter(
        'sample-server',
        { name: 'readItem', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
        {},
        30000
      );

      expect(adapter.safetyLevel).toBe(ToolSafetyLevel.SAFE);
    });
  });

  describe('execute', () => {
    it('returns text content on success', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'result data' }],
        isError: false,
      });

      const adapter = new MCPToolAdapter(
        'sample-server',
        { name: 'inspectItem', inputSchema: {} },
        { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
        {},
        30000
      );

      const result = await adapter.execute({});

      expect(result.success).toBe(true);
      expect(result.agentContent).toBe('result data');
    });

    it('returns a connection error when connect fails', async () => {
      mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const adapter = new MCPToolAdapter(
        'sample-server',
        { name: 'inspectItem', inputSchema: {} },
        { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
        {},
        30000
      );

      const result = await adapter.execute({});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(MCP_ERROR_CODES.CONNECTION);
    });

    it('applies default args before calling the tool', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      });

      const adapter = new MCPToolAdapter(
        'sample-server',
        {
          name: 'inspectItem',
          inputSchema: {
            type: 'object',
            properties: {
              siteUrl: { type: 'string' },
            },
          },
        },
        { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
        { siteUrl: 'https://sample-site.example.com' },
        30000
      );

      await adapter.execute({});

      expect(mockCallTool).toHaveBeenCalledWith(
        'inspectItem',
        { siteUrl: 'https://sample-site.example.com' },
        30000,
        undefined
      );
    });
  });

  describe('createMcpTools', () => {
    it('creates tools from resolved servers', () => {
      const servers: ResolvedMcpServer[] = [
        {
          slug: 'sample-server-a',
          name: 'Sample Server A',
          transport: { type: 'http', url: 'https://mcp-a.example.com/v1/mcp' },
          timeout: 30000,
          defaultArgs: {},
          env: {},
          discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
        },
        {
          slug: 'sample-server-b',
          name: 'Sample Server B',
          transport: { type: 'sse', url: 'https://mcp-b.example.com/sse' },
          timeout: 30000,
          defaultArgs: {},
          env: {},
          discoveredTools: [{ name: 'createItem', inputSchema: {} }],
        },
      ];

      const tools = createMcpTools(servers);

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('mcp__sample-server-a__inspectItem');
      expect(tools[1].name).toBe('mcp__sample-server-b__createItem');
    });
  });
});
