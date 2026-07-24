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

const mockGetRequestUserIdentity = jest.fn();
const mockResolveRequestGitHubToken = jest.fn();
const mockOpenChatRuntime = jest.fn();
const mockSerializeSessionRecord = jest.fn();
const mockGetOwnedSessionRecord = jest.fn();

jest.mock('server/lib/dependencies', () => ({}));

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
  // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
  requireRequestUserIdentity: (...args: unknown[]) => {
    const id = mockGetRequestUserIdentity(...args);
    if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return id;
  },
}));

jest.mock('server/lib/agentSession/githubToken', () => ({
  resolveRequestGitHubToken: (...args: unknown[]) => mockResolveRequestGitHubToken(...args),
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    openChatRuntime: (...args: unknown[]) => mockOpenChatRuntime(...args),
  },
}));

jest.mock('server/services/agent/SessionReadService', () => ({
  __esModule: true,
  default: {
    getOwnedSessionRecord: (...args: unknown[]) => mockGetOwnedSessionRecord(...args),
    serializeSessionRecord: (...args: unknown[]) => mockSerializeSessionRecord(...args),
  },
}));

jest.mock('server/services/agent/WorkspaceRuntimeStateService', () => {
  class WorkspaceActionBlockedError extends Error {
    constructor(
      public readonly reason: string,
      message: string,
      public readonly details: Record<string, unknown> = {}
    ) {
      super(message);
      this.name = 'WorkspaceActionBlockedError';
    }
  }

  return {
    WorkspaceActionBlockedError,
  };
});

import { POST } from './route';
import { WorkspaceActionBlockedError } from 'server/services/agent/WorkspaceRuntimeStateService';

const userIdentity = {
  userId: 'sample-user',
  githubUsername: 'sample-user',
  roles: ['user'],
};

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions/sample-session/workspace/open'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/sessions/[sessionId]/workspace/open', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue(userIdentity);
    mockResolveRequestGitHubToken.mockResolvedValue('sample-token');
    mockOpenChatRuntime.mockResolvedValue({ uuid: 'sample-session' });
    mockSerializeSessionRecord.mockResolvedValue({
      session: { id: 'sample-session', userId: 'sample-user' },
      sandbox: { status: 'ready' },
    });
    mockGetOwnedSessionRecord.mockResolvedValue(null);
  });

  it('opens the chat workspace through the service policy and serializes the session', async () => {
    const response = await POST(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockOpenChatRuntime).toHaveBeenCalledWith({
      sessionId: 'sample-session',
      userId: 'sample-user',
      userIdentity,
      githubToken: 'sample-token',
    });
    expect(mockSerializeSessionRecord).toHaveBeenCalledWith({ uuid: 'sample-session' });
    expect(body.data).toEqual({
      session: { id: 'sample-session', userId: 'sample-user' },
      sandbox: { status: 'ready' },
    });
  });

  it('maps canonical workspace action blockers to 409', async () => {
    mockOpenChatRuntime.mockRejectedValueOnce(
      new WorkspaceActionBlockedError(
        'action_in_progress',
        'Wait for the current workspace action to finish before starting another action.'
      )
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Wait for the current workspace action to finish before starting another action.');
    expect(mockOpenChatRuntime).toHaveBeenCalledWith({
      sessionId: 'sample-session',
      userId: 'sample-user',
      userIdentity,
      githubToken: 'sample-token',
    });
    expect(mockSerializeSessionRecord).not.toHaveBeenCalled();
    expect(mockGetOwnedSessionRecord).not.toHaveBeenCalled();
  });

  it('links workspace open failures to the canonical session failure projection', async () => {
    const workspaceFailure = {
      stage: 'connect_runtime',
      title: 'Workspace did not start',
      message: 'workspace pod failed',
      recordedAt: '2026-05-09T16:00:00.000Z',
      retryable: true,
      origin: 'chat_runtime',
    };
    mockOpenChatRuntime.mockRejectedValueOnce(new Error('workspace pod failed'));
    mockGetOwnedSessionRecord.mockResolvedValueOnce({
      session: { id: 'sample-session' },
      sandbox: {
        status: 'failed',
        error: workspaceFailure,
      },
    });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('workspace pod failed');
    expect(body.data).toEqual({
      sessionId: 'sample-session',
      sessionUrl: '/api/v2/ai/agent/sessions/sample-session',
      workspaceFailure,
    });
    expect(mockGetOwnedSessionRecord).toHaveBeenCalledWith('sample-session', 'sample-user');
  });

  it('keeps generic workspace open failures mapped to 400', async () => {
    mockOpenChatRuntime.mockRejectedValueOnce(new Error('Workspace runtime cannot be opened from the current state'));

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Workspace runtime cannot be opened from the current state');
    expect(body.data).toBeNull();
  });

  it('maps missing or non-owned sessions to 404', async () => {
    mockOpenChatRuntime.mockRejectedValueOnce(new Error('Session not found'));

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Session not found');
    expect(body.data).toBeNull();
    expect(mockGetOwnedSessionRecord).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests before resolving a GitHub token', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe('Authentication is required.');
    expect(mockResolveRequestGitHubToken).not.toHaveBeenCalled();
    expect(mockOpenChatRuntime).not.toHaveBeenCalled();
    expect(mockSerializeSessionRecord).not.toHaveBeenCalled();
  });
});
