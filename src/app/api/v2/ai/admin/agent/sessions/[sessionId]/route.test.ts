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

const mockGetUser = jest.fn();
const mockGetRequestUserIdentity = jest.fn();

jest.mock('server/services/agent/AdminService', () => ({
  __esModule: true,
  default: {
    getSession: jest.fn(),
  },
}));

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
  // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
  requireRequestUserIdentity: (...args: unknown[]) => {
    const id = mockGetRequestUserIdentity(...args);
    if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return id;
  },
}));

import { GET } from './route';
import AgentAdminService from 'server/services/agent/AdminService';

const mockGetSession = AgentAdminService.getSession as jest.Mock;

function makeRequest(url: string): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/admin/agent/sessions/[sessionId]', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({
      sub: 'sample-admin',
      realm_access: {
        roles: ['admin'],
      },
    });
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-admin',
      githubUsername: 'sample-admin',
    });
    mockGetSession.mockResolvedValue({
      id: 'session-1',
      status: 'active',
      repo: 'example-org/example-repo',
      threads: [],
    });
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('returns 403 for non-admin users before loading the session', async () => {
    mockGetUser.mockReturnValue({
      sub: 'sample-user',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/sessions/session-1'), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('returns the requested session for admin users', async () => {
    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/sessions/session-1'), {
      params: Promise.resolve({ sessionId: 'session-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetSession).toHaveBeenCalledWith('session-1');
    expect(body.data).toEqual(
      expect.objectContaining({
        id: 'session-1',
        status: 'active',
      })
    );
  });
});
