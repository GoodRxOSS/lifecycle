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
const mockGetSettings = jest.fn();
const mockSetConfig = jest.fn();

jest.mock('server/lib/get-user', () => ({
  __esModule: true,
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (req: unknown) => {
    const payload = mockGetUser(req) as {
      sub?: string;
      realm_access?: { roles?: string[] };
    } | null;
    return payload ? { userId: payload.sub, roles: payload.realm_access?.roles ?? [] } : null;
  },
  requireRequestUserIdentity: (req: unknown) => {
    const payload = mockGetUser(req) as {
      sub?: string;
      realm_access?: { roles?: string[] };
    } | null;
    if (!payload?.sub) throw new Error('unauthorized');
    return { userId: payload.sub, roles: payload.realm_access?.roles ?? [] };
  },
}));

jest.mock('server/services/mcpConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
      setConfig: (...args: unknown[]) => mockSetConfig(...args),
    })),
  },
}));

import { GET, PUT } from './route';

const STATUS = {
  enabled: true,
  allowChanges: false,
  endpoint: 'https://lifecycle.example.test/mcp',
  issue: null,
  capabilities: [],
};

function request(method: 'GET' | 'PUT', body?: unknown): NextRequest {
  return {
    method,
    headers: new Headers({ 'x-request-id': 'request-1' }),
    nextUrl: new URL('http://localhost/api/v2/config/mcp'),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(body === undefined ? '' : JSON.stringify(body)),
  } as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_AUTH = 'true';
  mockGetUser.mockReturnValue({
    sub: 'admin-user',
    realm_access: { roles: ['admin'] },
  });
  mockGetSettings.mockResolvedValue(STATUS);
  mockSetConfig.mockResolvedValue(STATUS);
});

it('returns the single small admin settings resource', async () => {
  const response = await GET(request('GET'));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    request_id: 'request-1',
    data: STATUS,
    error: null,
  });
  expect(mockGetSettings).toHaveBeenCalledWith();
});

it('accepts exactly enabled and allowChanges', async () => {
  const body = { enabled: true, allowChanges: false };
  const response = await PUT(request('PUT', body));
  expect(response.status).toBe(200);
  expect(mockSetConfig).toHaveBeenCalledWith(body, 'admin-user', 'request-1');
});

it('keeps both methods admin-only', async () => {
  mockGetUser.mockReturnValue({
    sub: 'ordinary-user',
    realm_access: { roles: ['user'] },
  });
  expect((await GET(request('GET'))).status).toBe(403);
  expect((await PUT(request('PUT', { enabled: false, allowChanges: false }))).status).toBe(403);
});
