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

jest.mock('server/services/agent/AdminService', () => ({
  __esModule: true,
  default: {
    getThreadConversation: jest.fn(),
  },
}));

import { GET } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentAdminService from 'server/services/agent/AdminService';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockGetThreadConversation = AgentAdminService.getThreadConversation as jest.Mock;

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/admin/agent/threads/thread-1/conversation'),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/admin/agent/threads/[threadId]/conversation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when the requester is not authenticated', async () => {
    mockGetRequestUserIdentity.mockReturnValue(null);

    const response = await GET(makeRequest(), { params: { threadId: 'thread-1' } });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Unauthorized' },
    });
    expect(mockGetThreadConversation).not.toHaveBeenCalled();
  });

  it('returns the canonical admin replay payload from the service', async () => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-admin',
      githubUsername: 'sample-admin',
    });
    mockGetThreadConversation.mockResolvedValue({
      session: { id: 'session-1' },
      thread: { id: 'thread-1' },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      ],
      runs: [],
      events: [],
      pendingActions: [],
      toolExecutions: [
        {
          id: 'tool-1',
          toolCallId: 'tool-call-1',
        },
      ],
    });

    const response = await GET(makeRequest(), { params: { threadId: 'thread-1' } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetThreadConversation).toHaveBeenCalledWith('thread-1');
    expect(body.data.messages[0]).toEqual({
      id: 'message-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hi' }],
    });
    expect(body.data.toolExecutions[0]).toEqual({
      id: 'tool-1',
      toolCallId: 'tool-call-1',
    });
  });

  it.each(['Agent thread not found', 'Agent session not found'])('returns 404 for %s', async (message) => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-admin',
      githubUsername: 'sample-admin',
    });
    mockGetThreadConversation.mockRejectedValue(new Error(message));

    const response = await GET(makeRequest(), { params: { threadId: 'missing-thread' } });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { message },
    });
  });
});
