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

import type { UIDataTypes, UIMessage } from 'ai';

export const AGENT_CAPABILITY_KEYS = [
  'read',
  'external_mcp_read',
  'workspace_write',
  'shell_exec',
  'git_write',
  'network_access',
  'deploy_k8s_mutation',
  'external_mcp_write',
] as const;

export type AgentCapabilityKey = (typeof AGENT_CAPABILITY_KEYS)[number];
export type AgentApprovalMode = 'allow' | 'require_approval' | 'deny';
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentPendingActionStatus = 'pending' | 'approved' | 'denied';
export type AgentPendingActionKind = 'tool_approval' | 'user_input';

export interface AgentRunUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  steps?: number;
  toolCalls?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  nonCachedInputTokens?: number;
  textOutputTokens?: number;
  totalCostUsd?: number;
  costSource?: string;
  finishReason?: string;
  rawFinishReason?: string;
  warningCount?: number;
  responseId?: string;
  responseModelId?: string;
  responseTimestamp?: string;
  providerMetadata?: Record<string, unknown>;
  rawUsage?: Record<string, unknown>;
}

export type AgentFileChangeKind = 'edited' | 'created' | 'deleted';
export type AgentFileChangeStage = 'awaiting-approval' | 'approved' | 'applied' | 'denied' | 'failed';

export interface AgentFileChangeArtifact {
  path: string;
  kind: AgentFileChangeKind;
  additions: number;
  deletions: number;
  truncated: boolean;
  unifiedDiff?: string | null;
  beforeTextPreview?: string | null;
  afterTextPreview?: string | null;
  summary?: string | null;
  encoding?: string | null;
  oldSizeBytes?: number | null;
  newSizeBytes?: number | null;
  oldSha256?: string | null;
  newSha256?: string | null;
}

export interface AgentFileChangeData extends AgentFileChangeArtifact {
  id: string;
  toolCallId: string;
  sourceTool: string;
  displayPath: string;
  stage: AgentFileChangeStage;
}

export interface AgentUIDataParts extends UIDataTypes {
  'file-change': AgentFileChangeData;
}

export interface AgentApprovalPolicy {
  defaultMode: AgentApprovalMode;
  rules: Record<AgentCapabilityKey, AgentApprovalMode>;
}

export interface AgentUIMessageMetadata {
  sessionId?: string;
  threadId?: string;
  runId?: string;
  provider?: string;
  model?: string;
  createdAt?: string;
  completedAt?: string;
  finishReason?: string;
  rawFinishReason?: string;
  responseId?: string;
  responseModelId?: string;
  responseTimestamp?: string;
  warningCount?: number;
  providerMetadata?: Record<string, unknown>;
  usage?: AgentRunUsageSummary;
}

export type AgentUIMessage = UIMessage<AgentUIMessageMetadata, AgentUIDataParts>;

export interface AgentModelSummary {
  provider: string;
  modelId: string;
  displayName: string;
  default: boolean;
  maxTokens: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

export interface AgentResolvedModelSelection {
  provider: string;
  modelId: string;
}

export interface AgentRunExecutionOptions {
  sessionId: string;
  threadId: string;
  userId: string;
  githubUsername?: string | null;
  messages: AgentUIMessage[];
  provider?: string;
  modelId?: string;
}

export interface AgentToolAuditRecord {
  source: 'mcp';
  serverSlug?: string | null;
  toolName: string;
  toolCallId?: string | null;
  args: Record<string, unknown>;
  capabilityKey: AgentCapabilityKey;
}

export const DEFAULT_AGENT_APPROVAL_POLICY: AgentApprovalPolicy = {
  defaultMode: 'require_approval',
  rules: {
    read: 'allow',
    external_mcp_read: 'allow',
    workspace_write: 'require_approval',
    shell_exec: 'require_approval',
    git_write: 'require_approval',
    network_access: 'require_approval',
    deploy_k8s_mutation: 'require_approval',
    external_mcp_write: 'require_approval',
  },
};

export function isAgentCapabilityKey(value: string): value is AgentCapabilityKey {
  return AGENT_CAPABILITY_KEYS.includes(value as AgentCapabilityKey);
}
