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
  return {
    __esModule: true,
    DEFAULT_AGENT_SESSION_MAX_DURABLE_PAYLOAD_BYTES: 64 * 1024,
    DEFAULT_AGENT_SESSION_PAYLOAD_PREVIEW_BYTES: 16 * 1024,
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
import AgentRunEventService, { RUN_EVENT_STREAM_POLL_INTERVAL_MS } from '../RunEventService';
import { normalizeRunEventPageLimit } from '../RunEventService';
import { AgentRunOwnershipLostError } from '../AgentRunOwnershipLostError';

const mockRunQuery = AgentRun.query as jest.Mock;
const mockRunTransaction = AgentRun.transaction as jest.Mock;
const mockRunEventKnex = AgentRunEvent.knex as jest.Mock;
const mockRunEventQuery = AgentRunEvent.query as jest.Mock;

describe('AgentRunEventService', () => {
  beforeEach(() => {
    delete (globalThis as any).__lifecycleRunEventNotify;
    delete (globalThis as any).__lifecyclePgNotificationListeners;
    jest.clearAllMocks();
    mockRunTransaction.mockImplementation(async (callback) => callback({ trx: true }));
    mockRunEventKnex.mockReturnValue({
      raw: jest.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the fallback stream poll cadence live enough for reasoning chunks', () => {
    expect(RUN_EVENT_STREAM_POLL_INTERVAL_MS).toBeLessThanOrEqual(500);
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

  it('keeps oversized tool.call.started input verbatim so approval-resume replays the real input', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const latestFirst = jest.fn().mockResolvedValue(null);
    const runFindOne = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1' });
    const runForUpdate = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1' });
    const runFindById = jest.fn().mockReturnValue({ forUpdate: runForUpdate });

    mockRunQuery.mockReturnValueOnce({ findOne: runFindOne }).mockReturnValueOnce({ findById: runFindById });
    mockRunEventQuery
      .mockReturnValueOnce({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ first: latestFirst }),
        }),
      })
      .mockReturnValueOnce({ insert });

    const largeContent = 'x'.repeat(70 * 1024);
    await AgentRunEventService.appendEventsForChunks('run-1', [
      {
        type: 'tool-input-available',
        toolCallId: 'tool-call-1',
        toolName: 'mcp__lifecycle__update_file',
        input: { new_content: largeContent, path: 'a.txt' },
      } as any,
    ]);

    const persistedInput = (insert.mock.calls[0][0][0] as { payload: { input: { new_content: string } } }).payload
      .input;
    expect(persistedInput.new_content).toBe(largeContent);
    expect(persistedInput).not.toHaveProperty('truncated');
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
          toolName: 'read_file',
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
            sourceTool: 'edit_file',
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
        toolName: 'read_file',
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
          sourceTool: 'edit_file',
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

  it('drains the terminal event and closes without polling when terminal status is visible', async () => {
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
    // Terminal status + event are atomic, so the first drain emits the terminal event and closes without waiting.
    const listRunEventsPage = jest.spyOn(AgentRunEventService, 'listRunEventsPage').mockResolvedValue({
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

    expect(waitForRunEventNotification).not.toHaveBeenCalled();
    expect(listRunEventsPage).toHaveBeenCalledTimes(1);
    expect(text).toContain('id: 2\nevent: run.completed');
  });

  it('closes the canonical stream on run.transitioned', async () => {
    const terminalEvent = {
      uuid: 'event-2',
      runUuid: 'run-1',
      threadUuid: 'thread-1',
      sessionUuid: 'session-1',
      runId: 17,
      sequence: 2,
      eventType: 'run.transitioned',
      payload: {
        status: 'transitioned',
        transition: {
          kind: 'workspace_escalation',
          reason: 'create a React app',
          toolCallId: 'tool-provision',
          workspaceStatus: 'provisioning',
          targetAgentDefinitionId: 'system.develop',
          createdAt: '2026-05-01T00:00:05.000Z',
          continuation: {
            status: 'ui_auto_continue_fallback',
            targetAgentDefinitionId: 'system.develop',
            runId: null,
          },
        },
      },
      createdAt: null,
      updatedAt: null,
    } as any;
    const listRunEventsPage = jest.spyOn(AgentRunEventService, 'listRunEventsPage').mockResolvedValue({
      events: [terminalEvent],
      nextSequence: 2,
      hasMore: false,
      run: {
        id: 'run-1',
        status: 'transitioned',
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
        status: 'transitioned',
      }),
    });

    const text = await new Response(
      AgentRunEventService.createCanonicalRunEventStream('run-1', 1, { pollIntervalMs: 10 })
    ).text();

    expect(waitForRunEventNotification).not.toHaveBeenCalled();
    expect(listRunEventsPage).toHaveBeenCalledTimes(1);
    expect(text).toContain('id: 2\nevent: run.transitioned');
  });

  it('self-heals a terminal run that is missing its terminal event, then closes', async () => {
    // Terminal status with no terminal event (crash / legacy non-atomic write) must not poll forever: repair and close.
    const ensureTerminal = jest
      .spyOn(
        AgentRunEventService as unknown as {
          ensureTerminalEventForTerminalRun: (runUuid: string) => Promise<boolean>;
        },
        'ensureTerminalEventForTerminalRun'
      )
      .mockResolvedValue(false);
    const listRunEventsPage = jest.spyOn(AgentRunEventService, 'listRunEventsPage').mockResolvedValue({
      events: [],
      nextSequence: 1,
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

    expect(ensureTerminal).toHaveBeenCalledWith('run-1');
    expect(waitForRunEventNotification).not.toHaveBeenCalled();
    expect(listRunEventsPage).toHaveBeenCalled();
    expect(typeof text).toBe('string');
    ensureTerminal.mockRestore();
  });

  it.each([
    [undefined, 100],
    [Number.NaN, 100],
    [0, 1],
    [1.9, 1],
    [501, 500],
  ])('normalizes event page limit %p to %s', (input, expected) => {
    expect(normalizeRunEventPageLimit(input)).toBe(expected);
  });

  it('falls back to numeric relation ids and the cursor for an empty event page', async () => {
    const limit = jest.fn().mockResolvedValue([]);
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
        status: 'running',
      } as any,
      { afterSequence: -2.8, limit: Number.POSITIVE_INFINITY }
    );

    expect(whereSequence).toHaveBeenCalledWith('sequence', '>', 0);
    expect(limit).toHaveBeenCalledWith(101);
    expect(result).toEqual(
      expect.objectContaining({
        events: [],
        nextSequence: 0,
        hasMore: false,
        limit: 100,
      })
    );
  });

  it('loads a run by UUID before delegating event page construction', async () => {
    const run = { id: 17, uuid: 'run-1', status: 'running' };
    const first = jest.fn().mockResolvedValue(run);
    const select = jest.fn().mockReturnValue({ first });
    const where = jest.fn().mockReturnValue({ select });
    const joinRelated = jest.fn().mockReturnValue({ where });
    const alias = jest.fn().mockReturnValue({ joinRelated });
    mockRunQuery.mockReturnValue({ alias });
    const page = { events: [], nextSequence: 0 } as any;
    const listForRun = jest.spyOn(AgentRunEventService, 'listRunEventsPageForRun').mockResolvedValue(page);

    await expect(AgentRunEventService.listRunEventsPage('run-1', { limit: 25 })).resolves.toBe(page);

    expect(alias).toHaveBeenCalledWith('run');
    expect(joinRelated).toHaveBeenCalledWith('[thread, session]');
    expect(where).toHaveBeenCalledWith('run.uuid', 'run-1');
    expect(select).toHaveBeenCalledWith('run.*', 'thread.uuid as threadUuid', 'session.uuid as sessionUuid');
    expect(listForRun).toHaveBeenCalledWith(run, { limit: 25 });
  });

  it('returns null when event-page run lookup misses', async () => {
    const first = jest.fn().mockResolvedValue(undefined);
    const select = jest.fn().mockReturnValue({ first });
    const where = jest.fn().mockReturnValue({ select });
    const joinRelated = jest.fn().mockReturnValue({ where });
    const alias = jest.fn().mockReturnValue({ joinRelated });
    mockRunQuery.mockReturnValue({ alias });

    await expect(AgentRunEventService.listRunEventsPage('missing')).resolves.toBeNull();
  });

  it('returns immediately for nonpositive waits and already-aborted waits', async () => {
    const ensureListening = jest.spyOn(AgentRunEventService as any, 'ensureNotificationListener');

    await expect(AgentRunEventService.waitForRunEventNotification('run-1', 2, 0)).resolves.toBe(false);
    await expect(
      AgentRunEventService.waitForRunEventNotification('run-1', 2, 100, { aborted: true } as AbortSignal)
    ).resolves.toBe(false);
    expect(ensureListening).not.toHaveBeenCalled();
  });

  it('receives valid PostgreSQL notifications, ignores stale and invalid payloads, and removes its subscriber', async () => {
    let notificationHandler: ((notification: { channel?: string; payload?: string }) => void) | undefined;
    const connection = {
      on: jest.fn((event: string, handler: (notification: { channel?: string; payload?: string }) => void) => {
        if (event === 'notification') notificationHandler = handler;
      }),
      query: jest.fn().mockResolvedValue(undefined),
      removeListener: jest.fn(),
    };
    const acquireConnection = jest.fn().mockResolvedValue(connection);
    mockRunEventKnex.mockReturnValue({
      client: {
        acquireConnection,
        releaseConnection: jest.fn(),
      },
    });

    const promise = AgentRunEventService.waitForRunEventNotification('run-1', 7, 5000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(notificationHandler).toBeDefined();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((globalThis as any).__lifecycleRunEventNotify?.subscribers?.has('run-1')) break;
      await Promise.resolve();
    }
    expect((globalThis as any).__lifecycleRunEventNotify.subscribers.has('run-1')).toBe(true);

    notificationHandler?.({ channel: 'agent_run_events', payload: undefined });
    notificationHandler?.({ channel: 'agent_run_events', payload: '{invalid' });
    notificationHandler?.({ channel: 'agent_run_events', payload: JSON.stringify({ runId: 'run-1' }) });
    notificationHandler?.({
      channel: 'agent_run_events',
      payload: JSON.stringify({ runId: 'run-1', latestSequence: 7 }),
    });
    notificationHandler?.({
      channel: 'agent_run_events',
      payload: JSON.stringify({ runId: 'unsubscribed-run', latestSequence: 9 }),
    });
    notificationHandler?.({
      channel: 'agent_run_events',
      payload: JSON.stringify({ runId: 'run-1', latestSequence: 8 }),
    });

    await expect(promise).resolves.toBe(true);
    expect((globalThis as any).__lifecycleRunEventNotify.subscribers.has('run-1')).toBe(false);
  });

  it('cleans a notification wait on abort and on timeout', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(AgentRunEventService as any, 'ensureNotificationListener').mockResolvedValue(undefined);
      const controller = new AbortController();
      const aborted = AgentRunEventService.waitForRunEventNotification('run-abort', 0, 1000, controller.signal);
      await Promise.resolve();
      controller.abort();
      await expect(aborted).resolves.toBe(false);

      const timedOut = AgentRunEventService.waitForRunEventNotification('run-timeout', 0, 50);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(50);
      await expect(timedOut).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('contains PostgreSQL notify failures', async () => {
    const failure = new Error('notify unavailable');
    const raw = jest.fn().mockRejectedValue(failure);
    mockRunEventKnex.mockReturnValue({ raw });

    await expect(AgentRunEventService.notifyRunEventsInserted('run-1', 9)).resolves.toBeUndefined();

    expect(raw).toHaveBeenCalledWith('select pg_notify(?, ?)', [
      'agent_run_events',
      JSON.stringify({ runId: 'run-1', latestSequence: 9 }),
    ]);
  });

  it('emits keepalives while a run remains open before its terminal event arrives', async () => {
    const terminalEvent = {
      uuid: 'event-2',
      runUuid: 'run-1',
      threadUuid: 'thread-1',
      sessionUuid: 'session-1',
      runId: 17,
      sequence: 2,
      eventType: 'run.completed',
      payload: { status: 'completed' },
      createdAt: null,
      updatedAt: null,
    } as any;
    jest
      .spyOn(AgentRunEventService, 'listRunEventsPage')
      .mockResolvedValueOnce({
        events: [],
        nextSequence: 1,
        hasMore: false,
        run: { id: 'run-1', status: 'running' },
        limit: 1,
        maxLimit: 500,
      })
      .mockResolvedValueOnce({
        events: [terminalEvent],
        nextSequence: 2,
        hasMore: false,
        run: { id: 'run-1', status: 'completed' },
        limit: 1,
        maxLimit: 500,
      });
    const findOne = jest
      .fn()
      .mockResolvedValueOnce({ uuid: 'run-1', status: 'running' })
      .mockResolvedValueOnce({ uuid: 'run-1', status: 'completed' });
    mockRunQuery.mockReturnValue({ findOne });
    const wait = jest.spyOn(AgentRunEventService, 'waitForRunEventNotification').mockResolvedValue(false);

    const text = await new Response(
      AgentRunEventService.createCanonicalRunEventStream('run-1', Number.NaN, {
        pageLimit: 0,
        pollIntervalMs: 5,
      })
    ).text();

    expect(wait).toHaveBeenCalledWith('run-1', 1, 5, expect.any(AbortSignal));
    expect(text).toContain(': keepalive');
    expect(text).toContain('event: run.completed');
  });

  it('closes a stream whose run or event page no longer exists and supports consumer cancellation', async () => {
    const list = jest.spyOn(AgentRunEventService, 'listRunEventsPage').mockResolvedValue(null);
    const missingPageText = await new Response(AgentRunEventService.createCanonicalRunEventStream('missing', 0)).text();
    expect(missingPageText).toBe('');

    list.mockImplementation(() => new Promise(() => undefined));
    const stream = AgentRunEventService.createCanonicalRunEventStream('run-1', 0);
    await expect(stream.cancel()).resolves.toBeUndefined();
  });

  it('does not enqueue a page that finishes loading after the consumer disconnects', async () => {
    let resolvePage!: (page: any) => void;
    const page = new Promise<any>((resolve) => {
      resolvePage = resolve;
    });
    const list = jest.spyOn(AgentRunEventService, 'listRunEventsPage').mockReturnValue(page);
    const stream = AgentRunEventService.createCanonicalRunEventStream('run-1', 0);

    await expect(stream.cancel()).resolves.toBeUndefined();
    resolvePage({
      events: [
        {
          uuid: 'event-1',
          runUuid: 'run-1',
          threadUuid: 'thread-1',
          sessionUuid: 'session-1',
          runId: 17,
          sequence: 1,
          eventType: 'message.delta',
          payload: { partType: 'text', partId: 'text-1', delta: 'late' },
          createdAt: null,
          updatedAt: null,
        },
      ],
      nextSequence: 1,
      hasMore: false,
      run: { id: 'run-1', status: 'running' },
      limit: 100,
      maxLimit: 500,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(list).toHaveBeenCalledTimes(1);
    expect(mockRunQuery).not.toHaveBeenCalled();
  });

  it('does not enqueue a keepalive when the consumer disconnects during the run lookup', async () => {
    jest.spyOn(AgentRunEventService, 'listRunEventsPage').mockResolvedValue({
      events: [],
      nextSequence: 0,
      hasMore: false,
      run: { id: 'run-1', status: 'running' },
      limit: 100,
      maxLimit: 500,
    });
    let resolveRun!: (run: any) => void;
    const run = new Promise<any>((resolve) => {
      resolveRun = resolve;
    });
    const findOne = jest.fn().mockReturnValue(run);
    mockRunQuery.mockReturnValue({ findOne });
    const wait = jest.spyOn(AgentRunEventService, 'waitForRunEventNotification');
    const stream = AgentRunEventService.createCanonicalRunEventStream('run-1', 0);

    await Promise.resolve();
    await expect(stream.cancel()).resolves.toBeUndefined();
    resolveRun({ uuid: 'run-1', status: 'running' });
    await Promise.resolve();
    await Promise.resolve();

    expect(findOne).toHaveBeenCalledWith({ uuid: 'run-1' });
    expect(wait).not.toHaveBeenCalled();
  });

  it('closes after draining when the run disappears before its status check', async () => {
    jest.spyOn(AgentRunEventService, 'listRunEventsPage').mockResolvedValue({
      events: [],
      nextSequence: 0,
      hasMore: false,
      run: { id: 'run-1', status: 'running' },
      limit: 100,
      maxLimit: 500,
    });
    mockRunQuery.mockReturnValue({ findOne: jest.fn().mockResolvedValue(undefined) });

    await expect(new Response(AgentRunEventService.createCanonicalRunEventStream('run-1', 0)).text()).resolves.toBe('');
  });

  it('closes when the terminal-status final drain can no longer find the run page', async () => {
    jest
      .spyOn(AgentRunEventService, 'listRunEventsPage')
      .mockResolvedValueOnce({
        events: [],
        nextSequence: 0,
        hasMore: false,
        run: { id: 'run-1', status: 'running' },
        limit: 100,
        maxLimit: 500,
      })
      .mockResolvedValueOnce(null);
    mockRunQuery.mockReturnValue({
      findOne: jest.fn().mockResolvedValue({ uuid: 'run-1', status: 'completed' }),
    });

    await expect(new Response(AgentRunEventService.createCanonicalRunEventStream('run-1', 0)).text()).resolves.toBe('');
  });

  it('repairs a missing terminal event atomically and notifies the stream', async () => {
    const trx = { id: 'trx' };
    mockRunTransaction.mockImplementation(async (callback) => callback(trx));
    const run = {
      id: 17,
      uuid: 'run-1',
      status: 'completed',
      error: null,
      usageSummary: undefined,
      transition: null,
    };
    const forUpdate = jest.fn().mockResolvedValue(run);
    const runFindOne = jest.fn().mockReturnValue({ forUpdate });
    mockRunQuery.mockReturnValue({ findOne: runFindOne });
    const existingFirst = jest.fn().mockResolvedValue(undefined);
    const latestFirst = jest.fn().mockResolvedValue({ sequence: 4 });
    const insert = jest.fn().mockResolvedValue(undefined);
    mockRunEventQuery
      .mockReturnValueOnce({ where: jest.fn(() => ({ first: existingFirst })) })
      .mockReturnValueOnce({
        where: jest.fn(() => ({ orderBy: jest.fn(() => ({ first: latestFirst })) })),
      })
      .mockReturnValueOnce({ insert });

    await expect((AgentRunEventService as any).ensureTerminalEventForTerminalRun('run-1')).resolves.toBe(true);

    expect(insert).toHaveBeenCalledWith([
      {
        runId: 17,
        sequence: 5,
        eventType: 'run.completed',
        payload: {
          status: 'completed',
          error: null,
          usageSummary: {},
          transition: null,
          repaired: true,
        },
      },
    ]);
    expect(mockRunEventKnex().raw).toHaveBeenCalledWith('select pg_notify(?, ?)', [
      'agent_run_events',
      JSON.stringify({ runId: 'run-1', latestSequence: 5 }),
    ]);
  });

  it('does not repair a missing, open, or already-repaired terminal run', async () => {
    const missingForUpdate = jest.fn().mockResolvedValue(undefined);
    mockRunQuery.mockReturnValueOnce({ findOne: jest.fn(() => ({ forUpdate: missingForUpdate })) });
    await expect((AgentRunEventService as any).ensureTerminalEventForTerminalRun('missing')).resolves.toBe(false);

    const runningForUpdate = jest.fn().mockResolvedValue({ id: 17, uuid: 'run-1', status: 'running' });
    mockRunQuery.mockReturnValueOnce({ findOne: jest.fn(() => ({ forUpdate: runningForUpdate })) });
    await expect((AgentRunEventService as any).ensureTerminalEventForTerminalRun('run-1')).resolves.toBe(false);

    const completed = { id: 17, uuid: 'run-1', status: 'completed' };
    mockRunQuery.mockReturnValueOnce({
      findOne: jest.fn(() => ({ forUpdate: jest.fn().mockResolvedValue(completed) })),
    });
    mockRunEventQuery.mockReturnValueOnce({
      where: jest.fn(() => ({ first: jest.fn().mockResolvedValue({ id: 99 }) })),
    });
    await expect((AgentRunEventService as any).ensureTerminalEventForTerminalRun('run-1')).resolves.toBe(false);
    expect(mockRunEventKnex().raw).not.toHaveBeenCalled();
  });

  it('appends a single event after the latest sequence and reports a missing locked run', async () => {
    const lockedRun = { id: 17, uuid: 'run-1', status: 'running' };
    mockRunQuery.mockReturnValueOnce({
      findById: jest.fn(() => ({ forUpdate: jest.fn().mockResolvedValue(lockedRun) })),
    });
    const latestFirst = jest.fn().mockResolvedValue({ sequence: 3 });
    const insert = jest.fn().mockResolvedValue(undefined);
    mockRunEventQuery
      .mockReturnValueOnce({
        where: jest.fn(() => ({ orderBy: jest.fn(() => ({ first: latestFirst })) })),
      })
      .mockReturnValueOnce({ insert });

    await expect(AgentRunEventService.appendEvent(17, 'run.note', { note: 'hello' })).resolves.toBe(4);
    expect(insert).toHaveBeenCalledWith([
      { runId: 17, sequence: 4, eventType: 'run.note', payload: { note: 'hello' } },
    ]);

    mockRunQuery.mockReturnValueOnce({
      findById: jest.fn(() => ({ forUpdate: jest.fn().mockResolvedValue(undefined) })),
    });
    await expect(AgentRunEventService.appendEvent(18, 'run.note', {})).rejects.toThrow('Agent run not found');
  });

  it('appends status events for an existing run and ignores a missing run', async () => {
    const run = { id: 17, uuid: 'run-1', status: 'running' };
    mockRunQuery
      .mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(run) })
      .mockReturnValueOnce({
        findById: jest.fn(() => ({ forUpdate: jest.fn().mockResolvedValue(run) })),
      });

    await expect(AgentRunEventService.appendStatusEvent('missing', 'run.failed', {})).resolves.toBeUndefined();

    const latestFirst = jest.fn().mockResolvedValue(undefined);
    const insert = jest.fn().mockResolvedValue(undefined);
    mockRunEventQuery
      .mockReturnValueOnce({
        where: jest.fn(() => ({ orderBy: jest.fn(() => ({ first: latestFirst })) })),
      })
      .mockReturnValueOnce({ insert });
    await AgentRunEventService.appendStatusEvent('run-1', 'run.completed', { status: 'completed' });

    expect(insert).toHaveBeenCalledWith([
      { runId: 17, sequence: 1, eventType: 'run.completed', payload: { status: 'completed' } },
    ]);
    expect(mockRunEventKnex().raw).toHaveBeenCalled();
  });

  it('handles empty and missing-run chunk append requests without writes', async () => {
    await AgentRunEventService.appendEventsForChunks('run-1', []);
    await AgentRunEventService.appendEventsForChunksForExecutionOwner('run-1', 'worker-1', []);
    await expect(
      AgentRunEventService.appendChunkEventsForRunInTransaction({ id: 17 }, [], {} as any)
    ).resolves.toBeNull();
    expect(mockRunQuery).not.toHaveBeenCalled();

    mockRunQuery
      .mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(undefined) });
    await AgentRunEventService.appendEventsForChunks('missing', [{ type: 'start' } as any]);
    await AgentRunEventService.appendEventsForChunksForExecutionOwner('missing', 'worker-1', [
      { type: 'start' } as any,
    ]);
    expect(mockRunEventQuery).not.toHaveBeenCalled();
  });

  it('appends chunk and status events inside a caller-owned transaction without locking the run', async () => {
    const trx = { id: 'trx' } as any;
    const latestFirst = jest.fn().mockResolvedValue(undefined);
    const chunkInsert = jest.fn().mockResolvedValue(undefined);
    const statusLatestFirst = jest.fn().mockResolvedValue({ sequence: 1 });
    const statusInsert = jest.fn().mockResolvedValue(undefined);
    mockRunEventQuery
      .mockReturnValueOnce({
        where: jest.fn(() => ({ orderBy: jest.fn(() => ({ first: latestFirst })) })),
      })
      .mockReturnValueOnce({ insert: chunkInsert })
      .mockReturnValueOnce({
        where: jest.fn(() => ({ orderBy: jest.fn(() => ({ first: statusLatestFirst })) })),
      })
      .mockReturnValueOnce({ insert: statusInsert });

    await expect(
      AgentRunEventService.appendChunkEventsForRunInTransaction(
        { id: 17, uuid: 'run-1' },
        [{ type: 'text-delta', id: 'text-1', delta: 'Hello' } as any],
        trx
      )
    ).resolves.toBe(1);
    await expect(
      AgentRunEventService.appendStatusEventForRunInTransaction(
        { id: 17, uuid: 'run-1' },
        'run.completed',
        { status: 'completed' },
        trx
      )
    ).resolves.toBe(2);

    expect(mockRunQuery).not.toHaveBeenCalled();
    expect(chunkInsert).toHaveBeenCalled();
    expect(statusInsert).toHaveBeenCalled();
  });

  it('serializes fallback identifiers and nullish public fields', () => {
    expect(
      AgentRunEventService.serializeRunEvent({
        uuid: 'event-1',
        runId: 17,
        threadId: 11,
        sessionId: 13,
        sequence: 1,
        eventType: 'run.note',
        payload: null,
        createdAt: undefined,
        updatedAt: undefined,
      } as any)
    ).toEqual({
      id: 'event-1',
      runId: '17',
      threadId: '11',
      sessionId: '13',
      sequence: 1,
      eventType: 'run.note',
      version: 1,
      payload: {},
      createdAt: null,
      updatedAt: null,
    });
  });
});
