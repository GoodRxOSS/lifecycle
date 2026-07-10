/**
 * Copyright 2025 GoodRx, Inc.
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

import type { AgentCapabilityAvailability, AgentCapabilityCatalogId } from 'server/services/agent/capabilityCatalog';

export interface AgentRuntimeModelConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  default: boolean;
  maxTokens: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

export interface AgentRuntimeProviderConfig {
  name: string;
  enabled: boolean;
  apiKeyEnvVar: string;
  models: AgentRuntimeModelConfig[];
}

export type ApprovalModeConfig = 'allow' | 'require_approval' | 'deny';

export interface ApprovalPolicyConfig {
  defaultMode?: ApprovalModeConfig;
  rules?: Partial<
    Record<
      | 'read'
      | 'external_mcp_read'
      | 'workspace_write'
      | 'shell_exec'
      | 'git_write'
      | 'network_access'
      | 'deploy_k8s_mutation'
      | 'external_mcp_write',
      ApprovalModeConfig
    >
  >;
}

export interface CapabilityPolicyConfig {
  availability?: Partial<Record<AgentCapabilityCatalogId, AgentCapabilityAvailability>>;
}

export type CustomAgentCreationMode = 'enabled' | 'disabled' | 'admins_only' | 'allowlist';
export type CreatorCapabilityAvailability = 'available' | 'reserved';

export interface CustomAgentCreationPolicyConfig {
  mode?: CustomAgentCreationMode;
  allowedUserIds?: string[];
  allowedGithubUsernames?: string[];
  capabilityAvailability?: Partial<Record<AgentCapabilityCatalogId, CreatorCapabilityAvailability>>;
}

export interface AgentRuntimeConfig {
  enabled: boolean;
  providers: AgentRuntimeProviderConfig[];
  maxMessagesPerSession: number;
  sessionTTL: number;
  approvalPolicy?: ApprovalPolicyConfig;
  capabilityPolicy?: CapabilityPolicyConfig;
  customAgentCreationPolicy?: CustomAgentCreationPolicyConfig;
  excludedTools?: string[];
  excludedFilePatterns?: string[];
  allowedWritePatterns?: string[];
  maxIterations?: number;
  maxToolCalls?: number;
  maxRepeatedCalls?: number;
  compressionThreshold?: number;
  observationMaskingRecencyWindow?: number;
  observationMaskingTokenThreshold?: number;
  toolExecutionTimeout?: number;
  toolOutputMaxChars?: number;
  retryBudget?: number;
}

export interface AgentRuntimeRepoConfigRow {
  id: number;
  repositoryFullName: string;
  config: Partial<AgentRuntimeRepoOverride>;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface AgentRuntimeRepoOverride {
  enabled?: boolean;
  maxMessagesPerSession?: number;
  sessionTTL?: number;
  approvalPolicy?: ApprovalPolicyConfig;
  capabilityPolicy?: CapabilityPolicyConfig;
  excludedTools?: string[];
  excludedFilePatterns?: string[];
  allowedWritePatterns?: string[];
}
