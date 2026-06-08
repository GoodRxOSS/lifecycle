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
const mockGetSession = jest.fn();
const mockAttachServices = jest.fn();
const mockSerializeAgentSessionSummary = jest.fn();

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

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    getSession: (...args: unknown[]) => mockGetSession(...args),
    attachServices: (...args: unknown[]) => mockAttachServices(...args),
  },
}));

jest.mock('server/services/agent/serializeSessionSummary', () => ({
  serializeAgentSessionSummary: (...args: unknown[]) => mockSerializeAgentSessionSummary(...args),
}));

import { POST } from './route';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions/session-1/services'),
  } as unknown as NextRequest;
}

function makeMalformedJsonRequest(): NextRequest {
  return {
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/sessions/session-1/services'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/sessions/[sessionId]/services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
  });

  it('returns 400 for malformed service objects before session lookup', async () => {
    const response = await POST(makeRequest({ services: [{ repo: 'example-org/example-repo' }] }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('services must be an array of service names or repo-qualified service references');
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockAttachServices).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON before session lookup', async () => {
    const response = await POST(makeMalformedJsonRequest(), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Invalid JSON body');
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockAttachServices).not.toHaveBeenCalled();
  });

  it('maps missing sessions to 404 before service attachment', async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const response = await POST(makeRequest({ services: ['sample-service'] }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Session not found');
    expect(mockAttachServices).not.toHaveBeenCalled();
  });

  it('maps non-owned sessions to 404 before service attachment', async () => {
    mockGetSession.mockResolvedValueOnce({
      uuid: 'session-1',
      userId: 'sample-other-user',
    });

    const response = await POST(makeRequest({ services: ['sample-service'] }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Session not found');
    expect(mockAttachServices).not.toHaveBeenCalled();
  });
});
