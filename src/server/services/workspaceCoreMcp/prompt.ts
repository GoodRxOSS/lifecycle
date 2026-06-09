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

import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import AgentPolicyService from 'server/services/agent/PolicyService';
import type { AgentRuntimeToolMetadata } from 'server/services/agent/toolMetadata';
import type { AgentApprovalPolicy } from 'server/services/agent/types';
import { buildAgentToolKey } from 'server/services/agent/toolKeys';
import {
  WORKSPACE_CORE_SERVER_SLUG,
  WORKSPACE_CORE_TOOL_DEFINITIONS,
  type WorkspaceCoreToolName,
} from './toolDefinitions';

type WorkspaceCorePromptCategory = {
  label: string;
  toolNames: WorkspaceCoreToolName[];
};

const PROMPT_CATEGORIES: readonly WorkspaceCorePromptCategory[] = [
  {
    label: 'inspect files, search code, and read git state',
    toolNames: ['read_file', 'list_files', 'glob', 'grep', 'git_status', 'git_diff'],
  },
  {
    label: 'edit workspace files',
    toolNames: ['apply_patch', 'edit_file', 'write_file'],
  },
  {
    label: 'run commands and manage async operations',
    toolNames: ['exec', 'operation_status', 'operation_logs', 'operation_cancel'],
  },
  {
    label: 'run long-lived services such as dev servers',
    toolNames: ['start_service', 'service_status'],
  },
  {
    label: 'publish and verify HTTP previews',
    toolNames: ['publish_http'],
  },
];

function workspaceCoreToolKey(toolName: WorkspaceCoreToolName): string {
  return buildAgentToolKey(WORKSPACE_CORE_SERVER_SLUG, toolName);
}

function isWorkspaceCoreMetadata(metadata: AgentRuntimeToolMetadata): boolean {
  return metadata.serverSlug === WORKSPACE_CORE_SERVER_SLUG || metadata.toolKey.startsWith('mcp__workspace_core__');
}

function isToolAllowed({
  toolName,
  approvalPolicy,
  toolRules = [],
}: {
  toolName: WorkspaceCoreToolName;
  approvalPolicy: AgentApprovalPolicy;
  toolRules?: AgentSessionToolRule[];
}): boolean {
  const definition = WORKSPACE_CORE_TOOL_DEFINITIONS.find((tool) => tool.name === toolName);
  if (!definition) {
    return false;
  }

  const toolKey = workspaceCoreToolKey(toolName);
  const ruleMode = toolRules.find((rule) => rule.toolKey === toolKey)?.mode;
  const policyMode = AgentPolicyService.modeForCapability(approvalPolicy, definition.capabilityKey);

  return (ruleMode || policyMode) !== 'deny';
}

export function buildWorkspaceCorePromptLines({
  approvalPolicy,
  toolRules,
  runtimeToolMetadata,
}: {
  approvalPolicy: AgentApprovalPolicy;
  toolRules?: AgentSessionToolRule[];
  runtimeToolMetadata?: readonly AgentRuntimeToolMetadata[];
}): string[] {
  const runtimeWorkspaceCoreKeys = runtimeToolMetadata
    ? new Set(runtimeToolMetadata.filter(isWorkspaceCoreMetadata).map((metadata) => metadata.toolKey))
    : null;

  if (runtimeToolMetadata && runtimeWorkspaceCoreKeys?.size === 0) {
    return [];
  }

  const availableToolNames = new Set<WorkspaceCoreToolName>();
  for (const definition of WORKSPACE_CORE_TOOL_DEFINITIONS) {
    const toolKey = workspaceCoreToolKey(definition.name);
    if (runtimeWorkspaceCoreKeys && !runtimeWorkspaceCoreKeys.has(toolKey)) {
      continue;
    }
    if (!isToolAllowed({ toolName: definition.name, approvalPolicy, toolRules })) {
      continue;
    }
    availableToolNames.add(definition.name);
  }

  const lines: string[] = [];
  for (const category of PROMPT_CATEGORIES) {
    const toolKeys = category.toolNames
      .filter((toolName) => availableToolNames.has(toolName))
      .map((toolName) => workspaceCoreToolKey(toolName));

    if (toolKeys.length > 0) {
      lines.push(`- ${category.label}: ${toolKeys.join(', ')}`);
    }
  }

  if (lines.length === 0) {
    return [];
  }

  lines.push('- do not claim a tool is unavailable unless it is not equipped here or a real tool call fails');
  if (availableToolNames.has('exec')) {
    lines.push('- use workspace_core.exec for bounded commands, tests, and installs');
  }
  if (availableToolNames.has('start_service')) {
    lines.push(
      '- start dev servers and anything that must keep running with workspace_core.start_service, never async exec: async operations are killed when their duration budget elapses'
    );
  }
  if (availableToolNames.has('publish_http')) {
    lines.push(
      '- when serving an HTTP preview from the workspace, start the app inside the workspace and use workspace_core.publish_http; treat unhealthy results as not reachable'
    );
  }

  return lines;
}
