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
import type { ResolvedMcpServer } from 'server/services/agentRuntime/mcp/types';
import { usesSessionWorkspaceGatewayExecution } from 'server/services/agentRuntime/mcp/sessionPod';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import type { CapabilityPolicyConfig, CustomAgentCreationPolicyConfig } from 'server/services/types/agentRuntimeConfig';
import AgentPolicyService from './PolicyService';
import type { ResolvedAgentCapabilityAccess } from './PolicyService';
import type { AgentApprovalPolicy } from './types';
import type { AgentCapabilityCatalogId } from './capabilityCatalog';
import AgentRuntimeConfigService from 'server/services/agentRuntime/config/agentRuntimeConfig';
import { buildAgentToolKey } from './toolKeys';
import { registerLifecycleDiagnosticFixTools, registerLifecycleDiagnosticReadTools } from './diagnosticTools';
import type { AgentRuntimeToolMetadata } from './toolMetadata';
import {
  configureAiToolFactories,
  type AgentRuntimeToolApprovalConfig,
  isCatalogCapabilityAllowed,
  resolveToolApprovalMode,
  selectedMcpConnectionRefs,
  type ToolExecutionHooks,
} from './capabilityToolHelpers';
import { resolveLifecycleDiagnosticGithubSafety, resolvePrimaryRepo } from './capabilitySessionContext';
import {
  isChatWorkspaceRuntimeReady,
  registerChatRequestWorkspaceTool,
  resolveSessionExecutionServer,
  resolveSessionGatewayEndpoint,
  resolveSessionWorkspaceGatewayServer,
  type WorkspaceToolDiscoveryMode,
} from './chatWorkspaceToolRegistration';
import { registerGenericMcpTool } from './mcpToolRegistration';
import { isWorkspaceCoreMcpEnabled } from 'server/services/workspaceCoreMcp/config';
import { registerWorkspaceCoreTools } from 'server/services/workspaceCoreMcp/registration';
import { loadAiSdk } from './aiSdkRuntime';
import { buildAgentRuntimeToolsContext, type AgentRuntimeToolsContext } from './runtimeContext';
import type { AgentRequestGitHubAuth } from './githubAuth';
import type { DiagnosticGitHubApprovalAuthResolver } from './tools/shared/githubClient';

export type { AgentRuntimeToolMetadata } from './toolMetadata';

// Dynamic import (SandboxService pattern): agentSession imports from this directory, so a static
// import would be circular. Never throws — reconciliation is best-effort on an already-failing path.
async function reconcileLostChatWorkspace(
  session: AgentSession,
  hooks?: ToolExecutionHooks
): Promise<AgentSession | null> {
  let allowedActiveRunUuid: string | null = null;
  try {
    allowedActiveRunUuid = hooks?.getActiveRunUuid?.() ?? null;
  } catch {
    // Tool build can run before the executor has a run row; the claim just loses its run exemption.
  }
  try {
    const AgentSessionService = (await import('server/services/agentSession')).default;
    return await AgentSessionService.reconcileLostChatWorkspaceRuntime(session.uuid, { allowedActiveRunUuid });
  } catch (error) {
    getLogger().warn(
      { error, sessionId: session.uuid },
      `AgentExec: workspace loss reconcile errored sessionId=${session.uuid}`
    );
    return null;
  }
}

type BuildToolSetOptions = {
  session: AgentSession;
  repoFullName?: string;
  userIdentity: RequestUserIdentity;
  approvalPolicy: AgentApprovalPolicy;
  workspaceToolDiscoveryTimeoutMs: number;
  workspaceToolExecutionTimeoutMs: number;
  workspaceToolDiscoveryMode?: WorkspaceToolDiscoveryMode;
  requestGitHubToken?: string | null;
  requestGitHubAuth?: AgentRequestGitHubAuth | null;
  resolveApprovalGitHubAuth?: DiagnosticGitHubApprovalAuthResolver;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
  resolvedCapabilityAccess?: ResolvedAgentCapabilityAccess[];
  selectedRuntimeMcpConnectionRefs?: string[];
  autoProvisionWorkspace?: boolean;
  agentDefinitionId?: string;
  agentSourceKind?: string;
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
    workspaceToolDiscoveryMode,
    requestGitHubToken,
    requestGitHubAuth,
    resolveApprovalGitHubAuth,
    hooks,
    toolRules,
    resolvedCapabilityAccess,
    selectedRuntimeMcpConnectionRefs,
    autoProvisionWorkspace = true,
    agentDefinitionId,
    agentSourceKind,
  }: BuildToolSetOptions): Promise<{
    tools: ToolSet;
    metadata: AgentRuntimeToolMetadata[];
    toolApproval: AgentRuntimeToolApprovalConfig;
    toolsContext: AgentRuntimeToolsContext;
    workspaceRuntimeReady: boolean;
  }> {
    configureAiToolFactories(await loadAiSdk());
    const tools: ToolSet = {};
    const metadata: AgentRuntimeToolMetadata[] = [];
    const toolApproval: AgentRuntimeToolApprovalConfig = {};
    let runtimeSession = session;
    let chatWorkspaceRuntimeReady = isChatWorkspaceRuntimeReady(runtimeSession);
    const workspaceCoreEnabled =
      isWorkspaceCoreMcpEnabled() && agentDefinitionId !== 'system.debug' && agentSourceKind !== 'build_context_chat';
    const effectiveAgentConfig = await AgentRuntimeConfigService.getInstance().getEffectiveConfig(repoFullName);
    const lifecycleDiagnosticGithubSafety = session.buildUuid
      ? await resolveLifecycleDiagnosticGithubSafety({
          session,
          repoFullName,
          config: effectiveAgentConfig,
        })
      : undefined;

    // Registered for every chat run, ready or not: it is an instant no-op on a live workspace, and it is
    // the recovery path when the workspace is lost mid-run (a tool set is fixed once the stream starts).
    if (session.sessionKind === 'chat' && workspaceCoreEnabled) {
      registerChatRequestWorkspaceTool({
        tools,
        session,
        userIdentity,
        approvalPolicy,
        requestGitHubToken,
        hooks,
        toolRules,
        autoProvisionWorkspace,
        resolvedCapabilityAccess,
        toolMetadata: metadata,
        toolApproval,
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
      requestGitHubAuth,
      resolveApprovalGitHubAuth,
      toolMetadata: metadata,
      toolApproval,
    });
    registerLifecycleDiagnosticFixTools({
      tools,
      session,
      approvalPolicy,
      hooks,
      toolRules,
      resolvedCapabilityAccess,
      githubSafety: lifecycleDiagnosticGithubSafety,
      requestGitHubAuth,
      resolveApprovalGitHubAuth,
      toolMetadata: metadata,
      toolApproval,
    });

    const mcpConfigService = new McpConfigService();
    const [repoServers, workspaceGatewayServer] = await Promise.all([
      mcpConfigService.resolveServers(repoFullName, undefined, userIdentity),
      session.sessionKind === 'chat' && !chatWorkspaceRuntimeReady
        ? Promise.resolve(null)
        : resolveSessionWorkspaceGatewayServer(
            session,
            {
              discoveryTimeoutMs: workspaceToolDiscoveryTimeoutMs,
              executionTimeoutMs: workspaceToolExecutionTimeoutMs,
            },
            { discoveryMode: workspaceToolDiscoveryMode }
          ).catch(async (error) => {
            // isChatWorkspaceRuntimeReady is status-based, so a chat can report ready before the gateway
            // is actually reachable (pod just started/attached). Throwing here would abort the whole tool
            // build and leave the model with zero tools (not even request_workspace) — the "no tools on
            // the first message" failure. Degrade to null for chats so base tools still register and
            // workspace tools resolve lazily once the gateway responds. Environment/workspace sessions
            // still fail loudly: the workspace IS the session there.
            if (session.sessionKind !== 'chat') {
              throw error;
            }
            getLogger().warn(
              { error, sessionId: session.uuid },
              `AgentExec: chat workspace gateway discovery failed during tool build; degrading to base tools sessionId=${session.uuid}`
            );
            // The unreachable gateway may mean the runtime is gone, not restarting: reconcile against the
            // provider/cluster so a confirmed loss settles now and this run builds against the real state.
            const settled = await reconcileLostChatWorkspace(session, hooks);
            if (settled) {
              runtimeSession = settled;
            }
            return null;
          }),
    ]);
    chatWorkspaceRuntimeReady = isChatWorkspaceRuntimeReady(runtimeSession);
    const selectedRuntimeMcpRefs = selectedMcpConnectionRefs(selectedRuntimeMcpConnectionRefs);
    const selectedRepoServers = selectedRuntimeMcpRefs
      ? repoServers.filter((server) => selectedRuntimeMcpRefs.has(`${server.scope}:${server.slug}`))
      : repoServers;
    // Resolve the session-scoped gateway endpoint once; per-server resolution would issue N parallel lookups.
    const gatewayEndpoint =
      workspaceGatewayServer &&
      selectedRepoServers.some((server) => usesSessionWorkspaceGatewayExecution(server.transport))
        ? await resolveSessionGatewayEndpoint(session)
        : null;
    const resolvedRepoServers = (
      await Promise.all(
        selectedRepoServers.map(async (server) => {
          if (!usesSessionWorkspaceGatewayExecution(server.transport)) {
            return server;
          }

          if (!workspaceGatewayServer) {
            getLogger().warn(
              `AgentExec: workspace gateway unavailable sessionId=${session.uuid} server=${server.slug}`
            );
            return null;
          }

          const routedServer = await resolveSessionExecutionServer(session, server, gatewayEndpoint);
          if (!routedServer) {
            getLogger().warn(
              `AgentExec: workspace gateway route unresolved sessionId=${session.uuid} server=${server.slug}`
            );
            return null;
          }

          return routedServer;
        })
      )
    ).filter((server): server is ResolvedMcpServer => Boolean(server));
    const resolvedServers = resolvedRepoServers;

    if (workspaceCoreEnabled) {
      registerWorkspaceCoreTools({
        tools,
        session,
        userIdentity,
        approvalPolicy,
        workspaceGatewayServer,
        resolveWorkspaceGatewayServer: async () => {
          const latestSession = await AgentSession.query().findOne({ uuid: session.uuid });
          if (!latestSession || !isChatWorkspaceRuntimeReady(latestSession)) {
            return null;
          }

          try {
            return await resolveSessionWorkspaceGatewayServer(latestSession, {
              discoveryTimeoutMs: workspaceToolDiscoveryTimeoutMs,
              executionTimeoutMs: workspaceToolExecutionTimeoutMs,
            });
          } catch (error) {
            // Mid-run loss: a confirmed-gone runtime settles here, so request_workspace (always
            // registered for chats) can recover in this same run and the next run reclassifies.
            await reconcileLostChatWorkspace(latestSession, hooks);
            throw error;
          }
        },
        workspaceToolExecutionTimeoutMs,
        hooks,
        toolRules,
        resolvedCapabilityAccess,
        toolMetadata: metadata,
        toolApproval,
      });
    }

    for (const server of resolvedServers) {
      for (const discoveredTool of server.discoveredTools) {
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
          toolApproval,
        });
      }
    }

    return {
      tools,
      metadata,
      toolApproval,
      toolsContext: buildAgentRuntimeToolsContext(metadata),
      workspaceRuntimeReady: chatWorkspaceRuntimeReady,
    };
  }
}
