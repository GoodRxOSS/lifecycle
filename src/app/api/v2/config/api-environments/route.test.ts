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
const mockGetApiEnvironmentsConfig = jest.fn();
const mockSetApiEnvironmentsConfig = jest.fn();

jest.mock('server/lib/get-user', () => ({
  __esModule: true,
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (req: unknown) => {
    const payload = mockGetUser(req) as { sub?: string; realm_access?: { roles?: string[] } } | null;
    return payload ? { userId: payload.sub, roles: payload.realm_access?.roles ?? [] } : null;
  },
  requireRequestUserIdentity: (req: unknown) => {
    const payload = mockGetUser(req) as { sub?: string; realm_access?: { roles?: string[] } } | null;
    if (!payload) throw new Error('unauthorized');
    return { userId: payload.sub, roles: payload.realm_access?.roles ?? [] };
  },
}));

jest.mock('server/services/apiAccessConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getApiEnvironmentsConfig: (...args: unknown[]) => mockGetApiEnvironmentsConfig(...args),
      setApiEnvironmentsConfig: (...args: unknown[]) => mockSetApiEnvironmentsConfig(...args),
    })),
  },
}));

import { GET, PUT } from './route';

const VALID_CONFIG = {
  enabled: true,
  defaultTtlHours: 72,
  maxTtlHours: 336,
  extensionHours: 24,
};

function makeRequest(body?: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/config/api-environments'),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe('/api/v2/config/api-environments', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({
      sub: 'admin-user',
      realm_access: {
        roles: ['admin'],
      },
    });
    mockGetApiEnvironmentsConfig.mockResolvedValue({ ...VALID_CONFIG, enabled: false });
    mockSetApiEnvironmentsConfig.mockImplementation(async (config) => config);
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('requires admin access before reading config', async () => {
    mockGetUser.mockReturnValue({
      sub: 'plain-user',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockGetApiEnvironmentsConfig).not.toHaveBeenCalled();
  });

  it('returns the api_environments config', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.config).toMatchObject({ enabled: false, maxTtlHours: 336 });
  });

  it('rejects unknown fields', async () => {
    const response = await PUT(makeRequest({ ...VALID_CONFIG, ttlDays: 7 }));

    expect(response.status).toBe(400);
    expect(mockSetApiEnvironmentsConfig).not.toHaveBeenCalled();
  });

  it('rejects a default TTL above the max TTL', async () => {
    const response = await PUT(makeRequest({ ...VALID_CONFIG, defaultTtlHours: 400, maxTtlHours: 336 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('defaultTtlHours must not exceed maxTtlHours');
    expect(mockSetApiEnvironmentsConfig).not.toHaveBeenCalled();
  });

  it('updates the config, attributing the acting admin for the transactional audit row', async () => {
    const response = await PUT(makeRequest(VALID_CONFIG));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSetApiEnvironmentsConfig).toHaveBeenCalledWith(VALID_CONFIG, 'admin-user');
    expect(body.data.config).toEqual(VALID_CONFIG);
  });
});
