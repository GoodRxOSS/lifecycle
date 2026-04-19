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

import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import AgentSession from 'server/models/AgentSession';
import { SESSION_WORKSPACE_GATEWAY_PORT } from 'server/lib/agentSession/podFactory';
import { McpConfigService } from 'server/services/ai/mcp/config';
import { McpClientManager } from 'server/services/ai/mcp/client';
import { applyMcpDefaultToolArgs } from 'server/services/ai/mcp/runtimeConfig';
import { usesSessionWorkspaceGatewayExecution } from 'server/services/ai/mcp/sessionPod';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import AgentPolicyService from './PolicyService';
import type { AgentApprovalMode, AgentApprovalPolicy, AgentCapabilityKey, AgentToolAuditRecord } from './types';
import type { ResolvedMcpServer } from 'server/services/ai/mcp/types';
import { isReadOnlyWorkspaceCommand } from './sandboxExecSafety';
import { buildProposedFileChanges, buildResultFileChanges, didToolResultFail } from './fileChanges';
import type { AgentFileChangeData } from './types';
import {
  buildAgentToolKey,
  SESSION_WORKSPACE_MUTATION_TOOL_NAME,
  SESSION_WORKSPACE_READONLY_TOOL_NAME,
} from './toolKeys';
import { getSessionWorkspaceCatalogEntriesForRuntimeTool } from './sandboxToolCatalog';
import { SessionWorkspaceGatewayUnavailableError } from './errors';

type ToolExecutionHooks = {
  onToolStarted?: (audit: AgentToolAuditRecord) => Promise<void>;
  onToolFinished?: (audit: AgentToolAuditRecord & { result: unknown; status: 'completed' | 'failed' }) => Promise<void>;
  onFileChange?: (change: AgentFileChangeData) => Promise<void>;
};

type SessionWorkspaceGatewayTimeouts = {
  discoveryTimeoutMs: number;
  executionTimeoutMs: number;
};

function resolvePrimaryRepo(session: AgentSession): string | undefined {
  const primaryRepo = (session.workspaceRepos || []).find((repo) => repo.primary)?.repo;
  if (primaryRepo) {
    return primaryRepo;
  }

  return session.selectedServices?.[0]?.repo || undefined;
}

function resolveToolApprovalMode({
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

function resolveSessionWorkspaceGatewayBaseUrl(session: AgentSession): string | null {
  if (!session.podName || !session.namespace || session.status !== 'active') {
    return null;
  }

  return `http://${session.podName}.${session.namespace}.svc.cluster.local:${SESSION_WORKSPACE_GATEWAY_PORT}`;
}

async function resolveSessionWorkspaceGatewayServer(
  session: AgentSession,
  timeouts: SessionWorkspaceGatewayTimeouts
): Promise<ResolvedMcpServer | null> {
  const baseUrl = resolveSessionWorkspaceGatewayBaseUrl(session);
  if (!baseUrl) {
    return null;
  }

  const url = `${baseUrl}/mcp`;
  const client = new McpClientManager();

  try {
    await client.connect({ type: 'http', url }, timeouts.discoveryTimeoutMs);
    const discoveredTools = await client.listTools(timeouts.discoveryTimeoutMs);

    return {
      slug: 'sandbox',
      name: 'Session Workspace',
      transport: { type: 'http', url },
      timeout: timeouts.executionTimeoutMs,
      defaultArgs: {},
      env: {},
      discoveredTools,
    };
  } catch (error) {
    getLogger().warn(
      { error },
      `AgentExec: workspace gateway unavailable sessionId=${session.uuid} namespace=${session.namespace} podName=${session.podName}`
    );
    throw new SessionWorkspaceGatewayUnavailableError({
      sessionId: session.uuid,
      cause: error,
    });
  } finally {
    await client.close();
  }
}

function resolveSessionExecutionServer(session: AgentSession, server: ResolvedMcpServer): ResolvedMcpServer | null {
  if (!usesSessionWorkspaceGatewayExecution(server.transport)) {
    return server;
  }

  const baseUrl = resolveSessionWorkspaceGatewayBaseUrl(session);
  if (!baseUrl) {
    return null;
  }

  return {
    ...server,
    transport: {
      type: 'http',
      url: `${baseUrl}/servers/${encodeURIComponent(server.slug)}/mcp`,
    },
  };
}

function registerGenericMcpTool({
  tools,
  session,
  server,
  discoveredTool,
  exposedToolName,
  description,
  capabilityKey,
  mode,
  hooks,
}: {
  tools: ToolSet;
  session: AgentSession;
  server: ResolvedMcpServer;
  discoveredTool: ResolvedMcpServer['discoveredTools'][number];
  exposedToolName: string;
  description: string;
  capabilityKey: AgentCapabilityKey;
  mode: AgentApprovalMode;
  hooks?: ToolExecutionHooks;
}) {
  const toolKey = buildAgentToolKey(server.slug, exposedToolName);

  tools[toolKey] = dynamicTool({
    description,
    inputSchema: jsonSchema(discoveredTool.inputSchema as Record<string, unknown>),
    needsApproval: mode === 'require_approval',
    onInputAvailable: async ({ input, toolCallId }) => {
      if (!toolCallId) {
        return;
      }

      const args = applyMcpDefaultToolArgs(
        discoveredTool.inputSchema as Record<string, unknown>,
        server.defaultArgs,
        (input as Record<string, unknown>) || {}
      );
      const changes = buildProposedFileChanges({
        toolCallId,
        sourceTool: exposedToolName,
        input: args,
      });

      for (const change of changes) {
        await hooks?.onFileChange?.(change);
      }
    },
    execute: async (input, context) => {
      const toolCallId = context?.toolCallId;
      const args = applyMcpDefaultToolArgs(
        discoveredTool.inputSchema as Record<string, unknown>,
        server.defaultArgs,
        (input as Record<string, unknown>) || {}
      );
      const audit: AgentToolAuditRecord = {
        source: 'mcp',
        serverSlug: server.slug,
        toolName: exposedToolName,
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
        if (toolCallId) {
          const changes = buildResultFileChanges({
            toolCallId,
            sourceTool: exposedToolName,
            input: args,
            result,
            failed,
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
        getLogger().warn(
          { error },
          `AgentExec: mcp tool failed sessionId=${session.uuid} server=${server.slug} tool=${exposedToolName}`
        );
        if (toolCallId) {
          const changes = buildResultFileChanges({
            toolCallId,
            sourceTool: exposedToolName,
            input: args,
            result: {
              error: error instanceof Error ? error.message : String(error),
            },
            failed: true,
          });

          for (const change of changes) {
            await hooks?.onFileChange?.(change);
          }
        }
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
}

export default class AgentCapabilityService {
  static async getOwnedSession(sessionUuid: string, userId: string): Promise<AgentSession> {
    const session = await AgentSession.query().findOne({ uuid: sessionUuid, userId });
    if (!session) {
      throw new Error('Agent session not found');
    }

    return session;
  }

  static async resolveSessionContext(
    sessionUuid: string,
    userIdentity: RequestUserIdentity
  ): Promise<{
    session: AgentSession;
    repoFullName?: string;
    approvalPolicy: AgentApprovalPolicy;
  }> {
    const session = await this.getOwnedSession(sessionUuid, userIdentity.userId);
    const repoFullName = resolvePrimaryRepo(session);
    const approvalPolicy = await AgentPolicyService.getEffectivePolicy(repoFullName);

    return {
      session,
      repoFullName,
      approvalPolicy,
    };
  }

  static async buildToolSet({
    session,
    repoFullName,
    userIdentity,
    approvalPolicy,
    workspaceToolDiscoveryTimeoutMs,
    workspaceToolExecutionTimeoutMs,
    hooks,
    toolRules,
  }: {
    session: AgentSession;
    repoFullName?: string;
    userIdentity: RequestUserIdentity;
    approvalPolicy: AgentApprovalPolicy;
    workspaceToolDiscoveryTimeoutMs: number;
    workspaceToolExecutionTimeoutMs: number;
    hooks?: ToolExecutionHooks;
    toolRules?: AgentSessionToolRule[];
  }): Promise<ToolSet> {
    const tools: ToolSet = {};
    if (!repoFullName) {
      return tools;
    }

    const mcpConfigService = new McpConfigService();
    const [repoServers, workspaceGatewayServer] = await Promise.all([
      mcpConfigService.resolveServersForRepo(repoFullName, undefined, userIdentity),
      resolveSessionWorkspaceGatewayServer(session, {
        discoveryTimeoutMs: workspaceToolDiscoveryTimeoutMs,
        executionTimeoutMs: workspaceToolExecutionTimeoutMs,
      }),
    ]);
    const resolvedRepoServers = repoServers.flatMap((server) => {
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
            const mode = resolveToolApprovalMode({
              toolRules,
              toolKey: entry.toolKey,
              capabilityMode: AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey),
            });

            if (mode === 'deny') {
              continue;
            }

            if (entry.toolName === SESSION_WORKSPACE_READONLY_TOOL_NAME) {
              const inputSchema = jsonSchema(discoveredTool.inputSchema as Record<string, unknown>);

              tools[entry.toolKey] = dynamicTool({
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

              continue;
            }

            if (entry.toolName === SESSION_WORKSPACE_MUTATION_TOOL_NAME) {
              const inputSchema = jsonSchema(discoveredTool.inputSchema as Record<string, unknown>);

              tools[entry.toolKey] = dynamicTool({
                description: entry.description,
                inputSchema,
                needsApproval: mode === 'require_approval',
                execute: async (input, context) => {
                  const toolCallId = context?.toolCallId;
                  const audit: AgentToolAuditRecord = {
                    source: 'mcp',
                    serverSlug: server.slug,
                    toolName: entry.toolName,
                    toolCallId,
                    args: (input as Record<string, unknown>) || {},
                    capabilityKey,
                  };

                  await hooks?.onToolStarted?.(audit);

                  const client = new McpClientManager();
                  try {
                    await client.connect(server.transport, server.timeout);
                    const result = await client.callTool(
                      discoveredTool.name,
                      (input as Record<string, unknown>) || {},
                      server.timeout
                    );
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
              hooks,
            });
          }

          continue;
        }

        const capabilityKey = AgentPolicyService.capabilityForExternalMcpTool(
          discoveredTool.name,
          discoveredTool.annotations
        );
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
          hooks,
        });
      }
    }

    return tools;
  }
}
