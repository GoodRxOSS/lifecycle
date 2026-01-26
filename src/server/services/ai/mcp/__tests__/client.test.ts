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

const mockClientInstance = {
  connect: jest.fn(),
  listTools: jest.fn(),
  callTool: jest.fn(),
  close: jest.fn(),
};

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => mockClientInstance),
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn(),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { McpClientManager } from '../client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

describe('McpClientManager', () => {
  let manager: McpClientManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new McpClientManager();
    mockClientInstance.connect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('connect', () => {
    it('succeeds with StreamableHTTP', async () => {
      await manager.connect('http://localhost:3000/mcp');
      expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
      expect(SSEClientTransport).not.toHaveBeenCalled();
    });

    it('falls back to SSE when StreamableHTTP fails', async () => {
      mockClientInstance.connect.mockRejectedValueOnce(new Error('streamable failed')).mockResolvedValueOnce(undefined);
      await manager.connect('http://localhost:3000/mcp');
      expect(SSEClientTransport).toHaveBeenCalledTimes(1);
      expect(Client).toHaveBeenCalledTimes(2);
    });

    it('throws when both transports fail', async () => {
      mockClientInstance.connect.mockRejectedValue(new Error('fail'));
      await expect(manager.connect('http://localhost:3000/mcp')).rejects.toThrow(
        'both StreamableHTTP and SSE transports failed'
      );
    });

    it('passes headers to transport', async () => {
      await manager.connect('http://localhost:3000/mcp', { Authorization: 'Bearer tok' });
      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ requestInit: { headers: { Authorization: 'Bearer tok' } } })
      );
    });
  });

  describe('listTools', () => {
    it('returns tools from single page', async () => {
      await manager.connect('http://localhost:3000/mcp');
      mockClientInstance.listTools.mockResolvedValue({
        tools: [{ name: 'tool1', description: 'desc', inputSchema: {} }],
        nextCursor: undefined,
      });
      const result = await manager.listTools();
      expect(result).toHaveLength(1);
    });

    it('paginates via nextCursor', async () => {
      await manager.connect('http://localhost:3000/mcp');
      mockClientInstance.listTools
        .mockResolvedValueOnce({ tools: [{ name: 't1', inputSchema: {} }], nextCursor: 'page2' })
        .mockResolvedValueOnce({ tools: [{ name: 't2', inputSchema: {} }], nextCursor: undefined });
      const result = await manager.listTools();
      expect(result).toHaveLength(2);
      expect(mockClientInstance.listTools).toHaveBeenCalledTimes(2);
      expect(mockClientInstance.listTools).toHaveBeenLastCalledWith({ cursor: 'page2' });
    });

    it('throws when not connected', async () => {
      await expect(manager.listTools()).rejects.toThrow('not connected');
    });
  });

  describe('callTool', () => {
    it('returns result on success', async () => {
      await manager.connect('http://localhost:3000/mcp');
      mockClientInstance.callTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      });
      const result = await manager.callTool('test', {});
      expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false });
    });

    it('throws timeout error', async () => {
      jest.useFakeTimers();
      await manager.connect('http://localhost:3000/mcp');

      mockClientInstance.callTool.mockImplementation((_args: any, _schema: any, options: any) => {
        return new Promise((_resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      const promise = manager.callTool('test', {}, 10);
      jest.advanceTimersByTime(15);
      await expect(promise).rejects.toThrow('timed out');
    });

    it('throws when not connected', async () => {
      await expect(manager.callTool('test', {})).rejects.toThrow('not connected');
    });
  });

  describe('close', () => {
    it('closes connected client', async () => {
      await manager.connect('http://localhost:3000/mcp');
      mockClientInstance.close.mockResolvedValue(undefined);
      await manager.close();
      expect(mockClientInstance.close).toHaveBeenCalled();
      await expect(manager.listTools()).rejects.toThrow('not connected');
    });

    it('is safe when not connected', async () => {
      await expect(manager.close()).resolves.toBeUndefined();
    });

    it('suppresses close errors', async () => {
      await manager.connect('http://localhost:3000/mcp');
      mockClientInstance.close.mockRejectedValue(new Error('close failed'));
      await expect(manager.close()).resolves.toBeUndefined();
    });
  });
});
