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
const mockCallTool = jest.fn();
const mockClose = jest.fn();

jest.mock('server/services/agentRuntime/mcp/client', () => ({
  McpClientManager: jest.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockConnect(...args),
    callTool: (...args: unknown[]) => mockCallTool(...args),
    close: (...args: unknown[]) => mockClose(...args),
  })),
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    publishChatHttpPort: jest.fn(),
  },
}));

import type { ResolvedMcpServer } from 'server/services/agentRuntime/mcp/types';
import { executeWorkspaceCoreTool } from '../adapters';
import { getWorkspaceCoreToolDefinition, type WorkspaceCoreToolName } from '../toolDefinitions';

function gatewayServer(toolNames: string[]): ResolvedMcpServer {
  return {
    scope: 'session',
    slug: 'sandbox',
    name: 'Session Workspace',
    transport: { type: 'http', url: 'http://workspace.example.test/mcp' },
    timeout: 1234,
    defaultArgs: {},
    env: {},
    discoveredTools: toolNames.map((name) => ({
      name,
      inputSchema: { type: 'object', properties: {} },
    })),
  };
}

function context(toolNames: string[]) {
  return {
    session: { uuid: 'session-123' } as any,
    userIdentity: { userId: 'user-123' } as any,
    workspaceGatewayServer: gatewayServer(toolNames),
    timeoutMs: 9999,
  };
}

function definition(name: WorkspaceCoreToolName) {
  const tool = getWorkspaceCoreToolDefinition(name);
  if (!tool) {
    throw new Error(`Missing workspace_core tool definition: ${name}`);
  }

  return tool;
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value),
      },
    ],
  };
}

describe('workspace_core adapters', () => {
  beforeEach(() => {
    mockConnect.mockResolvedValue(undefined);
    mockCallTool.mockReset();
    mockClose.mockResolvedValue(undefined);
  });

  it('executes workspace.exec and normalizes command output to the v1 contract', async () => {
    mockCallTool.mockResolvedValue(
      textResult({
        ok: true,
        operationId: 'op-1',
        status: 'succeeded',
        exitCode: 0,
        stdout: 'done\n',
        stderr: '',
        stdoutTruncated: false,
        cwd: 'src',
        startedAt: '2026-06-30T12:00:00.000Z',
        endedAt: '2026-06-30T12:00:01.000Z',
      })
    );

    const result = await executeWorkspaceCoreTool(
      definition('exec'),
      {
        cmd: 'pnpm test',
        cwd: 'src',
        timeout_ms: 5000,
        async: true,
        yield_time_ms: 250,
      },
      context(['workspace.exec'])
    );

    expect(mockConnect).toHaveBeenCalledWith({ type: 'http', url: 'http://workspace.example.test/mcp' }, 1234);
    expect(mockCallTool).toHaveBeenCalledWith(
      'workspace.exec',
      {
        command: 'pnpm test',
        cwd: 'src',
        maxDurationMs: 5000,
        async: true,
        waitMs: 250,
        captureFileChanges: true,
      },
      9999
    );
    expect(result).toEqual({
      operation_id: 'op-1',
      status: 'completed',
      exit_code: 0,
      stdout: 'done\n',
      stderr: '',
      truncated: false,
      cwd: 'src',
      started_at: '2026-06-30T12:00:00.000Z',
      finished_at: '2026-06-30T12:00:01.000Z',
    });
  });

  it('preserves the failure reason when an exec fails without a policy code', async () => {
    mockCallTool.mockResolvedValue(
      textResult({
        ok: false,
        error: 'Failed to run command',
        details: 'Too many workspace operations are retained; limit is 200',
      })
    );

    const result = await executeWorkspaceCoreTool(
      definition('exec'),
      { cmd: 'pnpm test' },
      context(['workspace.exec'])
    );

    expect(result).toMatchObject({
      status: 'failed',
      stderr: 'Failed to run command: Too many workspace operations are retained; limit is 200',
    });
    expect(result).not.toHaveProperty('ok');
    expect(result).not.toHaveProperty('error');
    expect(result).not.toHaveProperty('details');
  });

  it('maps non-policy-coded exec failures to the schema shape with output and reason preserved', async () => {
    mockCallTool.mockResolvedValue(
      textResult({
        ok: false,
        code: 'file_change_capture_failed',
        error: 'File change capture failed',
        details: 'git diff exited with 128',
        operationId: 'op-9',
        status: 'failed',
        exitCode: 1,
        stdout: 'partial out',
        stderr: 'partial err',
      })
    );

    const result = await executeWorkspaceCoreTool(
      definition('exec'),
      { cmd: 'pnpm test' },
      context(['workspace.exec'])
    );

    expect(result).toEqual({
      operation_id: 'op-9',
      status: 'failed',
      exit_code: 1,
      stdout: 'partial out',
      stderr: 'partial err\nfile_change_capture_failed: File change capture failed: git diff exited with 128',
      truncated: false,
      cwd: '.',
      started_at: expect.any(String),
      finished_at: undefined,
    });
  });

  it('preserves the failure reason from handle-mode exec snapshots returned ok:true', async () => {
    mockCallTool.mockResolvedValue(
      textResult({
        ok: true,
        operationId: 'op-7',
        status: 'failed',
        error: 'spawn pnpm ENOENT',
        stdout: '',
        stderr: '',
      })
    );

    const result = await executeWorkspaceCoreTool(
      definition('exec'),
      { cmd: 'pnpm test', async: true },
      context(['workspace.exec'])
    );

    expect(result).toMatchObject({
      operation_id: 'op-7',
      status: 'failed',
      stderr: 'spawn pnpm ENOENT',
    });
  });

  it('returns the mapped policy envelope for policy-coded exec failures', async () => {
    mockCallTool.mockResolvedValue(
      textResult({
        ok: false,
        code: 'policy_denied',
        retry: 'never',
        message: 'Command is not allowed.',
        audit_id: 'workspace_core:audit-exec',
      })
    );

    const result = await executeWorkspaceCoreTool(definition('exec'), { cmd: 'rm -rf /' }, context(['workspace.exec']));

    expect(result).toMatchObject({
      ok: false,
      code: 'policy_denied',
      retry: 'never',
      message: 'Command is not allowed.',
    });
  });

  it('normalizes read_file output from structured gateway content', async () => {
    mockCallTool.mockResolvedValue({
      content: [],
      structuredContent: {
        ok: true,
        path: 'src/app.ts',
        text: 'export {};\n',
        startLine: 1,
        endLine: 1,
        lines: 1,
        truncated: false,
        sha256: 'sha-read',
        mtime: '2026-06-30T12:00:00.000Z',
      },
    });

    const result = await executeWorkspaceCoreTool(
      definition('read_file'),
      { path: 'src/app.ts', limit: 100 },
      context(['workspace.read_file'])
    );

    expect(mockCallTool).toHaveBeenCalledWith('workspace.read_file', { path: 'src/app.ts', maxChars: 100 }, 9999);
    expect(result).toEqual({
      path: 'src/app.ts',
      content: 'export {};\n',
      start_line: 1,
      end_line: 1,
      total_lines: 1,
      truncated: false,
      binary: false,
      media_type: undefined,
      sha256: 'sha-read',
      mtime: '2026-06-30T12:00:00.000Z',
    });
  });

  it('normalizes write_file file change metadata', async () => {
    mockCallTool.mockResolvedValue({
      content: [],
      structuredContent: {
        ok: true,
        path: 'src/app.ts',
        fileChanges: [
          {
            path: 'src/app.ts',
            unifiedDiff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-old\n+new\n',
            newSha256: 'sha-write',
          },
        ],
      },
    });

    const result = await executeWorkspaceCoreTool(
      definition('write_file'),
      { path: 'src/app.ts', content: 'new\n' },
      context(['workspace.write_file'])
    );

    expect(mockCallTool).toHaveBeenCalledWith('workspace.write_file', { path: 'src/app.ts', content: 'new\n' }, 9999);
    expect(result).toEqual({
      written: true,
      path: 'src/app.ts',
      diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-old\n+new\n',
      new_sha256: 'sha-write',
    });
  });

  it('executes workspace.list_files when the gateway advertises it', async () => {
    mockCallTool.mockResolvedValue({
      content: [],
      structuredContent: {
        ok: true,
        path: 'src',
        entries: [
          { path: 'src/app.ts', kind: 'file', size: 42, mtime: '2026-06-30T12:00:00.000Z' },
          { path: 'src/components', type: 'dir' },
        ],
        truncated: false,
      },
    });

    const result = await executeWorkspaceCoreTool(
      definition('list_files'),
      { path: 'src', depth: 1, include_hidden: true, respect_gitignore: false, limit: 10 },
      context(['workspace.list_files'])
    );

    expect(mockCallTool).toHaveBeenCalledWith(
      'workspace.list_files',
      { path: 'src', depth: 1, includeHidden: true, respectGitignore: false, limit: 10 },
      9999
    );
    expect(result).toEqual({
      path: 'src',
      entries: [
        { path: 'src/app.ts', kind: 'file', size: 42, mtime: '2026-06-30T12:00:00.000Z' },
        { path: 'src/components', kind: 'directory' },
      ],
      truncated: false,
    });
  });

  it('executes workspace.apply_patch and returns changed files, diff, and warnings', async () => {
    mockCallTool.mockResolvedValue({
      content: [],
      structuredContent: {
        ok: true,
        fileChanges: [
          {
            path: 'src/app.ts',
            unifiedDiff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-old\n+new\n',
          },
        ],
        warnings: ['already formatted'],
      },
    });

    const result = await executeWorkspaceCoreTool(
      definition('apply_patch'),
      {
        patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch\n',
        format: 'codex_v4a',
        expected_files: [{ path: 'src/app.ts', sha256: 'sha-before' }],
        reason: 'test patch',
      },
      context(['workspace.apply_patch'])
    );

    expect(mockCallTool).toHaveBeenCalledWith(
      'workspace.apply_patch',
      {
        patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch\n',
        format: 'codex_v4a',
        expectedFiles: [{ path: 'src/app.ts', sha256: 'sha-before' }],
        reason: 'test patch',
      },
      9999
    );
    expect(result).toEqual({
      applied: true,
      changed_files: ['src/app.ts'],
      diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-old\n+new\n',
      warnings: ['already formatted'],
    });
  });

  it('returns a policy envelope when the gateway denies a tool call', async () => {
    mockCallTool.mockResolvedValue({
      content: [],
      structuredContent: {
        ok: false,
        code: 'policy_denied',
        retry: 'never',
        message: 'Path is not allowed.',
        audit_id: 'workspace_core:audit-1',
        details: { path: '.env' },
      },
    });

    const result = await executeWorkspaceCoreTool(
      definition('read_file'),
      { path: '.env' },
      context(['workspace.read_file'])
    );

    expect(result).toEqual({
      ok: false,
      code: 'policy_denied',
      retry: 'never',
      message: 'Path is not allowed.',
      audit_id: 'workspace_core:audit-1',
      details: { path: '.env' },
    });
  });

  it('returns tool_unavailable without connecting when the gateway does not advertise a required backing tool', async () => {
    const result = await executeWorkspaceCoreTool(
      definition('apply_patch'),
      { patch: '*** Begin Patch\n*** End Patch\n' },
      context(['workspace.read_file'])
    );

    expect(mockConnect).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      code: 'tool_unavailable',
      retry: 'never',
      details: {
        tool: 'apply_patch',
        runtime_tool: 'workspace.apply_patch',
      },
    });
  });
});
