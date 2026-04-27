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
              toolName: 'workspace_edit_file',
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
              toolName: 'workspace_edit_file',
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
              toolName: 'workspace_write_file',
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
