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

const logger = () => getLogger();

const PROVISIONING_TIMEOUT_MESSAGE =
  'Workspace provisioning timed out. The previous attempt was interrupted before the workspace became ready. Retry to start it again.';

export async function processAgentSessionCleanup(): Promise<void> {
  const cleanupConfig = await resolveAgentSessionCleanupConfig();
  const activeCutoff = new Date(Date.now() - cleanupConfig.activeIdleSuspendMs);
  const startingCutoff = new Date(Date.now() - cleanupConfig.startingTimeoutMs);
  const suspendedExpiryCutoff = new Date(Date.now() - cleanupConfig.hibernatedRetentionMs);
  const idleActiveSessions = await AgentSession.query()
    .where('status', 'active')
    .where('lastActivity', '<', activeCutoff)
    .where((builder) => {
      builder
        .whereNot('sessionKind', AgentSessionKind.CHAT)
        .orWhereNot('workspaceStatus', AgentWorkspaceStatus.HIBERNATED);
    });
  // Chat provisioning is synchronous in the HTTP request; if that process dies the catch never runs and
  // the session is stranded in PROVISIONING under a live claim. Reap stale ones into a retryable FAILED.
  const timedOutProvisioningSessions = await AgentSession.query()
    .where('status', 'active')
    .where('sessionKind', AgentSessionKind.CHAT)
    .where('workspaceStatus', AgentWorkspaceStatus.PROVISIONING)
    .where('updatedAt', '<', startingCutoff);
  const staleSessions = [
    ...idleActiveSessions,
    ...(await AgentSession.query().where('status', 'starting').where('updatedAt', '<', startingCutoff)),
    ...(await AgentSession.query()
      .where('status', 'active')
      .where('sessionKind', AgentSessionKind.CHAT)
      .where('workspaceStatus', AgentWorkspaceStatus.HIBERNATED)
      .where('updatedAt', '<', suspendedExpiryCutoff)),
  ];

  for (const session of timedOutProvisioningSessions) {
    const sessionId = session.uuid || String(session.id);
    try {
      const failure = buildWorkspaceRuntimeFailure({
        error: new Error(PROVISIONING_TIMEOUT_MESSAGE),
        stage: 'connect_runtime',
        origin: 'chat_runtime',
        retryable: true,
        code: 'workspace_provisioning_timeout',
      });
      logger().info(`Session: cleanup provisioning timed out sessionId=${sessionId} updatedAt=${session.updatedAt}`);
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
      logger().error({ error: err, sessionId }, `Session: cleanup provisioning-timeout failed sessionId=${sessionId}`);
    }
  }

  for (const session of staleSessions) {
    const sessionId = session.uuid || String(session.id);
    try {
      // Provisioning chat runtimes are owned by the provisioning-timeout reaper above; never end them here.
      const isProvisioningChatRuntime =
        session.status === 'active' &&
        session.sessionKind === AgentSessionKind.CHAT &&
        session.workspaceStatus === AgentWorkspaceStatus.PROVISIONING;
      if (isProvisioningChatRuntime) {
        logger().info(`Session: cleanup skipped sessionId=${sessionId} reason=runtime_provisioning`);
        continue;
      }

      const canSuspendChatRuntime =
        session.status === 'active' &&
        session.sessionKind === AgentSessionKind.CHAT &&
        session.workspaceStatus === AgentWorkspaceStatus.READY &&
        Boolean(session.namespace) &&
        Boolean(session.podName) &&
        Boolean(session.pvcName);

      if (canSuspendChatRuntime) {
        logger().info(`Session: cleanup suspending sessionId=${sessionId} lastActivity=${session.lastActivity}`);
        await AgentSessionService.suspendChatRuntime({
          sessionId,
          userId: session.userId,
        });
        continue;
      }

      logger().info(
        `Session: cleanup starting sessionId=${sessionId} status=${session.status} lastActivity=${session.lastActivity}`
      );
      await AgentSessionService.endSession(sessionId);
    } catch (err) {
      if (err instanceof WorkspaceActionBlockedError) {
        if (err.reason === 'active_run') {
          logger().info(`Session: cleanup skipped sessionId=${sessionId} reason=active_run`);
        } else {
          logger().info(`Session: cleanup skipped sessionId=${sessionId} reason=action_in_progress`);
        }
        continue;
      }
      logger().error({ error: err, sessionId }, `Session: cleanup failed sessionId=${sessionId}`);
    }
  }
}
