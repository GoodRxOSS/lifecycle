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
    listMcpServerUsers: jest.fn(),
  },
}));

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: jest.fn(),
}));

import { GET } from './route';
import AgentAdminService from 'server/services/agent/AdminService';
import { getRequestUserIdentity } from 'server/lib/get-user';

const mockListMcpServerUsers = AgentAdminService.listMcpServerUsers as jest.Mock;
const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;

function makeRequest(url: string): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/admin/agent/mcp-servers/[slug]/users', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 when scope is missing', async () => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-admin',
      githubUsername: 'sample-admin',
    });

    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/admin/agent/mcp-servers/sample-connector/users'),
      {
        params: { slug: 'sample-connector' },
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Missing required query parameter: scope' },
    });
    expect(mockListMcpServerUsers).not.toHaveBeenCalled();
  });

  it('returns masked per-user connection coverage rows', async () => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-admin',
      githubUsername: 'sample-admin',
    });
    mockListMcpServerUsers.mockResolvedValue([
      {
        userId: 'sample-user',
        githubUsername: 'sample-user',
        stale: false,
        configuredFieldKeys: ['apiToken', 'siteUrl'],
        discoveredToolCount: 3,
        validationError: null,
        validatedAt: '2026-04-05T12:00:00.000Z',
        updatedAt: '2026-04-05T12:05:00.000Z',
      },
    ]);

    const response = await GET(
      makeRequest(
        'http://localhost/api/v2/ai/admin/agent/mcp-servers/sample-connector/users?scope=example-org/example-repo'
      ),
      {
        params: { slug: 'sample-connector' },
      }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListMcpServerUsers).toHaveBeenCalledWith('sample-connector', 'example-org/example-repo');
    expect(body.data).toEqual([
      {
        userId: 'sample-user',
        githubUsername: 'sample-user',
        stale: false,
        configuredFieldKeys: ['apiToken', 'siteUrl'],
        discoveredToolCount: 3,
        validationError: null,
        validatedAt: '2026-04-05T12:00:00.000Z',
        updatedAt: '2026-04-05T12:05:00.000Z',
      },
    ]);
  });

  it('returns 404 when the shared connector definition does not exist', async () => {
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-admin',
      githubUsername: 'sample-admin',
    });
    mockListMcpServerUsers.mockRejectedValue(new Error('MCP server config not found'));

    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/admin/agent/mcp-servers/sample-connector/users?scope=global'),
      {
        params: { slug: 'sample-connector' },
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'MCP server config not found' },
    });
  });
});
