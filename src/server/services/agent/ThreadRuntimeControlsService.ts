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

import { createHash } from 'crypto';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { AppError } from 'server/lib/appError';
import type AgentThread from 'server/models/AgentThread';
import { McpConfigService } from 'server/services/agentRuntime/mcp/config';
import type { AgentMcpConnection } from 'server/services/agentRuntime/mcp/types';
import AgentRuntimeConfigService from 'server/services/agentRuntime/config/agentRuntimeConfig';
import AgentCapabilityService from './CapabilityService';
import * as AgentDefinitionRegistry from './AgentDefinitionRegistry';
import { customAgentDefinitionService } from './CustomAgentDefinitionService';
import AgentPolicyService from './PolicyService';
import AgentRunService from './RunService';
import AgentSourceService from './SourceService';
import AgentThreadService, { type AgentThreadRuntimeControlChoicesMetadata } from './ThreadService';
import type { AgentDefinitionContract } from './agentDefinitionTypes';
import {
  getAgentCapabilityCatalogEntry,
  type AgentCapabilityCatalogId,
  type AgentCapabilitySourceKind,
} from './capabilityCatalog';
import {
  isSystemAgentDefinitionId,
  sourceKindForSystemAgentDefinitionId,
  type SystemAgentDefinitionId,
} from './systemAgentDefinitions';

export type AgentThreadRuntimeControlChoice = {
  id: string;
  label: string;
  description: string | null;
  required: boolean;
  selected: boolean;
  available: boolean;
};

export type AgentThreadRuntimeControlsState = {
  tools: {
    required: AgentThreadRuntimeControlChoice[];
    optional: AgentThreadRuntimeControlChoice[];
    selectedChoiceIds: string[];
  };
  mcp: {
    connections: AgentThreadRuntimeControlChoice[];
    selectedChoiceIds: string[];
  };
  canEdit: boolean;
  disabledReason: string | null;
};

export type AgentThreadRuntimeControlChoiceInput = {
  agentId?: string | null;
  toolChoiceIds?: string[];
  mcpChoiceIds?: string[];
};

export type AgentRuntimeControlsEntrySourceInput = {
  adapter?: string;
  input?: Record<string, unknown>;
};

export type AgentRuntimeControlsEntryDefaultsInput = {
  provider?: string | null;
  model?: string | null;
};

export type ValidatedEntryRuntimeControlChoices = {
  selectedAgentMetadataPatch: Record<string, unknown> | null;
  runtimeControlChoices: AgentThreadRuntimeControlChoicesMetadata | null;
};

export type ResolvedRunAdmissionRuntimeChoices = {
  metadataPresent: boolean;
  selectedRuntimeToolChoiceIds?: string[];
  selectedRuntimeMcpChoiceIds?: string[];
  selectedRuntimeCapabilityIds?: AgentCapabilityCatalogId[];
  selectedRuntimeMcpConnectionRefs?: string[];
};

type RuntimeControlsErrorCode = 'invalid_input' | 'unknown_choice' | 'policy_denied' | 'active_run' | 'not_found';

// Each discriminant carries its own HTTP status so routes never re-map it.
const RUNTIME_CONTROLS_HTTP_STATUS: Record<RuntimeControlsErrorCode, number> = {
  invalid_input: 400,
  unknown_choice: 400,
  policy_denied: 403,
  not_found: 404,
  active_run: 409,
};

export class AgentThreadRuntimeControlsError extends AppError {
  constructor(code: RuntimeControlsErrorCode, message: string) {
    super({ httpStatus: RUNTIME_CONTROLS_HTTP_STATUS[code], code, message });
    this.name = 'AgentThreadRuntimeControlsError';
  }
}

const CHOICE_ID_PREFIX = 'rtc_v1_f48b74d9';
const ACTIVE_RUN_DISABLED_REASON = 'Change after this response finishes.';

type RuntimeChoiceContext = {
  selectedAgentId: string;
  definition: AgentDefinitionContract;
  sourceKind: AgentCapabilitySourceKind;
  capabilityPolicy: Awaited<ReturnType<typeof AgentCapabilityService.resolveSessionContext>>['capabilityPolicy'];
  customAgentCreationPolicy: Awaited<
    ReturnType<typeof AgentCapabilityService.resolveSessionContext>
  >['customAgentCreationPolicy'];
  approvalPolicy: Awaited<ReturnType<typeof AgentCapabilityService.resolveSessionContext>>['approvalPolicy'];
  repoFullName?: string;
  activeRun: boolean;
  savedChoices: AgentThreadRuntimeControlChoicesMetadata | null;
  mcpConnections: AgentMcpConnection[];
};

type ThreadRuntimeChoiceContext = RuntimeChoiceContext & {
  threadRecordId: number;
};

type ChoiceLookup = {
  toolsById: Map<string, AgentThreadRuntimeControlChoice & { rawCapabilityId: AgentCapabilityCatalogId }>;
  mcpById: Map<string, AgentThreadRuntimeControlChoice & { rawConnectionId: string }>;
};

type RuntimeChoicePatch = {
  toolChoiceIds?: string[];
  mcpChoiceIds?: string[];
};

function opaqueChoiceId(kind: 'mcp' | 'tool', rawId: string): string {
  const digest = createHash('sha256')
    .update(`${CHOICE_ID_PREFIX}:${kind}:${rawId}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
    .slice(0, 24);
  return `${CHOICE_ID_PREFIX}_${kind}_${digest}`;
}

function inferEntryDefaultAgentDefinitionId(source?: AgentRuntimeControlsEntrySourceInput): SystemAgentDefinitionId {
  if (source?.adapter === 'blank_workspace') {
    return typeof source.input?.buildUuid === 'string' && source.input.buildUuid.trim()
      ? 'system.debug'
      : 'system.freeform';
  }

  return 'system.develop';
}

function sourceKindForEntrySelection({
  defaultAgentDefinitionId,
  selectedAgentId,
  source,
}: {
  defaultAgentDefinitionId: SystemAgentDefinitionId;
  selectedAgentId: string;
  source?: AgentRuntimeControlsEntrySourceInput;
}): AgentCapabilitySourceKind {
  const isBlankChat =
    source?.adapter === 'blank_workspace' &&
    !(typeof source.input?.buildUuid === 'string' && source.input.buildUuid.trim());

  if (isBlankChat && selectedAgentId === 'system.develop') {
    return 'workspace_session';
  }

  return sourceKindForSystemAgentDefinitionId(defaultAgentDefinitionId);
}

function readOptionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new AgentThreadRuntimeControlsError('invalid_input', `${fieldName} must be an array of choice ids.`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new AgentThreadRuntimeControlsError('invalid_input', `${fieldName} must contain only choice ids.`);
    }
    const trimmed = item.trim();
    if (!seen.has(trimmed)) {
      normalized.push(trimmed);
      seen.add(trimmed);
    }
  }

  return normalized;
}

function patchFromChoiceInput(
  input: AgentThreadRuntimeControlChoiceInput | null | undefined
): RuntimeChoicePatch | null {
  if (!input) {
    return null;
  }

  const toolChoiceIds = readOptionalStringArray(input.toolChoiceIds, 'toolChoiceIds');
  const mcpChoiceIds = readOptionalStringArray(input.mcpChoiceIds, 'mcpChoiceIds');
  if (toolChoiceIds === undefined && mcpChoiceIds === undefined) {
    return null;
  }

  return {
    ...(toolChoiceIds !== undefined ? { toolChoiceIds } : {}),
    ...(mcpChoiceIds !== undefined ? { mcpChoiceIds } : {}),
  };
}

function isMcpCapability(capabilityId: AgentCapabilityCatalogId): boolean {
  return getAgentCapabilityCatalogEntry(capabilityId).category === 'mcp';
}

function repoFullNameFromEntrySource(source?: AgentRuntimeControlsEntrySourceInput): string | undefined {
  const input = source?.input || {};
  const directRepo = typeof input.repo === 'string' ? input.repo.trim() : '';
  if (directRepo) {
    return directRepo;
  }

  const repoUrl = typeof input.repoUrl === 'string' ? input.repoUrl.trim() : '';
  if (!repoUrl) {
    return undefined;
  }

  const normalized = repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  return normalized || undefined;
}

function isConnectionAvailable(connection: AgentMcpConnection): boolean {
  if (connection.validationError) {
    return false;
  }

  if (connection.connectionRequired && (!connection.configured || connection.stale)) {
    return false;
  }

  return (connection.discoveredTools?.length ?? 0) + (connection.sharedDiscoveredTools?.length ?? 0) > 0;
}

function capabilityAllowed({
  capabilityId,
  definition,
  context,
}: {
  capabilityId: AgentCapabilityCatalogId;
  definition: AgentDefinitionContract;
  context: RuntimeChoiceContext;
}) {
  return AgentPolicyService.resolveCapabilityAccess({
    capabilityId,
    capabilityPolicy: context.capabilityPolicy,
    customAgentCreationPolicy: context.customAgentCreationPolicy,
    approvalPolicy: context.approvalPolicy,
    definitionOwnerKind: definition.owner.kind,
    sourceKind: context.sourceKind,
  });
}

function hasAllowedMcpCapability(context: RuntimeChoiceContext): boolean {
  const capabilityRefs = [
    ...(context.definition.requiredCapabilityRefs || []),
    ...(context.definition.optionalCapabilityRefs || []),
    ...context.definition.capabilityRefs,
  ].filter(isMcpCapability);
  const uniqueCapabilityRefs = [...new Set(capabilityRefs)];

  return uniqueCapabilityRefs.some(
    (capabilityId) =>
      capabilityAllowed({
        capabilityId,
        definition: context.definition,
        context,
      }).allowed
  );
}

function assertDefinitionUsable(definition: AgentDefinitionContract, sourceKind: AgentCapabilitySourceKind): void {
  if (definition.status !== 'active') {
    throw new AgentThreadRuntimeControlsError('policy_denied', `${definition.name} is unavailable.`);
  }

  if (!definition.resourcePolicy.sourceKinds.includes(sourceKind)) {
    throw new AgentThreadRuntimeControlsError(
      'policy_denied',
      `${definition.name} is unavailable for this conversation.`
    );
  }
}

function buildChoiceState(context: RuntimeChoiceContext): {
  state: AgentThreadRuntimeControlsState;
  lookup: ChoiceLookup;
} {
  const savedChoices = context.savedChoices;
  const savedToolChoiceIds = savedChoices ? new Set(savedChoices.toolChoiceIds) : null;
  const savedMcpChoiceIds = savedChoices ? new Set(savedChoices.mcpChoiceIds) : null;
  const requiredCapabilities = new Set(context.definition.requiredCapabilityRefs || []);
  const optionalCapabilities = new Set(
    (context.definition.optionalCapabilityRefs?.length
      ? context.definition.optionalCapabilityRefs
      : context.definition.capabilityRefs
    ).filter((capabilityId) => !requiredCapabilities.has(capabilityId))
  );

  const required: AgentThreadRuntimeControlChoice[] = [];
  const optional: AgentThreadRuntimeControlChoice[] = [];
  const lookup: ChoiceLookup = {
    toolsById: new Map(),
    mcpById: new Map(),
  };

  for (const capabilityId of [...requiredCapabilities, ...optionalCapabilities]) {
    if (isMcpCapability(capabilityId)) {
      continue;
    }

    const entry = getAgentCapabilityCatalogEntry(capabilityId);
    const access = capabilityAllowed({
      capabilityId,
      definition: context.definition,
      context,
    });
    const id = opaqueChoiceId('tool', capabilityId);
    const isRequired = requiredCapabilities.has(capabilityId);
    const selected = isRequired || (savedToolChoiceIds ? savedToolChoiceIds.has(id) : true);
    const choice = {
      id,
      label: entry.label,
      description: entry.description || null,
      required: isRequired,
      selected,
      available: access.allowed,
    };
    lookup.toolsById.set(id, { ...choice, rawCapabilityId: capabilityId });
    if (isRequired) {
      required.push(choice);
    } else {
      optional.push(choice);
    }
  }

  const mcpConnections: AgentThreadRuntimeControlChoice[] = hasAllowedMcpCapability(context)
    ? context.mcpConnections.map((connection) => {
        const id = opaqueChoiceId('mcp', `${connection.scope}:${connection.slug}`);
        const available = isConnectionAvailable(connection);
        const choice = {
          id,
          label: connection.name,
          description: connection.description || null,
          required: false,
          selected: savedMcpChoiceIds ? savedMcpChoiceIds.has(id) : available,
          available,
        };
        lookup.mcpById.set(id, { ...choice, rawConnectionId: `${connection.scope}:${connection.slug}` });
        return choice;
      })
    : [];

  const selectedToolChoiceIds = [
    ...required.filter((choice) => choice.available).map((choice) => choice.id),
    ...optional.filter((choice) => choice.available && choice.selected).map((choice) => choice.id),
  ];
  const selectedMcpChoiceIds = mcpConnections
    .filter((choice) => choice.available && choice.selected)
    .map((choice) => choice.id);

  return {
    state: {
      tools: {
        required,
        optional,
        selectedChoiceIds: selectedToolChoiceIds,
      },
      mcp: {
        connections: mcpConnections,
        selectedChoiceIds: selectedMcpChoiceIds,
      },
      canEdit: !context.activeRun,
      disabledReason: context.activeRun ? ACTIVE_RUN_DISABLED_REASON : null,
    },
    lookup,
  };
}

function validateChoiceIds({
  lookup,
  toolChoiceIds,
  mcpChoiceIds,
}: {
  lookup: ChoiceLookup;
  toolChoiceIds: string[];
  mcpChoiceIds: string[];
}): AgentThreadRuntimeControlChoicesMetadata {
  for (const choiceId of toolChoiceIds) {
    const choice = lookup.toolsById.get(choiceId);
    if (!choice) {
      throw new AgentThreadRuntimeControlsError('unknown_choice', 'Unknown runtime control choice.');
    }
    if (!choice.available) {
      throw new AgentThreadRuntimeControlsError('policy_denied', 'Runtime control choice is unavailable.');
    }
  }

  for (const choiceId of mcpChoiceIds) {
    const choice = lookup.mcpById.get(choiceId);
    if (!choice) {
      throw new AgentThreadRuntimeControlsError('unknown_choice', 'Unknown runtime control choice.');
    }
    if (!choice.available) {
      throw new AgentThreadRuntimeControlsError('policy_denied', 'Runtime control choice is unavailable.');
    }
  }

  return {
    version: 1,
    toolChoiceIds: toolChoiceIds.filter((choiceId) => {
      const choice = lookup.toolsById.get(choiceId);
      return choice && !choice.required;
    }),
    mcpChoiceIds,
  };
}

function validateRequestedChoicePatch(
  lookup: ChoiceLookup,
  state: AgentThreadRuntimeControlsState,
  patch: RuntimeChoicePatch
): AgentThreadRuntimeControlChoicesMetadata {
  return validateChoiceIds({
    lookup,
    toolChoiceIds: patch.toolChoiceIds ?? state.tools.selectedChoiceIds,
    mcpChoiceIds: patch.mcpChoiceIds ?? state.mcp.selectedChoiceIds,
  });
}

async function resolveSystemDefinition(agentId: SystemAgentDefinitionId): Promise<AgentDefinitionContract> {
  await AgentDefinitionRegistry.ensureSystemAgentDefinitionsSeeded();
  return AgentDefinitionRegistry.getSystemAgentDefinition(agentId);
}

async function resolveDefinition(agentId: string, userIdentity: RequestUserIdentity): Promise<AgentDefinitionContract> {
  if (isSystemAgentDefinitionId(agentId)) {
    return resolveSystemDefinition(agentId);
  }

  if (agentId.startsWith('custom.')) {
    return customAgentDefinitionService.getUserDefinition(agentId, userIdentity.userId);
  }

  throw new AgentThreadRuntimeControlsError('policy_denied', 'Selected agent is unavailable.');
}

export default class AgentThreadRuntimeControlsService {
  static async resolveRunAdmissionChoices({
    thread,
    userIdentity,
    definition,
    sourceKind,
    capabilityPolicy,
    customAgentCreationPolicy,
    approvalPolicy,
    repoFullName,
  }: {
    thread: AgentThread;
    userIdentity: RequestUserIdentity;
    definition: AgentDefinitionContract;
    sourceKind: AgentCapabilitySourceKind;
    capabilityPolicy: RuntimeChoiceContext['capabilityPolicy'];
    customAgentCreationPolicy: RuntimeChoiceContext['customAgentCreationPolicy'];
    approvalPolicy: RuntimeChoiceContext['approvalPolicy'];
    repoFullName?: string;
  }): Promise<ResolvedRunAdmissionRuntimeChoices> {
    const savedChoices = AgentThreadService.getRuntimeControlChoices(thread);
    if (!savedChoices) {
      return {
        metadataPresent: false,
      };
    }

    const mcpConnections = await new McpConfigService().listEnabledConnectionsForUser(repoFullName, userIdentity);
    const { state, lookup } = buildChoiceState({
      selectedAgentId: definition.id,
      definition,
      sourceKind,
      capabilityPolicy,
      customAgentCreationPolicy,
      approvalPolicy,
      repoFullName,
      activeRun: false,
      savedChoices,
      mcpConnections,
    });

    const selectedRuntimeCapabilityIds = state.tools.selectedChoiceIds
      .map((choiceId) => lookup.toolsById.get(choiceId)?.rawCapabilityId)
      .filter((capabilityId): capabilityId is AgentCapabilityCatalogId => Boolean(capabilityId));
    const selectedRuntimeMcpConnectionRefs = state.mcp.selectedChoiceIds
      .map((choiceId) => lookup.mcpById.get(choiceId)?.rawConnectionId)
      .filter((connectionRef): connectionRef is string => Boolean(connectionRef));

    return {
      metadataPresent: true,
      selectedRuntimeToolChoiceIds: state.tools.selectedChoiceIds,
      selectedRuntimeMcpChoiceIds: state.mcp.selectedChoiceIds,
      selectedRuntimeCapabilityIds,
      selectedRuntimeMcpConnectionRefs,
    };
  }

  static async getState({
    threadId,
    userIdentity,
  }: {
    threadId: string;
    userIdentity: RequestUserIdentity;
  }): Promise<AgentThreadRuntimeControlsState> {
    const context = await this.buildThreadContext({ threadId, userIdentity });
    return buildChoiceState(context).state;
  }

  static async patchChoices({
    threadId,
    userIdentity,
    toolChoiceIds,
    mcpChoiceIds,
  }: {
    threadId: string;
    userIdentity: RequestUserIdentity;
    toolChoiceIds?: string[];
    mcpChoiceIds?: string[];
  }): Promise<AgentThreadRuntimeControlsState> {
    const context = await this.buildThreadContext({ threadId, userIdentity });
    if (context.activeRun) {
      throw new AgentThreadRuntimeControlsError('active_run', ACTIVE_RUN_DISABLED_REASON);
    }

    const patch = patchFromChoiceInput({ toolChoiceIds, mcpChoiceIds });
    if (!patch) {
      throw new AgentThreadRuntimeControlsError('invalid_input', 'runtimeControlChoices are required.');
    }
    const { state, lookup } = buildChoiceState(context);
    const validatedMetadata = validateRequestedChoicePatch(lookup, state, patch);

    await AgentThreadService.patchRuntimeControlChoices(context.threadRecordId, validatedMetadata);

    return buildChoiceState({
      ...context,
      savedChoices: validatedMetadata,
    }).state;
  }

  static async getEntryPreview({
    userIdentity,
    agentId,
    source,
    defaults,
    runtimeControlChoices,
  }: {
    userIdentity: RequestUserIdentity;
    agentId?: string | null;
    source?: AgentRuntimeControlsEntrySourceInput;
    defaults?: AgentRuntimeControlsEntryDefaultsInput;
    runtimeControlChoices?: AgentThreadRuntimeControlChoiceInput;
  }): Promise<AgentThreadRuntimeControlsState> {
    void defaults;
    const context = await this.buildEntryContext({ userIdentity, agentId, source });
    const patch = patchFromChoiceInput(runtimeControlChoices);
    const { state, lookup } = buildChoiceState(context);
    const savedChoices = patch ? validateRequestedChoicePatch(lookup, state, patch) : null;
    return buildChoiceState({
      ...context,
      savedChoices,
    }).state;
  }

  static async validateEntryChoices({
    userIdentity,
    agentId,
    source,
    defaults,
    runtimeControlChoices,
  }: {
    userIdentity: RequestUserIdentity;
    agentId?: string | null;
    source?: AgentRuntimeControlsEntrySourceInput;
    defaults?: AgentRuntimeControlsEntryDefaultsInput;
    runtimeControlChoices: AgentThreadRuntimeControlChoiceInput;
  }): Promise<ValidatedEntryRuntimeControlChoices> {
    void defaults;
    const selectedAgentId = agentId || runtimeControlChoices.agentId || null;
    const context = await this.buildEntryContext({ userIdentity, agentId: selectedAgentId, source });
    const patch = patchFromChoiceInput(runtimeControlChoices);
    const { state, lookup } = buildChoiceState(context);
    const validatedMetadata = patch ? validateRequestedChoicePatch(lookup, state, patch) : null;

    return {
      selectedAgentMetadataPatch: selectedAgentId
        ? AgentThreadService.buildSelectedAgentDefinitionMetadataPatch(context.selectedAgentId)
        : null,
      runtimeControlChoices: validatedMetadata,
    };
  }

  private static async buildThreadContext({
    threadId,
    userIdentity,
  }: {
    threadId: string;
    userIdentity: RequestUserIdentity;
  }): Promise<ThreadRuntimeChoiceContext> {
    let owned;
    try {
      owned = await AgentThreadService.getOwnedThreadWithSession(threadId, userIdentity.userId);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'Agent thread not found' || error.message === 'Agent session not found')
      ) {
        throw new AgentThreadRuntimeControlsError('not_found', error.message);
      }
      throw error;
    }

    const { thread, session } = owned;
    const source = await AgentSourceService.getSessionSource(session.id);
    if (!source || source.status !== 'ready') {
      throw new AgentThreadRuntimeControlsError('policy_denied', 'Session source is not ready yet.');
    }

    const defaultAgentDefinitionId = AgentDefinitionRegistry.inferDefaultSystemAgentDefinitionId(session, source);
    const selectedAgentId = AgentThreadService.getSelectedAgentDefinitionId(thread) || defaultAgentDefinitionId;
    const sourceKind = sourceKindForSystemAgentDefinitionId(defaultAgentDefinitionId);
    const definition = await resolveDefinition(selectedAgentId, userIdentity);
    assertDefinitionUsable(definition, sourceKind);
    const { repoFullName, approvalPolicy, capabilityPolicy, customAgentCreationPolicy } =
      await AgentCapabilityService.resolveSessionContext(session.uuid, userIdentity);
    const [activeRun, mcpConnections] = await Promise.all([
      AgentRunService.hasActiveRun(thread.id),
      new McpConfigService().listEnabledConnectionsForUser(repoFullName, userIdentity),
    ]);

    return {
      threadRecordId: thread.id,
      selectedAgentId,
      definition,
      sourceKind,
      capabilityPolicy,
      customAgentCreationPolicy,
      approvalPolicy,
      repoFullName,
      activeRun,
      savedChoices: AgentThreadService.getRuntimeControlChoices(thread),
      mcpConnections,
    };
  }

  private static async buildEntryContext({
    userIdentity,
    agentId,
    source,
  }: {
    userIdentity: RequestUserIdentity;
    agentId?: string | null;
    source?: AgentRuntimeControlsEntrySourceInput;
  }): Promise<RuntimeChoiceContext> {
    const defaultAgentDefinitionId = inferEntryDefaultAgentDefinitionId(source);
    const selectedAgentId = agentId?.trim() || defaultAgentDefinitionId;
    const sourceKind = sourceKindForEntrySelection({ defaultAgentDefinitionId, selectedAgentId, source });
    const definition = await resolveDefinition(selectedAgentId, userIdentity);
    assertDefinitionUsable(definition, sourceKind);
    const repoFullName = repoFullNameFromEntrySource(source);
    const [approvalPolicy, effectiveConfig, mcpConnections] = await Promise.all([
      AgentPolicyService.getEffectivePolicy(repoFullName),
      AgentRuntimeConfigService.getInstance().getEffectiveConfig(repoFullName),
      new McpConfigService().listEnabledConnectionsForUser(repoFullName, userIdentity),
    ]);

    return {
      selectedAgentId,
      definition,
      sourceKind,
      capabilityPolicy: effectiveConfig.capabilityPolicy,
      customAgentCreationPolicy: effectiveConfig.customAgentCreationPolicy,
      approvalPolicy,
      repoFullName,
      activeRun: false,
      savedChoices: null,
      mcpConnections,
    };
  }
}
