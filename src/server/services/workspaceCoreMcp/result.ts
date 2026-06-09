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

import { randomUUID } from 'crypto';

export type WorkspaceCoreCapability =
  | 'context.read'
  | 'workspace.request'
  | 'workspace.read'
  | 'workspace.exec'
  | 'workspace.write'
  | 'workspace.network'
  | 'workspace.preview'
  | 'workspace.git_read'
  | 'workspace.git_local_write'
  | 'source_control.remote_write'
  | 'diagnostics.read'
  | 'diagnostics.lifecycle_read'
  | 'deployment.write'
  | 'external_mcp.read'
  | 'external_mcp.write';

export type ToolPolicyRetry = 'immediate' | 'after_approval' | 'after_workspace_ready' | 'never';

export type ToolPolicyErrorCode =
  | 'capability_required'
  | 'approval_pending'
  | 'approval_denied'
  | 'policy_denied'
  | 'workspace_unavailable'
  | 'stale_runtime_generation'
  | 'protected_path'
  | 'network_denied'
  | 'tool_unavailable'
  | 'operation_not_live'
  | 'invalid_arguments';

export type ToolPolicyResult =
  | {
      ok: false;
      code: 'capability_required';
      required_capabilities: WorkspaceCoreCapability[];
      approval_required: boolean;
      approval_id?: string;
      retry: 'after_approval' | 'after_workspace_ready' | 'never';
      message: string;
      audit_id: string;
    }
  | {
      ok: false;
      code: Exclude<ToolPolicyErrorCode, 'capability_required'>;
      message: string;
      retry: ToolPolicyRetry;
      audit_id: string;
      details?: Record<string, unknown>;
    };

export type WorkspaceCoreMcpResult<T = unknown> = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: T | ToolPolicyResult;
  isError?: boolean;
};

export function createWorkspaceCoreAuditId(): string {
  return `workspace_core:${randomUUID()}`;
}

export function capabilityRequiredResult({
  requiredCapabilities,
  approvalRequired,
  approvalId,
  retry,
  message,
  auditId,
}: {
  requiredCapabilities: WorkspaceCoreCapability[];
  approvalRequired: boolean;
  approvalId?: string;
  retry: 'after_approval' | 'after_workspace_ready' | 'never';
  message: string;
  auditId?: string;
}): ToolPolicyResult {
  return {
    ok: false,
    code: 'capability_required',
    required_capabilities: requiredCapabilities,
    approval_required: approvalRequired,
    ...(approvalId ? { approval_id: approvalId } : {}),
    retry,
    message,
    audit_id: auditId || createWorkspaceCoreAuditId(),
  };
}

export function policyErrorResult({
  code,
  message,
  retry,
  details,
  auditId,
}: {
  code: Exclude<ToolPolicyErrorCode, 'capability_required'>;
  message: string;
  retry: ToolPolicyRetry;
  details?: Record<string, unknown>;
  auditId?: string;
}): ToolPolicyResult {
  return {
    ok: false,
    code,
    message,
    retry,
    audit_id: auditId || createWorkspaceCoreAuditId(),
    ...(details ? { details } : {}),
  };
}

export function toolUnavailableResult(toolName: string, message?: string, details?: Record<string, unknown>) {
  return policyErrorResult({
    code: 'tool_unavailable',
    retry: 'never',
    message: message || `workspace_core.${toolName} is not backed by the current workspace runtime.`,
    details: {
      tool: toolName,
      ...(details || {}),
    },
  });
}

export function workspaceUnavailableResult(message = 'Workspace runtime is not ready for workspace_core tool calls.') {
  return policyErrorResult({
    code: 'workspace_unavailable',
    retry: 'after_workspace_ready',
    message,
  });
}

export function invalidArgumentsResult(toolName: string, message: string, details?: Record<string, unknown>) {
  return policyErrorResult({
    code: 'invalid_arguments',
    retry: 'immediate',
    message,
    details: {
      tool: toolName,
      ...(details || {}),
    },
  });
}

export function toWorkspaceCoreMcpResult<T>(structuredContent: T, isError = false): WorkspaceCoreMcpResult<T> {
  return {
    content: [
      {
        type: 'text',
        text: typeof structuredContent === 'string' ? structuredContent : JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

export function toWorkspaceCorePolicyMcpResult(result: ToolPolicyResult): WorkspaceCoreMcpResult<ToolPolicyResult> {
  return toWorkspaceCoreMcpResult(result, true);
}
