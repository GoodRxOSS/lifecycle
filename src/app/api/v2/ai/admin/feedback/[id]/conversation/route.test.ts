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

jest.mock('server/models/MessageFeedback', () => {
  const model: { query: jest.Mock } = { query: jest.fn() };
  return { __esModule: true, default: model };
});

jest.mock('server/models/ConversationFeedback', () => {
  const model: { query: jest.Mock } = { query: jest.fn() };
  return { __esModule: true, default: model };
});

jest.mock('server/models/Conversation', () => {
  const model: { query: jest.Mock } = { query: jest.fn() };
  return { __esModule: true, default: model };
});

import { GET } from './route';
import MessageFeedback from 'server/models/MessageFeedback';
import ConversationFeedback from 'server/models/ConversationFeedback';
import Conversation from 'server/models/Conversation';

const MockMessageFeedback = MessageFeedback as unknown as { query: jest.Mock };
const MockConversationFeedback = ConversationFeedback as unknown as { query: jest.Mock };
const MockConversation = Conversation as unknown as { query: jest.Mock };

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/admin/feedback/[id]/conversation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 for invalid feedback id format', async () => {
    const response = await GET(makeRequest(), { params: { id: 'invalid' } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Invalid feedback id format' },
    });
  });

  it('returns message conversation replay with feedback comment', async () => {
    const findByIdMessageFeedback = jest.fn().mockResolvedValue({
      id: 9,
      buildUuid: 'uuid-1',
      messageId: 42,
      repo: 'org/repo',
      rating: 'up',
      text: 'Very helpful',
      userIdentifier: 'vmelikyan',
      createdAt: '2026-02-27T10:00:00.000Z',
    });
    MockMessageFeedback.query.mockReturnValue({ findById: findByIdMessageFeedback });

    const findByIdConversation = jest.fn().mockReturnThis();
    const withGraphFetched = jest.fn().mockReturnThis();
    const modifiers = jest.fn().mockResolvedValue({
      messageCount: 2,
      model: 'claude-sonnet',
      messages: [
        {
          id: 1,
          role: 'user',
          content: 'Why is my build failing?',
          timestamp: '1700000000000',
          metadata: {},
        },
        {
          id: 2,
          role: 'assistant',
          content: 'The dockerfilePath is wrong.',
          timestamp: 1700000001000,
          metadata: { toolCalls: [] },
        },
      ],
    });
    MockConversation.query.mockReturnValue({
      findById: findByIdConversation,
      withGraphFetched,
      modifiers,
    });

    const response = await GET(makeRequest(), { params: { id: 'message-9' } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.feedbackText).toBe('Very helpful');
    expect(body.data.feedbackUserIdentifier).toBe('vmelikyan');
    expect(body.data.feedbackType).toBe('message');
    expect(body.data.ratedMessageId).toBe(42);
    expect(body.data.conversation.messages).toHaveLength(2);
    expect(body.data.conversation.messages[0].timestamp).toBe(1700000000000);
    expect(MockConversationFeedback.query).not.toHaveBeenCalled();
  });

  it('returns conversation feedback replay payload', async () => {
    const findByIdConversationFeedback = jest.fn().mockResolvedValue({
      id: 5,
      buildUuid: 'uuid-2',
      repo: 'org/repo',
      rating: 'down',
      text: 'Session feedback comment',
      userIdentifier: 'vmelikyan',
      createdAt: '2026-02-27T10:05:00.000Z',
    });
    MockConversationFeedback.query.mockReturnValue({ findById: findByIdConversationFeedback });

    const findByIdConversation = jest.fn().mockReturnThis();
    const withGraphFetched = jest.fn().mockReturnThis();
    const modifiers = jest.fn().mockResolvedValue({
      messageCount: 1,
      model: null,
      messages: [
        {
          id: 10,
          role: 'assistant',
          content: 'Sample response',
          timestamp: 1700000002000,
          metadata: {},
        },
      ],
    });
    MockConversation.query.mockReturnValue({
      findById: findByIdConversation,
      withGraphFetched,
      modifiers,
    });

    const response = await GET(makeRequest(), { params: { id: 'conversation-5' } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.feedbackType).toBe('conversation');
    expect(body.data.feedbackText).toBe('Session feedback comment');
    expect(body.data.feedbackUserIdentifier).toBe('vmelikyan');
    expect(body.data.ratedMessageId).toBeNull();
  });
});
