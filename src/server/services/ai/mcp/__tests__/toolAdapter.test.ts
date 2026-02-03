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
import { MCP_ERROR_CODES } from '../types';

describe('MCPToolAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('produces namespaced name', () => {
      const adapter = new MCPToolAdapter(
        'my-server',
        { name: 'doStuff', inputSchema: { type: 'object' } },
        'http://x',
        {},
        30000
      );
      expect(adapter.name).toBe('mcp__my-server__doStuff');
    });

    it('maps destructive annotation to DANGEROUS', () => {
      const adapter = new MCPToolAdapter(
        'srv',
        { name: 'destroy', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
        'http://x',
        {},
        30000
      );
      expect(adapter.safetyLevel).toBe(ToolSafetyLevel.DANGEROUS);
      expect(adapter.description).toMatch(/^\[DANGEROUS\]/);
    });

    it('maps readOnly annotation to SAFE', () => {
      const adapter = new MCPToolAdapter(
        'srv',
        { name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        'http://x',
        {},
        30000
      );
      expect(adapter.safetyLevel).toBe(ToolSafetyLevel.SAFE);
    });

    it('defaults to CAUTIOUS with no annotations', () => {
      const adapter = new MCPToolAdapter(
        'srv',
        { name: 'unknown', inputSchema: { type: 'object' } },
        'http://x',
        {},
        30000
      );
      expect(adapter.safetyLevel).toBe(ToolSafetyLevel.CAUTIOUS);
    });

    it('has mcp category', () => {
      const adapter = new MCPToolAdapter(
        'srv',
        { name: 'tool', inputSchema: { type: 'object' } },
        'http://x',
        {},
        30000
      );
      expect(adapter.category).toBe('mcp');
    });
  });

  describe('execute', () => {
    it('returns success with text content', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'result data' }],
        isError: false,
      });
      const adapter = new MCPToolAdapter('srv', { name: 't', inputSchema: {} }, 'http://x', {}, 30000);
      const result = await adapter.execute({});
      expect(result.success).toBe(true);
      expect(result.agentContent).toBe('result data');
    });

    it('returns connection error when connect fails', async () => {
      mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const adapter = new MCPToolAdapter('srv', { name: 't', inputSchema: {} }, 'http://x', {}, 30000);
      const result = await adapter.execute({});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(MCP_ERROR_CODES.CONNECTION);
    });

    it('returns tool error when isError is true', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'bad input' }],
        isError: true,
      });
      const adapter = new MCPToolAdapter('srv', { name: 't', inputSchema: {} }, 'http://x', {}, 30000);
      const result = await adapter.execute({});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(MCP_ERROR_CODES.TOOL);
    });

    it('returns protocol error for json-rpc failures', async () => {
      mockCallTool.mockRejectedValue(new Error('json-rpc parse error'));
      const adapter = new MCPToolAdapter('srv', { name: 't', inputSchema: {} }, 'http://x', {}, 30000);
      const result = await adapter.execute({});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(MCP_ERROR_CODES.PROTOCOL);
      expect(result.error?.recoverable).toBe(false);
    });

    it('always calls close', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      });
      const adapter = new MCPToolAdapter('srv', { name: 't', inputSchema: {} }, 'http://x', {}, 30000);
      await adapter.execute({});
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('createMcpTools', () => {
    it('creates tools from servers', () => {
      const servers = [
        {
          slug: 'srv1',
          name: 'Server 1',
          url: 'http://s1',
          headers: {},
          envVars: {},
          timeout: 30000,
          cachedTools: [{ name: 'tool1', inputSchema: {} }],
        },
        {
          slug: 'srv2',
          name: 'Server 2',
          url: 'http://s2',
          headers: {},
          envVars: {},
          timeout: 30000,
          cachedTools: [{ name: 'tool2', inputSchema: {} }],
        },
      ];
      const tools = createMcpTools(servers);
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('mcp__srv1__tool1');
      expect(tools[1].name).toBe('mcp__srv2__tool2');
    });
  });
});
