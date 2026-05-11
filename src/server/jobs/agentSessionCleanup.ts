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
import { AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';
import { resolveAgentSessionCleanupConfig } from 'server/lib/agentSession/runtimeConfig';
import { WorkspaceActionBlockedError } from 'server/services/agent/WorkspaceRuntimeStateService';

const logger = () => getLogger();

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
  const staleSessions = [
    ...idleActiveSessions,
    ...(await AgentSession.query().where('status', 'starting').where('updatedAt', '<', startingCutoff)),
    ...(await AgentSession.query()
      .where('status', 'active')
      .where('sessionKind', AgentSessionKind.CHAT)
      .where('workspaceStatus', AgentWorkspaceStatus.HIBERNATED)
      .where('updatedAt', '<', suspendedExpiryCutoff)),
  ];

  for (const session of staleSessions) {
    const sessionId = session.uuid || String(session.id);
    try {
      const isProvisioningChatRuntime =
        session.status === 'active' &&
        session.sessionKind === AgentSessionKind.CHAT &&
        session.workspaceStatus === AgentWorkspaceStatus.PROVISIONING;
      if (isProvisioningChatRuntime && new Date(session.updatedAt).getTime() >= startingCutoff.getTime()) {
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
