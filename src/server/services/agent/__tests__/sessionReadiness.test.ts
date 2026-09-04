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
import { canSessionAcceptMessages, getSessionMessageBlockReason } from '../sessionReadiness';

function session(overrides: Partial<AgentSession> = {}) {
  return {
    status: 'active',
    sessionKind: AgentSessionKind.CHAT,
    chatStatus: AgentChatStatus.READY,
    workspaceStatus: AgentWorkspaceStatus.NONE,
    ...overrides,
  } as AgentSession;
}

describe('sessionReadiness', () => {
  it('allows ready chat sessions without requiring a workspace', () => {
    const value = session();

    expect(canSessionAcceptMessages(value)).toBe(true);
    expect(getSessionMessageBlockReason(value)).toBe('');
  });

  it('requires both chat and workspace readiness for environment sessions', () => {
    expect(
      canSessionAcceptMessages(
        session({ sessionKind: AgentSessionKind.ENVIRONMENT, workspaceStatus: AgentWorkspaceStatus.READY })
      )
    ).toBe(true);
    expect(
      canSessionAcceptMessages(
        session({ sessionKind: AgentSessionKind.ENVIRONMENT, workspaceStatus: AgentWorkspaceStatus.FAILED })
      )
    ).toBe(false);
  });

  it('blocks every session whose chat runtime is not ready', () => {
    const value = session({ chatStatus: AgentChatStatus.ERROR });

    expect(canSessionAcceptMessages(value)).toBe(false);
    expect(getSessionMessageBlockReason(value)).toBe('This session is no longer available for new messages.');
  });

  it.each([
    session({ sessionKind: AgentSessionKind.ENVIRONMENT, workspaceStatus: AgentWorkspaceStatus.PROVISIONING }),
    session({
      status: 'starting',
      sessionKind: AgentSessionKind.ENVIRONMENT,
      workspaceStatus: AgentWorkspaceStatus.NONE,
    }),
  ])('asks callers to wait while an environment session is still starting', (value) => {
    expect(getSessionMessageBlockReason(value)).toBe(
      'Wait for the session to finish starting before sending a message.'
    );
  });
});
