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

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
}));

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: jest.fn(),
}));

jest.mock('server/services/agent/ThreadService', () => ({
  __esModule: true,
  default: {
    createThread: jest.fn(),
    listThreadsForSession: jest.fn(),
    serializeThread: jest.fn((thread, sessionId) => ({
      id: thread.uuid,
      sessionId,
      title: thread.title,
      isDefault: thread.isDefault,
      metadata: thread.metadata ?? {},
    })),
  },
}));

import { GET, POST } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentThreadService from 'server/services/agent/ThreadService';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockCreateThread = AgentThreadService.createThread as jest.Mock;
const mockListThreadsForSession = AgentThreadService.listThreadsForSession as jest.Mock;
const mockSerializeThread = AgentThreadService.serializeThread as jest.Mock;

function makeRequest(body?: Record<string, unknown>): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body ?? {}),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions/session-1/threads'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/sessions/[sessionId]/threads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
  });

  it('lists owned session threads', async () => {
    mockListThreadsForSession.mockResolvedValue([
      {
        uuid: 'thread-1',
        title: 'Default thread',
        isDefault: true,
        metadata: {},
      },
    ]);

    const response = await GET(makeRequest(), {
      params: { sessionId: 'session-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListThreadsForSession).toHaveBeenCalledWith('session-1', 'sample-user');
    expect(body.data.threads).toEqual([
      {
        id: 'thread-1',
        sessionId: 'session-1',
        title: 'Default thread',
        isDefault: true,
        metadata: {},
      },
    ]);
  });

  it('maps missing sessions during list to 404', async () => {
    mockListThreadsForSession.mockRejectedValueOnce(new Error('Agent session not found'));

    const response = await GET(makeRequest(), {
      params: { sessionId: 'missing-session' },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent session not found');
  });

  it('creates a thread in an active owned session', async () => {
    mockCreateThread.mockResolvedValue({
      uuid: 'thread-2',
      title: 'New chat',
      isDefault: false,
      metadata: {},
    });

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: { sessionId: 'session-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockCreateThread).toHaveBeenCalledWith('session-1', 'sample-user', 'New chat');
    expect(body.data).toEqual({
      id: 'thread-2',
      sessionId: 'session-1',
      title: 'New chat',
      isDefault: false,
      metadata: {},
    });
  });

  it('rejects new threads for inactive sessions', async () => {
    mockCreateThread.mockRejectedValueOnce(new Error('Cannot create a thread for an inactive session'));

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: { sessionId: 'session-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Cannot create a thread for an inactive session');
  });

  it('maps runtime-unavailable sessions during create to 409', async () => {
    mockCreateThread.mockRejectedValueOnce(new Error('This session is no longer available for new messages.'));

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: { sessionId: 'session-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('This session is no longer available for new messages.');
  });

  it('maps missing sessions during create to 404', async () => {
    mockCreateThread.mockRejectedValueOnce(new Error('Agent session not found'));

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: { sessionId: 'missing-session' },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent session not found');
  });

  it('rejects unauthenticated requests', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: { sessionId: 'session-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe('Unauthorized');
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockSerializeThread).not.toHaveBeenCalled();
  });
});
