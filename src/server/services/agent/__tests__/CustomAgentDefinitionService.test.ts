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

const mockFindOne = jest.fn();
const mockInsert = jest.fn();
const mockOrderBy = jest.fn();
const mockPatchAndFetchById = jest.fn();
const mockWhere = jest.fn();
const mockGetEffectiveConfig = jest.fn();
const mockListAvailableModelsForUser = jest.fn();

jest.mock('server/models/AgentDefinition', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => ({
      findOne: (...args: unknown[]) => mockFindOne(...args),
      insert: (...args: unknown[]) => mockInsert(...args),
      patchAndFetchById: (...args: unknown[]) => mockPatchAndFetchById(...args),
      where: (...args: unknown[]) => {
        mockWhere(...args);
        return {
          orderBy: (...orderArgs: unknown[]) => mockOrderBy(...orderArgs),
        };
      },
    })),
  },
}));

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getEffectiveConfig: (...args: unknown[]) => mockGetEffectiveConfig(...args),
    })),
  },
}));

jest.mock('server/services/agent/ProviderRegistry', () => ({
  __esModule: true,
  default: {
    listAvailableModelsForUser: (...args: unknown[]) => mockListAvailableModelsForUser(...args),
  },
}));

import {
  customAgentDefinitionNeedsOneAgentConversion,
  CustomAgentDefinitionService,
  CustomAgentDefinitionServiceError,
  serializeUserAgentDefinition,
} from '../CustomAgentDefinitionService';

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    definitionId: 'custom.sample-agent',
    version: 1,
    ownerKind: 'user',
    ownerUserId: 'sample-user',
    ownerOrganizationId: null,
    name: 'Sample agent',
    description: 'Helps with sample workflows',
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
    updatedAt: '2026-05-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('CustomAgentDefinitionService', () => {
  const service = new CustomAgentDefinitionService();
  const userIdentity = { userId: 'sample-user', githubUsername: 'sample-user' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEffectiveConfig.mockResolvedValue({ capabilityPolicy: undefined });
    mockListAvailableModelsForUser.mockResolvedValue([
      {
        provider: 'openai',
        modelId: 'sample-model',
        displayName: 'Sample model',
        default: true,
        maxTokens: 4096,
      },
    ]);
  });

  it('listUserDefinitions returns only active rows for the owner newest first', async () => {
    mockOrderBy.mockResolvedValue([
      buildRow({
        id: 2,
        definitionId: 'custom.newest',
        name: 'Newest',
        updatedAt: '2026-05-01T13:00:00.000Z',
      }),
      buildRow({
        id: 1,
        definitionId: 'custom.oldest',
        name: 'Oldest',
        updatedAt: '2026-05-01T12:00:00.000Z',
      }),
    ]);

    const definitions = await service.listUserDefinitions({ userId: 'sample-user' });

    expect(mockWhere).toHaveBeenCalledWith({
      ownerKind: 'user',
      ownerUserId: 'sample-user',
      status: 'active',
    });
    expect(mockOrderBy).toHaveBeenCalledWith('updatedAt', 'desc');
    expect(definitions.map((definition) => definition.id)).toEqual(['custom.newest', 'custom.oldest']);
  });

  it('listUserDefinitions forwards an explicit disabled-status filter', async () => {
    mockOrderBy.mockResolvedValue([buildRow({ definitionId: 'custom.disabled', status: 'disabled' })]);

    const definitions = await service.listUserDefinitions({
      userId: 'sample-user',
      filters: { status: 'disabled' },
    });

    expect(mockWhere).toHaveBeenCalledWith({
      ownerKind: 'user',
      ownerUserId: 'sample-user',
      status: 'disabled',
    });
    expect(mockOrderBy).toHaveBeenCalledWith('updatedAt', 'desc');
    expect(definitions).toEqual([expect.objectContaining({ id: 'custom.disabled', status: 'disabled' })]);
  });

  it('getUserDefinition returns the active definition owned by the caller', async () => {
    mockFindOne.mockResolvedValue(buildRow({ id: 12, definitionId: 'custom.owned' }));

    const definition = await service.getUserDefinition('custom.owned', 'sample-user');

    expect(mockFindOne).toHaveBeenCalledWith({
      definitionId: 'custom.owned',
      ownerKind: 'user',
      ownerUserId: 'sample-user',
      status: 'active',
    });
    expect(definition).toEqual(
      expect.objectContaining({
        id: 'custom.owned',
        owner: { kind: 'user', userId: 'sample-user', organizationId: null },
      })
    );
  });

  it('getUserDefinition returns not found for another user, an archived row, or a system row', async () => {
    mockFindOne.mockResolvedValue(null);

    await expect(service.getUserDefinition('custom.other-user', 'sample-user')).rejects.toMatchObject({
      reason: 'not_found',
    });
    await expect(service.getUserDefinition('custom.archived', 'sample-user')).rejects.toBeInstanceOf(
      CustomAgentDefinitionServiceError
    );
    await expect(service.getUserDefinition('system.freeform', 'sample-user')).rejects.toMatchObject({
      reason: 'not_found',
    });
    await expect(service.getUserDefinition('system.debug', 'sample-user')).rejects.toMatchObject({
      reason: 'not_found',
    });

    expect(mockFindOne).toHaveBeenCalledWith({
      definitionId: 'custom.other-user',
      ownerKind: 'user',
      ownerUserId: 'sample-user',
      status: 'active',
    });
  });

  it('create and update trim fields, dedupe capabilities, increment version, and ignore codeOwned/readOnly input', async () => {
    mockInsert.mockImplementation(async (row) => buildRow({ id: 3, ...row }));
    mockFindOne.mockResolvedValue(buildRow({ id: 3, version: 2 }));
    mockPatchAndFetchById.mockImplementation(async (_id, patch) => buildRow({ id: 3, version: 3, ...patch }));

    const created = await service.createUserDefinition(userIdentity, {
      name: '  Release helper  ',
      description: '  Summarizes release notes.  ',
      instructionAddendum: '  Keep the response brief.  ',
      capabilityRefs: ['read_context', 'read_context'],
      resourceBehavior: 'chat_only',
      codeOwned: true,
      readOnly: true,
    } as any);

    expect(created).toEqual(
      expect.objectContaining({
        owner: { kind: 'user', userId: 'sample-user', organizationId: null },
        name: 'Release helper',
        description: 'Summarizes release notes.',
        instructionAddendum: 'Keep the response brief.',
        capabilityRefs: ['read_context'],
        optionalCapabilityRefs: ['read_context'],
        codeOwned: false,
        readOnly: false,
      })
    );
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        definitionId: expect.stringMatching(/^custom\./),
        ownerKind: 'user',
        ownerUserId: 'sample-user',
        ownerOrganizationId: null,
        codeOwned: false,
        readOnly: false,
      })
    );

    await service.updateUserDefinition('custom.sample-agent', userIdentity, {
      name: '  Updated helper  ',
      description: '  ',
      instructionAddendum: '  Prefer bullets.  ',
      capabilityRefs: ['read_context'],
      resourceBehavior: 'current_workspace_when_available',
      codeOwned: true,
      readOnly: true,
    } as any);

    expect(mockPatchAndFetchById).toHaveBeenCalledWith(
      3,
      expect.objectContaining({
        version: 3,
        name: 'Updated helper',
        description: null,
        instructionAddendum: 'Prefer bullets.',
        codeOwned: false,
        readOnly: false,
      })
    );
  });

  it.each([
    {
      fieldName: 'Name',
      input: {
        name: '   ',
        instructionAddendum: 'Answer briefly.',
        resourceBehavior: 'chat_only' as const,
      },
    },
    {
      fieldName: 'Instructions',
      input: {
        name: 'Sample agent',
        instructionAddendum: '\n\t ',
        resourceBehavior: 'chat_only' as const,
      },
    },
  ])('rejects a blank $fieldName before configuration or persistence calls', async ({ fieldName, input }) => {
    await expect(service.createUserDefinition(userIdentity, input)).rejects.toMatchObject({
      name: 'CustomAgentDefinitionServiceError',
      reason: 'invalid_input',
      httpStatus: 400,
      code: 'custom_agent_invalid',
      details: { reason: 'invalid_input' },
      message: `${fieldName} is required.`,
    });

    expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
    expect(mockListAvailableModelsForUser).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('normalizes omitted capabilities and blank model fields before persistence', async () => {
    mockInsert.mockImplementation(async (row) => buildRow({ id: 13, ...row }));

    const definition = await service.createUserDefinition(userIdentity, {
      name: '  Minimal helper  ',
      instructionAddendum: '  Answer briefly.  ',
      modelPreference: { provider: '  ', model: '\t' },
      resourceBehavior: 'chat_only',
    });

    expect(mockListAvailableModelsForUser).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Minimal helper',
        description: null,
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: [],
        requiredCapabilityRefs: [],
        optionalCapabilityRefs: [],
        modelPreference: null,
      })
    );
    expect(definition).toEqual(
      expect.objectContaining({
        capabilityRefs: [],
        optionalCapabilityRefs: [],
        modelPreference: null,
      })
    );
  });

  it.each([
    {
      selection: 'provider only',
      modelPreference: { provider: ' openai ', model: '   ' },
      expected: { provider: 'openai', model: null },
    },
    {
      selection: 'model only',
      modelPreference: { provider: '\t', model: ' sample-model ' },
      expected: { provider: null, model: 'sample-model' },
    },
  ])('normalizes and persists an available $selection model preference', async ({ modelPreference, expected }) => {
    mockInsert.mockImplementation(async (row) => buildRow({ id: 14, ...row }));

    await service.createUserDefinition(userIdentity, {
      name: 'Model helper',
      instructionAddendum: 'Answer briefly.',
      modelPreference,
      resourceBehavior: 'chat_only',
    });

    expect(mockListAvailableModelsForUser).toHaveBeenCalledWith({ userIdentity });
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ modelPreference: expected }));
  });

  it('keeps crafted system-definition fields out of user create and update persistence', async () => {
    mockInsert.mockImplementation(async (row) => buildRow({ id: 10, ...row }));
    mockFindOne.mockResolvedValue(buildRow({ id: 10, version: 4 }));
    mockPatchAndFetchById.mockImplementation(async (_id, patch) => buildRow({ id: 10, version: 5, ...patch }));

    await service.createUserDefinition(userIdentity, {
      definitionId: 'system.debug',
      ownerKind: 'system',
      instructionRefs: ['system:debug'],
      requiredCapabilityRefs: ['github_write'],
      codeOwned: true,
      readOnly: true,
      name: '  Crafted Debug  ',
      description: '  Tries to edit Debug.  ',
      instructionAddendum: '  Behave normally.  ',
      capabilityRefs: ['read_context'],
      resourceBehavior: 'chat_only',
    } as any);

    const inserted = mockInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).toEqual(
      expect.objectContaining({
        definitionId: expect.stringMatching(/^custom\./),
        ownerKind: 'user',
        ownerUserId: 'sample-user',
        instructionRefs: [],
        requiredCapabilityRefs: [],
        optionalCapabilityRefs: ['read_context'],
        codeOwned: false,
        readOnly: false,
      })
    );
    expect(inserted.definitionId).not.toBe('system.debug');

    await service.updateUserDefinition('custom.sample-agent', userIdentity, {
      definitionId: 'system.debug',
      ownerKind: 'system',
      instructionRefs: ['system:debug'],
      requiredCapabilityRefs: ['github_write'],
      codeOwned: true,
      readOnly: true,
      name: '  Updated helper  ',
      instructionAddendum: '  Prefer short answers.  ',
      capabilityRefs: ['read_context'],
      resourceBehavior: 'chat_only',
    } as any);

    const patch = mockPatchAndFetchById.mock.calls[0][1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('definitionId');
    expect(patch).not.toHaveProperty('ownerKind');
    expect(patch).not.toHaveProperty('instructionRefs');
    expect(patch.requiredCapabilityRefs).toEqual([]);
    expect(patch.codeOwned).toBe(false);
    expect(patch.readOnly).toBe(false);
  });

  it('archiveUserDefinition changes status to archived and keeps the row', async () => {
    mockFindOne.mockResolvedValue(buildRow({ id: 4, definitionId: 'custom.to-archive' }));
    mockPatchAndFetchById.mockResolvedValue(buildRow({ id: 4, definitionId: 'custom.to-archive', status: 'archived' }));

    const archived = await service.archiveUserDefinition('custom.to-archive', 'sample-user');

    expect(mockFindOne).toHaveBeenCalledWith({
      definitionId: 'custom.to-archive',
      ownerKind: 'user',
      ownerUserId: 'sample-user',
      status: 'active',
    });
    expect(mockPatchAndFetchById).toHaveBeenCalledWith(4, { status: 'archived' });
    expect(archived.status).toBe('archived');
  });

  it('stops an update before validation and persistence when the owned active row is missing', async () => {
    mockFindOne.mockResolvedValue(null);

    await expect(
      service.updateUserDefinition('custom.missing', userIdentity, {
        name: 'Updated agent',
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: ['read_context'],
        resourceBehavior: 'chat_only',
      })
    ).rejects.toMatchObject({
      reason: 'not_found',
      httpStatus: 404,
      code: 'custom_agent_not_found',
      details: { reason: 'not_found' },
    });

    expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
    expect(mockListAvailableModelsForUser).not.toHaveBeenCalled();
    expect(mockPatchAndFetchById).not.toHaveBeenCalled();
  });

  it('propagates persistence failures from create without attempting another write', async () => {
    const databaseError = new Error('database insert failed');
    mockInsert.mockRejectedValue(databaseError);

    await expect(
      service.createUserDefinition(userIdentity, {
        name: 'Sample agent',
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: ['read_context'],
        resourceBehavior: 'chat_only',
      })
    ).rejects.toBe(databaseError);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockPatchAndFetchById).not.toHaveBeenCalled();
  });

  it('rejects unknown capability ids before persistence', async () => {
    await expect(
      service.createUserDefinition(userIdentity, {
        name: 'Sample agent',
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: ['read_context', 'sample_unknown_capability' as any],
        resourceBehavior: 'chat_only',
      })
    ).rejects.toMatchObject({
      reason: 'unknown_capability',
      message: 'Some selected capabilities are no longer available. Review the list and save again.',
    });

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each([
    ['admin_only', 'external_mcp_write', undefined],
    ['system_only', 'approval_controls', undefined],
    ['disabled', 'read_context', { availability: { read_context: 'disabled' } }],
  ])('rejects %s capabilities for user-owned definitions', async (reason, capabilityId, capabilityPolicy) => {
    mockGetEffectiveConfig.mockResolvedValueOnce({ capabilityPolicy });

    await expect(
      service.createUserDefinition(userIdentity, {
        name: 'Sample agent',
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: [capabilityId as any],
        resourceBehavior: 'chat_only',
      })
    ).rejects.toMatchObject({
      reason: reason,
      message: 'Some selected capabilities are no longer available. Review the list and save again.',
    });

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown_capability', 'sample_unknown_capability', undefined],
    ['admin_only', 'external_mcp_write', undefined],
    ['system_only', 'approval_controls', undefined],
    ['disabled', 'read_context', { availability: { read_context: 'disabled' } }],
    ['source_incompatible', 'github_read', undefined],
  ])(
    'rejects update payloads with %s capabilities without persistence',
    async (reason, capabilityId, capabilityPolicy) => {
      mockFindOne.mockResolvedValue(
        buildRow({
          id: 5,
          version: 7,
          capabilityRefs: ['external_mcp_write'],
          optionalCapabilityRefs: ['external_mcp_write'],
        })
      );
      mockGetEffectiveConfig.mockResolvedValueOnce({ capabilityPolicy });

      await expect(
        service.updateUserDefinition('custom.sample-agent', userIdentity, {
          name: 'Sample agent',
          instructionAddendum: 'Answer briefly.',
          capabilityRefs: [capabilityId as any],
          resourceBehavior: 'chat_only',
        })
      ).rejects.toMatchObject({
        reason: reason,
        message: 'Some selected capabilities are no longer available. Review the list and save again.',
      });

      expect(mockPatchAndFetchById).not.toHaveBeenCalled();
    }
  );

  it('replaces stale stored restricted capability selections during allowed updates', async () => {
    mockFindOne.mockResolvedValue(
      buildRow({
        id: 6,
        version: 2,
        capabilityRefs: ['external_mcp_write'],
        optionalCapabilityRefs: ['external_mcp_write'],
      })
    );
    mockPatchAndFetchById.mockImplementation(async (_id, patch) => buildRow({ id: 6, version: 3, ...patch }));

    await service.updateUserDefinition('custom.sample-agent', userIdentity, {
      name: 'Sample agent',
      instructionAddendum: 'Answer briefly.',
      capabilityRefs: ['read_context'],
      resourceBehavior: 'chat_only',
    });

    expect(mockPatchAndFetchById).toHaveBeenCalledWith(
      6,
      expect.objectContaining({
        capabilityRefs: ['read_context'],
        optionalCapabilityRefs: ['read_context'],
      })
    );
    expect(JSON.stringify(mockPatchAndFetchById.mock.calls[0][1])).not.toContain('external_mcp_write');
  });

  it('rejects source-incompatible required capabilities for chat_only custom agents', async () => {
    await expect(
      service.createUserDefinition(userIdentity, {
        name: 'Sample agent',
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: ['github_read'],
        resourceBehavior: 'chat_only',
      })
    ).rejects.toMatchObject({
      reason: 'source_incompatible',
      message: 'Some selected capabilities are no longer available. Review the list and save again.',
    });
  });

  it.each([
    ['disabled', { mode: 'disabled' }],
    ['admins_only', { mode: 'admins_only' }],
    ['allowlist', { mode: 'allowlist', allowedUserIds: ['other-user'] }],
  ])(
    'rejects create when custom-agent creation policy is %s for the caller',
    async (_label, customAgentCreationPolicy) => {
      mockGetEffectiveConfig.mockResolvedValueOnce({ customAgentCreationPolicy });

      await expect(
        service.createUserDefinition(userIdentity, {
          name: 'Sample agent',
          instructionAddendum: 'Answer briefly.',
          capabilityRefs: ['read_context'],
          resourceBehavior: 'chat_only',
        })
      ).rejects.toMatchObject({
        reason: 'creation_unavailable',
        message: 'Custom agent creation is not available. Ask an admin for access.',
      });

      expect(mockInsert).not.toHaveBeenCalled();
    }
  );

  it('allows admin-role and allowlisted creators when creation policy is restricted', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      customAgentCreationPolicy: { mode: 'admins_only' },
    });
    mockInsert.mockImplementationOnce(async (row) => buildRow({ id: 7, ...row }));

    await expect(
      service.createUserDefinition(
        { ...userIdentity, roles: ['admin'] },
        {
          name: 'Sample agent',
          instructionAddendum: 'Answer briefly.',
          capabilityRefs: ['read_context'],
          resourceBehavior: 'chat_only',
        }
      )
    ).resolves.toMatchObject({ id: expect.stringMatching(/^custom\./) });

    mockGetEffectiveConfig.mockResolvedValueOnce({
      customAgentCreationPolicy: {
        mode: 'allowlist',
        allowedGithubUsernames: ['SAMPLE-USER'],
      },
    });
    mockInsert.mockImplementationOnce(async (row) => buildRow({ id: 8, ...row }));

    await expect(
      service.createUserDefinition(userIdentity, {
        name: 'Allowlisted agent',
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: ['read_context'],
        resourceBehavior: 'chat_only',
      })
    ).resolves.toMatchObject({ name: 'Allowlisted agent' });
  });

  it('normalizes configured user-id allowlist entries before authorizing creation', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      customAgentCreationPolicy: {
        mode: 'allowlist',
        allowedUserIds: ['  ', ' sample-user '],
      },
    });
    mockInsert.mockImplementationOnce(async (row) => buildRow({ id: 15, ...row }));

    await expect(
      service.createUserDefinition(
        { ...userIdentity, githubUsername: null },
        {
          name: 'Allowlisted by ID',
          instructionAddendum: 'Answer briefly.',
          capabilityRefs: ['read_context'],
          resourceBehavior: 'chat_only',
        }
      )
    ).resolves.toMatchObject({ name: 'Allowlisted by ID' });

    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('reports current-user custom-agent creation status from policy', async () => {
    await expect(
      service.getUserDefinitionCreationStatus({ userIdentity: { ...userIdentity, roles: [] } as any })
    ).resolves.toEqual({
      canCreate: true,
      creationUnavailableReason: null,
    });

    mockGetEffectiveConfig.mockResolvedValueOnce({
      customAgentCreationPolicy: { mode: 'disabled' },
    });

    await expect(
      service.getUserDefinitionCreationStatus({ userIdentity: { ...userIdentity, roles: [] } as any })
    ).resolves.toEqual({
      canCreate: false,
      creationUnavailableReason: 'creation_disabled',
    });

    mockGetEffectiveConfig.mockResolvedValueOnce({
      customAgentCreationPolicy: { mode: 'allowlist', allowedUserIds: ['other-user'] },
    });

    await expect(
      service.getUserDefinitionCreationStatus({ userIdentity: { ...userIdentity, roles: [] } as any })
    ).resolves.toEqual({
      canCreate: false,
      creationUnavailableReason: 'creation_restricted',
    });
  });

  it('rejects update when custom-agent creation policy no longer allows the caller', async () => {
    mockFindOne.mockResolvedValue(buildRow({ id: 9, version: 3 }));
    mockGetEffectiveConfig.mockResolvedValueOnce({
      customAgentCreationPolicy: { mode: 'allowlist', allowedUserIds: ['other-user'] },
    });

    await expect(
      service.updateUserDefinition('custom.sample-agent', userIdentity, {
        name: 'Sample agent',
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: ['read_context'],
        resourceBehavior: 'chat_only',
      })
    ).rejects.toMatchObject({
      reason: 'creation_unavailable',
    });

    expect(mockPatchAndFetchById).not.toHaveBeenCalled();
  });

  it('hides and rejects creator-reserved capabilities separately from runtime availability', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      capabilityPolicy: {
        availability: {
          external_mcp_write: 'all_users',
        },
      },
      customAgentCreationPolicy: {
        capabilityAvailability: {
          external_mcp_write: 'reserved',
        },
      },
    });

    const capabilities = await service.listUserSelectableCapabilities({
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user', roles: [] } as any,
      resourceBehavior: 'chat_only',
    });

    expect(capabilities.find((capability) => capability.capabilityId === 'external_mcp_write')).toBeUndefined();

    mockGetEffectiveConfig.mockResolvedValueOnce({
      capabilityPolicy: {
        availability: {
          external_mcp_write: 'all_users',
        },
      },
      customAgentCreationPolicy: {
        capabilityAvailability: {
          external_mcp_write: 'reserved',
        },
      },
    });

    await expect(
      service.createUserDefinition(userIdentity, {
        name: 'Sample agent',
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: ['external_mcp_write'],
        resourceBehavior: 'chat_only',
      })
    ).rejects.toMatchObject({
      reason: 'creator_capability_reserved',
      message: 'Some selected capabilities are no longer available. Review the list and save again.',
    });

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects unavailable modelPreference selections with model_unavailable', async () => {
    await expect(
      service.createUserDefinition(userIdentity, {
        name: 'Sample agent',
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: ['read_context'],
        modelPreference: { provider: 'internal-provider', model: 'internal-model' },
        resourceBehavior: 'chat_only',
      })
    ).rejects.toMatchObject({
      reason: 'model_unavailable',
      httpStatus: 409,
      code: 'custom_agent_conflict',
      details: { reason: 'model_unavailable' },
      message: 'Selected model is no longer available. Choose another model and save again.',
    });
    expect(mockListAvailableModelsForUser).toHaveBeenCalledWith({ userIdentity });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('sanitizes validation errors without raw tool keys, toolKey fields, serverSlug values, or internal path details', async () => {
    try {
      await service.createUserDefinition(userIdentity, {
        name: 'Sample agent',
        instructionAddendum: 'Answer briefly.',
        capabilityRefs: ['external_mcp_write'],
        resourceBehavior: 'chat_only',
      });
      throw new Error('Expected create to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CustomAgentDefinitionServiceError);
      expect((error as Error).message).toBe(
        'Some selected capabilities are no longer available. Review the list and save again.'
      );
      expect((error as Error).message).not.toContain('external_mcp_write');
      expect((error as Error).message).not.toContain('workspace.exec');
      expect((error as Error).message).not.toContain('toolKey');
      expect((error as Error).message).not.toContain('serverSlug');
      expect((error as Error).message).not.toContain('/internal/path');
    }
  });

  it('listUserSelectableCapabilities returns only user-visible chat capabilities', async () => {
    const capabilities = await service.listUserSelectableCapabilities({
      userIdentity: { userId: 'sample-user' } as any,
      resourceBehavior: 'chat_only',
    });

    expect(capabilities.map((capability) => capability.capabilityId)).toEqual([
      'read_context',
      'workspace_files',
      'workspace_shell',
      'workspace_git',
      'network_access',
      'preview_publish',
      'external_mcp_read',
    ]);
    expect(capabilities.find((capability) => capability.capabilityId === 'external_mcp_write')).toBeUndefined();
    expect(capabilities.find((capability) => capability.capabilityId === 'approval_controls')).toBeUndefined();
    expect(capabilities.find((capability) => capability.capabilityId === 'github_read')).toBeUndefined();
    expect(JSON.stringify(capabilities)).not.toContain('workspace.exec');
    expect(JSON.stringify(capabilities)).not.toContain('toolKey');
    expect(JSON.stringify(capabilities)).not.toContain('serverSlug');
  });

  it('listUserSelectableCapabilities includes workspace flags and hides disabled capabilities', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      capabilityPolicy: {
        availability: {
          read_context: 'disabled',
        },
      },
    });

    const capabilities = await service.listUserSelectableCapabilities({
      userIdentity: { userId: 'sample-user' } as any,
      resourceBehavior: 'current_workspace_when_available',
    });

    expect(capabilities.find((capability) => capability.capabilityId === 'read_context')).toBeUndefined();
    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: 'workspace_shell',
          // Workspace tools are chat-selectable now that chats can request a workspace on demand.
          requiresWorkspace: false,
          toolCount: 6,
          resourceCount: 1,
        }),
        expect.objectContaining({
          capabilityId: 'github_read',
          requiresWorkspace: true,
        }),
      ])
    );
  });

  it('listUserSelectableCapabilities returns empty inventory when creation is disabled for the caller', async () => {
    mockGetEffectiveConfig.mockResolvedValueOnce({
      customAgentCreationPolicy: { mode: 'disabled' },
    });

    const capabilities = await service.listUserSelectableCapabilities({
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user', roles: [] } as any,
      resourceBehavior: 'current_workspace_when_available',
    });

    expect(capabilities).toEqual([]);
  });
});

describe('custom-agent public contract helpers', () => {
  const baseDefinition = {
    id: 'custom.sample-agent',
    version: 3,
    owner: { kind: 'user' as const, userId: 'sample-user', organizationId: null },
    name: 'Sample agent',
    description: 'Sample description',
    instructionRefs: [],
    instructionAddendum: 'Answer briefly.',
    capabilityRefs: ['read_context' as const],
    requiredCapabilityRefs: [],
    optionalCapabilityRefs: ['workspace_shell' as const],
    resourcePolicy: {
      sourceKinds: ['freeform_chat'],
      workspaceRequired: false,
      sandboxRequired: false,
    },
    modelPreference: null,
    status: 'active' as const,
    codeOwned: false,
    readOnly: false,
  };

  it('serializes selected optional capabilities and workspace behavior for an archived definition', () => {
    const result = serializeUserAgentDefinition({
      ...baseDefinition,
      description: '',
      instructionAddendum: null,
      resourcePolicy: {
        sourceKinds: ['freeform_chat', 'workspace_session'],
        workspaceRequired: false,
        sandboxRequired: false,
      },
      modelPreference: { provider: 'openai', model: 'sample-model' },
      status: 'archived',
    });

    expect(result).toEqual({
      id: 'custom.sample-agent',
      version: 3,
      name: 'Sample agent',
      description: null,
      instructions: '',
      capabilityIds: ['workspace_shell'],
      modelPreference: { provider: 'openai', model: 'sample-model' },
      resourceBehavior: 'current_workspace_when_available',
      status: 'archived',
    });
  });

  it('falls back to required fields when optional public-contract fields are absent', () => {
    const result = serializeUserAgentDefinition({
      ...baseDefinition,
      description: undefined,
      instructionAddendum: undefined,
      optionalCapabilityRefs: undefined,
      modelPreference: undefined,
      status: 'disabled',
    });

    expect(result).toEqual({
      id: 'custom.sample-agent',
      version: 3,
      name: 'Sample agent',
      description: null,
      instructions: '',
      capabilityIds: ['read_context'],
      modelPreference: null,
      resourceBehavior: 'chat_only',
      status: 'active',
    });
  });

  it.each([
    {
      caseName: 'non-user ownership',
      definition: {
        ...baseDefinition,
        owner: { kind: 'admin' as const },
        resourcePolicy: { sourceKinds: ['workspace_session'], workspaceRequired: true, sandboxRequired: true },
      },
      expected: false,
    },
    {
      caseName: 'required workspace',
      definition: {
        ...baseDefinition,
        resourcePolicy: { sourceKinds: ['freeform_chat'], workspaceRequired: true, sandboxRequired: false },
      },
      expected: true,
    },
    {
      caseName: 'required sandbox',
      definition: {
        ...baseDefinition,
        resourcePolicy: { sourceKinds: ['freeform_chat'], workspaceRequired: false, sandboxRequired: true },
      },
      expected: true,
    },
    {
      caseName: 'workspace-only source',
      definition: {
        ...baseDefinition,
        resourcePolicy: { sourceKinds: ['workspace_session'], workspaceRequired: false, sandboxRequired: false },
      },
      expected: true,
    },
    {
      caseName: 'workspace-capable freeform source',
      definition: {
        ...baseDefinition,
        resourcePolicy: {
          sourceKinds: ['freeform_chat', 'workspace_session'],
          workspaceRequired: false,
          sandboxRequired: false,
        },
      },
      expected: false,
    },
    {
      caseName: 'chat-only source',
      definition: baseDefinition,
      expected: false,
    },
  ])('reports one-agent conversion as $expected for $caseName', ({ definition, expected }) => {
    expect(customAgentDefinitionNeedsOneAgentConversion(definition)).toBe(expected);
  });
});
