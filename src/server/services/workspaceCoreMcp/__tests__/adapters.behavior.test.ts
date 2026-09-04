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
const mockPublishChatHttpPort = jest.fn();

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
    publishChatHttpPort: (...args: unknown[]) => mockPublishChatHttpPort(...args),
  },
}));

import type { ResolvedMcpServer } from 'server/services/agentRuntime/mcp/types';
import { executeWorkspaceCoreTool } from '../adapters';
import {
  getWorkspaceCoreToolDefinition,
  type WorkspaceCoreToolDefinition,
  type WorkspaceCoreToolName,
} from '../toolDefinitions';

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

function context(toolNames: string[], overrides: Record<string, unknown> = {}) {
  return {
    session: { uuid: 'session-123' } as any,
    userIdentity: { userId: 'user-123' } as any,
    workspaceGatewayServer: gatewayServer(toolNames),
    timeoutMs: 9999,
    ...overrides,
  } as any;
}

function definition(name: WorkspaceCoreToolName): WorkspaceCoreToolDefinition {
  const tool = getWorkspaceCoreToolDefinition(name);
  if (!tool) {
    throw new Error(`Missing workspace_core tool definition: ${name}`);
  }
  return tool;
}

function structuredResult(value: unknown) {
  return { content: [], structuredContent: value };
}

function textResult(value: unknown) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  };
}

const expectPolicy = (code: string, message?: string) =>
  expect.objectContaining({
    ok: false,
    code,
    ...(message ? { message } : {}),
    audit_id: expect.stringMatching(/^workspace_core:/),
  });

describe('workspace_core adapter behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockCallTool.mockResolvedValue(structuredResult({ ok: true }));
    mockClose.mockResolvedValue(undefined);
    mockPublishChatHttpPort.mockResolvedValue({
      url: 'https://preview.example.test',
      upstreamHealth: { ok: true, statusCode: 200 },
    });
  });

  describe('gateway lifecycle and policy mapping', () => {
    it('uses a lazily resolved gateway when no cached gateway is available', async () => {
      const resolveWorkspaceGatewayServer = jest.fn().mockResolvedValue(gatewayServer(['workspace.read_file']));
      mockCallTool.mockResolvedValue(textResult({ ok: true, path: 'README.md', content: 'hello' }));

      const result = await executeWorkspaceCoreTool(
        definition('read_file'),
        { path: 'README.md' },
        context([], { workspaceGatewayServer: null, resolveWorkspaceGatewayServer })
      );

      expect(resolveWorkspaceGatewayServer).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ path: 'README.md', content: 'hello' });
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('returns workspace_unavailable without constructing a client when neither gateway source is ready', async () => {
      const resolveWorkspaceGatewayServer = jest.fn().mockResolvedValue(null);

      const result = await executeWorkspaceCoreTool(
        definition('read_file'),
        { path: 'README.md' },
        context([], { workspaceGatewayServer: null, resolveWorkspaceGatewayServer })
      );

      expect(result).toEqual(expectPolicy('workspace_unavailable'));
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockClose).not.toHaveBeenCalled();
    });

    it('returns workspace_unavailable when lazy resolution is not configured', async () => {
      const result = await executeWorkspaceCoreTool(
        definition('read_file'),
        { path: 'README.md' },
        context([], { workspaceGatewayServer: null, resolveWorkspaceGatewayServer: undefined })
      );

      expect(result).toEqual(expectPolicy('workspace_unavailable'));
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('maps gateway connection and call failures while always closing the client', async () => {
      mockConnect.mockRejectedValueOnce(new Error('gateway refused connection'));
      await expect(
        executeWorkspaceCoreTool(definition('read_file'), { path: 'README.md' }, context(['workspace.read_file']))
      ).resolves.toEqual(expectPolicy('workspace_unavailable', 'gateway refused connection'));
      expect(mockCallTool).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);

      mockConnect.mockResolvedValueOnce(undefined);
      mockCallTool.mockRejectedValueOnce('gateway reset');
      await expect(
        executeWorkspaceCoreTool(definition('read_file'), { path: 'README.md' }, context(['workspace.read_file']))
      ).resolves.toEqual(expectPolicy('workspace_unavailable', 'gateway reset'));
      expect(mockClose).toHaveBeenCalledTimes(2);
    });

    it('parses plain text payloads and defaults malformed text to an empty read result', async () => {
      mockCallTool.mockResolvedValueOnce(textResult('not-json'));
      await expect(
        executeWorkspaceCoreTool(definition('read_file'), { path: 'README.md' }, context(['workspace.read_file']))
      ).resolves.toMatchObject({ path: 'README.md', content: '' });

      mockCallTool.mockResolvedValueOnce({ content: [{ type: 'image', data: 'ignored' }] });
      await expect(
        executeWorkspaceCoreTool(definition('read_file'), { path: 'README.md' }, context(['workspace.read_file']))
      ).resolves.toMatchObject({ path: 'README.md', content: '' });
    });

    it('handles non-array MCP content according to the declared unknown content contract', async () => {
      mockCallTool.mockResolvedValue({ content: 'raw gateway content' });

      await expect(
        executeWorkspaceCoreTool(definition('read_file'), { path: 'README.md' }, context(['workspace.read_file']))
      ).resolves.toMatchObject({ path: 'README.md', content: 'raw gateway content' });
    });

    it('maps capability-required metadata and filters non-string capabilities', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({
          ok: false,
          code: 'capability_required',
          required_capabilities: ['workspace.write', 3, null],
          approval_required: true,
          approval_id: 'approval-1',
          retry: 'after_approval',
          error: 'Approval is required.',
          audit_id: 'workspace_core:audit-capability',
        })
      );

      await expect(
        executeWorkspaceCoreTool(
          definition('write_file'),
          { path: 'a.ts', content: 'x' },
          context(['workspace.write_file'])
        )
      ).resolves.toEqual({
        ok: false,
        code: 'capability_required',
        required_capabilities: ['workspace.write'],
        approval_required: true,
        approval_id: 'approval-1',
        retry: 'after_approval',
        message: 'Approval is required.',
        audit_id: 'workspace_core:audit-capability',
      });
    });

    it('uses safe fallbacks for malformed capability-required metadata', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({ ok: false, code: 'capability_required', retry: 'immediate', message: '' })
      );

      const result = await executeWorkspaceCoreTool(
        definition('read_file'),
        { path: 'a.ts' },
        context(['workspace.read_file'])
      );

      expect(result).toEqual(
        expect.objectContaining({
          ok: false,
          code: 'capability_required',
          required_capabilities: [],
          approval_required: false,
          retry: 'never',
          message: 'workspace_core.read_file failed.',
        })
      );
    });

    it.each([
      ['invalid_arguments', undefined, 'immediate'],
      ['network_denied', 'after_workspace_ready', 'after_workspace_ready'],
      ['approval_pending', 'unsupported-retry', 'never'],
    ])('maps policy code %s with the expected retry', async (code, retry, expectedRetry) => {
      mockCallTool.mockResolvedValue(
        structuredResult({ ok: false, code, retry, message: `${code} message`, details: { source: 'gateway' } })
      );

      const result = await executeWorkspaceCoreTool(
        definition('read_file'),
        { path: 'a.ts' },
        context(['workspace.read_file'])
      );

      expect(result).toEqual(
        expect.objectContaining({
          code,
          retry: expectedRetry,
          message: `${code} message`,
          details: { source: 'gateway' },
        })
      );
    });

    it('maps unknown and uncoded non-exec failures to invalid_arguments with useful details', async () => {
      mockCallTool
        .mockResolvedValueOnce(
          structuredResult({
            ok: false,
            code: 'new_gateway_failure',
            error: 'new failure',
            details: { field: 'path' },
          })
        )
        .mockResolvedValueOnce(structuredResult({ ok: false, details: 'plain details' }));

      await expect(
        executeWorkspaceCoreTool(definition('read_file'), { path: 'a.ts' }, context(['workspace.read_file']))
      ).resolves.toEqual(
        expect.objectContaining({
          code: 'invalid_arguments',
          message: 'new failure',
          details: { tool: 'read_file', field: 'path' },
        })
      );
      await expect(
        executeWorkspaceCoreTool(definition('read_file'), { path: 'a.ts' }, context(['workspace.read_file']))
      ).resolves.toEqual(
        expect.objectContaining({
          code: 'invalid_arguments',
          message: 'workspace_core.read_file failed.',
          details: { tool: 'read_file' },
        })
      );
    });

    it('short-circuits explicitly unavailable definitions', async () => {
      const unavailable = { ...definition('read_file'), adapterKind: 'unavailable' as const };

      await expect(executeWorkspaceCoreTool(unavailable, {}, context([]))).resolves.toEqual(
        expectPolicy('tool_unavailable')
      );
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it.each([
      ['operation_status', { operation_id: 'op-1' }, 'workspace.operation_status'],
      ['operation_cancel', { operation_id: 'op-1' }, 'workspace.operation_cancel'],
      ['list_files', {}, 'workspace.list_files'],
      ['glob', { pattern: '*.ts' }, 'workspace.glob'],
      ['grep', { pattern: 'term' }, 'workspace.grep'],
      ['edit_file', { path: 'a.ts', old_text: 'a', new_text: 'b' }, 'workspace.edit_file'],
      ['git_status', {}, 'git.status'],
      ['git_diff', {}, 'git.diff'],
    ] as const)('preserves the mapped policy envelope after %s gateway calls', async (name, input, runtimeTool) => {
      mockCallTool.mockResolvedValue(
        structuredResult({ ok: false, code: 'protected_path', message: 'protected', retry: 'never' })
      );

      await expect(executeWorkspaceCoreTool(definition(name), input, context([runtimeTool]))).resolves.toEqual(
        expect.objectContaining({ ok: false, code: 'protected_path', message: 'protected' })
      );
    });

    it.each([
      ['exec', { cmd: 'pwd' }, 'workspace.exec', { status: 'failed', stdout: '', stderr: '' }],
      [
        'operation_status',
        { operation_id: 'op-1' },
        'workspace.operation_status',
        { operation_id: '', status: 'failed' },
      ],
      ['start_service', { command: 'pnpm dev' }, 'workspace.service_start', { running: false }],
      ['operation_logs', { operation_id: 'op-1' }, 'workspace.operation_logs', { logs: '', status: 'failed' }],
      [
        'operation_cancel',
        { operation_id: 'op-1' },
        'workspace.operation_cancel',
        { cancelled: false, status: 'failed' },
      ],
      ['list_files', {}, 'workspace.list_files', { path: '.', entries: [], truncated: false }],
      ['apply_patch', { patch: 'patch' }, 'workspace.apply_patch', { applied: true, changed_files: [], diff: '' }],
      [
        'edit_file',
        { path: 'a.ts', old_text: 'a', new_text: 'b' },
        'workspace.edit_file',
        { changed: false, path: 'a.ts' },
      ],
      ['write_file', { path: 'a.ts', content: 'a' }, 'workspace.write_file', { written: true, path: 'a.ts' }],
      ['git_status', {}, 'git.status', { clean: true, changed_files: [] }],
    ] as const)(
      'maps a valid plain-text MCP payload to stable %s defaults',
      async (name, input, runtimeTool, expected) => {
        mockCallTool.mockResolvedValue(textResult('plain gateway response'));

        await expect(executeWorkspaceCoreTool(definition(name), input, context([runtimeTool]))).resolves.toEqual(
          expect.objectContaining(expected)
        );
      }
    );
  });

  describe('exec and operations', () => {
    it.each(['env', 'stdin', 'max_output_chars'])(
      'rejects unsupported exec field %s without calling the gateway',
      async (field) => {
        const result = await executeWorkspaceCoreTool(
          definition('exec'),
          { cmd: 'pwd', [field]: field === 'env' ? { A: 'b' } : 'value' },
          context(['workspace.exec'])
        );

        expect(result).toEqual(
          expect.objectContaining({
            code: 'tool_unavailable',
            details: { tool: 'exec', unsupported_field: field },
          })
        );
        expect(mockCallTool).not.toHaveBeenCalled();
      }
    );

    it.each([{}, { cmd: '' }, { cmd: 7 }])('rejects an invalid exec command %#', async (input) => {
      await expect(executeWorkspaceCoreTool(definition('exec'), input, context(['workspace.exec']))).resolves.toEqual(
        expect.objectContaining({ code: 'invalid_arguments', message: 'cmd must be a non-empty string.' })
      );
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('omits invalid optional exec values but preserves false and zero-valued supported options', async () => {
      mockCallTool.mockResolvedValue(structuredResult({ ok: true, status: 'queued', truncated: true }));

      const result = await executeWorkspaceCoreTool(
        definition('exec'),
        { cmd: 'pwd', cwd: '', timeout_ms: 0, async: false, yield_time_ms: 0 },
        context(['workspace.exec'])
      );

      expect(mockCallTool).toHaveBeenCalledWith(
        'workspace.exec',
        { command: 'pwd', async: false, waitMs: 0, captureFileChanges: true },
        9999
      );
      expect(result).toEqual(
        expect.objectContaining({ status: 'queued', truncated: true, stdout: '', stderr: '', cwd: '.' })
      );
    });

    it.each([
      ['canceled', 'cancelled'],
      ['timed_out', 'timed_out'],
      ['running', 'running'],
      ['failed', 'failed'],
      ['custom', 'custom'],
      [null, 'failed'],
    ])('maps exec status %p to %s', async (gatewayStatus, expectedStatus) => {
      mockCallTool.mockResolvedValue(structuredResult({ ok: true, status: gatewayStatus }));

      await expect(
        executeWorkspaceCoreTool(definition('exec'), { cmd: 'pwd' }, context(['workspace.exec']))
      ).resolves.toEqual(expect.objectContaining({ status: expectedStatus }));
    });

    it('preserves timeout failures and provides a fallback reason for uncoded empty failures', async () => {
      mockCallTool
        .mockResolvedValueOnce(structuredResult({ ok: false, status: 'timed_out', error: 'duration exceeded' }))
        .mockResolvedValueOnce(structuredResult({ ok: false }));

      await expect(
        executeWorkspaceCoreTool(definition('exec'), { cmd: 'slow' }, context(['workspace.exec']))
      ).resolves.toEqual(expect.objectContaining({ status: 'timed_out', stderr: 'duration exceeded' }));
      await expect(
        executeWorkspaceCoreTool(definition('exec'), { cmd: 'fail' }, context(['workspace.exec']))
      ).resolves.toEqual(
        expect.objectContaining({ status: 'failed', stderr: 'workspace_core.exec failed in the workspace runtime.' })
      );
    });

    it('validates and normalizes operation status aliases', async () => {
      await expect(executeWorkspaceCoreTool(definition('operation_status'), {}, context([]))).resolves.toEqual(
        expect.objectContaining({ code: 'invalid_arguments' })
      );
      expect(mockCallTool).not.toHaveBeenCalled();

      mockCallTool.mockResolvedValue(
        structuredResult({
          operationId: 'op-1',
          status: 'succeeded',
          exitCode: 0,
          startedAt: 'start',
          endedAt: 'end',
          command: 'pnpm test',
          cwd: 'src',
        })
      );
      await expect(
        executeWorkspaceCoreTool(
          definition('operation_status'),
          { operation_id: 'op-1' },
          context(['workspace.operation_status'])
        )
      ).resolves.toEqual({
        operation_id: 'op-1',
        kind: 'command',
        status: 'completed',
        exit_code: 0,
        started_at: 'start',
        finished_at: 'end',
        command: 'pnpm test',
        cwd: 'src',
      });
    });

    it('returns stable operation defaults when optional snapshot fields are absent', async () => {
      mockCallTool.mockResolvedValue(structuredResult({}));

      await expect(
        executeWorkspaceCoreTool(
          definition('operation_status'),
          { operation_id: 'requested-op' },
          context(['workspace.operation_status'])
        )
      ).resolves.toEqual({
        operation_id: '',
        kind: 'command',
        status: 'failed',
        exit_code: undefined,
        started_at: undefined,
        finished_at: undefined,
        command: undefined,
        cwd: undefined,
      });
    });

    it('rejects operation log cursors and missing operation ids before gateway work', async () => {
      await expect(
        executeWorkspaceCoreTool(definition('operation_logs'), { operation_id: 'op-1', cursor: 'next' }, context([]))
      ).resolves.toEqual(expect.objectContaining({ code: 'tool_unavailable' }));
      await expect(executeWorkspaceCoreTool(definition('operation_logs'), {}, context([]))).resolves.toEqual(
        expect.objectContaining({ code: 'invalid_arguments' })
      );
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('combines operation log streams, remaps combined, and reports truncation', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({
          stdout: 'out',
          stderr: 'err',
          nextCursor: 'next',
          stderrTruncated: true,
          status: 'running',
        })
      );

      const result = await executeWorkspaceCoreTool(
        definition('operation_logs'),
        { operation_id: 'op-1', stream: 'combined', limit_bytes: 100 },
        context(['workspace.operation_logs'])
      );

      expect(mockCallTool).toHaveBeenCalledWith(
        'workspace.operation_logs',
        { operationId: 'op-1', stream: 'both', maxChars: 100 },
        9999
      );
      expect(result).toEqual({
        operation_id: 'op-1',
        logs: 'out\nerr',
        next_cursor: 'next',
        truncated: true,
        status: 'running',
      });
    });

    it('prefers direct operation log text and passes through policy failures', async () => {
      mockCallTool
        .mockResolvedValueOnce(structuredResult({ logs: 'direct', stdout: 'ignored', status: 'failed' }))
        .mockResolvedValueOnce(structuredResult({ ok: false, code: 'operation_not_live', message: 'gone' }));

      await expect(
        executeWorkspaceCoreTool(
          definition('operation_logs'),
          { operation_id: 'op-1', stream: 'stdout' },
          context(['workspace.operation_logs'])
        )
      ).resolves.toEqual(expect.objectContaining({ logs: 'direct', status: 'failed' }));
      await expect(
        executeWorkspaceCoreTool(
          definition('operation_logs'),
          { operation_id: 'op-1' },
          context(['workspace.operation_logs'])
        )
      ).resolves.toEqual(expect.objectContaining({ code: 'operation_not_live' }));
    });

    it('returns stable empty operation logs when optional fields are absent', async () => {
      mockCallTool.mockResolvedValue(structuredResult({}));

      await expect(
        executeWorkspaceCoreTool(
          definition('operation_logs'),
          { operation_id: 'op-1' },
          context(['workspace.operation_logs'])
        )
      ).resolves.toEqual({
        operation_id: 'op-1',
        logs: '',
        next_cursor: undefined,
        truncated: false,
        status: 'failed',
      });
    });

    it('validates operation cancellation and recognizes both cancellation signals', async () => {
      await expect(executeWorkspaceCoreTool(definition('operation_cancel'), {}, context([]))).resolves.toEqual(
        expect.objectContaining({ code: 'invalid_arguments' })
      );

      mockCallTool
        .mockResolvedValueOnce(structuredResult({ status: 'running', cancellationRequested: true }))
        .mockResolvedValueOnce(structuredResult({ status: 'canceled' }));
      await expect(
        executeWorkspaceCoreTool(
          definition('operation_cancel'),
          { operation_id: 'op-1' },
          context(['workspace.operation_cancel'])
        )
      ).resolves.toEqual({ operation_id: 'op-1', cancelled: true, status: 'running' });
      await expect(
        executeWorkspaceCoreTool(
          definition('operation_cancel'),
          { operation_id: 'op-2' },
          context(['workspace.operation_cancel'])
        )
      ).resolves.toEqual({ operation_id: 'op-2', cancelled: true, status: 'cancelled' });
    });

    it('reports an uncancelled failed operation when cancellation fields are absent', async () => {
      mockCallTool.mockResolvedValue(structuredResult({}));

      await expect(
        executeWorkspaceCoreTool(
          definition('operation_cancel'),
          { operation_id: 'op-1' },
          context(['workspace.operation_cancel'])
        )
      ).resolves.toEqual({ operation_id: 'op-1', cancelled: false, status: 'failed' });
    });
  });

  describe('long-running services', () => {
    it('validates start_service and maps every supported option and snapshot field', async () => {
      await expect(executeWorkspaceCoreTool(definition('start_service'), {}, context([]))).resolves.toEqual(
        expect.objectContaining({ code: 'invalid_arguments' })
      );
      mockCallTool.mockResolvedValue(
        structuredResult({
          serviceName: 'web',
          status: 'running',
          running: true,
          pid: 0,
          port: 3000,
          startedAt: 'now',
          exitCode: 0,
          stdout: '',
          stderr: 'warning',
          error: 'recovering',
        })
      );

      const result = await executeWorkspaceCoreTool(
        definition('start_service'),
        {
          command: 'pnpm dev',
          service_name: 'web',
          cwd: 'app',
          port: 3000,
          restart: false,
          wait_ms: 0,
        },
        context(['workspace.service_start'])
      );

      expect(mockCallTool).toHaveBeenCalledWith(
        'workspace.service_start',
        { command: 'pnpm dev', serviceName: 'web', cwd: 'app', port: 3000, restart: false, waitMs: 0 },
        9999
      );
      expect(result).toEqual({
        service_name: 'web',
        status: 'running',
        running: true,
        pid: 0,
        port: 3000,
        started_at: 'now',
        exit_code: 0,
        stdout: '',
        stderr: 'warning',
        error: 'recovering',
      });
    });

    it('maps service status defaults and forwards optional inspection controls', async () => {
      mockCallTool.mockResolvedValue(structuredResult({ name: 'web', status: 'stopped' }));

      const result = await executeWorkspaceCoreTool(
        definition('service_status'),
        { service_name: 'web', include_logs: false, max_chars: 0 },
        context(['workspace.service_status'])
      );

      expect(mockCallTool).toHaveBeenCalledWith(
        'workspace.service_status',
        { serviceName: 'web', includeLogs: false, maxChars: 0 },
        9999
      );
      expect(result).toEqual({ service_name: 'web', status: 'stopped', running: false });
    });

    it.each(['start_service', 'service_status'] as const)('passes through %s policy envelopes', async (name) => {
      mockCallTool.mockResolvedValue(structuredResult({ ok: false, code: 'workspace_unavailable', message: 'gone' }));
      const input = name === 'start_service' ? { command: 'pnpm dev' } : {};

      await expect(
        executeWorkspaceCoreTool(
          definition(name),
          input,
          context([name === 'start_service' ? 'workspace.service_start' : 'workspace.service_status'])
        )
      ).resolves.toEqual(expect.objectContaining({ code: 'workspace_unavailable' }));
    });
  });

  describe('workspace reads and search', () => {
    it.each([
      [{ path: 'a.ts', offset: 1 }, 'offset'],
      [{ path: 'a.ts', encoding: 'base64' }, 'encoding'],
    ])('rejects unsupported read_file input %# without gateway work', async (input, field) => {
      const result = await executeWorkspaceCoreTool(definition('read_file'), input, context(['workspace.read_file']));

      expect(result).toEqual(
        expect.objectContaining({
          code: 'tool_unavailable',
          details: { tool: 'read_file', unsupported_field: field },
        })
      );
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it.each([{}, { path: '' }, { path: 3 }])('rejects invalid read_file path %#', async (input) => {
      await expect(
        executeWorkspaceCoreTool(definition('read_file'), input, context(['workspace.read_file']))
      ).resolves.toEqual(expect.objectContaining({ code: 'invalid_arguments' }));
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('maps read_file defaults and snake_case gateway fields', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({
          path: '',
          content: 'body',
          start_line: 0,
          end_line: 2,
          total_lines: 2,
          truncated: true,
          binary: true,
          media_type: 'application/octet-stream',
          sha256: 'sha',
          modified_at: 'mtime',
        })
      );

      const result = await executeWorkspaceCoreTool(
        definition('read_file'),
        { path: 'file.bin', limit: 0 },
        context(['workspace.read_file'])
      );

      expect(mockCallTool).toHaveBeenCalledWith('workspace.read_file', { path: 'file.bin' }, 9999);
      expect(result).toEqual({
        path: 'file.bin',
        content: 'body',
        start_line: 0,
        end_line: 2,
        total_lines: 2,
        truncated: true,
        binary: true,
        media_type: 'application/octet-stream',
        sha256: 'sha',
        mtime: 'mtime',
      });
    });

    it('maps list_files aliases, entry kinds, optional metadata, and inferred truncation', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({
          files: [
            'README.md',
            { name: 'src', kind: 'directory', bytes: 0, modifiedAt: 'today' },
            { path: 'latest', type: 'link' },
            { path: 'socket', kind: 'socket' },
            { kind: 'file' },
            null,
          ],
        })
      );

      const result = await executeWorkspaceCoreTool(
        definition('list_files'),
        { depth: 0, include_hidden: false, respect_gitignore: true, limit: 4 },
        context(['workspace.list_files'])
      );

      expect(mockCallTool).toHaveBeenCalledWith(
        'workspace.list_files',
        { path: '.', depth: 0, includeHidden: false, respectGitignore: true, limit: 4 },
        9999
      );
      expect(result).toEqual({
        path: '.',
        entries: [
          { path: 'README.md', kind: 'file' },
          { path: 'src', kind: 'directory', size: 0, mtime: 'today' },
          { path: 'latest', kind: 'symlink' },
          { path: 'socket', kind: 'other' },
        ],
        truncated: true,
      });
    });

    it('honors explicit list truncation and maps symlink aliases', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({ path: 'src', entries: [{ path: 'current', kind: 'symlink' }], truncated: false })
      );

      await expect(
        executeWorkspaceCoreTool(definition('list_files'), { path: 'src', limit: 1 }, context(['workspace.list_files']))
      ).resolves.toEqual({
        path: 'src',
        entries: [{ path: 'current', kind: 'symlink' }],
        truncated: false,
      });
    });

    it('returns stable list defaults when optional gateway fields are absent', async () => {
      mockCallTool.mockResolvedValue(structuredResult({}));

      await expect(
        executeWorkspaceCoreTool(definition('list_files'), { path: 'src' }, context(['workspace.list_files']))
      ).resolves.toEqual({ path: 'src', entries: [], truncated: false });
    });

    it.each([
      [{ pattern: '*.ts', cwd: 'src' }, 'cwd'],
      [{ pattern: '*.ts', respect_gitignore: true }, 'respect_gitignore'],
    ])('rejects unsupported glob input %#', async (input, field) => {
      await expect(executeWorkspaceCoreTool(definition('glob'), input, context([]))).resolves.toEqual(
        expect.objectContaining({
          code: 'tool_unavailable',
          details: { tool: 'glob', unsupported_field: field },
        })
      );
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('validates glob patterns and maps bounded matches', async () => {
      await expect(executeWorkspaceCoreTool(definition('glob'), {}, context([]))).resolves.toEqual(
        expect.objectContaining({ code: 'invalid_arguments' })
      );
      mockCallTool.mockResolvedValue(structuredResult({ matches: ['a.ts', '', 'b.ts'] }));

      const result = await executeWorkspaceCoreTool(
        definition('glob'),
        { pattern: '**/*.ts', limit: 2 },
        context(['workspace.glob'])
      );

      expect(mockCallTool).toHaveBeenCalledWith('workspace.glob', { pattern: '**/*.ts', limit: 2 }, 9999);
      expect(result).toEqual({ matches: ['a.ts', 'b.ts'], truncated: true });
    });

    it('maps absent glob matches and omits a zero limit', async () => {
      mockCallTool.mockResolvedValue(structuredResult({ matches: null }));

      await expect(
        executeWorkspaceCoreTool(definition('glob'), { pattern: '*.md', limit: 0 }, context(['workspace.glob']))
      ).resolves.toEqual({ matches: [], truncated: false });
      expect(mockCallTool).toHaveBeenCalledWith('workspace.glob', { pattern: '*.md' }, 9999);
    });

    it.each([
      [{ pattern: 'term', glob: '*.ts' }, 'glob'],
      [{ pattern: 'term', context_lines: 2 }, 'context_lines'],
      [{ pattern: 'term', respect_gitignore: true }, 'respect_gitignore'],
      [{ pattern: 'term', regex: true }, 'regex'],
    ])('rejects unsupported grep input %#', async (input, field) => {
      await expect(executeWorkspaceCoreTool(definition('grep'), input, context([]))).resolves.toEqual(
        expect.objectContaining({
          code: 'tool_unavailable',
          details: { tool: 'grep', unsupported_field: field },
        })
      );
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('validates grep patterns and maps normalized match context', async () => {
      await expect(executeWorkspaceCoreTool(definition('grep'), {}, context([]))).resolves.toEqual(
        expect.objectContaining({ code: 'invalid_arguments' })
      );
      mockCallTool.mockResolvedValue(
        structuredResult({
          matches: [
            { path: 'a.ts', line: 0, text: 'term', before: ['before', 1], after: ['after'] },
            { path: 1, line: 'bad', text: null },
          ],
        })
      );

      const result = await executeWorkspaceCoreTool(
        definition('grep'),
        { pattern: 'term', cwd: 'src', case_sensitive: false, limit: 2 },
        context(['workspace.grep'])
      );

      expect(mockCallTool).toHaveBeenCalledWith(
        'workspace.grep',
        { pattern: 'term', path: 'src', caseSensitive: false, maxResults: 2 },
        9999
      );
      expect(result).toEqual({
        matches: [
          { path: 'a.ts', line: 0, text: 'term', before: ['before'], after: ['after'] },
          { path: '', line: 0, text: '' },
        ],
        truncated: true,
      });
    });

    it('returns an empty grep result for non-array payload matches', async () => {
      mockCallTool.mockResolvedValue(structuredResult({ matches: 'none' }));

      await expect(
        executeWorkspaceCoreTool(definition('grep'), { pattern: 'term' }, context(['workspace.grep']))
      ).resolves.toEqual({ matches: [], truncated: false });
    });
  });

  describe('workspace writes', () => {
    it('validates edit_file inputs and rejects unsupported compare-and-swap', async () => {
      await expect(
        executeWorkspaceCoreTool(
          definition('edit_file'),
          { path: 'a.ts', old_text: 'a', new_text: 'b', expected_sha256: 'sha' },
          context([])
        )
      ).resolves.toEqual(expect.objectContaining({ code: 'tool_unavailable' }));
      for (const input of [{}, { path: 'a.ts', old_text: 1, new_text: '' }, { path: '', old_text: '', new_text: '' }]) {
        await expect(executeWorkspaceCoreTool(definition('edit_file'), input, context([]))).resolves.toEqual(
          expect.objectContaining({ code: 'invalid_arguments' })
        );
      }
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('maps edit_file direct diffs, replacement counts, and hash aliases', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({ path: 'renamed.ts', replacements: 2, diff: 'patch', new_sha256: 'new-sha' })
      );

      const result = await executeWorkspaceCoreTool(
        definition('edit_file'),
        { path: 'a.ts', old_text: '', new_text: 'prefix', replace_all: false },
        context(['workspace.edit_file'])
      );

      expect(mockCallTool).toHaveBeenCalledWith(
        'workspace.edit_file',
        { path: 'a.ts', oldText: '', newText: 'prefix', replaceAll: false },
        9999
      );
      expect(result).toEqual({
        changed: true,
        path: 'renamed.ts',
        replacements: 2,
        diff: 'patch',
        new_sha256: 'new-sha',
      });
    });

    it('maps edit_file fileChanges fallbacks and unchanged output', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({ fileChanges: [{ unifiedDiff: 'file patch', newSha256: 'sha' }] })
      );

      await expect(
        executeWorkspaceCoreTool(
          definition('edit_file'),
          { path: 'a.ts', old_text: 'old', new_text: 'new' },
          context(['workspace.edit_file'])
        )
      ).resolves.toEqual({
        changed: false,
        path: 'a.ts',
        replacements: 0,
        diff: 'file patch',
        new_sha256: 'sha',
      });
    });

    it('maps an edit success without optional change metadata', async () => {
      mockCallTool.mockResolvedValue(structuredResult({}));

      await expect(
        executeWorkspaceCoreTool(
          definition('edit_file'),
          { path: 'a.ts', old_text: 'old', new_text: 'new' },
          context(['workspace.edit_file'])
        )
      ).resolves.toEqual({ changed: false, path: 'a.ts', replacements: 0, diff: '' });
    });

    it('validates write_file unsupported options and required values', async () => {
      await expect(
        executeWorkspaceCoreTool(
          definition('write_file'),
          { path: 'a.ts', content: '', expected_sha256: 'sha' },
          context([])
        )
      ).resolves.toEqual(expect.objectContaining({ code: 'tool_unavailable' }));
      await expect(
        executeWorkspaceCoreTool(
          definition('write_file'),
          { path: 'a.ts', content: '', create_dirs: false },
          context([])
        )
      ).resolves.toEqual(expect.objectContaining({ code: 'tool_unavailable' }));
      for (const input of [{}, { path: '', content: '' }, { path: 'a.ts', content: 3 }]) {
        await expect(executeWorkspaceCoreTool(definition('write_file'), input, context([]))).resolves.toEqual(
          expect.objectContaining({ code: 'invalid_arguments' })
        );
      }
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('writes empty content and maps direct diff metadata', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({ path: 'actual.ts', diff: 'direct patch', newSha256: 'new-sha' })
      );

      await expect(
        executeWorkspaceCoreTool(
          definition('write_file'),
          { path: 'a.ts', content: '' },
          context(['workspace.write_file'])
        )
      ).resolves.toEqual({
        written: true,
        path: 'actual.ts',
        diff: 'direct patch',
        new_sha256: 'new-sha',
      });
    });

    it('maps a write success without optional change metadata', async () => {
      mockCallTool.mockResolvedValue(structuredResult({}));

      await expect(
        executeWorkspaceCoreTool(
          definition('write_file'),
          { path: 'a.ts', content: 'content' },
          context(['workspace.write_file'])
        )
      ).resolves.toEqual({ written: true, path: 'a.ts', diff: '' });
    });

    it('validates patch text, format, and expected_files before gateway work', async () => {
      for (const input of [
        {},
        { patch: '' },
        { patch: 'patch', format: 'unified' },
        { patch: 'patch', expected_files: {} },
      ]) {
        await expect(executeWorkspaceCoreTool(definition('apply_patch'), input, context([]))).resolves.toEqual(
          expect.objectContaining({ code: 'invalid_arguments' })
        );
      }
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('filters incomplete expected file entries and maps explicit apply_patch fields', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({ applied: false, changed_files: ['a.ts'], diff: 'direct', warnings: [] })
      );

      const result = await executeWorkspaceCoreTool(
        definition('apply_patch'),
        {
          patch: 'patch',
          expected_files: [null, { path: '' }, { path: 'a.ts' }, { path: 'b.ts', sha256: 'sha' }],
        },
        context(['workspace.apply_patch'])
      );

      expect(mockCallTool).toHaveBeenCalledWith(
        'workspace.apply_patch',
        { patch: 'patch', expectedFiles: [{ path: 'a.ts' }, { path: 'b.ts', sha256: 'sha' }] },
        9999
      );
      expect(result).toEqual({ applied: false, changed_files: ['a.ts'], diff: 'direct', warnings: [] });
    });

    it('maps changedFiles aliases and joins multiple file diffs when optional patch metadata is absent', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({
          changedFiles: ['a.ts', 4],
          fileChanges: [
            { path: 'a.ts', diff: 'one' },
            { path: 'b.ts', unifiedDiff: 'two' },
            { path: '', diff: '' },
          ],
        })
      );

      await expect(
        executeWorkspaceCoreTool(
          definition('apply_patch'),
          { patch: 'patch', format: 'codex_v4a', reason: 'test' },
          context(['workspace.apply_patch'])
        )
      ).resolves.toEqual({ applied: true, changed_files: ['a.ts'], diff: 'one\ntwo' });
    });

    it('ignores file change entries without a path when deriving changed files', async () => {
      mockCallTool.mockResolvedValue(
        structuredResult({ fileChanges: [{ unifiedDiff: 'one' }, { path: '', unifiedDiff: 'two' }] })
      );

      await expect(
        executeWorkspaceCoreTool(definition('apply_patch'), { patch: 'patch' }, context(['workspace.apply_patch']))
      ).resolves.toEqual({ applied: true, changed_files: [], diff: 'one\ntwo' });
    });
  });

  describe('publication and git reads', () => {
    it.each([
      [{ port: 3000, path: '/' }, 'path'],
      [{ port: 3000, healthcheck_path: '/health' }, 'healthcheck_path'],
      [{ port: 3000, expected_status: 204 }, 'expected_status'],
    ])('rejects unsupported publish_http input %#', async (input, field) => {
      await expect(executeWorkspaceCoreTool(definition('publish_http'), input, context([]))).resolves.toEqual(
        expect.objectContaining({
          code: 'tool_unavailable',
          details: { tool: 'publish_http', unsupported_field: field },
        })
      );
      expect(mockPublishChatHttpPort).not.toHaveBeenCalled();
    });

    it.each([{}, { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: '3000' }])(
      'rejects invalid publication port %#',
      async (input) => {
        await expect(executeWorkspaceCoreTool(definition('publish_http'), input, context([]))).resolves.toEqual(
          expect.objectContaining({ code: 'invalid_arguments' })
        );
        expect(mockPublishChatHttpPort).not.toHaveBeenCalled();
      }
    );

    it('publishes and reports verified health using session/user scope', async () => {
      const result = await executeWorkspaceCoreTool(definition('publish_http'), { port: 1 }, context([]));

      expect(mockPublishChatHttpPort).toHaveBeenCalledWith({
        sessionId: 'session-123',
        userId: 'user-123',
        port: 1,
      });
      expect(result).toEqual({
        url: 'https://preview.example.test',
        port: 1,
        healthy: true,
        auth_scope: 'session_user',
        status: 200,
        checked_url: 'https://preview.example.test',
        message: 'Preview published and verified.',
      });
    });

    it('maps unhealthy and unavailable publication outcomes without hiding reasons', async () => {
      mockPublishChatHttpPort
        .mockResolvedValueOnce({
          url: 'https://preview.example.test',
          upstreamHealth: { ok: false, message: 'connection refused' },
        })
        .mockResolvedValueOnce({ url: 'https://preview.example.test' })
        .mockRejectedValueOnce(new Error('workspace sleeping'))
        .mockRejectedValueOnce('gateway reset');

      await expect(executeWorkspaceCoreTool(definition('publish_http'), { port: 3000 }, context([]))).resolves.toEqual(
        expect.objectContaining({ healthy: false, status: undefined, message: 'connection refused' })
      );
      await expect(executeWorkspaceCoreTool(definition('publish_http'), { port: 3000 }, context([]))).resolves.toEqual(
        expect.objectContaining({ healthy: false, message: 'Preview published.' })
      );
      await expect(executeWorkspaceCoreTool(definition('publish_http'), { port: 3000 }, context([]))).resolves.toEqual(
        expectPolicy('workspace_unavailable', 'workspace sleeping')
      );
      await expect(executeWorkspaceCoreTool(definition('publish_http'), { port: 3000 }, context([]))).resolves.toEqual(
        expectPolicy('workspace_unavailable', 'gateway reset')
      );
    });

    it('rejects git_status cwd and parses porcelain branch/staging state', async () => {
      await expect(executeWorkspaceCoreTool(definition('git_status'), { cwd: 'src' }, context([]))).resolves.toEqual(
        expect.objectContaining({ code: 'tool_unavailable' })
      );
      mockCallTool.mockResolvedValue(
        structuredResult({ stdout: '## feature/test...origin/feature/test\nM  staged.ts\n M unstaged.ts\n?? new.ts\n' })
      );

      const result = await executeWorkspaceCoreTool(definition('git_status'), {}, context(['git.status']));

      expect(result).toEqual({
        branch: 'feature/test',
        clean: false,
        changed_files: [
          { path: 'staged.ts', status: 'M', staged: true },
          { path: 'unstaged.ts', status: 'M', staged: false },
          { path: 'new.ts', status: '??', staged: false },
        ],
      });
    });

    it('maps a clean git status without branch metadata', async () => {
      mockCallTool.mockResolvedValue(structuredResult({ stdout: '' }));

      await expect(executeWorkspaceCoreTool(definition('git_status'), {}, context(['git.status']))).resolves.toEqual({
        clean: true,
        changed_files: [],
      });
    });

    it('rejects git_diff cwd and maps staged path diffs with byte truncation', async () => {
      await expect(executeWorkspaceCoreTool(definition('git_diff'), { cwd: 'src' }, context([]))).resolves.toEqual(
        expect.objectContaining({ code: 'tool_unavailable' })
      );
      mockCallTool.mockResolvedValue(structuredResult({ stdout: '123456789' }));

      const result = await executeWorkspaceCoreTool(
        definition('git_diff'),
        { staged: false, path: 'a.ts', max_bytes: 5 },
        context(['git.diff'])
      );

      expect(mockCallTool).toHaveBeenCalledWith('git.diff', { staged: false, path: 'a.ts' }, 9999);
      expect(result).toEqual({ diff: '12345', truncated: true });
    });

    it('returns complete direct git diff content and defaults non-record payloads', async () => {
      mockCallTool
        .mockResolvedValueOnce(structuredResult({ diff: 'patch' }))
        .mockResolvedValueOnce(structuredResult({}))
        .mockResolvedValueOnce(structuredResult(null));

      await expect(
        executeWorkspaceCoreTool(definition('git_diff'), { max_bytes: 100 }, context(['git.diff']))
      ).resolves.toEqual({ diff: 'patch', truncated: false });
      await expect(executeWorkspaceCoreTool(definition('git_diff'), {}, context(['git.diff']))).resolves.toEqual({
        diff: '',
        truncated: false,
      });
      await expect(executeWorkspaceCoreTool(definition('git_diff'), {}, context(['git.diff']))).resolves.toEqual({
        diff: '',
        truncated: false,
      });
    });
  });
});
