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

import AIAgentConversationService from '../storage';

describe('AIAgentConversationService', () => {
  let service: AIAgentConversationService;
  let mockRedis: {
    get: jest.Mock;
    setex: jest.Mock;
    del: jest.Mock;
    expire: jest.Mock;
  };

  beforeEach(() => {
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      expire: jest.fn(),
    };
    service = new AIAgentConversationService({} as any, mockRedis as any, {} as any, {} as any);
  });

  describe('getConversation', () => {
    it('returns parsed conversation when it exists', async () => {
      const stored = { buildUuid: 'uuid-1', messages: [{ role: 'user', content: 'hi' }], lastActivity: 123 };
      mockRedis.get.mockResolvedValue(JSON.stringify(stored));

      const result = await service.getConversation('uuid-1');

      expect(result).toEqual(stored);
      expect(mockRedis.get).toHaveBeenCalledWith('lifecycle:agent:conversation:uuid-1');
    });

    it('returns null when conversation does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await service.getConversation('uuid-1');
      expect(result).toBeNull();
    });
  });

  describe('addMessage', () => {
    it('creates new conversation when none exists', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.addMessage('uuid-1', { role: 'user', content: 'hello' } as any);

      expect(result.messages).toHaveLength(1);
      expect(result.buildUuid).toBe('uuid-1');
      expect(mockRedis.setex).toHaveBeenCalledWith('lifecycle:agent:conversation:uuid-1', 3600, expect.any(String));
    });

    it('appends to existing conversation', async () => {
      const existing = { buildUuid: 'uuid-1', messages: [{ role: 'user', content: 'hi' }], lastActivity: 100 };
      mockRedis.get.mockResolvedValue(JSON.stringify(existing));

      const result = await service.addMessage('uuid-1', { role: 'assistant', content: 'hello' } as any);

      expect(result.messages).toHaveLength(2);
      expect(mockRedis.setex).toHaveBeenCalledWith('lifecycle:agent:conversation:uuid-1', 3600, expect.any(String));
    });
  });

  describe('clearConversation', () => {
    it('returns message count and deletes key when conversation exists', async () => {
      const stored = {
        buildUuid: 'uuid-1',
        messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }],
        lastActivity: 123,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(stored));

      const count = await service.clearConversation('uuid-1');

      expect(count).toBe(3);
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:conversation:uuid-1');
    });

    it('returns 0 when conversation does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);
      const count = await service.clearConversation('uuid-1');
      expect(count).toBe(0);
    });
  });

  describe('refreshTTL', () => {
    it('calls redis expire with correct key and TTL', async () => {
      await service.refreshTTL('uuid-1');
      expect(mockRedis.expire).toHaveBeenCalledWith('lifecycle:agent:conversation:uuid-1', 3600);
    });
  });
});
