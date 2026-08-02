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
const mockDelete = jest.fn();

jest.mock('server/lib/get-user', () => ({
  __esModule: true,
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (req: unknown) => {
    const payload = mockGetUser(req) as { sub?: string; realm_access?: { roles?: string[] } } | null;
    return payload ? { userId: payload.sub, roles: payload.realm_access?.roles ?? [] } : null;
  },
  requireRequestUserIdentity: (req: unknown) => {
    const payload = mockGetUser(req) as { sub?: string; realm_access?: { roles?: string[] } } | null;
    if (!payload?.sub) throw new Error('unauthorized');
    return { userId: payload.sub, roles: payload.realm_access?.roles ?? [] };
  },
}));

jest.mock('server/services/keycloak/mcpOauthClients', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      delete: (...args: unknown[]) => mockDelete(...args),
    })),
  },
}));

import { DELETE } from './route';

function request(): NextRequest {
  return {
    method: 'DELETE',
    headers: new Headers({ 'x-request-id': 'request-2' }),
    nextUrl: new URL('http://localhost/api/v2/config/mcp/oauth-clients/lifecycle-mcp-client-1'),
    text: jest.fn().mockResolvedValue(''),
  } as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_AUTH = 'true';
  mockGetUser.mockReturnValue({ sub: 'admin-user', realm_access: { roles: ['admin'] } });
  mockDelete.mockResolvedValue(undefined);
});

it('deletes a Lifecycle-managed MCP OAuth client', async () => {
  const response = await DELETE(request(), {
    params: Promise.resolve({ clientId: 'lifecycle-mcp-client-1' }),
  });
  expect(response.status).toBe(204);
  expect(mockDelete).toHaveBeenCalledWith('lifecycle-mcp-client-1', 'admin-user', 'request-2');
});

it('keeps deletion admin-only', async () => {
  mockGetUser.mockReturnValue({ sub: 'ordinary-user', realm_access: { roles: ['user'] } });
  const response = await DELETE(request(), {
    params: Promise.resolve({ clientId: 'lifecycle-mcp-client-1' }),
  });
  expect(response.status).toBe(403);
  expect(mockDelete).not.toHaveBeenCalled();
});
