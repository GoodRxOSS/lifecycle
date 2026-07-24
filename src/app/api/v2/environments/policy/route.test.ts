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

const mockGetIdentity = jest.fn();
const mockGetApiEnvironmentsConfig = jest.fn();

jest.mock('server/lib/get-user', () => ({
  __esModule: true,
  getRequestUserIdentity: (...args: unknown[]) => mockGetIdentity(...args),
}));

jest.mock('server/services/apiAccessConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getApiEnvironmentsConfig: (...args: unknown[]) => mockGetApiEnvironmentsConfig(...args),
    })),
  },
}));

import { GET } from './route';

const makeRequest = (headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost/api/v2/environments/policy', { headers });

describe('GET /api/v2/environments/policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIdentity.mockReturnValue({ userId: 'u-1', roles: ['user'] });
    mockGetApiEnvironmentsConfig.mockResolvedValue({
      enabled: true,
      defaultTtlHours: 72,
      maxTtlHours: 336,
      extensionHours: 24,
    });
  });

  it('401s anonymous requests', async () => {
    mockGetIdentity.mockReturnValue(null);

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockGetApiEnvironmentsConfig).not.toHaveBeenCalled();
  });

  it('403s API keys because the endpoint is session-only', async () => {
    const res = await GET(makeRequest({ authorization: `Bearer lfc_${'a'.repeat(40)}` }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('interactive_auth_required');
    expect(mockGetApiEnvironmentsConfig).not.toHaveBeenCalled();
  });

  it('returns the creation policy for any signed-in user', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      enabled: true,
      defaultTtlHours: 72,
      maxTtlHours: 336,
      extensionHours: 24,
    });
  });

  it('reports enabled false without requiring the admin role', async () => {
    mockGetApiEnvironmentsConfig.mockResolvedValue({
      enabled: false,
      defaultTtlHours: 72,
      maxTtlHours: 336,
      extensionHours: 24,
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect((await res.json()).data.enabled).toBe(false);
  });
});
