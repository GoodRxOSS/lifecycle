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

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({ getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args) })),
  },
}));

import { GET } from './route';

function makeRequest(): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/workspace-runtime/backends'),
  } as unknown as NextRequest;
}

describe('GET /api/v2/ai/workspace-runtime/backends', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'sample-admin', realm_access: { roles: ['admin'] } });
    mockGetAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        workspaceImage: 'workspace-image:v1',
        workspaceBackend: {
          provider: 'e2b',
          e2b: { apiKey: 'e2b-key', templateId: 'lifecycle-workspace' },
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

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockReturnValue(null);

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin user', async () => {
    mockGetUser.mockReturnValue({ sub: 'sample-user', realm_access: { roles: ['user'] } });

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
  });

  it('returns the backend catalog with configured/selectable/active flags and never echoes secrets', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.backends).toHaveLength(6);

    const byId = Object.fromEntries(body.data.backends.map((entry: { id: string }) => [entry.id, entry]));
    expect(byId.lifecycle_kubernetes).toMatchObject({
      displayName: 'Kubernetes',
      status: 'available',
      configured: true,
      selectable: true,
      active: false,
    });
    expect(byId.e2b).toMatchObject({ status: 'available', configured: true, selectable: true, active: true });
    expect(byId.modal).toMatchObject({ configured: false, selectable: false, active: false });
    expect(byId.substrate).toMatchObject({ status: 'coming_soon', selectable: false });
    expect(byId.e2b.capabilities.newChatWorkspaces).toEqual({ supported: true });
    expect(byId.e2b.capabilities.environmentSessions).toEqual({ supported: false });

    expect(JSON.stringify(body)).not.toContain('e2b-key');
  });
});
