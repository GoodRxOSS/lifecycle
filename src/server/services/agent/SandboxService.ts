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
import type { WorkspaceRuntimePlanMetadata } from 'server/lib/agentSession/workspaceRuntimePlan';
import {
  normalizeWorkspaceRuntimeFailure,
  type WorkspaceRuntimeFailure,
} from 'server/lib/agentSession/startupFailureState';

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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export interface AgentSandboxRuntimePlanPvcMetadata {
  name: string;
  ownsPvc: boolean;
  skipWorkspaceBootstrap: boolean;
  compatiblePrewarmUuid: string | null;
}

export interface AgentSandboxRuntimeLifecycleMetadata {
  currentAction: string;
  claimedAt?: string;
}

function buildRuntimePlanMetadata(runtimePlanMetadata: WorkspaceRuntimePlanMetadata): Record<string, unknown> {
  return {
    version: runtimePlanMetadata.version,
    pvc: {
      name: runtimePlanMetadata.pvcName,
      ownsPvc: runtimePlanMetadata.ownsPvc,
      skipWorkspaceBootstrap: runtimePlanMetadata.skipWorkspaceBootstrap,
      compatiblePrewarmUuid: runtimePlanMetadata.compatiblePrewarmUuid,
    },
  };
}

function buildRuntimeLifecycleMetadata(value: unknown): AgentSandboxRuntimeLifecycleMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const currentAction = readString(value.currentAction);
  if (!currentAction) {
    return undefined;
  }

  const claimedAt = readString(value.claimedAt);
  return {
    currentAction,
    ...(claimedAt ? { claimedAt } : {}),
  };
}

function readRuntimePlanPvcMetadata(metadata: unknown): AgentSandboxRuntimePlanPvcMetadata | null {
  if (!isRecord(metadata) || !isRecord(metadata.runtimePlan) || !isRecord(metadata.runtimePlan.pvc)) {
    return null;
  }

  const pvc = metadata.runtimePlan.pvc;
  const name = readString(pvc.name);
  const ownsPvc = readBoolean(pvc.ownsPvc);
  const skipWorkspaceBootstrap = readBoolean(pvc.skipWorkspaceBootstrap);
  if (!name || ownsPvc === undefined || skipWorkspaceBootstrap === undefined) {
    return null;
  }

  let compatiblePrewarmUuid: string | null = null;
  if (pvc.compatiblePrewarmUuid !== null && pvc.compatiblePrewarmUuid !== undefined) {
    const prewarmUuid = readString(pvc.compatiblePrewarmUuid);
    if (!prewarmUuid) {
      return null;
    }
    compatiblePrewarmUuid = prewarmUuid;
  }

  return {
    name,
    ownsPvc,
    skipWorkspaceBootstrap,
    compatiblePrewarmUuid,
  };
}

function buildSelectedServicesProviderState(selectedServices: unknown): Array<Record<string, string>> {
  if (!Array.isArray(selectedServices)) {
    return [];
  }

  return selectedServices
    .filter(isRecord)
    .map((service) => {
      const repositoryFullName = readString(service.repositoryFullName) ?? readString(service.repo);

      return {
        ...(readString(service.name) ? { name: readString(service.name) as string } : {}),
        ...(repositoryFullName ? { repositoryFullName } : {}),
        ...(readString(service.branch) ? { branch: readString(service.branch) as string } : {}),
        ...(readString(service.deployableName) ? { deployableName: readString(service.deployableName) as string } : {}),
        ...(readString(service.deployUuid) ? { deployUuid: readString(service.deployUuid) as string } : {}),
      };
    })
    .filter((service) => Object.keys(service).length > 0);
}

function buildProviderState(
  session: AgentSession,
  workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent,
  existingProviderState?: Record<string, unknown>
): Record<string, unknown> {
  const existingWorkspaceStorage = isRecord(existingProviderState?.workspaceStorage)
    ? existingProviderState.workspaceStorage
    : undefined;
  const selectedServices = buildSelectedServicesProviderState(session.selectedServices);

  return {
    ...(session.namespace ? { namespace: session.namespace } : {}),
    ...(session.podName ? { podName: session.podName } : {}),
    ...(session.pvcName ? { pvcName: session.pvcName } : {}),
    ...(selectedServices.length > 0 ? { selectedServices } : {}),
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

function buildMetadata(
  session: AgentSession,
  runtimePlanMetadata?: WorkspaceRuntimePlanMetadata,
  existingMetadata?: unknown,
  runtimeLifecycle?: AgentSandboxRuntimeLifecycleMetadata | null
): Record<string, unknown> {
  const existingRuntimePlan =
    isRecord(existingMetadata) && isRecord(existingMetadata.runtimePlan) ? existingMetadata.runtimePlan : undefined;
  const runtimePlan = runtimePlanMetadata ? buildRuntimePlanMetadata(runtimePlanMetadata) : existingRuntimePlan;
  const existingRuntimeLifecycle =
    isRecord(existingMetadata) && isRecord(existingMetadata.runtimeLifecycle)
      ? buildRuntimeLifecycleMetadata(existingMetadata.runtimeLifecycle)
      : undefined;
  const nextRuntimeLifecycle =
    runtimeLifecycle === null
      ? undefined
      : runtimeLifecycle === undefined
      ? existingRuntimeLifecycle
      : buildRuntimeLifecycleMetadata({
          ...existingRuntimeLifecycle,
          ...runtimeLifecycle,
        });

  return {
    sessionKind: session.sessionKind,
    buildUuid: session.buildUuid,
    buildKind: session.buildKind,
    ...(runtimePlan ? { runtimePlan } : {}),
    ...(nextRuntimeLifecycle ? { runtimeLifecycle: nextRuntimeLifecycle } : {}),
  };
}

function isFailedSandboxState(session: AgentSession): boolean {
  return session.workspaceStatus === 'failed' || session.status === 'error';
}

function buildSandboxError(
  session: AgentSession,
  failure?: WorkspaceRuntimeFailure | null,
  existingError?: unknown
): WorkspaceRuntimeFailure | null {
  if (!isFailedSandboxState(session)) {
    return null;
  }

  if (failure) {
    return normalizeWorkspaceRuntimeFailure(failure);
  }

  return normalizeWorkspaceRuntimeFailure(existingError, {
    origin: 'legacy',
    retryable: false,
  });
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

  static async getLatestRuntimePlanPvcMetadata(
    sessionId: number,
    options: { trx?: Transaction } = {}
  ): Promise<AgentSandboxRuntimePlanPvcMetadata | null> {
    const sandbox = await this.getLatestSandboxForSession(sessionId, options);
    return readRuntimePlanPvcMetadata(sandbox?.metadata);
  }

  static async recordSessionSandboxState(
    session: AgentSession,
    options: {
      trx?: Transaction;
      workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent;
      failure?: WorkspaceRuntimeFailure | null;
      runtimePlanMetadata?: WorkspaceRuntimePlanMetadata;
      sandboxStatus?: AgentSandbox['status'];
      runtimeLifecycle?: AgentSandboxRuntimeLifecycleMetadata | null;
    } = {}
  ): Promise<AgentSandbox | null> {
    const hasRuntimeRefs = Boolean(session.namespace || session.podName || session.pvcName);
    const shouldWriteSandboxState =
      hasRuntimeRefs ||
      Boolean(options.failure) ||
      options.sandboxStatus !== undefined ||
      options.runtimeLifecycle !== undefined;
    if (!shouldWriteSandboxState) {
      return this.getLatestSandboxForSession(session.id, options);
    }

    const existing = await this.getLatestSandboxForSession(session.id, options);
    const error = buildSandboxError(session, options.failure, existing?.error);
    const status = options.sandboxStatus ?? mapSessionToSandboxStatus(session);
    const sandbox = existing
      ? await AgentSandbox.query(options.trx).patchAndFetchById(existing.id, {
          provider: 'lifecycle_kubernetes',
          status,
          capabilitySnapshot: {
            toolTransport: 'mcp',
            persistentFilesystem: Boolean(session.pvcName),
            portExposure: true,
            editorAccess: true,
          },
          providerState: buildProviderState(session, options.workspaceStorage, existing.providerState),
          metadata: buildMetadata(session, options.runtimePlanMetadata, existing.metadata, options.runtimeLifecycle),
          error,
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
          status,
          capabilitySnapshot: {
            toolTransport: 'mcp',
            persistentFilesystem: Boolean(session.pvcName),
            portExposure: true,
            editorAccess: true,
          },
          providerState: buildProviderState(session, options.workspaceStorage),
          metadata: buildMetadata(session, options.runtimePlanMetadata, undefined, options.runtimeLifecycle),
          error,
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
    allowedActiveRunUuid,
  }: {
    sessionId: string;
    userId: string;
    userIdentity: RequestUserIdentity;
    githubToken?: string | null;
    allowedActiveRunUuid?: string | null;
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
      session = await AgentSessionService.openChatRuntime({
        sessionId,
        userId,
        userIdentity,
        githubToken,
        ...(allowedActiveRunUuid ? { allowedActiveRunUuid } : {}),
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
