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

import type AgentSession from 'server/models/AgentSession';
import AgentSessionService from 'server/services/agentSession';
import { McpClientManager } from 'server/services/agentRuntime/mcp/client';
import type { McpCallToolResult, ResolvedMcpServer } from 'server/services/agentRuntime/mcp/types';
import type { RequestUserIdentity } from 'server/lib/get-user';
import type { WorkspaceCoreToolDefinition, WorkspaceCoreToolName } from './toolDefinitions';
import {
  capabilityRequiredResult,
  invalidArgumentsResult,
  policyErrorResult,
  toolUnavailableResult,
  workspaceUnavailableResult,
  type ToolPolicyErrorCode,
  type ToolPolicyRetry,
  type WorkspaceCoreCapability,
} from './result';

type WorkspaceCoreAdapterContext = {
  session: AgentSession;
  userIdentity: RequestUserIdentity;
  workspaceGatewayServer: ResolvedMcpServer | null;
  resolveWorkspaceGatewayServer?: () => Promise<ResolvedMcpServer | null>;
  timeoutMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function readPropertyString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const text = readString(value[key]);
    if (text !== undefined) {
      return text;
    }
  }

  return undefined;
}

function readPropertyNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const number = readNumber(value[key]);
    if (number !== undefined) {
      return number;
    }
  }

  return undefined;
}

function readPropertyBoolean(value: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const bool = readBoolean(value[key]);
    if (bool !== undefined) {
      return bool;
    }
  }

  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function firstUnsupportedField(input: Record<string, unknown>, fieldNames: string[]): string | null {
  return fieldNames.find((fieldName) => hasValue(input[fieldName])) || null;
}

function unsupportedFieldResult(toolName: WorkspaceCoreToolName, fieldName: string) {
  return toolUnavailableResult(
    toolName,
    `workspace_core.${toolName} cannot enforce '${fieldName}' with the current workspace runtime.`,
    { unsupported_field: fieldName }
  );
}

function parseMcpPayload(result: McpCallToolResult): unknown {
  if ('structuredContent' in result && result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  const content = Array.isArray(result.content) ? result.content : [];
  const firstText = content.find((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string') as
    | { text?: string }
    | undefined;
  if (!firstText?.text) {
    return result;
  }

  try {
    return JSON.parse(firstText.text);
  } catch {
    return firstText.text;
  }
}

async function callGatewayTool({
  server,
  toolName,
  runtimeToolName,
  input,
  timeoutMs,
}: {
  server: ResolvedMcpServer;
  toolName: WorkspaceCoreToolName;
  runtimeToolName: string;
  input: Record<string, unknown>;
  timeoutMs: number;
}): Promise<unknown> {
  if (!server.discoveredTools.some((tool) => tool.name === runtimeToolName)) {
    return toolUnavailableResult(toolName, undefined, {
      runtime_tool: runtimeToolName,
    });
  }

  const client = new McpClientManager();
  try {
    await client.connect(server.transport, server.timeout);
    const result = await client.callTool(runtimeToolName, input, timeoutMs);
    return parseMcpPayload(result);
  } catch (error) {
    return policyErrorResult({
      code: 'workspace_unavailable',
      retry: 'after_workspace_ready',
      message: error instanceof Error ? error.message : String(error),
      details: { runtime_tool: runtimeToolName },
    });
  } finally {
    await client.close();
  }
}

function mapOperationStatus(status: unknown) {
  switch (status) {
    case 'succeeded':
      return 'completed';
    case 'canceled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'queued':
      return 'queued';
    default:
      return typeof status === 'string' ? status : 'failed';
  }
}

const TOOL_POLICY_ERROR_CODES: ReadonlySet<ToolPolicyErrorCode> = new Set([
  'approval_pending',
  'approval_denied',
  'policy_denied',
  'workspace_unavailable',
  'stale_runtime_generation',
  'protected_path',
  'network_denied',
  'tool_unavailable',
  'operation_not_live',
  'invalid_arguments',
]);

const TOOL_POLICY_RETRIES: ReadonlySet<ToolPolicyRetry> = new Set([
  'immediate',
  'after_approval',
  'after_workspace_ready',
  'never',
]);

function isToolPolicyErrorCode(
  value: string | undefined
): value is Exclude<ToolPolicyErrorCode, 'capability_required'> {
  return Boolean(value && value !== 'capability_required' && TOOL_POLICY_ERROR_CODES.has(value as ToolPolicyErrorCode));
}

function readRetry(value: unknown, fallback: ToolPolicyRetry): ToolPolicyRetry {
  return typeof value === 'string' && TOOL_POLICY_RETRIES.has(value as ToolPolicyRetry)
    ? (value as ToolPolicyRetry)
    : fallback;
}

function readWorkspaceCoreCapabilities(value: unknown): WorkspaceCoreCapability[] {
  return Array.isArray(value) ? value.filter((item): item is WorkspaceCoreCapability => typeof item === 'string') : [];
}

function mapGatewayPolicyResult(toolName: WorkspaceCoreToolName, payload: unknown) {
  if (!isRecord(payload) || payload.ok !== false) {
    return null;
  }

  const code = readString(payload.code);
  const message = readString(payload.message) || readString(payload.error) || `workspace_core.${toolName} failed.`;
  const details = isRecord(payload.details) ? payload.details : undefined;

  if (code === 'capability_required') {
    return capabilityRequiredResult({
      requiredCapabilities: readWorkspaceCoreCapabilities(payload.required_capabilities),
      approvalRequired: readBoolean(payload.approval_required) ?? false,
      approvalId: readString(payload.approval_id),
      retry:
        payload.retry === 'after_approval' || payload.retry === 'after_workspace_ready' || payload.retry === 'never'
          ? payload.retry
          : 'never',
      message,
      auditId: readString(payload.audit_id),
    });
  }

  if (isToolPolicyErrorCode(code)) {
    return policyErrorResult({
      code,
      message,
      retry: readRetry(payload.retry, code === 'invalid_arguments' ? 'immediate' : 'never'),
      details,
      auditId: readString(payload.audit_id),
    });
  }

  return invalidArgumentsResult(toolName, message, details);
}

function mapCommandResult(payload: unknown) {
  const value = isRecord(payload) ? payload : {};
  const status = mapOperationStatus(value.status);
  const stdout = readPropertyString(value, ['stdout']) || '';
  const stderr = readPropertyString(value, ['stderr']) || '';
  const truncated =
    readPropertyBoolean(value, ['truncated']) === true ||
    value.stdoutTruncated === true ||
    value.stderrTruncated === true;

  return {
    operation_id: readPropertyString(value, ['operation_id', 'operationId']),
    status: status === 'succeeded' ? 'completed' : status,
    exit_code: readPropertyNumber(value, ['exit_code', 'exitCode']),
    stdout,
    stderr,
    truncated,
    cwd: readPropertyString(value, ['cwd']) || '.',
    started_at: readPropertyString(value, ['started_at', 'startedAt']) || new Date().toISOString(),
    finished_at: readPropertyString(value, ['finished_at', 'endedAt']),
  };
}

function mapOperationSnapshot(payload: unknown) {
  const value = isRecord(payload) ? payload : {};
  return {
    operation_id: readPropertyString(value, ['operation_id', 'operationId']) || '',
    kind: 'command' as const,
    status: mapOperationStatus(value.status),
    exit_code: readPropertyNumber(value, ['exit_code', 'exitCode']),
    started_at: readPropertyString(value, ['started_at', 'startedAt']),
    finished_at: readPropertyString(value, ['finished_at', 'endedAt']),
    command: readPropertyString(value, ['command']),
    cwd: readPropertyString(value, ['cwd']),
  };
}

function mapGatewayFailure(toolName: WorkspaceCoreToolName, payload: unknown) {
  const policy = mapGatewayPolicyResult(toolName, payload);
  if (policy) {
    return policy;
  }

  if (!isRecord(payload) || payload.ok !== false) {
    return null;
  }

  return invalidArgumentsResult(
    toolName,
    readString(payload.error) || `workspace_core.${toolName} failed in the workspace runtime.`,
    isRecord(payload.details) ? payload.details : { details: payload.details }
  );
}

function fileChangeDiff(payload: Record<string, unknown>): { diff?: string; newSha256?: string } {
  const firstChange =
    Array.isArray(payload.fileChanges) && isRecord(payload.fileChanges[0]) ? payload.fileChanges[0] : {};
  return {
    diff: readPropertyString(payload, ['diff']) || readPropertyString(firstChange, ['unifiedDiff']) || '',
    newSha256:
      readPropertyString(payload, ['new_sha256', 'newSha256']) || readPropertyString(firstChange, ['newSha256']),
  };
}

function mapListEntryKind(kind: unknown): 'file' | 'directory' | 'symlink' | 'other' {
  switch (kind) {
    case 'file':
      return 'file';
    case 'directory':
    case 'dir':
      return 'directory';
    case 'symlink':
    case 'link':
      return 'symlink';
    default:
      return 'other';
  }
}

function mapListFilesResult(payload: unknown, requestedPath: string, limit?: number) {
  const value = isRecord(payload) ? payload : {};
  const rawEntries = Array.isArray(value.entries) ? value.entries : Array.isArray(value.files) ? value.files : [];
  const entries = rawEntries.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [{ path: entry, kind: 'file' as const }];
    }

    if (!isRecord(entry)) {
      return [];
    }

    const entryPath = readPropertyString(entry, ['path', 'name']);
    const size = readPropertyNumber(entry, ['size', 'bytes']);
    const mtime = readPropertyString(entry, ['mtime', 'modified_at', 'modifiedAt']);
    if (!entryPath) {
      return [];
    }

    return [
      {
        path: entryPath,
        kind: mapListEntryKind(entry.kind || entry.type),
        ...(size !== undefined ? { size } : {}),
        ...(mtime !== undefined ? { mtime } : {}),
      },
    ];
  });

  return {
    path: readPropertyString(value, ['path']) || requestedPath,
    entries,
    truncated: readPropertyBoolean(value, ['truncated']) ?? Boolean(limit && entries.length >= limit),
  };
}

function mapApplyPatchResult(payload: unknown) {
  const value = isRecord(payload) ? payload : {};
  const fileChanges = Array.isArray(value.fileChanges) ? value.fileChanges.filter(isRecord) : [];
  const changedFiles =
    readStringArray(value.changed_files) ||
    readStringArray(value.changedFiles) ||
    fileChanges.flatMap((change) => {
      const path = readPropertyString(change, ['path']);
      return path ? [path] : [];
    });
  const diff =
    readPropertyString(value, ['diff']) ||
    fileChanges
      .flatMap((change) => {
        const unifiedDiff = readPropertyString(change, ['unifiedDiff', 'diff']);
        return unifiedDiff ? [unifiedDiff] : [];
      })
      .join('\n');
  const warnings = readStringArray(value.warnings);

  return {
    applied: readPropertyBoolean(value, ['applied']) ?? true,
    changed_files: changedFiles,
    diff,
    ...(warnings ? { warnings } : {}),
  };
}

function mapGitStatus(payload: unknown) {
  const stdout = isRecord(payload) ? readString(payload.stdout) || '' : '';
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const branchLine = lines.find((line) => line.startsWith('## '));
  const branch = branchLine?.slice(3).split('...')[0]?.trim();
  const changedFiles = lines
    .filter((line) => !line.startsWith('## '))
    .map((line) => {
      const status = line.slice(0, 2);
      return {
        path: line.slice(3).trim(),
        status: status.trim() || status,
        staged: Boolean(status[0] && status[0] !== ' ' && status[0] !== '?'),
      };
    });

  return {
    ...(branch ? { branch } : {}),
    clean: changedFiles.length === 0,
    changed_files: changedFiles,
  };
}

async function executeGatewayAdapter(
  definition: WorkspaceCoreToolDefinition,
  input: Record<string, unknown>,
  context: WorkspaceCoreAdapterContext
) {
  const workspaceGatewayServer =
    context.workspaceGatewayServer || (await context.resolveWorkspaceGatewayServer?.()) || null;
  if (!workspaceGatewayServer || !definition.runtimeToolName) {
    return workspaceUnavailableResult();
  }

  const payload = await callGatewayTool({
    server: workspaceGatewayServer,
    toolName: definition.name,
    runtimeToolName: definition.runtimeToolName,
    input,
    timeoutMs: context.timeoutMs,
  });
  const policy = mapGatewayPolicyResult(definition.name, payload);
  if (policy) {
    return policy;
  }

  const failure = definition.name === 'exec' ? null : mapGatewayFailure(definition.name, payload);
  if (failure) {
    return failure;
  }

  return payload;
}

async function executeExec(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  const unsupported = firstUnsupportedField(input, ['env', 'stdin', 'max_output_chars']);
  if (unsupported) {
    return unsupportedFieldResult('exec', unsupported);
  }

  const command = readString(input.cmd);
  if (!command) {
    return invalidArgumentsResult('exec', 'cmd must be a non-empty string.');
  }

  const payload = await executeGatewayAdapter(
    {
      name: 'exec',
      runtimeToolName: 'workspace.exec',
    } as WorkspaceCoreToolDefinition,
    {
      command,
      ...(readString(input.cwd) ? { cwd: readString(input.cwd) } : {}),
      ...(readNumber(input.timeout_ms) ? { maxDurationMs: readNumber(input.timeout_ms) } : {}),
      ...(typeof input.async === 'boolean' ? { async: input.async } : {}),
      ...(readNumber(input.yield_time_ms) !== undefined ? { waitMs: readNumber(input.yield_time_ms) } : {}),
      captureFileChanges: true,
    },
    context
  );

  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  return mapCommandResult(payload);
}

async function executeOperationStatus(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  const operationId = readString(input.operation_id);
  if (!operationId) {
    return invalidArgumentsResult('operation_status', 'operation_id must be a non-empty string.');
  }

  const payload = await executeGatewayAdapter(
    {
      name: 'operation_status',
      runtimeToolName: 'workspace.operation_status',
    } as WorkspaceCoreToolDefinition,
    { operationId },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  return mapOperationSnapshot(payload);
}

async function executeOperationLogs(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  if (hasValue(input.cursor)) {
    return unsupportedFieldResult('operation_logs', 'cursor');
  }

  const operationId = readString(input.operation_id);
  if (!operationId) {
    return invalidArgumentsResult('operation_logs', 'operation_id must be a non-empty string.');
  }

  const stream = input.stream === 'combined' ? 'both' : readString(input.stream);
  const payload = await executeGatewayAdapter(
    {
      name: 'operation_logs',
      runtimeToolName: 'workspace.operation_logs',
    } as WorkspaceCoreToolDefinition,
    {
      operationId,
      ...(stream ? { stream } : {}),
      ...(readNumber(input.limit_bytes) ? { maxChars: readNumber(input.limit_bytes) } : {}),
    },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  const value = isRecord(payload) ? payload : {};
  const logs =
    readPropertyString(value, ['logs', 'text']) ||
    [readPropertyString(value, ['stdout']), readPropertyString(value, ['stderr'])]
      .filter((part): part is string => Boolean(part))
      .join('\n');
  return {
    operation_id: operationId,
    logs,
    next_cursor: readPropertyString(value, ['next_cursor', 'nextCursor']),
    truncated:
      readPropertyBoolean(value, ['truncated']) === true ||
      value.stdoutTruncated === true ||
      value.stderrTruncated === true,
    status: mapOperationStatus(value.status),
  };
}

async function executeOperationCancel(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  const operationId = readString(input.operation_id);
  if (!operationId) {
    return invalidArgumentsResult('operation_cancel', 'operation_id must be a non-empty string.');
  }

  const payload = await executeGatewayAdapter(
    {
      name: 'operation_cancel',
      runtimeToolName: 'workspace.operation_cancel',
    } as WorkspaceCoreToolDefinition,
    { operationId },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  const value = isRecord(payload) ? payload : {};
  const status = mapOperationStatus(value.status);
  return {
    operation_id: operationId,
    cancelled: value.cancellationRequested === true || status === 'cancelled',
    status,
  };
}

async function executeReadFile(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  const unsupported = firstUnsupportedField(input, ['offset']);
  if (unsupported) {
    return unsupportedFieldResult('read_file', unsupported);
  }
  if (input.encoding === 'base64') {
    return unsupportedFieldResult('read_file', 'encoding');
  }

  const path = readString(input.path);
  if (!path) {
    return invalidArgumentsResult('read_file', 'path must be a non-empty string.');
  }

  const payload = await executeGatewayAdapter(
    {
      name: 'read_file',
      runtimeToolName: 'workspace.read_file',
    } as WorkspaceCoreToolDefinition,
    {
      path,
      ...(readNumber(input.limit) ? { maxChars: readNumber(input.limit) } : {}),
    },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  const value = isRecord(payload) ? payload : {};
  return {
    path: readPropertyString(value, ['path']) || path,
    content: readPropertyString(value, ['content', 'text']) || '',
    start_line: readPropertyNumber(value, ['start_line', 'startLine']),
    end_line: readPropertyNumber(value, ['end_line', 'endLine']),
    total_lines: readPropertyNumber(value, ['total_lines', 'lines']),
    truncated: readPropertyBoolean(value, ['truncated']) === true,
    binary: readPropertyBoolean(value, ['binary']) === true,
    media_type: readPropertyString(value, ['media_type', 'mediaType']),
    sha256: readPropertyString(value, ['sha256']),
    mtime: readPropertyString(value, ['mtime', 'modified_at', 'modifiedAt']),
  };
}

async function executeListFiles(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  const path = readString(input.path) || '.';
  const limit = readNumber(input.limit);
  const payload = await executeGatewayAdapter(
    {
      name: 'list_files',
      runtimeToolName: 'workspace.list_files',
    } as WorkspaceCoreToolDefinition,
    {
      path,
      ...(readNumber(input.depth) !== undefined ? { depth: readNumber(input.depth) } : {}),
      ...(typeof input.include_hidden === 'boolean' ? { includeHidden: input.include_hidden } : {}),
      ...(typeof input.respect_gitignore === 'boolean' ? { respectGitignore: input.respect_gitignore } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  return mapListFilesResult(payload, path, limit);
}

async function executeGlob(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  const unsupported = firstUnsupportedField(input, ['cwd', 'respect_gitignore']);
  if (unsupported) {
    return unsupportedFieldResult('glob', unsupported);
  }

  const pattern = readString(input.pattern);
  if (!pattern) {
    return invalidArgumentsResult('glob', 'pattern must be a non-empty string.');
  }

  const limit = readNumber(input.limit);
  const payload = await executeGatewayAdapter(
    {
      name: 'glob',
      runtimeToolName: 'workspace.glob',
    } as WorkspaceCoreToolDefinition,
    {
      pattern,
      ...(limit ? { limit } : {}),
    },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  const matches =
    isRecord(payload) && Array.isArray(payload.matches) ? payload.matches.filter(Boolean).map(String) : [];
  return {
    matches,
    truncated: Boolean(limit && matches.length >= limit),
  };
}

async function executeGrep(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  const unsupported = firstUnsupportedField(input, ['glob', 'context_lines', 'respect_gitignore']);
  if (unsupported) {
    return unsupportedFieldResult('grep', unsupported);
  }
  if (input.regex === true) {
    return unsupportedFieldResult('grep', 'regex');
  }

  const pattern = readString(input.pattern);
  if (!pattern) {
    return invalidArgumentsResult('grep', 'pattern must be a non-empty string.');
  }

  const limit = readNumber(input.limit);
  const payload = await executeGatewayAdapter(
    {
      name: 'grep',
      runtimeToolName: 'workspace.grep',
    } as WorkspaceCoreToolDefinition,
    {
      pattern,
      ...(readString(input.cwd) ? { path: readString(input.cwd) } : {}),
      ...(typeof input.case_sensitive === 'boolean' ? { caseSensitive: input.case_sensitive } : {}),
      ...(limit ? { maxResults: limit } : {}),
    },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  const matches =
    isRecord(payload) && Array.isArray(payload.matches)
      ? payload.matches.filter(isRecord).map((match) => ({
          path: readString(match.path) || '',
          line: readNumber(match.line) || 0,
          text: readString(match.text) || '',
          ...(readStringArray(match.before) ? { before: readStringArray(match.before) } : {}),
          ...(readStringArray(match.after) ? { after: readStringArray(match.after) } : {}),
        }))
      : [];
  return {
    matches,
    truncated: Boolean(limit && matches.length >= limit),
  };
}

async function executeEditFile(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  if (hasValue(input.expected_sha256)) {
    return unsupportedFieldResult('edit_file', 'expected_sha256');
  }

  const path = readString(input.path);
  const oldText = readString(input.old_text);
  const newText = readString(input.new_text);
  if (!path || oldText === undefined || newText === undefined) {
    return invalidArgumentsResult('edit_file', 'path, old_text, and new_text are required.');
  }

  const payload = await executeGatewayAdapter(
    {
      name: 'edit_file',
      runtimeToolName: 'workspace.edit_file',
    } as WorkspaceCoreToolDefinition,
    {
      path,
      oldText,
      newText,
      ...(typeof input.replace_all === 'boolean' ? { replaceAll: input.replace_all } : {}),
    },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  const value = isRecord(payload) ? payload : {};
  const diff = fileChangeDiff(value);
  return {
    changed: (readNumber(value.replacements) || 0) > 0,
    path: readString(value.path) || path,
    replacements: readNumber(value.replacements) || 0,
    diff: diff.diff || '',
    ...(diff.newSha256 ? { new_sha256: diff.newSha256 } : {}),
  };
}

async function executeWriteFile(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  const unsupported = firstUnsupportedField(input, ['expected_sha256']);
  if (unsupported) {
    return unsupportedFieldResult('write_file', unsupported);
  }
  if (input.create_dirs === false) {
    return unsupportedFieldResult('write_file', 'create_dirs');
  }

  const path = readString(input.path);
  const content = readString(input.content);
  if (!path || content === undefined) {
    return invalidArgumentsResult('write_file', 'path and content are required.');
  }

  const payload = await executeGatewayAdapter(
    {
      name: 'write_file',
      runtimeToolName: 'workspace.write_file',
    } as WorkspaceCoreToolDefinition,
    { path, content },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  const value = isRecord(payload) ? payload : {};
  const diff = fileChangeDiff(value);
  return {
    written: true,
    path: readString(value.path) || path,
    diff: diff.diff || '',
    ...(diff.newSha256 ? { new_sha256: diff.newSha256 } : {}),
  };
}

function readExpectedFiles(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const path = readString(item.path);
    if (!path) {
      return [];
    }

    return [
      {
        path,
        ...(readString(item.sha256) ? { sha256: readString(item.sha256) } : {}),
      },
    ];
  });
}

async function executeApplyPatch(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  const patch = readString(input.patch);
  if (!patch) {
    return invalidArgumentsResult('apply_patch', 'patch must be a non-empty string.');
  }
  if (hasValue(input.format) && input.format !== 'codex_v4a') {
    return invalidArgumentsResult('apply_patch', 'format must be codex_v4a when provided.');
  }

  const expectedFiles = readExpectedFiles(input.expected_files);
  if (expectedFiles === null) {
    return invalidArgumentsResult('apply_patch', 'expected_files must be an array when provided.');
  }

  const payload = await executeGatewayAdapter(
    {
      name: 'apply_patch',
      runtimeToolName: 'workspace.apply_patch',
    } as WorkspaceCoreToolDefinition,
    {
      patch,
      ...(readString(input.format) ? { format: readString(input.format) } : {}),
      ...(expectedFiles ? { expectedFiles } : {}),
      ...(readString(input.reason) ? { reason: readString(input.reason) } : {}),
    },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  return mapApplyPatchResult(payload);
}

async function executePublishHttp(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  const unsupported = firstUnsupportedField(input, ['path', 'healthcheck_path', 'expected_status']);
  if (unsupported) {
    return unsupportedFieldResult('publish_http', unsupported);
  }

  const port = readNumber(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return invalidArgumentsResult('publish_http', 'port must be an integer between 1 and 65535.');
  }

  try {
    const publication = await AgentSessionService.publishChatHttpPort({
      sessionId: context.session.uuid,
      userId: context.userIdentity.userId,
      port,
    });
    const health = publication.upstreamHealth;
    return {
      url: publication.url,
      port,
      healthy: health?.ok === true,
      auth_scope: 'session_user' as const,
      status: health?.statusCode ?? undefined,
      checked_url: publication.url,
      message: health?.message || (health?.ok ? 'Preview published and verified.' : 'Preview published.'),
    };
  } catch (error) {
    return policyErrorResult({
      code: 'workspace_unavailable',
      retry: 'after_workspace_ready',
      message: error instanceof Error ? error.message : String(error),
      details: { tool: 'publish_http' },
    });
  }
}

async function executeGitStatus(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  if (hasValue(input.cwd)) {
    return unsupportedFieldResult('git_status', 'cwd');
  }

  const payload = await executeGatewayAdapter(
    {
      name: 'git_status',
      runtimeToolName: 'git.status',
    } as WorkspaceCoreToolDefinition,
    {},
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  return mapGitStatus(payload);
}

async function executeGitDiff(input: Record<string, unknown>, context: WorkspaceCoreAdapterContext) {
  if (hasValue(input.cwd)) {
    return unsupportedFieldResult('git_diff', 'cwd');
  }

  const maxBytes = readNumber(input.max_bytes);
  const payload = await executeGatewayAdapter(
    {
      name: 'git_diff',
      runtimeToolName: 'git.diff',
    } as WorkspaceCoreToolDefinition,
    {
      ...(typeof input.staged === 'boolean' ? { staged: input.staged } : {}),
      ...(readString(input.path) ? { path: readString(input.path) } : {}),
    },
    context
  );
  if (isRecord(payload) && payload.ok === false && payload.code) {
    return payload;
  }

  const diff = isRecord(payload) ? readPropertyString(payload, ['diff', 'stdout']) || '' : '';
  const truncated = Boolean(maxBytes && diff.length > maxBytes);
  return {
    diff: truncated && maxBytes ? diff.slice(0, maxBytes) : diff,
    truncated,
  };
}

export async function executeWorkspaceCoreTool(
  definition: WorkspaceCoreToolDefinition,
  input: Record<string, unknown>,
  context: WorkspaceCoreAdapterContext
) {
  if (definition.adapterKind === 'unavailable') {
    return toolUnavailableResult(definition.name);
  }

  switch (definition.name) {
    case 'exec':
      return executeExec(input, context);
    case 'operation_status':
      return executeOperationStatus(input, context);
    case 'operation_logs':
      return executeOperationLogs(input, context);
    case 'operation_cancel':
      return executeOperationCancel(input, context);
    case 'read_file':
      return executeReadFile(input, context);
    case 'list_files':
      return executeListFiles(input, context);
    case 'glob':
      return executeGlob(input, context);
    case 'grep':
      return executeGrep(input, context);
    case 'apply_patch':
      return executeApplyPatch(input, context);
    case 'edit_file':
      return executeEditFile(input, context);
    case 'write_file':
      return executeWriteFile(input, context);
    case 'publish_http':
      return executePublishHttp(input, context);
    case 'git_status':
      return executeGitStatus(input, context);
    case 'git_diff':
      return executeGitDiff(input, context);
    default:
      return toolUnavailableResult(definition.name);
  }
}
