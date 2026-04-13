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

jest.mock('server/services/agent/AdminService', () => ({
  __esModule: true,
  default: {
    listSessions: jest.fn(),
  },
}));

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: jest.fn(),
}));

import { GET } from './route';
import AgentAdminService from 'server/services/agent/AdminService';
import { getRequestUserIdentity } from 'server/lib/get-user';

const mockListSessions = AgentAdminService.listSessions as jest.Mock;
const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;

function makeRequest(url: string): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/admin/agent/sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when the requester is not authenticated', async () => {
    mockGetRequestUserIdentity.mockReturnValue(null);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/sessions'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Unauthorized' },
    });
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it('returns paginated agent sessions using the requested filters', async () => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-admin',
      githubUsername: 'sample-admin',
    });
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
