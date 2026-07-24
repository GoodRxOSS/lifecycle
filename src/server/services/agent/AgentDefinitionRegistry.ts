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

import AgentDefinition from 'server/models/AgentDefinition';
import type AgentSession from 'server/models/AgentSession';
import type AgentSource from 'server/models/AgentSource';
import { AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';
import type { AgentDefinitionContract } from './agentDefinitionTypes';
import type { AgentCapabilitySourceKind } from './capabilityCatalog';
import {
  isSystemAgentDefinitionId,
  SYSTEM_AGENT_DEFINITIONS,
  SYSTEM_AGENT_DEFINITION_IDS,
  type SystemAgentDefinitionId,
} from './systemAgentDefinitions';

export type AgentDefinitionSummary = {
  id: string;
  version: number;
  ownerKind: AgentDefinitionContract['owner']['kind'];
  name: string;
  description?: string | null;
  status: AgentDefinitionContract['status'];
  capabilityRefs: AgentDefinitionContract['capabilityRefs'];
  requiredCapabilityRefs: AgentDefinitionContract['capabilityRefs'];
  optionalCapabilityRefs: AgentDefinitionContract['capabilityRefs'];
  resourcePolicy: AgentDefinitionContract['resourcePolicy'];
  codeOwned: boolean;
  readOnly: boolean;
};

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toPersistenceRow(definition: AgentDefinitionContract): Partial<AgentDefinition> {
  return {
    definitionId: definition.id,
    version: definition.version,
    ownerKind: definition.owner.kind,
    ownerUserId: definition.owner.userId || null,
    ownerOrganizationId: definition.owner.organizationId || null,
    name: definition.name,
    description: definition.description || null,
    instructionRefs: definition.instructionRefs || [],
    instructionAddendum: definition.instructionAddendum || null,
    capabilityRefs: definition.capabilityRefs || [],
    requiredCapabilityRefs: definition.requiredCapabilityRefs || definition.capabilityRefs || [],
    optionalCapabilityRefs: definition.optionalCapabilityRefs || [],
    resourcePolicy: definition.resourcePolicy,
    modelPreference: definition.modelPreference || null,
    status: definition.status,
    codeOwned: Boolean(definition.codeOwned),
    readOnly: Boolean(definition.readOnly),
  };
}

export function agentDefinitionRowToContract(row: AgentDefinition): AgentDefinitionContract {
  return {
    id: row.definitionId,
    version: row.version,
    owner: {
      kind: row.ownerKind,
      userId: row.ownerUserId,
      organizationId: row.ownerOrganizationId,
    },
    name: row.name,
    description: row.description,
    instructionRefs: row.instructionRefs || [],
    instructionAddendum: row.instructionAddendum,
    capabilityRefs: row.capabilityRefs || [],
    requiredCapabilityRefs: row.requiredCapabilityRefs || row.capabilityRefs || [],
    optionalCapabilityRefs: row.optionalCapabilityRefs || [],
    resourcePolicy: row.resourcePolicy,
    modelPreference: row.modelPreference,
    status: row.status,
    codeOwned: row.codeOwned,
    readOnly: row.readOnly,
  };
}

export async function ensureSystemAgentDefinitionsSeeded(): Promise<AgentDefinitionContract[]> {
  const rows = await Promise.all(
    SYSTEM_AGENT_DEFINITION_IDS.map(async (agentId) => {
      const row = toPersistenceRow(SYSTEM_AGENT_DEFINITIONS[agentId]);
      return AgentDefinition.upsert(row, ['definitionId']) as Promise<AgentDefinition>;
    })
  );

  return rows.map(agentDefinitionRowToContract);
}

export async function listSystemAgentDefinitions(): Promise<AgentDefinitionContract[]> {
  const rows = await AgentDefinition.query()
    .whereIn('definitionId', [...SYSTEM_AGENT_DEFINITION_IDS])
    .where({ ownerKind: 'system' })
    .orderBy('definitionId', 'asc');

  return rows.map(agentDefinitionRowToContract);
}

export async function getSystemAgentDefinition(agentId: SystemAgentDefinitionId): Promise<AgentDefinitionContract> {
  const row = await AgentDefinition.query().findOne({
    definitionId: agentId,
    ownerKind: 'system',
  });

  if (!row) {
    throw new Error(`System agent definition not found: ${agentId}`);
  }

  return agentDefinitionRowToContract(row);
}

export function serializeAgentDefinitionSummary(definition: AgentDefinitionContract): AgentDefinitionSummary {
  return {
    id: definition.id,
    version: definition.version,
    ownerKind: definition.owner.kind,
    name: definition.name,
    description: definition.description || null,
    status: definition.status,
    capabilityRefs: definition.capabilityRefs,
    requiredCapabilityRefs: definition.requiredCapabilityRefs || definition.capabilityRefs,
    optionalCapabilityRefs: definition.optionalCapabilityRefs || [],
    resourcePolicy: definition.resourcePolicy,
    codeOwned: Boolean(definition.codeOwned),
    readOnly: Boolean(definition.readOnly),
  };
}

export function assertAgentDefinitionMutable(definition: AgentDefinitionContract): void {
  if (definition.codeOwned || definition.readOnly) {
    throw new Error(`Agent definition "${definition.id}" is code-owned and read-only.`);
  }
}

export function inferDefaultAgentSourceKind(session: AgentSession, source: AgentSource): AgentCapabilitySourceKind {
  if (session.sessionKind === AgentSessionKind.CHAT) {
    if (readString(source.input?.buildUuid)) {
      return 'build_context_chat';
    }

    if (session.workspaceStatus === AgentWorkspaceStatus.READY) {
      return 'workspace_session';
    }

    return 'freeform_chat';
  }

  return 'workspace_session';
}

export function inferDefaultSystemAgentDefinitionId(
  session: AgentSession,
  source: AgentSource
): SystemAgentDefinitionId {
  void session;
  void source;
  return 'system.agent';
}

export function normalizeSystemAgentDefinitionId(value: unknown): SystemAgentDefinitionId | null {
  return isSystemAgentDefinitionId(value) ? value : null;
}
