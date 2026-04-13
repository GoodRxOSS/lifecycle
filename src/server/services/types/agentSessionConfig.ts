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

export type AgentSessionToolRuleMode = 'allow' | 'deny';
export type AgentSessionToolRuleSelection = AgentSessionToolRuleMode | 'inherit';

export interface AgentSessionToolRule {
  toolKey: string;
  mode: AgentSessionToolRuleMode;
}

export interface AgentSessionControlPlaneConfigValue {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  toolRules?: AgentSessionToolRule[];
}

export interface EffectiveAgentSessionControlPlaneConfig {
  systemPrompt: string;
  appendSystemPrompt?: string;
  toolRules: AgentSessionToolRule[];
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
