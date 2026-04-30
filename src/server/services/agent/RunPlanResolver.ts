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
import type AgentSession from 'server/models/AgentSession';
import type AgentSource from 'server/models/AgentSource';
import type AgentThread from 'server/models/AgentThread';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import AgentCapabilityService from './CapabilityService';
import AgentPolicyService from './PolicyService';
import AgentProviderRegistry from './ProviderRegistry';
import * as AgentDefinitionRegistry from './AgentDefinitionRegistry';
import { CustomAgentDefinitionServiceError, customAgentDefinitionService } from './CustomAgentDefinitionService';
import type { AgentRunRuntimeOptions } from './canonicalMessages';
import AgentThreadService from './ThreadService';
import AgentThreadRuntimeControlsService from './ThreadRuntimeControlsService';
import type { AgentDefinitionContract } from './agentDefinitionTypes';
import { getAgentCapabilityCatalogEntry, type AgentCapabilityCatalogId } from './capabilityCatalog';
import type { AgentRunPlanSnapshotV1, AgentRunPlanSourceKind, AgentRunPlanWarning } from './runPlanTypes';
import {
  isSystemAgentDefinitionId,
  sourceKindForSystemAgentDefinitionId,
  type SystemAgentDefinitionId,
} from './systemAgentDefinitions';

export class AgentRunPlanCapabilityUnavailableError extends Error {
  constructor(public readonly capabilityId: string, public readonly reason: string | undefined) {
    super(`Agent capability "${capabilityId}" is unavailable${reason ? `: ${reason}` : ''}.`);
    this.name = 'AgentRunPlanCapabilityUnavailableError';
  }
}

export class AgentRunPlanAgentUnavailableError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly reason: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(`Agent "${agentId}" is unavailable: ${reason}.`);
    this.name = 'AgentRunPlanAgentUnavailableError';
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readSessionDefaultProvider(source: AgentSource): string | null {
  const defaults = source.input?.defaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return null;
  }

  return readString((defaults as Record<string, unknown>).provider);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hashPromptRefs(
  definitionId: string,
  instructionRefs: string[],
  version: number,
  instructionAddendum?: string | null
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ definitionId, instructionRefs, version, instructionAddendum: instructionAddendum || null })
    )
    .digest('hex');
}

function compactSource({
  session,
  source,
  sourceKind,
  repoFullName,
  capturedAt,
}: {
  session: AgentSession;
  source: AgentSource;
  sourceKind: AgentRunPlanSourceKind;
  repoFullName?: string;
  capturedAt: string;
}): AgentRunPlanSnapshotV1['source'] {
  const workspaceRepos = Array.isArray(session.workspaceRepos) ? session.workspaceRepos : [];
  const selectedServices = Array.isArray(session.selectedServices) ? session.selectedServices : [];
  const primaryRepo = workspaceRepos.find((repo) => repo.primary) || workspaceRepos[0] || null;
  const primaryService = selectedServices[0] || null;
  const sourceInput = readRecord(source.input);

  return {
    id: source.uuid || null,
    adapter: source.adapter || null,
    status: source.status || null,
    sessionKind: session.sessionKind || null,
    buildUuid: readString(sourceInput.buildUuid) || session.buildUuid || null,
    repoFullName: primaryRepo?.repo || repoFullName || null,
    branch: primaryRepo?.branch || readString(sourceInput.branchName) || null,
    namespace: session.namespace || readString(sourceInput.namespace) || null,
    workspaceLayout: {
      repoCount: Array.isArray(session.workspaceRepos) ? session.workspaceRepos.length : 0,
      primaryRepo: primaryRepo?.repo || repoFullName || null,
      selectedServiceCount: Array.isArray(session.selectedServices) ? session.selectedServices.length : 0,
      primaryService: primaryService?.name || null,
    },
    sandboxRequirements: source.sandboxRequirements || {},
    freshness: {
      capturedAt,
      preparedAt: source.preparedAt || null,
      freshnessSource: source.preparedAt ? 'source' : sourceKind === 'workspace_session' ? 'session' : 'request',
    },
  };
}

function uniqueCapabilityIds(capabilityIds: readonly AgentCapabilityCatalogId[]): AgentCapabilityCatalogId[] {
  return Array.from(new Set(capabilityIds));
}

function isKnownCapabilityId(capabilityId: string): capabilityId is AgentCapabilityCatalogId {
  try {
    getAgentCapabilityCatalogEntry(capabilityId as AgentCapabilityCatalogId);
    return true;
  } catch {
    return false;
  }
}

function warningForUnavailableOptionalCapability(
  capability: ReturnType<typeof AgentPolicyService.resolveCapabilityAccess>
): AgentRunPlanWarning {
  const label = capability.entry?.label || 'Optional capability';
  return {
    code: 'optional_capability_unavailable',
    message: `${label} is unavailable and was skipped.`,
    ...(capability.reason
      ? {
          detail: {
            reason: capability.reason,
          },
        }
      : {}),
  };
}

async function resolveSelectedDefinition({
  selectedAgentDefinitionId,
  defaultAgentDefinitionId,
  userId,
  warnings,
}: {
  selectedAgentDefinitionId: string | null;
  defaultAgentDefinitionId: SystemAgentDefinitionId;
  userId: string;
  warnings: AgentRunPlanWarning[];
}): Promise<{ selectedDefinitionId: string; definition: AgentDefinitionContract }> {
  if (!selectedAgentDefinitionId) {
    return {
      selectedDefinitionId: defaultAgentDefinitionId,
      definition: await AgentDefinitionRegistry.getSystemAgentDefinition(defaultAgentDefinitionId),
    };
  }

  if (isSystemAgentDefinitionId(selectedAgentDefinitionId)) {
    return {
      selectedDefinitionId: selectedAgentDefinitionId,
      definition: await AgentDefinitionRegistry.getSystemAgentDefinition(selectedAgentDefinitionId),
    };
  }

  try {
    return {
      selectedDefinitionId: selectedAgentDefinitionId,
      definition: await customAgentDefinitionService.getUserDefinition(selectedAgentDefinitionId, userId),
    };
  } catch (error) {
    if (!(error instanceof CustomAgentDefinitionServiceError) || error.code !== 'not_found') {
      throw error;
    }

    warnings.push({
      code: 'selected_agent_unavailable',
      message: 'Selected agent is unavailable. The default agent will be used for this run.',
    });

    return {
      selectedDefinitionId: defaultAgentDefinitionId,
      definition: await AgentDefinitionRegistry.getSystemAgentDefinition(defaultAgentDefinitionId),
    };
  }
}

export default class AgentRunPlanResolver {
  static async resolveForRunAdmission({
    thread,
    session,
    source,
    userIdentity,
    requestedProvider,
    requestedModel,
    runtimeOptions = {},
  }: {
    thread: AgentThread;
    session: AgentSession;
    source: AgentSource;
    userIdentity: RequestUserIdentity;
    requestedProvider?: string | null;
    requestedModel?: string | null;
    runtimeOptions?: AgentRunRuntimeOptions;
  }): Promise<{
    approvalPolicy: Awaited<ReturnType<typeof AgentCapabilityService.resolveSessionContext>>['approvalPolicy'];
    requestedHarness: null;
    requestedProvider: string | null;
    requestedModel: string | null;
    resolvedHarness: 'lifecycle_ai_sdk';
    resolvedProvider: string;
    resolvedModel: string;
    sandboxRequirement: Record<string, unknown>;
    runtimeOptions: AgentRunRuntimeOptions;
    repoFullName?: string;
    runPlanSnapshot: AgentRunPlanSnapshotV1;
  }> {
    const warnings: AgentRunPlanWarning[] = [];
    const { repoFullName, approvalPolicy, capabilityPolicy, customAgentCreationPolicy } =
      await AgentCapabilityService.resolveSessionContext(session.uuid, userIdentity);
    const requestedHarness = readString(session.defaultHarness);
    if (requestedHarness && requestedHarness !== 'lifecycle_ai_sdk') {
      const warning = {
        code: 'unsupported_harness_default',
        message: `Unsupported session harness "${requestedHarness}" was replaced with lifecycle_ai_sdk.`,
      };
      warnings.push(warning);
      getLogger().warn(
        { sessionId: session.uuid, requestedHarness },
        `AgentExec: run plan harness fallback sessionId=${session.uuid} harness=${requestedHarness}`
      );
    }

    await AgentDefinitionRegistry.ensureSystemAgentDefinitionsSeeded();
    const defaultAgentDefinitionId = AgentDefinitionRegistry.inferDefaultSystemAgentDefinitionId(session, source);
    const selectedAgentDefinitionId = AgentThreadService.getSelectedAgentDefinitionId(thread);
    const { selectedDefinitionId, definition } = await resolveSelectedDefinition({
      selectedAgentDefinitionId,
      defaultAgentDefinitionId,
      userId: userIdentity.userId,
      warnings,
    });
    const sourceKind = sourceKindForSystemAgentDefinitionId(defaultAgentDefinitionId);
    const resolvedProviderRequest =
      requestedProvider || definition.modelPreference?.provider || readSessionDefaultProvider(source) || undefined;
    const resolvedModelRequest =
      requestedModel || definition.modelPreference?.model || readString(session.defaultModel);
    if (!resolvedModelRequest) {
      throw new Error('Agent run model is required');
    }

    const selection = await AgentProviderRegistry.resolveSelection({
      repoFullName,
      requestedProvider: resolvedProviderRequest,
      requestedModelId: resolvedModelRequest,
    });
    if (definition.status !== 'active') {
      throw new AgentRunPlanAgentUnavailableError(selectedDefinitionId, 'disabled_agent');
    }

    if (!definition.resourcePolicy.sourceKinds.includes(sourceKind)) {
      throw new AgentRunPlanAgentUnavailableError(selectedDefinitionId, 'source_incompatible', {
        sourceKind,
      });
    }

    if (definition.resourcePolicy.workspaceRequired && sourceKind !== 'workspace_session') {
      throw new AgentRunPlanAgentUnavailableError(selectedDefinitionId, 'workspace_required', {
        sourceKind,
      });
    }

    if (definition.resourcePolicy.sandboxRequired && sourceKind !== 'workspace_session') {
      throw new AgentRunPlanAgentUnavailableError(selectedDefinitionId, 'sandbox_required', {
        sourceKind,
      });
    }

    const requiredCapabilityRefs = definition.requiredCapabilityRefs || definition.capabilityRefs;
    const optionalCapabilityRefs = definition.optionalCapabilityRefs || [];
    const runtimeChoices = await AgentThreadRuntimeControlsService.resolveRunAdmissionChoices({
      thread,
      userIdentity,
      definition,
      sourceKind,
      capabilityPolicy,
      customAgentCreationPolicy,
      approvalPolicy,
      repoFullName,
    });
    const selectedOptionalCapabilityRefs = runtimeChoices.metadataPresent
      ? uniqueCapabilityIds(
          (runtimeChoices.selectedRuntimeCapabilityIds || []).filter((capabilityId) =>
            optionalCapabilityRefs.includes(capabilityId)
          )
        )
      : optionalCapabilityRefs;
    const requiredCapabilityAccess = AgentPolicyService.resolveCapabilitySetAccess(requiredCapabilityRefs, {
      capabilityPolicy,
      customAgentCreationPolicy,
      approvalPolicy,
      definitionOwnerKind: definition.owner.kind,
      sourceKind,
    });
    const blockedCapability = requiredCapabilityAccess.find((capability) => !capability.allowed);
    if (blockedCapability) {
      throw new AgentRunPlanCapabilityUnavailableError(blockedCapability.capabilityId, blockedCapability.reason);
    }
    const optionalCapabilityAccess = AgentPolicyService.resolveCapabilitySetAccess(selectedOptionalCapabilityRefs, {
      capabilityPolicy,
      customAgentCreationPolicy,
      approvalPolicy,
      definitionOwnerKind: definition.owner.kind,
      sourceKind,
    });
    const allowedOptionalCapabilityAccess = optionalCapabilityAccess.filter((capability) => capability.allowed);
    for (const capability of optionalCapabilityAccess) {
      if (!capability.allowed) {
        warnings.push(warningForUnavailableOptionalCapability(capability));
      }
    }
    const resolvedCapabilityAccess = [...requiredCapabilityAccess, ...allowedOptionalCapabilityAccess];
    const provisionalCapabilityIds = uniqueCapabilityIds(
      [
        ...requiredCapabilityAccess.map((capability) => capability.capabilityId),
        ...allowedOptionalCapabilityAccess.map((capability) => capability.capabilityId),
      ].filter(isKnownCapabilityId)
    );
    const selectedRuntimeCapabilityIds = runtimeChoices.metadataPresent
      ? (provisionalCapabilityIds as AgentRunPlanSnapshotV1['capabilities']['selectedRuntimeCapabilityIds'])
      : undefined;
    const runtimeChoicesMatchAllowedCapabilities =
      !runtimeChoices.metadataPresent ||
      (runtimeChoices.selectedRuntimeCapabilityIds || []).every((capabilityId) =>
        provisionalCapabilityIds.includes(capabilityId)
      );

    const capturedAt = new Date().toISOString();
    const runPlanSnapshot: AgentRunPlanSnapshotV1 = {
      version: 1,
      capturedAt,
      agent: {
        id: selectedDefinitionId,
        label: definition.name,
        ownerKind: definition.owner.kind,
        version: definition.version,
        sourceKind,
        resourcePolicy: definition.resourcePolicy,
        modelPreference: definition.modelPreference || null,
      },
      source: compactSource({ session, source, sourceKind, repoFullName, capturedAt }),
      model: {
        requestedProvider: requestedProvider || null,
        requestedModel: requestedModel || null,
        resolvedProvider: selection.provider,
        resolvedModel: selection.modelId,
      },
      runtime: {
        requestedHarness,
        resolvedHarness: 'lifecycle_ai_sdk',
        sandboxRequirement: source.sandboxRequirements || {},
        runtimeOptions,
        approvalPolicy,
      },
      prompt: {
        instructionRefs: definition.instructionRefs,
        instructionAddendum: definition.instructionAddendum || null,
        renderedSummary: definition.description || definition.name,
        renderedHash: hashPromptRefs(
          selectedDefinitionId,
          definition.instructionRefs,
          definition.version,
          definition.instructionAddendum
        ),
      },
      capabilities: {
        provisionalCapabilityIds:
          provisionalCapabilityIds as AgentRunPlanSnapshotV1['capabilities']['provisionalCapabilityIds'],
        resolvedCapabilityAccess: resolvedCapabilityAccess.map((capability) => ({
          capabilityId:
            capability.capabilityId as AgentRunPlanSnapshotV1['capabilities']['provisionalCapabilityIds'][number],
          availability: capability.effectiveAvailability || capability.entry?.defaultAvailability || 'disabled',
          allowed: capability.allowed,
          ...(capability.reason ? { reason: capability.reason } : {}),
          ...(capability.entry?.runtimeCapabilityKey
            ? { runtimeCapabilityKey: capability.entry.runtimeCapabilityKey }
            : {}),
          ...(capability.approvalMode ? { approvalMode: capability.approvalMode } : {}),
        })),
        ...(runtimeChoices.metadataPresent
          ? {
              selectedRuntimeToolChoiceIds: runtimeChoicesMatchAllowedCapabilities
                ? runtimeChoices.selectedRuntimeToolChoiceIds || []
                : [],
              selectedRuntimeMcpChoiceIds: runtimeChoicesMatchAllowedCapabilities
                ? runtimeChoices.selectedRuntimeMcpChoiceIds || []
                : [],
              selectedRuntimeCapabilityIds,
              selectedRuntimeMcpConnectionRefs: runtimeChoicesMatchAllowedCapabilities
                ? runtimeChoices.selectedRuntimeMcpConnectionRefs || []
                : [],
            }
          : {}),
      },
      warnings,
    };

    return {
      approvalPolicy,
      requestedHarness: null,
      requestedProvider: requestedProvider || null,
      requestedModel: requestedModel || null,
      resolvedHarness: 'lifecycle_ai_sdk',
      resolvedProvider: selection.provider,
      resolvedModel: selection.modelId,
      sandboxRequirement: source.sandboxRequirements || {},
      runtimeOptions,
      repoFullName,
      runPlanSnapshot,
    };
  }
}
