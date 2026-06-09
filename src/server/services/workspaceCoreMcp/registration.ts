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

import { type ToolSet } from 'ai';
import type AgentSession from 'server/models/AgentSession';
import type { RequestUserIdentity } from 'server/lib/get-user';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import type { ResolvedMcpServer } from 'server/services/agentRuntime/mcp/types';
import AgentPolicyService, { type ResolvedAgentCapabilityAccess } from 'server/services/agent/PolicyService';
import type { AgentApprovalMode, AgentApprovalPolicy, AgentToolAuditRecord } from 'server/services/agent/types';
import type { AgentRuntimeToolMetadata } from 'server/services/agent/toolMetadata';
import { buildProposedFileChanges } from 'server/services/agent/fileChanges';
import {
  recordToolMetadata,
  recordToolApproval,
  resolveToolApprovalMode,
  toAiDynamicTool,
  toAiJsonSchema,
  toAiRuntimeToolContextSchema,
  type AgentRuntimeToolApprovalConfig,
  type ToolExecutionHooks,
} from 'server/services/agent/capabilityToolHelpers';
import { buildAgentToolKey } from 'server/services/agent/toolKeys';
import {
  buildAgentRuntimeToolContextFromMetadataInput,
  resolveAgentRuntimeToolContext,
} from 'server/services/agent/runtimeContext';
import { resolveAgentSessionDurabilityConfig } from 'server/lib/agentSession/runtimeConfig';
import { executeWorkspaceCoreTool } from './adapters';
import {
  WORKSPACE_CORE_SERVER_SLUG,
  WORKSPACE_CORE_TOOL_DEFINITIONS,
  type WorkspaceCoreToolDefinition,
} from './toolDefinitions';
import { policyErrorResult, toWorkspaceCoreMcpResult, toWorkspaceCorePolicyMcpResult } from './result';

type RegisterWorkspaceCoreToolsOptions = {
  tools: ToolSet;
  session: AgentSession;
  userIdentity: RequestUserIdentity;
  approvalPolicy: AgentApprovalPolicy;
  workspaceGatewayServer: ResolvedMcpServer | null;
  resolveWorkspaceGatewayServer?: () => Promise<ResolvedMcpServer | null>;
  workspaceToolExecutionTimeoutMs: number;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
  resolvedCapabilityAccess?: ResolvedAgentCapabilityAccess[];
  toolMetadata?: AgentRuntimeToolMetadata[];
  toolApproval?: AgentRuntimeToolApprovalConfig;
};

function capabilityAccessAllowed(
  resolvedCapabilityAccess: ResolvedAgentCapabilityAccess[] | undefined,
  definition: WorkspaceCoreToolDefinition
): boolean {
  if (!resolvedCapabilityAccess) {
    return false;
  }

  return resolvedCapabilityAccess.some(
    (access) => access.capabilityId === definition.catalogCapabilityId && access.allowed
  );
}

function buildCapabilityDeniedResult(definition: WorkspaceCoreToolDefinition) {
  return policyErrorResult({
    code: 'policy_denied',
    retry: 'never',
    message: `workspace_core.${definition.name} is not allowed by the current capability policy.`,
    details: {
      tool: definition.name,
      catalog_capability_id: definition.catalogCapabilityId,
      runtime_capability: definition.capabilityKey,
    },
  });
}

function resolveMode({
  definition,
  approvalPolicy,
  toolRules,
  toolKey,
}: {
  definition: WorkspaceCoreToolDefinition;
  approvalPolicy: AgentApprovalPolicy;
  toolRules?: AgentSessionToolRule[];
  toolKey: string;
}): AgentApprovalMode | undefined {
  return resolveToolApprovalMode({
    toolRules,
    toolKey,
    capabilityMode: AgentPolicyService.modeForCapability(approvalPolicy, definition.capabilityKey),
  });
}

function canBuildProposedFileChanges(definition: WorkspaceCoreToolDefinition): boolean {
  return definition.name === 'edit_file' || definition.name === 'write_file';
}

export function registerWorkspaceCoreTools({
  tools,
  session,
  userIdentity,
  approvalPolicy,
  workspaceGatewayServer,
  resolveWorkspaceGatewayServer,
  workspaceToolExecutionTimeoutMs,
  hooks,
  toolRules,
  resolvedCapabilityAccess,
  toolMetadata,
  toolApproval,
}: RegisterWorkspaceCoreToolsOptions): void {
  for (const definition of WORKSPACE_CORE_TOOL_DEFINITIONS) {
    const toolKey = buildAgentToolKey(WORKSPACE_CORE_SERVER_SLUG, definition.name);
    const mode = resolveMode({ definition, approvalPolicy, toolRules, toolKey });
    const metadataInput = {
      toolKey,
      serverSlug: WORKSPACE_CORE_SERVER_SLUG,
      sourceToolName: definition.name,
      catalogCapabilityId: definition.catalogCapabilityId,
      capabilityKey: definition.capabilityKey,
      approvalMode: mode || ('allow' as const),
    };
    const fallbackToolContext = buildAgentRuntimeToolContextFromMetadataInput(metadataInput);

    tools[toolKey] = toAiDynamicTool({
      description: definition.description,
      inputSchema: toAiJsonSchema(definition.inputSchema),
      outputSchema: toAiJsonSchema(definition.outputSchema),
      contextSchema: toAiRuntimeToolContextSchema(),
      onInputAvailable: canBuildProposedFileChanges(definition)
        ? async ({ input, toolCallId }) => {
            if (!toolCallId) {
              return;
            }

            const args =
              input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
            const durabilityConfig = await resolveAgentSessionDurabilityConfig();
            const changes = buildProposedFileChanges({
              toolCallId,
              sourceTool: definition.name,
              input: args,
              previewChars: durabilityConfig.fileChangePreviewChars,
            });

            for (const change of changes) {
              await hooks?.onFileChange?.(change);
            }
          }
        : undefined,
      execute: async (input, context) => {
        const runtimeToolContext = resolveAgentRuntimeToolContext(context?.context, fallbackToolContext);
        const args =
          input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
        const toolCallId = context?.toolCallId;
        const audit: AgentToolAuditRecord = {
          source: 'mcp',
          serverSlug: runtimeToolContext.serverSlug,
          toolName: runtimeToolContext.sourceToolName,
          toolCallId,
          args,
          capabilityKey: runtimeToolContext.capabilityKey,
        };

        await hooks?.onToolStarted?.(audit);

        const deniedResult = !capabilityAccessAllowed(resolvedCapabilityAccess, definition)
          ? buildCapabilityDeniedResult(definition)
          : mode === 'deny'
          ? buildCapabilityDeniedResult(definition)
          : null;

        if (deniedResult) {
          const result = toWorkspaceCorePolicyMcpResult(deniedResult);
          await hooks?.onToolFinished?.({
            ...audit,
            result,
            status: 'failed',
          });
          return result;
        }

        const structuredContent = await executeWorkspaceCoreTool(definition, args, {
          session,
          userIdentity,
          workspaceGatewayServer,
          resolveWorkspaceGatewayServer,
          timeoutMs: workspaceToolExecutionTimeoutMs,
        });
        const isError =
          structuredContent &&
          typeof structuredContent === 'object' &&
          !Array.isArray(structuredContent) &&
          (structuredContent as { ok?: unknown }).ok === false;
        const result = isError
          ? toWorkspaceCorePolicyMcpResult(structuredContent as ReturnType<typeof policyErrorResult>)
          : toWorkspaceCoreMcpResult(structuredContent);

        await hooks?.onToolFinished?.({
          ...audit,
          result,
          status: isError ? 'failed' : 'completed',
        });
        return result;
      },
    });

    recordToolMetadata(toolMetadata, metadataInput);
    recordToolApproval(toolApproval, { toolKey, mode: mode || 'allow' });
  }
}
