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

jest.mock('server/models/AgentRun', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('server/models/AgentRunEvent', () => ({
  __esModule: true,
  default: {
    knex: jest.fn(),
    query: jest.fn(),
  },
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  const actual = jest.requireActual('server/lib/agentSession/runtimeConfig');
  return {
    __esModule: true,
    ...actual,
    resolveAgentSessionDurabilityConfig: jest.fn().mockResolvedValue({
      runExecutionLeaseMs: 30 * 60 * 1000,
      queuedRunDispatchStaleMs: 30 * 1000,
      dispatchRecoveryLimit: 50,
      maxDurablePayloadBytes: 64 * 1024,
      payloadPreviewBytes: 16 * 1024,
      fileChangePreviewChars: 4000,
    }),
  };
});

import AgentRun from 'server/models/AgentRun';
import AgentRunEvent from 'server/models/AgentRunEvent';
import AgentRunEventService from '../RunEventService';
import { AgentRunOwnershipLostError } from '../AgentRunOwnershipLostError';

const mockRunQuery = AgentRun.query as jest.Mock;
const mockRunTransaction = AgentRun.transaction as jest.Mock;
const mockRunEventKnex = AgentRunEvent.knex as jest.Mock;
const mockRunEventQuery = AgentRunEvent.query as jest.Mock;

describe('AgentRunEventService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunTransaction.mockImplementation(async (callback) => callback({ trx: true }));
    mockRunEventKnex.mockReturnValue({
      raw: jest.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads run events after a sequence cursor with one extra row for hasMore', async () => {
    const limit = jest.fn().mockResolvedValue([
      {
        uuid: 'event-5',
        sequence: 5,
      },
      {
        uuid: 'event-6',
        sequence: 6,
      },
      {
        uuid: 'event-7',
        sequence: 7,
      },
    ]);
    const orderById = jest.fn().mockReturnValue({ limit });
    const orderBySequence = jest.fn().mockReturnValue({ orderBy: orderById });
    const whereSequence = jest.fn().mockReturnValue({ orderBy: orderBySequence });
    const whereRun = jest.fn().mockReturnValue({ where: whereSequence });

    mockRunEventQuery.mockReturnValue({ where: whereRun });

    const result = await AgentRunEventService.listRunEventsPageForRun(
      {
        id: 17,
        uuid: 'run-1',
        threadId: 11,
        sessionId: 13,
        threadUuid: 'thread-1',
        sessionUuid: 'session-1',
        status: 'running',
      } as any,
      {
        afterSequence: 4,
        limit: 2,
      }
    );

    expect(whereRun).toHaveBeenCalledWith({ runId: 17 });
    expect(whereSequence).toHaveBeenCalledWith('sequence', '>', 4);
    expect(orderBySequence).toHaveBeenCalledWith('sequence', 'asc');
    expect(orderById).toHaveBeenCalledWith('id', 'asc');
    expect(limit).toHaveBeenCalledWith(3);
    expect(result).toEqual({
      events: [
        expect.objectContaining({
          uuid: 'event-5',
          runUuid: 'run-1',
          threadUuid: 'thread-1',
          sessionUuid: 'session-1',
          sequence: 5,
        }),
        expect.objectContaining({
          uuid: 'event-6',
          runUuid: 'run-1',
          threadUuid: 'thread-1',
          sessionUuid: 'session-1',
          sequence: 6,
        }),
      ],
      nextSequence: 6,
      hasMore: true,
      run: {
        id: 'run-1',
        status: 'running',
      },
      limit: 2,
      maxLimit: 500,
    });
  });

  it('persists canonical run-event payloads without private UI replay chunks', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const latestFirst = jest.fn().mockResolvedValue(null);
    const runFindOne = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1' });
    const runForUpdate = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1' });
    const runFindById = jest.fn().mockReturnValue({ forUpdate: runForUpdate });

    mockRunQuery.mockReturnValueOnce({ findOne: runFindOne }).mockReturnValueOnce({ findById: runFindById });
    mockRunEventQuery
      .mockReturnValueOnce({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            first: latestFirst,
          }),
        }),
      })
      .mockReturnValueOnce({ insert });

    await AgentRunEventService.appendEventsForChunks('run-1', [
      { type: 'start', messageId: 'assistant-1' } as any,
      { type: 'text-start', id: 'text-1' } as any,
      { type: 'text-delta', id: 'text-1', delta: 'Hello' } as any,
      { type: 'finish', finishReason: 'stop' } as any,
    ]);

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        runId: 17,
        sequence: 1,
        eventType: 'message.created',
        payload: {
          messageId: 'assistant-1',
          metadata: {},
        },
      }),
      expect.objectContaining({
        sequence: 2,
        eventType: 'message.part.started',
        payload: {
          partType: 'text',
          partId: 'text-1',
        },
      }),
      expect.objectContaining({
        sequence: 3,
        eventType: 'message.delta',
        payload: {
          partType: 'text',
          partId: 'text-1',
          delta: 'Hello',
        },
      }),
      expect.objectContaining({
        sequence: 4,
        eventType: 'run.finished',
        payload: {
          finishReason: 'stop',
          metadata: {},
        },
      }),
    ]);
    expect(runFindById).toHaveBeenCalledWith(17);
    expect(runForUpdate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(insert.mock.calls[0][0])).not.toContain('__uiReplayChunk');
    expect(mockRunEventKnex().raw).toHaveBeenCalledWith('select pg_notify(?, ?)', [
      'agent_run_events',
      JSON.stringify({
        runId: 'run-1',
        latestSequence: 4,
      }),
    ]);
  });

  it('truncates oversized durable event payloads', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const latestFirst = jest.fn().mockResolvedValue(null);
    const runFindOne = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1' });
    const runForUpdate = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1' });
    const runFindById = jest.fn().mockReturnValue({ forUpdate: runForUpdate });

    mockRunQuery.mockReturnValueOnce({ findOne: runFindOne }).mockReturnValueOnce({ findById: runFindById });
    mockRunEventQuery
      .mockReturnValueOnce({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            first: latestFirst,
          }),
        }),
      })
      .mockReturnValueOnce({ insert });

    await AgentRunEventService.appendEventsForChunks('run-1', [
      {
        type: 'tool-output-available',
        toolCallId: 'tool-call-1',
        output: {
          content: 'x'.repeat(70 * 1024),
        },
      } as any,
    ]);

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        eventType: 'tool.call.completed',
        payload: expect.objectContaining({
          toolCallId: 'tool-call-1',
          status: 'completed',
          output: expect.objectContaining({
            truncated: true,
            originalJsonBytes: expect.any(Number),
            preview: expect.any(String),
          }),
        }),
      }),
    ]);
  });

  it('persists approval request events with the pending action link when present', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const latestFirst = jest.fn().mockResolvedValue(null);
    const runFindOne = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1' });
    const runForUpdate = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1' });
    const runFindById = jest.fn().mockReturnValue({ forUpdate: runForUpdate });

    mockRunQuery.mockReturnValueOnce({ findOne: runFindOne }).mockReturnValueOnce({ findById: runFindById });
    mockRunEventQuery
      .mockReturnValueOnce({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            first: latestFirst,
          }),
        }),
      })
      .mockReturnValueOnce({ insert });

    await AgentRunEventService.appendEventsForChunks('run-1', [
      {
        type: 'tool-approval-request',
        actionId: 'action-1',
        approvalId: 'approval-1',
        toolCallId: 'tool-call-1',
      } as any,
    ]);

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        eventType: 'approval.requested',
        payload: {
          actionId: 'action-1',
          approvalId: 'approval-1',
          toolCallId: 'tool-call-1',
        },
      }),
    ]);
  });

  it('persists stream events when the locked run owner matches', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const latestFirst = jest.fn().mockResolvedValue(null);
    const runFindOne = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1' });
    const runForUpdate = jest.fn().mockResolvedValue({
      id: 17,
      uuid: 'run-1',
      status: 'running',
      executionOwner: 'worker-1',
    });
    const runFindById = jest.fn().mockReturnValue({ forUpdate: runForUpdate });

    mockRunQuery.mockReturnValueOnce({ findOne: runFindOne }).mockReturnValueOnce({ findById: runFindById });
    mockRunEventQuery
      .mockReturnValueOnce({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            first: latestFirst,
          }),
        }),
      })
      .mockReturnValueOnce({ insert });

    await AgentRunEventService.appendEventsForChunksForExecutionOwner('run-1', 'worker-1', [
      { type: 'text-delta', id: 'text-1', delta: 'Hello' } as any,
    ]);

    expect(runFindById).toHaveBeenCalledWith(17);
    expect(runForUpdate).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        runId: 17,
        sequence: 1,
        eventType: 'message.delta',
        payload: {
          partType: 'text',
          partId: 'text-1',
          delta: 'Hello',
        },
      }),
    ]);
    expect(mockRunEventKnex().raw).toHaveBeenCalledWith('select pg_notify(?, ?)', [
      'agent_run_events',
      JSON.stringify({
        runId: 'run-1',
        latestSequence: 1,
      }),
    ]);
  });

  it('throws ownership loss without writing stream events when the locked run owner is stale', async () => {
    const runFindOne = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1' });
    const runForUpdate = jest.fn().mockResolvedValue({
      id: 17,
      uuid: 'run-1',
      status: 'running',
      executionOwner: 'worker-2',
    });
    const runFindById = jest.fn().mockReturnValue({ forUpdate: runForUpdate });

    mockRunQuery.mockReturnValueOnce({ findOne: runFindOne }).mockReturnValueOnce({ findById: runFindById });

    let thrownError: unknown;
    try {
      await AgentRunEventService.appendEventsForChunksForExecutionOwner('run-1', 'worker-1', [
        { type: 'text-delta', id: 'text-1', delta: 'Hello' } as any,
      ]);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(AgentRunOwnershipLostError);
    expect(thrownError).toMatchObject({
      runUuid: 'run-1',
      expectedExecutionOwner: 'worker-1',
      currentStatus: 'running',
      currentExecutionOwner: 'worker-2',
    });

    expect(mockRunEventQuery).not.toHaveBeenCalled();
    expect(mockRunEventKnex().raw).not.toHaveBeenCalled();
  });

  it('projects UI replay chunks from canonical run events', () => {
    const chunks = AgentRunEventService.projectUiChunksFromEvents([
      {
        eventType: 'message.created',
        payload: {
          messageId: 'assistant-1',
          metadata: { provider: 'openai' },
        },
      },
      {
        eventType: 'message.part.started',
        payload: {
          partType: 'text',
          partId: 'text-1',
        },
      },
      {
        eventType: 'message.delta',
        payload: {
          partType: 'text',
          partId: 'text-1',
          delta: 'Hello',
        },
      },
      {
        eventType: 'message.part.completed',
        payload: {
          partType: 'text',
          partId: 'text-1',
        },
      },
      {
        eventType: 'tool.call.started',
        payload: {
          toolCallId: 'tool-call-1',
          toolName: 'workspace_read_file',
          inputStatus: 'available',
          input: { path: '/workspace/README.md' },
        },
      },
      {
        eventType: 'tool.call.completed',
        payload: {
          toolCallId: 'tool-call-1',
          status: 'completed',
          output: { ok: true },
        },
      },
      {
        eventType: 'approval.requested',
        payload: {
          actionId: 'action-1',
          approvalId: 'approval-1',
          toolCallId: 'tool-call-2',
        },
      },
      {
        eventType: 'tool.file_change',
        payload: {
          id: 'file-change-1',
          data: {
            id: 'change-1',
            toolCallId: 'tool-call-2',
            sourceTool: 'workspace_edit_file',
            path: 'README.md',
            displayPath: 'README.md',
            kind: 'edited',
            stage: 'awaiting-approval',
            additions: 1,
            deletions: 0,
            truncated: false,
          },
        },
      },
      {
        eventType: 'run.finished',
        payload: {
          finishReason: 'stop',
          metadata: {},
        },
      },
    ] as any);

    expect(chunks).toEqual([
      { type: 'start', messageId: 'assistant-1', messageMetadata: { provider: 'openai' } },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Hello' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'tool-input-available',
        toolCallId: 'tool-call-1',
        toolName: 'workspace_read_file',
        input: { path: '/workspace/README.md' },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'tool-call-1',
        output: { ok: true },
      },
      {
        type: 'tool-approval-request',
        actionId: 'action-1',
        approvalId: 'approval-1',
        toolCallId: 'tool-call-2',
      },
      {
        type: 'data-file-change',
        id: 'file-change-1',
        data: {
          id: 'change-1',
          toolCallId: 'tool-call-2',
          sourceTool: 'workspace_edit_file',
          path: 'README.md',
          displayPath: 'README.md',
          kind: 'edited',
          stage: 'awaiting-approval',
          additions: 1,
          deletions: 0,
          truncated: false,
        },
      },
      { type: 'finish', finishReason: 'stop', messageMetadata: {} },
    ]);
  });

  it('projects run.failed events to UI error chunks for stream compatibility', () => {
    const chunks = AgentRunEventService.projectUiChunksFromEvents([
      {
        eventType: 'run.failed',
        payload: {
          status: 'failed',
          error: {
            message: 'Sample run failure.',
          },
        },
      },
    ] as any);

    expect(chunks).toEqual([
      {
        type: 'error',
        errorText: 'Sample run failure.',
      },
    ]);
  });

  it('serializes canonical run event payloads as public data', () => {
    const serialized = AgentRunEventService.serializeRunEvent({
      uuid: 'event-1',
      runUuid: 'run-1',
      threadUuid: 'thread-1',
      sessionUuid: 'session-1',
      runId: 17,
      sequence: 4,
      eventType: 'message.delta',
      payload: {
        partType: 'text',
        partId: 'text-1',
        delta: 'Hello',
      },
      createdAt: '2026-04-24T00:00:00.000Z',
      updatedAt: '2026-04-24T00:00:00.000Z',
    } as any);

    expect(serialized).toEqual({
      id: 'event-1',
      runId: 'run-1',
      threadId: 'thread-1',
      sessionId: 'session-1',
      sequence: 4,
      eventType: 'message.delta',
      version: 1,
      payload: {
        partType: 'text',
        partId: 'text-1',
        delta: 'Hello',
      },
      createdAt: '2026-04-24T00:00:00.000Z',
      updatedAt: '2026-04-24T00:00:00.000Z',
    });
  });

  it('streams canonical SSE frames after the requested sequence cursor', async () => {
    const terminalEvent = {
      uuid: 'event-7',
      runUuid: 'run-1',
      threadUuid: 'thread-1',
      sessionUuid: 'session-1',
      runId: 17,
      sequence: 7,
      eventType: 'run.completed',
      payload: {
        status: 'completed',
      },
      createdAt: '2026-04-24T00:00:01.000Z',
      updatedAt: '2026-04-24T00:00:01.000Z',
    } as any;
    const listRunEventsPage = jest
      .spyOn(AgentRunEventService, 'listRunEventsPage')
      .mockResolvedValueOnce({
        events: [
          {
            uuid: 'event-6',
            runUuid: 'run-1',
            threadUuid: 'thread-1',
            sessionUuid: 'session-1',
            runId: 17,
            sequence: 6,
            eventType: 'message.delta',
            payload: {
              partType: 'text',
              partId: 'text-1',
              delta: 'Hello',
            },
            createdAt: '2026-04-24T00:00:00.000Z',
            updatedAt: '2026-04-24T00:00:00.000Z',
          } as any,
        ],
        nextSequence: 6,
        hasMore: false,
        run: {
          id: 'run-1',
          status: 'running',
        },
        limit: 100,
        maxLimit: 500,
      })
      .mockResolvedValueOnce({
        events: [terminalEvent],
        nextSequence: 7,
        hasMore: false,
        run: {
          id: 'run-1',
          status: 'completed',
        },
        limit: 100,
        maxLimit: 500,
      });
    const waitForRunEventNotification = jest.spyOn(AgentRunEventService, 'waitForRunEventNotification');
    mockRunQuery.mockReturnValue({
      findOne: jest.fn().mockResolvedValue({
        uuid: 'run-1',
        status: 'completed',
      }),
    });

    const text = await new Response(AgentRunEventService.createCanonicalRunEventStream('run-1', 5)).text();

    expect(listRunEventsPage).toHaveBeenNthCalledWith(1, 'run-1', {
      afterSequence: 5,
      limit: 100,
    });
    expect(listRunEventsPage).toHaveBeenNthCalledWith(2, 'run-1', {
      afterSequence: 6,
      limit: 100,
    });
    expect(waitForRunEventNotification).not.toHaveBeenCalled();
    expect(text).toContain(
      'data: {"id":"event-6","runId":"run-1","threadId":"thread-1","sessionId":"session-1","sequence":6,"eventType":"message.delta","version":1,"payload":{"partType":"text","partId":"text-1","delta":"Hello"},"createdAt":"2026-04-24T00:00:00.000Z","updatedAt":"2026-04-24T00:00:00.000Z"}'
    );
    expect(text).toContain('id: 7\nevent: run.completed');
  });

  it('backs off when the run-event notification listener is unavailable', async () => {
    jest.useFakeTimers();
    try {
      const acquireConnection = jest.fn().mockRejectedValue(new Error('listen unavailable'));
      mockRunEventKnex.mockReturnValue({
        client: {
          acquireConnection,
          releaseConnection: jest.fn(),
        },
      });

      const promise = AgentRunEventService.waitForRunEventNotification('run-1', 7, 25);
      const settled = jest.fn();
      void promise.then(settled);

      await Promise.resolve();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(24);
      expect(settled).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBe(false);
      expect(acquireConnection).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drains events written after terminal status before closing the canonical stream', async () => {
    const terminalEvent = {
      uuid: 'event-2',
      runUuid: 'run-1',
      threadUuid: 'thread-1',
      sessionUuid: 'session-1',
      runId: 17,
      sequence: 2,
      eventType: 'run.completed',
      payload: {
        status: 'completed',
      },
      createdAt: null,
      updatedAt: null,
    } as any;
    const listRunEventsPage = jest
      .spyOn(AgentRunEventService, 'listRunEventsPage')
      .mockResolvedValueOnce({
        events: [],
        nextSequence: 1,
        hasMore: false,
        run: {
          id: 'run-1',
          status: 'running',
        },
        limit: 100,
        maxLimit: 500,
      })
      .mockResolvedValueOnce({
        events: [terminalEvent],
        nextSequence: 2,
        hasMore: false,
        run: {
          id: 'run-1',
          status: 'completed',
        },
        limit: 100,
        maxLimit: 500,
      });
    mockRunQuery.mockReturnValue({
      findOne: jest.fn().mockResolvedValue({
        uuid: 'run-1',
        status: 'completed',
      }),
    });

    const text = await new Response(AgentRunEventService.createCanonicalRunEventStream('run-1', 1)).text();

    expect(listRunEventsPage).toHaveBeenNthCalledWith(1, 'run-1', {
      afterSequence: 1,
      limit: 100,
    });
    expect(listRunEventsPage).toHaveBeenNthCalledWith(2, 'run-1', {
      afterSequence: 1,
      limit: 100,
    });
    expect(text).toContain('id: 2\nevent: run.completed');
  });

  it('waits once for the terminal event when terminal status is visible first', async () => {
    const terminalEvent = {
      uuid: 'event-2',
      runUuid: 'run-1',
      threadUuid: 'thread-1',
      sessionUuid: 'session-1',
      runId: 17,
      sequence: 2,
      eventType: 'run.completed',
      payload: {
        status: 'completed',
      },
      createdAt: null,
      updatedAt: null,
    } as any;
    const listRunEventsPage = jest
      .spyOn(AgentRunEventService, 'listRunEventsPage')
      .mockResolvedValueOnce({
        events: [],
        nextSequence: 1,
        hasMore: false,
        run: {
          id: 'run-1',
          status: 'running',
        },
        limit: 100,
        maxLimit: 500,
      })
      .mockResolvedValueOnce({
        events: [],
        nextSequence: 1,
        hasMore: false,
        run: {
          id: 'run-1',
          status: 'completed',
        },
        limit: 100,
        maxLimit: 500,
      })
      .mockResolvedValueOnce({
        events: [terminalEvent],
        nextSequence: 2,
        hasMore: false,
        run: {
          id: 'run-1',
          status: 'completed',
        },
        limit: 100,
        maxLimit: 500,
      });
    const waitForRunEventNotification = jest
      .spyOn(AgentRunEventService, 'waitForRunEventNotification')
      .mockResolvedValue(true);
    mockRunQuery.mockReturnValue({
      findOne: jest.fn().mockResolvedValue({
        uuid: 'run-1',
        status: 'completed',
      }),
    });

    const text = await new Response(
      AgentRunEventService.createCanonicalRunEventStream('run-1', 1, { pollIntervalMs: 10 })
    ).text();

    expect(waitForRunEventNotification).toHaveBeenCalledWith('run-1', 1, 10);
    expect(listRunEventsPage).toHaveBeenNthCalledWith(3, 'run-1', {
      afterSequence: 1,
      limit: 100,
    });
    expect(text).toContain('id: 2\nevent: run.completed');
  });

  it('keeps following terminal runs until a terminal event is available', async () => {
    const terminalEvent = {
      uuid: 'event-2',
      runUuid: 'run-1',
      threadUuid: 'thread-1',
      sessionUuid: 'session-1',
      runId: 17,
      sequence: 2,
      eventType: 'run.completed',
      payload: {
        status: 'completed',
      },
      createdAt: null,
      updatedAt: null,
    } as any;
    const listRunEventsPage = jest
      .spyOn(AgentRunEventService, 'listRunEventsPage')
      .mockResolvedValueOnce({
        events: [],
        nextSequence: 1,
        hasMore: false,
        run: {
          id: 'run-1',
          status: 'running',
        },
        limit: 100,
        maxLimit: 500,
      })
      .mockResolvedValueOnce({
        events: [],
        nextSequence: 1,
        hasMore: false,
        run: {
          id: 'run-1',
          status: 'completed',
        },
        limit: 100,
        maxLimit: 500,
      })
      .mockResolvedValueOnce({
        events: [terminalEvent],
        nextSequence: 2,
        hasMore: false,
        run: {
          id: 'run-1',
          status: 'completed',
        },
        limit: 100,
        maxLimit: 500,
      });
    const waitForRunEventNotification = jest
      .spyOn(AgentRunEventService, 'waitForRunEventNotification')
      .mockResolvedValue(false);
    mockRunQuery.mockReturnValue({
      findOne: jest.fn().mockResolvedValue({
        uuid: 'run-1',
        status: 'completed',
      }),
    });

    const text = await new Response(
      AgentRunEventService.createCanonicalRunEventStream('run-1', 1, { pollIntervalMs: 10 })
    ).text();

    expect(waitForRunEventNotification).toHaveBeenCalledWith('run-1', 1, 10);
    expect(listRunEventsPage).toHaveBeenCalledTimes(3);
    expect(text).toContain('id: 2\nevent: run.completed');
  });
});
