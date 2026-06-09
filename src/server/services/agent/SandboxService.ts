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
import {
  buildWorkspaceGatewayAuthHeaders,
  decryptWorkspaceGatewayToken,
} from 'server/services/workspaceRuntime/gatewayToken';
import { getLogger } from 'server/lib/logger';
import {
  getWorkspaceBackendDescriptor,
  isRemoteWorkspaceBackend,
  resolveRemoteRuntimeProviderForSandbox,
} from 'server/services/workspaceRuntime/registry';
import { LIFECYCLE_KUBERNETES_PROVIDER, type WorkspaceRuntimeEndpoint } from 'server/services/workspaceRuntime/types';
import { buildWorkspaceGatewayPreviewEndpoint } from 'server/services/workspaceRuntime/gatewayPreview';

export type { WorkspaceRuntimeEndpoint } from 'server/services/workspaceRuntime/types';

const SESSION_WORKSPACE_GATEWAY_PORT = parseInt(process.env.AGENT_SESSION_WORKSPACE_GATEWAY_PORT || '13338', 10);
const logger = () => getLogger();

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
  existingProviderState?: Record<string, unknown>,
  providerStatePatch?: Record<string, unknown>
): Record<string, unknown> {
  const existingWorkspaceStorage =
    existingProviderState && isRecord(existingProviderState.workspaceStorage)
      ? existingProviderState.workspaceStorage
      : undefined;
  const selectedServices = buildSelectedServicesProviderState(session.selectedServices);
  // This rebuilds providerState from session fields on every write; the encrypted gateway token
  // must survive those rewrites or the session loses gateway access mid-flight.
  const gatewayToken = readString(providerStatePatch?.gatewayToken) ?? readString(existingProviderState?.gatewayToken);

  return {
    ...(session.namespace ? { namespace: session.namespace } : {}),
    ...(session.podName ? { podName: session.podName } : {}),
    ...(session.pvcName ? { pvcName: session.pvcName } : {}),
    ...(gatewayToken ? { gatewayToken } : {}),
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

function getExistingRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function buildDefaultCapabilitySnapshot(
  session: AgentSession,
  provider: string,
  providerState: Record<string, unknown>
): Record<string, unknown> {
  const descriptor = getWorkspaceBackendDescriptor(provider);
  if (descriptor?.createProvider) {
    return {
      ...descriptor.declaredCapabilities,
      backend: descriptor.id,
      editorAccess: Boolean(readString(providerState.editorUrl)),
    };
  }

  return {
    toolTransport: 'mcp',
    persistentFilesystem: Boolean(session.pvcName),
    portExposure: true,
    editorAccess: true,
  };
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => entry[0].trim().length > 0 && typeof entry[1] === 'string'
    )
  );
}

function readPreviewSlug(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readString(value.previewSlug);
}

/** Gateway endpoints only — the editor is a separate process and must never see this token. */
function withGatewayBearerToken(
  endpoint: WorkspaceRuntimeEndpoint | null,
  providerState: Record<string, unknown>
): WorkspaceRuntimeEndpoint | null {
  const encryptedToken = readString(providerState.gatewayToken);
  if (!endpoint || !encryptedToken) {
    return endpoint;
  }

  return {
    ...endpoint,
    headers: {
      ...(endpoint.headers || {}),
      ...buildWorkspaceGatewayAuthHeaders(decryptWorkspaceGatewayToken(encryptedToken)),
    },
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

function mapSandboxToExposureStatus(sandbox: AgentSandbox): AgentSandboxExposure['status'] {
  if (sandbox.status === 'provisioning' || sandbox.status === 'resuming' || sandbox.status === 'suspending') {
    return 'provisioning';
  }

  if (sandbox.status === 'failed') {
    return 'failed';
  }

  if (sandbox.status === 'ended' || sandbox.status === 'suspended') {
    return 'ended';
  }

  return 'ready';
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
    const sandbox = await AgentSandbox.query(options.trx)
      .where({ sessionId })
      .orderBy('generation', 'desc')
      .orderBy('createdAt', 'desc')
      .first();
    return sandbox ?? null;
  }

  static async getLatestSandboxBySessionUuid(sessionUuid: string): Promise<AgentSandbox | null> {
    const session = await AgentSession.query().findOne({ uuid: sessionUuid });
    if (!session) {
      return null;
    }

    return this.getLatestSandboxForSession(session.id);
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
      runtimeProvider?: string;
      providerState?: Record<string, unknown>;
      capabilitySnapshot?: Record<string, unknown>;
    } = {}
  ): Promise<AgentSandbox | null> {
    const hasRuntimeRefs = Boolean(session.namespace || session.podName || session.pvcName);
    const shouldWriteSandboxState =
      hasRuntimeRefs ||
      Boolean(options.failure) ||
      options.sandboxStatus !== undefined ||
      options.runtimeLifecycle !== undefined ||
      options.runtimeProvider !== undefined ||
      options.providerState !== undefined ||
      options.capabilitySnapshot !== undefined;
    if (!shouldWriteSandboxState) {
      return this.getLatestSandboxForSession(session.id, options);
    }

    const existing = await this.getLatestSandboxForSession(session.id, options);
    const error = buildSandboxError(session, options.failure, existing?.error);
    const status = options.sandboxStatus ?? mapSessionToSandboxStatus(session);
    const provider = options.runtimeProvider || existing?.provider || LIFECYCLE_KUBERNETES_PROVIDER;
    const remoteBackend = isRemoteWorkspaceBackend(provider);
    const existingProviderState = getExistingRecord(existing?.providerState);
    const providerState = remoteBackend
      ? {
          ...existingProviderState,
          ...(options.providerState || {}),
        }
      : buildProviderState(session, options.workspaceStorage, existingProviderState, options.providerState);
    const existingCapabilitySnapshot =
      existing && isRecord(existing.capabilitySnapshot) ? existing.capabilitySnapshot : undefined;
    const capabilitySnapshot =
      options.capabilitySnapshot ||
      (remoteBackend && existingCapabilitySnapshot
        ? existingCapabilitySnapshot
        : buildDefaultCapabilitySnapshot(session, provider, providerState));
    const sandbox = existing
      ? await AgentSandbox.query(options.trx).patchAndFetchById(existing.id, {
          provider,
          status,
          capabilitySnapshot,
          providerState,
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
          provider,
          status,
          capabilitySnapshot,
          providerState,
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

    const remoteEditorUrl = remoteBackend ? readString(providerState.editorUrl) : undefined;
    const shouldExposeEditor =
      Boolean(session.podName && session.namespace && !remoteBackend) || Boolean(remoteEditorUrl);

    if (shouldExposeEditor) {
      const editorUrl = `/api/agent-session/workspace-editor/${session.uuid}/`;
      // The editor exposure is a per-sandbox singleton: also match ended rows so suspend/resume
      // cycles revive the same row instead of inserting a duplicate per cycle.
      const existingEditorExposure = await AgentSandboxExposure.query(options.trx)
        .where({ sandboxId: sandbox.id, kind: 'editor' })
        .orderBy('id', 'desc')
        .first();
      const exposureStatus = mapSandboxToExposureStatus(sandbox);
      const editorExposurePatch = {
        status: exposureStatus,
        url: editorUrl,
        metadata: {
          attachmentKind: remoteBackend ? `${provider}_endpoint` : 'mcp_gateway',
        },
        // Remote providers persist endpoint headers with platform credentials already stripped.
        providerState: remoteBackend
          ? {
              url: remoteEditorUrl,
              headers: readStringRecord(providerState.editorHeaders),
            }
          : {},
        lastVerifiedAt: exposureStatus === 'ready' ? new Date().toISOString() : null,
        endedAt:
          exposureStatus === 'ended'
            ? toTimestampString(sandbox.endedAt) || toTimestampString(sandbox.suspendedAt) || new Date().toISOString()
            : null,
      } as Partial<AgentSandboxExposure>;

      if (existingEditorExposure) {
        await AgentSandboxExposure.query(options.trx).patchAndFetchById(existingEditorExposure.id, editorExposurePatch);
      } else {
        await AgentSandboxExposure.query(options.trx).insert({
          sandboxId: sandbox.id,
          kind: 'editor',
          ...editorExposurePatch,
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

  static async resolveWorkspaceGatewayEndpoint(sessionUuid: string): Promise<WorkspaceRuntimeEndpoint | null> {
    const session = await AgentSession.query().findOne({ uuid: sessionUuid });
    if (!session || session.status !== 'active') {
      return null;
    }

    // Read-only: this runs on tool-routing hot paths; lifecycle transitions own sandbox-state writes.
    const sandbox = await this.getLatestSandboxForSession(session.id);
    if (!sandbox) {
      return null;
    }

    const provider = await resolveRemoteRuntimeProviderForSandbox(sandbox);
    if (provider) {
      return withGatewayBearerToken(provider.resolveGatewayEndpoint(sandbox.providerState), sandbox.providerState);
    }

    const providerState = sandbox?.providerState || {};
    const podName = typeof providerState.podName === 'string' ? providerState.podName : session.podName;
    const namespace = typeof providerState.namespace === 'string' ? providerState.namespace : session.namespace;

    if (!podName || !namespace) {
      return null;
    }

    return withGatewayBearerToken(
      {
        url: `http://${podName}.${namespace}.svc.cluster.local:${SESSION_WORKSPACE_GATEWAY_PORT}`,
      },
      providerState
    );
  }

  static async resolveWorkspaceGatewayBaseUrl(sessionUuid: string): Promise<string | null> {
    const endpoint = await this.resolveWorkspaceGatewayEndpoint(sessionUuid);
    return endpoint?.url || null;
  }

  static async resolveWorkspaceEditorEndpoint(sessionUuid: string): Promise<WorkspaceRuntimeEndpoint | null> {
    const sandbox = await this.getLatestSandboxBySessionUuid(sessionUuid);
    const provider = await resolveRemoteRuntimeProviderForSandbox(sandbox);
    if (!sandbox || !provider) {
      return null;
    }

    return provider.resolveEditorEndpoint(sandbox.providerState);
  }

  /** Upserts the preview exposure row for a published port (read by ws-server's preview proxy). */
  private static async upsertPreviewExposureForSandbox(
    sandboxId: number,
    publication: {
      port: number;
      url: string;
      endpointUrl?: string;
      headers?: Record<string, string>;
      attachmentKind: string;
      previewSlug?: string;
    }
  ): Promise<AgentSandboxExposure> {
    const existing = await AgentSandboxExposure.query()
      .where({ sandboxId, kind: 'preview', targetPort: publication.port })
      .orderBy('id', 'desc')
      .first();
    const patch = {
      sandboxId,
      kind: 'preview',
      targetPort: publication.port,
      status: 'ready',
      url: publication.url,
      metadata: {
        attachmentKind: publication.attachmentKind,
        ...(publication.previewSlug ? { previewSlug: publication.previewSlug } : {}),
      },
      providerState: {
        url: publication.endpointUrl || publication.url,
        headers: publication.headers || {},
      },
      lastVerifiedAt: new Date().toISOString(),
      endedAt: null,
    } as Partial<AgentSandboxExposure>;

    if (existing) {
      return AgentSandboxExposure.query().patchAndFetchById(existing.id, patch);
    }

    return AgentSandboxExposure.query().insertAndFetch(patch);
  }

  static async recordPreviewExposure(
    session: AgentSession,
    publication: {
      port: number;
      url: string;
      endpointUrl?: string;
      headers?: Record<string, string>;
      attachmentKind: string;
      previewSlug?: string;
    }
  ): Promise<AgentSandboxExposure | null> {
    const sandbox = await this.getLatestSandboxForSession(session.id);
    if (!sandbox) {
      return null;
    }

    return this.upsertPreviewExposureForSandbox(sandbox.id, publication);
  }

  static async restorePreviewExposures(session: AgentSession): Promise<number> {
    const sandbox = await this.getLatestSandboxForSession(session.id);
    if (!sandbox || sandbox.status !== 'ready') {
      return 0;
    }

    const previousExposures = await AgentSandboxExposure.query()
      .where({ sandboxId: sandbox.id, kind: 'preview' })
      .whereNotNull('targetPort')
      .orderBy('id', 'desc');
    const previewsByPort = new Map<number, { port: number; previewSlug?: string }>();
    for (const exposure of previousExposures) {
      const port = exposure.targetPort;
      if (!Number.isInteger(port) || port === null || previewsByPort.has(port)) {
        continue;
      }
      previewsByPort.set(port, {
        port,
        previewSlug: readPreviewSlug(exposure.metadata),
      });
    }
    if (previewsByPort.size === 0) {
      return 0;
    }

    const gatewayEndpoint = await this.resolveWorkspaceGatewayEndpoint(session.uuid);
    if (!gatewayEndpoint) {
      return 0;
    }

    let restored = 0;
    const { buildChatPreviewHostSlug, resolveChatPreviewPublicPublication } = await import(
      'server/lib/agentSession/chatPreviewFactory'
    );
    for (const preview of previewsByPort.values()) {
      try {
        const endpoint = buildWorkspaceGatewayPreviewEndpoint(gatewayEndpoint, preview.port);
        const previewSlug =
          preview.previewSlug || buildChatPreviewHostSlug({ sessionUuid: session.uuid, port: preview.port });
        const publicPreview = resolveChatPreviewPublicPublication({ port: preview.port, previewSlug });
        await this.upsertPreviewExposureForSandbox(sandbox.id, {
          port: preview.port,
          url: publicPreview.url,
          endpointUrl: endpoint.url,
          headers: endpoint.headers || {},
          attachmentKind: 'workspace_gateway_preview',
          previewSlug,
        });
        restored += 1;
      } catch (error) {
        logger().warn(
          { error, sessionId: session.uuid, provider: sandbox.provider, port: preview.port },
          'Session: failed to restore preview exposure after resume'
        );
      }
    }

    return restored;
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
