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

import type { AgentApprovalMode, AgentCapabilityKey } from './types';

export const AGENT_CAPABILITY_AVAILABILITIES = ['all_users', 'admin_only', 'system_only', 'disabled'] as const;

export type AgentCapabilityAvailability = (typeof AGENT_CAPABILITY_AVAILABILITIES)[number];

export const AGENT_CAPABILITY_CATALOG_IDS = [
  'read_context',
  'diagnostics_logs',
  'diagnostics_codefresh',
  'diagnostics_kubernetes',
  'diagnostics_database',
  'github_read',
  'github_write',
  'workspace_files',
  'workspace_shell',
  'workspace_git',
  'network_access',
  'preview_publish',
  'external_mcp_read',
  'external_mcp_write',
  'approval_controls',
] as const;

export type AgentCapabilityCatalogId = (typeof AGENT_CAPABILITY_CATALOG_IDS)[number];

export type AgentCapabilityCategory =
  | 'read'
  | 'diagnostics'
  | 'workspace'
  | 'source_control'
  | 'mcp'
  | 'deployment'
  | 'network'
  | 'preview'
  | 'approval';

export type AgentCapabilitySourceKind = 'build_context_chat' | 'workspace_session' | 'freeform_chat';

export interface AgentCapabilityCatalogEntry {
  id: AgentCapabilityCatalogId;
  category: AgentCapabilityCategory;
  label: string;
  description: string;
  defaultAvailability: AgentCapabilityAvailability;
  defaultApprovalMode: AgentApprovalMode;
  runtimeCapabilityKey?: AgentCapabilityKey;
  toolKeys?: readonly string[];
  resourceGrants?: readonly string[];
  sourceKinds?: readonly AgentCapabilitySourceKind[];
  userSelectable: boolean;
}

export const AGENT_CAPABILITY_CATALOG: readonly AgentCapabilityCatalogEntry[] = [
  {
    id: 'read_context',
    category: 'read',
    label: 'Read/context',
    description: 'Read session context, workspace files, service state, logs, and non-mutating reference data.',
    defaultAvailability: 'all_users',
    defaultApprovalMode: 'allow',
    runtimeCapabilityKey: 'read',
    resourceGrants: ['session_context'],
    sourceKinds: ['build_context_chat', 'workspace_session', 'freeform_chat'],
    userSelectable: true,
  },
  {
    id: 'diagnostics_logs',
    category: 'diagnostics',
    label: 'Diagnostic logs',
    description: 'Inspect Lifecycle and workload logs for troubleshooting.',
    defaultAvailability: 'system_only',
    defaultApprovalMode: 'allow',
    runtimeCapabilityKey: 'read',
    toolKeys: ['lifecycle.get_logs', 'k8s.get_pod_logs'],
    resourceGrants: ['build_context'],
    sourceKinds: ['build_context_chat'],
    userSelectable: false,
  },
  {
    id: 'diagnostics_codefresh',
    category: 'diagnostics',
    label: 'Codefresh diagnostics',
    description: 'Read Codefresh pipeline logs and build details.',
    defaultAvailability: 'system_only',
    defaultApprovalMode: 'allow',
    runtimeCapabilityKey: 'read',
    toolKeys: ['codefresh.get_logs'],
    resourceGrants: ['build_context', 'codefresh'],
    sourceKinds: ['build_context_chat'],
    userSelectable: false,
  },
  {
    id: 'diagnostics_kubernetes',
    category: 'diagnostics',
    label: 'Kubernetes diagnostics',
    description: 'Read Kubernetes resources, events, and pod state.',
    defaultAvailability: 'system_only',
    defaultApprovalMode: 'allow',
    runtimeCapabilityKey: 'read',
    toolKeys: ['k8s.get_resources', 'k8s.get_pod_logs', 'lifecycle.get_logs'],
    resourceGrants: ['build_context', 'kubernetes_read'],
    sourceKinds: ['build_context_chat'],
    userSelectable: false,
  },
  {
    id: 'diagnostics_database',
    category: 'diagnostics',
    label: 'Database diagnostics',
    description: 'Run read-only database inspection needed for environment troubleshooting.',
    defaultAvailability: 'system_only',
    defaultApprovalMode: 'allow',
    runtimeCapabilityKey: 'read',
    toolKeys: ['query_database'],
    resourceGrants: ['build_context', 'database_read'],
    sourceKinds: ['build_context_chat'],
    userSelectable: false,
  },
  {
    id: 'github_read',
    category: 'source_control',
    label: 'GitHub read',
    description: 'Read repository files, pull request context, and issue comments.',
    defaultAvailability: 'all_users',
    defaultApprovalMode: 'allow',
    runtimeCapabilityKey: 'read',
    toolKeys: ['github.get_file', 'github.list_directory', 'github.get_issue_comment'],
    resourceGrants: ['github_read'],
    sourceKinds: ['build_context_chat', 'workspace_session'],
    userSelectable: true,
  },
  {
    id: 'github_write',
    category: 'source_control',
    label: 'GitHub write',
    description: 'Apply repository or pull request fixes through GitHub.',
    defaultAvailability: 'system_only',
    defaultApprovalMode: 'require_approval',
    runtimeCapabilityKey: 'git_write',
    toolKeys: ['github.update_file', 'github.update_pr_labels'],
    resourceGrants: ['github_write'],
    sourceKinds: ['build_context_chat'],
    userSelectable: false,
  },
  {
    id: 'workspace_files',
    category: 'workspace',
    label: 'Workspace files',
    description: 'Create and edit files inside a development workspace.',
    defaultAvailability: 'all_users',
    defaultApprovalMode: 'require_approval',
    runtimeCapabilityKey: 'workspace_write',
    toolKeys: ['workspace_core.apply_patch', 'workspace_core.edit_file', 'workspace_core.write_file'],
    resourceGrants: ['workspace_write'],
    sourceKinds: ['workspace_session'],
    userSelectable: true,
  },
  {
    id: 'workspace_shell',
    category: 'workspace',
    label: 'Command tools',
    description: 'Run commands and manage workspace operations or services.',
    defaultAvailability: 'all_users',
    defaultApprovalMode: 'require_approval',
    runtimeCapabilityKey: 'shell_exec',
    toolKeys: [
      'workspace_core.exec',
      'workspace_core.operation_status',
      'workspace_core.operation_logs',
      'workspace_core.operation_cancel',
    ],
    resourceGrants: ['workspace_shell'],
    sourceKinds: ['workspace_session'],
    userSelectable: true,
  },
  {
    id: 'workspace_git',
    category: 'source_control',
    label: 'Source control',
    description: 'Inspect workspace git status and diffs.',
    defaultAvailability: 'all_users',
    defaultApprovalMode: 'allow',
    runtimeCapabilityKey: 'read',
    toolKeys: ['workspace_core.git_status', 'workspace_core.git_diff'],
    resourceGrants: ['workspace_read'],
    sourceKinds: ['workspace_session'],
    userSelectable: true,
  },
  {
    id: 'network_access',
    category: 'network',
    label: 'Network access',
    description: 'Allow workspace tools to reach external network resources.',
    defaultAvailability: 'all_users',
    defaultApprovalMode: 'require_approval',
    runtimeCapabilityKey: 'network_access',
    resourceGrants: ['network_access'],
    sourceKinds: ['workspace_session'],
    userSelectable: true,
  },
  {
    id: 'preview_publish',
    category: 'preview',
    label: 'Preview/publish',
    description: 'Expose workspace services and publish preview URLs.',
    defaultAvailability: 'all_users',
    defaultApprovalMode: 'require_approval',
    runtimeCapabilityKey: 'deploy_k8s_mutation',
    toolKeys: ['workspace_core.publish_http'],
    resourceGrants: ['preview_publish'],
    sourceKinds: ['workspace_session'],
    userSelectable: true,
  },
  {
    id: 'external_mcp_read',
    category: 'mcp',
    label: 'MCP read',
    description: 'Use connected MCP tools that declare read-only behavior.',
    defaultAvailability: 'all_users',
    defaultApprovalMode: 'allow',
    runtimeCapabilityKey: 'external_mcp_read',
    resourceGrants: ['mcp_read'],
    sourceKinds: ['build_context_chat', 'workspace_session', 'freeform_chat'],
    userSelectable: true,
  },
  {
    id: 'external_mcp_write',
    category: 'mcp',
    label: 'MCP write',
    description: 'Use connected MCP tools that can mutate external systems.',
    defaultAvailability: 'admin_only',
    defaultApprovalMode: 'require_approval',
    runtimeCapabilityKey: 'external_mcp_write',
    resourceGrants: ['mcp_write'],
    sourceKinds: ['build_context_chat', 'workspace_session', 'freeform_chat'],
    userSelectable: true,
  },
  {
    id: 'approval_controls',
    category: 'approval',
    label: 'Approval controls',
    description: 'Control approval behavior for protected tool execution.',
    defaultAvailability: 'system_only',
    defaultApprovalMode: 'require_approval',
    resourceGrants: ['approval_policy'],
    sourceKinds: ['build_context_chat', 'workspace_session', 'freeform_chat'],
    userSelectable: false,
  },
] as const;

const AGENT_CAPABILITY_CATALOG_BY_ID = new Map(AGENT_CAPABILITY_CATALOG.map((entry) => [entry.id, entry]));

export function isAgentCapabilityCatalogId(value: string): value is AgentCapabilityCatalogId {
  return AGENT_CAPABILITY_CATALOG_IDS.includes(value as AgentCapabilityCatalogId);
}

export function isAgentCapabilityAvailability(value: string): value is AgentCapabilityAvailability {
  return AGENT_CAPABILITY_AVAILABILITIES.includes(value as AgentCapabilityAvailability);
}

export function listAgentCapabilityCatalogEntries(): readonly AgentCapabilityCatalogEntry[] {
  return AGENT_CAPABILITY_CATALOG;
}

export function getAgentCapabilityCatalogEntry(id: AgentCapabilityCatalogId): AgentCapabilityCatalogEntry {
  const entry = AGENT_CAPABILITY_CATALOG_BY_ID.get(id);
  if (!entry) {
    throw new Error(`Unknown agent capability catalog id: ${id}`);
  }
  return entry;
}
