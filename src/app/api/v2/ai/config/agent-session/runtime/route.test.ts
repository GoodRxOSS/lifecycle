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
const mockGetGlobalRuntimeConfig = jest.fn();
const mockSetGlobalRuntimeConfig = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));

jest.mock('server/services/agentSessionConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getGlobalRuntimeConfig: (...args: unknown[]) => mockGetGlobalRuntimeConfig(...args),
      setGlobalRuntimeConfig: (...args: unknown[]) => mockSetGlobalRuntimeConfig(...args),
    })),
  },
}));

import { GET, PUT } from './route';

function makeRequest(body?: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/config/agent-session/runtime'),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe('PUT /api/v2/ai/config/agent-session/runtime (admin-gated org-wide write)', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'sample-admin', realm_access: { roles: ['admin'] } });
    mockGetGlobalRuntimeConfig.mockResolvedValue({});
    mockSetGlobalRuntimeConfig.mockResolvedValue({});
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('returns 403 for a non-admin and does not write', async () => {
    mockGetUser.mockReturnValue({ sub: 'sample-user', realm_access: { roles: ['user'] } });

    const response = await PUT(makeRequest({}));

    expect(response.status).toBe(403);
    expect(mockSetGlobalRuntimeConfig).not.toHaveBeenCalled();
  });

  it('rejects an invalid workspace backend payload', async () => {
    const response = await PUT(
      makeRequest({
        workspaceBackend: {
          provider: 'bogus_backend',
        },
      })
    );

    expect(response.status).toBe(400);
    expect(mockSetGlobalRuntimeConfig).not.toHaveBeenCalled();
  });

  it('writes the global runtime config for an admin', async () => {
    const runtimeConfig = {
      workspaceBackend: {
        provider: 'opensandbox',
        opensandbox: {
          poolRef: 'lifecycle-workspace-pool',
        },
      },
    };
    mockSetGlobalRuntimeConfig.mockResolvedValue(runtimeConfig);

    const response = await PUT(makeRequest(runtimeConfig));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSetGlobalRuntimeConfig).toHaveBeenCalledWith(runtimeConfig);
    expect(body.data).toEqual(runtimeConfig);
  });

  it('accepts a null backend block as the explicit removal sentinel', async () => {
    const response = await PUT(
      makeRequest({
        workspaceBackend: {
          provider: 'lifecycle_kubernetes',
          e2b: null,
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockSetGlobalRuntimeConfig).toHaveBeenCalledWith({
      workspaceBackend: { provider: 'lifecycle_kubernetes', e2b: null },
    });
  });

  it('maps a backend-in-use removal refusal to 409', async () => {
    const { ConflictError } = jest.requireActual('server/lib/appError');
    mockSetGlobalRuntimeConfig.mockRejectedValue(
      new ConflictError('Cannot remove the E2B workspace backend configuration.', 'workspace_backend_in_use')
    );

    const response = await PUT(makeRequest({ workspaceBackend: { e2b: null } }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('workspace_backend_in_use');
  });

  it('returns persisted workspace backend settings', async () => {
    mockGetGlobalRuntimeConfig.mockResolvedValue({
      workspaceBackend: {
        provider: 'opensandbox',
        opensandbox: {
          poolRef: 'lifecycle-workspace-pool',
        },
      },
    });

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.workspaceBackend).toEqual({
      provider: 'opensandbox',
      opensandbox: {
        poolRef: 'lifecycle-workspace-pool',
      },
    });
  });
});
