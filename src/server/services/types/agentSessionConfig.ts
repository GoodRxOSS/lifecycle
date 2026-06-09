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

import type { AgentApprovalMode, AgentCapabilityKey } from 'server/services/agent/types';
import type {
  AgentCapabilityAvailability,
  AgentCapabilityCatalogId,
  AgentCapabilityCategory,
} from 'server/services/agent/capabilityCatalog';
import type { AgentSessionWorkspaceBackendProvider, AgentSessionWorkspaceStorageAccessMode } from './globalConfig';

export type AgentSessionToolRuleMode = AgentApprovalMode;
export type AgentSessionToolRuleSelection = AgentSessionToolRuleMode | 'inherit';

export interface AgentSessionToolRule {
  toolKey: string;
  mode: AgentSessionToolRuleMode;
}

export interface AgentSessionControlPlaneConfigValue {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxIterations?: number;
  workspaceToolDiscoveryTimeoutMs?: number;
  workspaceToolExecutionTimeoutMs?: number;
  autoProvisionWorkspace?: boolean;
  toolRules?: AgentSessionToolRule[];
}

export interface EffectiveAgentSessionControlPlaneConfig {
  systemPrompt: string;
  appendSystemPrompt?: string;
  maxIterations: number;
  workspaceToolDiscoveryTimeoutMs: number;
  workspaceToolExecutionTimeoutMs: number;
  autoProvisionWorkspace: boolean;
  toolRules: AgentSessionToolRule[];
}

export interface AgentSessionReadinessSettingsValue {
  timeoutMs?: number;
  pollMs?: number;
}

export interface AgentSessionResourceRequirementsValue {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

export interface AgentSessionWorkspaceStorageSettingsValue {
  defaultSize?: string;
  allowedSizes?: string[];
  allowClientOverride?: boolean;
  accessMode?: AgentSessionWorkspaceStorageAccessMode;
}

export interface AgentSessionOpenSandboxBackendSettingsValue {
  domain?: string;
  protocol?: 'http' | 'https';
  apiKey?: string;
  /** Read-side only: whether an API key is configured (DB or env); the key itself is never returned. */
  apiKeyConfigured?: boolean;
  image?: string;
  poolRef?: string;
  timeoutSeconds?: number | null;
  useServerProxy?: boolean;
  secureAccess?: boolean;
  resourceLimits?: Record<string, string>;
  execdPort?: number;
  gatewayPort?: number;
  editorPort?: number;
}

export interface AgentSessionE2bBackendSettingsValue {
  apiKey?: string;
  /** Read-side only: whether an API key is configured (DB or env); the key itself is never returned. */
  apiKeyConfigured?: boolean;
  templateId?: string;
  domain?: string;
  timeoutSeconds?: number | null;
  autoPause?: boolean;
}

export interface AgentSessionDaytonaBackendSettingsValue {
  apiKey?: string;
  /** Read-side only: whether an API key is configured (DB or env); the key itself is never returned. */
  apiKeyConfigured?: boolean;
  snapshot?: string;
  apiUrl?: string;
  target?: string;
  autoArchiveInterval?: number;
}

export interface AgentSessionModalBackendSettingsValue {
  tokenId?: string;
  /** Read-side only: whether a token ID is configured (DB or env); the value itself is never returned. */
  tokenIdConfigured?: boolean;
  tokenSecret?: string;
  /** Read-side only: whether a token secret is configured (DB or env); the value itself is never returned. */
  tokenSecretConfigured?: boolean;
  environment?: string;
  appName?: string;
  image?: string;
  imageRegistrySecret?: string;
  timeoutSeconds?: number;
  cpu?: number;
  memoryMiB?: number;
  inboundCidrAllowlist?: string[];
}

export interface AgentSessionWorkspaceBackendSettingsValue {
  provider?: AgentSessionWorkspaceBackendProvider;
  opensandbox?: AgentSessionOpenSandboxBackendSettingsValue;
  e2b?: AgentSessionE2bBackendSettingsValue;
  daytona?: AgentSessionDaytonaBackendSettingsValue;
  modal?: AgentSessionModalBackendSettingsValue;
}

export interface AgentSessionCleanupSettingsValue {
  activeIdleSuspendMs?: number;
  startingTimeoutMs?: number;
  hibernatedRetentionMs?: number;
  intervalMs?: number;
  redisTtlSeconds?: number;
}

export interface AgentSessionDurabilitySettingsValue {
  runExecutionLeaseMs?: number;
  queuedRunDispatchStaleMs?: number;
  dispatchRecoveryLimit?: number;
  maxDurablePayloadBytes?: number;
  payloadPreviewBytes?: number;
  fileChangePreviewChars?: number;
}

export interface AgentSessionRuntimeSettingsValue {
  workspaceImage?: string;
  workspaceEditorImage?: string;
  workspaceGatewayImage?: string;
  scheduling?: {
    nodeSelector?: Record<string, string>;
    keepAttachedServicesOnSessionNode?: boolean;
  };
  readiness?: AgentSessionReadinessSettingsValue;
  resources?: {
    workspace?: AgentSessionResourceRequirementsValue;
    editor?: AgentSessionResourceRequirementsValue;
    workspaceGateway?: AgentSessionResourceRequirementsValue;
  };
  workspaceStorage?: AgentSessionWorkspaceStorageSettingsValue;
  workspaceBackend?: AgentSessionWorkspaceBackendSettingsValue;
  cleanup?: AgentSessionCleanupSettingsValue;
  durability?: AgentSessionDurabilitySettingsValue;
}

export interface AgentSessionToolInventoryEntry {
  toolKey: string;
  toolName: string;
  description: string | null;
  serverSlug: string;
  serverName: string;
  sourceType: 'builtin' | 'mcp';
  sourceScope: string;
  capabilityKey: AgentCapabilityKey;
  approvalMode: AgentApprovalMode;
  scopeRuleMode: AgentSessionToolRuleSelection;
  effectiveRuleMode: AgentSessionToolRuleSelection;
  availability: 'available' | 'blocked_by_tool_rule' | 'blocked_by_policy';
}

export interface AgentCapabilityInventoryToolEntry {
  toolKey: string;
  toolName: string;
  description: string | null;
  serverSlug: string;
  serverName: string;
  sourceType: 'builtin' | 'mcp';
  sourceScope: string;
}

export interface AgentCapabilityInventoryEntry {
  capabilityId: AgentCapabilityCatalogId;
  label: string;
  description: string;
  category: AgentCapabilityCategory;
  defaultAvailability: AgentCapabilityAvailability;
  configuredAvailability?: AgentCapabilityAvailability;
  inheritedAvailability?: AgentCapabilityAvailability;
  effectiveAvailability: AgentCapabilityAvailability;
  approvalMode: AgentApprovalMode;
  runtimeCapabilityKey?: AgentCapabilityKey;
  userSelectable: boolean;
  toolCount: number;
  resourceCount: number;
  resourceGrants: string[];
  tools: AgentCapabilityInventoryToolEntry[];
  blockedReason?: 'admin_only' | 'system_only' | 'disabled';
}
