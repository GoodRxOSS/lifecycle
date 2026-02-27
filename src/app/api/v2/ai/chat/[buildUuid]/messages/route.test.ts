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

import { NextRequest } from 'next/server';

const mockGetConversation = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
}));

jest.mock('server/services/ai/conversation/storage', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getConversation: mockGetConversation,
  })),
}));

jest.mock('server/models/ConversationMessage', () => {
  const model: { query: jest.Mock } = { query: jest.fn() };
  return { __esModule: true, default: model };
});

import { GET } from './route';
import ConversationMessage from 'server/models/ConversationMessage';

const MockConversationMessage = ConversationMessage as unknown as {
  query: jest.Mock;
};

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/chat/[buildUuid]/messages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps messageId for bigint timestamps and preserves duplicate ordering', async () => {
    mockGetConversation.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          content: 'first',
          timestamp: 1700000000001,
        },
        {
          role: 'assistant',
          content: 'second',
          timestamp: 1700000000001,
        },
        {
          role: 'assistant',
          content: 'third',
          timestamp: 1700000000002,
        },
      ],
      lastActivity: 1700000005000,
    });

    const orderBy = jest.fn().mockResolvedValue([
      { id: 501, role: 'assistant', timestamp: '1700000000001' },
      { id: 502, role: 'assistant', timestamp: '1700000000001' },
      { id: 503, role: 'assistant', timestamp: '1700000000002' },
    ]);
    const select = jest.fn().mockReturnValue({ orderBy });
    const where = jest.fn().mockReturnValue({ select });
    MockConversationMessage.query.mockReturnValue({ where });

    const response = await GET(makeRequest(), { params: { buildUuid: 'uuid-1' } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.messages).toHaveLength(3);
    expect(body.data.messages[0].messageId).toBe(501);
    expect(body.data.messages[1].messageId).toBe(502);
    expect(body.data.messages[2].messageId).toBe(503);
  });
});
