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

jest.mock('server/services/agent/ThreadService', () => ({
  __esModule: true,
  getToolApprovalAllowlist: jest.fn((thread) => thread?.metadata?.toolApprovalAllowlist ?? []),
  default: {
    getOwnedThreadWithSession: jest.fn(),
    setToolApprovalAllowlist: jest.fn(),
  },
}));

import { GET, PUT } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentThreadService from 'server/services/agent/ThreadService';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockGetOwnedThreadWithSession = AgentThreadService.getOwnedThreadWithSession as jest.Mock;
const mockSetToolApprovalAllowlist = AgentThreadService.setToolApprovalAllowlist as jest.Mock;

function makeRequest(body: unknown = {}, jsonError?: unknown): NextRequest {
  return {
    json: jsonError === undefined ? jest.fn().mockResolvedValue(body) : jest.fn().mockRejectedValue(jsonError),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/threads/thread-1/tool-approval-allowlist'),
  } as unknown as NextRequest;
}

describe('PUT /api/v2/ai/agent/threads/[threadId]/tool-approval-allowlist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({ roles: ['user'], userId: 'sample-user' });
    mockGetOwnedThreadWithSession.mockResolvedValue({
      thread: { id: 7, metadata: { toolApprovalAllowlist: [] } },
      session: { id: 17 },
    });
    mockSetToolApprovalAllowlist.mockResolvedValue({ metadata: { toolApprovalAllowlist: ['read_tool'] } });
  });

  it('rejects git_write tool keys instead of storing a silently inert allowlist entry', async () => {
    const response = await PUT(makeRequest({ toolKeys: ['mcp__lifecycle__update_file'] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('mcp__lifecycle__update_file');
    expect(mockSetToolApprovalAllowlist).not.toHaveBeenCalled();
  });

  it('accepts always-allow-eligible tool keys', async () => {
    const response = await PUT(makeRequest({ toolKeys: ['read_tool'] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockSetToolApprovalAllowlist).toHaveBeenCalledWith(7, ['read_tool']);
  });

  it('lists the current thread allowlist for its owner', async () => {
    mockGetOwnedThreadWithSession.mockResolvedValueOnce({
      thread: { id: 7, metadata: { toolApprovalAllowlist: ['read_tool', 'search_tool'] } },
      session: { id: 17 },
    });

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetOwnedThreadWithSession).toHaveBeenCalledWith('thread-1', 'sample-user');
    expect(body.data).toEqual({ toolKeys: ['read_tool', 'search_tool'] });
  });

  it.each([
    { label: 'GET thread', method: GET, error: new Error('Agent thread not found') },
    { label: 'GET session', method: GET, error: new Error('Agent session not found') },
    { label: 'PUT thread', method: PUT, error: new Error('Agent thread not found') },
    { label: 'PUT session', method: PUT, error: new Error('Agent session not found') },
  ])('maps a missing $label to 404', async ({ method, error }) => {
    mockGetOwnedThreadWithSession.mockRejectedValueOnce(error);

    const response = await method(makeRequest({ toolKeys: ['read_tool'] }), {
      params: Promise.resolve({ threadId: 'missing-thread' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe(error.message);
    expect(mockSetToolApprovalAllowlist).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'GET Error', method: GET, error: new Error('database unavailable') },
    { label: 'GET non-Error', method: GET, error: 'database unavailable' },
    { label: 'PUT Error', method: PUT, error: new Error('database unavailable') },
    { label: 'PUT non-Error', method: PUT, error: 'database unavailable' },
  ])('returns 500 when $label lookup fails unexpectedly', async ({ method, error }) => {
    mockGetOwnedThreadWithSession.mockRejectedValueOnce(error);

    const response = await method(makeRequest({ toolKeys: ['read_tool'] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockSetToolApprovalAllowlist).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'null', body: null },
    { label: 'a primitive', body: 'read_tool' },
    { label: 'an array', body: [] },
  ])('rejects a PUT body that is $label', async ({ body }) => {
    const response = await PUT(makeRequest(body), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe('Request body must be an object.');
    expect(mockGetOwnedThreadWithSession).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON as an invalid body', async () => {
    const response = await PUT(makeRequest(undefined, new SyntaxError('invalid JSON')), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Request body must be an object.');
    expect(mockGetOwnedThreadWithSession).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'an omitted list', body: {} },
    { label: 'a primitive list', body: { toolKeys: 'read_tool' } },
    { label: 'a non-string key', body: { toolKeys: [7] } },
    { label: 'a blank key', body: { toolKeys: ['  '] } },
  ])('rejects toolKeys with $label', async ({ body }) => {
    const response = await PUT(makeRequest(body), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe('toolKeys must be an array of tool keys.');
    expect(mockGetOwnedThreadWithSession).not.toHaveBeenCalled();
  });

  it('trims eligible keys, preserves duplicates, and permits clearing the allowlist', async () => {
    mockSetToolApprovalAllowlist
      .mockResolvedValueOnce({ metadata: { toolApprovalAllowlist: ['read_tool', 'read_tool'] } })
      .mockResolvedValueOnce({ metadata: { toolApprovalAllowlist: [] } });

    const trimmed = await PUT(makeRequest({ toolKeys: [' read_tool ', 'read_tool'] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    const cleared = await PUT(makeRequest({ toolKeys: [] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });
    const trimmedBody = await trimmed.json();
    const clearedBody = await cleared.json();

    expect(trimmed.status).toBe(200);
    expect(cleared.status).toBe(200);
    expect(mockSetToolApprovalAllowlist).toHaveBeenNthCalledWith(1, 7, ['read_tool', 'read_tool']);
    expect(mockSetToolApprovalAllowlist).toHaveBeenNthCalledWith(2, 7, []);
    expect(trimmedBody.data.toolKeys).toEqual(['read_tool', 'read_tool']);
    expect(clearedBody.data.toolKeys).toEqual([]);
  });

  it('reports every ineligible key and does not load or mutate the thread', async () => {
    const response = await PUT(
      makeRequest({
        toolKeys: ['read_tool', 'mcp__lifecycle__update_file', 'mcp__lifecycle__update_pr_labels'],
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('mcp__lifecycle__update_file');
    expect(body.error.message).toContain('mcp__lifecycle__update_pr_labels');
    expect(mockGetOwnedThreadWithSession).not.toHaveBeenCalled();
    expect(mockSetToolApprovalAllowlist).not.toHaveBeenCalled();
  });

  it('maps a session disappearance during mutation to 404', async () => {
    mockSetToolApprovalAllowlist.mockRejectedValueOnce(new Error('Agent session not found'));

    const response = await PUT(makeRequest({ toolKeys: ['read_tool'] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });

    expect(response.status).toBe(404);
  });

  it('returns 500 when allowlist persistence fails unexpectedly', async () => {
    mockSetToolApprovalAllowlist.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await PUT(makeRequest({ toolKeys: ['read_tool'] }), {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });

    expect(response.status).toBe(500);
  });

  it.each([
    { label: 'GET', method: GET },
    { label: 'PUT', method: PUT },
  ])('requires authentication for $label before accessing thread state', async ({ method }) => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);
    const request = makeRequest({ toolKeys: ['read_tool'] });

    const response = await method(request, {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });

    expect(response.status).toBe(401);
    expect(mockGetOwnedThreadWithSession).not.toHaveBeenCalled();
    expect(mockSetToolApprovalAllowlist).not.toHaveBeenCalled();
    if (method === PUT) {
      expect(request.json).not.toHaveBeenCalled();
    }
  });
});
