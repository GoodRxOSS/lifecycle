/**
 * Copyright 2025 GoodRx, Inc.
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

const mockGetConversation = jest.fn();

jest.mock('../storage', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getConversation: mockGetConversation,
  })),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('server/lib/logger', () => ({
  getLogger: () => mockLogger,
}));

jest.mock('server/models/Conversation', () => {
  const model: any = {};
  model.query = jest.fn();
  model.transact = jest.fn();
  return { __esModule: true, default: model };
});

jest.mock('server/models/ConversationMessage', () => {
  const model: any = {};
  model.query = jest.fn();
  return { __esModule: true, default: model };
});

import ConversationPersistenceService from '../persistence';
import AIAgentConversationService from '../storage';
import Conversation from 'server/models/Conversation';
import ConversationMessage from 'server/models/ConversationMessage';

const MockConversation = Conversation as any;
const MockConversationMessage = ConversationMessage as any;

interface TransactionSetup {
  existingConversation?: any;
  existingMessages?: Array<{ role: string; timestamp: number }>;
  onConversationInsert?: (row: any) => void;
  onConversationPatch?: (row: any) => void;
  onMessageInsert?: (rows: any[]) => void;
}

function setupTransaction({
  existingConversation,
  existingMessages = [],
  onConversationInsert,
  onConversationPatch,
  onMessageInsert,
}: TransactionSetup) {
  const findById = jest.fn().mockResolvedValue(existingConversation);
  const insertConversation = jest.fn().mockImplementation(async (row: any) => {
    onConversationInsert?.(row);
    return row;
  });
  const patchWhere = jest.fn().mockResolvedValue(1);
  const patchConversation = jest.fn().mockImplementation((row: any) => {
    onConversationPatch?.(row);
    return { where: patchWhere };
  });

  const selectMessages = jest.fn().mockResolvedValue(existingMessages);
  const whereMessages = jest.fn().mockReturnValue({ select: selectMessages });
  const insertMessages = jest.fn().mockImplementation(async (rows: any[]) => {
    onMessageInsert?.(rows);
    return rows;
  });

  MockConversation.transact.mockImplementation(async (cb: any) => {
    const trx = { id: 'mock-trx' };

    MockConversation.query.mockImplementation((arg: any) => {
      if (arg === trx) {
        return {
          findById,
          insert: insertConversation,
          patch: patchConversation,
        };
      }
      return {};
    });

    MockConversationMessage.query.mockImplementation((arg: any) => {
      if (arg === trx) {
        return {
          where: whereMessages,
          insert: insertMessages,
        };
      }
      return {};
    });

    return cb(trx);
  });

  return {
    findById,
    insertConversation,
    patchConversation,
    patchWhere,
    whereMessages,
    selectMessages,
    insertMessages,
  };
}

describe('ConversationPersistenceService', () => {
  let service: ConversationPersistenceService;

  beforeEach(() => {
    jest.clearAllMocks();
    const conversationService = new AIAgentConversationService({} as any, {} as any, {} as any, {} as any);
    service = new ConversationPersistenceService(conversationService);
  });

  describe('persistConversation', () => {
    it('returns false when Redis has no conversation', async () => {
      mockGetConversation.mockResolvedValue(null);

      const result = await service.persistConversation('uuid-1', 'my-org/my-repo');

      expect(result).toBe(false);
      expect(mockGetConversation).toHaveBeenCalledWith('uuid-1');
      expect(MockConversation.transact).not.toHaveBeenCalled();
    });

    it('returns false when Redis conversation has empty messages', async () => {
      mockGetConversation.mockResolvedValue({
        buildUuid: 'uuid-1',
        messages: [],
        lastActivity: 1000,
      });

      const result = await service.persistConversation('uuid-1', 'my-org/my-repo');

      expect(result).toBe(false);
      expect(MockConversation.transact).not.toHaveBeenCalled();
    });

    it('persists a new conversation and all messages', async () => {
      const conversation = {
        buildUuid: 'uuid-1',
        messages: [
          { role: 'user', content: 'hello', timestamp: 1000 },
          { role: 'assistant', content: 'hi there', timestamp: 1001 },
          { role: 'user', content: 'thanks', timestamp: 1002 },
        ],
        lastActivity: 1002,
        contextSnapshot: { buildUuid: 'uuid-1' },
      };
      mockGetConversation.mockResolvedValue(conversation);

      let insertedConversation: any;
      let insertedMessages: any[] = [];
      setupTransaction({
        existingConversation: undefined,
        existingMessages: [],
        onConversationInsert: (row) => {
          insertedConversation = row;
        },
        onMessageInsert: (rows) => {
          insertedMessages = rows;
        },
      });

      const result = await service.persistConversation('uuid-1', 'my-org/my-repo', 'gpt-4');

      expect(result).toBe(true);
      expect(insertedConversation).toMatchObject({
        buildUuid: 'uuid-1',
        repo: 'my-org/my-repo',
        model: 'gpt-4',
        messageCount: 3,
        metadata: {
          contextSnapshot: { buildUuid: 'uuid-1' },
          lastActivity: 1002,
        },
      });
      expect(insertedMessages).toHaveLength(3);
      expect(mockLogger.info).toHaveBeenCalledWith('AI: conversation persisted buildUuid=uuid-1 messageCount=3');
    });

    it('syncs existing conversation and inserts only missing messages', async () => {
      const conversation = {
        buildUuid: 'uuid-2',
        messages: [
          { role: 'user', content: 'first', timestamp: 1000 },
          { role: 'assistant', content: 'second', timestamp: 1001 },
          { role: 'assistant', content: 'third', timestamp: 1002 },
        ],
        lastActivity: 1002,
      };
      mockGetConversation.mockResolvedValue(conversation);

      let patchedConversation: any;
      let insertedMessages: any[] = [];
      setupTransaction({
        existingConversation: { buildUuid: 'uuid-2', repo: 'org/repo', model: null },
        existingMessages: [
          { role: 'user', timestamp: 1000 },
          { role: 'assistant', timestamp: 1001 },
        ],
        onConversationPatch: (row) => {
          patchedConversation = row;
        },
        onMessageInsert: (rows) => {
          insertedMessages = rows;
        },
      });

      const result = await service.persistConversation('uuid-2', 'org/repo');

      expect(result).toBe(true);
      expect(insertedMessages).toHaveLength(1);
      expect(insertedMessages[0]).toMatchObject({
        buildUuid: 'uuid-2',
        role: 'assistant',
        content: 'third',
        timestamp: 1002,
      });
      expect(patchedConversation).toMatchObject({
        repo: 'org/repo',
        messageCount: 3,
      });
    });

    it('truncates large tool results in metadata', async () => {
      const largeResult = 'x'.repeat(20000);
      const conversation = {
        buildUuid: 'uuid-3',
        messages: [
          {
            role: 'assistant',
            content: 'done',
            timestamp: 1000,
            debugToolData: [
              {
                toolCallId: 'tc-1',
                toolName: 'kubectl',
                toolArgs: { cmd: 'get pods' },
                toolResult: largeResult,
              },
            ],
          },
        ],
        lastActivity: 1000,
      };
      mockGetConversation.mockResolvedValue(conversation);

      let insertedMessages: any[] = [];
      setupTransaction({
        existingConversation: undefined,
        existingMessages: [],
        onMessageInsert: (rows) => {
          insertedMessages = rows;
        },
      });

      await service.persistConversation('uuid-3', 'org/repo');

      expect(insertedMessages).toHaveLength(1);
      const storedToolData = insertedMessages[0].metadata.debugToolData;
      expect(storedToolData[0].toolResult).toHaveLength(10000 + '... [truncated]'.length);
      expect(storedToolData[0].toolResult).toContain('... [truncated]');
    });

    it('returns false and logs error on Postgres failure', async () => {
      const conversation = {
        buildUuid: 'uuid-fail',
        messages: [{ role: 'user', content: 'hi', timestamp: 1000 }],
        lastActivity: 1000,
      };
      mockGetConversation.mockResolvedValue(conversation);

      MockConversation.transact.mockRejectedValue(new Error('persistent failure'));

      const result = await service.persistConversation('uuid-fail', 'org/repo');

      expect(result).toBe(false);
      expect(MockConversation.transact).toHaveBeenCalledTimes(3);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('AI: conversation persistence failed buildUuid=uuid-fail')
      );
    });
  });
});
