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
const mockGetAllConfigs = jest.fn();
const mockCreateDaytonaRuntimeService = jest.fn();

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

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args) })),
  },
}));

jest.mock('server/services/workspaceRuntime/providers/daytona', () => ({
  ...jest.requireActual('server/services/workspaceRuntime/providers/daytona'),
  createDaytonaRuntimeService: (...args: unknown[]) => mockCreateDaytonaRuntimeService(...args),
}));

import { POST } from './route';

function makeRequest(id: string): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = {
    headers: new Headers([['x-request-id', 'req-deep-check']]),
    nextUrl: new URL(`http://localhost/api/v2/ai/workspace-runtime/backends/${id}/deep-check`),
  } as unknown as NextRequest;
  return [req, { params: Promise.resolve({ id }) }];
}

describe('POST /api/v2/ai/workspace-runtime/backends/{id}/deep-check', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'sample-admin', realm_access: { roles: ['admin'] } });
    mockGetAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceBackend: {
          provider: 'daytona',
          daytona: {
            apiKey: 'daytona-key',
            snapshot: 'snap',
            apiUrl: 'https://app.daytona.io/api',
          },
        },
      },
    });
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('returns 401 when unauthenticated and 403 for non-admin users', async () => {
    mockGetUser.mockReturnValue(null);
    expect((await POST(...makeRequest('daytona'))).status).toBe(401);

    mockGetUser.mockReturnValue({ sub: 'sample-user', realm_access: { roles: ['user'] } });
    expect((await POST(...makeRequest('daytona'))).status).toBe(403);

    expect(mockCreateDaytonaRuntimeService).not.toHaveBeenCalled();
  });

  it('refuses link-local/metadata probe targets before provisioning a sandbox', async () => {
    mockGetAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceBackend: {
          daytona: {
            apiKey: 'daytona-key',
            snapshot: 'snap',
            apiUrl: 'http://169.254.169.254/latest/meta-data',
          },
        },
      },
    });

    const response = await POST(...makeRequest('daytona'));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('link-local/metadata');
    expect(mockCreateDaytonaRuntimeService).not.toHaveBeenCalled();
  });
});
