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

import type { ToolSet } from 'ai';
import type AgentSession from 'server/models/AgentSession';
import type { ResolvedMcpServer } from 'server/services/agentRuntime/mcp/types';
import { configureAiToolFactories, type ToolExecutionHooks } from '../capabilityToolHelpers';
import { registerGenericMcpTool } from '../mcpToolRegistration';

const mockConnect = jest.fn();
const mockCallTool = jest.fn();
const mockClose = jest.fn();
const mockLoggerWarn = jest.fn();
const mockGetFileChangePreviewChars = jest.fn();

jest.mock('server/services/agentRuntime/mcp/client', () => ({
  McpClientManager: jest.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockConnect(...args),
    callTool: (...args: unknown[]) => mockCallTool(...args),
    close: (...args: unknown[]) => mockClose(...args),
  })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  }),
}));

jest.mock('../chatWorkspaceToolRegistration', () => ({
  getFileChangePreviewChars: (...args: unknown[]) => mockGetFileChangePreviewChars(...args),
}));

type RegisteredTool = {
  description: string;
  inputSchema: unknown;
  onInputAvailable: (args: {
    input: unknown;
    toolCallId: string;
    messages: unknown[];
    context: unknown;
  }) => Promise<void>;
  execute: (input: unknown, context: { toolCallId: string; messages: unknown[]; context: unknown }) => Promise<unknown>;
};

const writeFileSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['path', 'content'],
};

const writeFileToolContext = {
  toolKey: 'mcp__workspace_files__write_file',
  serverSlug: 'workspace-files',
  sourceToolName: 'write_file',
  catalogCapabilityId: 'external_mcp_write',
  capabilityKey: 'external_mcp_write',
  approvalMode: 'require_approval',
};

function buildServer(defaultArgs: Record<string, string> = {}): ResolvedMcpServer {
  return {
    scope: 'global',
    slug: 'workspace-files',
    name: 'Workspace Files',
    transport: {
      type: 'http',
      url: 'https://mcp.example.test',
      headers: { authorization: 'Bearer transport-secret' },
    },
    timeout: 12_000,
    defaultArgs,
    env: {},
    discoveredTools: [
      {
        name: 'write_file',
        description: 'Write a workspace file',
        inputSchema: writeFileSchema,
      },
    ],
  };
}

function registerWriteFileTool({
  server = buildServer(),
  hooks,
}: {
  server?: ResolvedMcpServer;
  hooks?: ToolExecutionHooks;
} = {}): RegisteredTool {
  const tools: ToolSet = {};

  registerGenericMcpTool({
    tools,
    session: { uuid: 'session-1' } as AgentSession,
    server,
    discoveredTool: server.discoveredTools[0],
    exposedToolName: 'write_file',
    description: 'Write a workspace file',
    capabilityKey: 'external_mcp_write',
    mode: 'require_approval',
    catalogCapabilityId: 'external_mcp_write',
    hooks,
  });

  return tools.mcp__workspace_files__write_file as RegisteredTool;
}

configureAiToolFactories({
  dynamicTool: ((config: unknown) => config) as never,
  jsonSchema: ((schema: unknown) => schema) as never,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockGetFileChangePreviewChars.mockResolvedValue(1_000);
});

describe('registerGenericMcpTool file-change lifecycle', () => {
  it('emits an approval preview without exposing a server-provided file value', async () => {
    const onFileChange = jest.fn().mockResolvedValue(undefined);
    const server = buildServer({ content: 'server-secret-content' });
    const tool = registerWriteFileTool({ server, hooks: { onFileChange } });

    await tool.onInputAvailable({
      input: { path: '/workspace/notes.txt' },
      toolCallId: 'tool-call-1',
      messages: [],
      context: writeFileToolContext,
    });

    expect(mockGetFileChangePreviewChars).toHaveBeenCalledTimes(1);
    expect(onFileChange).toHaveBeenCalledTimes(1);
    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool-call-1:notes.txt',
        toolCallId: 'tool-call-1',
        sourceTool: 'write_file',
        path: '/workspace/notes.txt',
        displayPath: 'notes.txt',
        stage: 'awaiting-approval',
        afterTextPreview: '******',
        summary: 'Proposed write to notes.txt',
      })
    );
    expect(JSON.stringify(onFileChange.mock.calls)).not.toContain('server-secret-content');
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('reports a failed file change and closes the client when the MCP write throws', async () => {
    const onToolStarted = jest.fn().mockResolvedValue(undefined);
    const onToolFinished = jest.fn().mockResolvedValue(undefined);
    const onFileChange = jest.fn().mockResolvedValue(undefined);
    mockCallTool.mockRejectedValue(new Error('upstream write failed'));
    const tool = registerWriteFileTool({
      hooks: { onToolStarted, onToolFinished, onFileChange },
    });
    const input = { path: '/workspace/notes.txt', content: 'hello' };

    await expect(
      tool.execute(input, {
        toolCallId: 'tool-call-2',
        messages: [],
        context: writeFileToolContext,
      })
    ).rejects.toThrow('upstream write failed');

    expect(mockConnect).toHaveBeenCalledWith(
      {
        type: 'http',
        url: 'https://mcp.example.test',
        headers: { authorization: 'Bearer transport-secret' },
      },
      12_000
    );
    expect(mockCallTool).toHaveBeenCalledWith('write_file', input, 12_000);
    expect(onToolStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tool-call-2',
        toolName: 'write_file',
        args: input,
      })
    );
    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool-call-2:notes.txt',
        toolCallId: 'tool-call-2',
        path: '/workspace/notes.txt',
        stage: 'failed',
        afterTextPreview: 'hello',
      })
    );
    expect(onToolFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tool-call-2',
        result: { error: 'upstream write failed' },
        status: 'failed',
      })
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { error: 'upstream write failed' },
      'AgentExec: mcp tool failed sessionId=session-1 server=workspace-files tool=write_file'
    );
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
