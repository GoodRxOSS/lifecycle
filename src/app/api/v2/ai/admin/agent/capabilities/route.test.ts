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
const mockListCapabilityInventory = jest.fn();
const mockGetGlobalConfig = jest.fn();
const mockGetRepoConfig = jest.fn();
const mockGetEffectiveConfig = jest.fn();
const mockUpdateGlobalCapabilityPolicy = jest.fn();
const mockUpdateRepoCapabilityPolicy = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));

jest.mock('server/services/agentSessionConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      listCapabilityInventory: (...args: unknown[]) => mockListCapabilityInventory(...args),
    })),
  },
}));

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getGlobalConfig: (...args: unknown[]) => mockGetGlobalConfig(...args),
      getRepoConfig: (...args: unknown[]) => mockGetRepoConfig(...args),
      getEffectiveConfig: (...args: unknown[]) => mockGetEffectiveConfig(...args),
      updateGlobalCapabilityPolicy: (...args: unknown[]) => mockUpdateGlobalCapabilityPolicy(...args),
      updateRepoCapabilityPolicy: (...args: unknown[]) => mockUpdateRepoCapabilityPolicy(...args),
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

const capabilityRow = {
  capabilityId: 'workspace_shell',
  label: 'Workspace shell',
  description: 'Run shell commands in the workspace.',
  category: 'workspace',
  defaultAvailability: 'all_users',
  effectiveAvailability: 'admin_only',
  approvalMode: 'require_approval',
  runtimeCapabilityKey: 'shell_exec',
  userSelectable: true,
  toolCount: 1,
  resourceCount: 0,
  resourceGrants: [],
  tools: [],
};

describe('/api/v2/ai/admin/agent/capabilities', () => {
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
    mockListCapabilityInventory.mockResolvedValue([capabilityRow]);
    mockGetGlobalConfig.mockResolvedValue({
      capabilityPolicy: {
        availability: {
          workspace_shell: 'admin_only',
        },
      },
    });
    mockGetRepoConfig.mockResolvedValue(null);
    mockGetEffectiveConfig.mockResolvedValue({
      capabilityPolicy: {
        availability: {
          workspace_shell: 'admin_only',
        },
      },
    });
    mockUpdateGlobalCapabilityPolicy.mockResolvedValue({});
    mockUpdateRepoCapabilityPolicy.mockResolvedValue({});
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('rejects non-admin users before loading inventory', async () => {
    mockGetUser.mockReturnValue({
      sub: 'sample-user',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/capabilities'));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockListCapabilityInventory).not.toHaveBeenCalled();
  });

  it('returns global capability inventory and effective policy', async () => {
    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/capabilities'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListCapabilityInventory).toHaveBeenCalledWith('global');
    expect(body.data).toEqual(
      expect.objectContaining({
        scope: 'global',
        scopeType: 'global',
        capabilityPolicy: {
          availability: {
            workspace_shell: 'admin_only',
          },
        },
        effectiveCapabilityPolicy: {
          availability: {
            workspace_shell: 'admin_only',
          },
        },
        capabilities: [capabilityRow],
      })
    );
  });

  it('returns repo capability inventory with inherited policy metadata', async () => {
    mockGetRepoConfig.mockResolvedValue({
      capabilityPolicy: {
        availability: {
          workspace_shell: 'all_users',
        },
      },
    });
    mockGetEffectiveConfig.mockResolvedValue({
      capabilityPolicy: {
        availability: {
          workspace_shell: 'all_users',
        },
      },
    });

    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/admin/agent/capabilities?scope=Example-Org/Example-Repo')
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetRepoConfig).toHaveBeenCalledWith('example-org/example-repo');
    expect(mockListCapabilityInventory).toHaveBeenCalledWith('example-org/example-repo');
    expect(body.data).toEqual(
      expect.objectContaining({
        scope: 'example-org/example-repo',
        scopeType: 'repo',
        repoFullName: 'example-org/example-repo',
        capabilityPolicy: {
          availability: {
            workspace_shell: 'all_users',
          },
        },
        inheritedCapabilityPolicy: {
          availability: {
            workspace_shell: 'admin_only',
          },
        },
        effectiveCapabilityPolicy: {
          availability: {
            workspace_shell: 'all_users',
          },
        },
      })
    );
  });

  it('updates global capability policy and returns refreshed inventory', async () => {
    const body = {
      capabilityPolicy: {
        availability: {
          workspace_shell: 'disabled',
        },
      },
    };

    const response = await PUT(makeRequest('http://localhost/api/v2/ai/admin/agent/capabilities', body));

    expect(response.status).toBe(200);
    expect(mockUpdateGlobalCapabilityPolicy).toHaveBeenCalledWith(body.capabilityPolicy);
    expect(mockUpdateRepoCapabilityPolicy).not.toHaveBeenCalled();
    expect(mockListCapabilityInventory).toHaveBeenCalledWith('global');
  });

  it('updates repo capability policy and returns refreshed inventory', async () => {
    const body = {
      capabilityPolicy: {
        availability: {
          workspace_shell: 'all_users',
        },
      },
    };

    const response = await PUT(
      makeRequest('http://localhost/api/v2/ai/admin/agent/capabilities?scope=Example-Org/Example-Repo', body)
    );

    expect(response.status).toBe(200);
    expect(mockUpdateRepoCapabilityPolicy).toHaveBeenCalledWith('example-org/example-repo', body.capabilityPolicy);
    expect(mockUpdateGlobalCapabilityPolicy).not.toHaveBeenCalled();
    expect(mockListCapabilityInventory).toHaveBeenCalledWith('example-org/example-repo');
  });

  it('rejects malformed repo scope', async () => {
    const response = await GET(makeRequest('http://localhost/api/v2/ai/admin/agent/capabilities?scope=repo'));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Repo capability scope');
    expect(mockListCapabilityInventory).not.toHaveBeenCalled();
  });

  it('rejects invalid capability ids from service validation', async () => {
    mockUpdateGlobalCapabilityPolicy.mockRejectedValueOnce(
      new AgentRuntimeConfigValidationError('Unknown capability id "sample_unknown".')
    );

    const response = await PUT(
      makeRequest('http://localhost/api/v2/ai/admin/agent/capabilities', {
        capabilityPolicy: {
          availability: {
            sample_unknown: 'disabled',
          },
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Unknown capability id "sample_unknown".');
  });

  it('rejects invalid capability availability values from service validation', async () => {
    mockUpdateGlobalCapabilityPolicy.mockRejectedValueOnce(
      new AgentRuntimeConfigValidationError('Capability "workspace_shell" has invalid availability "sometimes".')
    );

    const response = await PUT(
      makeRequest('http://localhost/api/v2/ai/admin/agent/capabilities', {
        capabilityPolicy: {
          availability: {
            workspace_shell: 'sometimes',
          },
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Capability "workspace_shell" has invalid availability "sometimes".');
  });

  it.each([
    ['null', null],
    ['array', []],
    ['scalar', 'disabled'],
  ])('rejects malformed capability policy availability: %s', async (_label, availability) => {
    const response = await PUT(
      makeRequest('http://localhost/api/v2/ai/admin/agent/capabilities', {
        capabilityPolicy: {
          availability,
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('capabilityPolicy.availability must be an object.');
    expect(mockUpdateGlobalCapabilityPolicy).not.toHaveBeenCalled();
    expect(mockUpdateRepoCapabilityPolicy).not.toHaveBeenCalled();
  });
});
