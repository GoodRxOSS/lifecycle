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

const canonicalStartupFailure = {
  stage: 'connect_runtime',
  title: 'Session workspace pod failed to start',
  message: 'init-workspace: ImagePullBackOff',
  recordedAt: '2026-04-05T18:30:00.000Z',
  retryable: false,
  origin: 'agent_session',
};

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
    const threadSelect = jest.fn().mockResolvedValue([
      { sessionId: 101, lastRunAt: '2026-04-05T18:00:00.000Z' },
      { sessionId: 202, lastRunAt: '2026-04-05T19:00:00.000Z' },
    ]);
    mockThreadQuery.mockReturnValue({
      whereIn: threadWhereIn,
      select: threadSelect,
    });

    const pendingWhereIn = jest.fn().mockReturnThis();
    const pendingWhere = jest.fn().mockReturnThis();
    const pendingSelect = jest.fn().mockResolvedValue([{ sessionId: 202 }]);
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
        pendingActionsCount: 0,
        lastRunAt: '2026-04-05T18:00:00.000Z',
        startupFailure: canonicalStartupFailure,
      }),
      expect.objectContaining({
        id: '3e81553b-b8d4-4d2b-88d0-8d5775bcffde',
        threadCount: 1,
        pendingActionsCount: 1,
        lastRunAt: '2026-04-05T19:00:00.000Z',
      }),
    ]);
  });
});

describe('AgentAdminService.getSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('summarizes each non-archived thread with independent counts and latest run context', async () => {
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
      orderBy: jest.fn().mockResolvedValue([
        {
          id: 7,
          uuid: 'thread-old-debug',
          title: 'Old Debug diagnosis',
          lastRunAt: '2026-05-09T17:00:00.000Z',
        },
        {
          id: 9,
          uuid: 'thread-fresh-debug',
          title: 'Fresh Debug diagnosis',
          lastRunAt: '2026-05-09T18:00:00.000Z',
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
    expect(threadQuery.whereNull).toHaveBeenCalledWith('archivedAt');
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
    ]);
    expect(result.session).toEqual(
      expect.objectContaining({
        id: 'session-1',
        threadCount: 2,
        pendingActionsCount: 1,
        lastRunAt: '2026-05-09T18:00:00.000Z',
      })
    );
  });
});

describe('AgentAdminService.listMcpServerCoverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
          sharedDiscoveredTools: [],
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
});

describe('AgentAdminService.getThreadConversation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    mockSerializeCanonicalMessage.mockImplementation((message, threadUuid, runUuid) => ({
      id: message.uuid,
      clientMessageId: message.clientMessageId || null,
      threadId: threadUuid,
      runId: runUuid,
      role: message.role,
      parts: message.parts,
      createdAt: message.createdAt || null,
    }));
  });

  it('returns canonical messages, runs, events, pending actions, and tool executions for admin replay', async () => {
    jest.spyOn(AgentAdminService, 'getSession').mockResolvedValueOnce({
      session: {
        id: 'session-1',
        status: 'active',
      },
      threads: [
        {
          id: 'thread-1',
          sessionId: 'session-1',
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
            toolName: 'mcp__sandbox__workspace_edit_file',
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
          serverSlug: 'sandbox',
          toolName: 'workspace.edit_file',
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

    const result = await AgentAdminService.getThreadConversation('thread-1');

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
    ]);
    expect(String((result.messages[1].parts[0] as { text?: string }).text)).toContain(
      'Lifecycle picked up the repair commit'
    );
    expect(result.pendingActions).toEqual([
      expect.objectContaining({
        id: 'action-1',
        threadId: 'thread-1',
        runId: 'run-1',
        requestedAt: '2026-04-11T00:00:00.000Z',
        toolName: 'mcp__sandbox__workspace_edit_file',
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
    ]);
    expect(result.messages[0]).not.toHaveProperty('metadata');
  });
});
