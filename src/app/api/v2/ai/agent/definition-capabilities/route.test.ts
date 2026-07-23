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

const mockGetRequestUserIdentity = jest.fn();
const mockGetUserDefinitionCreationStatus = jest.fn();
const mockListUserSelectableCapabilities = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
  // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
  requireRequestUserIdentity: (...args: unknown[]) => {
    const id = mockGetRequestUserIdentity(...args);
    if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return id;
  },
}));

jest.mock('server/services/agent/CustomAgentDefinitionService', () => ({
  __esModule: true,
  customAgentDefinitionService: {
    getUserDefinitionCreationStatus: (...args: unknown[]) => mockGetUserDefinitionCreationStatus(...args),
    listUserSelectableCapabilities: (...args: unknown[]) => mockListUserSelectableCapabilities(...args),
  },
}));

import { GET } from './route';

const capabilityRows = [
  {
    capabilityId: 'read_context',
    label: 'Read/context',
    description: 'Read session context.',
    category: 'read',
    toolCount: 0,
    resourceCount: 1,
    requiresWorkspace: false,
    tools: [],
    resources: [{ name: 'Session context' }],
  },
  {
    capabilityId: 'workspace_shell',
    label: 'Command tools',
    description: 'Run shell commands inside a development workspace.',
    category: 'workspace',
    toolCount: 1,
    resourceCount: 1,
    requiresWorkspace: true,
    tools: [{ name: 'Workspace exec', description: null }],
    resources: [{ name: 'Workspace shell' }],
  },
];

function makeRequest(url = 'http://localhost/api/v2/ai/agent/definition-capabilities'): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/definition-capabilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      roles: ['user'],
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetUserDefinitionCreationStatus.mockResolvedValue({
      canCreate: true,
      creationUnavailableReason: null,
    });
    mockListUserSelectableCapabilities.mockResolvedValue(capabilityRows);
  });

  it('returns 401 for unauthenticated requests', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(mockListUserSelectableCapabilities).not.toHaveBeenCalled();
  });

  it('defaults to current_workspace_when_available and delegates userSelectable inventory loading', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetUserDefinitionCreationStatus).toHaveBeenCalledWith({
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
        roles: ['user'],
      },
    });
    expect(mockListUserSelectableCapabilities).toHaveBeenCalledWith({
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
        roles: ['user'],
      },
      resourceBehavior: 'current_workspace_when_available',
    });
    expect(body.data).toEqual({
      resourceBehavior: 'current_workspace_when_available',
      canCreate: true,
      creationUnavailableReason: null,
      capabilities: capabilityRows,
    });
  });

  it('returns blocked creation status without loading capabilities', async () => {
    mockGetUserDefinitionCreationStatus.mockResolvedValueOnce({
      canCreate: false,
      creationUnavailableReason: 'creation_restricted',
    });

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListUserSelectableCapabilities).not.toHaveBeenCalled();
    expect(body.data).toEqual({
      resourceBehavior: 'current_workspace_when_available',
      canCreate: false,
      creationUnavailableReason: 'creation_restricted',
      capabilities: [],
    });
  });

  it('passes chat_only resourceBehavior through to omit source-incompatible capabilities in the service', async () => {
    mockListUserSelectableCapabilities.mockResolvedValueOnce([capabilityRows[0]]);

    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/agent/definition-capabilities?resourceBehavior=chat_only')
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListUserSelectableCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ resourceBehavior: 'chat_only' })
    );
    expect(body.data.capabilities.map((capability: { capabilityId: string }) => capability.capabilityId)).toEqual([
      'read_context',
    ]);
  });

  it('rejects unsupported resourceBehavior values', async () => {
    const response = await GET(
      makeRequest('http://localhost/api/v2/ai/agent/definition-capabilities?resourceBehavior=workspace_only')
    );

    expect(response.status).toBe(400);
    expect(mockGetUserDefinitionCreationStatus).not.toHaveBeenCalled();
    expect(mockListUserSelectableCapabilities).not.toHaveBeenCalled();
  });

  it('does not include admin_only, system_only, disabled, hidden count, toolKey, or serverSlug response fields', async () => {
    mockListUserSelectableCapabilities.mockResolvedValueOnce([
      {
        ...capabilityRows[0],
        hiddenRestrictedCount: 2,
        toolKey: 'mcp__sample__read_secret',
        serverSlug: 'sample-internal-mcp',
        defaultAvailability: 'admin_only',
      },
    ]);

    const response = await GET(makeRequest());
    const body = await response.json();
    const serialized = JSON.stringify(body.data);

    expect(response.status).toBe(200);
    expect(body.data.capabilities).toEqual([capabilityRows[0]]);
    expect(serialized).toContain('requiresWorkspace');
    expect(serialized).not.toContain('admin_only');
    expect(serialized).not.toContain('system_only');
    expect(serialized).not.toContain('disabled');
    expect(serialized).not.toContain('hiddenRestricted');
    expect(serialized).not.toContain('toolKey');
    expect(serialized).not.toContain('serverSlug');
  });
});
