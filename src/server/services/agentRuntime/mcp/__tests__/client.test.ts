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
const mockCallTool = jest.fn();
const mockCreateMCPClient = jest.fn();
const mockExperimentalStdioTransport = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('@ai-sdk/mcp', () => ({
  createMCPClient: (...args: unknown[]) => mockCreateMCPClient(...args),
}));

jest.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: function (...args: unknown[]) {
    return mockExperimentalStdioTransport(...args);
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: (...args: unknown[]) => mockLoggerWarn(...args), error: jest.fn() }),
}));

import { McpClientManager } from '../client';

describe('McpClientManager', () => {
  let manager: McpClientManager;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCreateMCPClient.mockResolvedValue({
      listTools: mockListTools,
      callTool: mockCallTool,
      close: mockClose,
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
          redirect: 'follow',
        },
        clientName: 'lifecycle',
        version: '1.0.0',
      })
    );
  });

  it('preserves an explicit redirect policy for SSE transports', async () => {
    await manager.connect({
      type: 'sse',
      url: 'https://mcp.example.com/v1/events',
      redirect: 'error',
    });

    expect(mockCreateMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: {
          type: 'sse',
          url: 'https://mcp.example.com/v1/events',
          redirect: 'error',
        },
      })
    );
  });

  it('rejects when the MCP handshake exceeds its timeout and remains disconnected', async () => {
    jest.useFakeTimers();
    mockCreateMCPClient.mockReturnValueOnce(new Promise(() => undefined));

    const connection = manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' }, 25);
    const rejection = expect(connection).rejects.toThrow('MCP client connect timed out after 25ms');
    await jest.advanceTimersByTimeAsync(25);
    await rejection;
    await expect(manager.listTools()).rejects.toThrow('MCP client not connected. Call connect() first.');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('propagates handshake failures and remains disconnected', async () => {
    const handshakeError = new Error('upstream handshake failed');
    mockCreateMCPClient.mockRejectedValueOnce(handshakeError);

    await expect(manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' })).rejects.toBe(handshakeError);
    await expect(manager.callTool('inspectItem', {})).rejects.toThrow(
      'MCP client not connected. Call connect() first.'
    );
  });

  it('redacts transport secrets from uncaught MCP client errors', async () => {
    mockCreateMCPClient.mockImplementationOnce(async (options: { onUncaughtError?: (error: Error) => void }) => {
      options.onUncaughtError?.(
        new Error(
          'uncaught Authorization=Bearer transport-secret query=query/secret+value encoded=query%2Fsecret%2Bvalue'
        )
      );
      return {
        listTools: mockListTools,
        callTool: mockCallTool,
        close: mockClose,
      };
    });

    await manager.connect({
      type: 'http',
      url: 'https://mcp.example.com/v1/mcp?api_key=query/secret+value',
      headers: { Authorization: 'Bearer transport-secret' },
    });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'MCP client uncaught error: uncaught Authorization=****** query=****** encoded=******'
    );
  });

  it('redacts malformed raw query values without over-redacting short values', async () => {
    mockCreateMCPClient.mockImplementationOnce(async (options: { onUncaughtError?: (error: Error) => void }) => {
      options.onUncaughtError?.(new Error('request exposed bad%ZZvalue but short value abc'));
      return {
        listTools: mockListTools,
        callTool: mockCallTool,
        close: mockClose,
      };
    });

    await manager.connect({
      type: 'http',
      url: 'https://mcp.example.com/v1/mcp?flag&&token=bad%ZZvalue&short=abc#fragment',
    });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'MCP client uncaught error: request exposed ****** but short value abc'
    );
  });

  it('preserves an uncaught error when a transport has no configured secrets', async () => {
    mockCreateMCPClient.mockImplementationOnce(async (options: { onUncaughtError?: (error: Error) => void }) => {
      options.onUncaughtError?.(new Error('plain upstream failure'));
      return {
        listTools: mockListTools,
        callTool: mockCallTool,
        close: mockClose,
      };
    });

    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });

    expect(mockLoggerWarn).toHaveBeenCalledWith('MCP client uncaught error: plain upstream failure');
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

  it('uses empty stdio arguments and redacts stdio environment secrets from uncaught errors', async () => {
    mockCreateMCPClient.mockImplementationOnce(async (options: { onUncaughtError?: (error: Error) => void }) => {
      options.onUncaughtError?.(new Error('stdio failed with STDIO_SECRET_VALUE and abc and ******'));
      return {
        listTools: mockListTools,
        callTool: mockCallTool,
        close: mockClose,
      };
    });

    await manager.connect({
      type: 'stdio',
      command: 'sample-command',
      env: { MCP_TOKEN: 'STDIO_SECRET_VALUE', SHORT_VALUE: 'abc', ALREADY_REDACTED: '******' },
    });

    expect(mockExperimentalStdioTransport).toHaveBeenCalledWith({
      command: 'sample-command',
      args: [],
      env: { MCP_TOKEN: 'STDIO_SECRET_VALUE', SHORT_VALUE: 'abc', ALREADY_REDACTED: '******' },
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'MCP client uncaught error: stdio failed with ****** and abc and ******'
    );
  });

  it('handles a non-Error stdio callback when no environment is configured', async () => {
    mockCreateMCPClient.mockImplementationOnce(async (options: { onUncaughtError?: (error: unknown) => void }) => {
      options.onUncaughtError?.('plain string failure');
      return {
        listTools: mockListTools,
        callTool: mockCallTool,
        close: mockClose,
      };
    });

    await manager.connect({ type: 'stdio', command: 'sample-command' });

    expect(mockLoggerWarn).toHaveBeenCalledWith('MCP client uncaught error: plain string failure');
  });

  it('returns discovered tools from AI SDK definitions', async () => {
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'inspectItem',
          description: 'Inspect item',
          inputSchema: {},
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
        {
          name: 'deleteItem',
          description: 'Delete item',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        },
      ],
    });

    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });
    const result = await manager.listTools();

    expect(result).toEqual([
      {
        name: 'inspectItem',
        description: 'Inspect item',
        inputSchema: {},
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        annotations: undefined,
      },
      {
        name: 'deleteItem',
        description: 'Delete item',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
    ]);
    expect(mockListTools).toHaveBeenCalledWith({ options: { timeout: 30000 } });
  });

  it('passes a custom discovery timeout and propagates upstream discovery failures', async () => {
    const discoveryError = new Error('tool discovery failed');
    mockListTools.mockRejectedValueOnce(discoveryError);
    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });

    await expect(manager.listTools(125)).rejects.toBe(discoveryError);
    expect(mockListTools).toHaveBeenCalledWith({ options: { timeout: 125 } });
  });

  it('executes tool calls through the MCP v2 direct client API', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'inspectItem', description: 'Inspect item', inputSchema: {} }],
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
      isError: false,
    });

    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });
    const result = await manager.callTool('inspectItem', { id: 'item-123' });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'inspectItem',
      arguments: { id: 'item-123' },
      options: expect.objectContaining({
        signal: expect.any(Object),
        timeout: 30000,
      }),
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
      isError: false,
    });
  });

  it('reuses cached tool definitions and does not rediscover tools before a call', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'inspectItem', description: 'Inspect item', inputSchema: {} }],
    });
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'cached' }] });
    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });
    await manager.listTools();
    mockListTools.mockClear();

    await expect(manager.callTool('inspectItem', { id: 'item-123' }, 250)).resolves.toEqual({
      content: [{ type: 'text', text: 'cached' }],
    });
    expect(mockListTools).not.toHaveBeenCalled();
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ timeout: 250 }) })
    );
  });

  it('rejects an undiscovered tool without calling the upstream tool endpoint', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'inspectItem', description: 'Inspect item', inputSchema: {} }],
    });
    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });

    await expect(manager.callTool('missingTool', {})).rejects.toThrow("MCP tool 'missingTool' not found");
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('aborts a pending tool request and rejects when the call timeout expires', async () => {
    jest.useFakeTimers();
    mockListTools.mockResolvedValue({
      tools: [{ name: 'inspectItem', description: 'Inspect item', inputSchema: {} }],
    });
    let requestSignal: AbortSignal | undefined;
    mockCallTool.mockImplementationOnce((request: { options: { signal: AbortSignal } }) => {
      requestSignal = request.options.signal;
      return new Promise(() => undefined);
    });
    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });

    const call = manager.callTool('inspectItem', {}, 40);
    const rejection = expect(call).rejects.toThrow("MCP tool call 'inspectItem' timed out after 40ms");
    await Promise.resolve();
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(40);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('maps an upstream abort error to the public timeout error', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'inspectItem', description: 'Inspect item', inputSchema: {} }],
    });
    mockCallTool.mockRejectedValueOnce(new Error('Request was aborted by the transport'));
    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });

    await expect(manager.callTool('inspectItem', {}, 75)).rejects.toThrow(
      "MCP tool call 'inspectItem' timed out after 75ms"
    );
  });

  it('propagates non-abort tool failures and clears the request timer', async () => {
    jest.useFakeTimers();
    const toolError = new Error('tool execution failed');
    mockListTools.mockResolvedValue({
      tools: [{ name: 'inspectItem', description: 'Inspect item', inputSchema: {} }],
    });
    mockCallTool.mockRejectedValueOnce(toolError);
    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });

    await expect(manager.callTool('inspectItem', {}, 75)).rejects.toBe(toolError);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('forwards caller cancellation and removes its abort listener during cleanup', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'inspectItem', description: 'Inspect item', inputSchema: {} }],
    });
    mockCallTool.mockImplementationOnce(
      (request: { options: { signal: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          request.options.signal.addEventListener(
            'abort',
            () => reject(new Error('Request was aborted by the caller')),
            { once: true }
          );
        })
    );
    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });
    const callerController = new AbortController();
    const addListener = jest.spyOn(callerController.signal, 'addEventListener');
    const removeListener = jest.spyOn(callerController.signal, 'removeEventListener');

    const call = manager.callTool('inspectItem', {}, 5000, callerController.signal);
    const rejection = expect(call).rejects.toThrow("MCP tool call 'inspectItem' timed out after 5000ms");
    await Promise.resolve();
    callerController.abort();
    await rejection;

    const registeredListener = addListener.mock.calls.find(([event]) => event === 'abort')?.[1];
    expect(registeredListener).toEqual(expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('abort', registeredListener);
  });

  it('closes an active client once, clears cached state, and is then idempotent', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'inspectItem', description: 'Inspect item', inputSchema: {} }],
    });
    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });
    await manager.listTools();

    await expect(manager.close()).resolves.toBeUndefined();
    await expect(manager.close()).resolves.toBeUndefined();

    expect(mockClose).toHaveBeenCalledTimes(1);
    await expect(manager.listTools()).rejects.toThrow('MCP client not connected. Call connect() first.');
    await expect(manager.callTool('inspectItem', {})).rejects.toThrow(
      'MCP client not connected. Call connect() first.'
    );
  });

  it.each([
    ['an Error', new Error('socket close failed'), 'socket close failed'],
    ['a non-Error rejection', 'socket close rejected', 'socket close rejected'],
  ])('warns and resets the client when close rejects with %s', async (_case, rejection, message) => {
    mockClose.mockRejectedValueOnce(rejection);
    await manager.connect({ type: 'http', url: 'https://mcp.example.com/v1/mcp' });

    await expect(manager.close()).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith(`MCP client close warning: ${message}`);
    await expect(manager.listTools()).rejects.toThrow('MCP client not connected. Call connect() first.');
  });
});
