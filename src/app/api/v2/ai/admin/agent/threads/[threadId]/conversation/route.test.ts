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

const mockGetUser = jest.fn();
const mockGetRequestUserIdentity = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
  // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
  requireRequestUserIdentity: (...args: unknown[]) => {
    const id = mockGetRequestUserIdentity(...args);
    if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return id;
  },
}));

jest.mock('server/services/agent/AdminService', () => ({
  __esModule: true,
  default: {
    getThreadConversation: jest.fn(),
  },
}));

import { GET } from './route';
import AgentAdminService from 'server/services/agent/AdminService';

const mockGetThreadConversation = AgentAdminService.getThreadConversation as jest.Mock;

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/admin/agent/threads/thread-1/conversation'),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/admin/agent/threads/[threadId]/conversation', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({
      sub: 'sample-admin',
      realm_access: {
        roles: ['admin'],
      },
    });
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-admin',
      githubUsername: 'sample-admin',
    });
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('returns 401 when the requester is not authenticated', async () => {
    mockGetUser.mockReturnValue(null);
    mockGetRequestUserIdentity.mockReturnValue(null);

    const response = await GET(makeRequest(), { params: Promise.resolve({ threadId: 'thread-1' }) });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Unauthorized' },
    });
    expect(mockGetThreadConversation).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin users before loading the conversation', async () => {
    mockGetUser.mockReturnValue({
      sub: 'sample-user',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await GET(makeRequest(), { params: Promise.resolve({ threadId: 'thread-1' }) });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockGetThreadConversation).not.toHaveBeenCalled();
  });

  it('returns the canonical admin replay payload from the service', async () => {
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

    const response = await GET(makeRequest(), { params: Promise.resolve({ threadId: 'thread-1' }) });
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
    mockGetThreadConversation.mockRejectedValue(new Error(message));

    const response = await GET(makeRequest(), { params: Promise.resolve({ threadId: 'missing-thread' }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { message },
    });
  });
});
