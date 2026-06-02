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
import AgentSessionService from 'server/services/agentSession';
import { SESSION_WORKSPACE_GATEWAY_PORT } from 'server/lib/agentSession/podFactory';
import { McpClientManager } from 'server/services/agentRuntime/mcp/client';
import { usesSessionWorkspaceGatewayExecution } from 'server/services/agentRuntime/mcp/sessionPod';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import AgentPolicyService from './PolicyService';
import type { ResolvedAgentCapabilityAccess } from './PolicyService';
import type { AgentApprovalPolicy, AgentCapabilityKey, AgentToolAuditRecord } from './types';
import type { AgentCapabilityCatalogId } from './capabilityCatalog';
import type { ResolvedMcpServer } from 'server/services/agentRuntime/mcp/types';
import { assertSafeWorkspaceMutationCommand, isReadOnlyWorkspaceCommand } from './sandboxExecSafety';
import { buildProposedFileChanges, buildResultFileChanges, didToolResultFail } from './fileChanges';
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
import { SessionWorkspaceGatewayUnavailableError } from './errors';
import AgentSandboxService from './SandboxService';
import type { AgentRuntimeToolMetadata } from './toolMetadata';
import {
  isCatalogCapabilityAllowed,
  recordToolMetadata,
  resolveToolApprovalMode,
  toAiDynamicTool,
  toAiJsonSchema,
  type ToolExecutionHooks,
} from './capabilityToolHelpers';
import { loadLatestSession } from './capabilitySessionContext';

type SessionWorkspaceGatewayTimeouts = {
  discoveryTimeoutMs: number;
  executionTimeoutMs: number;
};

const WORKSPACE_EXEC_RUNTIME_TOOL_NAME = 'workspace.exec';
const WORKSPACE_WRITE_FILE_RUNTIME_TOOL_NAME = 'workspace.write_file';
const WORKSPACE_EDIT_FILE_RUNTIME_TOOL_NAME = 'workspace.edit_file';
export const WORKSPACE_EXEC_INPUT_SCHEMA = {
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

function resolveSessionWorkspaceGatewayBaseUrl(session: AgentSession): string | null {
  if (!session.podName || !session.namespace || session.status !== 'active') {
    return null;
  }

  return `http://${session.podName}.${session.namespace}.svc.cluster.local:${SESSION_WORKSPACE_GATEWAY_PORT}`;
}

export function isChatWorkspaceRuntimeReady(session: AgentSession): boolean {
  return (
    session.sessionKind === 'chat' &&
    session.status === 'active' &&
    session.workspaceStatus === 'ready' &&
    Boolean(session.namespace) &&
    Boolean(session.podName)
  );
}

export async function resolveSessionWorkspaceGatewayServer(
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
      scope: 'session',
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

export function resolveSessionExecutionServer(
  session: AgentSession,
  server: ResolvedMcpServer
): ResolvedMcpServer | null {
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

export async function getFileChangePreviewChars(): Promise<number> {
  return (await resolveAgentSessionDurabilityConfig()).fileChangePreviewChars;
}

async function ensureChatWorkspaceRuntime({
  session,
  userIdentity,
  requestGitHubToken,
  allowedActiveRunUuid,
}: {
  session: AgentSession;
  userIdentity: RequestUserIdentity;
  requestGitHubToken?: string | null;
  allowedActiveRunUuid?: string | null;
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
    ...(allowedActiveRunUuid ? { allowedActiveRunUuid } : {}),
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
  allowedActiveRunUuid,
}: {
  session: AgentSession;
  runtimeToolName: string;
  input: Record<string, unknown>;
  timeoutMs: number;
  userIdentity: RequestUserIdentity;
  requestGitHubToken?: string | null;
  allowedActiveRunUuid?: string | null;
}) {
  const runtimeSession = await ensureChatWorkspaceRuntime({
    session,
    userIdentity,
    requestGitHubToken,
    allowedActiveRunUuid,
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

export async function emitResultFileChanges({
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
  catalogCapabilityId,
  resolvedCapabilityAccess,
  toolMetadata,
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
  catalogCapabilityId: AgentCapabilityCatalogId;
  resolvedCapabilityAccess?: ResolvedAgentCapabilityAccess[];
  toolMetadata?: AgentRuntimeToolMetadata[];
}) {
  if (!isCatalogCapabilityAllowed(resolvedCapabilityAccess, catalogCapabilityId)) {
    return;
  }

  const toolKey = buildAgentToolKey(SESSION_WORKSPACE_SERVER_SLUG, toolName);
  const mode = resolveToolApprovalMode({
    toolRules,
    toolKey,
    capabilityMode: AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey),
  });

  if (mode === 'deny') {
    return;
  }

  tools[toolKey] = toAiDynamicTool({
    description,
    inputSchema: toAiJsonSchema(WORKSPACE_EXEC_INPUT_SCHEMA),
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
          allowedActiveRunUuid: hooks?.getActiveRunUuid?.() ?? null,
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
  recordToolMetadata(toolMetadata, {
    toolKey,
    catalogCapabilityId,
    capabilityKey,
    approvalMode: mode,
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
  catalogCapabilityId,
  resolvedCapabilityAccess,
  toolMetadata,
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
  catalogCapabilityId: AgentCapabilityCatalogId;
  resolvedCapabilityAccess?: ResolvedAgentCapabilityAccess[];
  toolMetadata?: AgentRuntimeToolMetadata[];
}) {
  if (!isCatalogCapabilityAllowed(resolvedCapabilityAccess, catalogCapabilityId)) {
    return;
  }

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

  tools[toolKey] = toAiDynamicTool({
    description,
    inputSchema: toAiJsonSchema(inputSchema),
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
          allowedActiveRunUuid: hooks?.getActiveRunUuid?.() ?? null,
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
  recordToolMetadata(toolMetadata, {
    toolKey,
    catalogCapabilityId,
    capabilityKey,
    approvalMode: mode,
  });
}

export function registerChatPublishHttpTool({
  tools,
  session,
  approvalPolicy,
  userIdentity,
  requestGitHubToken,
  hooks,
  toolRules,
  resolvedCapabilityAccess,
  toolMetadata,
}: {
  tools: ToolSet;
  session: AgentSession;
  approvalPolicy: AgentApprovalPolicy;
  userIdentity: RequestUserIdentity;
  requestGitHubToken?: string | null;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
  resolvedCapabilityAccess?: ResolvedAgentCapabilityAccess[];
  toolMetadata?: AgentRuntimeToolMetadata[];
}) {
  const toolKey = buildAgentToolKey(LIFECYCLE_BUILTIN_SERVER_SLUG, CHAT_PUBLISH_HTTP_TOOL_NAME);
  if (!isCatalogCapabilityAllowed(resolvedCapabilityAccess, 'preview_publish')) {
    return;
  }

  const capabilityKey: AgentCapabilityKey = 'deploy_k8s_mutation';
  const mode = resolveToolApprovalMode({
    toolRules,
    toolKey,
    capabilityMode: AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey),
  });

  if (mode === 'deny') {
    return;
  }

  tools[toolKey] = toAiDynamicTool({
    description:
      'Expose a running HTTP app from the chat workspace through lifecycle-managed ingress and return the reachable URL.',
    inputSchema: toAiJsonSchema(PUBLISH_HTTP_INPUT_SCHEMA),
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
          allowedActiveRunUuid: hooks?.getActiveRunUuid?.() ?? null,
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
  recordToolMetadata(toolMetadata, {
    toolKey,
    catalogCapabilityId: 'preview_publish',
    capabilityKey,
    approvalMode: mode,
  });
}

export function registerChatWorkspaceTools({
  tools,
  session,
  userIdentity,
  approvalPolicy,
  workspaceToolExecutionTimeoutMs,
  requestGitHubToken,
  hooks,
  toolRules,
  resolvedCapabilityAccess,
  toolMetadata,
}: {
  tools: ToolSet;
  session: AgentSession;
  userIdentity: RequestUserIdentity;
  approvalPolicy: AgentApprovalPolicy;
  workspaceToolExecutionTimeoutMs: number;
  requestGitHubToken?: string | null;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
  resolvedCapabilityAccess?: ResolvedAgentCapabilityAccess[];
  toolMetadata?: AgentRuntimeToolMetadata[];
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
    catalogCapabilityId: 'read_context',
    resolvedCapabilityAccess,
    toolMetadata,
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
    catalogCapabilityId: 'workspace_shell',
    resolvedCapabilityAccess,
    toolMetadata,
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
    catalogCapabilityId: 'workspace_files',
    resolvedCapabilityAccess,
    toolMetadata,
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
    catalogCapabilityId: 'workspace_files',
    resolvedCapabilityAccess,
    toolMetadata,
  });
}
