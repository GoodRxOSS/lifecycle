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

import type { AgentDefinitionContract } from './agentDefinitionTypes';
import type { AgentCapabilitySourceKind } from './capabilityCatalog';

export const SYSTEM_AGENT_DEFINITION_IDS = ['system.debug', 'system.develop', 'system.freeform'] as const;

export type SystemAgentDefinitionId = (typeof SYSTEM_AGENT_DEFINITION_IDS)[number];

function defineSystemAgent(
  systemId: SystemAgentDefinitionId,
  definition: Omit<
    AgentDefinitionContract,
    | 'id'
    | 'version'
    | 'owner'
    | 'requiredCapabilityRefs'
    | 'optionalCapabilityRefs'
    | 'status'
    | 'codeOwned'
    | 'readOnly'
  >
): AgentDefinitionContract {
  return {
    id: systemId,
    version: 1,
    owner: { kind: 'system' },
    ...definition,
    requiredCapabilityRefs: [...definition.capabilityRefs],
    optionalCapabilityRefs: [],
    status: 'active',
    codeOwned: true,
    readOnly: true,
  };
}

export const SYSTEM_AGENT_DEFINITIONS: Record<SystemAgentDefinitionId, AgentDefinitionContract> = {
  'system.debug': defineSystemAgent('system.debug', {
    name: 'Debug',
    description: 'Investigate build and environment context.',
    instructionRefs: ['system:debug'],
    capabilityRefs: [
      'diagnostics_logs',
      'diagnostics_codefresh',
      'diagnostics_kubernetes',
      'diagnostics_database',
      'github_read',
      'github_write',
      'external_mcp_read',
    ],
    resourcePolicy: {
      sourceKinds: ['build_context_chat'],
      sandboxRequired: false,
      workspaceRequired: false,
    },
  }),
  'system.develop': defineSystemAgent('system.develop', {
    name: 'Develop',
    description: 'Work in a prepared Lifecycle workspace.',
    instructionRefs: ['system:develop'],
    capabilityRefs: [
      'read_context',
      'workspace_files',
      'workspace_shell',
      'workspace_git',
      'network_access',
      'preview_publish',
      'external_mcp_read',
    ],
    resourcePolicy: {
      sourceKinds: ['workspace_session'],
      sandboxRequired: true,
      workspaceRequired: true,
    },
  }),
  'system.freeform': defineSystemAgent('system.freeform', {
    name: 'Free-form',
    description: 'Answer general questions without build or workspace requirements.',
    instructionRefs: ['system:freeform'],
    capabilityRefs: ['read_context', 'external_mcp_read'],
    resourcePolicy: {
      sourceKinds: ['build_context_chat', 'workspace_session', 'freeform_chat'],
      sandboxRequired: false,
      workspaceRequired: false,
    },
  }),
};

export function isSystemAgentDefinitionId(value: unknown): value is SystemAgentDefinitionId {
  return typeof value === 'string' && SYSTEM_AGENT_DEFINITION_IDS.includes(value as SystemAgentDefinitionId);
}

export function sourceKindForSystemAgentDefinitionId(id: SystemAgentDefinitionId): AgentCapabilitySourceKind {
  switch (id) {
    case 'system.debug':
      return 'build_context_chat';
    case 'system.develop':
      return 'workspace_session';
    case 'system.freeform':
      return 'freeform_chat';
  }
}
