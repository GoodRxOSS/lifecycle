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

jest.mock('server/models/AgentMessage', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentRun', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('../ThreadService', () => ({
  __esModule: true,
  default: {
    getOwnedThread: jest.fn(),
    getOwnedThreadWithSession: jest.fn(),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => '11111111-1111-4111-8111-111111111111'),
}));

import AgentMessage from 'server/models/AgentMessage';
import AgentMessageStore from '../MessageStore';
import AgentThreadService from '../ThreadService';

const mockMessageQuery = AgentMessage.query as jest.Mock;
const mockGetOwnedThread = AgentThreadService.getOwnedThread as jest.Mock;

describe('AgentMessageStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageQuery.mockReset();
    mockGetOwnedThread.mockReset();
  });

  describe('serializeCanonicalMessage', () => {
    it('returns the public canonical message shape', () => {
      expect(
        AgentMessageStore.serializeCanonicalMessage(
          {
            uuid: '22222222-2222-4222-8222-222222222222',
            clientMessageId: 'client-message-1',
            role: 'user',
            parts: [{ type: 'text', text: 'Hello' }],
            metadata: { ignored: true },
            createdAt: '2026-04-25T00:00:00.000Z',
          } as any,
          'thread-uuid',
          'run-uuid'
        )
      ).toEqual({
        id: '22222222-2222-4222-8222-222222222222',
        clientMessageId: 'client-message-1',
        threadId: 'thread-uuid',
        runId: 'run-uuid',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        createdAt: '2026-04-25T00:00:00.000Z',
      });
    });

    it('prefers run.startedAt for assistant createdAt over a buggy ~completion stored metadata.createdAt', () => {
      expect(
        AgentMessageStore.serializeCanonicalMessage(
          {
            uuid: '44444444-4444-4444-8444-444444444444',
            clientMessageId: null,
            role: 'assistant',
            parts: [{ type: 'text', text: 'Done' }],
            // Buggy stored values were set near completion, yielding ~0/negative durations.
            metadata: {
              runId: 'run-1',
              createdAt: '2026-04-25T00:00:08.900Z',
              completedAt: '2026-04-25T00:00:09.000Z',
            },
            runStartedAt: '2026-04-25T00:00:01.000Z',
            runCompletedAt: '2026-04-25T00:00:09.000Z',
            createdAt: '2026-04-25T00:00:08.950Z',
          } as any,
          'thread-uuid'
        )
      ).toEqual(
        expect.objectContaining({
          role: 'assistant',
          metadata: {
            runId: 'run-1',
            createdAt: '2026-04-25T00:00:01.000Z',
            completedAt: '2026-04-25T00:00:09.000Z',
          },
        })
      );
    });

    it('handles run timestamps returned as Date objects from the join (not ISO strings)', () => {
      expect(
        AgentMessageStore.serializeCanonicalMessage(
          {
            uuid: '44444444-4444-4444-8444-444444444444',
            clientMessageId: null,
            role: 'assistant',
            parts: [{ type: 'text', text: 'Done' }],
            metadata: {
              runId: 'run-1',
              createdAt: '2026-04-25T00:00:08.900Z',
              completedAt: '2026-04-25T00:00:09.000Z',
            },
            runStartedAt: new Date('2026-04-25T00:00:01.000Z'),
            runCompletedAt: new Date('2026-04-25T00:00:09.000Z'),
            createdAt: '2026-04-25T00:00:08.950Z',
          } as any,
          'thread-uuid'
        )
      ).toEqual(
        expect.objectContaining({
          role: 'assistant',
          metadata: {
            runId: 'run-1',
            createdAt: '2026-04-25T00:00:01.000Z',
            completedAt: '2026-04-25T00:00:09.000Z',
          },
        })
      );
    });

    it('falls back to stored metadata, then the row created time, when run.startedAt is absent', () => {
      expect(
        AgentMessageStore.serializeCanonicalMessage(
          {
            uuid: '44444444-4444-4444-8444-444444444444',
            clientMessageId: null,
            role: 'assistant',
            parts: [{ type: 'text', text: 'Done' }],
            metadata: { runId: 'run-1', createdAt: '2026-04-25T00:00:02.000Z' },
            runCompletedAt: '2026-04-25T00:00:09.000Z',
            createdAt: '2026-04-25T00:00:05.000Z',
          } as any,
          'thread-uuid'
        )
      ).toEqual(
        expect.objectContaining({
          role: 'assistant',
          metadata: {
            runId: 'run-1',
            createdAt: '2026-04-25T00:00:02.000Z',
            completedAt: '2026-04-25T00:00:09.000Z',
          },
        })
      );
    });

    it('clamps the served createdAt to completedAt when run.startedAt is later than completion', () => {
      expect(
        AgentMessageStore.serializeCanonicalMessage(
          {
            uuid: '44444444-4444-4444-8444-444444444444',
            clientMessageId: null,
            role: 'assistant',
            parts: [{ type: 'text', text: 'Done' }],
            metadata: { runId: 'run-1' },
            runStartedAt: '2026-04-25T00:00:10.000Z',
            runCompletedAt: '2026-04-25T00:00:09.000Z',
            createdAt: '2026-04-25T00:00:08.000Z',
          } as any,
          'thread-uuid'
        )
      ).toEqual(
        expect.objectContaining({
          role: 'assistant',
          metadata: {
            runId: 'run-1',
            createdAt: '2026-04-25T00:00:09.000Z',
            completedAt: '2026-04-25T00:00:09.000Z',
          },
        })
      );
    });

    it('falls back to the assistant row created time when no run timestamps exist', () => {
      const serialized = AgentMessageStore.serializeCanonicalMessage(
        {
          uuid: '55555555-5555-4555-8555-555555555555',
          clientMessageId: null,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Done' }],
          metadata: {},
          createdAt: '2026-04-25T00:00:00.000Z',
        } as any,
        'thread-uuid'
      );

      expect(serialized.metadata).toEqual({
        createdAt: '2026-04-25T00:00:00.000Z',
        completedAt: '2026-04-25T00:00:00.000Z',
      });
    });

    it('returns typed agent switch system messages but rejects unrelated system messages', () => {
      const switchMessage = AgentMessageStore.serializeCanonicalMessage(
        {
          uuid: '22222222-2222-4222-8222-222222222222',
          clientMessageId: null,
          role: 'system',
          parts: [{ type: 'text', text: 'You switched Debug -> Develop. Applies to future runs.' }],
          metadata: {
            kind: 'agent_switch',
            beforeAgent: { id: 'system.debug', label: 'Debug' },
            afterAgent: { id: 'system.develop', label: 'Develop' },
          },
          createdAt: '2026-04-25T00:00:00.000Z',
        } as any,
        'thread-uuid'
      );

      expect(switchMessage).toEqual(
        expect.objectContaining({
          role: 'system',
          metadata: expect.objectContaining({ kind: 'agent_switch' }),
        })
      );
      expect(() =>
        AgentMessageStore.serializeCanonicalMessage(
          {
            uuid: '33333333-3333-4333-8333-333333333333',
            role: 'system',
            parts: [{ type: 'text', text: 'Hidden status' }],
            metadata: { kind: 'internal_status' },
          } as any,
          'thread-uuid'
        )
      ).toThrow('Agent message is not a public canonical message');
    });
  });

  describe('createAgentSwitchEvent', () => {
    it('inserts a server-authored agent_switch system event with metadata fields and no run id', async () => {
      const insertAndFetch = jest.fn().mockResolvedValue({ uuid: 'message-1' });
      mockMessageQuery.mockReturnValueOnce({ insertAndFetch });

      await AgentMessageStore.createAgentSwitchEvent({
        thread: { id: 17 },
        actor: { userId: 'sample-user', label: 'You' },
        beforeAgent: { id: 'system.debug', label: 'Debug' },
        afterAgent: { id: 'system.develop', label: 'Develop' },
        occurredAt: '2026-05-01T00:00:00.000Z',
      });

      expect(insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 17,
          runId: null,
          role: 'system',
          parts: [{ type: 'text', text: 'You switched Debug -> Develop. Applies to future runs.' }],
          metadata: expect.objectContaining({
            kind: 'agent_switch',
            actor: { userId: 'sample-user', label: 'You' },
            beforeAgent: { id: 'system.debug', label: 'Debug' },
            afterAgent: { id: 'system.develop', label: 'Develop' },
            appliesTo: 'future_runs',
            occurredAt: '2026-05-01T00:00:00.000Z',
          }),
        })
      );
    });

    it('inserts a custom agent switch event with label-only visible copy and backend id metadata', async () => {
      const insertAndFetch = jest.fn().mockResolvedValue({ uuid: 'message-1' });
      mockMessageQuery.mockReturnValueOnce({ insertAndFetch });

      await AgentMessageStore.createAgentSwitchEvent({
        thread: { id: 17 },
        actor: { userId: 'sample-user', label: 'Sample User' },
        beforeAgent: { id: 'system.debug', label: 'Debug' },
        afterAgent: { id: 'custom.sample-agent', label: 'Custom helper' },
        occurredAt: '2026-05-01T00:00:00.000Z',
      });

      expect(insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: [{ type: 'text', text: 'Sample User switched Debug -> Custom helper. Applies to future runs.' }],
          metadata: expect.objectContaining({
            kind: 'agent_switch',
            beforeAgent: { id: 'system.debug', label: 'Debug' },
            afterAgent: { id: 'custom.sample-agent', label: 'Custom helper' },
          }),
        })
      );
      expect(JSON.stringify(insertAndFetch.mock.calls[0][0].parts)).not.toContain('custom.sample-agent');
    });
  });

  describe('createRuntimeControlsUpdateEvent', () => {
    it('inserts a runtime_controls_update system event describing the tool diff', async () => {
      const insertAndFetch = jest.fn().mockResolvedValue({ uuid: 'message-1' });
      mockMessageQuery.mockReturnValueOnce({ insertAndFetch });

      await AgentMessageStore.createRuntimeControlsUpdateEvent({
        thread: { id: 17 },
        actor: { userId: 'sample-user', label: 'Sample User' },
        enabled: [{ id: 'rtc_a', label: 'GitHub' }],
        disabled: [
          { id: 'rtc_b', label: 'Workspace files' },
          { id: 'rtc_c', label: 'Sample MCP' },
        ],
        occurredAt: '2026-07-04T00:00:00.000Z',
      });

      expect(insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 17,
          runId: null,
          role: 'system',
          parts: [
            {
              type: 'text',
              text: 'Sample User changed the available tools: enabled GitHub; disabled Workspace files, Sample MCP. Applies to future runs.',
            },
          ],
          metadata: expect.objectContaining({
            kind: 'runtime_controls_update',
            actor: { userId: 'sample-user', label: 'Sample User' },
            enabled: [{ id: 'rtc_a', label: 'GitHub' }],
            disabled: [
              { id: 'rtc_b', label: 'Workspace files' },
              { id: 'rtc_c', label: 'Sample MCP' },
            ],
            appliesTo: 'future_runs',
            occurredAt: '2026-07-04T00:00:00.000Z',
          }),
        })
      );
    });

    it('phrases an enable-only change without a dangling separator', async () => {
      const insertAndFetch = jest.fn().mockResolvedValue({ uuid: 'message-1' });
      mockMessageQuery.mockReturnValueOnce({ insertAndFetch });

      await AgentMessageStore.createRuntimeControlsUpdateEvent({
        thread: { id: 17 },
        actor: { userId: 'sample-user' },
        enabled: [{ id: 'rtc_a', label: 'Slack' }],
        disabled: [],
      });

      expect(insertAndFetch.mock.calls[0][0].parts).toEqual([
        { type: 'text', text: 'You changed the available tools: enabled Slack. Applies to future runs.' },
      ]);
    });
  });

  describe('listMessages', () => {
    it('omits stored messages with no canonical parts', async () => {
      const orderBy = jest.fn().mockResolvedValue([
        {
          id: 11,
          uuid: '22222222-2222-4222-8222-222222222222',
          threadId: 17,
          role: 'assistant',
          parts: [],
          metadata: { runId: 'run-empty' },
        },
        {
          id: 12,
          uuid: '33333333-3333-4333-8333-333333333333',
          threadId: 17,
          role: 'user',
          parts: [{ type: 'text', text: 'Continue' }],
          metadata: {},
        },
      ]);
      const where = jest.fn().mockReturnValue({ orderBy });

      mockGetOwnedThread.mockResolvedValue({ id: 17, uuid: 'thread-uuid' });
      mockMessageQuery.mockReturnValueOnce({ where });

      const result = await AgentMessageStore.listMessages('thread-uuid', 'sample-user');

      expect(result).toEqual([
        expect.objectContaining({
          id: '33333333-3333-4333-8333-333333333333',
          role: 'user',
          parts: [{ type: 'text', text: 'Continue' }],
        }),
      ]);
    });
  });

  describe('syncCanonicalMessages', () => {
    it('persists canonical parts without uiMessage as the source of truth', async () => {
      const insertedRow = {
        id: 11,
        uuid: '11111111-1111-4111-8111-111111111111',
        threadId: 17,
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        uiMessage: null,
        metadata: { clientMessageId: 'client-message-1' },
      };
      const insert = jest.fn().mockResolvedValue(insertedRow);
      const orderBy = jest.fn().mockResolvedValue([insertedRow]);
      const existingWhere = jest.fn().mockResolvedValue([]);
      const reloadedWhere = jest.fn().mockReturnValue({ orderBy });

      mockGetOwnedThread.mockResolvedValue({ id: 17, uuid: 'thread-uuid' });
      mockMessageQuery
        .mockReturnValueOnce({ where: existingWhere })
        .mockReturnValueOnce({ insert })
        .mockReturnValueOnce({ where: reloadedWhere });

      const result = await AgentMessageStore.syncCanonicalMessages('thread-uuid', 'sample-user', [
        {
          id: 'client-message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
      ]);

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          uuid: '11111111-1111-4111-8111-111111111111',
          threadId: 17,
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
          uiMessage: null,
          metadata: { clientMessageId: 'client-message-1' },
        })
      );
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: '11111111-1111-4111-8111-111111111111',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
          metadata: { clientMessageId: 'client-message-1' },
        })
      );
    });

    it('reuses existing rows by canonical client message id', async () => {
      const existingRow = {
        id: 11,
        uuid: '22222222-2222-4222-8222-222222222222',
        runId: null,
        role: 'user',
        parts: [{ type: 'text', text: 'Before' }],
        uiMessage: null,
        metadata: { clientMessageId: 'client-message-1' },
      };
      const patchAndFetchById = jest.fn().mockResolvedValue(existingRow);
      const orderBy = jest.fn().mockResolvedValue([
        {
          ...existingRow,
          parts: [{ type: 'text', text: 'After' }],
        },
      ]);
      const existingWhere = jest.fn().mockResolvedValue([existingRow]);
      const reloadedWhere = jest.fn().mockReturnValue({ orderBy });

      mockGetOwnedThread.mockResolvedValue({ id: 17, uuid: 'thread-uuid' });
      mockMessageQuery
        .mockReturnValueOnce({ where: existingWhere })
        .mockReturnValueOnce({ patchAndFetchById })
        .mockReturnValueOnce({ where: reloadedWhere });

      const result = await AgentMessageStore.syncCanonicalMessages('thread-uuid', 'sample-user', [
        {
          id: 'client-message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'After' }],
        },
      ]);

      expect(patchAndFetchById).toHaveBeenCalledWith(
        11,
        expect.objectContaining({
          parts: [{ type: 'text', text: 'After' }],
          uiMessage: null,
          metadata: { clientMessageId: 'client-message-1' },
        })
      );
      expect(result).toHaveLength(1);
    });

    it('strips non-canonical parts before persisting messages', async () => {
      const insertedRow = {
        id: 11,
        uuid: '11111111-1111-4111-8111-111111111111',
        threadId: 17,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Done' }],
        uiMessage: null,
        metadata: {},
      };
      const insert = jest.fn().mockResolvedValue(insertedRow);
      const orderBy = jest.fn().mockResolvedValue([insertedRow]);
      const existingWhere = jest.fn().mockResolvedValue([]);
      const reloadedWhere = jest.fn().mockReturnValue({ orderBy });

      mockGetOwnedThread.mockResolvedValue({ id: 17, uuid: 'thread-uuid' });
      mockMessageQuery
        .mockReturnValueOnce({ where: existingWhere })
        .mockReturnValueOnce({ insert })
        .mockReturnValueOnce({ where: reloadedWhere });

      await AgentMessageStore.syncCanonicalMessages('thread-uuid', 'sample-user', [
        {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Done' },
            {
              type: 'dynamic-tool',
              toolCallId: 'tool-call-1',
              toolName: 'edit_file',
              state: 'output-available',
            } as any,
          ],
        },
      ]);

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: [{ type: 'text', text: 'Done' }],
          uiMessage: null,
        })
      );
    });
  });

  describe('upsertCanonicalMessagesForThread', () => {
    it('does not compare non-uuid client message IDs against the uuid column', async () => {
      const existingLookupQuery = {
        where: jest.fn(),
        whereIn: jest.fn(),
        orWhereIn: jest.fn(),
        whereRaw: jest.fn(),
        orWhereRaw: jest.fn(),
      };
      existingLookupQuery.where.mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') {
          arg(existingLookupQuery);
          return Promise.resolve([]);
        }
        return existingLookupQuery;
      });
      existingLookupQuery.whereIn.mockReturnValue(existingLookupQuery);
      existingLookupQuery.orWhereIn.mockReturnValue(existingLookupQuery);
      existingLookupQuery.whereRaw.mockReturnValue(existingLookupQuery);
      existingLookupQuery.orWhereRaw.mockReturnValue(existingLookupQuery);
      const insert = jest.fn().mockResolvedValue({
        id: 11,
        uuid: '11111111-1111-4111-8111-111111111111',
        metadata: { clientMessageId: 'short-client-message-id' },
      });

      mockMessageQuery.mockReturnValueOnce(existingLookupQuery).mockReturnValueOnce({ insert });

      await AgentMessageStore.upsertCanonicalMessagesForThread({ id: 17 }, [
        {
          id: 'short-client-message-id',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
      ]);

      expect(existingLookupQuery.whereIn).toHaveBeenCalledWith('clientMessageId', ['short-client-message-id']);
      expect(existingLookupQuery.whereIn).not.toHaveBeenCalledWith('uuid', expect.anything());
      expect(existingLookupQuery.orWhereRaw).toHaveBeenCalledWith('"metadata"->>? = ANY(?::text[])', [
        'clientMessageId',
        ['short-client-message-id'],
      ]);
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 17,
          role: 'user',
          clientMessageId: 'short-client-message-id',
          metadata: { clientMessageId: 'short-client-message-id' },
        })
      );
    });

    it('preserves existing assistant run ownership when saving a later run transcript', async () => {
      const existingRow = {
        id: 11,
        uuid: '22222222-2222-4222-8222-222222222222',
        threadId: 17,
        runId: 101,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Previous response' }],
        clientMessageId: null,
        metadata: { runId: 'run-old' },
      };
      const existingWhere = jest.fn().mockResolvedValue([existingRow]);
      const patchAndFetchById = jest.fn().mockResolvedValue(existingRow);
      const insert = jest.fn().mockResolvedValue({
        id: 12,
        uuid: '33333333-3333-4333-8333-333333333333',
        threadId: 17,
        runId: 202,
        role: 'assistant',
        clientMessageId: null,
        metadata: { runId: 'run-new' },
      });

      mockMessageQuery
        .mockReturnValueOnce({ where: existingWhere })
        .mockReturnValueOnce({ patchAndFetchById })
        .mockReturnValueOnce({ insert });

      await AgentMessageStore.upsertCanonicalUiMessagesForThread(
        { id: 17 },
        [
          {
            id: '22222222-2222-4222-8222-222222222222',
            role: 'assistant',
            metadata: { runId: 'run-old' },
            parts: [{ type: 'text', text: 'Previous response' }],
          } as any,
          {
            id: '33333333-3333-4333-8333-333333333333',
            role: 'assistant',
            metadata: { runId: 'run-new' },
            parts: [{ type: 'text', text: 'Current response' }],
          } as any,
        ],
        { runId: 202 }
      );

      expect(patchAndFetchById).toHaveBeenCalledWith(
        11,
        expect.objectContaining({
          runId: 101,
          parts: [{ type: 'text', text: 'Previous response' }],
        })
      );
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 17,
          role: 'assistant',
          runId: 202,
          parts: [{ type: 'text', text: 'Current response' }],
        })
      );
    });
  });

  describe('syncCanonicalMessagesFromUiMessages', () => {
    it('stores only canonical conversational parts from harness UI messages', async () => {
      const insertedRow = {
        id: 11,
        uuid: '33333333-3333-4333-8333-333333333333',
        threadId: 17,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Done' }],
        uiMessage: null,
        metadata: { runId: 'run-1' },
      };
      const insert = jest.fn().mockResolvedValue(insertedRow);
      const orderBy = jest.fn().mockResolvedValue([insertedRow]);
      const existingWhere = jest.fn().mockResolvedValue([]);
      const reloadedWhere = jest.fn().mockReturnValue({ orderBy });

      mockGetOwnedThread.mockResolvedValue({ id: 17, uuid: 'thread-uuid' });
      mockMessageQuery
        .mockReturnValueOnce({ where: existingWhere })
        .mockReturnValueOnce({ insert })
        .mockReturnValueOnce({ where: reloadedWhere });

      await AgentMessageStore.syncCanonicalMessagesFromUiMessages('thread-uuid', 'sample-user', [
        {
          id: '33333333-3333-4333-8333-333333333333',
          role: 'assistant',
          metadata: { runId: 'run-1' },
          parts: [
            { type: 'text', text: 'Done' },
            {
              type: 'dynamic-tool',
              toolCallId: 'tool-1',
              toolName: 'edit_file',
              state: 'output-available',
              output: { ok: true },
            },
          ],
        } as any,
      ]);

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          parts: [{ type: 'text', text: 'Done' }],
          uiMessage: null,
          metadata: { runId: 'run-1' },
        })
      );
    });

    it('does not persist assistant messages that only contain tool UI parts', async () => {
      const existingWhere = jest.fn().mockResolvedValue([]);
      const orderBy = jest.fn().mockResolvedValue([]);
      const reloadedWhere = jest.fn().mockReturnValue({ orderBy });

      mockGetOwnedThread.mockResolvedValue({ id: 17, uuid: 'thread-uuid' });
      mockMessageQuery.mockReturnValueOnce({ where: existingWhere }).mockReturnValueOnce({ where: reloadedWhere });

      const result = await AgentMessageStore.syncCanonicalMessagesFromUiMessages('thread-uuid', 'sample-user', [
        {
          id: '33333333-3333-4333-8333-333333333333',
          role: 'assistant',
          metadata: { runId: 'run-1' },
          parts: [
            {
              type: 'dynamic-tool',
              toolCallId: 'tool-1',
              toolName: 'write_file',
              state: 'output-available',
              output: { ok: true },
            },
          ],
        } as any,
      ]);

      expect(mockMessageQuery).toHaveBeenCalledTimes(2);
      expect(result).toEqual([]);
    });
  });
});
