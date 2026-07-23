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
const mockGetApiKeysConfig = jest.fn();
const mockSetApiKeysConfig = jest.fn();

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
      getApiKeysConfig: (...args: unknown[]) => mockGetApiKeysConfig(...args),
      setApiKeysConfig: (...args: unknown[]) => mockSetApiKeysConfig(...args),
    })),
  },
}));

import { GET, PUT } from './route';

const VALID_CONFIG = {
  issuanceEnabled: true,
  personalAuthEnabled: true,
  serviceAuthEnabled: false,
  rateLimitPerMinute: 300,
  maxActivePersonalKeysPerUser: 5,
};

function makeRequest(body?: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/config/api-keys'),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe('/api/v2/config/api-keys', () => {
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
    mockGetApiKeysConfig.mockResolvedValue({ ...VALID_CONFIG, issuanceEnabled: false });
    mockSetApiKeysConfig.mockImplementation(async (config) => config);
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
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockGetApiKeysConfig).not.toHaveBeenCalled();
  });

  it('requires admin access before writing config', async () => {
    mockGetUser.mockReturnValue({
      sub: 'plain-user',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await PUT(makeRequest(VALID_CONFIG));

    expect(response.status).toBe(403);
    expect(mockSetApiKeysConfig).not.toHaveBeenCalled();
  });

  it('returns the api_keys config', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.config).toMatchObject({ issuanceEnabled: false, rateLimitPerMinute: 300 });
  });

  it('rejects unknown fields', async () => {
    const response = await PUT(makeRequest({ ...VALID_CONFIG, expiresInHours: 24 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Validation failed');
    expect(mockSetApiKeysConfig).not.toHaveBeenCalled();
  });

  it('rejects partial replacement updates', async () => {
    const response = await PUT(makeRequest({ issuanceEnabled: true }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Validation failed');
    expect(mockSetApiKeysConfig).not.toHaveBeenCalled();
  });

  it('rejects out-of-range limits', async () => {
    const response = await PUT(makeRequest({ ...VALID_CONFIG, rateLimitPerMinute: 0 }));

    expect(response.status).toBe(400);
    expect(mockSetApiKeysConfig).not.toHaveBeenCalled();
  });

  it('updates the config, attributing the acting admin for the transactional audit row', async () => {
    const response = await PUT(makeRequest(VALID_CONFIG));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSetApiKeysConfig).toHaveBeenCalledWith(VALID_CONFIG, 'admin-user');
    expect(body.data.config).toEqual(VALID_CONFIG);
  });
});
