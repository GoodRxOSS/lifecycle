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
import AgentSessionService from 'server/services/agentSession';
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
import { assertSafeWorkspaceMutationCommand, isReadOnlyWorkspaceCommand } from './sandboxExecSafety';
import { buildProposedFileChanges, buildResultFileChanges, didToolResultFail } from './fileChanges';
import type { AgentFileChangeData } from './types';
import { resolveAgentSessionDurabilityConfig } from 'server/lib/agentSession/runtimeConfig';
import {
  buildAgentToolKey,
  CHAT_PUBLISH_HTTP_TOOL_NAME,
  LIFECYCLE_BUILTIN_SERVER_SLUG,
  SESSION_WORKSPACE_MUTATION_TOOL_NAME,
  SESSION_WORKSPACE_READONLY_TOOL_NAME,
  SESSION_WORKSPACE_SERVER_NAME,
  SESSION_WORKSPACE_SERVER_SLUG,
  buildWorkspaceMutationExecDescription,
  buildWorkspaceReadonlyExecDescription,
} from './toolKeys';
import { getSessionWorkspaceCatalogEntriesForRuntimeTool } from './sandboxToolCatalog';
import { SessionWorkspaceGatewayUnavailableError } from './errors';
import AgentSandboxService from './SandboxService';

type ToolExecutionHooks = {
  onToolStarted?: (audit: AgentToolAuditRecord) => Promise<void>;
  onToolFinished?: (audit: AgentToolAuditRecord & { result: unknown; status: 'completed' | 'failed' }) => Promise<void>;
  onFileChange?: (change: AgentFileChangeData) => Promise<void>;
};

type SessionWorkspaceGatewayTimeouts = {
  discoveryTimeoutMs: number;
  executionTimeoutMs: number;
};

const WORKSPACE_EXEC_RUNTIME_TOOL_NAME = 'workspace.exec';
const WORKSPACE_WRITE_FILE_RUNTIME_TOOL_NAME = 'workspace.write_file';
const WORKSPACE_EDIT_FILE_RUNTIME_TOOL_NAME = 'workspace.edit_file';
const WORKSPACE_EXEC_INPUT_SCHEMA = {
  type: 'object',
  required: ['command'],
  additionalProperties: false,
  properties: {
    command: {
      type: 'string',
      minLength: 1,
      description: 'Command to run with bash -lc',
    },
    cwd: {
      type: 'string',
      description: 'Working directory relative to the workspace',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 120000,
      description: 'Command timeout in milliseconds',
    },
  },
} as const;
const WORKSPACE_WRITE_FILE_INPUT_SCHEMA = {
  type: 'object',
  required: ['path', 'content'],
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      minLength: 1,
      description: 'Workspace-relative file path to write',
    },
    content: {
      type: 'string',
      description: 'Complete file content to write',
    },
  },
} as const;
const WORKSPACE_EDIT_FILE_INPUT_SCHEMA = {
  type: 'object',
  required: ['path', 'oldText', 'newText'],
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      minLength: 1,
      description: 'Workspace-relative file path to edit',
    },
    oldText: {
      type: 'string',
      description: 'Exact existing text to replace',
    },
    newText: {
      type: 'string',
      description: 'Replacement text',
    },
  },
} as const;
const PUBLISH_HTTP_INPUT_SCHEMA = {
  type: 'object',
  required: ['port'],
  additionalProperties: false,
  properties: {
    port: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      description: 'Workspace HTTP port to expose through ingress',
    },
  },
} as const;

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

function isChatWorkspaceRuntimeReady(session: AgentSession): boolean {
  return (
    session.sessionKind === 'chat' &&
    session.status === 'active' &&
    session.workspaceStatus === 'ready' &&
    Boolean(session.namespace) &&
    Boolean(session.podName)
  );
}

async function resolveSessionWorkspaceGatewayServer(
  session: AgentSession,
  timeouts: SessionWorkspaceGatewayTimeouts
): Promise<ResolvedMcpServer | null> {
  const baseUrl =
    (await AgentSandboxService.resolveWorkspaceGatewayBaseUrl(session.uuid)) ||
    resolveSessionWorkspaceGatewayBaseUrl(session);
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

async function loadLatestSession(sessionUuid: string): Promise<AgentSession> {
  const session = await AgentSession.query().findOne({ uuid: sessionUuid });
  if (!session) {
    throw new Error('Agent session not found');
  }

  return session;
}

async function getFileChangePreviewChars(): Promise<number> {
  return (await resolveAgentSessionDurabilityConfig()).fileChangePreviewChars;
}

async function ensureChatWorkspaceRuntime({
  session,
  userIdentity,
  requestGitHubToken,
}: {
  session: AgentSession;
  userIdentity: RequestUserIdentity;
  requestGitHubToken?: string | null;
}): Promise<AgentSession> {
  const latestSession = await loadLatestSession(session.uuid);
  if (latestSession.sessionKind !== 'chat') {
    return latestSession;
  }

  const ensured = await AgentSandboxService.ensureChatSandbox({
    sessionId: latestSession.uuid,
    userId: userIdentity.userId,
    userIdentity,
    githubToken: requestGitHubToken,
  });

  return ensured.session;
}

async function executeWorkspaceRuntimeTool({
  session,
  runtimeToolName,
  input,
  timeoutMs,
  userIdentity,
  requestGitHubToken,
}: {
  session: AgentSession;
  runtimeToolName: string;
  input: Record<string, unknown>;
  timeoutMs: number;
  userIdentity: RequestUserIdentity;
  requestGitHubToken?: string | null;
}) {
  const runtimeSession = await ensureChatWorkspaceRuntime({
    session,
    userIdentity,
    requestGitHubToken,
  });
  const baseUrl =
    (await AgentSandboxService.resolveWorkspaceGatewayBaseUrl(runtimeSession.uuid)) ||
    resolveSessionWorkspaceGatewayBaseUrl(runtimeSession);
  if (!baseUrl) {
    throw new SessionWorkspaceGatewayUnavailableError({
      sessionId: runtimeSession.uuid,
      cause: new Error('Session workspace gateway URL is not available'),
    });
  }

  const client = new McpClientManager();
  try {
    await client.connect({ type: 'http', url: `${baseUrl}/mcp` }, timeoutMs);
    return await client.callTool(runtimeToolName, input, timeoutMs);
  } catch (error) {
    throw new SessionWorkspaceGatewayUnavailableError({
      sessionId: runtimeSession.uuid,
      cause: error,
    });
  } finally {
    await client.close();
  }
}

async function emitResultFileChanges({
  hooks,
  toolCallId,
  sourceTool,
  input,
  result,
  failed,
}: {
  hooks?: ToolExecutionHooks;
  toolCallId?: string;
  sourceTool: string;
  input: Record<string, unknown>;
  result: unknown;
  failed: boolean;
}) {
  if (!toolCallId) {
    return;
  }

  const changes = buildResultFileChanges({
    toolCallId,
    sourceTool,
    input,
    result,
    failed,
    previewChars: await getFileChangePreviewChars(),
  });

  for (const change of changes) {
    await hooks?.onFileChange?.(change);
  }
}

function registerChatWorkspaceExecTool({
  tools,
  session,
  userIdentity,
  approvalPolicy,
  workspaceToolExecutionTimeoutMs,
  requestGitHubToken,
  hooks,
  toolRules,
  toolName,
  capabilityKey,
  description,
  readOnly,
}: {
  tools: ToolSet;
  session: AgentSession;
  userIdentity: RequestUserIdentity;
  approvalPolicy: AgentApprovalPolicy;
  workspaceToolExecutionTimeoutMs: number;
  requestGitHubToken?: string | null;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
  toolName: string;
  capabilityKey: AgentCapabilityKey;
  description: string;
  readOnly: boolean;
}) {
  const toolKey = buildAgentToolKey(SESSION_WORKSPACE_SERVER_SLUG, toolName);
  const mode = resolveToolApprovalMode({
    toolRules,
    toolKey,
    capabilityMode: AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey),
  });

  if (mode === 'deny') {
    return;
  }

  tools[toolKey] = dynamicTool({
    description,
    inputSchema: jsonSchema(WORKSPACE_EXEC_INPUT_SCHEMA),
    needsApproval: mode === 'require_approval',
    execute: async (input, context) => {
      const args = (input as Record<string, unknown>) || {};
      const command = typeof args.command === 'string' ? args.command : '';
      if (readOnly && !isReadOnlyWorkspaceCommand(command)) {
        throw new Error(
          'This command is not a safe read-only inspection command. Use the workspace exec mutation tool for state-changing, networked, or process-managing commands.'
        );
      }
      if (!readOnly) {
        assertSafeWorkspaceMutationCommand(command);
      }

      const toolCallId = context?.toolCallId;
      const audit: AgentToolAuditRecord = {
        source: 'mcp',
        serverSlug: SESSION_WORKSPACE_SERVER_SLUG,
        toolName,
        toolCallId,
        args,
        capabilityKey,
      };

      await hooks?.onToolStarted?.(audit);

      try {
        const runtimeArgs = readOnly ? args : { ...args, captureFileChanges: true };
        const result = await executeWorkspaceRuntimeTool({
          session,
          runtimeToolName: WORKSPACE_EXEC_RUNTIME_TOOL_NAME,
          input: runtimeArgs,
          timeoutMs: workspaceToolExecutionTimeoutMs,
          userIdentity,
          requestGitHubToken,
        });
        const failed = result.isError || didToolResultFail(result);
        if (!readOnly) {
          await emitResultFileChanges({
            hooks,
            toolCallId,
            sourceTool: toolName,
            input: args,
            result,
            failed,
          });
        }
        await hooks?.onToolFinished?.({
          ...audit,
          result,
          status: failed ? 'failed' : 'completed',
        });
        return result;
      } catch (error) {
        getLogger().warn({ error }, `AgentExec: chat workspace tool failed sessionId=${session.uuid} tool=${toolName}`);
        await hooks?.onToolFinished?.({
          ...audit,
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
          status: 'failed',
        });
        throw error;
      }
    },
  });
}

function registerChatWorkspaceFileTool({
  tools,
  session,
  userIdentity,
  approvalPolicy,
  workspaceToolExecutionTimeoutMs,
  requestGitHubToken,
  hooks,
  toolRules,
  toolName,
  inputSchema,
  description,
}: {
  tools: ToolSet;
  session: AgentSession;
  userIdentity: RequestUserIdentity;
  approvalPolicy: AgentApprovalPolicy;
  workspaceToolExecutionTimeoutMs: number;
  requestGitHubToken?: string | null;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
  toolName: string;
  inputSchema: Record<string, unknown>;
  description: string;
}) {
  const toolKey = buildAgentToolKey(SESSION_WORKSPACE_SERVER_SLUG, toolName);
  const capabilityKey: AgentCapabilityKey = 'workspace_write';
  const mode = resolveToolApprovalMode({
    toolRules,
    toolKey,
    capabilityMode: AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey),
  });

  if (mode === 'deny') {
    return;
  }

  tools[toolKey] = dynamicTool({
    description,
    inputSchema: jsonSchema(inputSchema),
    needsApproval: mode === 'require_approval',
    onInputAvailable: async ({ input, toolCallId }) => {
      if (!toolCallId) {
        return;
      }

      const args = (input as Record<string, unknown>) || {};
      const changes = buildProposedFileChanges({
        toolCallId,
        sourceTool: toolName,
        input: args,
        previewChars: await getFileChangePreviewChars(),
      });

      for (const change of changes) {
        await hooks?.onFileChange?.(change);
      }
    },
    execute: async (input, context) => {
      const args = (input as Record<string, unknown>) || {};
      const toolCallId = context?.toolCallId;
      const audit: AgentToolAuditRecord = {
        source: 'mcp',
        serverSlug: SESSION_WORKSPACE_SERVER_SLUG,
        toolName,
        toolCallId,
        args,
        capabilityKey,
      };

      await hooks?.onToolStarted?.(audit);

      try {
        const result = await executeWorkspaceRuntimeTool({
          session,
          runtimeToolName: toolName,
          input: args,
          timeoutMs: workspaceToolExecutionTimeoutMs,
          userIdentity,
          requestGitHubToken,
        });
        const failed = result.isError || didToolResultFail(result);
        if (toolCallId) {
          const changes = buildResultFileChanges({
            toolCallId,
            sourceTool: toolName,
            input: args,
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
        getLogger().warn(
          { error },
          `AgentExec: chat workspace file tool failed sessionId=${session.uuid} tool=${toolName}`
        );
        if (toolCallId) {
          const changes = buildResultFileChanges({
            toolCallId,
            sourceTool: toolName,
            input: args,
            result: {
              error: error instanceof Error ? error.message : String(error),
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
            error: error instanceof Error ? error.message : String(error),
          },
          status: 'failed',
        });
        throw error;
      }
    },
  });
}

function registerChatPublishHttpTool({
  tools,
  session,
  approvalPolicy,
  userIdentity,
  requestGitHubToken,
  hooks,
  toolRules,
}: {
  tools: ToolSet;
  session: AgentSession;
  approvalPolicy: AgentApprovalPolicy;
  userIdentity: RequestUserIdentity;
  requestGitHubToken?: string | null;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
}) {
  const toolKey = buildAgentToolKey(LIFECYCLE_BUILTIN_SERVER_SLUG, CHAT_PUBLISH_HTTP_TOOL_NAME);
  const capabilityKey: AgentCapabilityKey = 'deploy_k8s_mutation';
  const mode = resolveToolApprovalMode({
    toolRules,
    toolKey,
    capabilityMode: AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey),
  });

  if (mode === 'deny') {
    return;
  }

  tools[toolKey] = dynamicTool({
    description:
      'Expose a running HTTP app from the chat workspace through lifecycle-managed ingress and return the reachable URL.',
    inputSchema: jsonSchema(PUBLISH_HTTP_INPUT_SCHEMA),
    needsApproval: mode === 'require_approval',
    execute: async (input, context) => {
      const args = (input as Record<string, unknown>) || {};
      const toolCallId = context?.toolCallId;
      const audit: AgentToolAuditRecord = {
        source: 'mcp',
        serverSlug: LIFECYCLE_BUILTIN_SERVER_SLUG,
        toolName: CHAT_PUBLISH_HTTP_TOOL_NAME,
        toolCallId,
        args,
        capabilityKey,
      };

      await hooks?.onToolStarted?.(audit);

      try {
        const runtimeSession = await ensureChatWorkspaceRuntime({
          session,
          userIdentity,
          requestGitHubToken,
        });
        const port = Number(args.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error('port must be an integer between 1 and 65535');
        }

        const result = await AgentSessionService.publishChatHttpPort({
          sessionId: runtimeSession.uuid,
          userId: userIdentity.userId,
          port,
        });
        await hooks?.onToolFinished?.({
          ...audit,
          result,
          status: 'completed',
        });
        return result;
      } catch (error) {
        getLogger().warn({ error }, `AgentExec: chat publish failed sessionId=${session.uuid}`);
        await hooks?.onToolFinished?.({
          ...audit,
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
          status: 'failed',
        });
        throw error;
      }
    },
  });
}

function registerChatWorkspaceTools({
  tools,
  session,
  userIdentity,
  approvalPolicy,
  workspaceToolExecutionTimeoutMs,
  requestGitHubToken,
  hooks,
  toolRules,
}: {
  tools: ToolSet;
  session: AgentSession;
  userIdentity: RequestUserIdentity;
  approvalPolicy: AgentApprovalPolicy;
  workspaceToolExecutionTimeoutMs: number;
  requestGitHubToken?: string | null;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
}) {
  registerChatWorkspaceExecTool({
    tools,
    session,
    userIdentity,
    approvalPolicy,
    workspaceToolExecutionTimeoutMs,
    requestGitHubToken,
    hooks,
    toolRules,
    toolName: SESSION_WORKSPACE_READONLY_TOOL_NAME,
    capabilityKey: 'read',
    description: buildWorkspaceReadonlyExecDescription(SESSION_WORKSPACE_SERVER_NAME),
    readOnly: true,
  });
  registerChatWorkspaceExecTool({
    tools,
    session,
    userIdentity,
    approvalPolicy,
    workspaceToolExecutionTimeoutMs,
    requestGitHubToken,
    hooks,
    toolRules,
    toolName: SESSION_WORKSPACE_MUTATION_TOOL_NAME,
    capabilityKey: 'shell_exec',
    description: buildWorkspaceMutationExecDescription(SESSION_WORKSPACE_SERVER_NAME),
    readOnly: false,
  });
  registerChatWorkspaceFileTool({
    tools,
    session,
    userIdentity,
    approvalPolicy,
    workspaceToolExecutionTimeoutMs,
    requestGitHubToken,
    hooks,
    toolRules,
    toolName: WORKSPACE_WRITE_FILE_RUNTIME_TOOL_NAME,
    inputSchema: WORKSPACE_WRITE_FILE_INPUT_SCHEMA,
    description:
      'Write a file in the chat workspace. Use this when the user asks to create or replace file contents. This provisions the workspace only when the tool runs.',
  });
  registerChatWorkspaceFileTool({
    tools,
    session,
    userIdentity,
    approvalPolicy,
    workspaceToolExecutionTimeoutMs,
    requestGitHubToken,
    hooks,
    toolRules,
    toolName: WORKSPACE_EDIT_FILE_RUNTIME_TOOL_NAME,
    inputSchema: WORKSPACE_EDIT_FILE_INPUT_SCHEMA,
    description:
      'Edit a file in the chat workspace by replacing exact text. Use this for targeted file modifications. This provisions the workspace only when the tool runs.',
  });
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
        previewChars: await getFileChangePreviewChars(),
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
            previewChars: await getFileChangePreviewChars(),
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
    requestGitHubToken,
    hooks,
    toolRules,
  }: {
    session: AgentSession;
    repoFullName?: string;
    userIdentity: RequestUserIdentity;
    approvalPolicy: AgentApprovalPolicy;
    workspaceToolDiscoveryTimeoutMs: number;
    workspaceToolExecutionTimeoutMs: number;
    requestGitHubToken?: string | null;
    hooks?: ToolExecutionHooks;
    toolRules?: AgentSessionToolRule[];
  }): Promise<ToolSet> {
    const tools: ToolSet = {};
    const chatWorkspaceRuntimeReady = isChatWorkspaceRuntimeReady(session);

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
      });

      registerChatPublishHttpTool({
        tools,
        session,
        approvalPolicy,
        userIdentity,
        requestGitHubToken,
        hooks,
        toolRules,
      });
    }

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
              const inputSchema = jsonSchema(WORKSPACE_EXEC_INPUT_SCHEMA);

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
              const inputSchema = jsonSchema(WORKSPACE_EXEC_INPUT_SCHEMA);

              tools[entry.toolKey] = dynamicTool({
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
