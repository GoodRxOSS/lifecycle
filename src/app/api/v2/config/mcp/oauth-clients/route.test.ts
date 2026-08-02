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
const mockList = jest.fn();
const mockCreate = jest.fn();

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
      list: (...args: unknown[]) => mockList(...args),
      create: (...args: unknown[]) => mockCreate(...args),
    })),
  },
}));

import { GET, POST } from './route';

const CLIENT = {
  clientId: 'lifecycle-mcp-client-1',
  name: 'Desktop tool',
  redirectUris: ['http://127.0.0.1:8123/callback'],
  createdAt: '2026-08-01T20:00:00.000Z',
};

function request(method: 'GET' | 'POST', body?: unknown): NextRequest {
  return {
    method,
    headers: new Headers({ 'x-request-id': 'request-1' }),
    nextUrl: new URL('http://localhost/api/v2/config/mcp/oauth-clients'),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(body === undefined ? '' : JSON.stringify(body)),
  } as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_AUTH = 'true';
  mockGetUser.mockReturnValue({ sub: 'admin-user', realm_access: { roles: ['admin'] } });
  mockList.mockResolvedValue([CLIENT]);
  mockCreate.mockResolvedValue(CLIENT);
});

it('lists Lifecycle-managed MCP OAuth clients', async () => {
  const response = await GET(request('GET'));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ request_id: 'request-1', data: [CLIENT], error: null });
});

it('creates a client as the authenticated administrator', async () => {
  const body = { name: 'Desktop tool', redirectUris: ['http://127.0.0.1:8123/callback'] };
  const response = await POST(request('POST', body));
  expect(response.status).toBe(201);
  expect(mockCreate).toHaveBeenCalledWith(body, 'admin-user', 'request-1');
});

it('keeps list and create admin-only', async () => {
  mockGetUser.mockReturnValue({ sub: 'ordinary-user', realm_access: { roles: ['user'] } });
  expect((await GET(request('GET'))).status).toBe(403);
  expect((await POST(request('POST', { name: 'Client', redirectUris: ['https://example.com/callback'] }))).status).toBe(
    403
  );
});
