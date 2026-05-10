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

import type { AgentApprovalMode, AgentApprovalPolicy, AgentCapabilityKey } from './types';
import type { AgentCapabilityAvailability, AgentCapabilityCatalogId } from './capabilityCatalog';
import type { AgentRunRuntimeOptions } from './canonicalMessages';
import type {
  AgentDefinitionModelPreference,
  AgentDefinitionOwnerKind,
  AgentDefinitionResourcePolicy,
} from './agentDefinitionTypes';

export type AgentRunPlanSourceKind = 'build_context_chat' | 'workspace_session' | 'freeform_chat';
export type AgentDebugRunIntent = 'diagnose' | 'investigate' | 'repair';

export function isAgentDebugRunIntent(value: unknown): value is AgentDebugRunIntent {
  return value === 'diagnose' || value === 'investigate' || value === 'repair';
}

export interface AgentRunPlanWarning {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface AgentRunPlanAgentSnapshot {
  id: string;
  label: string;
  ownerKind?: AgentDefinitionOwnerKind;
  version?: number;
  sourceKind: AgentRunPlanSourceKind;
  resourcePolicy?: AgentDefinitionResourcePolicy;
  modelPreference?: AgentDefinitionModelPreference | null;
}

export interface AgentRunPlanSourceSnapshot {
  id?: string | null;
  adapter?: string | null;
  status?: string | null;
  sessionKind?: string | null;
  buildUuid?: string | null;
  repoFullName?: string | null;
  branch?: string | null;
  namespace?: string | null;
  selectedDeploy?: {
    selectedDeployUuid: string;
    deployableName?: string | null;
    deployableType?: string | null;
    repositoryFullName?: string | null;
    branchName?: string | null;
    serviceSha?: string | null;
    dockerfilePath?: string | null;
    initDockerfilePath?: string | null;
    deployStatus?: string | null;
    deployStatusMessage?: string | null;
    source?: string | null;
    helm?: {
      chartName?: string | null;
      chartRepoUrl?: string | null;
      valueFiles?: string[];
    } | null;
  } | null;
  workspaceLayout?: {
    repoCount?: number;
    primaryRepo?: string | null;
    selectedServiceCount?: number;
    primaryService?: string | null;
  };
  sandboxRequirements?: Record<string, unknown>;
  freshness: {
    capturedAt: string;
    preparedAt?: string | null;
    freshnessSource: 'source' | 'session' | 'request';
  };
}

export interface AgentRunPlanModelSnapshot {
  requestedProvider?: string | null;
  requestedModel?: string | null;
  resolvedProvider: string;
  resolvedModel: string;
}

export interface AgentRunPlanRuntimeSnapshot {
  resolvedHarness: 'lifecycle_ai_sdk';
  requestedHarness?: string | null;
  sandboxRequirement: Record<string, unknown>;
  runtimeOptions: AgentRunRuntimeOptions;
  approvalPolicy: AgentApprovalPolicy;
}

export interface AgentRunPlanResolvedInstructionSnapshot {
  ref: string;
  source: 'default' | 'override';
  version: number;
  hash: string;
  renderedText: string;
}

export interface AgentRunPlanPromptSnapshot {
  instructionRefs: string[];
  resolvedInstructions?: AgentRunPlanResolvedInstructionSnapshot[];
  instructionAddendum?: string | null;
  renderedSummary: string;
  renderedHash: string;
}

export interface AgentRunPlanCapabilitiesSnapshot {
  provisionalCapabilityIds: AgentCapabilityCatalogId[];
  resolvedCapabilityAccess: AgentRunPlanResolvedCapabilityAccess[];
  selectedRuntimeToolChoiceIds?: string[];
  selectedRuntimeMcpChoiceIds?: string[];
  selectedRuntimeCapabilityIds?: AgentCapabilityCatalogId[];
  selectedRuntimeMcpConnectionRefs?: string[];
}

export interface AgentRunPlanResolvedCapabilityAccess {
  capabilityId: AgentCapabilityCatalogId;
  availability: AgentCapabilityAvailability;
  allowed: boolean;
  reason?: string;
  runtimeCapabilityKey?: AgentCapabilityKey;
  approvalMode?: AgentApprovalMode;
}

export interface AgentRunPlanSnapshotV1 {
  version: 1;
  capturedAt: string;
  agent: AgentRunPlanAgentSnapshot;
  source: AgentRunPlanSourceSnapshot;
  model: AgentRunPlanModelSnapshot;
  runtime: AgentRunPlanRuntimeSnapshot;
  prompt: AgentRunPlanPromptSnapshot;
  capabilities: AgentRunPlanCapabilitiesSnapshot;
  debug?: {
    requestedIntent: AgentDebugRunIntent | null;
    resolvedIntent: AgentDebugRunIntent;
    decisionSource: 'default' | 'client_request' | 'message_heuristic' | 'repair_guard';
    reasonCode: string;
  };
  warnings: AgentRunPlanWarning[];
}

export interface AgentRunPlanPublicSummary {
  version: 1;
  agent: {
    id: string;
    label: string;
    sourceKind: AgentRunPlanSourceKind;
  };
  source: {
    kind: AgentRunPlanSourceKind;
    repoFullName?: string | null;
    branch?: string | null;
    buildUuid?: string | null;
    namespace?: string | null;
  };
  model: {
    provider: string;
    model: string;
  };
  runtime: {
    harness: 'lifecycle_ai_sdk';
    maxIterations: number | null;
  };
  approval: {
    defaultMode: AgentApprovalMode;
  };
  capabilities: {
    effective: Array<{
      capabilityId: AgentCapabilityCatalogId;
      availability: AgentCapabilityAvailability;
      allowed: boolean;
      approvalMode?: AgentApprovalMode;
    }>;
    selected: {
      capabilityIds: AgentCapabilityCatalogId[];
      toolChoiceIds: string[];
      mcpChoiceIds: string[];
    };
  };
  debug?: {
    intent: AgentDebugRunIntent;
  };
  warnings: Array<{
    code: string;
    message: string;
  }>;
}

export function isAgentRunPlanSnapshotV1(value: unknown): value is AgentRunPlanSnapshotV1 {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1
  );
}
