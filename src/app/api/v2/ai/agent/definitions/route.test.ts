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
const mockListUserDefinitions = jest.fn();
const mockCreateUserDefinition = jest.fn();

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
      listUserDefinitions: (...args: unknown[]) => mockListUserDefinitions(...args),
      createUserDefinition: (...args: unknown[]) => mockCreateUserDefinition(...args),
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

import { GET, POST } from './route';
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
    nextUrl: new URL('http://localhost/api/v2/ai/agent/definitions'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/definitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      roles: ['user'],
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockListUserDefinitions.mockResolvedValue([sampleDefinition]);
    mockCreateUserDefinition.mockResolvedValue(sampleDefinition);
  });

  it('GET returns 401 for unauthenticated requests', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(mockListUserDefinitions).not.toHaveBeenCalled();
  });

  it('GET returns only current-user custom agents through the service', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListUserDefinitions).toHaveBeenCalledWith({ userId: 'sample-user' });
    expect(body.data).toEqual({ definitions: [publicDefinition] });
    expect(JSON.stringify(body.data)).not.toContain('sample-user');
    expect(JSON.stringify(body.data)).not.toContain('other-user');
  });

  it('POST rejects ownerKind, ownerUserId, codeOwned, readOnly, and other unsupported fields', async () => {
    const response = await POST(
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
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Unsupported agent definition fields');
    expect(mockCreateUserDefinition).not.toHaveBeenCalled();
  });

  it('POST delegates normalized create input to CustomAgentDefinitionService', async () => {
    const response = await POST(
      makeRequest({
        name: ' Release helper ',
        description: ' Summarizes release notes. ',
        instructions: ' Keep the response brief. ',
        capabilityIds: ['read_context'],
        modelPreference: { provider: 'openai', model: 'sample-model' },
        resourceBehavior: 'chat_only',
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(mockCreateUserDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sample-user',
        githubUsername: 'sample-user',
      }),
      {
        name: ' Release helper ',
        description: ' Summarizes release notes. ',
        instructionAddendum: ' Keep the response brief. ',
        capabilityRefs: ['read_context'],
        modelPreference: { provider: 'openai', model: 'sample-model' },
        resourceBehavior: 'chat_only',
      }
    );
    expect(body.data.definition).toEqual(publicDefinition);
  });

  it.each([
    ['unknown_capability', 'sample_unknown_capability'],
    ['admin_only', 'external_mcp_write'],
    ['system_only', 'approval_controls'],
    ['disabled', 'read_context'],
    ['source_incompatible', 'workspace_shell'],
  ])(
    'POST maps %s capability validation errors to 400 with sanitized response messages',
    async (code, capabilityId) => {
      mockCreateUserDefinition.mockRejectedValueOnce(
        new CustomAgentDefinitionServiceError(
          code as any,
          'Some selected capabilities are no longer available. Review the list and save again.'
        )
      );

      const response = await POST(
        makeRequest({
          name: 'Sample agent',
          instructions: 'Answer briefly.',
          capabilityIds: [capabilityId],
          resourceBehavior: 'chat_only',
        })
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

  it('POST maps unavailable model errors to 409 with sanitized response messages', async () => {
    mockCreateUserDefinition.mockRejectedValueOnce(
      new CustomAgentDefinitionServiceError('model_unavailable', 'Selected model is unavailable. Choose another model.')
    );

    const response = await POST(
      makeRequest({
        name: 'Sample agent',
        instructions: 'Answer briefly.',
        modelPreference: { provider: 'internal-provider', model: 'internal-model' },
        resourceBehavior: 'chat_only',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Selected model is unavailable. Choose another model.');
    expect(body.error.message).not.toContain('internal-provider');
    expect(body.error.message).not.toContain('internal-model');
  });

  it('POST maps creation policy denials to 403 with sanitized response messages', async () => {
    mockCreateUserDefinition.mockRejectedValueOnce(
      new CustomAgentDefinitionServiceError(
        'creation_unavailable',
        'Custom agent creation is not available. Ask an admin for access.'
      )
    );

    const response = await POST(
      makeRequest({
        name: 'Sample agent',
        instructions: 'Answer briefly.',
        capabilityIds: ['read_context'],
        resourceBehavior: 'chat_only',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Custom agent creation is not available. Ask an admin for access.');
    expect(body.error.message).not.toContain('roles');
    expect(body.error.message).not.toContain('customAgentCreationPolicy');
  });
});
