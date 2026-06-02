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
const mockGetEntryPreview = jest.fn();

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
      getEntryPreview: (...args: unknown[]) => mockGetEntryPreview(...args),
    },
    AgentThreadRuntimeControlsError,
  };
});

import { POST } from './route';
import { AgentThreadRuntimeControlsError } from 'server/services/agent/ThreadRuntimeControlsService';

const previewState = {
  tools: {
    required: [],
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
    selectedChoiceIds: ['rtc_optional'],
  },
  mcp: {
    connections: [],
    selectedChoiceIds: [],
  },
  canEdit: true,
  disabledReason: null,
};

function makeRequest(body?: Record<string, unknown>): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body || {}),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/runtime-controls/preview'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/runtime-controls/preview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetEntryPreview.mockResolvedValue(previewState);
  });

  it('returns sanitized /new runtime choices without a thread', async () => {
    const body = {
      agentId: 'custom.sample-agent',
      source: { adapter: 'lifecycle_fork', input: { repo: 'example-org/example-repo' } },
      defaults: { provider: 'openai', model: 'sample-model' },
      runtimeControlChoices: { toolChoiceIds: ['rtc_optional'], mcpChoiceIds: [] },
    };

    const response = await POST(makeRequest(body));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetEntryPreview).toHaveBeenCalledWith({
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' },
      ...body,
    });
    expect(payload.data).toEqual(previewState);
  });

  it('returns 400 for malformed and unknown choices', async () => {
    const malformed = await POST(makeRequest({ runtimeControlChoices: 'workspace_files' }));
    expect(malformed.status).toBe(400);

    mockGetEntryPreview.mockRejectedValueOnce(
      new AgentThreadRuntimeControlsError('unknown_choice', 'Unknown runtime control choice.')
    );
    const unknown = await POST(makeRequest({ runtimeControlChoices: { toolChoiceIds: ['workspace_files'] } }));
    expect(unknown.status).toBe(400);
  });

  it('returns 403 for unavailable choices and 401 without identity', async () => {
    mockGetEntryPreview.mockRejectedValueOnce(
      new AgentThreadRuntimeControlsError('policy_denied', 'Runtime control choice is unavailable.')
    );
    const denied = await POST(makeRequest({ runtimeControlChoices: { toolChoiceIds: ['rtc_optional'] } }));
    expect(denied.status).toBe(403);

    mockGetRequestUserIdentity.mockReturnValueOnce(null);
    const unauthorized = await POST(makeRequest());
    expect(unauthorized.status).toBe(401);
  });
});
