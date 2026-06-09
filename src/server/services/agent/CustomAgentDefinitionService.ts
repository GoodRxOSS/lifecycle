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

import type { RequestUserIdentity } from 'server/lib/get-user';
import { AppError } from 'server/lib/appError';
import AgentDefinition from 'server/models/AgentDefinition';
import AgentRuntimeConfigService from 'server/services/agentRuntime/config/agentRuntimeConfig';
import { v4 as uuid } from 'uuid';
import type { CapabilityPolicyConfig, CustomAgentCreationPolicyConfig } from 'server/services/types/agentRuntimeConfig';
import {
  listAgentCapabilityCatalogEntries,
  type AgentCapabilityCatalogId,
  type AgentCapabilityCategory,
  type AgentCapabilitySourceKind,
} from './capabilityCatalog';
import { agentDefinitionRowToContract } from './AgentDefinitionRegistry';
import type {
  AgentDefinitionContract,
  AgentDefinitionModelPreference,
  AgentDefinitionResourcePolicy,
  UserAgentDefinitionListFilters,
  UserAgentDefinitionResourceBehavior,
  UserAgentDefinitionUpsertInput,
} from './agentDefinitionTypes';
import AgentPolicyService, { type AgentCapabilityAccessReason } from './PolicyService';
import AgentProviderRegistry from './ProviderRegistry';

type CustomAgentDefinitionErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'model_unavailable'
  | 'creation_unavailable'
  | 'creator_capability_reserved'
  | AgentCapabilityAccessReason;
type CustomAgentDefinitionUserIdentity = Pick<RequestUserIdentity, 'githubUsername' | 'userId'> &
  Partial<Pick<RequestUserIdentity, 'roles'>>;
export type CustomAgentCreationUnavailableReason = 'creation_disabled' | 'creation_restricted';
export interface CustomAgentCreationStatus {
  canCreate: boolean;
  creationUnavailableReason: CustomAgentCreationUnavailableReason | null;
}

const CAPABILITY_UNAVAILABLE_MESSAGE =
  'Some selected capabilities are no longer available. Review the list and save again.';
const MODEL_UNAVAILABLE_MESSAGE = 'Selected model is no longer available. Choose another model and save again.';
const CREATION_UNAVAILABLE_MESSAGE = 'Custom agent creation is not available. Ask an admin for access.';
export const CUSTOM_AGENT_NEEDS_CONVERSION_MESSAGE =
  'This custom agent needs conversion before it can run in the one-agent harness.';
const CAPABILITY_DENIAL_REASONS = new Set<AgentCapabilityAccessReason>([
  'unknown_capability',
  'admin_only',
  'system_only',
  'disabled',
  'source_incompatible',
]);

export interface UserAgentDefinitionCapabilityDisplaySummary {
  name: string;
  description: string | null;
}

export interface UserAgentDefinitionCapability {
  capabilityId: AgentCapabilityCatalogId;
  label: string;
  description: string;
  category: AgentCapabilityCategory;
  toolCount: number;
  resourceCount: number;
  requiresWorkspace: boolean;
  tools: UserAgentDefinitionCapabilityDisplaySummary[];
  resources: UserAgentDefinitionCapabilityDisplaySummary[];
}

export interface UserAgentDefinitionPublicContract {
  id: string;
  version: number;
  name: string;
  description: string | null;
  instructions: string;
  capabilityIds: AgentCapabilityCatalogId[];
  modelPreference: AgentDefinitionModelPreference | null;
  resourceBehavior: UserAgentDefinitionResourceBehavior;
  status: 'active' | 'archived';
}

// Maps each service-error discriminant to {httpStatus, stable contract code} so routes never re-map.
const CUSTOM_AGENT_ERROR_CONTRACT: Record<CustomAgentDefinitionErrorCode, { httpStatus: number; code: string }> = {
  not_found: { httpStatus: 404, code: 'custom_agent_not_found' },
  invalid_input: { httpStatus: 400, code: 'custom_agent_invalid' },
  model_unavailable: { httpStatus: 409, code: 'custom_agent_conflict' },
  creation_unavailable: { httpStatus: 403, code: 'custom_agent_creation_unavailable' },
  creator_capability_reserved: { httpStatus: 400, code: 'custom_agent_invalid' },
  unknown_capability: { httpStatus: 400, code: 'custom_agent_invalid' },
  admin_only: { httpStatus: 400, code: 'custom_agent_invalid' },
  system_only: { httpStatus: 400, code: 'custom_agent_invalid' },
  disabled: { httpStatus: 400, code: 'custom_agent_invalid' },
  source_incompatible: { httpStatus: 400, code: 'custom_agent_invalid' },
};

export class CustomAgentDefinitionServiceError extends AppError {
  readonly reason: CustomAgentDefinitionErrorCode;

  constructor(reason: CustomAgentDefinitionErrorCode, message: string) {
    const contract = CUSTOM_AGENT_ERROR_CONTRACT[reason];
    super({ httpStatus: contract.httpStatus, code: contract.code, message, details: { reason } });
    this.name = 'CustomAgentDefinitionServiceError';
    this.reason = reason;
  }
}

function trimRequired(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CustomAgentDefinitionServiceError('invalid_input', `${fieldName} is required.`);
  }
  return trimmed;
}

function trimNullable(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function dedupeCapabilities(capabilityRefs: AgentCapabilityCatalogId[] | undefined): AgentCapabilityCatalogId[] {
  return [...new Set(capabilityRefs || [])];
}

function normalizeModelPreference(
  modelPreference: AgentDefinitionModelPreference | null | undefined
): AgentDefinitionModelPreference | null {
  if (!modelPreference) {
    return null;
  }

  const provider = trimNullable(modelPreference.provider);
  const model = trimNullable(modelPreference.model);

  if (!provider && !model) {
    return null;
  }

  return { provider, model };
}

function resourcePolicyForBehavior(
  resourceBehavior: UserAgentDefinitionResourceBehavior
): AgentDefinitionResourcePolicy {
  if (resourceBehavior === 'current_workspace_when_available') {
    return {
      sourceKinds: ['freeform_chat', 'workspace_session'],
      workspaceRequired: false,
      sandboxRequired: false,
    };
  }

  return {
    sourceKinds: ['freeform_chat'],
    workspaceRequired: false,
    sandboxRequired: false,
  };
}

function resourceBehaviorForPolicy(resourcePolicy: AgentDefinitionResourcePolicy): UserAgentDefinitionResourceBehavior {
  return resourcePolicy.sourceKinds.includes('workspace_session') ? 'current_workspace_when_available' : 'chat_only';
}

function sourceKindsForResourceBehavior(
  resourceBehavior: UserAgentDefinitionResourceBehavior
): AgentCapabilitySourceKind[] {
  if (resourceBehavior === 'current_workspace_when_available') {
    return ['freeform_chat', 'workspace_session'];
  }

  return ['freeform_chat'];
}

function normalizeIdentifierList(values: string[] | undefined, options: { lowercase?: boolean } = {}): Set<string> {
  return new Set(
    (values || [])
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (options.lowercase ? value.toLowerCase() : value))
  );
}

function isCustomAgentCreatorAllowed(
  userIdentity: CustomAgentDefinitionUserIdentity,
  policy?: CustomAgentCreationPolicyConfig
): boolean {
  const mode = policy?.mode || 'enabled';
  if (mode === 'enabled') {
    return true;
  }
  if (mode === 'disabled') {
    return false;
  }
  if (mode === 'admins_only') {
    return Boolean(userIdentity.roles?.includes('admin'));
  }

  const allowedUserIds = normalizeIdentifierList(policy?.allowedUserIds);
  const allowedGithubUsernames = normalizeIdentifierList(policy?.allowedGithubUsernames, { lowercase: true });
  const githubUsername = userIdentity.githubUsername?.trim().toLowerCase();

  return (
    allowedUserIds.has(userIdentity.userId) || Boolean(githubUsername && allowedGithubUsernames.has(githubUsername))
  );
}

function getCustomAgentCreationUnavailableReason(
  userIdentity: CustomAgentDefinitionUserIdentity,
  policy?: CustomAgentCreationPolicyConfig
): CustomAgentCreationUnavailableReason | null {
  if (isCustomAgentCreatorAllowed(userIdentity, policy)) {
    return null;
  }

  return policy?.mode === 'disabled' ? 'creation_disabled' : 'creation_restricted';
}

function isCreatorCapabilityAvailable(
  capabilityId: AgentCapabilityCatalogId,
  policy?: CustomAgentCreationPolicyConfig
): boolean {
  return policy?.capabilityAvailability?.[capabilityId] !== 'reserved';
}

function displayNameFromIdentifier(value: string): string {
  return value
    .replace(/[_./-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizeUpsertInput(input: UserAgentDefinitionUpsertInput): {
  name: string;
  description: string | null;
  instructionAddendum: string;
  capabilityRefs: AgentCapabilityCatalogId[];
  modelPreference: AgentDefinitionModelPreference | null;
  resourcePolicy: AgentDefinitionResourcePolicy;
} {
  const capabilityRefs = dedupeCapabilities(input.capabilityRefs);

  return {
    name: trimRequired(input.name, 'Name'),
    description: trimNullable(input.description),
    instructionAddendum: trimRequired(input.instructionAddendum, 'Instructions'),
    capabilityRefs,
    modelPreference: normalizeModelPreference(input.modelPreference),
    resourcePolicy: resourcePolicyForBehavior(input.resourceBehavior),
  };
}

function selectDeniedCapabilityReason(
  results: ReturnType<typeof AgentPolicyService.resolveCapabilitySetAccess>
): AgentCapabilityAccessReason {
  const policyDenied = results.find((result) => result.reason && result.reason !== 'source_incompatible');
  const reason = policyDenied?.reason || results[0]?.reason;
  return reason && CAPABILITY_DENIAL_REASONS.has(reason) ? reason : 'unknown_capability';
}

export function serializeUserAgentDefinition(definition: AgentDefinitionContract): UserAgentDefinitionPublicContract {
  return {
    id: definition.id,
    version: definition.version,
    name: definition.name,
    description: definition.description || null,
    instructions: definition.instructionAddendum || '',
    capabilityIds: definition.optionalCapabilityRefs?.length
      ? definition.optionalCapabilityRefs
      : definition.capabilityRefs,
    modelPreference: definition.modelPreference || null,
    resourceBehavior: resourceBehaviorForPolicy(definition.resourcePolicy),
    status: definition.status === 'archived' ? 'archived' : 'active',
  };
}

export function customAgentDefinitionNeedsOneAgentConversion(definition: AgentDefinitionContract): boolean {
  if (definition.owner.kind !== 'user') {
    return false;
  }

  const sourceKinds = definition.resourcePolicy.sourceKinds;
  return Boolean(
    definition.resourcePolicy.workspaceRequired ||
      definition.resourcePolicy.sandboxRequired ||
      (sourceKinds.includes('workspace_session') && !sourceKinds.includes('freeform_chat'))
  );
}

export class CustomAgentDefinitionService {
  async getUserDefinitionCreationStatus({
    userIdentity,
  }: {
    userIdentity: RequestUserIdentity;
  }): Promise<CustomAgentCreationStatus> {
    const effectiveConfig = await AgentRuntimeConfigService.getInstance().getEffectiveConfig();
    const creationUnavailableReason = getCustomAgentCreationUnavailableReason(
      userIdentity,
      effectiveConfig.customAgentCreationPolicy
    );

    return {
      canCreate: creationUnavailableReason === null,
      creationUnavailableReason,
    };
  }

  async listUserSelectableCapabilities({
    userIdentity,
    resourceBehavior,
  }: {
    userIdentity: RequestUserIdentity;
    resourceBehavior: UserAgentDefinitionResourceBehavior;
  }): Promise<UserAgentDefinitionCapability[]> {
    const effectiveConfig = await AgentRuntimeConfigService.getInstance().getEffectiveConfig();
    if (getCustomAgentCreationUnavailableReason(userIdentity, effectiveConfig.customAgentCreationPolicy)) {
      return [];
    }

    const sourceKinds = sourceKindsForResourceBehavior(resourceBehavior);

    return listAgentCapabilityCatalogEntries()
      .filter((entry) => entry.userSelectable)
      .filter((entry) => isCreatorCapabilityAvailable(entry.id, effectiveConfig.customAgentCreationPolicy))
      .filter((entry) =>
        sourceKinds.some((sourceKind) => {
          const access = AgentPolicyService.resolveCapabilityAccess({
            capabilityId: entry.id,
            capabilityPolicy: effectiveConfig.capabilityPolicy,
            definitionOwnerKind: 'user',
            sourceKind,
          });
          return access.allowed;
        })
      )
      .map((entry) => {
        const runtimeToolNames = entry.toolKeys || [];
        const tools = runtimeToolNames.map((runtimeToolName) => ({
          name: displayNameFromIdentifier(runtimeToolName),
          description: null,
        }));
        const resources = (entry.resourceGrants || []).map((resourceGrant) => ({
          name: displayNameFromIdentifier(resourceGrant),
          description: null,
        }));

        return {
          capabilityId: entry.id,
          label: entry.label,
          description: entry.description,
          category: entry.category,
          toolCount: tools.length,
          resourceCount: resources.length,
          requiresWorkspace: Boolean(
            entry.sourceKinds?.includes('workspace_session') && !entry.sourceKinds.includes('freeform_chat')
          ),
          tools,
          resources,
        };
      });
  }

  async listUserDefinitions({
    userId,
    filters = {},
  }: {
    userId: string;
    filters?: UserAgentDefinitionListFilters;
  }): Promise<AgentDefinitionContract[]> {
    const rows = await AgentDefinition.query()
      .where({
        ownerKind: 'user',
        ownerUserId: userId,
        status: filters.status || 'active',
      })
      .orderBy('updatedAt', 'desc');

    return rows.map(agentDefinitionRowToContract);
  }

  async getUserDefinition(definitionId: string, userId: string): Promise<AgentDefinitionContract> {
    const row = await this.findActiveUserDefinitionRow(definitionId, userId);
    return agentDefinitionRowToContract(row);
  }

  async createUserDefinition(
    userIdentity: CustomAgentDefinitionUserIdentity,
    input: UserAgentDefinitionUpsertInput
  ): Promise<AgentDefinitionContract> {
    const normalized = normalizeUpsertInput(input);
    await this.validateNormalizedInput(normalized, userIdentity);
    const row = await AgentDefinition.query().insert({
      definitionId: `custom.${uuid()}`,
      version: 1,
      ownerKind: 'user',
      ownerUserId: userIdentity.userId,
      ownerOrganizationId: null,
      name: normalized.name,
      description: normalized.description,
      instructionRefs: [],
      instructionAddendum: normalized.instructionAddendum,
      capabilityRefs: normalized.capabilityRefs,
      requiredCapabilityRefs: [],
      optionalCapabilityRefs: normalized.capabilityRefs,
      resourcePolicy: normalized.resourcePolicy,
      modelPreference: normalized.modelPreference,
      status: 'active',
      codeOwned: false,
      readOnly: false,
    });

    return agentDefinitionRowToContract(row);
  }

  async updateUserDefinition(
    definitionId: string,
    userIdentity: CustomAgentDefinitionUserIdentity,
    input: UserAgentDefinitionUpsertInput
  ): Promise<AgentDefinitionContract> {
    const existing = await this.findActiveUserDefinitionRow(definitionId, userIdentity.userId);
    const normalized = normalizeUpsertInput(input);
    await this.validateNormalizedInput(normalized, userIdentity);
    const row = await AgentDefinition.query().patchAndFetchById(existing.id, {
      version: existing.version + 1,
      name: normalized.name,
      description: normalized.description,
      instructionAddendum: normalized.instructionAddendum,
      capabilityRefs: normalized.capabilityRefs,
      requiredCapabilityRefs: [],
      optionalCapabilityRefs: normalized.capabilityRefs,
      resourcePolicy: normalized.resourcePolicy,
      modelPreference: normalized.modelPreference,
      codeOwned: false,
      readOnly: false,
    });

    return agentDefinitionRowToContract(row);
  }

  async archiveUserDefinition(definitionId: string, userId: string): Promise<AgentDefinitionContract> {
    const existing = await this.findActiveUserDefinitionRow(definitionId, userId);
    const row = await AgentDefinition.query().patchAndFetchById(existing.id, { status: 'archived' });
    return agentDefinitionRowToContract(row);
  }

  private async validateNormalizedInput(
    input: ReturnType<typeof normalizeUpsertInput>,
    userIdentity: CustomAgentDefinitionUserIdentity
  ): Promise<void> {
    const effectiveConfig = await AgentRuntimeConfigService.getInstance().getEffectiveConfig();
    this.validateCustomAgentCreator(userIdentity, effectiveConfig.customAgentCreationPolicy);
    this.validateCapabilityRefs(
      input.capabilityRefs,
      input.resourcePolicy,
      effectiveConfig.capabilityPolicy,
      effectiveConfig.customAgentCreationPolicy
    );
    await this.validateModelPreference(input.modelPreference, userIdentity);
  }

  private validateCustomAgentCreator(
    userIdentity: CustomAgentDefinitionUserIdentity,
    customAgentCreationPolicy?: CustomAgentCreationPolicyConfig
  ): void {
    if (isCustomAgentCreatorAllowed(userIdentity, customAgentCreationPolicy)) {
      return;
    }

    throw new CustomAgentDefinitionServiceError('creation_unavailable', CREATION_UNAVAILABLE_MESSAGE);
  }

  private validateCapabilityRefs(
    capabilityRefs: AgentCapabilityCatalogId[],
    resourcePolicy: AgentDefinitionResourcePolicy,
    capabilityPolicy?: CapabilityPolicyConfig,
    customAgentCreationPolicy?: CustomAgentCreationPolicyConfig
  ): void {
    if (capabilityRefs.length === 0) {
      return;
    }

    const reservedCapability = capabilityRefs.find(
      (capabilityId) => !isCreatorCapabilityAvailable(capabilityId, customAgentCreationPolicy)
    );
    if (reservedCapability) {
      throw new CustomAgentDefinitionServiceError('creator_capability_reserved', CAPABILITY_UNAVAILABLE_MESSAGE);
    }

    const accessBySource = resourcePolicy.sourceKinds.map((sourceKind) =>
      AgentPolicyService.resolveCapabilitySetAccess(capabilityRefs, {
        capabilityPolicy,
        definitionOwnerKind: 'user',
        sourceKind: sourceKind as AgentCapabilitySourceKind,
      })
    );

    for (const capabilityId of capabilityRefs) {
      const results = accessBySource.flatMap((sourceResults) =>
        sourceResults.filter((result) => result.capabilityId === capabilityId)
      );
      if (results.some((result) => result.allowed)) {
        continue;
      }

      throw new CustomAgentDefinitionServiceError(
        selectDeniedCapabilityReason(results),
        CAPABILITY_UNAVAILABLE_MESSAGE
      );
    }
  }

  private async validateModelPreference(
    modelPreference: AgentDefinitionModelPreference | null,
    userIdentity: CustomAgentDefinitionUserIdentity
  ): Promise<void> {
    if (!modelPreference) {
      return;
    }

    const models = await AgentProviderRegistry.listAvailableModelsForUser({ userIdentity });
    const modelAvailable = models.some(
      (model) =>
        (!modelPreference.provider || model.provider === modelPreference.provider) &&
        (!modelPreference.model || model.modelId === modelPreference.model)
    );

    if (!modelAvailable) {
      throw new CustomAgentDefinitionServiceError('model_unavailable', MODEL_UNAVAILABLE_MESSAGE);
    }
  }

  private async findActiveUserDefinitionRow(definitionId: string, userId: string): Promise<AgentDefinition> {
    const row = await AgentDefinition.query().findOne({
      definitionId,
      ownerKind: 'user',
      ownerUserId: userId,
      status: 'active',
    });

    if (!row) {
      throw new CustomAgentDefinitionServiceError('not_found', 'Agent not found.');
    }

    return row;
  }
}

export const customAgentDefinitionService = new CustomAgentDefinitionService();
