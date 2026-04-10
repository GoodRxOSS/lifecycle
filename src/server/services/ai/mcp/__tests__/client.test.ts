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

const mockListTools = jest.fn();
const mockClose = jest.fn();
const mockExecute = jest.fn();
const mockCreateMCPClient = jest.fn();
const mockExperimentalStdioTransport = jest.fn();

jest.mock('@ai-sdk/mcp', () => ({
  createMCPClient: (...args: unknown[]) => mockCreateMCPClient(...args),
}));

jest.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: function (...args: unknown[]) {
    return mockExperimentalStdioTransport(...args);
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { McpClientManager } from '../client';

describe('McpClientManager', () => {
  let manager: McpClientManager;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCreateMCPClient.mockResolvedValue({
      listTools: mockListTools,
      close: mockClose,
      toolsFromDefinitions: jest.fn(() => ({
        inspectItem: { execute: mockExecute },
      })),
    });

    mockExperimentalStdioTransport.mockReturnValue({ transport: 'stdio' });
    mockClose.mockResolvedValue(undefined);
    manager = new McpClientManager();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('connects using HTTP transport through the AI SDK MCP client', async () => {
    await manager.connect({
      type: 'http',
      url: 'https://mcp.example.com/v1/mcp',
      headers: { Authorization: 'Bearer sample-token' },
    });

    expect(mockCreateMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: {
          type: 'http',
          url: 'https://mcp.example.com/v1/mcp',
          headers: { Authorization: 'Bearer sample-token' },
        },
        name: 'lifecycle',
        version: '1.0.0',
      })
    );
  });

  it('wraps stdio transport with the AI SDK stdio helper', async () => {
    await manager.connect({
      type: 'stdio',
      command: 'sample-command',
      args: ['--serve'],
      env: { SAMPLE_ENV: '1' },
    });

    expect(mockExperimentalStdioTransport).toHaveBeenCalledWith({
      command: 'sample-command',
      args: ['--serve'],
      env: { SAMPLE_ENV: '1' },
    });
    expect(mockCreateMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: { transport: 'stdio' },
      })
    );
  });

  it('returns discovered tools from AI SDK definitions', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'inspectItem', description: 'Inspect item', inputSchema: {} }],
    });

    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });
    const result = await manager.listTools();

    expect(result).toEqual([
      {
        name: 'inspectItem',
        description: 'Inspect item',
        inputSchema: {},
        annotations: undefined,
      },
    ]);
  });

  it('executes tool calls via toolsFromDefinitions', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'inspectItem', description: 'Inspect item', inputSchema: {} }],
    });
    mockExecute.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });

    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });
    const result = await manager.callTool('inspectItem', { id: 'item-123' });

    expect(mockExecute).toHaveBeenCalledWith(
      { id: 'item-123' },
      expect.objectContaining({ abortSignal: expect.any(Object) })
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
  });
});
