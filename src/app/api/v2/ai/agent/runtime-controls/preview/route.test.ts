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

function makeRequest(body: unknown = {}, jsonError?: unknown): NextRequest {
  return {
    json: jsonError === undefined ? jest.fn().mockResolvedValue(body) : jest.fn().mockRejectedValue(jsonError),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/runtime-controls/preview'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/runtime-controls/preview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      roles: ['user'],
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
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user', roles: ['user'] },
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

  it.each([
    { label: 'null', body: null },
    { label: 'a primitive', body: 'choices' },
    { label: 'an array', body: [] },
  ])('rejects a request body that is $label', async ({ body }) => {
    const response = await POST(makeRequest(body));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe('Request body must be an object.');
    expect(mockGetEntryPreview).not.toHaveBeenCalled();
  });

  it('treats malformed JSON as an empty preview request', async () => {
    const response = await POST(makeRequest(undefined, new SyntaxError('invalid JSON')));

    expect(response.status).toBe(200);
    expect(mockGetEntryPreview).toHaveBeenCalledWith({
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user', roles: ['user'] },
      agentId: undefined,
      source: undefined,
      defaults: undefined,
      runtimeControlChoices: undefined,
    });
  });

  it('rejects unknown top-level preview fields', async () => {
    const response = await POST(makeRequest({ threadId: 'thread-1', extra: true }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe('Unsupported runtime-control preview fields: threadId, extra.');
    expect(mockGetEntryPreview).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a number', agentId: 7 },
    { label: 'a blank string', agentId: '   ' },
  ])('rejects top-level agentId as $label', async ({ agentId }) => {
    const response = await POST(makeRequest({ agentId }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe('agentId must be a non-empty string.');
    expect(mockGetEntryPreview).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a null source', field: 'source', value: null },
    { label: 'a primitive source', field: 'source', value: 'repository' },
    { label: 'an array source', field: 'source', value: [] },
    { label: 'null defaults', field: 'defaults', value: null },
    { label: 'primitive defaults', field: 'defaults', value: 'openai' },
    { label: 'array defaults', field: 'defaults', value: [] },
  ])('rejects $label', async ({ field, value }) => {
    const response = await POST(makeRequest({ [field]: value }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe(`${field} must be an object.`);
    expect(mockGetEntryPreview).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'null', value: null },
    { label: 'a primitive', value: 'rtc_optional' },
    { label: 'an array', value: [] },
  ])('rejects runtimeControlChoices as $label', async ({ value }) => {
    const response = await POST(makeRequest({ runtimeControlChoices: value }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe('runtimeControlChoices must be an object.');
    expect(mockGetEntryPreview).not.toHaveBeenCalled();
  });

  it('rejects unknown fields inside runtimeControlChoices', async () => {
    const response = await POST(makeRequest({ runtimeControlChoices: { harness: 'sdk', extra: true } }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe('Unsupported runtime-control fields: harness, extra.');
    expect(mockGetEntryPreview).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a number', agentId: 7 },
    { label: 'a blank string', agentId: '  ' },
  ])('rejects runtimeControlChoices.agentId as $label', async ({ agentId }) => {
    const response = await POST(makeRequest({ runtimeControlChoices: { agentId } }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe('runtimeControlChoices.agentId must be a non-empty string.');
    expect(mockGetEntryPreview).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'tool choices as a primitive', field: 'toolChoiceIds', value: 'rtc_optional', kind: 'array' },
    { label: 'tool choices with a number', field: 'toolChoiceIds', value: [7], kind: 'items' },
    { label: 'tool choices with a blank id', field: 'toolChoiceIds', value: ['  '], kind: 'items' },
    { label: 'MCP choices as a primitive', field: 'mcpChoiceIds', value: 'mcp.sample', kind: 'array' },
    { label: 'MCP choices with a number', field: 'mcpChoiceIds', value: [7], kind: 'items' },
    { label: 'MCP choices with a blank id', field: 'mcpChoiceIds', value: ['  '], kind: 'items' },
  ])('rejects $label', async ({ field, value, kind }) => {
    const response = await POST(makeRequest({ runtimeControlChoices: { [field]: value } }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe(
      kind === 'array'
        ? `runtimeControlChoices.${field} must be an array of choice ids.`
        : `runtimeControlChoices.${field} must contain only choice ids.`
    );
    expect(mockGetEntryPreview).not.toHaveBeenCalled();
  });

  it('trims agent and choice ids while preserving explicit null agent selections as unset', async () => {
    const response = await POST(
      makeRequest({
        agentId: ' custom.sample-agent ',
        source: {},
        defaults: {},
        runtimeControlChoices: {
          agentId: null,
          toolChoiceIds: [' rtc_optional '],
          mcpChoiceIds: [' mcp.sample '],
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockGetEntryPreview).toHaveBeenCalledWith({
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user', roles: ['user'] },
      agentId: 'custom.sample-agent',
      source: {},
      defaults: {},
      runtimeControlChoices: {
        agentId: undefined,
        toolChoiceIds: ['rtc_optional'],
        mcpChoiceIds: ['mcp.sample'],
      },
    });
  });

  it('trims an explicit runtime-control agent selection when choice arrays are omitted', async () => {
    const response = await POST(makeRequest({ runtimeControlChoices: { agentId: ' custom.override-agent ' } }));

    expect(response.status).toBe(200);
    expect(mockGetEntryPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeControlChoices: {
          agentId: 'custom.override-agent',
          toolChoiceIds: undefined,
          mcpChoiceIds: undefined,
        },
      })
    );
  });

  it('does not read JSON or call the preview service when unauthenticated', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);
    const request = makeRequest({ agentId: 'custom.sample-agent' });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(request.json).not.toHaveBeenCalled();
    expect(mockGetEntryPreview).not.toHaveBeenCalled();
  });

  it('returns 500 when preview generation fails unexpectedly', async () => {
    mockGetEntryPreview.mockRejectedValueOnce(new Error('preview service unavailable'));

    const response = await POST(makeRequest({}));

    expect(response.status).toBe(500);
  });
});
