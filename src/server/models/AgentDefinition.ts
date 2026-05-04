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

import Model from './_Model';
import type { AgentCapabilityCatalogId } from 'server/services/agent/capabilityCatalog';
import type {
  AgentDefinitionModelPreference,
  AgentDefinitionOwnerKind,
  AgentDefinitionResourcePolicy,
  AgentDefinitionStatus,
} from 'server/services/agent/agentDefinitionTypes';

export default class AgentDefinition extends Model {
  definitionId!: string;
  version!: number;
  ownerKind!: AgentDefinitionOwnerKind;
  ownerUserId!: string | null;
  ownerOrganizationId!: string | null;
  name!: string;
  description!: string | null;
  instructionRefs!: string[];
  instructionAddendum!: string | null;
  capabilityRefs!: AgentCapabilityCatalogId[];
  requiredCapabilityRefs!: AgentCapabilityCatalogId[];
  optionalCapabilityRefs!: AgentCapabilityCatalogId[];
  resourcePolicy!: AgentDefinitionResourcePolicy;
  modelPreference!: AgentDefinitionModelPreference | null;
  status!: AgentDefinitionStatus;
  codeOwned!: boolean;
  readOnly!: boolean;

  static tableName = 'agent_definitions';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['definitionId', 'version', 'ownerKind', 'name', 'instructionRefs', 'capabilityRefs', 'resourcePolicy'],
    properties: {
      id: { type: 'integer' },
      definitionId: { type: 'string', minLength: 1 },
      version: { type: 'integer', minimum: 1, default: 1 },
      ownerKind: { type: 'string', enum: ['system', 'admin', 'user'] },
      ownerUserId: { type: ['string', 'null'] },
      ownerOrganizationId: { type: ['string', 'null'] },
      name: { type: 'string', minLength: 1 },
      description: { type: ['string', 'null'] },
      instructionRefs: { type: 'array', items: { type: 'string' }, default: [] },
      instructionAddendum: { type: ['string', 'null'] },
      capabilityRefs: { type: 'array', items: { type: 'string' }, default: [] },
      requiredCapabilityRefs: { type: 'array', items: { type: 'string' }, default: [] },
      optionalCapabilityRefs: { type: 'array', items: { type: 'string' }, default: [] },
      resourcePolicy: {
        type: 'object',
        required: ['sourceKinds'],
        properties: {
          sourceKinds: { type: 'array', items: { type: 'string' }, default: [] },
          sandboxRequired: { type: 'boolean' },
          workspaceRequired: { type: 'boolean' },
        },
        default: { sourceKinds: [] },
      },
      modelPreference: { type: ['object', 'null'], default: null },
      status: { type: 'string', enum: ['active', 'disabled', 'archived'], default: 'active' },
      codeOwned: { type: 'boolean', default: false },
      readOnly: { type: 'boolean', default: false },
    },
  };

  static get jsonAttributes() {
    return [
      'instructionRefs',
      'capabilityRefs',
      'requiredCapabilityRefs',
      'optionalCapabilityRefs',
      'resourcePolicy',
      'modelPreference',
    ];
  }
}
