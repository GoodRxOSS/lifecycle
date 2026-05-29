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

import { dynamicTool, jsonSchema } from 'ai';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import type { ResolvedAgentCapabilityAccess } from './PolicyService';
import type { AgentApprovalMode, AgentToolAuditRecord, AgentFileChangeData } from './types';
import type { AgentCapabilityCatalogId } from './capabilityCatalog';
import { buildAgentRuntimeToolMetadata, type AgentRuntimeToolMetadata } from './toolMetadata';

const REDACTED_MCP_DEFAULT_ARG = '******';

export type ToolExecutionHooks = {
  onToolStarted?: (audit: AgentToolAuditRecord) => Promise<void>;
  onToolFinished?: (audit: AgentToolAuditRecord & { result: unknown; status: 'completed' | 'failed' }) => Promise<void>;
  onFileChange?: (change: AgentFileChangeData) => Promise<void>;
  getActiveRunUuid?: () => string | null | undefined;
};

export function toAiJsonSchema(schema: unknown) {
  return jsonSchema(schema as any);
}

export function toAiDynamicTool(config: unknown) {
  return dynamicTool(config as any);
}

export function resolveToolApprovalMode({
  toolRules,
  toolKey,
  capabilityMode,
}: {
  toolRules: AgentSessionToolRule[] | undefined;
  toolKey: string;
  capabilityMode: AgentApprovalMode;
}): AgentApprovalMode {
  const rule = toolRules?.find((item) => item.toolKey === toolKey);
  return rule?.mode || capabilityMode;
}

export function recordToolMetadata(
  toolMetadata: AgentRuntimeToolMetadata[] | undefined,
  metadata: Omit<AgentRuntimeToolMetadata, 'effect' | 'resourceDomain' | 'workspaceNeed' | 'exposure'>
) {
  toolMetadata?.push(buildAgentRuntimeToolMetadata(metadata));
}

export function isCatalogCapabilityAllowed(
  resolvedCapabilityAccess: ResolvedAgentCapabilityAccess[] | undefined,
  capabilityId: AgentCapabilityCatalogId
): boolean {
  if (!resolvedCapabilityAccess) {
    return false;
  }

  return resolvedCapabilityAccess.some((entry) => entry.capabilityId === capabilityId && entry.allowed);
}

export function selectedMcpConnectionRefs(connectionRefs?: string[]): Set<string> | undefined {
  if (connectionRefs === undefined) {
    return undefined;
  }

  return new Set(connectionRefs.map((connectionRef) => connectionRef.trim()).filter(Boolean));
}

export function redactMcpDefaultArgs(
  args: Record<string, unknown>,
  defaultArgs: Record<string, string> | undefined
): Record<string, unknown> {
  if (!defaultArgs || Object.keys(defaultArgs).length === 0) {
    return args;
  }

  const redacted = { ...args };
  for (const key of Object.keys(defaultArgs)) {
    if (key in redacted) {
      redacted[key] = REDACTED_MCP_DEFAULT_ARG;
    }
  }

  return redacted;
}
