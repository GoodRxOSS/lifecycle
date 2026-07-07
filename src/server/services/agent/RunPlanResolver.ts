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
import { AppError, ConflictError } from 'server/lib/appError';
import { AgentWorkspaceStatus } from 'shared/constants';
import AgentCapabilityService from './CapabilityService';
import AgentPolicyService from './PolicyService';
import AgentProviderRegistry from './ProviderRegistry';
import * as AgentDefinitionRegistry from './AgentDefinitionRegistry';
import {
  CUSTOM_AGENT_NEEDS_CONVERSION_MESSAGE,
  CustomAgentDefinitionServiceError,
  customAgentDefinitionNeedsOneAgentConversion,
  customAgentDefinitionService,
} from './CustomAgentDefinitionService';
import type { AgentRunRuntimeOptions } from './canonicalMessages';
import AgentThreadService from './ThreadService';
import AgentThreadRuntimeControlsService from './ThreadRuntimeControlsService';
import type { AgentDefinitionContract } from './agentDefinitionTypes';
import { getAgentCapabilityCatalogEntry, type AgentCapabilityCatalogId } from './capabilityCatalog';
import type {
  AgentDebugRunIntent,
  AgentRunPlanResolvedInstructionSnapshot,
  AgentRunPlanResolvedRuleSnapshot,
  AgentRunPlanSnapshotV1,
  AgentRunPlanSourceKind,
  AgentRunPlanWarning,
} from './runPlanTypes';
import {
  isSystemAgentDefinitionId,
  SYSTEM_AGENT_DEFINITIONS,
  type SystemAgentDefinitionId,
} from './systemAgentDefinitions';
import { resolveAgentHarnessV2ProfileCapabilities, toRunPlanProfileSnapshot } from './profileCapabilityResolver';
import InstructionTemplateService, {
  InstructionTemplateServiceError,
  type ResolvedInstructionTemplate,
} from './InstructionTemplateService';
import InstructionRuleService from './InstructionRuleService';

type FindPriorCompletedDebugIntentRun = (input: {
  threadId: number;
  intents: AgentDebugRunIntent[];
  buildUuid?: string | null;
  selectedDeployUuid?: string | null;
}) => Promise<boolean>;

export class AgentRunPlanCapabilityUnavailableError extends ConflictError {
  readonly capabilityId: string;
  readonly reason: string | undefined;
  constructor(capabilityId: string, reason: string | undefined) {
    super(
      `Agent capability "${capabilityId}" is unavailable${reason ? `: ${reason}` : ''}.`,
      'capability_unavailable',
      {
        capabilityId,
        ...(reason ? { reason } : {}),
      }
    );
    this.name = 'AgentRunPlanCapabilityUnavailableError';
    this.capabilityId = capabilityId;
    this.reason = reason;
  }
}

export class AgentRunPlanAgentUnavailableError extends ConflictError {
  readonly agentId: string;
  readonly reason: string;
  constructor(agentId: string, reason: string, extra?: Record<string, unknown>) {
    super(`Agent "${agentId}" is unavailable: ${reason}.`, 'agent_unavailable', { agentId, reason, ...extra });
    this.name = 'AgentRunPlanAgentUnavailableError';
    this.agentId = agentId;
    this.reason = reason;
  }
}

export class AgentRunPlanInstructionTemplateError extends AppError {
  readonly templateCode: string;
  readonly statusCode?: number;
  constructor(templateCode: string, message: string, statusCode?: number, details?: Record<string, unknown>) {
    super({
      httpStatus: 422,
      code: 'instruction_template_invalid',
      message: `Agent instruction template configuration is invalid: ${message}`,
      details: { templateCode, ...(details || {}) },
    });
    this.name = 'AgentRunPlanInstructionTemplateError';
    this.templateCode = templateCode;
    this.statusCode = statusCode;
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

function compactSelectedDeploy(value: unknown): AgentRunPlanSnapshotV1['source']['selectedDeploy'] {
  const selectedDeploy = readRecord(value);
  const selectedDeployUuid = readString(selectedDeploy.selectedDeployUuid);
  if (!selectedDeployUuid) {
    return null;
  }

  const helm = readRecord(selectedDeploy.helm);
  const valueFiles = Array.isArray(helm.valueFiles)
    ? helm.valueFiles.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];

  return {
    selectedDeployUuid,
    deployableName: readString(selectedDeploy.deployableName),
    deployableType: readString(selectedDeploy.deployableType),
    repositoryFullName: readString(selectedDeploy.repositoryFullName),
    branchName: readString(selectedDeploy.branchName),
    serviceSha: readString(selectedDeploy.serviceSha),
    dockerfilePath: readString(selectedDeploy.dockerfilePath),
    initDockerfilePath: readString(selectedDeploy.initDockerfilePath),
    deployStatus: readString(selectedDeploy.deployStatus),
    deployStatusMessage: readString(selectedDeploy.deployStatusMessage),
    source: readString(selectedDeploy.source),
    helm:
      Object.keys(helm).length > 0
        ? {
            chartName: readString(helm.chartName),
            chartRepoUrl: readString(helm.chartRepoUrl),
            valueFiles,
          }
        : null,
  };
}

function toResolvedInstructionSnapshot(resolved: ResolvedInstructionTemplate): AgentRunPlanResolvedInstructionSnapshot {
  return {
    ref: resolved.ref,
    source: resolved.source,
    version: resolved.version,
    hash: resolved.hash,
    renderedText: resolved.content,
  };
}

async function resolveInstructionSnapshots(
  instructionRefs: readonly string[]
): Promise<AgentRunPlanResolvedInstructionSnapshot[]> {
  try {
    await InstructionTemplateService.seedSystemTemplates();
    if (instructionRefs.length === 0) {
      return [];
    }

    const resolved = await InstructionTemplateService.resolveRefs(instructionRefs);
    return resolved.map(toResolvedInstructionSnapshot);
  } catch (error) {
    if (error instanceof InstructionTemplateServiceError) {
      throw new AgentRunPlanInstructionTemplateError(
        error.templateCode,
        error.message,
        error.statusCode,
        error.details
      );
    }

    throw error;
  }
}

async function resolveRuleSnapshots(
  instructionRefs: readonly string[],
  repoFullName?: string | null
): Promise<AgentRunPlanResolvedRuleSnapshot[]> {
  return InstructionRuleService.resolveForRun({ instructionRefs, repoFullName });
}

function hashPromptSnapshot(
  definitionId: string,
  instructionRefs: string[],
  version: number,
  resolvedInstructions: AgentRunPlanResolvedInstructionSnapshot[],
  resolvedRules: AgentRunPlanResolvedRuleSnapshot[],
  instructionAddendum?: string | null
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        definitionId,
        instructionRefs,
        version,
        resolvedInstructions,
        resolvedRules,
        instructionAddendum: instructionAddendum || null,
      })
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
  const selectedDeploy = compactSelectedDeploy(sourceInput.selectedDeploy);
  const selectedRepo = selectedDeploy?.repositoryFullName || null;
  const selectedBranch = selectedDeploy?.branchName || null;

  return {
    id: source.uuid || null,
    adapter: source.adapter || null,
    status: source.status || null,
    sessionKind: session.sessionKind || null,
    buildUuid: readString(sourceInput.buildUuid) || session.buildUuid || null,
    repoFullName: selectedRepo || primaryRepo?.repo || repoFullName || null,
    branch: selectedBranch || primaryRepo?.branch || readString(sourceInput.branchName) || null,
    namespace: session.namespace || readString(sourceInput.namespace) || null,
    selectedDeploy,
    workspaceLayout: {
      repoCount: Array.isArray(session.workspaceRepos) ? session.workspaceRepos.length : 0,
      primaryRepo: selectedRepo || primaryRepo?.repo || repoFullName || null,
      selectedServiceCount: Array.isArray(session.selectedServices) ? session.selectedServices.length : 0,
      primaryService: selectedDeploy?.deployableName || primaryService?.name || null,
    },
    sandboxRequirements: source.sandboxRequirements || {},
    freshness: {
      capturedAt,
      preparedAt: source.preparedAt || null,
      freshnessSource: source.preparedAt ? 'source' : sourceKind === 'workspace_session' ? 'session' : 'request',
    },
  };
}

function resolveSourceKindForDefinition({
  defaultSourceKind,
  definition,
  session,
  source,
}: {
  defaultSourceKind: AgentRunPlanSourceKind;
  definition: AgentDefinitionContract;
  session: AgentSession;
  source: AgentSource;
}): AgentRunPlanSourceKind {
  const sourceKinds = definition.resourcePolicy.sourceKinds;

  if (sourceKinds.includes(defaultSourceKind)) {
    return defaultSourceKind;
  }

  if (session.workspaceStatus === AgentWorkspaceStatus.READY && sourceKinds.includes('workspace_session')) {
    return 'workspace_session';
  }

  if (readString(source.input?.buildUuid) && sourceKinds.includes('build_context_chat')) {
    return 'build_context_chat';
  }

  if (sourceKinds.includes('freeform_chat')) {
    return 'freeform_chat';
  }

  return defaultSourceKind;
}

function legacySystemDefinitionForSourceKind(sourceKind: AgentRunPlanSourceKind): AgentDefinitionContract {
  switch (sourceKind) {
    case 'build_context_chat':
      return SYSTEM_AGENT_DEFINITIONS['system.debug'];
    case 'workspace_session':
      return SYSTEM_AGENT_DEFINITIONS['system.develop'];
    case 'freeform_chat':
      return SYSTEM_AGENT_DEFINITIONS['system.freeform'];
  }
}

function effectiveDefinitionForRun({
  selectedDefinitionId,
  definition,
  sourceKind,
}: {
  selectedDefinitionId: string;
  definition: AgentDefinitionContract;
  sourceKind: AgentRunPlanSourceKind;
}): AgentDefinitionContract {
  if (selectedDefinitionId === 'system.agent') {
    return legacySystemDefinitionForSourceKind(sourceKind);
  }

  return definition;
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

const INVESTIGATION_REQUEST_PATTERNS = [
  /\binvestigate\s+(?:more|further|again|deeper)\b/,
  /\bkeep\s+investigating\b/,
  /\bdig\s+deeper\b/,
  /\blook\s+(?:deeper|further|closer|again)\b/,
  /\bmore\s+evidence\b/,
];

function messageRequestsDeeperInvestigation(messageText?: string | null): boolean {
  const normalized = messageText?.toLowerCase() || '';
  return INVESTIGATION_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Word-boundary patterns: bare substring matching misfired ("disapprove" contains "approve",
// "go ahead and dig deeper" contains "go ahead"). Buttons send an explicit debugIntent; this
// heuristic only backstops free text, so it stays conservative and defaults to diagnose.
const REPAIR_REQUEST_PATTERNS = [
  /\b(?:please\s+)?fix\s+(?:it|this|that|the)\b/,
  /\bplease\s+fix\b/,
  /\brepair\s+(?:it|this|that|the)\b/,
  /\bapply\s+(?:the|this|that)\s+fix\b/,
  /\bmake\s+(?:the|that)\s+fix\b/,
  /\bcommit\s+(?:the|that)\s+fix\b/,
  /\bproceed\s+with\s+(?:the\s+fix|the\s+repair|repairing)\b/,
  /\bgo\s+ahead\s+and\s+(?:fix|repair)\b/,
  /\byes,?\s+(?:fix|repair)\b/,
  /\bapproved?\b/,
  /\bdo\s+(?:it|that)\b/,
  /\bgo\s+ahead\b/,
  /\bplease\s+proceed\b/,
  // Redeploy/rebuild requests are actions, not questions — without these the run lands in
  // diagnose where trigger_redeploy is not even registered and the agent cannot comply.
  /\b(?:trigger|start|run|kick\s+off|do)\s+(?:a\s+|the\s+)?re-?deploy(?:ment)?\b/,
  /\bre-?deploy\s+(?:it|this|that|the|now)\b/,
  /\b(?:trigger|start|kick\s+off)\s+(?:a\s+|the\s+)?re-?build\b/,
  /\bre-?build\s+(?:it|this|that|the\s+environment|now)\b/,
];

function messageRequestsRepair(messageText?: string | null): boolean {
  const normalized = messageText?.toLowerCase() || '';
  if (
    /\b(do not|don't|dont|not)\s+(approve|repair|fix|proceed|do it)\b/.test(normalized) ||
    /\b(no|stop|cancel)\b[\s\S]{0,40}\b(repair|fix|do it|proceed|approve)\b/.test(normalized)
  ) {
    return false;
  }
  return REPAIR_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function resolveDebugIntentSnapshot({
  selectedDefinitionId,
  sourceKind,
  threadId,
  messageText,
  requestedDebugIntent,
  findPriorCompletedDebugIntentRun,
  sourceSnapshot,
  warnings,
}: {
  selectedDefinitionId: string;
  sourceKind: AgentRunPlanSourceKind;
  threadId: number;
  messageText?: string | null;
  requestedDebugIntent?: AgentDebugRunIntent | null;
  findPriorCompletedDebugIntentRun?: FindPriorCompletedDebugIntentRun;
  sourceSnapshot: AgentRunPlanSnapshotV1['source'];
  warnings: AgentRunPlanWarning[];
}): Promise<AgentRunPlanSnapshotV1['debug'] | undefined> {
  if (
    sourceKind !== 'build_context_chat' ||
    (selectedDefinitionId !== 'system.debug' && selectedDefinitionId !== 'system.agent')
  ) {
    return undefined;
  }

  const requestedIntent = requestedDebugIntent || null;

  const resolveRepairWithGuard = async (
    decisionSource: 'client_request' | 'message_heuristic',
    grantedReasonCode: string
  ): Promise<AgentRunPlanSnapshotV1['debug']> => {
    // 'investigate' kept for historical run rows.
    const hasPriorDiagnosisOrInvestigation = findPriorCompletedDebugIntentRun
      ? await findPriorCompletedDebugIntentRun({
          threadId,
          intents: ['diagnose', 'investigate'],
          buildUuid: sourceSnapshot.buildUuid || null,
          selectedDeployUuid: sourceSnapshot.selectedDeploy?.selectedDeployUuid || null,
        })
      : false;

    if (hasPriorDiagnosisOrInvestigation) {
      return {
        requestedIntent,
        resolvedIntent: 'repair',
        decisionSource,
        reasonCode: grantedReasonCode,
      };
    }

    warnings.push({
      code: 'debug_repair_requires_prior_diagnosis',
      message: 'Debug repair requires a prior completed diagnosis or investigation. Diagnosis will run first.',
    });

    return {
      requestedIntent,
      resolvedIntent: 'diagnose',
      decisionSource: 'repair_guard',
      reasonCode: 'repair_requires_prior_diagnosis',
    };
  };

  // 'investigate' stays accepted on the wire but runs identically to diagnose.
  if (requestedIntent === 'investigate') {
    return {
      requestedIntent,
      resolvedIntent: 'diagnose',
      decisionSource: 'client_request',
      reasonCode: 'explicit_investigate',
    };
  }

  if (requestedIntent === 'repair') {
    return resolveRepairWithGuard('client_request', 'explicit_repair_after_diagnosis');
  }

  if (requestedIntent === 'diagnose') {
    return {
      requestedIntent,
      resolvedIntent: 'diagnose',
      decisionSource: 'client_request',
      reasonCode: 'explicit_diagnose',
    };
  }

  // Investigation wins over repair phrasing: "go ahead and dig deeper" is a diagnose request.
  if (messageRequestsDeeperInvestigation(messageText)) {
    return {
      requestedIntent: null,
      resolvedIntent: 'diagnose',
      decisionSource: 'message_heuristic',
      reasonCode: 'message_requests_investigation',
    };
  }

  if (messageRequestsRepair(messageText)) {
    return resolveRepairWithGuard('message_heuristic', 'message_requests_repair');
  }

  return {
    requestedIntent: null,
    resolvedIntent: 'diagnose',
    decisionSource: 'default',
    reasonCode: 'default_debug_diagnose',
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
    if (!(error instanceof CustomAgentDefinitionServiceError) || error.reason !== 'not_found') {
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
    messageText,
    requestedDebugIntent,
    findPriorCompletedDebugIntentRun,
  }: {
    thread: AgentThread;
    session: AgentSession;
    source: AgentSource;
    userIdentity: RequestUserIdentity;
    requestedProvider?: string | null;
    requestedModel?: string | null;
    runtimeOptions?: AgentRunRuntimeOptions;
    messageText?: string | null;
    requestedDebugIntent?: AgentDebugRunIntent | null;
    findPriorCompletedDebugIntentRun?: FindPriorCompletedDebugIntentRun;
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
    const defaultSourceKind = AgentDefinitionRegistry.inferDefaultAgentSourceKind(session, source);
    const selectedAgentDefinitionId = AgentThreadService.getSelectedAgentDefinitionId(thread);
    const { selectedDefinitionId, definition } = await resolveSelectedDefinition({
      selectedAgentDefinitionId,
      defaultAgentDefinitionId,
      userId: userIdentity.userId,
      warnings,
    });
    const sourceKind = resolveSourceKindForDefinition({
      defaultSourceKind,
      definition,
      session,
      source,
    });
    const effectiveDefinition = effectiveDefinitionForRun({ selectedDefinitionId, definition, sourceKind });
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

    if (customAgentDefinitionNeedsOneAgentConversion(definition)) {
      throw new AgentRunPlanAgentUnavailableError(selectedDefinitionId, 'needs_conversion', {
        message: CUSTOM_AGENT_NEEDS_CONVERSION_MESSAGE,
      });
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

    const requiredCapabilityRefs = effectiveDefinition.requiredCapabilityRefs || effectiveDefinition.capabilityRefs;
    const optionalCapabilityRefs = effectiveDefinition.optionalCapabilityRefs || [];
    const runtimeChoices = await AgentThreadRuntimeControlsService.resolveRunAdmissionChoices({
      thread,
      userIdentity,
      definition: effectiveDefinition,
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
      definitionOwnerKind: effectiveDefinition.owner.kind,
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
      definitionOwnerKind: effectiveDefinition.owner.kind,
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
    const resolvedInstructions = await resolveInstructionSnapshots(effectiveDefinition.instructionRefs);
    const resolvedRules = await resolveRuleSnapshots(effectiveDefinition.instructionRefs, repoFullName);

    const capturedAt = new Date().toISOString();
    const sourceSnapshot = compactSource({ session, source, sourceKind, repoFullName, capturedAt });
    const debugIntentSnapshot = await resolveDebugIntentSnapshot({
      selectedDefinitionId,
      sourceKind,
      threadId: thread.id,
      messageText,
      requestedDebugIntent,
      findPriorCompletedDebugIntentRun,
      sourceSnapshot,
      warnings,
    });
    const runPlanSnapshot: AgentRunPlanSnapshotV1 = {
      version: 1,
      capturedAt,
      agent: {
        id: selectedDefinitionId,
        label: definition.name,
        ownerKind: definition.owner.kind,
        version: definition.version,
        sourceKind,
        resourcePolicy: effectiveDefinition.resourcePolicy,
        modelPreference: effectiveDefinition.modelPreference || definition.modelPreference || null,
      },
      source: sourceSnapshot,
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
        instructionRefs: effectiveDefinition.instructionRefs,
        resolvedInstructions,
        resolvedRules,
        instructionAddendum: effectiveDefinition.instructionAddendum || definition.instructionAddendum || null,
        renderedSummary: effectiveDefinition.description || definition.description || definition.name,
        renderedHash: hashPromptSnapshot(
          selectedDefinitionId,
          effectiveDefinition.instructionRefs,
          effectiveDefinition.version,
          resolvedInstructions,
          resolvedRules,
          effectiveDefinition.instructionAddendum || definition.instructionAddendum
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
    const profileResolution = resolveAgentHarnessV2ProfileCapabilities({ runPlanSnapshot });
    runPlanSnapshot.profile = toRunPlanProfileSnapshot(profileResolution);
    if (debugIntentSnapshot) {
      runPlanSnapshot.debug = debugIntentSnapshot;
      runPlanSnapshot.profile = toRunPlanProfileSnapshot(resolveAgentHarnessV2ProfileCapabilities({ runPlanSnapshot }));
    }

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
