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
const mockSuspendChatRuntime = jest.fn();
const mockSerializeSessionRecord = jest.fn();

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

jest.mock('server/services/agentSession', () => {
  return {
    __esModule: true,
    default: {
      suspendChatRuntime: (...args: unknown[]) => mockSuspendChatRuntime(...args),
    },
  };
});

jest.mock('server/services/agent/SessionReadService', () => ({
  __esModule: true,
  default: {
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

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions/sample-session/sandbox/suspend'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/sessions/[sessionId]/sandbox/suspend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockSuspendChatRuntime.mockResolvedValue({ uuid: 'sample-session' });
    mockSerializeSessionRecord.mockResolvedValue({
      session: { id: 'sample-session', userId: 'sample-user' },
      sandbox: { status: 'hibernated' },
    });
  });

  it('maps canonical workspace action blockers to 409', async () => {
    mockSuspendChatRuntime.mockRejectedValueOnce(
      new WorkspaceActionBlockedError(
        'active_run',
        'Wait for the current agent run to finish before changing the workspace.'
      )
    );

    const response = await POST(makeRequest(), {
      params: { sessionId: 'sample-session' },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Wait for the current agent run to finish before changing the workspace.');
    expect(mockSuspendChatRuntime).toHaveBeenCalledWith({
      sessionId: 'sample-session',
      userId: 'sample-user',
    });
    expect(mockSerializeSessionRecord).not.toHaveBeenCalled();
  });

  it('keeps generic suspend failures mapped to 400', async () => {
    mockSuspendChatRuntime.mockRejectedValueOnce(new Error('Workspace runtime is not ready'));

    const response = await POST(makeRequest(), {
      params: { sessionId: 'sample-session' },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Workspace runtime is not ready');
  });

  it('maps missing or non-owned sessions to 404', async () => {
    mockSuspendChatRuntime.mockRejectedValueOnce(new Error('Session not found'));

    const response = await POST(makeRequest(), {
      params: { sessionId: 'sample-session' },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Session not found');
    expect(mockSerializeSessionRecord).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await POST(makeRequest(), {
      params: { sessionId: 'sample-session' },
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe('Authentication is required.');
    expect(mockSuspendChatRuntime).not.toHaveBeenCalled();
    expect(mockSerializeSessionRecord).not.toHaveBeenCalled();
  });
});
