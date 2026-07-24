/**
 * Copyright 2025 GoodRx, Inc.
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
import AgentSession from 'server/models/AgentSession';
import AgentSessionService from 'server/services/agentSession';
import { getLogger } from 'server/lib/logger';
import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';
import { resolveAgentSessionCleanupConfig } from 'server/lib/agentSession/runtimeConfig';
import {
  WorkspaceActionBlockedError,
  WorkspaceRuntimeStateService,
} from 'server/services/agent/WorkspaceRuntimeStateService';
import { buildWorkspaceRuntimeFailure } from 'server/lib/agentSession/startupFailureState';
import AgentSandboxService from 'server/services/agent/SandboxService';
import {
  isRemoteWorkspaceBackend,
  listRemoteWorkspaceBackendIds,
  resolveRemoteRuntimeProviderForSandbox,
} from 'server/services/workspaceRuntime/registry';
import { MODAL_PROVIDER } from 'server/services/workspaceRuntime/providers/modal';
import { WorkspaceRuntimeGoneError } from 'server/services/workspaceRuntime/types';
import type { RemoteWorkspaceRuntimeProvider } from 'server/services/workspaceRuntime/types';
import type { ResolvedAgentSessionCleanupConfig } from 'server/lib/agentSession/runtimeConfig';

const logger = () => getLogger();

const WORKSPACE_STARTUP_TIMEOUT_MESSAGE =
  'Workspace startup timed out. The previous attempt was interrupted before the workspace became ready. Retry to start it again.';

async function isRemoteBackedSession(sessionId: number): Promise<boolean> {
  const sandbox = await AgentSandboxService.getLatestSandboxForSession(sessionId);
  return isRemoteWorkspaceBackend(sandbox?.provider);
}

const WALL_MARGIN_MIN_MS = 10 * 60 * 1000;

function isNearModalWall(sandbox: AgentSandbox, cleanupConfig: ResolvedAgentSessionCleanupConfig): boolean {
  if (sandbox.provider !== MODAL_PROVIDER) {
    return false;
  }

  const state = (sandbox.providerState || {}) as Record<string, unknown>;
  const createdAt = typeof state.createdAt === 'string' ? Date.parse(state.createdAt) : NaN;
  const timeoutMs = typeof state.timeoutMs === 'number' && state.timeoutMs > 0 ? state.timeoutMs : NaN;
  if (!Number.isFinite(createdAt) || !Number.isFinite(timeoutMs)) {
    return false;
  }

  const margin = Math.max(cleanupConfig.intervalMs * 2, WALL_MARGIN_MIN_MS);
  return Date.now() > createdAt + timeoutMs - margin;
}

// A wall-killed Modal sandbox is finished but its row is still 'ready'; convert it to a hibernated
// state pointing at the last checkpoint so the next open resumes from it (instead of checkpoint-spamming
// the dead sandbox until idle-suspend eventually fails it). Best-effort: an active run blocks the claim.
async function reconcileFinishedModalSandbox(sandbox: AgentSandbox): Promise<void> {
  const session = await AgentSession.query().findById(sandbox.sessionId);
  if (
    !session ||
    session.status !== 'active' ||
    session.workspaceStatus !== AgentWorkspaceStatus.READY ||
    sandbox.provider !== MODAL_PROVIDER
  ) {
    return;
  }

  const claimedAt = new Date().toISOString();
  await WorkspaceRuntimeStateService.claimWorkspaceAction(session.id, {
    action: 'cleanup',
    claimedAt,
    sessionPatch: {
      status: 'active',
      chatStatus: AgentChatStatus.READY,
      workspaceStatus: AgentWorkspaceStatus.READY,
    } as unknown as Partial<AgentSession>,
    sandboxStatus: 'suspending',
    runtimeProvider: sandbox.provider,
  });
  await WorkspaceRuntimeStateService.recordWorkspaceState(
    session.id,
    {
      sessionPatch: {
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
        pvcName: null,
      } as unknown as Partial<AgentSession>,
      sandboxStatus: 'suspended',
      runtimeProvider: sandbox.provider,
      // Merge explicit nulls so the row stops pointing at the dead sandbox; snapshotImageId survives for resume.
      providerState: { sandboxId: null, gatewayUrl: null },
      runtimeLifecycle: null,
    },
    { expectedLifecycle: { action: 'cleanup', claimedAt } }
  );
  logger().info(`Session: cleanup hibernated wall-killed sandbox provider=${sandbox.provider} sandboxId=${sandbox.id}`);
}

// A pinned workspace must outlive the provider TTL even while suspended: renew its lease every pass.
async function renewKeptSuspendedWorkspaces(remoteBackendIds: string[]): Promise<void> {
  const keptSessionIds = (await AgentSession.query().where({ keepWorkspace: true, status: 'active' }).select('id')).map(
    (session) => session.id
  );
  if (keptSessionIds.length === 0) {
    return;
  }

  const suspendedSandboxes = (
    await AgentSandbox.query()
      .where({ status: 'suspended' })
      .whereIn('provider', remoteBackendIds)
      .whereIn('sessionId', keptSessionIds)
  ).filter((sandbox) => isRemoteWorkspaceBackend(sandbox.provider));

  for (const sandbox of suspendedSandboxes) {
    try {
      const provider = await resolveRemoteRuntimeProviderForSandbox(sandbox);
      await provider?.renewLease?.(sandbox.providerState);
    } catch (err) {
      // Non-fatal per row: a missed renewal only matters if it keeps failing.
      logger().warn({ error: err, sandboxId: sandbox.id }, 'Session: cleanup kept-workspace lease renewal failed');
    }
  }
}

// Remote backends TTL-terminate sandboxes (even suspended ones); keep live ones renewed so only
// Lifecycle decides when a workspace dies. Suspend/end paths manage their own expiry. Modal has
// no lease extension and hard-kills at its 24h wall, so wall-adjacent sandboxes are checkpointed
// every pass — a wall kill then resumes from the last checkpoint (delta since it is lost).
async function maintainActiveRemoteWorkspaces(cleanupConfig: ResolvedAgentSessionCleanupConfig): Promise<void> {
  const remoteBackendIds = listRemoteWorkspaceBackendIds();
  if (remoteBackendIds.length === 0) {
    return;
  }
  await renewKeptSuspendedWorkspaces(remoteBackendIds).catch((err) => {
    logger().warn({ error: err }, 'Session: cleanup kept-workspace renewal pass failed');
  });
  // Pure-K8s installs read zero rows; the JS guard below is a belt-and-suspenders check on the SQL filter.
  const remoteSandboxes = (
    await AgentSandbox.query().where({ status: 'ready' }).whereIn('provider', remoteBackendIds)
  ).filter((sandbox) => isRemoteWorkspaceBackend(sandbox.provider));
  if (remoteSandboxes.length === 0) {
    return;
  }

  const providers = new Map<string, RemoteWorkspaceRuntimeProvider | null>();
  for (const sandbox of remoteSandboxes) {
    try {
      if (!providers.has(sandbox.provider)) {
        providers.set(sandbox.provider, await resolveRemoteRuntimeProviderForSandbox(sandbox));
      }
      const provider = providers.get(sandbox.provider);
      await provider?.renewLease?.(sandbox.providerState);

      if (provider?.checkpoint && isNearModalWall(sandbox, cleanupConfig)) {
        // Re-fetch so a concurrent suspend/destroy (HTTP route, other process) isn't clobbered by this
        // stale-read checkpoint. Only act while still 'ready' (any lifecycle action moves status away).
        const current = await AgentSandbox.query().findById(sandbox.id);
        if (!current || current.status !== 'ready') {
          continue;
        }
        try {
          const handle = await provider.checkpoint(current.providerState);
          if (handle) {
            // Merge (never full-replace) and persist only while still 'ready', so a concurrent suspend wins.
            const updated = await AgentSandbox.query()
              .patch({ providerState: { ...current.providerState, ...handle.providerState } })
              .where('id', current.id)
              .where('status', 'ready');
            if (updated === 0) {
              logger().info(`Session: cleanup checkpoint superseded by a concurrent action sandboxId=${sandbox.id}`);
            }
          }
          logger().info(
            `Session: cleanup checkpointed wall-adjacent sandbox provider=${sandbox.provider} sandboxId=${sandbox.id}`
          );
        } catch (checkpointErr) {
          // The sandbox already hit the wall and is gone: hibernate from the last checkpoint.
          if (checkpointErr instanceof WorkspaceRuntimeGoneError) {
            await reconcileFinishedModalSandbox(current);
          } else {
            throw checkpointErr;
          }
        }
      }
    } catch (err) {
      // A lease renewal on a sandbox the provider already terminated: settle the session now instead
      // of warning every pass while runs keep building against a dead runtime.
      if (err instanceof WorkspaceRuntimeGoneError) {
        const session = await AgentSession.query().findById(sandbox.sessionId);
        if (session?.uuid) {
          await AgentSessionService.reconcileLostChatWorkspaceRuntime(session.uuid).catch((reconcileErr) => {
            logger().warn(
              { error: reconcileErr, sandboxId: sandbox.id },
              'Session: cleanup workspace-loss reconcile failed'
            );
            return null;
          });
        }
        continue;
      }
      // Non-fatal per row: a missed renewal/checkpoint only matters if it keeps failing.
      logger().warn({ error: err, sandboxId: sandbox.id }, 'Session: cleanup remote maintenance failed');
    }
  }
}

export async function processAgentSessionCleanup(): Promise<void> {
  const cleanupConfig = await resolveAgentSessionCleanupConfig();
  const activeCutoff = new Date(Date.now() - cleanupConfig.activeIdleSuspendMs);
  const startingCutoff = new Date(Date.now() - cleanupConfig.startingTimeoutMs);
  const suspendedExpiryCutoff = new Date(Date.now() - cleanupConfig.hibernatedRetentionMs);
  const archiveCutoff = new Date(Date.now() - cleanupConfig.idleArchiveMs);
  // Idle chats with nothing to reclaim (hibernated or no workspace) are left alone here;
  // list hygiene is the idle-archive pass, not workspace teardown.
  const idleActiveSessions = await AgentSession.query()
    .where('status', 'active')
    .where('lastActivity', '<', activeCutoff)
    .where((builder) => {
      builder
        .whereNot('sessionKind', AgentSessionKind.CHAT)
        .orWhereNotIn('workspaceStatus', [AgentWorkspaceStatus.HIBERNATED, AgentWorkspaceStatus.NONE]);
    });
  // Chat workspace startup is synchronous in the HTTP request; if that process dies the catch never runs and
  // the session is stranded in PROVISIONING under a live claim. Reap stale ones into a retryable FAILED.
  const timedOutWorkspaceStartupSessions = await AgentSession.query()
    .where('status', 'active')
    .where('sessionKind', AgentSessionKind.CHAT)
    .where('workspaceStatus', AgentWorkspaceStatus.PROVISIONING)
    .where('updatedAt', '<', startingCutoff);
  const stuckStartingSessions = await AgentSession.query()
    .where('status', 'starting')
    .where('updatedAt', '<', startingCutoff);
  // Kept workspaces are pinned: they sleep but are never reclaimed or auto-archived.
  const expiredHibernatedSessions = await AgentSession.query()
    .where('status', 'active')
    .where('sessionKind', AgentSessionKind.CHAT)
    .where('workspaceStatus', AgentWorkspaceStatus.HIBERNATED)
    .where('keepWorkspace', false)
    .where('updatedAt', '<', suspendedExpiryCutoff);
  const idleArchiveSessions = await AgentSession.query()
    .whereIn('status', ['active', 'error'])
    .where('keepWorkspace', false)
    .where('lastActivity', '<', archiveCutoff);

  for (const session of timedOutWorkspaceStartupSessions) {
    const sessionId = session.uuid || String(session.id);
    try {
      const failure = buildWorkspaceRuntimeFailure({
        error: new Error(WORKSPACE_STARTUP_TIMEOUT_MESSAGE),
        stage: 'connect_runtime',
        origin: 'chat_runtime',
        retryable: true,
        code: 'workspace_startup_timeout',
      });
      logger().info(
        `Session: cleanup workspace startup timed out sessionId=${sessionId} updatedAt=${session.updatedAt}`
      );
      await WorkspaceRuntimeStateService.recordWorkspaceFailure(session.id, {
        sessionPatch: {
          status: 'active',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
        } as unknown as Partial<AgentSession>,
        failure,
        // Release the stranded lifecycle claim so the retry path is unblocked.
        runtimeLifecycle: null,
      });
    } catch (err) {
      logger().error(
        { error: err, sessionId },
        `Session: cleanup workspace-startup-timeout failed sessionId=${sessionId}`
      );
    }
  }

  const runGuarded = async (session: AgentSession, action: () => Promise<unknown>): Promise<void> => {
    const sessionId = session.uuid || String(session.id);
    try {
      await action();
    } catch (err) {
      if (err instanceof WorkspaceActionBlockedError) {
        const reason = err.reason === 'active_run' ? 'active_run' : 'action_in_progress';
        logger().info(`Session: cleanup skipped sessionId=${sessionId} reason=${reason}`);
        return;
      }
      logger().error({ error: err, sessionId }, `Session: cleanup failed sessionId=${sessionId}`);
    }
  };

  for (const session of idleActiveSessions) {
    const sessionId = session.uuid || String(session.id);
    await runGuarded(session, async () => {
      // Starting chat workspaces are owned by the startup-timeout reaper above; never touch them here.
      const isProvisioningChatRuntime =
        session.sessionKind === AgentSessionKind.CHAT && session.workspaceStatus === AgentWorkspaceStatus.PROVISIONING;
      if (isProvisioningChatRuntime) {
        logger().info(`Session: cleanup skipped sessionId=${sessionId} reason=runtime_provisioning`);
        return;
      }

      const isReadyChatRuntime =
        session.sessionKind === AgentSessionKind.CHAT &&
        session.workspaceStatus === AgentWorkspaceStatus.READY &&
        Boolean(session.namespace) &&
        Boolean(session.podName);
      // Suspendable workspaces persist either in a PVC (kubernetes) or a suspendable remote sandbox.
      const canSuspendChatRuntime =
        isReadyChatRuntime && (Boolean(session.pvcName) || (await isRemoteBackedSession(session.id)));

      if (canSuspendChatRuntime) {
        logger().info(`Session: cleanup suspending sessionId=${sessionId} lastActivity=${session.lastActivity}`);
        await AgentSessionService.suspendChatRuntime({
          sessionId,
          userId: session.userId,
        });
        return;
      }

      // A kept workspace can sleep (handled above) but is never destroyed by the reaper.
      if (session.keepWorkspace) {
        logger().info(`Session: cleanup skipped sessionId=${sessionId} reason=keep_workspace`);
        return;
      }

      if (session.sessionKind === AgentSessionKind.CHAT) {
        // Unsuspendable chat workspaces are reclaimed; the conversation stays live.
        logger().info(
          `Session: cleanup releasing workspace sessionId=${sessionId} lastActivity=${session.lastActivity}`
        );
        await AgentSessionService.releaseWorkspace(sessionId);
        return;
      }

      // Environment/sandbox workspaces are bound to their build; idle ones archive (reversible).
      logger().info(
        `Session: cleanup archiving sessionId=${sessionId} kind=${session.sessionKind} lastActivity=${session.lastActivity}`
      );
      await AgentSessionService.archiveSession(sessionId);
    });
  }

  for (const session of stuckStartingSessions) {
    const sessionId = session.uuid || String(session.id);
    await runGuarded(session, async () => {
      logger().info(`Session: cleanup archiving stuck-starting sessionId=${sessionId} updatedAt=${session.updatedAt}`);
      await AgentSessionService.archiveSession(sessionId);
    });
  }

  for (const session of expiredHibernatedSessions) {
    const sessionId = session.uuid || String(session.id);
    await runGuarded(session, async () => {
      // The suspended sandbox's retention lapsed: reclaim it. The chat survives and a fresh
      // workspace provisions on the next message.
      logger().info(
        `Session: cleanup releasing expired workspace sessionId=${sessionId} updatedAt=${session.updatedAt}`
      );
      await AgentSessionService.releaseWorkspace(sessionId);
    });
  }

  for (const session of idleArchiveSessions) {
    const sessionId = session.uuid || String(session.id);
    await runGuarded(session, async () => {
      logger().info(`Session: cleanup auto-archiving sessionId=${sessionId} lastActivity=${session.lastActivity}`);
      await AgentSessionService.archiveSession(sessionId);
    });
  }

  await maintainActiveRemoteWorkspaces(cleanupConfig).catch((err) => {
    logger().error({ error: err }, 'Session: cleanup workspace lease renewal failed');
  });
}
