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
import AgentSession from 'server/models/AgentSession';
import { sanitizeMcpErrorMessage, sanitizeMcpResult } from 'server/services/agentRuntime/mcp/config';
import { McpClientManager } from 'server/services/agentRuntime/mcp/client';
import { applyMcpDefaultToolArgs } from 'server/services/agentRuntime/mcp/runtimeConfig';
import { getLogger } from 'server/lib/logger';
import type { AgentApprovalMode, AgentCapabilityKey, AgentToolAuditRecord } from './types';
import type { AgentCapabilityCatalogId } from './capabilityCatalog';
import type { ResolvedMcpServer } from 'server/services/agentRuntime/mcp/types';
import { buildProposedFileChanges, buildResultFileChanges, didToolResultFail } from './fileChanges';
import { buildAgentToolKey } from './toolKeys';
import type { AgentRuntimeToolMetadata } from './toolMetadata';
import { recordToolMetadata, redactMcpDefaultArgs, toAiDynamicTool, toAiJsonSchema } from './capabilityToolHelpers';
import type { ToolExecutionHooks } from './capabilityToolHelpers';
import { getFileChangePreviewChars } from './chatWorkspaceToolRegistration';

export function registerGenericMcpTool({
  tools,
  session,
  server,
  discoveredTool,
  exposedToolName,
  description,
  capabilityKey,
  mode,
  catalogCapabilityId,
  hooks,
  toolMetadata,
}: {
  tools: ToolSet;
  session: AgentSession;
  server: ResolvedMcpServer;
  discoveredTool: ResolvedMcpServer['discoveredTools'][number];
  exposedToolName: string;
  description: string;
  capabilityKey: AgentCapabilityKey;
  mode: AgentApprovalMode;
  catalogCapabilityId: AgentCapabilityCatalogId;
  hooks?: ToolExecutionHooks;
  toolMetadata?: AgentRuntimeToolMetadata[];
}) {
  const toolKey = buildAgentToolKey(server.slug, exposedToolName);

  tools[toolKey] = toAiDynamicTool({
    description,
    inputSchema: toAiJsonSchema(discoveredTool.inputSchema as Record<string, unknown>),
    needsApproval: mode === 'require_approval',
    onInputAvailable: async ({ input, toolCallId }) => {
      if (!toolCallId) {
        return;
      }

      const runtimeArgs = applyMcpDefaultToolArgs(
        discoveredTool.inputSchema as Record<string, unknown>,
        server.defaultArgs,
        (input as Record<string, unknown>) || {}
      );
      const auditArgs = redactMcpDefaultArgs(runtimeArgs, server.defaultArgs);
      const changes = buildProposedFileChanges({
        toolCallId,
        sourceTool: exposedToolName,
        input: auditArgs,
        previewChars: await getFileChangePreviewChars(),
      });

      for (const change of changes) {
        await hooks?.onFileChange?.(change);
      }
    },
    execute: async (input, context) => {
      const toolCallId = context?.toolCallId;
      const runtimeArgs = applyMcpDefaultToolArgs(
        discoveredTool.inputSchema as Record<string, unknown>,
        server.defaultArgs,
        (input as Record<string, unknown>) || {}
      );
      const auditArgs = redactMcpDefaultArgs(runtimeArgs, server.defaultArgs);
      const audit: AgentToolAuditRecord = {
        source: 'mcp',
        serverSlug: server.slug,
        toolName: exposedToolName,
        toolCallId,
        args: auditArgs,
        capabilityKey,
      };

      await hooks?.onToolStarted?.(audit);

      const mcpSecretSources = [
        {
          compiledConfig: {
            env: server.env,
            defaultArgs: server.defaultArgs,
          },
          transport: server.transport,
        },
      ];
      const client = new McpClientManager();
      try {
        await client.connect(server.transport, server.timeout);
        const rawResult = await client.callTool(discoveredTool.name, runtimeArgs, server.timeout);
        const failed = rawResult.isError || didToolResultFail(rawResult);
        const result = failed ? sanitizeMcpResult(rawResult, mcpSecretSources) : rawResult;
        if (toolCallId) {
          const changes = buildResultFileChanges({
            toolCallId,
            sourceTool: exposedToolName,
            input: auditArgs,
            result,
            failed,
            previewChars: await getFileChangePreviewChars(),
          });

          for (const change of changes) {
            await hooks?.onFileChange?.(change);
          }
        }
        await hooks?.onToolFinished?.({
          ...audit,
          result,
          status: failed ? 'failed' : 'completed',
        });
        return result;
      } catch (error) {
        const errorMessage = sanitizeMcpErrorMessage(error, mcpSecretSources);
        getLogger().warn(
          { error: errorMessage },
          `AgentExec: mcp tool failed sessionId=${session.uuid} server=${server.slug} tool=${exposedToolName}`
        );
        if (toolCallId) {
          const changes = buildResultFileChanges({
            toolCallId,
            sourceTool: exposedToolName,
            input: auditArgs,
            result: {
              error: errorMessage,
            },
            failed: true,
            previewChars: await getFileChangePreviewChars(),
          });

          for (const change of changes) {
            await hooks?.onFileChange?.(change);
          }
        }
        await hooks?.onToolFinished?.({
          ...audit,
          result: {
            error: errorMessage,
          },
          status: 'failed',
        });
        throw new Error(errorMessage);
      } finally {
        await client.close();
      }
    },
  });
  recordToolMetadata(toolMetadata, {
    toolKey,
    catalogCapabilityId,
    capabilityKey,
    approvalMode: mode,
  });
}
