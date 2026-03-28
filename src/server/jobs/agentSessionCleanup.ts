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

const logger = () => getLogger();
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const STARTING_TIMEOUT_MS = 15 * 60 * 1000;

export async function processAgentSessionCleanup(): Promise<void> {
  const activeCutoff = new Date(Date.now() - IDLE_TIMEOUT_MS);
  const startingCutoff = new Date(Date.now() - STARTING_TIMEOUT_MS);
  const staleSessions = [
    ...(await AgentSession.query().where('status', 'active').where('lastActivity', '<', activeCutoff)),
    ...(await AgentSession.query().where('status', 'starting').where('updatedAt', '<', startingCutoff)),
  ];

  for (const session of staleSessions) {
    const sessionId = session.uuid || String(session.id);
    try {
      logger().info(
        `Session: cleanup starting sessionId=${sessionId} status=${session.status} lastActivity=${session.lastActivity}`
      );
      await AgentSessionService.endSession(sessionId);
    } catch (err) {
      logger().error({ error: err, sessionId }, `Session: cleanup failed sessionId=${sessionId}`);
    }
  }
}
