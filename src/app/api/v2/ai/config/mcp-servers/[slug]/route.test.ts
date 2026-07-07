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
const mockUpdate = jest.fn();
const mockDelete = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    return user ? { userId: user.sub, githubUsername: null, roles: user.realm_access?.roles ?? [] } : null;
  },
  requireRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    if (!user) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return { userId: user.sub, githubUsername: null, roles: user.realm_access?.roles ?? [] };
  },
}));

jest.mock('server/services/agentRuntime/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  })),
  redactMcpConfigSecrets: (config: unknown) => config,
}));

jest.mock('server/lib/dependencies', () => ({}));

import { DELETE, PUT } from './route';

function makeRequest(body?: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/config/mcp-servers/sample'),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

const params = { params: Promise.resolve({ slug: 'sample' }) };

describe('/api/v2/ai/config/mcp-servers/[slug] (admin-gated org-wide writes)', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'sample-admin', realm_access: { roles: ['admin'] } });
    mockUpdate.mockResolvedValue({ slug: 'sample', name: 'Sample' });
    mockDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('PUT returns 403 for a non-admin and does not update', async () => {
    mockGetUser.mockReturnValue({ sub: 'sample-user', realm_access: { roles: ['user'] } });

    const response = await PUT(makeRequest({ name: 'New' }), params);

    expect(response.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('PUT updates for an admin', async () => {
    const response = await PUT(makeRequest({ name: 'New' }), params);

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('DELETE returns 403 for a non-admin and does not delete', async () => {
    mockGetUser.mockReturnValue({ sub: 'sample-user', realm_access: { roles: ['user'] } });

    const response = await DELETE(makeRequest(), params);

    expect(response.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('DELETE deletes for an admin', async () => {
    const response = await DELETE(makeRequest(), params);

    expect(response.status).toBe(204);
    expect(mockDelete).toHaveBeenCalled();
  });
});
