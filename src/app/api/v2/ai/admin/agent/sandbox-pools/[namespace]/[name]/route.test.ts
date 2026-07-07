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
import { ConflictError, NotFoundError } from 'server/lib/appError';

const mockGetUser = jest.fn();
const mockGetPool = jest.fn();
const mockUpdateCapacity = jest.fn();

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

// Keep the real parseOpenSandboxPoolCapacityPatch; only stub the k8s-backed service class.
jest.mock('server/services/agent/OpenSandboxPoolAdminService', () => ({
  __esModule: true,
  ...jest.requireActual('server/services/agent/OpenSandboxPoolAdminService'),
  default: jest.fn(() => ({
    getPool: (...args: unknown[]) => mockGetPool(...args),
    updateCapacity: (...args: unknown[]) => mockUpdateCapacity(...args),
  })),
}));

import { GET, PATCH } from './route';

function makeRequest(body?: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/admin/agent/sandbox-pools/opensandbox/pool-a'),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeContext(params: Record<string, string | undefined> = { namespace: 'opensandbox', name: 'pool-a' }) {
  return { params: Promise.resolve(params) };
}

const pool = {
  name: 'pool-a',
  namespace: 'opensandbox',
  capacitySpec: { poolMin: 1, poolMax: 3, bufferMin: 1, bufferMax: 1 },
  status: { total: 3, allocated: 2, available: 1 },
  labels: {},
};

describe('/api/v2/ai/admin/agent/sandbox-pools/[namespace]/[name]', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'sample-admin', realm_access: { roles: ['admin'] } });
    mockGetPool.mockResolvedValue(pool);
    mockUpdateCapacity.mockResolvedValue(pool);
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  describe('GET', () => {
    it('returns 403 for a non-admin user', async () => {
      mockGetUser.mockReturnValue({ sub: 'sample-user', realm_access: { roles: ['user'] } });

      const response = await GET(makeRequest(), makeContext());

      expect(response.status).toBe(403);
      expect(mockGetPool).not.toHaveBeenCalled();
    });

    it('returns the pool', async () => {
      const response = await GET(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockGetPool).toHaveBeenCalledWith('opensandbox', 'pool-a');
      expect(body.data.pool).toEqual(pool);
    });

    it('maps NotFoundError to 404', async () => {
      mockGetPool.mockRejectedValue(
        new NotFoundError('OpenSandbox pool "opensandbox/pool-a" was not found.', 'opensandbox_pool_not_found')
      );

      const response = await GET(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error.code).toBe('opensandbox_pool_not_found');
    });

    it('returns 400 when route params are missing', async () => {
      const response = await GET(makeRequest(), makeContext({ namespace: 'opensandbox' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toBe('OpenSandbox pool namespace and name are required.');
      expect(mockGetPool).not.toHaveBeenCalled();
    });
  });

  describe('PATCH', () => {
    it('updates capacity with the parsed patch', async () => {
      const response = await PATCH(makeRequest({ capacitySpec: { poolMax: 5, bufferMax: 2 } }), makeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockUpdateCapacity).toHaveBeenCalledWith('opensandbox', 'pool-a', { poolMax: 5, bufferMax: 2 });
      expect(body.data.pool).toEqual(pool);
    });

    it('returns 400 for invalid JSON', async () => {
      const req = makeRequest();
      (req.json as jest.Mock).mockRejectedValue(new SyntaxError('Unexpected token'));

      const response = await PATCH(req, makeContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toBe('Invalid JSON in request body.');
      expect(mockUpdateCapacity).not.toHaveBeenCalled();
    });

    it('returns 400 when capacitySpec is missing', async () => {
      const response = await PATCH(makeRequest({}), makeContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toBe('capacitySpec must be an object.');
      expect(mockUpdateCapacity).not.toHaveBeenCalled();
    });

    it('maps ConflictError to 409', async () => {
      mockUpdateCapacity.mockRejectedValue(
        new ConflictError(
          'OpenSandbox pool "opensandbox/pool-a" was modified concurrently; retry the update.',
          'opensandbox_pool_conflict'
        )
      );

      const response = await PATCH(makeRequest({ capacitySpec: { poolMax: 5 } }), makeContext());
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error.code).toBe('opensandbox_pool_conflict');
    });
  });
});
