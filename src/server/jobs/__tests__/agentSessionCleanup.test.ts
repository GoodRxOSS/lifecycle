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

jest.mock('server/models/AgentSession');
jest.mock('server/services/agentSession', () => {
  class ActiveAgentRunSuspensionError extends Error {
    constructor() {
      super('Cannot suspend a chat runtime while an agent run is active');
      this.name = 'ActiveAgentRunSuspensionError';
    }
  }

  return {
    __esModule: true,
    ActiveAgentRunSuspensionError,
    default: {
      endSession: jest.fn(),
      suspendChatRuntime: jest.fn(),
    },
  };
});
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
  })),
}));
jest.mock('server/lib/agentSession/runtimeConfig', () => {
  const actual = jest.requireActual('server/lib/agentSession/runtimeConfig');
  return {
    __esModule: true,
    ...actual,
    resolveAgentSessionCleanupConfig: jest.fn().mockResolvedValue({
      activeIdleSuspendMs: 30 * 60 * 1000,
      startingTimeoutMs: 15 * 60 * 1000,
      hibernatedRetentionMs: 24 * 60 * 60 * 1000,
      intervalMs: 5 * 60 * 1000,
      redisTtlSeconds: 7200,
    }),
  };
});

import AgentSession from 'server/models/AgentSession';
import AgentSessionService, { ActiveAgentRunSuspensionError } from 'server/services/agentSession';
import { getLogger } from 'server/lib/logger';
import { processAgentSessionCleanup } from '../agentSessionCleanup';

describe('agentSessionCleanup', () => {
  const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getLogger as jest.Mock).mockReturnValue(mockLogger);
    jest.useFakeTimers().setSystemTime(new Date('2026-03-23T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('cleans up both idle active sessions and stale starting sessions', async () => {
    const activeSessions = [
      {
        id: 1,
        uuid: 'active-session',
        status: 'active',
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:00:00.000Z',
      },
    ];
    const startingSessions = [
      {
        id: 2,
        uuid: 'starting-session',
        status: 'starting',
        lastActivity: '2026-03-23T11:50:00.000Z',
        updatedAt: '2026-03-23T11:40:00.000Z',
      },
    ];

    const activeQuery = { where: jest.fn() };
    activeQuery.where
      .mockImplementationOnce(() => activeQuery)
      .mockImplementationOnce(() => activeQuery)
      .mockImplementationOnce((callback) => {
        callback({
          whereNot: jest.fn().mockReturnValue({
            orWhereNot: jest.fn(),
          }),
        });
        return Promise.resolve(activeSessions);
      });

    const startingQuery = { where: jest.fn() };
    startingQuery.where
      .mockImplementationOnce(() => startingQuery)
      .mockImplementationOnce(() => Promise.resolve(startingSessions));

    const suspendedQuery = { where: jest.fn() };
    suspendedQuery.where
      .mockImplementationOnce(() => suspendedQuery)
      .mockImplementationOnce(() => suspendedQuery)
      .mockImplementationOnce(() => suspendedQuery)
      .mockImplementationOnce(() => Promise.resolve([]));

    (AgentSession.query as jest.Mock) = jest
      .fn()
      .mockReturnValueOnce(activeQuery)
      .mockReturnValueOnce(startingQuery)
      .mockReturnValueOnce(suspendedQuery);
    (AgentSessionService.endSession as jest.Mock).mockResolvedValue(undefined);

    await processAgentSessionCleanup();

    expect(AgentSession.query).toHaveBeenCalledTimes(3);
    expect(AgentSessionService.endSession).toHaveBeenCalledTimes(2);
    expect(AgentSessionService.endSession).toHaveBeenNthCalledWith(1, 'active-session');
    expect(AgentSessionService.endSession).toHaveBeenNthCalledWith(2, 'starting-session');
  });

  it('suspends idle chat runtimes before terminal cleanup', async () => {
    const activeSessions = [
      {
        id: 1,
        uuid: 'chat-session',
        userId: 'sample-user',
        sessionKind: 'chat',
        workspaceStatus: 'ready',
        status: 'active',
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:00:00.000Z',
      },
    ];

    const activeQuery = { where: jest.fn() };
    activeQuery.where
      .mockImplementationOnce(() => activeQuery)
      .mockImplementationOnce(() => activeQuery)
      .mockImplementationOnce((callback) => {
        callback({
          whereNot: jest.fn().mockReturnValue({
            orWhereNot: jest.fn(),
          }),
        });
        return Promise.resolve(activeSessions);
      });

    const emptyTwoWhereQuery = { where: jest.fn() };
    emptyTwoWhereQuery.where
      .mockImplementationOnce(() => emptyTwoWhereQuery)
      .mockImplementationOnce(() => Promise.resolve([]));

    const emptyFourWhereQuery = { where: jest.fn() };
    emptyFourWhereQuery.where
      .mockImplementationOnce(() => emptyFourWhereQuery)
      .mockImplementationOnce(() => emptyFourWhereQuery)
      .mockImplementationOnce(() => emptyFourWhereQuery)
      .mockImplementationOnce(() => Promise.resolve([]));

    (AgentSession.query as jest.Mock) = jest
      .fn()
      .mockReturnValueOnce(activeQuery)
      .mockReturnValueOnce(emptyTwoWhereQuery)
      .mockReturnValueOnce(emptyFourWhereQuery);
    (AgentSessionService.suspendChatRuntime as jest.Mock).mockResolvedValue(undefined);

    await processAgentSessionCleanup();

    expect(AgentSessionService.suspendChatRuntime).toHaveBeenCalledWith({
      sessionId: 'chat-session',
      userId: 'sample-user',
    });
    expect(AgentSessionService.endSession).not.toHaveBeenCalled();
  });

  it('skips idle chat suspension when a run is still active', async () => {
    const activeSessions = [
      {
        id: 1,
        uuid: 'chat-session',
        userId: 'sample-user',
        sessionKind: 'chat',
        workspaceStatus: 'ready',
        status: 'active',
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:00:00.000Z',
      },
    ];

    const activeQuery = { where: jest.fn() };
    activeQuery.where
      .mockImplementationOnce(() => activeQuery)
      .mockImplementationOnce(() => activeQuery)
      .mockImplementationOnce((callback) => {
        callback({
          whereNot: jest.fn().mockReturnValue({
            orWhereNot: jest.fn(),
          }),
        });
        return Promise.resolve(activeSessions);
      });

    const emptyTwoWhereQuery = { where: jest.fn() };
    emptyTwoWhereQuery.where
      .mockImplementationOnce(() => emptyTwoWhereQuery)
      .mockImplementationOnce(() => Promise.resolve([]));

    const emptyFourWhereQuery = { where: jest.fn() };
    emptyFourWhereQuery.where
      .mockImplementationOnce(() => emptyFourWhereQuery)
      .mockImplementationOnce(() => emptyFourWhereQuery)
      .mockImplementationOnce(() => emptyFourWhereQuery)
      .mockImplementationOnce(() => Promise.resolve([]));

    (AgentSession.query as jest.Mock) = jest
      .fn()
      .mockReturnValueOnce(activeQuery)
      .mockReturnValueOnce(emptyTwoWhereQuery)
      .mockReturnValueOnce(emptyFourWhereQuery);
    (AgentSessionService.suspendChatRuntime as jest.Mock).mockRejectedValue(new ActiveAgentRunSuspensionError());

    await processAgentSessionCleanup();

    expect(AgentSessionService.suspendChatRuntime).toHaveBeenCalledWith({
      sessionId: 'chat-session',
      userId: 'sample-user',
    });
    expect(AgentSessionService.endSession).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('Session: cleanup skipped sessionId=chat-session reason=active_run');
  });
});
