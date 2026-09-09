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

const mockEnrichSessions = jest.fn();
const mockListThreadFeedback = jest.fn();
const mockSessionQuery = jest.fn();
const mockThreadQuery = jest.fn();
const mockPendingActionQuery = jest.fn();
const mockMessageQuery = jest.fn();
const mockRunQuery = jest.fn();
const mockRunEventQuery = jest.fn();
const mockToolExecutionQuery = jest.fn();
const mockMcpServerConfigQuery = jest.fn();
const mockUserMcpConnectionQuery = jest.fn();
const mockSerializeRun = jest.fn();
const mockSerializeRunEvent = jest.fn();
const mockSerializeThread = jest.fn();
const mockSerializeCanonicalMessage = jest.fn();
const mockListMaskedUsersForServer = jest.fn();

const canonicalStartupFailure = {
  stage: 'connect_runtime',
  title: 'Session workspace pod failed to start',
  message: 'init-workspace: ImagePullBackOff',
  recordedAt: '2026-04-05T18:30:00.000Z',
  retryable: false,
  origin: 'agent_session',
};

jest.mock('../FeedbackService', () => ({
  __esModule: true,
  default: { listThreadFeedback: (...args: unknown[]) => mockListThreadFeedback(...args) },
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    enrichSessions: (...args: unknown[]) => mockEnrichSessions(...args),
  },
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockSessionQuery(...args),
  },
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockThreadQuery(...args),
  },
}));

jest.mock('server/models/AgentPendingAction', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockPendingActionQuery(...args),
  },
}));

jest.mock('server/models/AgentMessage', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockMessageQuery(...args),
  },
}));

jest.mock('server/models/AgentRun', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockRunQuery(...args),
  },
}));

jest.mock('server/models/AgentRunEvent', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockRunEventQuery(...args),
  },
}));

jest.mock('server/models/AgentToolExecution', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockToolExecutionQuery(...args),
  },
}));

jest.mock('server/models/McpServerConfig', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockMcpServerConfigQuery(...args),
  },
}));

jest.mock('server/models/UserMcpConnection', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockUserMcpConnectionQuery(...args),
  },
}));

jest.mock('server/services/userMcpConnection', () => ({
  __esModule: true,
  default: {
    listMaskedUsersForServer: (...args: unknown[]) => mockListMaskedUsersForServer(...args),
  },
}));

jest.mock('../RunService', () => ({
  __esModule: true,
  default: {
    serializeRun: (...args: unknown[]) => mockSerializeRun(...args),
  },
}));

jest.mock('../RunEventService', () => ({
  __esModule: true,
  default: {
    serializeRunEvent: (...args: unknown[]) => mockSerializeRunEvent(...args),
  },
}));

jest.mock('../ThreadService', () => ({
  __esModule: true,
  default: {
    serializeThread: (...args: unknown[]) => mockSerializeThread(...args),
  },
}));

jest.mock('../MessageStore', () => ({
  __esModule: true,
  default: {
    serializeCanonicalMessage: (...args: unknown[]) => mockSerializeCanonicalMessage(...args),
  },
}));

import AgentAdminService from '../AdminService';

describe('AgentAdminService.listSessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListThreadFeedback.mockResolvedValue([]);
  });

  it('excludes empty and system-only histories before enrichment, counts, and pagination while retaining first questions', async () => {
    const sessions = [
      { id: 1, uuid: 'no-threads' },
      { id: 2, uuid: 'empty-thread' },
      { id: 3, uuid: 'system-events-only' },
      { id: 4, uuid: 'empty-assistant-placeholder' },
      { id: 5, uuid: 'first-user-question' },
      { id: 6, uuid: 'multiple-conversations' },
      { id: 7, uuid: 'assistant-history' },
    ].map((session) => ({ ...session, services: [], workspaceRepos: [], selectedServices: [] }));
    const threads = [
      { id: 20, sessionId: 2 },
      { id: 30, sessionId: 3 },
      { id: 40, sessionId: 4 },
      { id: 50, sessionId: 5 },
      { id: 60, sessionId: 6 },
      { id: 61, sessionId: 6 },
      { id: 70, sessionId: 7 },
    ];
    const messages = [
      { threadId: 30, role: 'system', parts: [{ type: 'text', text: 'Environment is ready' }] },
      { threadId: 40, role: 'assistant', parts: [] },
      { threadId: 50, role: 'user', parts: [{ type: 'text', text: 'Why did the build fail?' }] },
      { threadId: 60, role: 'user', parts: [{ type: 'text', text: 'Inspect this deployment.' }] },
      { threadId: 60, role: 'assistant', parts: [{ type: 'text', text: 'The container failed to start.' }] },
      { threadId: 61, role: 'user', parts: [{ type: 'text', text: 'What should I change?' }] },
      { threadId: 70, role: 'assistant', parts: [{ type: 'text', text: 'Here is the investigation.' }] },
    ];
    let hasHistoryFilter = false;
    const sessionQuery = {
      whereRaw: jest.fn((sql: string, roles: string[]) => {
        expect(sql).toContain('EXISTS (');
        expect(sql).toContain('history_message."threadId" = history_thread.id');
        expect(sql).toContain('history_thread."sessionId" = agent_sessions.id');
        expect(sql).toContain('history_message.role IN (?, ?)');
        expect(sql).toContain('jsonb_array_length(history_message.parts) > 0');
        expect(roles).toEqual(['user', 'assistant']);
        hasHistoryFilter = true;
        return sessionQuery;
      }),
      orderBy: jest.fn().mockReturnThis(),
      then: (resolve: (value: unknown[]) => unknown) =>
        Promise.resolve(
          hasHistoryFilter
            ? sessions.filter((session) =>
                threads.some(
                  (thread) =>
                    thread.sessionId === session.id &&
                    messages.some(
                      (message) =>
                        message.threadId === thread.id &&
                        ['user', 'assistant'].includes(message.role) &&
                        message.parts.length > 0
                    )
                )
              )
            : sessions
        ).then(resolve),
    };
    mockSessionQuery.mockReturnValue(sessionQuery);
    mockEnrichSessions.mockImplementation(async (rows) => rows);
    const threadWhereIn = jest.fn().mockReturnThis();
    mockThreadQuery.mockReturnValue({ whereIn: threadWhereIn, select: jest.fn().mockResolvedValue(threads.slice(3)) });
    mockPendingActionQuery.mockReturnValue({
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([]),
    });

    for (const [index, id] of ['first-user-question', 'multiple-conversations', 'assistant-history'].entries()) {
      const result = await AgentAdminService.listSessions({ page: index + 1, limit: 1 });

      expect(result.data.map((session) => session.id)).toEqual([id]);
      expect(result.metadata.pagination).toEqual({ current: index + 1, total: 3, items: 3, limit: 1 });
      expect(mockEnrichSessions).toHaveBeenLastCalledWith(sessions.slice(4));
      expect(threadWhereIn).toHaveBeenLastCalledWith('sessionId', [5, 6, 7]);
    }
    const pastLastPage = await AgentAdminService.listSessions({ page: 4, limit: 1 });
    expect(pastLastPage.data).toEqual([]);
    expect(pastLastPage.metadata.pagination).toEqual({ current: 4, total: 3, items: 3, limit: 1 });
  });

  it('returns zero history count when the database excludes every empty session', async () => {
    const sessionQuery = {
      whereRaw: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
    };
    mockSessionQuery.mockReturnValue(sessionQuery);
    mockEnrichSessions.mockResolvedValue([]);

    const result = await AgentAdminService.listSessions({ page: 1, limit: 25 });

    expect(result).toEqual({
      data: [],
      metadata: { pagination: { current: 1, total: 1, items: 0, limit: 25 } },
    });
    expect(mockThreadQuery).not.toHaveBeenCalled();
    expect(mockPendingActionQuery).not.toHaveBeenCalled();
  });

  it('links the latest populated conversation with deterministic ties and retains archived history', async () => {
    const session = { id: 101, uuid: 'review-session', services: [], workspaceRepos: [], selectedServices: [] };
    const sessionQuery = {
      whereRaw: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([session]).then(resolve),
    };
    mockSessionQuery.mockReturnValue(sessionQuery);
    mockEnrichSessions.mockResolvedValue([session]);
    const threads = [
      {
        id: 1,
        uuid: 'old-run',
        title: 'Earlier diagnosis',
        sessionId: 101,
        lastRunAt: '2026-04-01T00:00:00Z',
        hasConversation: true,
      },
      {
        id: 5,
        uuid: 'tie-lower',
        title: 'Earlier creation',
        sessionId: 101,
        createdAt: '2026-04-02T00:00:00Z',
        hasConversation: true,
      },
      {
        id: 6,
        uuid: 'latest',
        title: 'New conversation',
        sessionId: 101,
        createdAt: '2026-04-02T00:00:00Z',
        hasConversation: true,
      },
      {
        id: 8,
        uuid: 'archived',
        title: 'Archived',
        sessionId: 101,
        updatedAt: '2026-04-01T00:00:00Z',
        archivedAt: '2026-04-01T00:00:00Z',
        hasConversation: true,
      },
      {
        id: 9,
        uuid: 'empty',
        title: 'Empty latest conversation',
        sessionId: 101,
        updatedAt: '2026-04-04T00:00:00Z',
        hasConversation: false,
      },
    ];
    const threadSelect = jest.fn().mockResolvedValue(threads);
    mockThreadQuery.mockReturnValue({ whereIn: jest.fn().mockReturnThis(), select: threadSelect });
    mockPendingActionQuery.mockReturnValue({
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([]),
    });

    const result = await AgentAdminService.listSessions({});
    expect(result.data[0]).toEqual(
      expect.objectContaining({ latestThreadId: 'latest', latestThreadTitle: 'New conversation' })
    );
    threadSelect.mockResolvedValue(threads.slice().reverse());
    expect((await AgentAdminService.listSessions({})).data[0]).toEqual(
      expect.objectContaining({ latestThreadId: 'latest', latestThreadTitle: 'New conversation' })
    );
    threadSelect.mockResolvedValue([threads[3]]);
    expect((await AgentAdminService.listSessions({})).data[0]).toEqual(
      expect.objectContaining({ latestThreadId: 'archived', latestThreadTitle: 'Archived' })
    );
    threadSelect.mockResolvedValue([threads[4]]);
    expect((await AgentAdminService.listSessions({})).data[0]).toEqual(
      expect.objectContaining({ latestThreadId: null, latestThreadTitle: null, threadCount: 1 })
    );
  });

  it('uses internal numeric session ids for thread and approval queries while returning public uuids', async () => {
    const rawSessions = [
      {
        id: 101,
        uuid: 'eda50b6f-f421-42c4-8d7e-7b38d1c7c362',
        buildUuid: 'sample-build-1',
        buildKind: 'environment',
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        podName: 'agent-eda50b6f',
        namespace: 'env-sample',
        pvcName: 'sample-pvc',
        model: 'claude-sonnet-4-5',
        status: 'active',
        selectedServices: [],
        workspaceRepos: [],
        devModeSnapshots: {},
      },
      {
        id: 202,
        uuid: '3e81553b-b8d4-4d2b-88d0-8d5775bcffde',
        buildUuid: 'sample-build-2',
        buildKind: 'environment',
        userId: 'sample-user-2',
        ownerGithubUsername: 'sample-user-2',
        podName: 'agent-3e81553b',
        namespace: 'env-sample',
        pvcName: 'sample-pvc-2',
        model: 'claude-sonnet-4-5',
        status: 'starting',
        selectedServices: [],
        workspaceRepos: [],
        devModeSnapshots: {},
      },
    ];

    const sessionQueryBuilder = {
      whereRaw: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest
        .fn()
        .mockImplementationOnce(() => sessionQueryBuilder)
        .mockImplementationOnce(() => Promise.resolve(rawSessions)),
    };
    mockSessionQuery.mockReturnValue(sessionQueryBuilder);

    mockEnrichSessions.mockResolvedValue([
      {
        ...rawSessions[0],
        id: rawSessions[0].uuid,
        repo: 'example-org/example-repo',
        primaryRepo: 'example-org/example-repo',
        services: [],
        startupFailure: canonicalStartupFailure,
      },
      {
        ...rawSessions[1],
        id: rawSessions[1].uuid,
        repo: 'example-org/example-repo',
        primaryRepo: 'example-org/example-repo',
        services: [],
        startupFailure: null,
      },
    ]);

    const threadWhereIn = jest.fn().mockReturnThis();
    const threadSelect = jest.fn().mockResolvedValue([{ sessionId: 101, lastRunAt: '2026-04-05T18:00:00.000Z' }]);
    mockThreadQuery.mockReturnValue({
      whereIn: threadWhereIn,
      select: threadSelect,
    });

    const pendingWhereIn = jest.fn().mockReturnThis();
    const pendingWhere = jest.fn().mockReturnThis();
    const pendingSelect = jest.fn().mockResolvedValue([{ sessionId: 101 }]);
    mockPendingActionQuery.mockReturnValue({
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      whereIn: pendingWhereIn,
      where: pendingWhere,
      select: pendingSelect,
    });

    const result = await AgentAdminService.listSessions({});

    expect(threadWhereIn).toHaveBeenCalledWith('sessionId', [101, 202]);
    expect(pendingWhereIn).toHaveBeenCalledWith('thread.sessionId', [101, 202]);
    expect(result.data).toEqual([
      expect.objectContaining({
        id: 'eda50b6f-f421-42c4-8d7e-7b38d1c7c362',
        threadCount: 1,
        pendingActionsCount: 1,
        lastRunAt: '2026-04-05T18:00:00.000Z',
        startupFailure: canonicalStartupFailure,
      }),
      expect.objectContaining({
        id: '3e81553b-b8d4-4d2b-88d0-8d5775bcffde',
        threadCount: 0,
        pendingActionsCount: 0,
        lastRunAt: null,
      }),
    ]);
  });

  it('applies database and enriched repository filters before loading aggregate counts', async () => {
    const rawSessions = [
      {
        id: 101,
        uuid: 'session-payments',
        status: 'active',
        buildUuid: 'build-payments',
        userId: 'sample-user',
        ownerGithubUsername: 'Sample-GitHub',
        podName: null,
        namespace: null,
        workspaceRepos: [],
        selectedServices: [],
      },
      {
        id: 202,
        uuid: 'session-catalog',
        status: 'active',
        buildUuid: 'build-catalog',
        userId: 'other-user',
        ownerGithubUsername: 'other-github',
        podName: null,
        namespace: null,
        workspaceRepos: [],
        selectedServices: [],
      },
    ];
    const userSearchBuilder = {
      whereRaw: jest.fn().mockReturnThis(),
      orWhereRaw: jest.fn().mockReturnThis(),
    };
    const sessionQueryBuilder = {
      whereRaw: jest.fn().mockReturnThis(),
      where: jest.fn((clause: unknown) => {
        if (typeof clause === 'function') {
          clause(userSearchBuilder);
        }
        return sessionQueryBuilder;
      }),
      orderBy: jest
        .fn()
        .mockImplementationOnce(() => sessionQueryBuilder)
        .mockImplementationOnce(() => Promise.resolve(rawSessions)),
    };
    mockSessionQuery.mockReturnValue(sessionQueryBuilder);
    mockEnrichSessions.mockResolvedValue([
      {
        ...rawSessions[0],
        repo: 'example-org/api',
        primaryRepo: 'example-org/api',
        services: ['payments-worker'],
        startupFailure: null,
      },
      {
        ...rawSessions[1],
        repo: 'example-org/catalog',
        primaryRepo: 'example-org/catalog',
        services: ['catalog-worker'],
        startupFailure: null,
      },
    ]);

    const threadWhereIn = jest.fn().mockReturnThis();
    mockThreadQuery.mockReturnValue({
      whereIn: threadWhereIn,
      select: jest.fn().mockResolvedValue([
        { sessionId: 101, lastRunAt: null },
        { sessionId: 101, lastRunAt: '2026-04-05T18:00:00.000Z' },
        { sessionId: 101, lastRunAt: '2026-04-05T20:00:00.000Z' },
        { sessionId: 101, lastRunAt: '2026-04-05T19:00:00.000Z' },
      ]),
    });
    const pendingWhereIn = jest.fn().mockReturnThis();
    mockPendingActionQuery.mockReturnValue({
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      whereIn: pendingWhereIn,
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([{ sessionId: 101 }, { sessionId: 101 }]),
    });

    const result = await AgentAdminService.listSessions({
      status: 'active',
      buildUuid: 'build-payments',
      user: ' SAMPLE ',
      repo: ' PAYMENTS ',
      page: 1,
      limit: 10,
    });

    expect(sessionQueryBuilder.where).toHaveBeenCalledWith({ status: 'active' });
    expect(sessionQueryBuilder.where).toHaveBeenCalledWith({ buildUuid: 'build-payments' });
    expect(userSearchBuilder.whereRaw).toHaveBeenCalledWith('LOWER("userId") like ?', ['%sample%']);
    expect(userSearchBuilder.orWhereRaw).toHaveBeenCalledWith('LOWER(COALESCE("ownerGithubUsername", \'\')) like ?', [
      '%sample%',
    ]);
    expect(threadWhereIn).toHaveBeenCalledWith('sessionId', [101]);
    expect(pendingWhereIn).toHaveBeenCalledWith('thread.sessionId', [101]);
    expect(result).toEqual({
      data: [
        expect.objectContaining({
          id: 'session-payments',
          threadCount: 4,
          pendingActionsCount: 2,
          lastRunAt: '2026-04-05T20:00:00.000Z',
          editorUrl: null,
        }),
      ],
      metadata: {
        pagination: {
          current: 1,
          total: 1,
          items: 1,
          limit: 10,
        },
      },
    });
  });

  it('returns normalized empty pagination without issuing aggregate queries when repository filtering removes every session', async () => {
    const rawSession = {
      id: 101,
      uuid: 'session-1',
      status: 'active',
      workspaceRepos: [],
      selectedServices: [],
    };
    const sessionQueryBuilder = {
      whereRaw: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest
        .fn()
        .mockImplementationOnce(() => sessionQueryBuilder)
        .mockImplementationOnce(() => Promise.resolve([rawSession])),
    };
    mockSessionQuery.mockReturnValue(sessionQueryBuilder);
    mockEnrichSessions.mockResolvedValue([
      {
        ...rawSession,
        repo: 'example-org/catalog',
        primaryRepo: 'example-org/catalog',
        services: [],
        startupFailure: null,
      },
    ]);

    const result = await AgentAdminService.listSessions({
      status: 'all',
      user: '   ',
      repo: 'payments',
      page: 0,
      limit: -2,
    });

    expect(sessionQueryBuilder.where).not.toHaveBeenCalled();
    expect(mockThreadQuery).not.toHaveBeenCalled();
    expect(mockPendingActionQuery).not.toHaveBeenCalled();
    expect(result).toEqual({
      data: [],
      metadata: {
        pagination: {
          current: 1,
          total: 1,
          items: 0,
          limit: 25,
        },
      },
    });
  });
});

describe('AgentAdminService.getSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListThreadFeedback.mockResolvedValue([]);
    mockSerializeThread.mockImplementation((thread, sessionId) => ({
      id: thread.uuid,
      sessionId,
      title: thread.title || null,
      lastRunAt: thread.lastRunAt || null,
    }));
    mockSerializeRun.mockImplementation((run) => ({
      id: run.uuid,
      threadId: run.threadUuid,
      sessionId: run.sessionUuid,
      status: run.status,
      runPlan: run.runPlanSnapshot?.debug
        ? {
            debug: {
              intent: run.runPlanSnapshot.debug.resolvedIntent,
            },
          }
        : null,
    }));
  });

  it('fails fast when the requested session does not exist', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    mockSessionQuery.mockReturnValueOnce({ findOne });

    await expect(AgentAdminService.getSession('missing-session')).rejects.toThrow('Agent session not found');

    expect(findOne).toHaveBeenCalledWith({ uuid: 'missing-session' });
    expect(mockEnrichSessions).not.toHaveBeenCalled();
    expect(mockThreadQuery).not.toHaveBeenCalled();
    expect(mockMessageQuery).not.toHaveBeenCalled();
    expect(mockRunQuery).not.toHaveBeenCalled();
    expect(mockPendingActionQuery).not.toHaveBeenCalled();
  });

  it('returns an empty summary without aggregate queries when a session has no threads', async () => {
    const rawSession = {
      id: 17,
      uuid: 'session-empty',
      status: 'active',
      sessionKind: 'environment',
      buildUuid: null,
      buildKind: 'environment',
      userId: 'sample-user',
      ownerGithubUsername: null,
      podName: null,
      namespace: null,
      workspaceRepos: [],
      selectedServices: [],
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    };
    mockSessionQuery.mockReturnValueOnce({
      findOne: jest.fn().mockResolvedValue(rawSession),
    });
    mockEnrichSessions.mockResolvedValueOnce([
      {
        ...rawSession,
        repo: null,
        primaryRepo: null,
        services: [],
        startupFailure: null,
      },
    ]);
    mockThreadQuery.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([]),
    });

    const result = await AgentAdminService.getSession('session-empty');

    expect(result.threads).toEqual([]);
    expect(result.session).toEqual(
      expect.objectContaining({
        id: 'session-empty',
        threadCount: 0,
        pendingActionsCount: 0,
        lastRunAt: null,
        editorUrl: null,
      })
    );
    expect(mockMessageQuery).not.toHaveBeenCalled();
    expect(mockRunQuery).not.toHaveBeenCalled();
    expect(mockPendingActionQuery).not.toHaveBeenCalled();
    expect(mockSerializeThread).not.toHaveBeenCalled();
    expect(mockSerializeRun).not.toHaveBeenCalled();
  });

  it('summarizes archived and active threads but defaults to populated history instead of a newer empty thread', async () => {
    const rawSession = {
      id: 17,
      uuid: 'session-1',
      status: 'active',
      buildKind: 'environment',
      userId: 'sample-user',
      selectedServices: [],
      workspaceRepos: [],
      devModeSnapshots: {},
    };
    mockSessionQuery.mockReturnValueOnce({
      findOne: jest.fn().mockResolvedValue(rawSession),
    });
    mockEnrichSessions.mockResolvedValueOnce([
      {
        ...rawSession,
        repo: 'example-org/example-repo',
        primaryRepo: 'example-org/example-repo',
        services: [],
        startupFailure: null,
      },
    ]);

    const threadQuery = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([
        {
          id: 7,
          uuid: 'thread-old-debug',
          title: 'Old Debug diagnosis',
          lastRunAt: '2026-05-09T17:00:00.000Z',
          archivedAt: '2026-05-09T17:30:00.000Z',
          hasConversation: true,
        },
        {
          id: 9,
          uuid: 'thread-fresh-debug',
          title: 'Fresh Debug diagnosis',
          lastRunAt: '2026-05-09T18:00:00.000Z',
          hasConversation: true,
        },
        {
          id: 11,
          uuid: 'thread-no-runs',
          title: 'New conversation',
          lastRunAt: null,
          createdAt: '2026-05-10T18:00:00.000Z',
          hasConversation: false,
        },
      ]),
    };
    mockThreadQuery.mockReturnValueOnce(threadQuery);

    mockMessageQuery.mockReturnValueOnce({
      whereIn: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([{ threadId: 7 }, { threadId: 7 }, { threadId: 9 }]),
    });
    mockRunQuery.mockReturnValueOnce({
      whereIn: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([
        {
          uuid: 'run-fresh-diagnose',
          threadId: 9,
          status: 'completed',
          runPlanSnapshot: {
            debug: { resolvedIntent: 'diagnose' },
          },
        },
        {
          uuid: 'run-old-repair',
          threadId: 7,
          status: 'completed',
          runPlanSnapshot: {
            debug: { resolvedIntent: 'repair' },
          },
        },
        {
          uuid: 'run-old-diagnose',
          threadId: 7,
          status: 'completed',
          runPlanSnapshot: {
            debug: { resolvedIntent: 'diagnose' },
          },
        },
      ]),
    });
    mockPendingActionQuery.mockReturnValueOnce({
      whereIn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([{ threadId: 7 }]),
    });

    const result = await AgentAdminService.getSession('session-1');

    expect(threadQuery.where).toHaveBeenCalledWith({ sessionId: 17 });
    expect(threadQuery.whereNull).not.toHaveBeenCalled();
    expect(result.threads).toEqual([
      expect.objectContaining({
        id: 'thread-old-debug',
        messageCount: 2,
        runCount: 2,
        pendingActionsCount: 1,
        latestRun: expect.objectContaining({
          id: 'run-old-repair',
          threadId: 'thread-old-debug',
          runPlan: { debug: { intent: 'repair' } },
        }),
      }),
      expect.objectContaining({
        id: 'thread-fresh-debug',
        messageCount: 1,
        runCount: 1,
        pendingActionsCount: 0,
        latestRun: expect.objectContaining({
          id: 'run-fresh-diagnose',
          threadId: 'thread-fresh-debug',
          runPlan: { debug: { intent: 'diagnose' } },
        }),
      }),
      expect.objectContaining({
        id: 'thread-no-runs',
        messageCount: 0,
        runCount: 0,
        pendingActionsCount: 0,
        latestRun: null,
      }),
    ]);
    expect(result.session).toEqual(
      expect.objectContaining({
        id: 'session-1',
        latestThreadId: 'thread-fresh-debug',
        threadCount: 3,
        pendingActionsCount: 1,
        lastRunAt: '2026-05-09T18:00:00.000Z',
      })
    );
  });
});

describe('AgentAdminService.listMcpServerCoverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListThreadFeedback.mockResolvedValue([]);
  });

  it('redacts transport and shared MCP secrets in admin coverage rows', async () => {
    const configQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([
        {
          slug: 'sample-connector',
          name: 'Sample Connector',
          description: 'A sample MCP connector.',
          scope: 'global',
          preset: null,
          transport: {
            type: 'http',
            url: 'https://mcp.example.test?api_key=transport-query-secret',
            headers: {
              Authorization: 'Bearer shared-token',
              'X-Api-Key': 'shared-api-key',
            },
          },
          sharedConfig: {
            headers: {
              'X-Shared-Token': 'header-secret',
            },
            query: {
              token: 'query-secret',
            },
            env: {
              SAMPLE_TOKEN: 'env-secret',
            },
            defaultArgs: {
              project: 'arg-secret',
            },
          },
          authConfig: { mode: 'none' },
          enabled: true,
          timeout: 5000,
          sharedDiscoveredTools: [
            {
              name: 'readSample',
              inputSchema: {},
              annotations: { readOnlyHint: true },
            },
          ],
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
        },
        {
          slug: 'sample-cli',
          name: 'Sample CLI',
          description: null,
          scope: 'global',
          preset: null,
          transport: {
            type: 'stdio',
            command: 'sample-mcp',
            args: ['--mode', 'stdio'],
            env: {
              SAMPLE_API_TOKEN: 'stdio-secret',
            },
          },
          sharedConfig: {},
          authConfig: { mode: 'none' },
          enabled: true,
          timeout: 5000,
          sharedDiscoveredTools: [],
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
        },
      ]),
    };
    mockMcpServerConfigQuery.mockReturnValue(configQueryBuilder);

    const connectionQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([{ slug: 'sample-connector', validatedAt: '2026-04-22T00:00:00.000Z' }]),
    };
    mockUserMcpConnectionQuery.mockReturnValue(connectionQueryBuilder);

    const result = await AgentAdminService.listMcpServerCoverage();

    expect(configQueryBuilder.where).toHaveBeenCalledWith({ scope: 'global' });
    expect(result).toEqual([
      expect.objectContaining({
        slug: 'sample-connector',
        transport: {
          type: 'http',
          url: 'https://mcp.example.test?api_key=******',
          headers: {
            Authorization: '******',
            'X-Api-Key': '******',
          },
        },
        sharedConfig: {
          headers: {
            'X-Shared-Token': '******',
          },
          query: {
            token: '******',
          },
          env: {
            SAMPLE_TOKEN: '******',
          },
          defaultArgs: {
            project: '******',
          },
        },
        userConnectionCount: 1,
        latestUserValidatedAt: '2026-04-22T00:00:00.000Z',
        connectionRequired: false,
        sharedDiscoveredTools: [
          {
            name: 'readSample',
            inputSchema: {},
            annotations: { readOnlyHint: true },
          },
        ],
      }),
      expect.objectContaining({
        slug: 'sample-cli',
        transport: {
          type: 'stdio',
          command: 'sample-mcp',
          args: ['--mode', 'stdio'],
          env: {
            SAMPLE_API_TOKEN: '******',
          },
        },
        sharedConfig: {},
        userConnectionCount: 0,
        latestUserValidatedAt: null,
      }),
    ]);
  });

  it('returns early without loading user connections when no MCP configs exist in the scope', async () => {
    const configQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([]),
    };
    mockMcpServerConfigQuery.mockReturnValue(configQueryBuilder);

    const result = await AgentAdminService.listMcpServerCoverage('team-sample');

    expect(result).toEqual([]);
    expect(configQueryBuilder.where).toHaveBeenCalledWith({ scope: 'team-sample' });
    expect(mockUserMcpConnectionQuery).not.toHaveBeenCalled();
  });

  it('hides shared tools for connection-required MCPs and groups scoped user coverage', async () => {
    const configQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([
        {
          slug: 'private-sample',
          name: 'Private Sample',
          description: 'Requires credentials from each user.',
          scope: 'team-sample',
          preset: 'custom',
          transport: {
            type: 'http',
            url: 'https://mcp.example.test',
          },
          sharedConfig: {},
          authConfig: {
            mode: 'user-fields',
            schema: {
              fields: [{ key: 'token', label: 'Token', required: true, inputType: 'password' }],
              bindings: [{ target: 'header', key: 'Authorization', fieldKey: 'token', format: 'bearer' }],
            },
          },
          enabled: true,
          timeout: 5000,
          sharedDiscoveredTools: [
            {
              name: 'readPrivateSample',
              inputSchema: {},
              annotations: { readOnlyHint: true },
            },
          ],
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
        },
      ]),
    };
    mockMcpServerConfigQuery.mockReturnValue(configQueryBuilder);
    const connectionQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([
        { slug: 'private-sample', validatedAt: '2026-04-23T00:00:00.000Z' },
        { slug: 'private-sample', validatedAt: '2026-04-22T00:00:00.000Z' },
      ]),
    };
    mockUserMcpConnectionQuery.mockReturnValue(connectionQueryBuilder);

    const result = await AgentAdminService.listMcpServerCoverage('team-sample');

    expect(connectionQueryBuilder.where).toHaveBeenCalledWith({ scope: 'team-sample' });
    expect(result).toEqual([
      expect.objectContaining({
        slug: 'private-sample',
        scope: 'team-sample',
        connectionRequired: true,
        sharedDiscoveredTools: [],
        userConnectionCount: 2,
        latestUserValidatedAt: '2026-04-23T00:00:00.000Z',
        authConfig: expect.objectContaining({ mode: 'user-fields' }),
      }),
    ]);
  });
});

describe('AgentAdminService.listMcpServerUsers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListThreadFeedback.mockResolvedValue([]);
  });

  it('fails without loading user connection state when the scoped MCP config does not exist', async () => {
    const configQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    mockMcpServerConfigQuery.mockReturnValue(configQueryBuilder);

    await expect(AgentAdminService.listMcpServerUsers('missing-server', 'team-sample')).rejects.toThrow(
      'MCP server config not found'
    );

    expect(configQueryBuilder.where).toHaveBeenCalledWith({ slug: 'missing-server', scope: 'team-sample' });
    expect(configQueryBuilder.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(mockListMaskedUsersForServer).not.toHaveBeenCalled();
  });

  it('loads masked users with the current definition fingerprint and normalizes nullable timestamps', async () => {
    const config = {
      slug: 'private-sample',
      scope: 'team-sample',
      preset: 'custom',
      transport: {
        type: 'http',
        url: 'https://mcp.example.test',
      },
      sharedConfig: {
        headers: { 'X-Tenant': 'sample' },
      },
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
        clientName: 'Sample Client',
      },
    };
    const configQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(config),
    };
    mockMcpServerConfigQuery.mockReturnValue(configQueryBuilder);
    mockListMaskedUsersForServer.mockResolvedValue([
      {
        userId: 'user-1',
        ownerGithubUsername: 'octocat',
        authMode: 'oauth',
        stale: false,
        configuredFieldKeys: [],
        discoveredToolCount: 3,
        validationError: null,
        validatedAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-24T00:00:00.000Z',
      },
      {
        userId: 'user-2',
        ownerGithubUsername: null,
        authMode: 'none',
        stale: true,
        configuredFieldKeys: ['token'],
        discoveredToolCount: 0,
        validationError: 'Connection needs refresh',
        validatedAt: null,
        updatedAt: null,
      },
    ]);

    const result = await AgentAdminService.listMcpServerUsers('private-sample', 'team-sample');

    expect(mockListMaskedUsersForServer).toHaveBeenCalledWith(
      'team-sample',
      'private-sample',
      expect.stringMatching(/^[a-f0-9]{40}$/)
    );
    expect(result).toEqual([
      {
        userId: 'user-1',
        githubUsername: 'octocat',
        authMode: 'oauth',
        stale: false,
        configuredFieldKeys: [],
        discoveredToolCount: 3,
        validationError: null,
        validatedAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-24T00:00:00.000Z',
      },
      {
        userId: 'user-2',
        githubUsername: null,
        authMode: 'none',
        stale: true,
        configuredFieldKeys: ['token'],
        discoveredToolCount: 0,
        validationError: 'Connection needs refresh',
        validatedAt: null,
        updatedAt: null,
      },
    ]);
  });
});

describe('AgentAdminService.getThreadConversation', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockListThreadFeedback.mockResolvedValue([]);
    mockSerializeThread.mockImplementation((thread, sessionId) => ({
      id: thread.uuid,
      sessionId,
      title: thread.title || null,
      lastRunAt: thread.lastRunAt || null,
    }));
    mockSerializeRun.mockImplementation((run) => ({
      id: run.uuid,
      threadId: run.threadUuid,
      sessionId: run.sessionUuid,
      status: run.status,
    }));
    mockSerializeRunEvent.mockImplementation((event) => ({
      id: event.uuid,
      runId: event.runUuid,
      threadId: event.threadUuid,
      sessionId: event.sessionUuid,
      sequence: event.sequence,
      eventType: event.eventType,
      version: 1,
      payload: event.payload,
    }));
    mockSerializeCanonicalMessage.mockImplementation((message, threadUuid, runUuid) => {
      if (message.uuid === 'message-invalid') {
        throw new Error('Malformed canonical message');
      }
      return {
        id: message.uuid,
        clientMessageId: message.clientMessageId || null,
        threadId: threadUuid,
        runId: runUuid,
        role: message.role,
        parts: message.parts,
        createdAt: message.createdAt || null,
      };
    });
  });

  it('fails fast when the requested thread does not exist', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    mockThreadQuery.mockReturnValueOnce({ findOne });

    await expect(AgentAdminService.getThreadConversation('missing-thread')).rejects.toThrow('Agent thread not found');

    expect(findOne).toHaveBeenCalledWith({ uuid: 'missing-thread' });
    expect(mockSessionQuery).not.toHaveBeenCalled();
    expect(mockMessageQuery).not.toHaveBeenCalled();
    expect(mockRunQuery).not.toHaveBeenCalled();
    expect(mockPendingActionQuery).not.toHaveBeenCalled();
    expect(mockToolExecutionQuery).not.toHaveBeenCalled();
    expect(mockRunEventQuery).not.toHaveBeenCalled();
  });

  it('fails before loading conversation records when the owning session does not exist', async () => {
    mockThreadQuery.mockReturnValueOnce({
      findOne: jest.fn().mockResolvedValue({
        id: 7,
        uuid: 'thread-1',
        sessionId: 17,
      }),
    });
    const findById = jest.fn().mockResolvedValue(null);
    mockSessionQuery.mockReturnValueOnce({ findById });
    const getSessionSpy = jest.spyOn(AgentAdminService, 'getSession');

    await expect(AgentAdminService.getThreadConversation('thread-1')).rejects.toThrow('Agent session not found');

    expect(findById).toHaveBeenCalledWith(17);
    expect(getSessionSpy).not.toHaveBeenCalled();
    expect(mockMessageQuery).not.toHaveBeenCalled();
    expect(mockRunQuery).not.toHaveBeenCalled();
    expect(mockPendingActionQuery).not.toHaveBeenCalled();
    expect(mockToolExecutionQuery).not.toHaveBeenCalled();
    expect(mockRunEventQuery).not.toHaveBeenCalled();
  });

  it('rejects a thread that disappears from the session summary during review', async () => {
    mockThreadQuery.mockReturnValueOnce({
      findOne: jest.fn().mockResolvedValue({
        id: 7,
        uuid: 'thread-archived',
        sessionId: 17,
      }),
    });
    mockSessionQuery.mockReturnValueOnce({
      findById: jest.fn().mockResolvedValue({
        id: 17,
        uuid: 'session-1',
      }),
    });
    jest.spyOn(AgentAdminService, 'getSession').mockResolvedValueOnce({
      session: { id: 'session-1' },
      threads: [],
    } as any);
    mockMessageQuery.mockReturnValueOnce({
      alias: jest.fn().mockReturnThis(),
      leftJoinRelated: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([]),
    });
    mockRunQuery.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([]),
    });
    mockPendingActionQuery.mockReturnValueOnce({
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([]),
    });
    mockToolExecutionQuery.mockReturnValueOnce({
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      leftJoinRelated: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([]),
    });
    const eventQuery = {
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn(),
    };
    eventQuery.orderBy.mockImplementationOnce(() => eventQuery).mockResolvedValueOnce([]);
    mockRunEventQuery.mockReturnValueOnce(eventQuery);

    await expect(AgentAdminService.getThreadConversation('thread-archived')).rejects.toThrow('Agent thread not found');

    expect(mockSerializeCanonicalMessage).not.toHaveBeenCalled();
    expect(mockSerializeRun).not.toHaveBeenCalled();
    expect(mockSerializeRunEvent).not.toHaveBeenCalled();
  });

  it('returns canonical messages, feedback, runs, and activity for archived admin conversation replay', async () => {
    jest.spyOn(AgentAdminService, 'getSession').mockResolvedValueOnce({
      session: {
        id: 'session-1',
        status: 'active',
      },
      threads: [
        {
          id: 'thread-1',
          sessionId: 'session-1',
          archivedAt: '2026-04-12T00:00:00.000Z',
          messageCount: 1,
          runCount: 1,
          pendingActionsCount: 1,
          latestRun: null,
        },
      ],
    } as any);

    mockThreadQuery.mockReturnValueOnce({
      findOne: jest.fn().mockResolvedValue({
        id: 7,
        uuid: 'thread-1',
        sessionId: 17,
        archivedAt: '2026-04-12T00:00:00.000Z',
      }),
    });
    mockSessionQuery.mockReturnValueOnce({
      findById: jest.fn().mockResolvedValue({
        id: 17,
        uuid: 'session-1',
      }),
    });

    mockMessageQuery.mockReturnValueOnce({
      alias: jest.fn().mockReturnThis(),
      leftJoinRelated: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([
        {
          uuid: 'message-1',
          clientMessageId: 'client-message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hi' }],
          runUuid: 'run-1',
          createdAt: '2026-04-11T00:00:00.000Z',
        },
        {
          uuid: 'message-2',
          clientMessageId: null,
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'Repair Summary\n\nCommit: https://github.com/example-org/example-repo/commit/0123456789abcdef0123456789abcdef01234567. Fresh Lifecycle state: Lifecycle picked up the repair commit.',
            },
          ],
          runUuid: 'run-1',
          createdAt: '2026-04-11T00:02:00.000Z',
        },
        {
          uuid: 'message-3',
          clientMessageId: null,
          role: 'system',
          parts: [{ type: 'text', text: 'System note' }],
          createdAt: '2026-04-11T00:03:00.000Z',
        },
        {
          uuid: 'message-invalid',
          clientMessageId: null,
          role: 'assistant',
          parts: [{ type: 'unsupported' }],
          createdAt: '2026-04-11T00:04:00.000Z',
        },
      ]),
    });
    mockRunQuery.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([
        {
          uuid: 'run-1',
          status: 'completed',
        },
      ]),
    });
    mockPendingActionQuery.mockReturnValueOnce({
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([
        {
          uuid: 'action-1',
          threadId: 7,
          runId: 11,
          runUuid: 'run-1',
          kind: 'tool_approval',
          status: 'approved',
          capabilityKey: 'workspace_write',
          title: 'Approve workspace edit',
          description: 'A workspace edit requires approval.',
          payload: {
            toolName: 'mcp__workspace_core__edit_file',
            input: {
              path: 'sample-file.txt',
            },
          },
          resolution: {
            approved: true,
          },
          resolvedAt: '2026-04-11T00:01:00.000Z',
          createdAt: '2026-04-11T00:00:00.000Z',
        },
      ]),
    });
    mockToolExecutionQuery.mockReturnValueOnce({
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      leftJoinRelated: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([
        {
          uuid: 'tool-1',
          source: 'mcp',
          serverSlug: 'workspace_core',
          toolName: 'edit_file',
          toolCallId: 'tool-call-1',
          args: { path: 'sample-file.txt' },
          result: null,
          status: 'completed',
          safetyLevel: null,
          approved: true,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          createdAt: '2026-04-11T00:00:00.000Z',
          updatedAt: '2026-04-11T00:00:00.000Z',
          threadUuid: 'thread-1',
          runUuid: 'run-1',
          pendingActionUuid: 'action-1',
        },
        {
          uuid: 'tool-2',
          source: 'mcp',
          serverSlug: null,
          toolName: 'read_context',
          toolCallId: null,
          args: {},
          result: { content: 'ok' },
          status: 'completed',
          safetyLevel: null,
          approved: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          createdAt: '2026-04-11T00:03:00.000Z',
          updatedAt: '2026-04-11T00:03:00.000Z',
          threadUuid: 'thread-1',
          runUuid: 'run-1',
          pendingActionUuid: null,
        },
      ]),
    });
    const eventQuery: any = {
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn(),
    };
    eventQuery.orderBy
      .mockImplementationOnce(() => eventQuery)
      .mockResolvedValueOnce([
        {
          uuid: 'event-1',
          runUuid: 'run-1',
          sequence: 1,
          eventType: 'approval.resolved',
          payload: {
            actionId: 'action-1',
            approved: true,
          },
        },
      ]);
    mockRunEventQuery.mockReturnValueOnce(eventQuery);

    const feedback = [
      {
        id: 'feedback-1',
        threadId: 'thread-1',
        messageId: 'message-2',
        rating: 'down',
        text: 'The diagnosis missed the failing service.',
      },
    ];
    mockListThreadFeedback.mockResolvedValueOnce(feedback);
    const result = await AgentAdminService.getThreadConversation('thread-1');
    expect(result.thread.archivedAt).toBe('2026-04-12T00:00:00.000Z');
    expect(mockListThreadFeedback).toHaveBeenCalledWith(7);
    expect(result.feedback).toEqual(feedback);

    expect(mockSerializeCanonicalMessage).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'message-1' }),
      'thread-1',
      'run-1'
    );
    expect(result.messages).toEqual([
      {
        id: 'message-1',
        clientMessageId: 'client-message-1',
        threadId: 'thread-1',
        runId: 'run-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
        createdAt: '2026-04-11T00:00:00.000Z',
      },
      {
        id: 'message-2',
        clientMessageId: null,
        threadId: 'thread-1',
        runId: 'run-1',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: 'Repair Summary\n\nCommit: https://github.com/example-org/example-repo/commit/0123456789abcdef0123456789abcdef01234567. Fresh Lifecycle state: Lifecycle picked up the repair commit.',
          },
        ],
        createdAt: '2026-04-11T00:02:00.000Z',
      },
      {
        id: 'message-3',
        clientMessageId: null,
        threadId: 'thread-1',
        runId: null,
        role: 'system',
        parts: [{ type: 'text', text: 'System note' }],
        createdAt: '2026-04-11T00:03:00.000Z',
      },
    ]);
    expect(mockSerializeCanonicalMessage).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'message-invalid' }),
      'thread-1',
      null
    );
    expect(String((result.messages[1].parts[0] as { text?: string }).text)).toContain(
      'Lifecycle picked up the repair commit'
    );
    expect(result.pendingActions).toEqual([
      expect.objectContaining({
        id: 'action-1',
        threadId: 'thread-1',
        runId: 'run-1',
        requestedAt: '2026-04-11T00:00:00.000Z',
        toolName: 'mcp__workspace_core__edit_file',
      }),
    ]);
    expect(result.events).toEqual([
      {
        id: 'event-1',
        runId: 'run-1',
        threadId: 'thread-1',
        sessionId: 'session-1',
        sequence: 1,
        eventType: 'approval.resolved',
        version: 1,
        payload: {
          actionId: 'action-1',
          approved: true,
        },
      },
    ]);
    expect(mockSerializeRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        uuid: 'event-1',
        runUuid: 'run-1',
        threadUuid: 'thread-1',
        sessionUuid: 'session-1',
      })
    );
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({
        id: 'tool-1',
        threadId: 'thread-1',
        runId: 'run-1',
        pendingActionId: 'action-1',
        toolCallId: 'tool-call-1',
      }),
      expect.objectContaining({
        id: 'tool-2',
        threadId: 'thread-1',
        runId: 'run-1',
        pendingActionId: null,
        toolCallId: null,
        args: {},
        result: { content: 'ok' },
      }),
    ]);
    expect(result.messages[0]).not.toHaveProperty('metadata');
  });
});
