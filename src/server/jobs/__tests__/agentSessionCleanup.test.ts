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
jest.mock('server/services/agentSession');
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
  })),
}));

import AgentSession from 'server/models/AgentSession';
import AgentSessionService from 'server/services/agentSession';
import { processAgentSessionCleanup } from '../agentSessionCleanup';

describe('agentSessionCleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      .mockImplementationOnce(() => Promise.resolve(activeSessions));

    const startingQuery = { where: jest.fn() };
    startingQuery.where
      .mockImplementationOnce(() => startingQuery)
      .mockImplementationOnce(() => Promise.resolve(startingSessions));

    (AgentSession.query as jest.Mock) = jest.fn().mockReturnValueOnce(activeQuery).mockReturnValueOnce(startingQuery);
    (AgentSessionService.endSession as jest.Mock).mockResolvedValue(undefined);

    await processAgentSessionCleanup();

    expect(AgentSession.query).toHaveBeenCalledTimes(2);
    expect(AgentSessionService.endSession).toHaveBeenCalledTimes(2);
    expect(AgentSessionService.endSession).toHaveBeenNthCalledWith(1, 'active-session');
    expect(AgentSessionService.endSession).toHaveBeenNthCalledWith(2, 'starting-session');
  });
});
