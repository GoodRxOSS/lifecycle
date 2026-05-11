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

import type { AgentCapabilityCatalogId } from './capabilityCatalog';
import type { AgentApprovalMode, AgentCapabilityKey } from './types';

export type AgentRuntimeToolEffect = 'read' | 'write';
export type AgentRuntimeToolExposure = 'read' | 'repair';
export type AgentRuntimeToolWorkspaceNeed = 'none' | 'optional' | 'required';
export type AgentRuntimeToolResourceDomain =
  | 'lifecycle'
  | 'codefresh'
  | 'kubernetes'
  | 'database'
  | 'github'
  | 'workspace'
  | 'git'
  | 'mcp'
  | 'preview'
  | 'network'
  | 'approval';

export type AgentRuntimeToolMetadata = {
  toolKey: string;
  catalogCapabilityId: AgentCapabilityCatalogId;
  capabilityKey: AgentCapabilityKey;
  approvalMode: AgentApprovalMode;
  effect?: AgentRuntimeToolEffect;
  resourceDomain?: AgentRuntimeToolResourceDomain;
  workspaceNeed?: AgentRuntimeToolWorkspaceNeed;
  exposure?: AgentRuntimeToolExposure;
};

export function classifyToolEffect(capabilityKey: AgentCapabilityKey): AgentRuntimeToolEffect {
  return capabilityKey === 'read' || capabilityKey === 'external_mcp_read' ? 'read' : 'write';
}

function classifyToolResourceDomain({
  catalogCapabilityId,
  toolKey,
}: {
  catalogCapabilityId: AgentCapabilityCatalogId;
  toolKey: string;
}): AgentRuntimeToolResourceDomain {
  if (catalogCapabilityId === 'diagnostics_codefresh') return 'codefresh';
  if (catalogCapabilityId === 'diagnostics_kubernetes') return 'kubernetes';
  if (catalogCapabilityId === 'diagnostics_database') return 'database';
  if (catalogCapabilityId === 'github_read' || catalogCapabilityId === 'github_write') return 'github';
  if (catalogCapabilityId === 'workspace_git') return 'git';
  if (catalogCapabilityId === 'workspace_files' || catalogCapabilityId === 'workspace_shell') return 'workspace';
  if (catalogCapabilityId === 'external_mcp_read' || catalogCapabilityId === 'external_mcp_write') return 'mcp';
  if (catalogCapabilityId === 'preview_publish') return 'preview';
  if (catalogCapabilityId === 'network_access') return 'network';
  if (catalogCapabilityId === 'approval_controls') return 'approval';
  if (toolKey.includes('__lifecycle__')) return 'lifecycle';
  return 'workspace';
}

function classifyWorkspaceNeed(catalogCapabilityId: AgentCapabilityCatalogId): AgentRuntimeToolWorkspaceNeed {
  if (
    catalogCapabilityId === 'workspace_files' ||
    catalogCapabilityId === 'workspace_shell' ||
    catalogCapabilityId === 'workspace_git' ||
    catalogCapabilityId === 'preview_publish'
  ) {
    return 'required';
  }

  if (catalogCapabilityId === 'read_context') {
    return 'optional';
  }

  return 'none';
}

export function buildAgentRuntimeToolMetadata(
  metadata: Omit<AgentRuntimeToolMetadata, 'effect' | 'resourceDomain' | 'workspaceNeed' | 'exposure'>
): AgentRuntimeToolMetadata {
  const effect = classifyToolEffect(metadata.capabilityKey);
  return {
    ...metadata,
    effect,
    resourceDomain: classifyToolResourceDomain(metadata),
    workspaceNeed: classifyWorkspaceNeed(metadata.catalogCapabilityId),
    exposure: effect === 'read' ? 'read' : 'repair',
  };
}

export function isReadOnlyRuntimeTool(metadata: AgentRuntimeToolMetadata): boolean {
  return (metadata.effect || classifyToolEffect(metadata.capabilityKey)) === 'read';
}

export function isApprovalGatedWriteRuntimeTool(metadata: AgentRuntimeToolMetadata): boolean {
  return !isReadOnlyRuntimeTool(metadata) && metadata.approvalMode === 'require_approval';
}
