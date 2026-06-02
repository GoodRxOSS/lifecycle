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

import { CustomAgentDefinitionService, CustomAgentDefinitionServiceError } from '../CustomAgentDefinitionService';

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

    expect(mockPatchAndFetchById).toHaveBeenCalledWith(4, { status: 'archived' });
    expect(archived.status).toBe('archived');
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
    ['source_incompatible', 'workspace_shell', undefined],
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
        capabilityRefs: ['workspace_shell'],
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

    expect(capabilities.map((capability) => capability.capabilityId)).toEqual(['read_context', 'external_mcp_read']);
    expect(capabilities.find((capability) => capability.capabilityId === 'external_mcp_write')).toBeUndefined();
    expect(capabilities.find((capability) => capability.capabilityId === 'approval_controls')).toBeUndefined();
    expect(capabilities.find((capability) => capability.capabilityId === 'workspace_shell')).toBeUndefined();
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
          requiresWorkspace: true,
          toolCount: 1,
          resourceCount: 1,
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
