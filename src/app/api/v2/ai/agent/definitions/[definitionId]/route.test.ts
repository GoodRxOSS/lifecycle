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
const mockGetUserDefinition = jest.fn();
const mockUpdateUserDefinition = jest.fn();
const mockArchiveUserDefinition = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
  // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
  requireRequestUserIdentity: (...args: unknown[]) => {
    const id = mockGetRequestUserIdentity(...args);
    if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return id;
  },
}));

jest.mock('server/services/agent/CustomAgentDefinitionService', () => {
  const CONTRACT: Record<string, { httpStatus: number; code: string }> = {
    not_found: { httpStatus: 404, code: 'custom_agent_not_found' },
    model_unavailable: { httpStatus: 409, code: 'custom_agent_conflict' },
    creation_unavailable: { httpStatus: 403, code: 'custom_agent_creation_unavailable' },
  };
  class CustomAgentDefinitionServiceError extends Error {
    readonly httpStatus: number;
    readonly code: string;
    constructor(public readonly reason: string, message: string) {
      super(message);
      this.name = 'CustomAgentDefinitionServiceError';
      const contract = CONTRACT[reason] || { httpStatus: 400, code: 'custom_agent_invalid' };
      this.httpStatus = contract.httpStatus;
      this.code = contract.code;
    }
  }

  return {
    __esModule: true,
    CustomAgentDefinitionServiceError,
    customAgentDefinitionService: {
      getUserDefinition: (...args: unknown[]) => mockGetUserDefinition(...args),
      updateUserDefinition: (...args: unknown[]) => mockUpdateUserDefinition(...args),
      archiveUserDefinition: (...args: unknown[]) => mockArchiveUserDefinition(...args),
    },
    serializeUserAgentDefinition: (definition: any) => ({
      id: definition.id,
      version: definition.version,
      name: definition.name,
      description: definition.description,
      instructions: definition.instructionAddendum || '',
      capabilityIds: definition.optionalCapabilityRefs?.length
        ? definition.optionalCapabilityRefs
        : definition.capabilityRefs,
      modelPreference: definition.modelPreference || null,
      resourceBehavior: definition.resourcePolicy?.sourceKinds?.includes('workspace_session')
        ? 'current_workspace_when_available'
        : 'chat_only',
      status: definition.status === 'archived' ? 'archived' : 'active',
    }),
  };
});

import { DELETE, GET, PATCH } from './route';
import { CustomAgentDefinitionServiceError } from 'server/services/agent/CustomAgentDefinitionService';

const sampleDefinition = {
  id: 'custom.sample-agent',
  version: 1,
  owner: { kind: 'user', userId: 'sample-user', organizationId: null },
  name: 'Sample agent',
  description: 'Helps with sample workflows.',
  instructionRefs: [],
  instructionAddendum: 'Answer with concise steps.',
  capabilityRefs: ['read_context'],
  requiredCapabilityRefs: [],
  optionalCapabilityRefs: ['read_context'],
  resourcePolicy: {
    sourceKinds: ['freeform_chat'],
    workspaceRequired: false,
    sandboxRequired: false,
  },
  modelPreference: null,
  status: 'active',
  codeOwned: false,
  readOnly: false,
};

const publicDefinition = {
  id: 'custom.sample-agent',
  version: 1,
  name: 'Sample agent',
  description: 'Helps with sample workflows.',
  instructions: 'Answer with concise steps.',
  capabilityIds: ['read_context'],
  modelPreference: null,
  resourceBehavior: 'chat_only',
  status: 'active',
};

function makeRequest(body?: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/definitions/custom.sample-agent'),
  } as unknown as NextRequest;
}

const params = { params: { definitionId: 'custom.sample-agent' } };

describe('/api/v2/ai/agent/definitions/[definitionId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetUserDefinition.mockResolvedValue(sampleDefinition);
    mockUpdateUserDefinition.mockResolvedValue({ ...sampleDefinition, version: 2 });
    mockArchiveUserDefinition.mockResolvedValue({ ...sampleDefinition, status: 'archived' });
  });

  it('GET returns 401 for unauthenticated requests', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await GET(makeRequest(), params);

    expect(response.status).toBe(401);
    expect(mockGetUserDefinition).not.toHaveBeenCalled();
  });

  it('GET returns 404 for non-owned or archived rows', async () => {
    mockGetUserDefinition.mockRejectedValueOnce(new CustomAgentDefinitionServiceError('not_found', 'Agent not found.'));

    const response = await GET(makeRequest(), params);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(mockGetUserDefinition).toHaveBeenCalledWith('custom.sample-agent', 'sample-user');
    expect(body.error.message).toBe('Agent not found.');
  });

  it('PATCH rejects ownerKind, ownerUserId, codeOwned, readOnly, and other unsupported fields', async () => {
    const response = await PATCH(
      makeRequest({
        name: 'Sample agent',
        instructions: 'Answer briefly.',
        resourceBehavior: 'chat_only',
        capabilityIds: ['read_context'],
        ownerKind: 'system',
        ownerUserId: 'other-user',
        codeOwned: true,
        readOnly: true,
        unsupportedField: true,
      }),
      params
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Unsupported agent definition fields');
    expect(mockUpdateUserDefinition).not.toHaveBeenCalled();
  });

  it('PATCH delegates normalized update input to CustomAgentDefinitionService', async () => {
    const response = await PATCH(
      makeRequest({
        name: 'Updated helper',
        description: 'Summarizes release notes.',
        instructions: 'Prefer bullets.',
        capabilityIds: ['read_context'],
        modelPreference: null,
        resourceBehavior: 'current_workspace_when_available',
      }),
      params
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mockUpdateUserDefinition).toHaveBeenCalledWith(
      'custom.sample-agent',
      expect.objectContaining({
        userId: 'sample-user',
        githubUsername: 'sample-user',
      }),
      {
        name: 'Updated helper',
        description: 'Summarizes release notes.',
        instructionAddendum: 'Prefer bullets.',
        capabilityRefs: ['read_context'],
        modelPreference: null,
        resourceBehavior: 'current_workspace_when_available',
      }
    );
    expect(body.data.definition).toEqual({
      ...publicDefinition,
      version: 2,
    });
  });

  it.each([
    ['unknown_capability', 'sample_unknown_capability'],
    ['admin_only', 'external_mcp_write'],
    ['system_only', 'approval_controls'],
    ['disabled', 'read_context'],
    ['source_incompatible', 'workspace_shell'],
  ])(
    'PATCH maps %s capability validation failures to deterministic sanitized 400 responses',
    async (code, capabilityId) => {
      mockUpdateUserDefinition.mockRejectedValueOnce(
        new CustomAgentDefinitionServiceError(
          code as any,
          'Some selected capabilities are no longer available. Review the list and save again.'
        )
      );

      const response = await PATCH(
        makeRequest({
          name: 'Sample agent',
          instructions: 'Answer briefly.',
          capabilityIds: [capabilityId],
          resourceBehavior: 'chat_only',
        }),
        params
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toBe(
        'Some selected capabilities are no longer available. Review the list and save again.'
      );
      expect(body.error.message).not.toContain(capabilityId);
      expect(body.error.message).not.toContain('mcp__');
      expect(body.error.message).not.toContain('toolKey');
      expect(body.error.message).not.toContain('serverSlug');
    }
  );

  it('PATCH maps creation policy denials to 403 with sanitized response messages', async () => {
    mockUpdateUserDefinition.mockRejectedValueOnce(
      new CustomAgentDefinitionServiceError(
        'creation_unavailable',
        'Custom agent creation is not available. Ask an admin for access.'
      )
    );

    const response = await PATCH(
      makeRequest({
        name: 'Sample agent',
        instructions: 'Answer briefly.',
        capabilityIds: ['read_context'],
        resourceBehavior: 'chat_only',
      }),
      params
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Custom agent creation is not available. Ask an admin for access.');
    expect(body.error.message).not.toContain('roles');
    expect(body.error.message).not.toContain('customAgentCreationPolicy');
  });

  it('DELETE archives the current user definition and returns archived state', async () => {
    const response = await DELETE(makeRequest(), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockArchiveUserDefinition).toHaveBeenCalledWith('custom.sample-agent', 'sample-user');
    expect(body.data).toEqual({
      archived: true,
      definition: { ...publicDefinition, status: 'archived' },
    });
  });
});
