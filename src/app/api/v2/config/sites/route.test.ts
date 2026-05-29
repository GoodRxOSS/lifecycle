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
const mockGetSitesConfig = jest.fn();
const mockSetSitesConfig = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));

jest.mock('server/services/sitesConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getConfig: (...args: unknown[]) => mockGetSitesConfig(...args),
      setConfig: (...args: unknown[]) => mockSetSitesConfig(...args),
    })),
  },
}));

import { GET, PUT } from './route';

function makeRequest(body?: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/config/sites'),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe('/api/v2/config/sites', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({
      sub: 'sample-user',
      realm_access: {
        roles: ['admin'],
      },
    });
    mockGetSitesConfig.mockResolvedValue({
      enabled: false,
      domain: 'localhost',
      hostPrefix: 'site',
    });
    mockSetSitesConfig.mockImplementation(async (config) => config);
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
      sub: 'sample-user',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockGetSitesConfig).not.toHaveBeenCalled();
  });

  it('returns the Sites config', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.config).toMatchObject({
      enabled: false,
      domain: 'localhost',
      hostPrefix: 'site',
    });
  });

  it('rejects invalid updates', async () => {
    const request = makeRequest({
      enabled: true,
      domain: 'sites.example.com',
      upload: {
        maxFiles: 0,
      },
    });

    const response = await PUT(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Validation failed');
    expect(mockSetSitesConfig).not.toHaveBeenCalled();
  });

  it('rejects partial replacement updates', async () => {
    const response = await PUT(makeRequest({ enabled: true }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Validation failed');
    expect(mockSetSitesConfig).not.toHaveBeenCalled();
  });

  it('updates the Sites config', async () => {
    const nextConfig = {
      enabled: true,
      domain: 'sites.example.com',
      port: 443,
      hostPrefix: 'preview',
      ttl: {
        enabled: true,
        defaultDays: 14,
        extensionDays: 7,
      },
      upload: {
        maxUploadBytes: 20971520,
        maxExtractedBytes: 20971520,
        maxFiles: 1000,
        allowedExtensions: ['html', 'zip'],
      },
      storage: {
        backend: 's3',
        bucket: 'lifecycle-sites',
        prefix: 'sites',
        region: 'us-west-2',
        endpoint: null,
        forcePathStyle: false,
      },
      cleanup: {
        enabled: true,
        intervalMinutes: 30,
      },
    };

    const response = await PUT(makeRequest(nextConfig));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSetSitesConfig).toHaveBeenCalledWith(nextConfig);
    expect(body.data.config).toEqual(nextConfig);
  });
});
