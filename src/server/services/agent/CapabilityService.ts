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
import { getOwnedSession } from 'server/services/agent/sessionOwnership';
import { McpConfigService } from 'server/services/agentRuntime/mcp/config';
import { McpClientManager } from 'server/services/agentRuntime/mcp/client';
import { usesSessionWorkspaceGatewayExecution } from 'server/services/agentRuntime/mcp/sessionPod';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import type { CapabilityPolicyConfig, CustomAgentCreationPolicyConfig } from 'server/services/types/agentRuntimeConfig';
import AgentPolicyService from './PolicyService';
import type { ResolvedAgentCapabilityAccess } from './PolicyService';
import type { AgentApprovalPolicy, AgentToolAuditRecord } from './types';
import type { AgentCapabilityCatalogId } from './capabilityCatalog';
import AgentRuntimeConfigService from 'server/services/agentRuntime/config/agentRuntimeConfig';
import { assertSafeWorkspaceMutationCommand, isReadOnlyWorkspaceCommand } from './sandboxExecSafety';
import { didToolResultFail } from './fileChanges';
import {
  buildAgentToolKey,
  SESSION_WORKSPACE_MUTATION_TOOL_NAME,
  SESSION_WORKSPACE_READONLY_TOOL_NAME,
} from './toolKeys';
import { getSessionWorkspaceCatalogEntriesForRuntimeTool } from './sandboxToolCatalog';
import { registerLifecycleDiagnosticFixTools, registerLifecycleDiagnosticReadTools } from './diagnosticTools';
import type { AgentRuntimeToolMetadata } from './toolMetadata';
import {
  isCatalogCapabilityAllowed,
  recordToolMetadata,
  resolveToolApprovalMode,
  selectedMcpConnectionRefs,
  toAiDynamicTool,
  toAiJsonSchema,
  type ToolExecutionHooks,
} from './capabilityToolHelpers';
import { resolveLifecycleDiagnosticGithubSafety, resolvePrimaryRepo } from './capabilitySessionContext';
import {
  emitResultFileChanges,
  isChatWorkspaceRuntimeReady,
  registerChatPublishHttpTool,
  registerChatWorkspaceTools,
  resolveSessionExecutionServer,
  resolveSessionWorkspaceGatewayServer,
  WORKSPACE_EXEC_INPUT_SCHEMA,
} from './chatWorkspaceToolRegistration';
import { registerGenericMcpTool } from './mcpToolRegistration';

export type { AgentRuntimeToolMetadata } from './toolMetadata';

type BuildToolSetOptions = {
  session: AgentSession;
  repoFullName?: string;
  userIdentity: RequestUserIdentity;
  approvalPolicy: AgentApprovalPolicy;
  workspaceToolDiscoveryTimeoutMs: number;
  workspaceToolExecutionTimeoutMs: number;
  requestGitHubToken?: string | null;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
  resolvedCapabilityAccess?: ResolvedAgentCapabilityAccess[];
  selectedRuntimeMcpConnectionRefs?: string[];
};

export default class AgentCapabilityService {
  static async resolveSessionContext(
    sessionUuid: string,
    userIdentity: RequestUserIdentity
  ): Promise<{
    session: AgentSession;
    repoFullName?: string;
    approvalPolicy: AgentApprovalPolicy;
    capabilityPolicy?: CapabilityPolicyConfig;
    customAgentCreationPolicy?: CustomAgentCreationPolicyConfig;
  }> {
    const session = await getOwnedSession(sessionUuid, userIdentity.userId);
    const repoFullName = resolvePrimaryRepo(session);
    const [approvalPolicy, effectiveAgentConfig] = await Promise.all([
      AgentPolicyService.getEffectivePolicy(repoFullName),
      AgentRuntimeConfigService.getInstance().getEffectiveConfig(repoFullName),
    ]);

    return {
      session,
      repoFullName,
      approvalPolicy,
      capabilityPolicy: effectiveAgentConfig.capabilityPolicy,
      customAgentCreationPolicy: effectiveAgentConfig.customAgentCreationPolicy,
    };
  }

  static async buildToolSet(options: BuildToolSetOptions): Promise<ToolSet> {
    return (await this.buildToolSetWithMetadata(options)).tools;
  }

  static async buildToolSetWithMetadata({
    session,
    repoFullName,
    userIdentity,
    approvalPolicy,
    workspaceToolDiscoveryTimeoutMs,
    workspaceToolExecutionTimeoutMs,
    requestGitHubToken,
    hooks,
    toolRules,
    resolvedCapabilityAccess,
    selectedRuntimeMcpConnectionRefs,
  }: BuildToolSetOptions): Promise<{ tools: ToolSet; metadata: AgentRuntimeToolMetadata[] }> {
    const tools: ToolSet = {};
    const metadata: AgentRuntimeToolMetadata[] = [];
    const chatWorkspaceRuntimeReady = isChatWorkspaceRuntimeReady(session);
    const effectiveAgentConfig = await AgentRuntimeConfigService.getInstance().getEffectiveConfig(repoFullName);
    const lifecycleDiagnosticGithubSafety = session.buildUuid
      ? await resolveLifecycleDiagnosticGithubSafety({
          session,
          repoFullName,
          config: effectiveAgentConfig,
        })
      : undefined;

    if (session.sessionKind === 'chat') {
      registerChatWorkspaceTools({
        tools,
        session,
        userIdentity,
        approvalPolicy,
        workspaceToolExecutionTimeoutMs,
        requestGitHubToken,
        hooks,
        toolRules,
        resolvedCapabilityAccess,
        toolMetadata: metadata,
      });

      registerChatPublishHttpTool({
        tools,
        session,
        approvalPolicy,
        userIdentity,
        requestGitHubToken,
        hooks,
        toolRules,
        resolvedCapabilityAccess,
        toolMetadata: metadata,
      });
    }

    registerLifecycleDiagnosticReadTools({
      tools,
      session,
      approvalPolicy,
      hooks,
      toolRules,
      resolvedCapabilityAccess,
      githubSafety: lifecycleDiagnosticGithubSafety,
      toolMetadata: metadata,
    });
    registerLifecycleDiagnosticFixTools({
      tools,
      session,
      approvalPolicy,
      hooks,
      toolRules,
      resolvedCapabilityAccess,
      githubSafety: lifecycleDiagnosticGithubSafety,
      toolMetadata: metadata,
    });

    const mcpConfigService = new McpConfigService();
    const [repoServers, workspaceGatewayServer] = await Promise.all([
      mcpConfigService.resolveServers(repoFullName, undefined, userIdentity),
      session.sessionKind === 'chat' && !chatWorkspaceRuntimeReady
        ? Promise.resolve(null)
        : resolveSessionWorkspaceGatewayServer(session, {
            discoveryTimeoutMs: workspaceToolDiscoveryTimeoutMs,
            executionTimeoutMs: workspaceToolExecutionTimeoutMs,
          }),
    ]);
    const selectedRuntimeMcpRefs = selectedMcpConnectionRefs(selectedRuntimeMcpConnectionRefs);
    const selectedRepoServers = selectedRuntimeMcpRefs
      ? repoServers.filter((server) => selectedRuntimeMcpRefs.has(`${server.scope}:${server.slug}`))
      : repoServers;
    const resolvedRepoServers = selectedRepoServers.flatMap((server) => {
      if (!usesSessionWorkspaceGatewayExecution(server.transport)) {
        return [server];
      }

      if (!workspaceGatewayServer) {
        getLogger().warn(`AgentExec: workspace gateway unavailable sessionId=${session.uuid} server=${server.slug}`);
        return [];
      }

      const routedServer = resolveSessionExecutionServer(session, server);
      if (!routedServer) {
        getLogger().warn(
          `AgentExec: workspace gateway route unresolved sessionId=${session.uuid} server=${server.slug}`
        );
        return [];
      }

      return [routedServer];
    });
    const resolvedServers = workspaceGatewayServer
      ? [workspaceGatewayServer, ...resolvedRepoServers]
      : resolvedRepoServers;

    for (const server of resolvedServers) {
      for (const discoveredTool of server.discoveredTools) {
        if (server.slug === 'sandbox') {
          const catalogEntries = getSessionWorkspaceCatalogEntriesForRuntimeTool(discoveredTool.name, server.name);

          for (const entry of catalogEntries) {
            const capabilityKey = AgentPolicyService.capabilityForSessionWorkspaceTool(
              entry.toolName,
              entry.annotations || discoveredTool.annotations
            );
            if (!isCatalogCapabilityAllowed(resolvedCapabilityAccess, entry.catalogCapabilityId)) {
              continue;
            }

            const mode = resolveToolApprovalMode({
              toolRules,
              toolKey: entry.toolKey,
              capabilityMode: AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey),
            });

            if (mode === 'deny') {
              continue;
            }

            if (entry.toolName === SESSION_WORKSPACE_READONLY_TOOL_NAME) {
              const inputSchema = toAiJsonSchema(WORKSPACE_EXEC_INPUT_SCHEMA);

              tools[entry.toolKey] = toAiDynamicTool({
                description: entry.description,
                inputSchema,
                needsApproval: mode === 'require_approval',
                execute: async (input, context) => {
                  const toolCallId = context?.toolCallId;
                  const args = (input as Record<string, unknown>) || {};
                  const command = typeof args.command === 'string' ? args.command : '';
                  if (!isReadOnlyWorkspaceCommand(command)) {
                    throw new Error(
                      'This command is not a safe read-only inspection command. Use the workspace exec mutation tool for state-changing, networked, or process-managing commands.'
                    );
                  }

                  const audit: AgentToolAuditRecord = {
                    source: 'mcp',
                    serverSlug: server.slug,
                    toolName: entry.toolName,
                    toolCallId,
                    args,
                    capabilityKey,
                  };

                  await hooks?.onToolStarted?.(audit);

                  const client = new McpClientManager();
                  try {
                    await client.connect(server.transport, server.timeout);
                    const result = await client.callTool(discoveredTool.name, args, server.timeout);
                    const failed = result.isError || didToolResultFail(result);
                    await hooks?.onToolFinished?.({
                      ...audit,
                      result,
                      status: failed ? 'failed' : 'completed',
                    });
                    return result;
                  } catch (error) {
                    getLogger().warn(
                      { error },
                      `AgentExec: mcp tool failed sessionId=${session.uuid} server=${server.slug} tool=${entry.toolName}`
                    );
                    await hooks?.onToolFinished?.({
                      ...audit,
                      result: {
                        error: error instanceof Error ? error.message : String(error),
                      },
                      status: 'failed',
                    });
                    throw error;
                  } finally {
                    await client.close();
                  }
                },
              });
              recordToolMetadata(metadata, {
                toolKey: entry.toolKey,
                catalogCapabilityId: entry.catalogCapabilityId,
                capabilityKey,
                approvalMode: mode,
              });

              continue;
            }

            if (entry.toolName === SESSION_WORKSPACE_MUTATION_TOOL_NAME) {
              const inputSchema = toAiJsonSchema(WORKSPACE_EXEC_INPUT_SCHEMA);

              tools[entry.toolKey] = toAiDynamicTool({
                description: entry.description,
                inputSchema,
                needsApproval: mode === 'require_approval',
                execute: async (input, context) => {
                  const args = (input as Record<string, unknown>) || {};
                  const command = typeof args.command === 'string' ? args.command : '';
                  assertSafeWorkspaceMutationCommand(command);
                  const toolCallId = context?.toolCallId;
                  const audit: AgentToolAuditRecord = {
                    source: 'mcp',
                    serverSlug: server.slug,
                    toolName: entry.toolName,
                    toolCallId,
                    args,
                    capabilityKey,
                  };

                  await hooks?.onToolStarted?.(audit);

                  const client = new McpClientManager();
                  try {
                    await client.connect(server.transport, server.timeout);
                    const result = await client.callTool(
                      discoveredTool.name,
                      { ...args, captureFileChanges: true },
                      server.timeout
                    );
                    const failed = result.isError || didToolResultFail(result);
                    await emitResultFileChanges({
                      hooks,
                      toolCallId,
                      sourceTool: entry.toolName,
                      input: args,
                      result,
                      failed,
                    });
                    await hooks?.onToolFinished?.({
                      ...audit,
                      result,
                      status: failed ? 'failed' : 'completed',
                    });
                    return result;
                  } catch (error) {
                    getLogger().warn(
                      { error },
                      `AgentExec: mcp tool failed sessionId=${session.uuid} server=${server.slug} tool=${entry.toolName}`
                    );
                    await hooks?.onToolFinished?.({
                      ...audit,
                      result: {
                        error: error instanceof Error ? error.message : String(error),
                      },
                      status: 'failed',
                    });
                    throw error;
                  } finally {
                    await client.close();
                  }
                },
              });
              recordToolMetadata(metadata, {
                toolKey: entry.toolKey,
                catalogCapabilityId: entry.catalogCapabilityId,
                capabilityKey,
                approvalMode: mode,
              });

              continue;
            }

            registerGenericMcpTool({
              tools,
              session,
              server,
              discoveredTool,
              exposedToolName: entry.toolName,
              description: entry.description,
              capabilityKey,
              mode,
              catalogCapabilityId: entry.catalogCapabilityId,
              hooks,
              toolMetadata: metadata,
            });
          }

          continue;
        }

        const capabilityKey = AgentPolicyService.capabilityForExternalMcpTool(
          discoveredTool.name,
          discoveredTool.annotations
        );
        const catalogCapabilityId: AgentCapabilityCatalogId =
          capabilityKey === 'external_mcp_read' ? 'external_mcp_read' : 'external_mcp_write';
        if (!isCatalogCapabilityAllowed(resolvedCapabilityAccess, catalogCapabilityId)) {
          continue;
        }

        const toolName = buildAgentToolKey(server.slug, discoveredTool.name);
        const mode = resolveToolApprovalMode({
          toolRules,
          toolKey: toolName,
          capabilityMode: AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey),
        });

        if (mode === 'deny') {
          continue;
        }

        registerGenericMcpTool({
          tools,
          session,
          server,
          discoveredTool,
          exposedToolName: discoveredTool.name,
          description: discoveredTool.description || `MCP tool ${discoveredTool.name} from ${server.name}`,
          capabilityKey,
          mode,
          catalogCapabilityId,
          hooks,
          toolMetadata: metadata,
        });
      }
    }

    return { tools, metadata };
  }
}
