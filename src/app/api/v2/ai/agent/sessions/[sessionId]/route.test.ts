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
const mockGetOwnedSessionRecord = jest.fn();
const mockGetSession = jest.fn();
const mockArchiveSession = jest.fn();

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

jest.mock('server/services/agent/SessionReadService', () => ({
  __esModule: true,
  default: {
    getOwnedSessionRecord: (...args: unknown[]) => mockGetOwnedSessionRecord(...args),
  },
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    getSession: (...args: unknown[]) => mockGetSession(...args),
    archiveSession: (...args: unknown[]) => mockArchiveSession(...args),
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

import { DELETE } from './route';
import { WorkspaceActionBlockedError } from 'server/services/agent/WorkspaceRuntimeStateService';

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions/sample-session'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/sessions/[sessionId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetSession.mockResolvedValue({
      uuid: 'sample-session',
      userId: 'sample-user',
      status: 'active',
    });
    mockArchiveSession.mockResolvedValue(undefined);
  });

  it('archives the session and reports the archived state', async () => {
    const response = await DELETE(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ archived: true });
    expect(mockArchiveSession).toHaveBeenCalledWith('sample-session');
  });

  it('returns archived without re-archiving when the session is already archived', async () => {
    mockGetSession.mockResolvedValueOnce({
      uuid: 'sample-session',
      userId: 'sample-user',
      status: 'archived',
    });

    const response = await DELETE(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ archived: true });
    expect(mockArchiveSession).not.toHaveBeenCalled();
  });

  it('maps canonical workspace action blockers during archive to 409', async () => {
    mockArchiveSession.mockRejectedValueOnce(
      new WorkspaceActionBlockedError(
        'active_run',
        'Wait for the current agent run to finish before changing the workspace.'
      )
    );

    const response = await DELETE(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Wait for the current agent run to finish before changing the workspace.');
    expect(mockGetSession).toHaveBeenCalledWith('sample-session');
    expect(mockArchiveSession).toHaveBeenCalledWith('sample-session');
  });

  it('rejects unauthenticated delete requests', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await DELETE(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe('Authentication is required.');
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockArchiveSession).not.toHaveBeenCalled();
  });

  it('returns 404 when deleting a missing session', async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await DELETE(makeRequest(), {
      params: Promise.resolve({ sessionId: 'missing-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Session not found');
    expect(mockArchiveSession).not.toHaveBeenCalled();
  });

  it('maps delete ownership failures to 404', async () => {
    mockGetSession.mockResolvedValueOnce({
      uuid: 'sample-session',
      userId: 'sample-other-user',
    });

    const response = await DELETE(makeRequest(), {
      params: Promise.resolve({ sessionId: 'sample-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Session not found');
    expect(mockArchiveSession).not.toHaveBeenCalled();
  });
});
