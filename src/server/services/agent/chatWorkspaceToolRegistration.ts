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
import { SESSION_WORKSPACE_GATEWAY_PORT } from 'server/lib/agentSession/podFactory';
import { McpClientManager } from 'server/services/agentRuntime/mcp/client';
import { usesSessionWorkspaceGatewayExecution } from 'server/services/agentRuntime/mcp/sessionPod';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import AgentPolicyService from './PolicyService';
import type { ResolvedAgentCapabilityAccess } from './PolicyService';
import type { AgentApprovalPolicy, AgentCapabilityKey, AgentToolAuditRecord } from './types';
import type { ResolvedMcpServer } from 'server/services/agentRuntime/mcp/types';
import { resolveAgentSessionDurabilityConfig } from 'server/lib/agentSession/runtimeConfig';
import { buildAgentToolKey, CHAT_REQUEST_WORKSPACE_TOOL_NAME, LIFECYCLE_BUILTIN_SERVER_SLUG } from './toolKeys';
import { SessionWorkspaceGatewayUnavailableError } from './errors';
import AgentSandboxService, { type WorkspaceRuntimeEndpoint } from './SandboxService';
import {
  buildWorkspaceGatewayContractFailureMessage,
  findMissingWorkspaceGatewayTools,
} from 'server/services/workspaceRuntime/gatewayContract';
import type { AgentRuntimeToolMetadata } from './toolMetadata';
import {
  isCatalogCapabilityAllowed,
  recordToolApproval,
  recordToolMetadata,
  resolveToolApprovalMode,
  toAiDynamicTool,
  toAiJsonSchema,
  toAiRuntimeToolContextSchema,
  type AgentRuntimeToolApprovalConfig,
  type ToolExecutionHooks,
} from './capabilityToolHelpers';
import { loadLatestSession } from './capabilitySessionContext';
import { buildAgentRuntimeToolContextFromMetadataInput, resolveAgentRuntimeToolContext } from './runtimeContext';

type SessionWorkspaceGatewayTimeouts = {
  discoveryTimeoutMs: number;
  executionTimeoutMs: number;
};

export type WorkspaceToolDiscoveryMode = 'live' | 'prefer_cached';

// Keyed on session + pod + status + endpoint, so any workspace transition self-invalidates.
// Only approval resumes read it (moments after the pausing run discovered live); everything else stays live.
const GATEWAY_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const gatewayDiscoveryCache = new Map<
  string,
  { discoveredTools: ResolvedMcpServer['discoveredTools']; cachedAt: number }
>();

function gatewayDiscoveryCacheKey(session: AgentSession, endpointUrl: string): string {
  return [
    session.uuid,
    session.workspaceStatus || '',
    session.podName || '',
    session.namespace || '',
    endpointUrl,
  ].join('|');
}

function readCachedGatewayDiscovery(key: string): ResolvedMcpServer['discoveredTools'] | null {
  const cached = gatewayDiscoveryCache.get(key);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.cachedAt > GATEWAY_DISCOVERY_CACHE_TTL_MS) {
    gatewayDiscoveryCache.delete(key);
    return null;
  }
  return cached.discoveredTools;
}

function writeCachedGatewayDiscovery(key: string, discoveredTools: ResolvedMcpServer['discoveredTools']): void {
  for (const [existingKey, entry] of gatewayDiscoveryCache) {
    if (Date.now() - entry.cachedAt > GATEWAY_DISCOVERY_CACHE_TTL_MS) {
      gatewayDiscoveryCache.delete(existingKey);
    }
  }
  gatewayDiscoveryCache.set(key, { discoveredTools, cachedAt: Date.now() });
}

const REQUEST_WORKSPACE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      description: 'Short reason the task needs a workspace.',
    },
    timeout_ms: {
      type: 'integer',
      minimum: 1000,
      maximum: 1800000,
      description: 'Maximum time to wait for the workspace to become ready.',
    },
  },
} as const;
const REQUEST_WORKSPACE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_WORKSPACE_POLL_MS = 1000;

function readWorkspaceRequestReason(args: Record<string, unknown>): string | null {
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  return reason || null;
}

function readRequestWorkspaceTimeoutMs(args: Record<string, unknown>): number {
  const raw = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
  if (!Number.isFinite(raw) || !raw) {
    return REQUEST_WORKSPACE_DEFAULT_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.trunc(raw), 1000), 30 * 60 * 1000);
}

function isWaitableWorkspaceRequestError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  const reason = 'reason' in error ? (error as { reason?: unknown }).reason : undefined;
  return (
    message.includes('already provisioning') ||
    message.includes('workspace action to finish') ||
    reason === 'action_in_progress'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinGatewayPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function resolveSessionWorkspaceGatewayEndpoint(session: AgentSession): WorkspaceRuntimeEndpoint | null {
  if (!session.podName || !session.namespace || session.status !== 'active') {
    return null;
  }

  return {
    url: `http://${session.podName}.${session.namespace}.svc.cluster.local:${SESSION_WORKSPACE_GATEWAY_PORT}`,
  };
}

export async function resolveSessionGatewayEndpoint(session: AgentSession): Promise<WorkspaceRuntimeEndpoint | null> {
  try {
    return (
      (await AgentSandboxService.resolveWorkspaceGatewayEndpoint(session.uuid)) ||
      resolveSessionWorkspaceGatewayEndpoint(session)
    );
  } catch (error) {
    // A gateway-token decryption failure (ENCRYPTION_KEY rotation/loss) must surface as the standard
    // gateway-unavailable tool error (decrypt hint preserved on the cause), not an unclassified throw
    // on the hot tool path — only the typed error records the session runtime failure downstream.
    throw new SessionWorkspaceGatewayUnavailableError({ sessionId: session.uuid, cause: error });
  }
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
  timeouts: SessionWorkspaceGatewayTimeouts,
  options: { discoveryMode?: WorkspaceToolDiscoveryMode } = {}
): Promise<ResolvedMcpServer | null> {
  const endpoint = await resolveSessionGatewayEndpoint(session);
  if (!endpoint) {
    return null;
  }

  const url = joinGatewayPath(endpoint.url, '/mcp');
  const transport = { type: 'http' as const, url, ...(endpoint.headers ? { headers: endpoint.headers } : {}) };
  const buildServer = (discoveredTools: ResolvedMcpServer['discoveredTools']): ResolvedMcpServer => ({
    scope: 'session',
    slug: 'sandbox',
    name: 'Session Workspace',
    transport,
    timeout: timeouts.executionTimeoutMs,
    defaultArgs: {},
    env: {},
    discoveredTools,
  });

  const cacheKey = gatewayDiscoveryCacheKey(session, url);
  if (options.discoveryMode === 'prefer_cached') {
    const cachedTools = readCachedGatewayDiscovery(cacheKey);
    if (cachedTools) {
      return buildServer(cachedTools);
    }
  }

  const client = new McpClientManager();

  try {
    await client.connect(transport, timeouts.discoveryTimeoutMs);
    const discoveredTools = await client.listTools(timeouts.discoveryTimeoutMs);
    const missingGatewayTools = findMissingWorkspaceGatewayTools(discoveredTools.map((tool) => tool.name));
    if (missingGatewayTools.length > 0) {
      throw new Error(buildWorkspaceGatewayContractFailureMessage(missingGatewayTools));
    }

    writeCachedGatewayDiscovery(cacheKey, discoveredTools);
    return buildServer(discoveredTools);
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

export async function resolveSessionExecutionServer(
  session: AgentSession,
  server: ResolvedMcpServer,
  // Callers routing many servers should resolve the session-scoped endpoint once and pass it in.
  gatewayEndpoint?: WorkspaceRuntimeEndpoint | null
): Promise<ResolvedMcpServer | null> {
  if (!usesSessionWorkspaceGatewayExecution(server.transport)) {
    return server;
  }

  const endpoint = gatewayEndpoint !== undefined ? gatewayEndpoint : await resolveSessionGatewayEndpoint(session);
  if (!endpoint) {
    return null;
  }

  return {
    ...server,
    transport: {
      type: 'http',
      url: joinGatewayPath(endpoint.url, `/servers/${encodeURIComponent(server.slug)}/mcp`),
      ...(endpoint.headers ? { headers: endpoint.headers } : {}),
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

async function waitForChatWorkspaceRequest({
  session,
  userIdentity,
  requestGitHubToken,
  allowedActiveRunUuid,
  timeoutMs,
}: {
  session: AgentSession;
  userIdentity: RequestUserIdentity;
  requestGitHubToken?: string | null;
  allowedActiveRunUuid?: string | null;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  let lastError: string | null = null;

  try {
    const runtimeSession = await ensureChatWorkspaceRuntime({
      session,
      userIdentity,
      requestGitHubToken,
      allowedActiveRunUuid,
    });
    if (isChatWorkspaceRuntimeReady(runtimeSession)) {
      return {
        status: 'ready' as const,
        workspaceStatus: runtimeSession.workspaceStatus,
        message: 'Workspace is ready. Use workspace_core tools for commands, files, git, and previews.',
      };
    }
    if (runtimeSession.workspaceStatus === 'failed' || runtimeSession.status === 'error') {
      return {
        status: 'failed' as const,
        workspaceStatus: runtimeSession.workspaceStatus,
        message: 'Workspace failed to become ready.',
      };
    }
  } catch (error) {
    lastError = readErrorMessage(error);
    if (!isWaitableWorkspaceRequestError(error)) {
      return {
        status: 'failed' as const,
        workspaceStatus: 'failed',
        message: lastError,
      };
    }
  }

  while (Date.now() - startedAt < timeoutMs) {
    const latestSession = await loadLatestSession(session.uuid);
    if (isChatWorkspaceRuntimeReady(latestSession)) {
      return {
        status: 'ready' as const,
        workspaceStatus: latestSession.workspaceStatus,
        message: 'Workspace is ready. Use workspace_core tools for commands, files, git, and previews.',
      };
    }
    if (
      latestSession.workspaceStatus === 'failed' ||
      latestSession.status === 'error' ||
      latestSession.status === 'archived'
    ) {
      return {
        status: 'failed' as const,
        workspaceStatus: latestSession.workspaceStatus,
        message: 'Workspace failed to become ready.',
      };
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt);
    await sleep(Math.min(REQUEST_WORKSPACE_POLL_MS, Math.max(remainingMs, 0)));
  }

  return {
    status: 'timed_out' as const,
    workspaceStatus: (await loadLatestSession(session.uuid)).workspaceStatus,
    message: lastError
      ? `Workspace did not become ready before timeout. Last status: ${lastError}`
      : 'Workspace did not become ready before timeout.',
  };
}

export function registerChatRequestWorkspaceTool({
  tools,
  session,
  userIdentity,
  approvalPolicy,
  requestGitHubToken,
  hooks,
  toolRules,
  autoProvisionWorkspace,
  resolvedCapabilityAccess,
  toolMetadata,
  toolApproval,
}: {
  tools: ToolSet;
  session: AgentSession;
  userIdentity: RequestUserIdentity;
  approvalPolicy: AgentApprovalPolicy;
  requestGitHubToken?: string | null;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
  autoProvisionWorkspace: boolean;
  resolvedCapabilityAccess?: ResolvedAgentCapabilityAccess[];
  toolMetadata?: AgentRuntimeToolMetadata[];
  toolApproval?: AgentRuntimeToolApprovalConfig;
}) {
  if (session.sessionKind !== 'chat') {
    return;
  }
  if (!isCatalogCapabilityAllowed(resolvedCapabilityAccess, 'read_context')) {
    return;
  }

  const toolKey = buildAgentToolKey(LIFECYCLE_BUILTIN_SERVER_SLUG, CHAT_REQUEST_WORKSPACE_TOOL_NAME);
  const capabilityKey: AgentCapabilityKey = 'read';
  const mode = resolveToolApprovalMode({
    toolRules,
    toolKey,
    capabilityMode: AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey),
  });

  if (mode === 'deny') {
    return;
  }

  const requiresApproval = mode === 'require_approval' || !autoProvisionWorkspace;
  const metadataInput = {
    toolKey,
    serverSlug: LIFECYCLE_BUILTIN_SERVER_SLUG,
    sourceToolName: CHAT_REQUEST_WORKSPACE_TOOL_NAME,
    catalogCapabilityId: 'read_context' as const,
    capabilityKey,
    approvalMode: requiresApproval ? ('require_approval' as const) : ('allow' as const),
  };
  const fallbackToolContext = buildAgentRuntimeToolContextFromMetadataInput(metadataInput);

  tools[toolKey] = toAiDynamicTool({
    description:
      'Request a Lifecycle workspace for this chat when the task genuinely needs commands, file edits, git, previews, or editor access. ' +
      'Returns only after the workspace is ready, failed, or timed out. After a ready result, use workspace_core tools in this same run.',
    inputSchema: toAiJsonSchema(REQUEST_WORKSPACE_INPUT_SCHEMA),
    contextSchema: toAiRuntimeToolContextSchema(),
    execute: async (input, context) => {
      const runtimeToolContext = resolveAgentRuntimeToolContext(context?.context, fallbackToolContext);
      const args = (input as Record<string, unknown>) || {};
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

      const result = await waitForChatWorkspaceRequest({
        session,
        userIdentity,
        requestGitHubToken,
        allowedActiveRunUuid: hooks?.getActiveRunUuid?.() ?? null,
        timeoutMs: readRequestWorkspaceTimeoutMs(args),
      });
      const toolResult = {
        ...result,
        workspace_status: result.workspaceStatus,
        reason: readWorkspaceRequestReason(args),
      };
      await hooks?.onToolFinished?.({
        ...audit,
        result: toolResult,
        status: result.status === 'ready' ? 'completed' : 'failed',
      });
      return toolResult;
    },
  });
  recordToolMetadata(toolMetadata, metadataInput);
  recordToolApproval(toolApproval, {
    toolKey,
    mode: requiresApproval ? 'require_approval' : 'allow',
  });
}
