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

const mockAgentSessionQuery = jest.fn();
const mockAgentThreadQuery = jest.fn();

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentSessionQuery(...args),
  },
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentThreadQuery(...args),
  },
}));

import AgentThreadService from 'server/services/agent/ThreadService';

describe('AgentThreadService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retries a conflicting default-thread insert by returning the concurrent winner', async () => {
    const session = { id: 17, uuid: 'session-1', userId: 'user-123' };
    const existingThread = { uuid: 'thread-1', sessionId: 17, isDefault: true };

    mockAgentSessionQuery.mockReturnValueOnce({
      findOne: jest.fn().mockResolvedValue(session),
    });
    mockAgentThreadQuery
      .mockReturnValueOnce({
        findOne: jest.fn().mockResolvedValue(null),
      })
      .mockReturnValueOnce({
        insertAndFetch: jest.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint')),
      })
      .mockReturnValueOnce({
        findOne: jest.fn().mockResolvedValue(existingThread),
      });

    await expect(AgentThreadService.getDefaultThreadForSession('session-1', 'user-123')).resolves.toBe(existingThread);
  });

  it('creates a default thread before listing threads for a session', async () => {
    const session = { id: 17, uuid: 'session-1', userId: 'user-123' };
    const createdThread = { uuid: 'thread-1', sessionId: 17, isDefault: true, archivedAt: null };
    const listedThreads = [createdThread];

    mockAgentSessionQuery
      .mockReturnValueOnce({
        findOne: jest.fn().mockResolvedValue(session),
      })
      .mockReturnValueOnce({
        findOne: jest.fn().mockResolvedValue(session),
      });
    mockAgentThreadQuery
      .mockReturnValueOnce({
        findOne: jest.fn().mockResolvedValue(null),
      })
      .mockReturnValueOnce({
        insertAndFetch: jest.fn().mockResolvedValue(createdThread),
      })
      .mockReturnValueOnce(
        (() => {
          const query = {
            where: jest.fn(() => query),
            whereNull: jest.fn(() => query),
            orderBy: jest
              .fn()
              .mockImplementationOnce(() => query)
              .mockImplementationOnce(() => Promise.resolve(listedThreads)),
          };

          return query;
        })()
      );

    await expect(AgentThreadService.listThreadsForSession('session-1', 'user-123')).resolves.toEqual(listedThreads);
  });
});
