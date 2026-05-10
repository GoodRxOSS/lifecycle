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
    listSessions: jest.fn(),
  },
}));

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
}));

import { GET } from './route';
import AgentAdminService from 'server/services/agent/AdminService';

const mockListSessions = AgentAdminService.listSessions as jest.Mock;

function makeRequest(url: string): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/admin/agent/sessions', () => {
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
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('returns 401 when the requester is not authenticated', async () => {
    mockGetUser.mockReturnValue(null);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/sessions'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Unauthorized' },
    });
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin users before listing sessions', async () => {
    mockGetUser.mockReturnValue({
      sub: 'sample-user',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/sessions'));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it('returns paginated agent sessions using the requested filters', async () => {
    mockListSessions.mockResolvedValue({
      data: [
        {
          id: 'session-1',
          status: 'active',
          repo: 'example-org/example-repo',
          threadCount: 2,
          pendingActionsCount: 1,
        },
      ],
      metadata: {
        pagination: {
          current: 2,
          total: 3,
          items: 26,
          limit: 10,
        },
      },
    });

    const response = await GET(
      makeRequest(
        'http://localhost/api/v2/ai/admin/agent/sessions?page=2&limit=10&status=active&repo=example-org/example-repo&user=sample-admin&buildUuid=build-123'
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListSessions).toHaveBeenCalledWith({
      page: 2,
      limit: 10,
      status: 'active',
      repo: 'example-org/example-repo',
      user: 'sample-admin',
      buildUuid: 'build-123',
    });
    expect(body.data).toEqual([
      expect.objectContaining({
        id: 'session-1',
        status: 'active',
      }),
    ]);
    expect(body.metadata.pagination).toMatchObject({
      current: 2,
      total: 3,
      items: 26,
      limit: 10,
    });
  });
});
