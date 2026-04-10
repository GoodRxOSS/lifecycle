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

import type { McpDiscoveredTool } from 'server/services/ai/mcp/types';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import type { AgentApprovalPolicy } from './types';
import AgentPolicyService from './PolicyService';
import {
  buildAgentToolKey,
  buildWorkspaceMutationExecDescription,
  buildWorkspaceReadonlyExecDescription,
  SESSION_WORKSPACE_MUTATION_TOOL_NAME,
  SESSION_WORKSPACE_READONLY_TOOL_NAME,
  SESSION_WORKSPACE_SERVER_NAME,
  SESSION_WORKSPACE_SERVER_SLUG,
} from './toolKeys';

type SessionWorkspaceToolCategory = 'skills' | 'inspect' | 'file_change' | 'command' | 'git_change';

export type SessionWorkspaceToolAdminVisibility = 'visible' | 'hidden';

type SessionWorkspaceToolCatalogRecord = {
  toolName: string;
  runtimeToolName: string;
  category: SessionWorkspaceToolCategory;
  order: number;
  adminVisibility: SessionWorkspaceToolAdminVisibility;
  annotations?: McpDiscoveredTool['annotations'];
  description: string | ((serverName: string) => string);
};

type SessionWorkspaceToolCatalogEntry = SessionWorkspaceToolCatalogRecord & {
  description: string;
  toolKey: string;
};

const SESSION_WORKSPACE_TOOL_CATALOG: readonly SessionWorkspaceToolCatalogRecord[] = [
  {
    toolName: 'skills.list',
    runtimeToolName: 'skills.list',
    category: 'skills',
    order: 10,
    adminVisibility: 'hidden',
    annotations: { readOnlyHint: true },
    description: 'List the skills equipped for this session.',
  },
  {
    toolName: 'skills.learn',
    runtimeToolName: 'skills.learn',
    category: 'skills',
    order: 20,
    adminVisibility: 'hidden',
    annotations: { readOnlyHint: true },
    description: 'Load SKILL.md or another referenced file for one equipped skill.',
  },
  {
    toolName: 'workspace.read_file',
    runtimeToolName: 'workspace.read_file',
    category: 'inspect',
    order: 30,
    adminVisibility: 'visible',
    annotations: { readOnlyHint: true },
    description: 'Read a text file from the workspace root.',
  },
  {
    toolName: 'workspace.glob',
    runtimeToolName: 'workspace.glob',
    category: 'inspect',
    order: 40,
    adminVisibility: 'visible',
    annotations: { readOnlyHint: true },
    description: 'Return workspace files and directories matching a glob pattern.',
  },
  {
    toolName: 'workspace.grep',
    runtimeToolName: 'workspace.grep',
    category: 'inspect',
    order: 50,
    adminVisibility: 'visible',
    annotations: { readOnlyHint: true },
    description: 'Search text across workspace files using a literal substring match.',
  },
  {
    toolName: SESSION_WORKSPACE_READONLY_TOOL_NAME,
    runtimeToolName: 'workspace.exec',
    category: 'inspect',
    order: 60,
    adminVisibility: 'visible',
    annotations: { readOnlyHint: true },
    description: (serverName: string) => buildWorkspaceReadonlyExecDescription(serverName),
  },
  {
    toolName: 'session.get_workspace_state',
    runtimeToolName: 'session.get_workspace_state',
    category: 'inspect',
    order: 70,
    adminVisibility: 'hidden',
    annotations: { readOnlyHint: true },
    description: 'Return a normalized snapshot of the current workspace and state files.',
  },
  {
    toolName: 'session.list_ports',
    runtimeToolName: 'session.list_ports',
    category: 'inspect',
    order: 80,
    adminVisibility: 'hidden',
    annotations: { readOnlyHint: true },
    description: 'Return the current ports snapshot for the sandbox.',
  },
  {
    toolName: 'session.list_processes',
    runtimeToolName: 'session.list_processes',
    category: 'inspect',
    order: 90,
    adminVisibility: 'hidden',
    annotations: { readOnlyHint: true },
    description: 'Return the current process snapshot for the sandbox.',
  },
  {
    toolName: 'session.get_service_status',
    runtimeToolName: 'session.get_service_status',
    category: 'inspect',
    order: 100,
    adminVisibility: 'hidden',
    annotations: { readOnlyHint: true },
    description: 'Return service status for the sandbox.',
  },
  {
    toolName: 'git.status',
    runtimeToolName: 'git.status',
    category: 'inspect',
    order: 110,
    adminVisibility: 'visible',
    annotations: { readOnlyHint: true },
    description: 'Return a short git status for the workspace repository.',
  },
  {
    toolName: 'git.diff',
    runtimeToolName: 'git.diff',
    category: 'inspect',
    order: 120,
    adminVisibility: 'visible',
    annotations: { readOnlyHint: true },
    description: 'Return a git diff for the workspace repository.',
  },
  {
    toolName: 'workspace.write_file',
    runtimeToolName: 'workspace.write_file',
    category: 'file_change',
    order: 130,
    adminVisibility: 'visible',
    description: 'Write or overwrite a text file within the workspace.',
  },
  {
    toolName: 'workspace.edit_file',
    runtimeToolName: 'workspace.edit_file',
    category: 'file_change',
    order: 140,
    adminVisibility: 'visible',
    description: 'Replace text inside a workspace file using an exact-match edit.',
  },
  {
    toolName: SESSION_WORKSPACE_MUTATION_TOOL_NAME,
    runtimeToolName: 'workspace.exec',
    category: 'command',
    order: 150,
    adminVisibility: 'visible',
    description: (serverName: string) => buildWorkspaceMutationExecDescription(serverName),
  },
  {
    toolName: 'git.add',
    runtimeToolName: 'git.add',
    category: 'git_change',
    order: 160,
    adminVisibility: 'visible',
    description: 'Stage one or more paths in the workspace repository.',
  },
  {
    toolName: 'git.commit',
    runtimeToolName: 'git.commit',
    category: 'git_change',
    order: 170,
    adminVisibility: 'visible',
    description: 'Create a commit from the current staged changes.',
  },
  {
    toolName: 'git.branch',
    runtimeToolName: 'git.branch',
    category: 'git_change',
    order: 180,
    adminVisibility: 'visible',
    description: 'Inspect branches or create or switch a branch.',
  },
] as const;

const PROMPT_CATEGORY_COPY: Record<SessionWorkspaceToolCategory, { label: string; toolNames: string[] }> = {
  skills: {
    label: 'discover and learn equipped skills',
    toolNames: ['skills.list', 'skills.learn'],
  },
  inspect: {
    label: 'inspect files, services, and git state',
    toolNames: [
      'workspace.read_file',
      'workspace.glob',
      'workspace.grep',
      SESSION_WORKSPACE_READONLY_TOOL_NAME,
      'session.get_workspace_state',
      'session.list_ports',
      'session.list_processes',
      'session.get_service_status',
      'git.status',
      'git.diff',
    ],
  },
  file_change: {
    label: 'change workspace files directly',
    toolNames: ['workspace.write_file', 'workspace.edit_file'],
  },
  command: {
    label: 'run mutating or networked shell commands',
    toolNames: [SESSION_WORKSPACE_MUTATION_TOOL_NAME],
  },
  git_change: {
    label: 'manage git changes',
    toolNames: ['git.add', 'git.commit', 'git.branch'],
  },
};

function resolveDescription(entry: SessionWorkspaceToolCatalogRecord, serverName: string): string {
  return typeof entry.description === 'function' ? entry.description(serverName) : entry.description;
}

function resolveEntry(entry: SessionWorkspaceToolCatalogRecord, serverName: string): SessionWorkspaceToolCatalogEntry {
  return {
    ...entry,
    description: resolveDescription(entry, serverName),
    toolKey: buildAgentToolKey(SESSION_WORKSPACE_SERVER_SLUG, entry.toolName),
  };
}

export function listSessionWorkspaceToolCatalog(
  serverName = SESSION_WORKSPACE_SERVER_NAME
): SessionWorkspaceToolCatalogEntry[] {
  return SESSION_WORKSPACE_TOOL_CATALOG.map((entry) => resolveEntry(entry, serverName));
}

export function listAdminVisibleSessionWorkspaceToolCatalog(
  serverName = SESSION_WORKSPACE_SERVER_NAME
): SessionWorkspaceToolCatalogEntry[] {
  return listSessionWorkspaceToolCatalog(serverName).filter((entry) => entry.adminVisibility === 'visible');
}

export function getSessionWorkspaceCatalogEntriesForRuntimeTool(
  runtimeToolName: string,
  serverName = SESSION_WORKSPACE_SERVER_NAME
): SessionWorkspaceToolCatalogEntry[] {
  return SESSION_WORKSPACE_TOOL_CATALOG.filter((entry) => entry.runtimeToolName === runtimeToolName).map((entry) =>
    resolveEntry(entry, serverName)
  );
}

export function getSessionWorkspaceToolSortKey(toolName: string): number {
  const entry = SESSION_WORKSPACE_TOOL_CATALOG.find((item) => item.toolName === toolName);
  return entry?.order ?? Number.MAX_SAFE_INTEGER;
}

function isSessionWorkspaceToolAllowed(
  entry: SessionWorkspaceToolCatalogEntry,
  approvalPolicy: AgentApprovalPolicy,
  toolRules: AgentSessionToolRule[] = []
): boolean {
  const rule = toolRules.find((item) => item.toolKey === entry.toolKey);
  if (rule?.mode === 'deny') {
    return false;
  }

  const capabilityKey = AgentPolicyService.capabilityForMcpTool(entry.toolName, entry.annotations);

  return AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey) !== 'deny';
}

export function buildSessionWorkspacePromptLines({
  approvalPolicy,
  toolRules,
  includeSkills,
}: {
  approvalPolicy: AgentApprovalPolicy;
  toolRules?: AgentSessionToolRule[];
  includeSkills?: boolean;
}): string[] {
  const entries = listSessionWorkspaceToolCatalog().filter((entry) =>
    isSessionWorkspaceToolAllowed(entry, approvalPolicy, toolRules)
  );
  const availableToolNames = new Set(entries.map((entry) => entry.toolName));
  const lines: string[] = [];

  for (const category of ['inspect', 'file_change', 'command', 'git_change', 'skills'] as const) {
    if (category === 'skills' && !includeSkills) {
      continue;
    }

    const copy = PROMPT_CATEGORY_COPY[category];
    const toolNames = copy.toolNames.filter((toolName) => availableToolNames.has(toolName));

    if (toolNames.length === 0) {
      continue;
    }

    lines.push(`- ${copy.label}: ${toolNames.join(', ')}`);
  }

  if (lines.length > 0) {
    lines.push('- do not claim a tool is unavailable unless it is not equipped here or a real tool call fails');
  }

  return lines;
}
