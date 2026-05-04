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
import { AgentRuntimeConfigValidationError } from 'server/lib/validation/agentRuntimeConfigValidator';

const mockGetUser = jest.fn();
const mockGetGlobalConfig = jest.fn();
const mockUpdateGlobalCustomAgentCreationPolicy = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getGlobalConfig: (...args: unknown[]) => mockGetGlobalConfig(...args),
      updateGlobalCustomAgentCreationPolicy: (...args: unknown[]) => mockUpdateGlobalCustomAgentCreationPolicy(...args),
    })),
  },
}));

import { GET, PUT } from './route';

function makeRequest(url: string, body?: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/admin/agent/creation-policy', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({
      sub: 'sample-admin',
      realm_access: {
        roles: ['admin'],
      },
    });
    mockGetGlobalConfig.mockResolvedValue({});
    mockUpdateGlobalCustomAgentCreationPolicy.mockResolvedValue({});
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('rejects non-admin users before loading policy', async () => {
    mockGetUser.mockReturnValue({
      sub: 'sample-user',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/creation-policy'));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockGetGlobalConfig).not.toHaveBeenCalled();
  });

  it('returns an empty policy when no custom-agent creation policy is configured', async () => {
    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/creation-policy'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      customAgentCreationPolicy: {},
    });
  });

  it('returns the configured custom-agent creation policy', async () => {
    mockGetGlobalConfig.mockResolvedValueOnce({
      customAgentCreationPolicy: {
        mode: 'allowlist',
        allowedGithubUsernames: ['sample-user'],
        capabilityAvailability: {
          workspace_shell: 'reserved',
        },
      },
    });

    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/creation-policy'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.customAgentCreationPolicy).toEqual({
      mode: 'allowlist',
      allowedGithubUsernames: ['sample-user'],
      capabilityAvailability: {
        workspace_shell: 'reserved',
      },
    });
  });

  it('updates policy and returns the normalized saved policy', async () => {
    const policy = {
      mode: 'allowlist',
      allowedUserIds: ['sample-user-id'],
      capabilityAvailability: {
        workspace_shell: 'reserved',
      },
    };
    mockGetGlobalConfig.mockResolvedValueOnce({
      customAgentCreationPolicy: policy,
    });

    const response = await PUT(
      makeRequest('http://localhost/api/v2/ai/admin/agent/creation-policy', {
        customAgentCreationPolicy: policy,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockUpdateGlobalCustomAgentCreationPolicy).toHaveBeenCalledWith(policy);
    expect(body.data.customAgentCreationPolicy).toEqual(policy);
  });

  it.each([
    ['missing policy', {}],
    ['null policy', { customAgentCreationPolicy: null }],
    ['array policy', { customAgentCreationPolicy: [] }],
  ])('rejects malformed body: %s', async (_label, body) => {
    const response = await PUT(makeRequest('http://localhost/api/v2/ai/admin/agent/creation-policy', body));
    const responseBody = await response.json();

    expect(response.status).toBe(400);
    expect(responseBody.error.message).toBe('Request body must include customAgentCreationPolicy.');
    expect(mockUpdateGlobalCustomAgentCreationPolicy).not.toHaveBeenCalled();
  });

  it('rejects malformed capability availability before service mutation', async () => {
    const response = await PUT(
      makeRequest('http://localhost/api/v2/ai/admin/agent/creation-policy', {
        customAgentCreationPolicy: {
          capabilityAvailability: [],
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('customAgentCreationPolicy.capabilityAvailability must be an object.');
    expect(mockUpdateGlobalCustomAgentCreationPolicy).not.toHaveBeenCalled();
  });

  it('maps service validation errors to 400', async () => {
    mockUpdateGlobalCustomAgentCreationPolicy.mockRejectedValueOnce(
      new AgentRuntimeConfigValidationError('Invalid custom agent creation mode "sometimes".')
    );

    const response = await PUT(
      makeRequest('http://localhost/api/v2/ai/admin/agent/creation-policy', {
        customAgentCreationPolicy: {
          mode: 'sometimes',
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Invalid custom agent creation mode "sometimes".');
  });
});
