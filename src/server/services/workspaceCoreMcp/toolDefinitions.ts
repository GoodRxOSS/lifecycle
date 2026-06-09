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

import type { AgentCapabilityCatalogId } from 'server/services/agent/capabilityCatalog';
import type { AgentCapabilityKey } from 'server/services/agent/types';
import type { McpToolAnnotations } from 'server/services/agentRuntime/mcp/types';
import type { WorkspaceCoreCapability } from './result';

export const WORKSPACE_CORE_SERVER_SLUG = 'workspace_core';
export const WORKSPACE_CORE_SERVER_NAME = 'Workspace Core';

export const WORKSPACE_CORE_REQUIRED_TOOL_NAMES = [
  'exec',
  'operation_status',
  'operation_logs',
  'operation_cancel',
  'start_service',
  'service_status',
  'read_file',
  'list_files',
  'glob',
  'grep',
  'apply_patch',
  'edit_file',
  'write_file',
  'publish_http',
  'git_status',
  'git_diff',
] as const;

export type WorkspaceCoreToolName = (typeof WORKSPACE_CORE_REQUIRED_TOOL_NAMES)[number];
export type WorkspaceCoreRuntimeAdapterKind = 'workspace_gateway' | 'publish_http' | 'unavailable';
export type JsonSchemaObject = Record<string, unknown>;

export type WorkspaceCoreToolDefinition = {
  name: WorkspaceCoreToolName;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema: JsonSchemaObject;
  annotations?: McpToolAnnotations;
  capabilities: WorkspaceCoreCapability[];
  capabilityKey: AgentCapabilityKey;
  catalogCapabilityId: AgentCapabilityCatalogId;
  adapterKind: WorkspaceCoreRuntimeAdapterKind;
  runtimeToolName?: string;
};

const POLICY_RESULT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      required: ['ok', 'code', 'required_capabilities', 'approval_required', 'retry', 'message', 'audit_id'],
      properties: {
        ok: { const: false },
        code: { const: 'capability_required' },
        required_capabilities: { type: 'array', items: { type: 'string' } },
        approval_required: { type: 'boolean' },
        approval_id: { type: 'string' },
        retry: { enum: ['after_approval', 'after_workspace_ready', 'never'] },
        message: { type: 'string' },
        audit_id: { type: 'string' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['ok', 'code', 'message', 'retry', 'audit_id'],
      properties: {
        ok: { const: false },
        code: {
          enum: [
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
          ],
        },
        message: { type: 'string' },
        retry: { enum: ['immediate', 'after_approval', 'after_workspace_ready', 'never'] },
        audit_id: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    },
  ],
} as const;

function objectSchema(properties: JsonSchemaObject, required: string[] = []): JsonSchemaObject {
  return {
    type: 'object',
    required,
    additionalProperties: false,
    properties,
  };
}

function outputSchema(successSchema: JsonSchemaObject): JsonSchemaObject {
  return {
    oneOf: [successSchema, POLICY_RESULT_SCHEMA],
  };
}

const EXEC_OUTPUT_SCHEMA = outputSchema(
  objectSchema({
    operation_id: { type: 'string' },
    status: { enum: ['completed', 'running', 'failed', 'cancelled', 'timed_out'] },
    exit_code: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    truncated: { type: 'boolean' },
    cwd: { type: 'string' },
    started_at: { type: 'string' },
    finished_at: { type: 'string' },
  })
);

const OPERATION_STATUS_OUTPUT_SCHEMA = outputSchema(
  objectSchema({
    operation_id: { type: 'string' },
    kind: { enum: ['command', 'service', 'publish', 'unknown'] },
    status: { enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out'] },
    exit_code: { type: 'integer' },
    started_at: { type: 'string' },
    finished_at: { type: 'string' },
    command: { type: 'string' },
    cwd: { type: 'string' },
  })
);

const TOOL_DEFINITIONS: readonly WorkspaceCoreToolDefinition[] = [
  {
    name: 'exec',
    title: 'Run Workspace Command',
    description: 'Run a command in the workspace. The host classifies and enforces policy before execution.',
    inputSchema: objectSchema(
      {
        cmd: { type: 'string', minLength: 1 },
        cwd: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1 },
        async: { type: 'boolean' },
        yield_time_ms: { type: 'integer', minimum: 0 },
        max_output_chars: { type: 'integer', minimum: 1 },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        stdin: { type: 'string' },
        reason: { type: 'string' },
      },
      ['cmd']
    ),
    outputSchema: EXEC_OUTPUT_SCHEMA,
    annotations: { destructiveHint: true, openWorldHint: true },
    capabilities: ['workspace.exec'],
    capabilityKey: 'shell_exec',
    catalogCapabilityId: 'workspace_shell',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.exec',
  },
  {
    name: 'operation_status',
    title: 'Get Operation Status',
    description: 'Inspect an async workspace operation.',
    inputSchema: objectSchema({ operation_id: { type: 'string', minLength: 1 } }, ['operation_id']),
    outputSchema: OPERATION_STATUS_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    capabilities: ['workspace.read'],
    capabilityKey: 'read',
    catalogCapabilityId: 'workspace_shell',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.operation_status',
  },
  {
    name: 'operation_logs',
    title: 'Read Operation Logs',
    description: 'Fetch bounded output for an async workspace operation.',
    inputSchema: objectSchema(
      {
        operation_id: { type: 'string', minLength: 1 },
        cursor: { type: 'string' },
        limit_bytes: { type: 'integer', minimum: 1 },
        stream: { enum: ['stdout', 'stderr', 'combined'] },
      },
      ['operation_id']
    ),
    outputSchema: outputSchema(
      objectSchema({
        operation_id: { type: 'string' },
        logs: { type: 'string' },
        next_cursor: { type: 'string' },
        truncated: { type: 'boolean' },
        status: { type: 'string' },
      })
    ),
    annotations: { readOnlyHint: true },
    capabilities: ['workspace.read'],
    capabilityKey: 'read',
    catalogCapabilityId: 'workspace_shell',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.operation_logs',
  },
  {
    name: 'operation_cancel',
    title: 'Cancel Operation',
    description: 'Cancel a live workspace operation.',
    inputSchema: objectSchema(
      {
        operation_id: { type: 'string', minLength: 1 },
        reason: { type: 'string' },
      },
      ['operation_id']
    ),
    outputSchema: outputSchema(
      objectSchema({
        operation_id: { type: 'string' },
        cancelled: { type: 'boolean' },
        status: { type: 'string' },
      })
    ),
    annotations: { destructiveHint: true },
    capabilities: ['workspace.exec'],
    capabilityKey: 'shell_exec',
    catalogCapabilityId: 'workspace_shell',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.operation_cancel',
  },
  {
    name: 'start_service',
    title: 'Start Workspace Service',
    description:
      'Start or restart a long-lived workspace service such as a dev server. Use this instead of async exec for anything that must keep running: async operations are terminated when their duration budget elapses, services are not.',
    inputSchema: objectSchema(
      {
        command: { type: 'string', minLength: 1 },
        service_name: { type: 'string' },
        cwd: { type: 'string' },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        restart: { type: 'boolean' },
        wait_ms: { type: 'integer', minimum: 0 },
        reason: { type: 'string' },
      },
      ['command']
    ),
    outputSchema: outputSchema(
      objectSchema({
        service_name: { type: 'string' },
        status: { type: 'string' },
        running: { type: 'boolean' },
        pid: { type: 'integer' },
        port: { type: 'integer' },
        started_at: { type: 'string' },
        error: { type: 'string' },
      })
    ),
    annotations: { destructiveHint: true, openWorldHint: true },
    capabilities: ['workspace.exec'],
    capabilityKey: 'shell_exec',
    catalogCapabilityId: 'workspace_shell',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.service_start',
  },
  {
    name: 'service_status',
    title: 'Get Workspace Service Status',
    description: 'Inspect a long-lived workspace service, optionally with bounded stdout/stderr tails.',
    inputSchema: objectSchema({
      service_name: { type: 'string' },
      include_logs: { type: 'boolean' },
      max_chars: { type: 'integer', minimum: 1 },
    }),
    outputSchema: outputSchema(
      objectSchema({
        service_name: { type: 'string' },
        status: { type: 'string' },
        running: { type: 'boolean' },
        pid: { type: 'integer' },
        port: { type: 'integer' },
        started_at: { type: 'string' },
        exit_code: { type: 'integer' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        error: { type: 'string' },
      })
    ),
    annotations: { readOnlyHint: true },
    capabilities: ['workspace.read'],
    capabilityKey: 'read',
    catalogCapabilityId: 'workspace_shell',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.service_status',
  },
  {
    name: 'read_file',
    title: 'Read File',
    description: 'Read a file from the workspace with bounded output.',
    inputSchema: objectSchema(
      {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
        encoding: { enum: ['utf8', 'base64'] },
      },
      ['path']
    ),
    outputSchema: outputSchema(
      objectSchema({
        path: { type: 'string' },
        content: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
        total_lines: { type: 'integer' },
        truncated: { type: 'boolean' },
        binary: { type: 'boolean' },
        media_type: { type: 'string' },
        sha256: { type: 'string' },
        mtime: { type: 'string' },
      })
    ),
    annotations: { readOnlyHint: true },
    capabilities: ['workspace.read'],
    capabilityKey: 'read',
    catalogCapabilityId: 'read_context',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.read_file',
  },
  {
    name: 'list_files',
    title: 'List Files',
    description: 'List files under a workspace path.',
    inputSchema: objectSchema({
      path: { type: 'string' },
      depth: { type: 'integer', minimum: 0 },
      include_hidden: { type: 'boolean' },
      respect_gitignore: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1 },
    }),
    outputSchema: outputSchema(
      objectSchema({
        path: { type: 'string' },
        entries: {
          type: 'array',
          items: objectSchema({
            path: { type: 'string' },
            kind: { enum: ['file', 'directory', 'symlink', 'other'] },
            size: { type: 'integer' },
            mtime: { type: 'string' },
          }),
        },
        truncated: { type: 'boolean' },
      })
    ),
    annotations: { readOnlyHint: true },
    capabilities: ['workspace.read'],
    capabilityKey: 'read',
    catalogCapabilityId: 'read_context',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.list_files',
  },
  {
    name: 'glob',
    title: 'Glob Files',
    description: 'Find workspace files by glob pattern.',
    inputSchema: objectSchema(
      {
        pattern: { type: 'string', minLength: 1 },
        cwd: { type: 'string' },
        limit: { type: 'integer', minimum: 1 },
        respect_gitignore: { type: 'boolean' },
      },
      ['pattern']
    ),
    outputSchema: outputSchema(
      objectSchema({
        matches: { type: 'array', items: { type: 'string' } },
        truncated: { type: 'boolean' },
      })
    ),
    annotations: { readOnlyHint: true },
    capabilities: ['workspace.read'],
    capabilityKey: 'read',
    catalogCapabilityId: 'read_context',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.glob',
  },
  {
    name: 'grep',
    title: 'Grep Files',
    description: 'Search workspace file contents.',
    inputSchema: objectSchema(
      {
        pattern: { type: 'string', minLength: 1 },
        cwd: { type: 'string' },
        glob: { type: 'string' },
        regex: { type: 'boolean' },
        case_sensitive: { type: 'boolean' },
        respect_gitignore: { type: 'boolean' },
        context_lines: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      },
      ['pattern']
    ),
    outputSchema: outputSchema(
      objectSchema({
        matches: {
          type: 'array',
          items: objectSchema({
            path: { type: 'string' },
            line: { type: 'integer' },
            text: { type: 'string' },
            before: { type: 'array', items: { type: 'string' } },
            after: { type: 'array', items: { type: 'string' } },
          }),
        },
        truncated: { type: 'boolean' },
      })
    ),
    annotations: { readOnlyHint: true },
    capabilities: ['workspace.read'],
    capabilityKey: 'read',
    catalogCapabilityId: 'read_context',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.grep',
  },
  {
    name: 'apply_patch',
    title: 'Apply Patch',
    description: 'Apply an atomic multi-file patch to the workspace.',
    inputSchema: objectSchema(
      {
        patch: { type: 'string', minLength: 1 },
        format: { enum: ['codex_v4a'] },
        expected_files: {
          type: 'array',
          items: objectSchema({
            path: { type: 'string' },
            sha256: { type: 'string' },
          }),
        },
        reason: { type: 'string' },
      },
      ['patch']
    ),
    outputSchema: outputSchema(
      objectSchema({
        applied: { type: 'boolean' },
        changed_files: { type: 'array', items: { type: 'string' } },
        diff: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
      })
    ),
    annotations: { destructiveHint: true },
    capabilities: ['workspace.write'],
    capabilityKey: 'workspace_write',
    catalogCapabilityId: 'workspace_files',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.apply_patch',
  },
  {
    name: 'edit_file',
    title: 'Edit File',
    description: 'Replace exact text in a workspace file.',
    inputSchema: objectSchema(
      {
        path: { type: 'string', minLength: 1 },
        old_text: { type: 'string', minLength: 1 },
        new_text: { type: 'string' },
        expected_sha256: { type: 'string' },
        replace_all: { type: 'boolean' },
        reason: { type: 'string' },
      },
      ['path', 'old_text', 'new_text']
    ),
    outputSchema: outputSchema(
      objectSchema({
        changed: { type: 'boolean' },
        path: { type: 'string' },
        replacements: { type: 'integer' },
        diff: { type: 'string' },
        new_sha256: { type: 'string' },
      })
    ),
    annotations: { destructiveHint: true },
    capabilities: ['workspace.write'],
    capabilityKey: 'workspace_write',
    catalogCapabilityId: 'workspace_files',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.edit_file',
  },
  {
    name: 'write_file',
    title: 'Write File',
    description: 'Create or replace a whole workspace file.',
    inputSchema: objectSchema(
      {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
        expected_sha256: { type: 'string' },
        create_dirs: { type: 'boolean' },
        reason: { type: 'string' },
      },
      ['path', 'content']
    ),
    outputSchema: outputSchema(
      objectSchema({
        written: { type: 'boolean' },
        path: { type: 'string' },
        diff: { type: 'string' },
        new_sha256: { type: 'string' },
      })
    ),
    annotations: { destructiveHint: true },
    capabilities: ['workspace.write'],
    capabilityKey: 'workspace_write',
    catalogCapabilityId: 'workspace_files',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'workspace.write_file',
  },
  {
    name: 'publish_http',
    title: 'Publish HTTP Preview',
    description: 'Publish and verify a workspace HTTP port.',
    inputSchema: objectSchema(
      {
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        label: { type: 'string' },
      },
      ['port']
    ),
    outputSchema: outputSchema(
      objectSchema({
        url: { type: 'string' },
        port: { type: 'integer' },
        healthy: { type: 'boolean' },
        auth_scope: { enum: ['session_user', 'workspace_members', 'organization', 'public_unguessable'] },
        status: { type: 'integer' },
        checked_url: { type: 'string' },
        message: { type: 'string' },
      })
    ),
    annotations: { destructiveHint: true, openWorldHint: true },
    capabilities: ['workspace.preview'],
    capabilityKey: 'deploy_k8s_mutation',
    catalogCapabilityId: 'preview_publish',
    adapterKind: 'publish_http',
  },
  {
    name: 'git_status',
    title: 'Git Status',
    description: 'Read git status for the workspace repository.',
    inputSchema: objectSchema({ cwd: { type: 'string' } }),
    outputSchema: outputSchema(
      objectSchema({
        branch: { type: 'string' },
        clean: { type: 'boolean' },
        changed_files: {
          type: 'array',
          items: objectSchema({
            path: { type: 'string' },
            status: { type: 'string' },
            staged: { type: 'boolean' },
          }),
        },
      })
    ),
    annotations: { readOnlyHint: true },
    capabilities: ['workspace.git_read'],
    capabilityKey: 'read',
    catalogCapabilityId: 'workspace_git',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'git.status',
  },
  {
    name: 'git_diff',
    title: 'Git Diff',
    description: 'Read git diff for the workspace repository.',
    inputSchema: objectSchema({
      cwd: { type: 'string' },
      staged: { type: 'boolean' },
      path: { type: 'string' },
      max_bytes: { type: 'integer', minimum: 1 },
    }),
    outputSchema: outputSchema(
      objectSchema({
        diff: { type: 'string' },
        truncated: { type: 'boolean' },
      })
    ),
    annotations: { readOnlyHint: true },
    capabilities: ['workspace.git_read'],
    capabilityKey: 'read',
    catalogCapabilityId: 'workspace_git',
    adapterKind: 'workspace_gateway',
    runtimeToolName: 'git.diff',
  },
];

export const WORKSPACE_CORE_TOOL_DEFINITIONS: readonly WorkspaceCoreToolDefinition[] = TOOL_DEFINITIONS;

export function getWorkspaceCoreToolDefinition(name: string): WorkspaceCoreToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}
