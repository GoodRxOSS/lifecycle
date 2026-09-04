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

function makeRequest(body: unknown): NextRequest {
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
      roles: ['user'],
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetSession.mockResolvedValue({
      uuid: 'session-1',
      userId: 'sample-user',
      status: 'active',
    });
    mockAttachServices.mockResolvedValue(undefined);
    mockSerializeAgentSessionSummary.mockReturnValue({ id: 'session-1', status: 'active' });
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

  it.each([
    { label: 'an omitted list', body: {} },
    { label: 'a null list', body: { services: null } },
    { label: 'a primitive list', body: { services: 'sample-service' } },
    { label: 'an empty list', body: { services: [] } },
  ])('rejects services with $label before session lookup', async ({ body }) => {
    const response = await POST(makeRequest(body), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe('services is required');
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockAttachServices).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'null', service: null },
    { label: 'a number', service: 7 },
    { label: 'an array', service: [] },
    { label: 'a non-string name', service: { name: 7 } },
    { label: 'a non-string repository', service: { name: 'web', repo: 7 } },
    { label: 'a non-string branch', service: { name: 'web', branch: 7 } },
  ])('rejects a service reference that is $label', async ({ service }) => {
    const response = await POST(makeRequest({ services: [service] }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('services must be an array of service names or repo-qualified service references');
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockAttachServices).not.toHaveBeenCalled();
  });

  it('attaches string and repo-qualified service references and returns the refreshed session summary', async () => {
    const requestedServices = [
      'api',
      { name: 'web', repo: 'example-org/web', branch: 'preview' },
      { name: '', repo: null, branch: null },
    ];

    const response = await POST(makeRequest({ services: requestedServices }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetSession).toHaveBeenCalledTimes(2);
    expect(mockAttachServices).toHaveBeenCalledWith('session-1', requestedServices);
    expect(mockSerializeAgentSessionSummary).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'session-1', userId: 'sample-user' })
    );
    expect(body.data).toEqual({ id: 'session-1', status: 'active' });
  });

  it('returns 404 when the session disappears after attachment', async () => {
    mockGetSession
      .mockResolvedValueOnce({ uuid: 'session-1', userId: 'sample-user', status: 'active' })
      .mockResolvedValueOnce(null);

    const response = await POST(makeRequest({ services: ['api'] }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });

    expect(response.status).toBe(404);
    expect(mockAttachServices).toHaveBeenCalledWith('session-1', ['api']);
    expect(mockSerializeAgentSessionSummary).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'lowercase session-not-found Error', error: new Error('session not found'), status: 404 },
    { label: 'mixed-case session-not-found Error', error: new Error('Agent Session Not Found'), status: 404 },
    { label: 'other Error', error: new Error('service unavailable'), status: 400 },
    { label: 'non-Error', error: 'service unavailable', status: 400 },
  ])('maps an attachment $label to $status', async ({ error, status }) => {
    mockAttachServices.mockRejectedValueOnce(error);

    const response = await POST(makeRequest({ services: ['api'] }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });

    expect(response.status).toBe(status);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the initial session lookup fails', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await POST(makeRequest({ services: ['api'] }), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockAttachServices).not.toHaveBeenCalled();
  });

  it('requires authentication before reading the request body', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);
    const request = makeRequest({ services: ['api'] });

    const response = await POST(request, {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });

    expect(response.status).toBe(401);
    expect(request.json).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});
