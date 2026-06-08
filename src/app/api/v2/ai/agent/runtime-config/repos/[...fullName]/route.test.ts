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
const mockSetRepoConfig = jest.fn();
const mockUpdateRepoAdditiveRules = jest.fn();
const mockDeleteRepoConfig = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      setRepoConfig: (...args: unknown[]) => mockSetRepoConfig(...args),
      updateRepoAdditiveRules: (...args: unknown[]) => mockUpdateRepoAdditiveRules(...args),
      deleteRepoConfig: (...args: unknown[]) => mockDeleteRepoConfig(...args),
    })),
  },
}));

import { DELETE, PATCH, PUT } from './route';

function makeRequest(body?: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/runtime-config/repos/example-org/example-repo'),
    json: jest.fn().mockResolvedValue(body ?? {}),
  } as unknown as NextRequest;
}

const params = { params: Promise.resolve({ fullName: ['example-org', 'example-repo'] }) };

describe('/api/v2/ai/agent/runtime-config/repos/[...fullName]', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({
      sub: 'sample-user',
      realm_access: {
        roles: ['user'],
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

  it('rejects non-admin repo config replacement before parsing the body', async () => {
    const request = makeRequest({});

    const response = await PUT(request, params);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(request.json).not.toHaveBeenCalled();
    expect(mockSetRepoConfig).not.toHaveBeenCalled();
  });

  it('rejects non-admin repo additive-rule patches before parsing the body', async () => {
    const request = makeRequest({ additiveRules: [] });

    const response = await PATCH(request, params);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(request.json).not.toHaveBeenCalled();
    expect(mockUpdateRepoAdditiveRules).not.toHaveBeenCalled();
  });

  it('rejects non-admin repo config deletion before mutating config', async () => {
    const response = await DELETE(makeRequest(), params);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockDeleteRepoConfig).not.toHaveBeenCalled();
  });
});
