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

const mockGetOwnedThreadWithSession = jest.fn();
const mockGetSelectedAgentDefinitionId = jest.fn();
const mockGetRuntimeControlChoices = jest.fn();
const mockPatchRuntimeControlChoices = jest.fn();
const mockBuildSelectedAgentDefinitionMetadataPatch = jest.fn();
const mockGetSessionSource = jest.fn();
const mockResolveSessionContext = jest.fn();
const mockHasActiveRun = jest.fn();
const mockEnsureSeeded = jest.fn();
const mockGetSystemAgentDefinition = jest.fn();
const mockInferDefaultAgentDefinitionId = jest.fn();
const mockListUserDefinitions = jest.fn();
const mockGetUserDefinition = jest.fn();
const mockListEnabledConnectionsForUser = jest.fn();
const mockGetEffectiveConfig = jest.fn();

jest.mock('../ThreadService', () => ({
  __esModule: true,
  default: {
    getOwnedThreadWithSession: (...args: unknown[]) => mockGetOwnedThreadWithSession(...args),
    getSelectedAgentDefinitionId: (...args: unknown[]) => mockGetSelectedAgentDefinitionId(...args),
    getRuntimeControlChoices: (...args: unknown[]) => mockGetRuntimeControlChoices(...args),
    patchRuntimeControlChoices: (...args: unknown[]) => mockPatchRuntimeControlChoices(...args),
    buildSelectedAgentDefinitionMetadataPatch: (...args: unknown[]) =>
      mockBuildSelectedAgentDefinitionMetadataPatch(...args),
  },
}));

jest.mock('../SourceService', () => ({
  __esModule: true,
  default: {
    getSessionSource: (...args: unknown[]) => mockGetSessionSource(...args),
  },
}));

jest.mock('../CapabilityService', () => ({
  __esModule: true,
  default: {
    resolveSessionContext: (...args: unknown[]) => mockResolveSessionContext(...args),
  },
}));

jest.mock('../RunService', () => ({
  __esModule: true,
  default: {
    hasActiveRun: (...args: unknown[]) => mockHasActiveRun(...args),
  },
}));

jest.mock('../AgentDefinitionRegistry', () => {
  const actual = jest.requireActual('../AgentDefinitionRegistry');
  return {
    __esModule: true,
    ...actual,
    ensureSystemAgentDefinitionsSeeded: (...args: unknown[]) => mockEnsureSeeded(...args),
    getSystemAgentDefinition: (...args: unknown[]) => mockGetSystemAgentDefinition(...args),
    inferDefaultSystemAgentDefinitionId: (...args: unknown[]) => mockInferDefaultAgentDefinitionId(...args),
  };
});

jest.mock('../CustomAgentDefinitionService', () => ({
  __esModule: true,
  customAgentDefinitionService: {
    listUserDefinitions: (...args: unknown[]) => mockListUserDefinitions(...args),
    getUserDefinition: (...args: unknown[]) => mockGetUserDefinition(...args),
  },
}));

jest.mock('server/services/agentRuntime/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    listEnabledConnectionsForUser: (...args: unknown[]) => mockListEnabledConnectionsForUser(...args),
  })),
}));

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getEffectiveConfig: (...args: unknown[]) => mockGetEffectiveConfig(...args),
    })),
  },
}));

import AgentThreadRuntimeControlsService, { AgentThreadRuntimeControlsError } from '../ThreadRuntimeControlsService';
import { SYSTEM_AGENT_DEFINITIONS } from '../systemAgentDefinitions';

const userIdentity = {
  userId: 'sample-user',
  githubUsername: 'sample-user',
  preferredUsername: 'sample-user',
  email: 'sample-user@example.com',
  firstName: 'Sample',
  lastName: 'User',
  displayName: 'Sample User',
  gitUserName: 'Sample User',
  gitUserEmail: 'sample-user@example.com',
  roles: [],
};

const session = {
  id: 17,
  uuid: 'session-1',
  sessionKind: 'chat',
  buildUuid: null,
  workspaceRepos: [{ repo: 'example-org/example-repo', primary: true }],
};

const thread = {
  id: 23,
  uuid: 'thread-1',
  metadata: {},
};

const source = {
  id: 7,
  status: 'ready',
  input: {},
};

const customDefinition = {
  id: 'custom.sample-agent',
  version: 1,
  owner: { kind: 'user' as const, userId: 'sample-user' },
  name: 'Sample agent',
  description: 'Helps with sample work.',
  instructionRefs: [],
  instructionAddendum: 'Answer clearly.',
  capabilityRefs: ['read_context', 'workspace_files', 'external_mcp_read'],
  requiredCapabilityRefs: ['read_context'],
  optionalCapabilityRefs: ['workspace_files', 'external_mcp_read'],
  resourcePolicy: {
    sourceKinds: ['freeform_chat', 'workspace_session'],
    workspaceRequired: false,
    sandboxRequired: false,
  },
  modelPreference: null,
  status: 'active' as const,
  codeOwned: false,
  readOnly: false,
};

function mockBaseContext() {
  mockGetOwnedThreadWithSession.mockResolvedValue({ thread, session });
  mockGetSelectedAgentDefinitionId.mockReturnValue('custom.sample-agent');
  mockGetRuntimeControlChoices.mockReturnValue(null);
  mockGetSessionSource.mockResolvedValue(source);
  mockResolveSessionContext.mockResolvedValue({
    repoFullName: 'example-org/example-repo',
    approvalPolicy: { defaultMode: 'allow', rules: {} },
    capabilityPolicy: undefined,
  });
  mockHasActiveRun.mockResolvedValue(false);
  mockEnsureSeeded.mockResolvedValue([]);
  mockInferDefaultAgentDefinitionId.mockReturnValue('system.develop');
  mockGetEffectiveConfig.mockResolvedValue({
    approvalPolicy: { defaultMode: 'allow', rules: {} },
    capabilityPolicy: undefined,
  });
  mockListUserDefinitions.mockResolvedValue([customDefinition]);
  mockGetUserDefinition.mockResolvedValue(customDefinition);
  mockBuildSelectedAgentDefinitionMetadataPatch.mockImplementation((agentId: string) => ({
    selectedAgentDefinitionId: agentId,
  }));
  mockListEnabledConnectionsForUser.mockResolvedValue([
    {
      slug: 'sample-mcp',
      name: 'Sample MCP',
      description: 'Provides sample context.',
      scope: 'global',
      connectionRequired: false,
      configured: true,
      stale: false,
      discoveredTools: [{ name: 'readSample', annotations: { readOnlyHint: true } }],
    },
  ]);
}

function getOptionalChoiceId(state: Awaited<ReturnType<typeof AgentThreadRuntimeControlsService.getState>>) {
  const optional = state.tools.optional.find((choice) => choice.label === 'Workspace files');
  if (!optional) {
    throw new Error('Expected Workspace files optional choice');
  }
  return optional.id;
}

describe('AgentThreadRuntimeControlsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBaseContext();
  });

  it('returns sanitized opaque tool and MCP state for an existing thread', async () => {
    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });

    expect(state.canEdit).toBe(true);
    expect(state.disabledReason).toBeNull();
    expect(state.tools.required).toEqual([
      expect.objectContaining({
        label: 'Read/context',
        required: true,
        selected: true,
        available: true,
      }),
    ]);
    expect(state.tools.optional).toEqual([
      expect.objectContaining({
        label: 'Workspace files',
        required: false,
        selected: true,
        available: true,
      }),
    ]);
    expect(state.mcp.connections).toEqual([
      expect.objectContaining({
        label: 'Sample MCP',
        selected: true,
        available: true,
      }),
    ]);
    expect(JSON.stringify(state)).not.toContain('workspace_files');
    expect(JSON.stringify(state)).not.toContain('external_mcp_read');
    expect(JSON.stringify(state)).not.toContain('sample-mcp');
    expect(state.tools.selectedChoiceIds.every((id) => id.startsWith('rtc_'))).toBe(true);
    expect(state.mcp.selectedChoiceIds.every((id) => id.startsWith('rtc_'))).toBe(true);
  });

  it('hides creator-reserved optional capabilities from selected runtime choices', async () => {
    mockResolveSessionContext.mockResolvedValueOnce({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'allow', rules: {} },
      capabilityPolicy: undefined,
      customAgentCreationPolicy: {
        capabilityAvailability: {
          workspace_files: 'reserved',
          external_mcp_read: 'reserved',
        },
      },
    });

    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });

    expect(state.tools.optional).toEqual([
      expect.objectContaining({
        label: 'Workspace files',
        available: false,
      }),
    ]);
    expect(state.tools.selectedChoiceIds).toEqual([state.tools.required[0].id]);
    expect(state.mcp.connections).toEqual([]);
    expect(state.mcp.selectedChoiceIds).toEqual([]);
  });

  it('persists valid optional choices as opaque ids and leaves raw ids out of metadata', async () => {
    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });
    const optionalChoiceId = getOptionalChoiceId(state);
    const mcpChoiceId = state.mcp.connections[0].id;
    mockPatchRuntimeControlChoices.mockResolvedValue({
      ...thread,
      metadata: {},
    });

    await AgentThreadRuntimeControlsService.patchChoices({
      threadId: 'thread-1',
      userIdentity,
      toolChoiceIds: [optionalChoiceId],
      mcpChoiceIds: [mcpChoiceId],
    });

    expect(mockPatchRuntimeControlChoices).toHaveBeenCalledWith(23, {
      version: 1,
      toolChoiceIds: [optionalChoiceId],
      mcpChoiceIds: [mcpChoiceId],
    });
    expect(JSON.stringify(mockPatchRuntimeControlChoices.mock.calls[0][1])).not.toContain('workspace_files');
    expect(JSON.stringify(mockPatchRuntimeControlChoices.mock.calls[0][1])).not.toContain('sample-mcp');
  });

  it('preserves current MCP choices when patching only tool choices', async () => {
    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });
    const optionalChoiceId = getOptionalChoiceId(state);
    const mcpChoiceId = state.mcp.connections[0].id;
    mockPatchRuntimeControlChoices.mockResolvedValue({
      ...thread,
      metadata: {},
    });

    await AgentThreadRuntimeControlsService.patchChoices({
      threadId: 'thread-1',
      userIdentity,
      toolChoiceIds: [optionalChoiceId],
    });

    expect(mockPatchRuntimeControlChoices).toHaveBeenCalledWith(23, {
      version: 1,
      toolChoiceIds: [optionalChoiceId],
      mcpChoiceIds: [mcpChoiceId],
    });
  });

  it('preserves current tool choices when patching only MCP choices', async () => {
    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });
    const optionalChoiceId = getOptionalChoiceId(state);
    const mcpChoiceId = state.mcp.connections[0].id;
    mockPatchRuntimeControlChoices.mockResolvedValue({
      ...thread,
      metadata: {},
    });

    await AgentThreadRuntimeControlsService.patchChoices({
      threadId: 'thread-1',
      userIdentity,
      mcpChoiceIds: [mcpChoiceId],
    });

    expect(mockPatchRuntimeControlChoices).toHaveBeenCalledWith(23, {
      version: 1,
      toolChoiceIds: [optionalChoiceId],
      mcpChoiceIds: [mcpChoiceId],
    });
  });

  it('keeps required tool choices selected when a patch omits them', async () => {
    mockPatchRuntimeControlChoices.mockResolvedValue({
      ...thread,
      metadata: {},
    });

    const updatedState = await AgentThreadRuntimeControlsService.patchChoices({
      threadId: 'thread-1',
      userIdentity,
      toolChoiceIds: [],
      mcpChoiceIds: [],
    });

    expect(mockPatchRuntimeControlChoices).toHaveBeenCalledWith(23, {
      version: 1,
      toolChoiceIds: [],
      mcpChoiceIds: [],
    });
    expect(updatedState.tools.required).toEqual([
      expect.objectContaining({
        label: 'Read/context',
        required: true,
        selected: true,
        available: true,
      }),
    ]);
    expect(updatedState.tools.selectedChoiceIds).toEqual([updatedState.tools.required[0].id]);
  });

  it('treats shared discovered MCP tools as available runtime choices', async () => {
    mockListEnabledConnectionsForUser.mockResolvedValue([
      {
        slug: 'shared-sample-mcp',
        name: 'Shared Sample MCP',
        description: 'Provides shared sample context.',
        scope: 'global',
        connectionRequired: false,
        configured: false,
        stale: false,
        validationError: null,
        discoveredTools: [],
        sharedDiscoveredTools: [{ name: 'readSharedSample', annotations: { readOnlyHint: true } }],
      },
    ]);

    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });

    expect(state.mcp.connections).toEqual([
      expect.objectContaining({
        label: 'Shared Sample MCP',
        selected: true,
        available: true,
      }),
    ]);
    expect(state.mcp.selectedChoiceIds).toEqual([state.mcp.connections[0].id]);
  });

  it('marks MCP connections with validation errors unavailable and rejects saved choices', async () => {
    mockListEnabledConnectionsForUser.mockResolvedValue([
      {
        slug: 'broken-sample-mcp',
        name: 'Broken Sample MCP',
        description: 'Broken sample context.',
        scope: 'global',
        connectionRequired: false,
        configured: true,
        stale: false,
        validationError: 'Connection failed',
        discoveredTools: [{ name: 'readBrokenSample', annotations: { readOnlyHint: true } }],
        sharedDiscoveredTools: [],
      },
    ]);

    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });
    const brokenChoiceId = state.mcp.connections[0].id;

    expect(state.mcp.connections).toEqual([
      expect.objectContaining({
        label: 'Broken Sample MCP',
        selected: false,
        available: false,
      }),
    ]);
    expect(state.mcp.selectedChoiceIds).toEqual([]);

    await expect(
      AgentThreadRuntimeControlsService.patchChoices({
        threadId: 'thread-1',
        userIdentity,
        toolChoiceIds: [],
        mcpChoiceIds: [brokenChoiceId],
      })
    ).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });

  it('keeps metadata absent until runtime choices are saved', async () => {
    await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });

    expect(mockPatchRuntimeControlChoices).not.toHaveBeenCalled();
  });

  it('rejects raw, unknown, and policy-denied choices', async () => {
    await expect(
      AgentThreadRuntimeControlsService.patchChoices({
        threadId: 'thread-1',
        userIdentity,
        toolChoiceIds: ['workspace_files'],
        mcpChoiceIds: [],
      })
    ).rejects.toMatchObject({
      code: 'unknown_choice',
    });

    mockResolveSessionContext.mockResolvedValue({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'allow', rules: {} },
      capabilityPolicy: { availability: { workspace_files: 'disabled' } },
    });
    const deniedState = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });
    const deniedChoiceId = getOptionalChoiceId(deniedState);

    await expect(
      AgentThreadRuntimeControlsService.patchChoices({
        threadId: 'thread-1',
        userIdentity,
        toolChoiceIds: [deniedChoiceId],
        mcpChoiceIds: [],
      })
    ).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });

  it('blocks existing-thread edits while an active run exists', async () => {
    mockHasActiveRun.mockResolvedValue(true);

    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });

    expect(state.canEdit).toBe(false);
    expect(state.disabledReason).toBe('Change after this response finishes.');

    await expect(
      AgentThreadRuntimeControlsService.patchChoices({
        threadId: 'thread-1',
        userIdentity,
        toolChoiceIds: [],
        mcpChoiceIds: [],
      })
    ).rejects.toMatchObject({
      code: 'active_run',
      message: 'Change after this response finishes.',
    });
  });

  it('returns a sanitized /new preview without requiring a thread id', async () => {
    const state = await AgentThreadRuntimeControlsService.getEntryPreview({
      userIdentity,
      agentId: 'custom.sample-agent',
      source: { adapter: 'lifecycle_fork', input: {} },
      defaults: {},
    });

    expect(mockGetOwnedThreadWithSession).not.toHaveBeenCalled();
    expect(state.canEdit).toBe(true);
    expect(state.tools.optional.map((choice) => choice.label)).toEqual(['Workspace files']);
    expect(state.mcp.connections.map((choice) => choice.label)).toEqual(['Sample MCP']);
    expect(JSON.stringify(state)).not.toContain('custom.sample-agent');
    expect(JSON.stringify(state)).not.toContain('sample-mcp');
  });

  it('previews Develop tools for blank chat entry without a prepared workspace yet', async () => {
    mockGetSystemAgentDefinition.mockResolvedValueOnce(SYSTEM_AGENT_DEFINITIONS['system.develop']);

    const state = await AgentThreadRuntimeControlsService.getEntryPreview({
      userIdentity,
      agentId: 'system.develop',
      source: { adapter: 'blank_workspace', input: {} },
      defaults: {},
    });

    expect(state.tools.required.map((choice) => choice.label)).toEqual(
      expect.arrayContaining(['Workspace files', 'Command tools', 'Source control'])
    );
    expect(state.canEdit).toBe(true);
  });

  it('validates create-session bootstrap choices and preserves explicit empty arrays', async () => {
    const preview = await AgentThreadRuntimeControlsService.getEntryPreview({
      userIdentity,
      agentId: 'custom.sample-agent',
      source: { adapter: 'lifecycle_fork', input: {} },
      defaults: {},
    });
    const optionalChoiceId = getOptionalChoiceId(preview);

    const metadata = await AgentThreadRuntimeControlsService.validateEntryChoices({
      userIdentity,
      agentId: 'custom.sample-agent',
      source: { adapter: 'lifecycle_fork', input: {} },
      defaults: {},
      runtimeControlChoices: {
        toolChoiceIds: [optionalChoiceId],
        mcpChoiceIds: [],
      },
    });

    expect(metadata).toEqual({
      selectedAgentMetadataPatch: {
        selectedAgentDefinitionId: 'custom.sample-agent',
      },
      runtimeControlChoices: {
        version: 1,
        toolChoiceIds: [optionalChoiceId],
        mcpChoiceIds: [],
      },
    });
    expect(mockBuildSelectedAgentDefinitionMetadataPatch).toHaveBeenCalledWith('custom.sample-agent');
  });

  it('stores selected agent metadata without runtime-choice metadata for agent-only create-session input', async () => {
    const metadata = await AgentThreadRuntimeControlsService.validateEntryChoices({
      userIdentity,
      agentId: 'custom.sample-agent',
      source: { adapter: 'lifecycle_fork', input: {} },
      defaults: {},
      runtimeControlChoices: {
        agentId: 'custom.sample-agent',
      },
    });

    expect(metadata).toEqual({
      selectedAgentMetadataPatch: {
        selectedAgentDefinitionId: 'custom.sample-agent',
      },
      runtimeControlChoices: null,
    });
  });

  it('stores Develop metadata for blank chat create-session input', async () => {
    mockGetSystemAgentDefinition.mockResolvedValueOnce(SYSTEM_AGENT_DEFINITIONS['system.develop']);

    const metadata = await AgentThreadRuntimeControlsService.validateEntryChoices({
      userIdentity,
      agentId: 'system.develop',
      source: { adapter: 'blank_workspace', input: {} },
      defaults: {},
      runtimeControlChoices: {
        agentId: 'system.develop',
      },
    });

    expect(metadata).toEqual({
      selectedAgentMetadataPatch: {
        selectedAgentDefinitionId: 'system.develop',
      },
      runtimeControlChoices: null,
    });
  });

  it('keeps default tool choices in /new preview when only MCP choices are provided', async () => {
    const preview = await AgentThreadRuntimeControlsService.getEntryPreview({
      userIdentity,
      agentId: 'custom.sample-agent',
      source: { adapter: 'lifecycle_fork', input: {} },
      defaults: {},
    });
    const optionalChoiceId = getOptionalChoiceId(preview);

    const updatedPreview = await AgentThreadRuntimeControlsService.getEntryPreview({
      userIdentity,
      agentId: 'custom.sample-agent',
      source: { adapter: 'lifecycle_fork', input: {} },
      defaults: {},
      runtimeControlChoices: {
        mcpChoiceIds: [],
      },
    });

    expect(updatedPreview.tools.selectedChoiceIds).toContain(optionalChoiceId);
    expect(updatedPreview.mcp.selectedChoiceIds).toEqual([]);
  });

  it('throws a typed not_found error for missing threads', async () => {
    mockGetOwnedThreadWithSession.mockRejectedValueOnce(new Error('Agent thread not found'));

    await expect(
      AgentThreadRuntimeControlsService.getState({
        threadId: 'missing-thread',
        userIdentity,
      })
    ).rejects.toBeInstanceOf(AgentThreadRuntimeControlsError);
  });
});
