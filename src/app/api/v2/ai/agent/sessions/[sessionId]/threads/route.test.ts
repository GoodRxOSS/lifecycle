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

jest.mock('server/lib/get-user', () => {
  const getRequestUserIdentity = jest.fn();
  return {
    getRequestUserIdentity,
    // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
    requireRequestUserIdentity: (...args: unknown[]) => {
      const id = getRequestUserIdentity(...args);
      if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
      return id;
    },
  };
});

jest.mock('server/services/agent/ThreadService', () => {
  class AgentThreadCreateNotFoundError extends Error {
    readonly httpStatus = 404;
    readonly code = 'thread_target_not_found';
    constructor(public readonly reason: 'session_not_found' | 'source_thread_not_found', message: string) {
      super(message);
      this.name = 'AgentThreadCreateNotFoundError';
    }
  }

  class AgentThreadCreateConflictError extends Error {
    readonly httpStatus = 409;
    constructor(
      public readonly code:
        | 'inactive_session'
        | 'session_starting'
        | 'session_unavailable'
        | 'active_run'
        | 'pending_approval',
      message: string
    ) {
      super(message);
      this.name = 'AgentThreadCreateConflictError';
    }
  }

  return {
    __esModule: true,
    AgentThreadCreateConflictError,
    AgentThreadCreateNotFoundError,
    default: {
      createThread: jest.fn(),
      listThreadHistoryForSession: jest.fn(),
      listThreadsForSession: jest.fn(),
      serializeThread: jest.fn((thread, sessionId) => ({
        id: thread.uuid,
        sessionId,
        title: thread.title,
        isDefault: thread.isDefault,
        metadata: thread.metadata ?? {},
      })),
    },
  };
});

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    getSession: jest.fn(),
    ensureSessionActive: jest.fn(),
  },
}));

jest.mock('server/services/agent/WorkspaceRuntimeStateService', () => {
  class WorkspaceActionBlockedError extends Error {
    readonly httpStatus = 409;
    readonly code = 'workspace_action_blocked';
    constructor(
      public readonly reason: 'active_run' | 'action_in_progress',
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

import { GET, POST } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentThreadService, {
  AgentThreadCreateConflictError,
  AgentThreadCreateNotFoundError,
} from 'server/services/agent/ThreadService';
import { WorkspaceActionBlockedError } from 'server/services/agent/WorkspaceRuntimeStateService';
import AgentSessionService from 'server/services/agentSession';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockCreateThread = AgentThreadService.createThread as jest.Mock;
const mockListThreadHistoryForSession = AgentThreadService.listThreadHistoryForSession as jest.Mock;
const mockSerializeThread = AgentThreadService.serializeThread as jest.Mock;
const mockGetSession = AgentSessionService.getSession as jest.Mock;
const mockEnsureSessionActive = AgentSessionService.ensureSessionActive as jest.Mock;

function makeRequest(body?: unknown, options: { jsonError?: Error; hasBody?: boolean } = {}): NextRequest {
  const hasBody = options.hasBody ?? (body !== undefined || options.jsonError !== undefined);

  return {
    body: hasBody ? ({} as ReadableStream<Uint8Array>) : null,
    json: jest.fn().mockImplementation(() => {
      if (options.jsonError) {
        return Promise.reject(options.jsonError);
      }

      return Promise.resolve(body);
    }),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions/session-1/threads'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/sessions/[sessionId]/threads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      roles: ['user'],
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetSession.mockResolvedValue({
      id: 17,
      uuid: 'session-1',
      userId: 'sample-user',
      status: 'active',
    });
    mockEnsureSessionActive.mockImplementation(async (session) => session);
  });

  it('lists owned session threads', async () => {
    mockListThreadHistoryForSession.mockResolvedValue([
      {
        id: 'thread-1',
        sessionId: 'session-1',
        title: 'Default thread',
        isDefault: true,
        archivedAt: null,
        lastRunAt: null,
        metadata: {},
        createdAt: '2026-05-09T00:00:00.000Z',
        updatedAt: '2026-05-09T00:00:00.000Z',
        summary: {
          messageCount: 2,
          runCount: 1,
          pendingActionsCount: 0,
          latestRun: {
            id: 'run-1',
            status: 'completed',
            requestedProvider: null,
            requestedModel: null,
            resolvedProvider: 'openai',
            resolvedModel: 'gpt-5',
            provider: 'openai',
            model: 'gpt-5',
            queuedAt: '2026-05-09T00:00:01.000Z',
            startedAt: '2026-05-09T00:00:02.000Z',
            completedAt: '2026-05-09T00:00:03.000Z',
            cancelledAt: null,
            usageSummary: { totalTokens: 17 },
            createdAt: '2026-05-09T00:00:01.000Z',
            updatedAt: '2026-05-09T00:00:03.000Z',
          },
          lastActivityAt: '2026-05-09T00:00:03.000Z',
          usage: {
            usageSummary: { totalTokens: 17 },
            usageByModel: [
              {
                provider: 'openai',
                model: 'gpt-5',
                totalTokens: 17,
                runCount: 1,
                reportedRunCount: 1,
                missingUsageRunCount: 0,
              },
            ],
            usageCompleteness: {
              runCount: 1,
              reportedRunCount: 1,
              missingUsageRunCount: 0,
              complete: true,
            },
          },
        },
      },
    ]);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListThreadHistoryForSession).toHaveBeenCalledWith('session-1', 'sample-user');
    expect(body.data.threads).toEqual([
      {
        id: 'thread-1',
        sessionId: 'session-1',
        title: 'Default thread',
        isDefault: true,
        archivedAt: null,
        lastRunAt: null,
        metadata: {},
        createdAt: '2026-05-09T00:00:00.000Z',
        updatedAt: '2026-05-09T00:00:00.000Z',
        summary: {
          messageCount: 2,
          runCount: 1,
          pendingActionsCount: 0,
          latestRun: {
            id: 'run-1',
            status: 'completed',
            requestedProvider: null,
            requestedModel: null,
            resolvedProvider: 'openai',
            resolvedModel: 'gpt-5',
            provider: 'openai',
            model: 'gpt-5',
            queuedAt: '2026-05-09T00:00:01.000Z',
            startedAt: '2026-05-09T00:00:02.000Z',
            completedAt: '2026-05-09T00:00:03.000Z',
            cancelledAt: null,
            usageSummary: { totalTokens: 17 },
            createdAt: '2026-05-09T00:00:01.000Z',
            updatedAt: '2026-05-09T00:00:03.000Z',
          },
          lastActivityAt: '2026-05-09T00:00:03.000Z',
          usage: {
            usageSummary: { totalTokens: 17 },
            usageByModel: [
              {
                provider: 'openai',
                model: 'gpt-5',
                totalTokens: 17,
                runCount: 1,
                reportedRunCount: 1,
                missingUsageRunCount: 0,
              },
            ],
            usageCompleteness: {
              runCount: 1,
              reportedRunCount: 1,
              missingUsageRunCount: 0,
              complete: true,
            },
          },
        },
      },
    ]);
  });

  it('maps missing sessions during list to 404', async () => {
    mockListThreadHistoryForSession.mockRejectedValueOnce(new Error('Agent session not found'));

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ sessionId: 'missing-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent session not found');
  });

  it('creates a thread in an active owned session', async () => {
    mockCreateThread.mockResolvedValue({
      uuid: 'thread-2',
      title: 'New chat',
      isDefault: true,
      metadata: {},
    });

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockCreateThread).toHaveBeenCalledWith('session-1', 'sample-user', {
      title: 'New chat',
      sourceThreadId: undefined,
    });
    expect(body.data).toEqual({
      id: 'thread-2',
      sessionId: 'session-1',
      title: 'New chat',
      isDefault: true,
      metadata: {},
    });
  });

  it('creates a thread with an optional source thread id', async () => {
    mockCreateThread.mockResolvedValue({
      uuid: 'thread-2',
      title: 'New chat',
      isDefault: true,
      metadata: {},
    });

    const response = await POST(makeRequest({ title: 'New chat', sourceThreadId: 'source-thread-1' }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });

    expect(response.status).toBe(201);
    expect(mockCreateThread).toHaveBeenCalledWith('session-1', 'sample-user', {
      title: 'New chat',
      sourceThreadId: 'source-thread-1',
    });
  });

  it('creates a thread when the optional body is absent', async () => {
    mockCreateThread.mockResolvedValue({
      uuid: 'thread-2',
      title: null,
      isDefault: true,
      metadata: {},
    });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });

    expect(response.status).toBe(201);
    expect(mockCreateThread).toHaveBeenCalledWith('session-1', 'sample-user', {});
  });

  it.each([
    [{ title: 42 }, 'title must be a string.'],
    [{ sourceThreadId: 42 }, 'sourceThreadId must be a string.'],
    [null, 'Request body must be an object.'],
    ['New chat', 'Request body must be an object.'],
    [42, 'Request body must be an object.'],
    [[{ title: 'New chat' }], 'Request body must be an object.'],
    [{ title: 'New chat', unexpected: true }, 'Unsupported thread request fields: unexpected.'],
  ])('rejects invalid create-thread bodies %#', async (invalidBody, expectedMessage) => {
    const response = await POST(makeRequest(invalidBody), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      request_id: 'req-test',
      data: null,
      error: {
        message: expectedMessage,
      },
    });
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON bodies', async () => {
    const response = await POST(makeRequest(undefined, { jsonError: new SyntaxError('Unexpected token') }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Request body must be valid JSON.');
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('rejects new threads for inactive sessions', async () => {
    mockCreateThread.mockRejectedValueOnce(
      new AgentThreadCreateConflictError('inactive_session', 'Cannot create a thread for an inactive session')
    );

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Cannot create a thread for an inactive session');
  });

  it('maps runtime-unavailable sessions during create to 409', async () => {
    mockCreateThread.mockRejectedValueOnce(
      new AgentThreadCreateConflictError('session_unavailable', 'This session is no longer available for new messages.')
    );

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('This session is no longer available for new messages.');
  });

  it('maps missing sessions during create to 404', async () => {
    mockCreateThread.mockRejectedValueOnce(
      new AgentThreadCreateNotFoundError('session_not_found', 'Agent session not found')
    );

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: Promise.resolve({ sessionId: 'missing-session' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent session not found');
  });

  it('maps missing source threads during create to 404', async () => {
    mockCreateThread.mockRejectedValueOnce(
      new AgentThreadCreateNotFoundError('source_thread_not_found', 'Source agent thread not found')
    );

    const response = await POST(makeRequest({ title: 'New chat', sourceThreadId: 'missing-thread' }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Source agent thread not found');
  });

  it.each([
    ['active_run', 'Wait for the current agent run to finish before starting a new thread.'],
    ['pending_approval', 'Resolve pending approvals before starting a new thread.'],
  ] as const)('maps unsafe start-fresh conflicts to 409: %s', async (code, message) => {
    mockCreateThread.mockRejectedValueOnce(new AgentThreadCreateConflictError(code, message));

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe(message);
  });

  it('maps active workspace lifecycle actions to 409', async () => {
    mockCreateThread.mockRejectedValueOnce(
      new WorkspaceActionBlockedError(
        'action_in_progress',
        'Wait for the current workspace action to finish before starting another action.'
      )
    );

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Wait for the current workspace action to finish before starting another action.');
  });

  it('rejects unauthenticated requests', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await POST(makeRequest({ title: 'New chat' }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe('Authentication is required.');
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockSerializeThread).not.toHaveBeenCalled();
  });
});
