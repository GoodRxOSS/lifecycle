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
import type { ChatPreviewHostMatch } from './chatPreviewFactory';

export interface ChatPreviewHostSession {
  sessionId: string;
  userId: string;
  ready: boolean;
}

export async function resolveChatPreviewSessionForHost(
  hostMatch: ChatPreviewHostMatch
): Promise<ChatPreviewHostSession | null> {
  const exposure = await AgentSandboxExposure.query()
    .where({ kind: 'preview', targetPort: hostMatch.port })
    .whereRaw('"metadata"->>? = ?', ['previewSlug', hostMatch.previewSlug])
    .orderBy('id', 'desc')
    .first();
  if (!exposure) {
    return null;
  }

  const sandbox = await AgentSandbox.query().findById(exposure.sandboxId);
  if (!sandbox) {
    return null;
  }

  const session = await AgentSession.query().findById(sandbox.sessionId);
  if (!session || session.status !== 'active') {
    return null;
  }

  return {
    sessionId: session.uuid,
    userId: session.userId,
    ready:
      exposure.status === 'ready' &&
      (exposure.endedAt === null || exposure.endedAt === undefined) &&
      sandbox.status === 'ready' &&
      session.workspaceStatus === 'ready',
  };
}
