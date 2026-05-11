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
const mockAgentSessionTransaction = jest.fn();
const mockAgentThreadQuery = jest.fn();
const mockAgentMessageQuery = jest.fn();
const mockAgentRunQuery = jest.fn();
const mockAgentPendingActionQuery = jest.fn();
const mockAssertNoActiveWorkspaceAction = jest.fn();

jest.mock('server/lib/dependencies', () => ({}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentSessionQuery(...args),
    transaction: (...args: unknown[]) => mockAgentSessionTransaction(...args),
  },
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentThreadQuery(...args),
  },
}));

jest.mock('server/models/AgentMessage', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentMessageQuery(...args),
  },
}));

jest.mock('server/models/AgentRun', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentRunQuery(...args),
  },
}));

jest.mock('server/models/AgentPendingAction', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentPendingActionQuery(...args),
  },
}));

jest.mock('../WorkspaceRuntimeStateService', () => ({
  __esModule: true,
  default: {
    assertNoActiveWorkspaceAction: (...args: unknown[]) => mockAssertNoActiveWorkspaceAction(...args),
  },
}));

import AgentThreadService from 'server/services/agent/ThreadService';
import { TERMINAL_RUN_STATUSES } from 'server/services/agent/RunService';

const trx = { trx: true };

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    uuid: 'sample-session',
    userId: 'sample-user',
    status: 'active',
    sessionKind: 'chat',
    chatStatus: 'ready',
    workspaceStatus: 'none',
    defaultThreadId: null,
    ...overrides,
  };
}

function mockOwnedSessionLock(session = buildSession()) {
  const forUpdate = jest.fn().mockResolvedValue(session);
  const findOne = jest.fn().mockReturnValue({ forUpdate });
  mockAgentSessionQuery.mockReturnValueOnce({ findOne });
  return { findOne, forUpdate };
}

function mockActiveRun(activeRun: unknown = null) {
  const query = {
    where: jest.fn(),
    whereNotIn: jest.fn(),
    orderBy: jest.fn(),
    first: jest.fn().mockResolvedValue(activeRun),
  };
  query.where.mockReturnValue(query);
  query.whereNotIn.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  mockAgentRunQuery.mockReturnValueOnce(query);
  return query;
}

function mockPendingAction(pendingAction: unknown = null) {
  const query = {
    alias: jest.fn(),
    joinRelated: jest.fn(),
    where: jest.fn(),
    select: jest.fn(),
    first: jest.fn().mockResolvedValue(pendingAction),
  };
  query.alias.mockReturnValue(query);
  query.joinRelated.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.select.mockReturnValue(query);
  mockAgentPendingActionQuery.mockReturnValueOnce(query);
  return query;
}

function mockThreadFindOne(thread: unknown) {
  const findOne = jest.fn().mockResolvedValue(thread);
  mockAgentThreadQuery.mockReturnValueOnce({ findOne });
  return findOne;
}

function mockThreadInsert(thread: unknown) {
  const insertAndFetch = jest.fn().mockResolvedValue(thread);
  mockAgentThreadQuery.mockReturnValueOnce({ insertAndFetch });
  return insertAndFetch;
}

function mockDefaultThreadDemotion() {
  const query = {
    where: jest.fn(),
    whereNull: jest.fn(),
    patch: jest.fn().mockResolvedValue(1),
  };
  query.where.mockReturnValue(query);
  query.whereNull.mockReturnValue(query);
  mockAgentThreadQuery.mockReturnValueOnce(query);
  return query;
}

function mockDefaultThreadPointerPatch() {
  const patchAndFetchById = jest.fn().mockResolvedValue(buildSession());
  mockAgentSessionQuery.mockReturnValueOnce({ patchAndFetchById });
  return patchAndFetchById;
}

function mockThreadList(threads: unknown[]) {
  const query = {
    where: jest.fn(),
    whereNull: jest.fn(),
    orderBy: jest.fn(),
  };
  query.where.mockReturnValue(query);
  query.whereNull.mockReturnValue(query);
  query.orderBy.mockReturnValueOnce(query).mockResolvedValueOnce(threads);
  mockAgentThreadQuery.mockReturnValueOnce(query);
  return query;
}

function mockMessageRows(rows: unknown[]) {
  const query = {
    whereIn: jest.fn(),
    select: jest.fn().mockResolvedValue(rows),
  };
  query.whereIn.mockReturnValue(query);
  mockAgentMessageQuery.mockReturnValueOnce(query);
  return query;
}

function mockRunRows(rows: unknown[]) {
  const query = {
    whereIn: jest.fn(),
    orderBy: jest.fn(),
  };
  query.whereIn.mockReturnValue(query);
  query.orderBy.mockReturnValueOnce(query).mockResolvedValueOnce(rows);
  mockAgentRunQuery.mockReturnValueOnce(query);
  return query;
}

function mockPendingRows(rows: unknown[]) {
  const query = {
    whereIn: jest.fn(),
    where: jest.fn(),
    select: jest.fn().mockResolvedValue(rows),
  };
  query.whereIn.mockReturnValue(query);
  query.where.mockReturnValue(query);
  mockAgentPendingActionQuery.mockReturnValueOnce(query);
  return query;
}

describe('AgentThreadService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentSessionTransaction.mockImplementation(async (callback) => callback(trx));
    mockAssertNoActiveWorkspaceAction.mockResolvedValue(undefined);
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

  it('prefers the session current-thread pointer over the legacy default-thread marker', async () => {
    const session = { id: 17, uuid: 'sample-session', userId: 'sample-user', defaultThreadId: 31 };
    const currentThread = { id: 31, uuid: 'sample-thread-2', sessionId: 17, isDefault: false };
    const findOne = jest.fn().mockResolvedValue(session);
    const threadFindOne = jest.fn().mockResolvedValue(currentThread);

    mockAgentSessionQuery.mockReturnValueOnce({ findOne });
    mockAgentThreadQuery.mockReturnValueOnce({ findOne: threadFindOne });

    await expect(AgentThreadService.getDefaultThreadForSession('sample-session', 'sample-user')).resolves.toBe(
      currentThread
    );
    expect(threadFindOne).toHaveBeenCalledWith({
      id: 31,
      sessionId: 17,
      archivedAt: null,
    });
    expect(mockAgentThreadQuery).toHaveBeenCalledTimes(1);
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

  it('returns persisted thread history summaries with per-thread counts, latest run, and usage', async () => {
    const session = buildSession({ defaultThreadId: 101 });
    const defaultThread = {
      id: 101,
      uuid: 'sample-thread-default',
      sessionId: 17,
      title: 'Default thread',
      isDefault: true,
      archivedAt: null,
      lastRunAt: '2026-05-09T00:20:00.000Z',
      metadata: {},
      createdAt: '2026-05-09T00:00:00.000Z',
      updatedAt: '2026-05-09T00:20:00.000Z',
    };
    const priorThread = {
      id: 102,
      uuid: 'sample-thread-prior',
      sessionId: 17,
      title: 'Prior thread',
      isDefault: false,
      archivedAt: null,
      lastRunAt: '2026-05-09T00:10:00.000Z',
      metadata: { topic: 'sample' },
      createdAt: '2026-05-09T00:01:00.000Z',
      updatedAt: '2026-05-09T00:11:00.000Z',
    };
    const latestDefaultRun = {
      id: 202,
      uuid: 'sample-run-latest',
      threadId: 101,
      sessionId: 17,
      status: 'completed',
      requestedProvider: null,
      requestedModel: null,
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5',
      provider: 'openai',
      model: 'gpt-5',
      queuedAt: '2026-05-09T00:15:00.000Z',
      startedAt: '2026-05-09T00:16:00.000Z',
      completedAt: '2026-05-09T00:18:00.000Z',
      cancelledAt: null,
      usageSummary: { totalTokens: 11, inputTokens: 7, outputTokens: 4 },
      createdAt: '2026-05-09T00:15:00.000Z',
      updatedAt: '2026-05-09T00:18:00.000Z',
    };
    const olderDefaultRun = {
      ...latestDefaultRun,
      id: 201,
      uuid: 'sample-run-older',
      queuedAt: '2026-05-09T00:05:00.000Z',
      startedAt: '2026-05-09T00:06:00.000Z',
      completedAt: '2026-05-09T00:07:00.000Z',
      usageSummary: { totalTokens: 5 },
      createdAt: '2026-05-09T00:05:00.000Z',
      updatedAt: '2026-05-09T00:07:00.000Z',
    };
    const priorRun = {
      ...latestDefaultRun,
      id: 203,
      uuid: 'sample-run-prior-thread',
      threadId: 102,
      status: 'failed',
      usageSummary: {},
      queuedAt: '2026-05-09T00:08:00.000Z',
      startedAt: '2026-05-09T00:09:00.000Z',
      completedAt: '2026-05-09T00:10:00.000Z',
      createdAt: '2026-05-09T00:08:00.000Z',
      updatedAt: '2026-05-09T00:10:00.000Z',
    };
    mockAgentSessionQuery
      .mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(session) })
      .mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(session) });
    mockThreadFindOne(defaultThread);
    const listQuery = mockThreadList([defaultThread, priorThread]);
    const messageQuery = mockMessageRows([{ threadId: 101 }, { threadId: 101 }, { threadId: 102 }]);
    mockRunRows([latestDefaultRun, priorRun, olderDefaultRun]);
    const pendingQuery = mockPendingRows([{ threadId: 101 }, { threadId: 102 }, { threadId: 102 }]);

    const history = await AgentThreadService.listThreadHistoryForSession('sample-session', 'sample-user');

    expect(listQuery.where).toHaveBeenCalledWith({ sessionId: 17 });
    expect(listQuery.whereNull).toHaveBeenCalledWith('archivedAt');
    expect(listQuery.orderBy).toHaveBeenNthCalledWith(1, 'isDefault', 'desc');
    expect(listQuery.orderBy).toHaveBeenNthCalledWith(2, 'createdAt', 'asc');
    expect(messageQuery.whereIn).toHaveBeenCalledWith('threadId', [101, 102]);
    expect(pendingQuery.where).toHaveBeenCalledWith('status', 'pending');
    expect(history).toEqual([
      expect.objectContaining({
        id: 'sample-thread-default',
        sessionId: 'sample-session',
        isDefault: true,
        summary: {
          messageCount: 2,
          runCount: 2,
          pendingActionsCount: 1,
          latestRun: {
            id: 'sample-run-latest',
            status: 'completed',
            requestedProvider: null,
            requestedModel: null,
            resolvedProvider: 'openai',
            resolvedModel: 'gpt-5',
            provider: 'openai',
            model: 'gpt-5',
            queuedAt: '2026-05-09T00:15:00.000Z',
            startedAt: '2026-05-09T00:16:00.000Z',
            completedAt: '2026-05-09T00:18:00.000Z',
            cancelledAt: null,
            usageSummary: { totalTokens: 11, inputTokens: 7, outputTokens: 4 },
            createdAt: '2026-05-09T00:15:00.000Z',
            updatedAt: '2026-05-09T00:18:00.000Z',
          },
          lastActivityAt: '2026-05-09T00:20:00.000Z',
          usage: expect.objectContaining({
            usageSummary: {
              totalTokens: 16,
              inputTokens: 7,
              outputTokens: 4,
            },
            usageCompleteness: {
              runCount: 2,
              reportedRunCount: 2,
              missingUsageRunCount: 0,
              complete: true,
            },
          }),
        },
      }),
      expect.objectContaining({
        id: 'sample-thread-prior',
        summary: expect.objectContaining({
          messageCount: 1,
          runCount: 1,
          pendingActionsCount: 2,
          latestRun: expect.objectContaining({ id: 'sample-run-prior-thread', status: 'failed' }),
          usage: expect.objectContaining({
            usageSummary: { totalTokens: 0 },
            usageCompleteness: {
              runCount: 1,
              reportedRunCount: 0,
              missingUsageRunCount: 1,
              complete: false,
            },
          }),
        }),
      }),
    ]);
  });

  it('returns safe history metadata for non-archived threads without runs', async () => {
    const session = buildSession({ defaultThreadId: 101 });
    const defaultThread = {
      id: 101,
      uuid: 'sample-thread-default',
      sessionId: 17,
      title: 'Default thread',
      isDefault: true,
      archivedAt: null,
      lastRunAt: null,
      metadata: {},
      createdAt: '2026-05-09T00:00:00.000Z',
      updatedAt: '2026-05-09T00:02:00.000Z',
    };
    mockAgentSessionQuery
      .mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(session) })
      .mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(session) });
    mockThreadFindOne(defaultThread);
    const listQuery = mockThreadList([defaultThread]);
    mockMessageRows([]);
    mockRunRows([]);
    mockPendingRows([]);

    const history = await AgentThreadService.listThreadHistoryForSession('sample-session', 'sample-user');

    expect(listQuery.whereNull).toHaveBeenCalledWith('archivedAt');
    expect(history).toEqual([
      expect.objectContaining({
        id: 'sample-thread-default',
        archivedAt: null,
        summary: {
          messageCount: 0,
          runCount: 0,
          pendingActionsCount: 0,
          latestRun: null,
          lastActivityAt: '2026-05-09T00:02:00.000Z',
          usage: {
            usageSummary: { totalTokens: 0 },
            usageByModel: [],
            usageCompleteness: {
              runCount: 0,
              reportedRunCount: 0,
              missingUsageRunCount: 0,
              complete: true,
            },
          },
        },
      }),
    ]);
  });

  it.each(['ended', 'error'])('blocks new threads for %s sessions', async (status) => {
    mockOwnedSessionLock(buildSession({ status }));

    await expect(AgentThreadService.createThread('sample-session', 'sample-user', 'New chat')).rejects.toThrow(
      'Cannot create a thread for an inactive session'
    );
    expect(mockAgentThreadQuery).not.toHaveBeenCalled();
  });

  it('blocks new threads when the session runtime cannot accept messages', async () => {
    mockOwnedSessionLock(
      buildSession({
        sessionKind: 'environment',
        workspaceStatus: 'failed',
      })
    );

    await expect(AgentThreadService.createThread('sample-session', 'sample-user', 'New chat')).rejects.toThrow(
      'This session is no longer available for new messages.'
    );
    expect(mockAgentThreadQuery).not.toHaveBeenCalled();
  });

  it('creates new threads when the session can accept messages and updates the current thread pointer', async () => {
    const createdThread = { id: 31, uuid: 'sample-thread-2', sessionId: 17, isDefault: true };
    mockOwnedSessionLock();
    const activeRunQuery = mockActiveRun();
    const pendingActionQuery = mockPendingAction();
    const demotionQuery = mockDefaultThreadDemotion();
    const insertAndFetch = mockThreadInsert(createdThread);
    const patchAndFetchById = mockDefaultThreadPointerPatch();

    await expect(AgentThreadService.createThread('sample-session', 'sample-user', 'New chat')).resolves.toBe(
      createdThread
    );
    expect(activeRunQuery.whereNotIn).toHaveBeenCalledWith('status', TERMINAL_RUN_STATUSES);
    expect(pendingActionQuery.joinRelated).toHaveBeenCalledWith('thread');
    expect(pendingActionQuery.where).toHaveBeenCalledWith('thread.sessionId', 17);
    expect(pendingActionQuery.where).toHaveBeenCalledWith('pendingAction.status', 'pending');
    expect(mockAssertNoActiveWorkspaceAction).toHaveBeenCalledWith(17, { trx });
    expect(demotionQuery.where).toHaveBeenCalledWith({ sessionId: 17, isDefault: true });
    expect(demotionQuery.whereNull).toHaveBeenCalledWith('archivedAt');
    expect(demotionQuery.patch).toHaveBeenCalledWith({ isDefault: false });
    expect(insertAndFetch).toHaveBeenCalledWith({
      sessionId: 17,
      title: 'New chat',
      isDefault: true,
      metadata: {
        sessionUuid: 'sample-session',
      },
    });
    expect(patchAndFetchById).toHaveBeenCalledWith(17, {
      defaultThreadId: 31,
    });
  });

  it('copies only safe selected-agent and runtime-control metadata from an explicit same-session source thread', async () => {
    const sourceThread = {
      id: 23,
      uuid: 'sample-source-thread',
      sessionId: 17,
      archivedAt: null,
      metadata: {
        selectedAgentDefinitionId: ' custom.sample-agent ',
        runtimeControlChoices: {
          version: 1,
          toolChoiceIds: ['tool-choice-1'],
          mcpChoiceIds: ['mcp-choice-1'],
        },
        latestRunId: 'sample-run',
        adminEvidence: { hidden: true },
      },
    };
    const createdThread = { id: 31, uuid: 'sample-thread-2', sessionId: 17, isDefault: true };
    mockOwnedSessionLock();
    mockActiveRun();
    mockPendingAction();
    const findOne = mockThreadFindOne(sourceThread);
    const demotionQuery = mockDefaultThreadDemotion();
    const insertAndFetch = mockThreadInsert(createdThread);
    mockDefaultThreadPointerPatch();

    await expect(
      AgentThreadService.createThread('sample-session', 'sample-user', {
        title: '  New chat  ',
        sourceThreadId: ' sample-source-thread ',
      })
    ).resolves.toBe(createdThread);

    expect(findOne).toHaveBeenCalledWith({
      uuid: 'sample-source-thread',
      sessionId: 17,
      archivedAt: null,
    });
    expect(insertAndFetch).toHaveBeenCalledWith({
      sessionId: 17,
      title: 'New chat',
      isDefault: true,
      metadata: {
        sessionUuid: 'sample-session',
        selectedAgentDefinitionId: 'custom.sample-agent',
        runtimeControlChoices: {
          version: 1,
          toolChoiceIds: ['tool-choice-1'],
          mcpChoiceIds: ['mcp-choice-1'],
        },
      },
    });
    expect(demotionQuery.patch).toHaveBeenCalledWith({ isDefault: false });
    expect(mockAgentMessageQuery).not.toHaveBeenCalled();
    expect(mockAgentRunQuery).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(insertAndFetch.mock.calls[0][0])).not.toContain('latestRunId');
    expect(JSON.stringify(insertAndFetch.mock.calls[0][0])).not.toContain('adminEvidence');
  });

  it('falls back to the current default thread metadata when no source thread is supplied', async () => {
    const defaultThread = {
      id: 23,
      uuid: 'sample-current-thread',
      sessionId: 17,
      archivedAt: null,
      metadata: {
        selectedAgentDefinitionId: 'system.develop',
        runtimeControlChoices: {
          version: 1,
          toolChoiceIds: ['tool-choice-1'],
          mcpChoiceIds: [],
        },
        arbitraryMetadata: 'do-not-copy',
      },
    };
    const createdThread = { id: 31, uuid: 'sample-thread-2', sessionId: 17, isDefault: true };
    mockOwnedSessionLock(buildSession({ defaultThreadId: 23 }));
    mockActiveRun();
    mockPendingAction();
    const findOne = mockThreadFindOne(defaultThread);
    mockDefaultThreadDemotion();
    const insertAndFetch = mockThreadInsert(createdThread);
    mockDefaultThreadPointerPatch();

    await expect(AgentThreadService.createThread('sample-session', 'sample-user', 'New chat')).resolves.toBe(
      createdThread
    );

    expect(findOne).toHaveBeenCalledWith({
      id: 23,
      sessionId: 17,
      archivedAt: null,
    });
    expect(insertAndFetch).toHaveBeenCalledWith({
      sessionId: 17,
      title: 'New chat',
      isDefault: true,
      metadata: {
        sessionUuid: 'sample-session',
        selectedAgentDefinitionId: 'system.develop',
        runtimeControlChoices: {
          version: 1,
          toolChoiceIds: ['tool-choice-1'],
          mcpChoiceIds: [],
        },
      },
    });
    expect(JSON.stringify(insertAndFetch.mock.calls[0][0])).not.toContain('arbitraryMetadata');
  });

  it('rejects source threads that are not active threads in the same session', async () => {
    mockOwnedSessionLock();
    mockActiveRun();
    mockPendingAction();
    mockThreadFindOne(null);

    await expect(
      AgentThreadService.createThread('sample-session', 'sample-user', {
        title: 'New chat',
        sourceThreadId: 'sample-other-thread',
      })
    ).rejects.toThrow('Source agent thread not found');

    expect(mockAgentThreadQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects new threads while a session run is nonterminal', async () => {
    mockOwnedSessionLock();
    const activeRunQuery = mockActiveRun({ id: 41, uuid: 'sample-run', status: 'running' });

    await expect(AgentThreadService.createThread('sample-session', 'sample-user', 'New chat')).rejects.toThrow(
      'Wait for the current agent run to finish before starting a new thread.'
    );

    expect(activeRunQuery.whereNotIn).toHaveBeenCalledWith('status', TERMINAL_RUN_STATUSES);
    expect(mockAgentPendingActionQuery).not.toHaveBeenCalled();
    expect(mockAssertNoActiveWorkspaceAction).not.toHaveBeenCalled();
    expect(mockAgentThreadQuery).not.toHaveBeenCalled();
  });

  it('rejects new threads while any thread in the same session has a pending action', async () => {
    mockOwnedSessionLock();
    mockActiveRun();
    mockPendingAction({ id: 51, uuid: 'sample-pending-action', status: 'pending' });

    await expect(AgentThreadService.createThread('sample-session', 'sample-user', 'New chat')).rejects.toThrow(
      'Resolve pending approvals before starting a new thread.'
    );

    expect(mockAssertNoActiveWorkspaceAction).not.toHaveBeenCalled();
    expect(mockAgentThreadQuery).not.toHaveBeenCalled();
  });

  it('rejects new threads while a workspace lifecycle action is active', async () => {
    const blocked = new Error('Wait for the current workspace action to finish before starting another action.');
    mockOwnedSessionLock();
    mockActiveRun();
    mockPendingAction();
    mockAssertNoActiveWorkspaceAction.mockRejectedValueOnce(blocked);

    await expect(AgentThreadService.createThread('sample-session', 'sample-user', 'New chat')).rejects.toBe(blocked);

    expect(mockAssertNoActiveWorkspaceAction).toHaveBeenCalledWith(17, { trx });
    expect(mockAgentThreadQuery).not.toHaveBeenCalled();
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
