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

export type AgentDefinitionOwnerKind = 'system' | 'admin' | 'user';
export type AgentDefinitionStatus = 'active' | 'disabled' | 'archived';

export interface AgentDefinitionOwner {
  kind: AgentDefinitionOwnerKind;
  userId?: string | null;
  organizationId?: string | null;
}

export interface AgentDefinitionResourcePolicy {
  sourceKinds: string[];
  sandboxRequired?: boolean;
  workspaceRequired?: boolean;
}

export interface AgentDefinitionModelPreference {
  provider?: string | null;
  model?: string | null;
}

export type UserAgentDefinitionResourceBehavior = 'chat_only' | 'current_workspace_when_available';

export interface UserAgentDefinitionUpsertInput {
  name: string;
  description?: string | null;
  instructionAddendum: string;
  capabilityRefs?: AgentCapabilityCatalogId[];
  modelPreference?: AgentDefinitionModelPreference | null;
  resourceBehavior: UserAgentDefinitionResourceBehavior;
}

export interface UserAgentDefinitionListFilters {
  status?: Extract<AgentDefinitionStatus, 'active' | 'disabled'>;
}

export interface AgentDefinitionContract {
  id: string;
  version: number;
  owner: AgentDefinitionOwner;
  name: string;
  description?: string | null;
  instructionRefs: string[];
  instructionAddendum?: string | null;
  capabilityRefs: AgentCapabilityCatalogId[];
  requiredCapabilityRefs?: AgentCapabilityCatalogId[];
  optionalCapabilityRefs?: AgentCapabilityCatalogId[];
  resourcePolicy: AgentDefinitionResourcePolicy;
  modelPreference?: AgentDefinitionModelPreference | null;
  status: AgentDefinitionStatus;
  codeOwned?: boolean;
  readOnly?: boolean;
}
