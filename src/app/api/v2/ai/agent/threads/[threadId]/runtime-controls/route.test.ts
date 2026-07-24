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
const mockGetState = jest.fn();
const mockPatchChoices = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
  // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
  requireRequestUserIdentity: (...args: unknown[]) => {
    const id = mockGetRequestUserIdentity(...args);
    if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return id;
  },
}));

jest.mock('server/services/agent/ThreadRuntimeControlsService', () => {
  const HTTP_STATUS: Record<string, number> = {
    invalid_input: 400,
    unknown_choice: 400,
    policy_denied: 403,
    not_found: 404,
    active_run: 409,
  };
  class AgentThreadRuntimeControlsError extends Error {
    readonly httpStatus: number;
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = 'AgentThreadRuntimeControlsError';
      this.httpStatus = HTTP_STATUS[code] ?? 400;
    }
  }

  return {
    __esModule: true,
    default: {
      getState: (...args: unknown[]) => mockGetState(...args),
      patchChoices: (...args: unknown[]) => mockPatchChoices(...args),
    },
    AgentThreadRuntimeControlsError,
  };
});

import { GET, PATCH } from './route';
import { AgentThreadRuntimeControlsError } from 'server/services/agent/ThreadRuntimeControlsService';

const runtimeControlsState = {
  tools: {
    required: [
      {
        id: 'rtc_required',
        label: 'Read/context',
        description: 'Read safe context.',
        required: true,
        selected: true,
        available: true,
      },
    ],
    optional: [
      {
        id: 'rtc_optional',
        label: 'Workspace files',
        description: 'Work with files.',
        required: false,
        selected: true,
        available: true,
      },
    ],
    selectedChoiceIds: ['rtc_required', 'rtc_optional'],
  },
  mcp: {
    connections: [
      {
        id: 'rtc_mcp',
        label: 'Sample MCP',
        description: 'Provides sample context.',
        required: false,
        selected: true,
        available: true,
      },
    ],
    selectedChoiceIds: ['rtc_mcp'],
  },
  canEdit: true,
  disabledReason: null,
};

function makeRequest(body?: Record<string, unknown>): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body || {}),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/threads/thread-1/runtime-controls'),
  } as unknown as NextRequest;
}

function makeInvalidJsonRequest(): NextRequest {
  return {
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/threads/thread-1/runtime-controls'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/threads/[threadId]/runtime-controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      roles: ['user'],
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetState.mockResolvedValue(runtimeControlsState);
    mockPatchChoices.mockResolvedValue(runtimeControlsState);
  });

  it('GET returns sanitized runtime-control state', async () => {
    const response = await GET(makeRequest(), { params: Promise.resolve({ threadId: 'thread-1' }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetState).toHaveBeenCalledWith({
      threadId: 'thread-1',
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user', roles: ['user'] },
    });
    expect(body.data).toEqual(runtimeControlsState);
    expect(JSON.stringify(body.data)).not.toContain('workspace_files');
    expect(JSON.stringify(body.data)).not.toContain('sample-mcp');
  });

  it('PATCH accepts choice arrays and returns updated state', async () => {
    const response = await PATCH(
      makeRequest({
        toolChoiceIds: ['rtc_optional'],
        mcpChoiceIds: ['rtc_mcp'],
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );

    expect(response.status).toBe(200);
    expect(mockPatchChoices).toHaveBeenCalledWith({
      threadId: 'thread-1',
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user', roles: ['user'] },
      toolChoiceIds: ['rtc_optional'],
      mcpChoiceIds: ['rtc_mcp'],
    });
  });

  it('returns 400 for malformed bodies and unknown choices', async () => {
    const malformed = await PATCH(makeRequest({ toolChoiceIds: 'workspace_files' }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    expect(malformed.status).toBe(400);

    const invalidJson = await PATCH(makeInvalidJsonRequest(), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    expect(invalidJson.status).toBe(400);

    mockPatchChoices.mockRejectedValueOnce(
      new AgentThreadRuntimeControlsError('unknown_choice', 'Unknown runtime control choice.')
    );
    const unknown = await PATCH(makeRequest({ toolChoiceIds: ['workspace_files'], mcpChoiceIds: [] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    expect(unknown.status).toBe(400);
  });

  it('maps policy, ownership, and active-run service errors', async () => {
    mockPatchChoices.mockRejectedValueOnce(
      new AgentThreadRuntimeControlsError('policy_denied', 'Runtime control choice is unavailable.')
    );
    const denied = await PATCH(makeRequest({ toolChoiceIds: ['rtc_optional'], mcpChoiceIds: [] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    expect(denied.status).toBe(403);

    mockGetState.mockRejectedValueOnce(new AgentThreadRuntimeControlsError('not_found', 'Agent thread not found'));
    const missing = await GET(makeRequest(), { params: Promise.resolve({ threadId: 'thread-1' }) });
    expect(missing.status).toBe(404);

    mockPatchChoices.mockRejectedValueOnce(
      new AgentThreadRuntimeControlsError('active_run', 'Change after this response finishes.')
    );
    const active = await PATCH(makeRequest({ toolChoiceIds: [], mcpChoiceIds: [] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    expect(active.status).toBe(409);
  });

  it('returns 401 without identity', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await GET(makeRequest(), { params: Promise.resolve({ threadId: 'thread-1' }) });

    expect(response.status).toBe(401);
  });
});
