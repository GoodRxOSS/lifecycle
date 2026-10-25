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

import type { AgentDefinitionOwnerKind } from './agentDefinitionTypes';
import type { AgentCapabilityCatalogId } from './capabilityCatalog';
import type { AgentApprovalMode, AgentApprovalPolicy, AgentCapabilityKey } from './types';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import type { CapabilityPolicyConfig, CustomAgentCreationPolicyConfig } from 'server/services/types/agentRuntimeConfig';
import AgentPolicyService, { type ResolvedAgentCapabilityAccess } from './PolicyService';
import { isCatalogCapabilityAllowed } from './capabilityToolHelpers';
import { buildAgentToolKey } from './toolKeys';

export type WorkspaceMcpAdmission = {
  catalogCapabilityId: AgentCapabilityCatalogId;
  approvalCapabilities: AgentCapabilityKey[];
};

export function resolveWorkspaceMcpAdmission({
  resolvedCapabilityAccess,
  definitionOwnerKind,
  sourceKind,
  capabilityPolicy,
  customAgentCreationPolicy,
  approvalPolicy,
}: {
  resolvedCapabilityAccess?: ResolvedAgentCapabilityAccess[];
  definitionOwnerKind?: AgentDefinitionOwnerKind;
  sourceKind?: string;
  capabilityPolicy?: CapabilityPolicyConfig;
  customAgentCreationPolicy?: CustomAgentCreationPolicyConfig;
  approvalPolicy: AgentApprovalPolicy;
}): WorkspaceMcpAdmission | null {
  if (capabilityPolicy?.availability?.external_mcp_write === 'disabled') return null;
  if (isCatalogCapabilityAllowed(resolvedCapabilityAccess, 'external_mcp_write')) {
    return { catalogCapabilityId: 'external_mcp_write', approvalCapabilities: ['external_mcp_write'] };
  }

  if (
    !definitionOwnerKind ||
    (sourceKind !== 'workspace_session' && sourceKind !== 'freeform_chat') ||
    !isCatalogCapabilityAllowed(resolvedCapabilityAccess, 'workspace_shell') ||
    !isCatalogCapabilityAllowed(resolvedCapabilityAccess, 'external_mcp_read')
  ) {
    return null;
  }

  const writePolicy = AgentPolicyService.resolveCapabilityAccess({
    capabilityId: 'external_mcp_write',
    definitionOwnerKind,
    sourceKind,
    capabilityPolicy,
    customAgentCreationPolicy,
    approvalPolicy,
  });
  if (!writePolicy.allowed) return null;

  return {
    catalogCapabilityId: 'workspace_shell',
    approvalCapabilities: ['external_mcp_write', 'shell_exec', 'external_mcp_read'],
  };
}

export function workspaceMcpApprovalMode(
  admission: WorkspaceMcpAdmission,
  approvalPolicy: AgentApprovalPolicy,
  toolRules?: AgentSessionToolRule[],
  toolKey?: string
): AgentApprovalMode {
  const rule = toolKey ? toolRules?.find((entry) => entry.toolKey === toolKey) : undefined;
  if (rule) return rule.mode;
  const modes = admission.approvalCapabilities.map((key) => AgentPolicyService.modeForCapability(approvalPolicy, key));
  if (modes.includes('deny')) return 'deny';
  return modes.includes('require_approval') ? 'require_approval' : 'allow';
}

export function canDiscoverWorkspaceMcp(
  admission: WorkspaceMcpAdmission | null,
  serverSlug: string,
  approvalPolicy: AgentApprovalPolicy,
  toolRules?: AgentSessionToolRule[]
): boolean {
  if (!admission) return false;
  if (workspaceMcpApprovalMode(admission, approvalPolicy) !== 'deny') return true;
  const prefix = buildAgentToolKey(serverSlug, '');
  return Boolean(
    toolRules?.some(
      (rule) =>
        rule.toolKey.startsWith(prefix) &&
        rule.toolKey.length > prefix.length &&
        workspaceMcpApprovalMode(admission, approvalPolicy, toolRules, rule.toolKey) !== 'deny'
    )
  );
}
