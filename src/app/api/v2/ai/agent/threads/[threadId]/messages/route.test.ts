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

import { NextRequest } from 'next/server';

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: jest.fn(),
}));

jest.mock('server/services/agent/MessageStore', () => ({
  __esModule: true,
  DEFAULT_AGENT_MESSAGE_PAGE_LIMIT: 50,
  MAX_AGENT_MESSAGE_PAGE_LIMIT: 100,
  default: {
    listCanonicalMessages: jest.fn(),
  },
}));

import { GET } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentMessageStore from 'server/services/agent/MessageStore';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockListCanonicalMessages = AgentMessageStore.listCanonicalMessages as jest.Mock;

function makeRequest(url = 'http://localhost/api/v2/ai/agent/threads/thread-1/messages'): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/agent/threads/[threadId]/messages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockListCanonicalMessages.mockResolvedValue({
      thread: {
        id: 'thread-1',
        sessionId: 'session-1',
        title: null,
        isDefault: true,
        archivedAt: null,
        lastRunAt: null,
        metadata: {},
        createdAt: null,
        updatedAt: null,
      },
      messages: [
        {
          id: 'message-1',
          clientMessageId: 'client-message-1',
          threadId: 'thread-1',
          runId: 'run-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hi' }],
          createdAt: '2026-04-25T00:00:00.000Z',
        },
      ],
      pagination: {
        hasMore: false,
        nextBeforeMessageId: null,
      },
    });
  });

  it('returns canonical messages with cursor options', async () => {
    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/agent/threads/thread-1/messages?limit=25&beforeMessageId=message-2'),
      { params: { threadId: 'thread-1' } }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListCanonicalMessages).toHaveBeenCalledWith('thread-1', 'sample-user', {
      limit: 25,
      beforeMessageId: 'message-2',
    });
    expect(body.data.messages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        clientMessageId: 'client-message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
      }),
    ]);
  });

  it('rejects invalid limits', async () => {
    const response = await GET(makeRequest('http://localhost/api/v2/ai/agent/threads/thread-1/messages?limit=0'), {
      params: { threadId: 'thread-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Expected a positive integer limit.');
    expect(mockListCanonicalMessages).not.toHaveBeenCalled();
  });

  it('maps missing threads to 404', async () => {
    mockListCanonicalMessages.mockRejectedValueOnce(new Error('Agent thread not found'));

    const response = await GET(makeRequest(), { params: { threadId: 'missing-thread' } });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent thread not found');
  });
});
