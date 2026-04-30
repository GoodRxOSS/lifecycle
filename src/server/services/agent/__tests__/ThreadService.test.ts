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

  it.each(['ended', 'error'])('blocks new threads for %s sessions', async (status) => {
    mockAgentSessionQuery.mockReturnValueOnce({
      findOne: jest.fn().mockResolvedValue({
        id: 17,
        uuid: 'session-1',
        userId: 'user-123',
        status,
      }),
    });

    await expect(AgentThreadService.createThread('session-1', 'user-123', 'New chat')).rejects.toThrow(
      'Cannot create a thread for an inactive session'
    );
    expect(mockAgentThreadQuery).not.toHaveBeenCalled();
  });

  it('blocks new threads when the session runtime cannot accept messages', async () => {
    mockAgentSessionQuery.mockReturnValueOnce({
      findOne: jest.fn().mockResolvedValue({
        id: 17,
        uuid: 'session-1',
        userId: 'user-123',
        status: 'active',
        sessionKind: 'environment',
        chatStatus: 'ready',
        workspaceStatus: 'failed',
      }),
    });

    await expect(AgentThreadService.createThread('session-1', 'user-123', 'New chat')).rejects.toThrow(
      'This session is no longer available for new messages.'
    );
    expect(mockAgentThreadQuery).not.toHaveBeenCalled();
  });

  it('creates new threads when the session can accept messages', async () => {
    const createdThread = { uuid: 'thread-2', sessionId: 17, isDefault: false };
    const insertAndFetch = jest.fn().mockResolvedValue(createdThread);

    mockAgentSessionQuery.mockReturnValueOnce({
      findOne: jest.fn().mockResolvedValue({
        id: 17,
        uuid: 'session-1',
        userId: 'user-123',
        status: 'active',
        sessionKind: 'chat',
        chatStatus: 'ready',
        workspaceStatus: 'none',
      }),
    });
    mockAgentThreadQuery.mockReturnValueOnce({
      insertAndFetch,
    });

    await expect(AgentThreadService.createThread('session-1', 'user-123', 'New chat')).resolves.toBe(createdThread);
    expect(insertAndFetch).toHaveBeenCalledWith({
      sessionId: 17,
      title: 'New chat',
      isDefault: false,
      metadata: {
        sessionUuid: 'session-1',
      },
    });
  });

  it('reads selected agent definition metadata without agent-definition fallback', () => {
    expect(
      AgentThreadService.getSelectedAgentDefinitionId({
        metadata: { selectedAgentDefinitionId: 'system.debug' },
      } as any)
    ).toBe('system.debug');
    expect(
      AgentThreadService.getSelectedAgentDefinitionId({
        metadata: {},
      } as any)
    ).toBeNull();
  });

  it('builds a scoped selected agent definition metadata patch', () => {
    expect(AgentThreadService.buildSelectedAgentDefinitionMetadataPatch('custom.sample-agent')).toEqual({
      selectedAgentDefinitionId: 'custom.sample-agent',
    });
  });

  it('trims explicit selected agent definition metadata', () => {
    expect(
      AgentThreadService.getSelectedAgentDefinitionId({
        metadata: {
          selectedAgentDefinitionId: ' custom.sample-agent ',
        },
      } as any)
    ).toBe('custom.sample-agent');
    expect(
      AgentThreadService.getSelectedAgentDefinitionId({
        metadata: {
          selectedAgentDefinitionId: ' ',
        },
      } as any)
    ).toBeNull();
  });
});
