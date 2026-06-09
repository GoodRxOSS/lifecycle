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

import type { ToolApprovalConfiguration, ToolApprovalStatus, ToolSet } from 'ai';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import type { ResolvedAgentCapabilityAccess } from './PolicyService';
import type { AgentApprovalMode, AgentToolAuditRecord, AgentFileChangeData } from './types';
import type { AgentCapabilityCatalogId } from './capabilityCatalog';
import { buildAgentRuntimeToolMetadata, type AgentRuntimeToolMetadata } from './toolMetadata';
import type { AiSdkRuntime } from './aiSdkRuntime';
import {
  AGENT_RUNTIME_TOOL_CONTEXT_JSON_SCHEMA,
  type AgentRuntimeContext,
  type AgentRuntimeToolContext,
  type AgentRuntimeToolsContext,
} from './runtimeContext';

const REDACTED_MCP_DEFAULT_ARG = '******';
type AiToolFactories = Pick<AiSdkRuntime, 'dynamicTool' | 'jsonSchema'>;
let aiToolFactories: AiToolFactories | null = null;

export function configureAiToolFactories(factories: AiToolFactories): void {
  aiToolFactories = factories;
}

function requireAiToolFactories(): AiToolFactories {
  if (!aiToolFactories) {
    throw new Error('AI SDK tool factories are not initialized.');
  }

  return aiToolFactories;
}

export type ToolExecutionHooks = {
  onToolStarted?: (audit: AgentToolAuditRecord) => Promise<void>;
  onToolFinished?: (
    audit: AgentToolAuditRecord & {
      result: unknown;
      status: 'completed' | 'failed';
      auth?: AgentToolAuditRecord['auth'];
    }
  ) => Promise<void>;
  onFileChange?: (change: AgentFileChangeData) => Promise<void>;
  getActiveRunUuid?: () => string | null | undefined;
};

export type AgentRuntimeToolApprovalPredicate = (input: Record<string, unknown>) => boolean | Promise<boolean>;
export type AgentRuntimeToolApprovalResolver = (
  input: unknown,
  context: {
    toolContext?: AgentRuntimeToolContext;
    runtimeContext?: AgentRuntimeContext;
  }
) => ToolApprovalStatus | Promise<ToolApprovalStatus>;
export type AgentRuntimeToolApprovalConfig = Record<string, ToolApprovalStatus | AgentRuntimeToolApprovalResolver>;

export function toAiJsonSchema(schema: unknown) {
  return requireAiToolFactories().jsonSchema(schema as any);
}

export function toAiDynamicTool(config: unknown) {
  return requireAiToolFactories().dynamicTool(config as any);
}

export function toAiRuntimeToolContextSchema() {
  return toAiJsonSchema(AGENT_RUNTIME_TOOL_CONTEXT_JSON_SCHEMA);
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

export function recordToolApproval(
  toolApproval: AgentRuntimeToolApprovalConfig | undefined,
  {
    toolKey,
    mode,
    shouldRequestApproval,
  }: {
    toolKey: string;
    mode: AgentApprovalMode;
    shouldRequestApproval?: AgentRuntimeToolApprovalPredicate;
  }
) {
  if (!toolApproval || mode !== 'require_approval') {
    return;
  }

  if (!shouldRequestApproval) {
    toolApproval[toolKey] = 'user-approval';
    return;
  }

  toolApproval[toolKey] = async (input: unknown) => {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    return (await shouldRequestApproval(args)) ? 'user-approval' : 'not-applicable';
  };
}

export function buildAiToolApprovalConfig(
  toolApproval: AgentRuntimeToolApprovalConfig | undefined
): ToolApprovalConfiguration<ToolSet, AgentRuntimeContext> | undefined {
  if (!toolApproval || Object.keys(toolApproval).length === 0) {
    return undefined;
  }

  const approval: ToolApprovalConfiguration<ToolSet, AgentRuntimeContext> = async ({
    toolCall,
    toolsContext,
    runtimeContext,
  }) => {
    const decision = toolApproval[toolCall.toolName];
    if (!decision) {
      return 'not-applicable';
    }

    if (typeof decision === 'function') {
      return decision(toolCall.input, {
        toolContext: (toolsContext as AgentRuntimeToolsContext | undefined)?.[toolCall.toolName],
        runtimeContext,
      });
    }

    return decision;
  };

  return approval;
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
