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

import type { AgentDebugRunIntent, AgentRunPlanPublicSummary, AgentRunPlanSourceKind } from './runPlanTypes';
import { isAgentDebugRunIntent, isAgentRunPlanSnapshotV1 } from './runPlanTypes';
import { isAgentCapabilityAvailability, isAgentCapabilityCatalogId } from './capabilityCatalog';
import type { AgentApprovalMode } from './types';

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readSourceKind(value: unknown): AgentRunPlanSourceKind | null {
  if (value === 'build_context_chat' || value === 'workspace_session' || value === 'freeform_chat') {
    return value;
  }

  return null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readApprovalMode(value: unknown): AgentApprovalMode | null {
  if (value === 'allow' || value === 'require_approval' || value === 'deny') {
    return value;
  }

  return null;
}

function readDebugRunIntent(value: unknown): AgentDebugRunIntent | null {
  return isAgentDebugRunIntent(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readCapabilityIds(value: unknown): AgentRunPlanPublicSummary['capabilities']['selected']['capabilityIds'] {
  return readStringArray(value).filter(isAgentCapabilityCatalogId);
}

function readCapabilitySummary(value: unknown): AgentRunPlanPublicSummary['capabilities']['effective'][number] | null {
  const capability = readRecord(value);

  if (!capability) {
    return null;
  }

  const capabilityId = readNullableString(capability.capabilityId);
  const availability = readNullableString(capability.availability);
  const allowed = capability.allowed;
  const approvalMode = readApprovalMode(capability.approvalMode);

  if (
    !capabilityId ||
    !isAgentCapabilityCatalogId(capabilityId) ||
    !availability ||
    !isAgentCapabilityAvailability(availability) ||
    typeof allowed !== 'boolean'
  ) {
    return null;
  }

  return {
    capabilityId,
    availability,
    allowed,
    ...(approvalMode ? { approvalMode } : {}),
  };
}

function readCapabilitySummaries(value: unknown): AgentRunPlanPublicSummary['capabilities']['effective'] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const summaries: AgentRunPlanPublicSummary['capabilities']['effective'] = [];

  for (const entry of value) {
    const summary = readCapabilitySummary(entry);
    if (!summary) {
      return null;
    }
    summaries.push(summary);
  }

  return summaries;
}

function readWarningSummary(warnings: unknown[]): AgentRunPlanPublicSummary['warnings'] {
  return warnings
    .map(readRecord)
    .filter((warning): warning is Record<string, unknown> => Boolean(warning))
    .filter(
      (warning): warning is { code: string; message: string } =>
        typeof warning.code === 'string' && typeof warning.message === 'string'
    )
    .map((warning) => ({
      code: warning.code,
      message: warning.message,
    }));
}

export function serializeRunPlanSummary(snapshot: unknown): AgentRunPlanPublicSummary | null {
  if (!isAgentRunPlanSnapshotV1(snapshot)) {
    return null;
  }

  const agent = readRecord(snapshot.agent);
  const source = readRecord(snapshot.source);
  const model = readRecord(snapshot.model);
  const runtime = readRecord(snapshot.runtime);
  const approvalPolicy = runtime ? readRecord(runtime.approvalPolicy) : null;
  const runtimeOptions = runtime ? readRecord(runtime.runtimeOptions) : null;
  const capabilities = readRecord(snapshot.capabilities);
  const debug = readRecord(snapshot.debug);

  if (
    !agent ||
    !source ||
    !model ||
    !runtime ||
    !approvalPolicy ||
    !runtimeOptions ||
    !capabilities ||
    !Array.isArray(snapshot.warnings)
  ) {
    return null;
  }

  const label = readNullableString(agent.label);
  const agentId = readNullableString(agent.id);
  const sourceKind = readSourceKind(agent.sourceKind);
  const provider = readNullableString(model.resolvedProvider);
  const resolvedModel = readNullableString(model.resolvedModel);
  const harness = runtime.resolvedHarness;
  const maxIterations = typeof runtimeOptions.maxIterations === 'number' ? runtimeOptions.maxIterations : null;
  const defaultMode = readApprovalMode(approvalPolicy.defaultMode);
  const effectiveCapabilities = readCapabilitySummaries(capabilities.resolvedCapabilityAccess);
  const selectedCapabilityIds = readCapabilityIds(capabilities.selectedRuntimeCapabilityIds);
  const debugIntent = debug ? readDebugRunIntent(debug.resolvedIntent) : null;

  if (
    !agentId ||
    !label ||
    !sourceKind ||
    !provider ||
    !resolvedModel ||
    harness !== 'lifecycle_ai_sdk' ||
    !defaultMode ||
    !effectiveCapabilities
  ) {
    return null;
  }

  return {
    version: 1,
    agent: {
      id: agentId,
      label,
      sourceKind,
    },
    source: {
      kind: sourceKind,
      repoFullName: readNullableString(source.repoFullName),
      branch: readNullableString(source.branch),
      buildUuid: readNullableString(source.buildUuid),
      namespace: readNullableString(source.namespace),
    },
    model: {
      provider,
      model: resolvedModel,
    },
    runtime: {
      harness,
      maxIterations,
    },
    approval: {
      defaultMode,
    },
    capabilities: {
      effective: effectiveCapabilities,
      selected: {
        capabilityIds: selectedCapabilityIds,
        toolChoiceIds: readStringArray(capabilities.selectedRuntimeToolChoiceIds),
        mcpChoiceIds: readStringArray(capabilities.selectedRuntimeMcpChoiceIds),
      },
    },
    ...(debugIntent
      ? {
          debug: {
            intent: debugIntent,
          },
        }
      : {}),
    warnings: readWarningSummary(snapshot.warnings),
  };
}
