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
const mockListPools = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));

jest.mock('server/services/agent/OpenSandboxPoolAdminService', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    listPools: (...args: unknown[]) => mockListPools(...args),
  })),
}));

import { GET } from './route';

function makeRequest(url: string): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

const pool = {
  name: 'lifecycle-workspace-pool',
  namespace: 'opensandbox',
  capacitySpec: { poolMin: 1, poolMax: 3, bufferMin: 1, bufferMax: 1 },
  status: { total: 3, allocated: 2, available: 1 },
  labels: {},
};

describe('GET /api/v2/ai/admin/agent/sandbox-pools', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'sample-admin', realm_access: { roles: ['admin'] } });
    mockListPools.mockResolvedValue([pool]);
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockReturnValue(null);

    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/sandbox-pools'));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe('Unauthorized');
    expect(mockListPools).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin user', async () => {
    mockGetUser.mockReturnValue({ sub: 'sample-user', realm_access: { roles: ['user'] } });

    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/sandbox-pools'));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockListPools).not.toHaveBeenCalled();
  });

  it('lists pools without a namespace param', async () => {
    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/sandbox-pools'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListPools).toHaveBeenCalledWith(null);
    expect(body.data.pools).toEqual([pool]);
  });

  it('passes the namespace query param through to the service', async () => {
    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/sandbox-pools?namespace=custom-ns'));

    expect(response.status).toBe(200);
    expect(mockListPools).toHaveBeenCalledWith('custom-ns');
  });
});
