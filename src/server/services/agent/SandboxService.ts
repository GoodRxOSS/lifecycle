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

import AgentSandbox from 'server/models/AgentSandbox';
import AgentSandboxExposure from 'server/models/AgentSandboxExposure';
import AgentSession from 'server/models/AgentSession';
import type { RequestUserIdentity } from 'server/lib/get-user';
import type { Transaction } from 'objection';
import type { ResolvedAgentSessionWorkspaceStorageIntent } from 'server/lib/agentSession/runtimeConfig';

const SESSION_WORKSPACE_GATEWAY_PORT = parseInt(process.env.AGENT_SESSION_WORKSPACE_GATEWAY_PORT || '13338', 10);

function mapSessionToSandboxStatus(session: AgentSession): AgentSandbox['status'] {
  if (session.status === 'ended' || session.workspaceStatus === 'ended') {
    return 'ended';
  }

  if (session.workspaceStatus === 'failed' || session.status === 'error') {
    return 'failed';
  }

  if (session.workspaceStatus === 'hibernated') {
    return 'suspended';
  }

  if (session.workspaceStatus === 'provisioning') {
    return 'provisioning';
  }

  return 'ready';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildProviderState(
  session: AgentSession,
  workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent,
  existingProviderState?: Record<string, unknown>
): Record<string, unknown> {
  const existingWorkspaceStorage = isRecord(existingProviderState?.workspaceStorage)
    ? existingProviderState.workspaceStorage
    : undefined;

  return {
    ...(session.namespace ? { namespace: session.namespace } : {}),
    ...(session.podName ? { podName: session.podName } : {}),
    ...(session.pvcName ? { pvcName: session.pvcName } : {}),
    ...(workspaceStorage
      ? {
          workspaceStorage: {
            size: workspaceStorage.storageSize,
            accessMode: workspaceStorage.accessMode,
            ...(session.pvcName ? { pvcName: session.pvcName } : {}),
          },
        }
      : existingWorkspaceStorage
      ? { workspaceStorage: existingWorkspaceStorage }
      : {}),
  };
}

function toTimestampString(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return typeof value === 'string' ? value : null;
}

export default class AgentSandboxService {
  static async getLatestSandboxForSession(
    sessionId: number,
    options: { trx?: Transaction } = {}
  ): Promise<AgentSandbox | null> {
    return AgentSandbox.query(options.trx)
      .where({ sessionId })
      .orderBy('generation', 'desc')
      .orderBy('createdAt', 'desc')
      .first();
  }

  static async recordSessionSandboxState(
    session: AgentSession,
    options: { trx?: Transaction; workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent } = {}
  ): Promise<AgentSandbox | null> {
    if (!session.namespace && !session.podName && !session.pvcName) {
      return this.getLatestSandboxForSession(session.id, options);
    }

    const existing = await this.getLatestSandboxForSession(session.id, options);
    const sandbox = existing
      ? await AgentSandbox.query(options.trx).patchAndFetchById(existing.id, {
          provider: 'lifecycle_kubernetes',
          status: mapSessionToSandboxStatus(session),
          capabilitySnapshot: {
            toolTransport: 'mcp',
            persistentFilesystem: Boolean(session.pvcName),
            portExposure: true,
            editorAccess: true,
          },
          providerState: buildProviderState(session, options.workspaceStorage, existing.providerState),
          metadata: {
            sessionKind: session.sessionKind,
            buildUuid: session.buildUuid,
            buildKind: session.buildKind,
          },
          error:
            session.workspaceStatus === 'failed' || session.status === 'error' ? { message: 'Sandbox failed' } : null,
          suspendedAt:
            session.workspaceStatus === 'hibernated'
              ? toTimestampString(session.updatedAt) || new Date().toISOString()
              : null,
          endedAt:
            session.status === 'ended'
              ? toTimestampString(session.endedAt) || toTimestampString(session.updatedAt) || new Date().toISOString()
              : null,
        } as Partial<AgentSandbox>)
      : await AgentSandbox.query(options.trx).insertAndFetch({
          sessionId: session.id,
          generation: 1,
          provider: 'lifecycle_kubernetes',
          status: mapSessionToSandboxStatus(session),
          capabilitySnapshot: {
            toolTransport: 'mcp',
            persistentFilesystem: Boolean(session.pvcName),
            portExposure: true,
            editorAccess: true,
          },
          providerState: buildProviderState(session, options.workspaceStorage),
          metadata: {
            sessionKind: session.sessionKind,
            buildUuid: session.buildUuid,
            buildKind: session.buildKind,
          },
          error:
            session.workspaceStatus === 'failed' || session.status === 'error' ? { message: 'Sandbox failed' } : null,
          suspendedAt:
            session.workspaceStatus === 'hibernated'
              ? toTimestampString(session.updatedAt) || new Date().toISOString()
              : null,
          endedAt:
            session.status === 'ended'
              ? toTimestampString(session.endedAt) || toTimestampString(session.updatedAt) || new Date().toISOString()
              : null,
        } as Partial<AgentSandbox>);

    if (sandbox.status === 'suspended' || sandbox.status === 'ended') {
      await AgentSandboxExposure.query(options.trx)
        .where({ sandboxId: sandbox.id })
        .whereNull('endedAt')
        .patch({
          status: 'ended',
          endedAt:
            toTimestampString(sandbox.suspendedAt) || toTimestampString(sandbox.endedAt) || new Date().toISOString(),
        } as Partial<AgentSandboxExposure>);
    }

    if (session.podName && session.namespace) {
      const editorUrl = `/api/agent-session/workspace-editor/${session.uuid}/`;
      const existingEditorExposure = await AgentSandboxExposure.query(options.trx)
        .where({ sandboxId: sandbox.id, kind: 'editor' })
        .whereNull('endedAt')
        .first();

      if (existingEditorExposure) {
        await AgentSandboxExposure.query(options.trx).patchAndFetchById(existingEditorExposure.id, {
          status:
            sandbox.status === 'provisioning'
              ? 'provisioning'
              : sandbox.status === 'failed'
              ? 'failed'
              : sandbox.status === 'ended'
              ? 'ended'
              : 'ready',
          url: editorUrl,
          metadata: {
            attachmentKind: 'mcp_gateway',
          },
          providerState: {},
          lastVerifiedAt: sandbox.status === 'ready' ? new Date().toISOString() : null,
          endedAt: toTimestampString(sandbox.endedAt),
        } as Partial<AgentSandboxExposure>);
      } else {
        await AgentSandboxExposure.query(options.trx).insert({
          sandboxId: sandbox.id,
          kind: 'editor',
          status:
            sandbox.status === 'provisioning'
              ? 'provisioning'
              : sandbox.status === 'failed'
              ? 'failed'
              : sandbox.status === 'ended'
              ? 'ended'
              : 'ready',
          url: editorUrl,
          metadata: {
            attachmentKind: 'mcp_gateway',
          },
          providerState: {},
          lastVerifiedAt: sandbox.status === 'ready' ? new Date().toISOString() : null,
          endedAt: toTimestampString(sandbox.endedAt),
        } as Partial<AgentSandboxExposure>);
      }
    }

    return sandbox;
  }

  static async ensureChatSandbox({
    sessionId,
    userId,
    userIdentity,
    githubToken,
  }: {
    sessionId: string;
    userId: string;
    userIdentity: RequestUserIdentity;
    githubToken?: string | null;
  }): Promise<{ session: AgentSession; sandbox: AgentSandbox | null }> {
    let session = await AgentSession.query().findOne({ uuid: sessionId, userId });
    if (!session) {
      throw new Error('Agent session not found');
    }

    if (
      session.sessionKind === 'chat' &&
      (session.workspaceStatus !== 'ready' || !session.namespace || !session.podName)
    ) {
      const AgentSessionService = (await import('server/services/agentSession')).default;
      session = await AgentSessionService.provisionChatRuntime({
        sessionId,
        userId,
        userIdentity,
        githubToken,
      });
    }

    const sandbox = await this.recordSessionSandboxState(session);
    return { session, sandbox };
  }

  static async resolveWorkspaceGatewayBaseUrl(sessionUuid: string): Promise<string | null> {
    const session = await AgentSession.query().findOne({ uuid: sessionUuid });
    if (!session) {
      return null;
    }

    const sandbox = await this.recordSessionSandboxState(session);
    const providerState = sandbox?.providerState || {};
    const podName = typeof providerState.podName === 'string' ? providerState.podName : session.podName;
    const namespace = typeof providerState.namespace === 'string' ? providerState.namespace : session.namespace;

    if (!podName || !namespace || session.status !== 'active') {
      return null;
    }

    return `http://${podName}.${namespace}.svc.cluster.local:${SESSION_WORKSPACE_GATEWAY_PORT}`;
  }

  static serializeSandboxExposure(exposure: AgentSandboxExposure) {
    return {
      id: exposure.uuid,
      kind: exposure.kind,
      status: exposure.status,
      targetPort: exposure.targetPort,
      url: exposure.url,
      metadata: exposure.metadata || {},
      lastVerifiedAt: exposure.lastVerifiedAt,
      endedAt: exposure.endedAt,
      createdAt: exposure.createdAt || null,
      updatedAt: exposure.updatedAt || null,
    };
  }
}
