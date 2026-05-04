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

import type AgentSession from 'server/models/AgentSession';
import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';

export function canSessionAcceptMessages(
  session: Pick<AgentSession, 'sessionKind' | 'chatStatus' | 'workspaceStatus'>
): boolean {
  if (session.chatStatus !== AgentChatStatus.READY) {
    return false;
  }

  if (session.sessionKind === AgentSessionKind.CHAT) {
    return true;
  }

  return session.workspaceStatus === AgentWorkspaceStatus.READY;
}

export function getSessionMessageBlockReason(
  session: Pick<AgentSession, 'sessionKind' | 'status' | 'chatStatus' | 'workspaceStatus'>
): string {
  if (canSessionAcceptMessages(session)) {
    return '';
  }

  if (
    session.sessionKind !== AgentSessionKind.CHAT &&
    (session.workspaceStatus === AgentWorkspaceStatus.PROVISIONING || session.status === 'starting')
  ) {
    return 'Wait for the session to finish starting before sending a message.';
  }

  return 'This session is no longer available for new messages.';
}
