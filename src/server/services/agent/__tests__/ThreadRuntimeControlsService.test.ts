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
const mockInferDefaultAgentSourceKind = jest.fn();
const mockListUserDefinitions = jest.fn();
const mockGetUserDefinition = jest.fn();
const mockListEnabledConnectionsForUser = jest.fn();
const mockGetEffectiveConfig = jest.fn();
const mockCreateRuntimeControlsUpdateEvent = jest.fn();

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

jest.mock('../MessageStore', () => ({
  __esModule: true,
  default: {
    createRuntimeControlsUpdateEvent: (...args: unknown[]) => mockCreateRuntimeControlsUpdateEvent(...args),
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
    inferDefaultAgentSourceKind: (...args: unknown[]) => mockInferDefaultAgentSourceKind(...args),
  };
});

jest.mock('../CustomAgentDefinitionService', () => ({
  __esModule: true,
  CUSTOM_AGENT_NEEDS_CONVERSION_MESSAGE:
    'This custom agent needs conversion before it can run in the one-agent harness.',
  customAgentDefinitionNeedsOneAgentConversion: (definition: any) =>
    definition.owner.kind === 'user' &&
    (definition.resourcePolicy.workspaceRequired ||
      definition.resourcePolicy.sandboxRequired ||
      (definition.resourcePolicy.sourceKinds.includes('workspace_session') &&
        !definition.resourcePolicy.sourceKinds.includes('freeform_chat'))),
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
  mockInferDefaultAgentDefinitionId.mockReturnValue('system.agent');
  mockInferDefaultAgentSourceKind.mockReturnValue('workspace_session');
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
    mockCreateRuntimeControlsUpdateEvent.mockResolvedValue({});
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

  it('trims and deduplicates externally supplied choice ids before persistence', async () => {
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
      toolChoiceIds: [`  ${optionalChoiceId}  `, optionalChoiceId],
      mcpChoiceIds: [` ${mcpChoiceId}`, mcpChoiceId],
    });

    expect(mockPatchRuntimeControlChoices).toHaveBeenCalledWith(23, {
      version: 1,
      toolChoiceIds: [optionalChoiceId],
      mcpChoiceIds: [mcpChoiceId],
    });
    expect(mockCreateRuntimeControlsUpdateEvent).not.toHaveBeenCalled();
  });

  it('rejects missing and malformed choice arrays without persisting', async () => {
    await expect(
      AgentThreadRuntimeControlsService.patchChoices({
        threadId: 'thread-1',
        userIdentity,
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      httpStatus: 400,
      message: 'runtimeControlChoices are required.',
    });

    await expect(
      AgentThreadRuntimeControlsService.patchChoices({
        threadId: 'thread-1',
        userIdentity,
        toolChoiceIds: 'not-an-array' as never,
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'toolChoiceIds must be an array of choice ids.',
    });

    await expect(
      AgentThreadRuntimeControlsService.patchChoices({
        threadId: 'thread-1',
        userIdentity,
        mcpChoiceIds: ['   '],
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'mcpChoiceIds must contain only choice ids.',
    });

    expect(mockPatchRuntimeControlChoices).not.toHaveBeenCalled();
    expect(mockCreateRuntimeControlsUpdateEvent).not.toHaveBeenCalled();
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

  it('records a runtime-controls update system event with the human-readable diff', async () => {
    mockPatchRuntimeControlChoices.mockResolvedValue({
      ...thread,
      metadata: {},
    });

    await AgentThreadRuntimeControlsService.patchChoices({
      threadId: 'thread-1',
      userIdentity,
      toolChoiceIds: [],
      mcpChoiceIds: [],
    });

    expect(mockCreateRuntimeControlsUpdateEvent).toHaveBeenCalledWith({
      thread: { id: 23 },
      actor: { userId: 'sample-user', label: 'Sample User' },
      enabled: [],
      disabled: expect.arrayContaining([
        expect.objectContaining({ label: 'Workspace files' }),
        expect.objectContaining({ label: 'Sample MCP' }),
      ]),
    });
  });

  it('records newly enabled choices in the runtime-controls update event', async () => {
    const defaultState = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });
    const optionalChoiceId = getOptionalChoiceId(defaultState);
    const mcpChoiceId = defaultState.mcp.connections[0].id;
    mockGetRuntimeControlChoices.mockReturnValue({
      version: 1,
      toolChoiceIds: [],
      mcpChoiceIds: [],
    });
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

    expect(mockCreateRuntimeControlsUpdateEvent).toHaveBeenCalledWith({
      thread: { id: 23 },
      actor: { userId: 'sample-user', label: 'Sample User' },
      enabled: expect.arrayContaining([
        expect.objectContaining({ label: 'Workspace files' }),
        expect.objectContaining({ label: 'Sample MCP' }),
      ]),
      disabled: [],
    });
  });

  it('propagates persistence failures and does not append an audit event', async () => {
    const persistenceError = new Error('update failed');
    mockPatchRuntimeControlChoices.mockRejectedValueOnce(persistenceError);

    await expect(
      AgentThreadRuntimeControlsService.patchChoices({
        threadId: 'thread-1',
        userIdentity,
        toolChoiceIds: [],
        mcpChoiceIds: [],
      })
    ).rejects.toBe(persistenceError);

    expect(mockCreateRuntimeControlsUpdateEvent).not.toHaveBeenCalled();
  });

  it('records no event when the patch does not change the selection', async () => {
    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });
    mockPatchRuntimeControlChoices.mockResolvedValue({
      ...thread,
      metadata: {},
    });

    await AgentThreadRuntimeControlsService.patchChoices({
      threadId: 'thread-1',
      userIdentity,
      toolChoiceIds: [getOptionalChoiceId(state)],
      mcpChoiceIds: [state.mcp.connections[0].id],
    });

    expect(mockCreateRuntimeControlsUpdateEvent).not.toHaveBeenCalled();
  });

  it('does not fail the patch when the event append fails', async () => {
    mockPatchRuntimeControlChoices.mockResolvedValue({
      ...thread,
      metadata: {},
    });
    mockCreateRuntimeControlsUpdateEvent.mockRejectedValueOnce(new Error('insert failed'));

    const updatedState = await AgentThreadRuntimeControlsService.patchChoices({
      threadId: 'thread-1',
      userIdentity,
      toolChoiceIds: [],
      mcpChoiceIds: [],
    });

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

  it('reflects connection setup, staleness, tool discovery, and nullable descriptions in MCP availability', async () => {
    mockListEnabledConnectionsForUser.mockResolvedValue([
      {
        slug: 'needs-setup',
        name: 'Needs setup',
        description: 'Not configured.',
        scope: 'global',
        connectionRequired: true,
        configured: false,
        stale: false,
        validationError: null,
        discoveredTools: [{ name: 'readSetup', annotations: { readOnlyHint: true } }],
        sharedDiscoveredTools: [],
      },
      {
        slug: 'stale-connection',
        name: 'Stale connection',
        description: 'Needs refresh.',
        scope: 'global',
        connectionRequired: true,
        configured: true,
        stale: true,
        validationError: null,
        discoveredTools: [{ name: 'readStale', annotations: { readOnlyHint: true } }],
        sharedDiscoveredTools: [],
      },
      {
        slug: 'no-tools',
        name: 'No tools',
        description: 'Connected but empty.',
        scope: 'global',
        connectionRequired: false,
        configured: true,
        stale: false,
        validationError: null,
        discoveredTools: [],
        sharedDiscoveredTools: [],
      },
      {
        slug: 'available-without-description',
        name: 'Available without description',
        description: null,
        scope: 'global',
        connectionRequired: false,
        configured: true,
        stale: false,
        validationError: null,
        discoveredTools: [{ name: 'readAvailable', annotations: { readOnlyHint: true } }],
        sharedDiscoveredTools: [],
      },
    ]);

    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });

    expect(state.mcp.connections).toEqual([
      expect.objectContaining({ label: 'Needs setup', available: false, selected: false }),
      expect.objectContaining({ label: 'Stale connection', available: false, selected: false }),
      expect.objectContaining({ label: 'No tools', available: false, selected: false }),
      expect.objectContaining({
        label: 'Available without description',
        description: null,
        available: true,
        selected: true,
      }),
    ]);
    expect(state.mcp.selectedChoiceIds).toEqual([state.mcp.connections[3].id]);
  });

  it('keeps metadata absent until runtime choices are saved', async () => {
    await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });

    expect(mockPatchRuntimeControlChoices).not.toHaveBeenCalled();
  });

  it('returns an absent admission snapshot without loading MCP connections when no choices were saved', async () => {
    const choices = await AgentThreadRuntimeControlsService.resolveRunAdmissionChoices({
      thread,
      userIdentity,
      definition: SYSTEM_AGENT_DEFINITIONS['system.freeform'],
      sourceKind: 'freeform_chat',
      capabilityPolicy: undefined,
      customAgentCreationPolicy: undefined,
      approvalPolicy: { defaultMode: 'allow', rules: {} },
      repoFullName: 'example-org/example-repo',
    });

    expect(choices).toEqual({ metadataPresent: false });
    expect(mockListEnabledConnectionsForUser).not.toHaveBeenCalled();
  });

  it('admits allowed MCP capabilities when a connection is selected', async () => {
    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });
    mockGetRuntimeControlChoices.mockReturnValue({
      version: 1,
      toolChoiceIds: [],
      mcpChoiceIds: [state.mcp.connections[0].id],
    });

    const choices = await AgentThreadRuntimeControlsService.resolveRunAdmissionChoices({
      thread,
      userIdentity,
      definition: SYSTEM_AGENT_DEFINITIONS['system.freeform'],
      sourceKind: 'freeform_chat',
      capabilityPolicy: undefined,
      customAgentCreationPolicy: undefined,
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      repoFullName: 'example-org/example-repo',
    });

    expect(choices.selectedRuntimeCapabilityIds).toEqual(['read_context', 'external_mcp_read', 'external_mcp_write']);
    expect(choices.selectedRuntimeMcpConnectionRefs).toEqual(['global:sample-mcp']);
  });

  it('does not admit optional MCP capabilities when no connection is selected', async () => {
    mockGetRuntimeControlChoices.mockReturnValue({
      version: 1,
      toolChoiceIds: [],
      mcpChoiceIds: [],
    });

    const choices = await AgentThreadRuntimeControlsService.resolveRunAdmissionChoices({
      thread,
      userIdentity,
      definition: SYSTEM_AGENT_DEFINITIONS['system.freeform'],
      sourceKind: 'freeform_chat',
      capabilityPolicy: undefined,
      customAgentCreationPolicy: undefined,
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      repoFullName: 'example-org/example-repo',
    });

    expect(choices.selectedRuntimeCapabilityIds).toEqual(['read_context']);
    expect(choices.selectedRuntimeMcpConnectionRefs).toEqual([]);
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

  it('rejects an unknown MCP choice before persistence', async () => {
    await expect(
      AgentThreadRuntimeControlsService.patchChoices({
        threadId: 'thread-1',
        userIdentity,
        toolChoiceIds: [],
        mcpChoiceIds: ['rtc_v1_f48b74d9_mcp_unknown'],
      })
    ).rejects.toMatchObject({
      code: 'unknown_choice',
      httpStatus: 400,
    });

    expect(mockPatchRuntimeControlChoices).not.toHaveBeenCalled();
    expect(mockCreateRuntimeControlsUpdateEvent).not.toHaveBeenCalled();
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

  it.each([
    {
      name: 'build-backed blank chat',
      sourceInput: { adapter: 'blank_workspace', input: { buildUuid: ' build-1 ' } },
      expectedRequiredLabel: 'Diagnostic logs',
    },
    {
      name: 'workspace chat',
      sourceInput: { adapter: 'lifecycle_fork', input: {} },
      expectedRequiredLabel: 'Workspace files',
    },
    {
      name: 'free-form blank chat',
      sourceInput: { adapter: 'blank_workspace', input: {} },
      expectedRequiredLabel: 'Read/context',
    },
  ])('maps the default Lifecycle agent to the $name tool surface', async ({ sourceInput, expectedRequiredLabel }) => {
    mockGetSystemAgentDefinition.mockResolvedValueOnce(SYSTEM_AGENT_DEFINITIONS['system.agent']);

    const state = await AgentThreadRuntimeControlsService.getEntryPreview({
      userIdentity,
      source: sourceInput,
      defaults: {},
    });

    expect(state.tools.required).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: expectedRequiredLabel, selected: true })])
    );
  });

  it('uses workspace defaults when a new-entry preview omits source details', async () => {
    mockGetSystemAgentDefinition.mockResolvedValueOnce(SYSTEM_AGENT_DEFINITIONS['system.agent']);

    const state = await AgentThreadRuntimeControlsService.getEntryPreview({
      userIdentity,
      defaults: {},
    });

    expect(state.tools.required.map((choice) => choice.label)).toEqual(
      expect.arrayContaining(['Read/context', 'Workspace files', 'Command tools', 'Source control'])
    );
    expect(mockGetEffectiveConfig).toHaveBeenCalledWith(undefined);
    expect(mockListEnabledConnectionsForUser).toHaveBeenCalledWith(undefined, userIdentity);
  });

  it('uses an explicitly selected legacy system agent source kind instead of the entry adapter default', async () => {
    mockGetSystemAgentDefinition.mockResolvedValueOnce(SYSTEM_AGENT_DEFINITIONS['system.freeform']);

    const state = await AgentThreadRuntimeControlsService.getEntryPreview({
      userIdentity,
      agentId: 'system.freeform',
      source: { adapter: 'lifecycle_fork', input: {} },
      defaults: {},
    });

    expect(mockGetSystemAgentDefinition).toHaveBeenCalledWith('system.freeform');
    expect(state.tools.required).toEqual([expect.objectContaining({ label: 'Read/context', available: true })]);
  });

  it.each([
    {
      name: 'direct repository',
      sourceInput: {
        adapter: 'lifecycle_fork',
        input: { repo: ' example-org/direct-repo ', repoUrl: 'https://github.com/ignored/repo.git' },
      },
      expectedRepo: 'example-org/direct-repo',
    },
    {
      name: 'GitHub URL',
      sourceInput: {
        adapter: 'lifecycle_fork',
        input: { repoUrl: ' https://github.com/example-org/url-repo.git ' },
      },
      expectedRepo: 'example-org/url-repo',
    },
    {
      name: 'incomplete GitHub URL',
      sourceInput: {
        adapter: 'lifecycle_fork',
        input: { repoUrl: 'https://github.com/' },
      },
      expectedRepo: undefined,
    },
  ])('normalizes the $name before resolving entry policy and MCP context', async ({ sourceInput, expectedRepo }) => {
    await AgentThreadRuntimeControlsService.getEntryPreview({
      userIdentity,
      agentId: 'custom.sample-agent',
      source: sourceInput,
      defaults: {},
    });

    expect(mockGetEffectiveConfig).toHaveBeenCalledWith(expectedRepo);
    expect(mockListEnabledConnectionsForUser).toHaveBeenCalledWith(expectedRepo, userIdentity);
  });

  it('uses capabilityRefs as optional choices for a definition without explicit required/optional partitions', async () => {
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      requiredCapabilityRefs: undefined,
      optionalCapabilityRefs: undefined,
    });

    const state = await AgentThreadRuntimeControlsService.getEntryPreview({
      userIdentity,
      agentId: 'custom.sample-agent',
      source: { adapter: 'lifecycle_fork', input: {} },
      defaults: {},
    });

    expect(state.tools.required).toEqual([]);
    expect(state.tools.optional.map((choice) => choice.label)).toEqual(['Read/context', 'Workspace files']);
    expect(state.mcp.connections).toEqual([expect.objectContaining({ label: 'Sample MCP', available: true })]);
  });

  it('rejects disabled custom definitions before resolving policy or MCP context', async () => {
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      status: 'disabled',
    });

    await expect(
      AgentThreadRuntimeControlsService.getEntryPreview({
        userIdentity,
        agentId: 'custom.sample-agent',
        source: { adapter: 'lifecycle_fork', input: {} },
        defaults: {},
      })
    ).rejects.toMatchObject({
      code: 'policy_denied',
      httpStatus: 403,
      message: 'Sample agent is unavailable.',
    });

    expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
    expect(mockListEnabledConnectionsForUser).not.toHaveBeenCalled();
  });

  it('rejects custom definitions that require one-agent conversion before resolving runtime context', async () => {
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      resourcePolicy: {
        ...customDefinition.resourcePolicy,
        workspaceRequired: true,
      },
    });

    await expect(
      AgentThreadRuntimeControlsService.getEntryPreview({
        userIdentity,
        agentId: 'custom.sample-agent',
        source: { adapter: 'lifecycle_fork', input: {} },
        defaults: {},
      })
    ).rejects.toMatchObject({
      code: 'policy_denied',
      message: 'This custom agent needs conversion before it can run in the one-agent harness.',
    });

    expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
    expect(mockListEnabledConnectionsForUser).not.toHaveBeenCalled();
  });

  it('rejects a definition that does not support the selected conversation source', async () => {
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      resourcePolicy: {
        ...customDefinition.resourcePolicy,
        sourceKinds: ['freeform_chat'],
      },
    });

    await expect(
      AgentThreadRuntimeControlsService.getEntryPreview({
        userIdentity,
        agentId: 'custom.sample-agent',
        source: { adapter: 'lifecycle_fork', input: {} },
        defaults: {},
      })
    ).rejects.toMatchObject({
      code: 'policy_denied',
      message: 'Sample agent is unavailable for this conversation.',
    });

    expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
    expect(mockListEnabledConnectionsForUser).not.toHaveBeenCalled();
  });

  it('rejects an unknown agent family without querying user definitions or runtime context', async () => {
    await expect(
      AgentThreadRuntimeControlsService.getEntryPreview({
        userIdentity,
        agentId: 'vendor.unknown',
        source: { adapter: 'lifecycle_fork', input: {} },
        defaults: {},
      })
    ).rejects.toMatchObject({
      code: 'policy_denied',
      message: 'Selected agent is unavailable.',
    });

    expect(mockGetUserDefinition).not.toHaveBeenCalled();
    expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
    expect(mockListEnabledConnectionsForUser).not.toHaveBeenCalled();
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

  it('uses the default agent without writing selected-agent metadata when entry choices omit an agent', async () => {
    mockGetSystemAgentDefinition.mockResolvedValueOnce(SYSTEM_AGENT_DEFINITIONS['system.agent']);

    const metadata = await AgentThreadRuntimeControlsService.validateEntryChoices({
      userIdentity,
      source: { adapter: 'blank_workspace', input: {} },
      defaults: {},
      runtimeControlChoices: {},
    });

    expect(metadata).toEqual({
      selectedAgentMetadataPatch: null,
      runtimeControlChoices: null,
    });
    expect(mockBuildSelectedAgentDefinitionMetadataPatch).not.toHaveBeenCalled();
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

  it('falls back to the inferred system agent when the thread has no saved agent selection', async () => {
    mockGetSelectedAgentDefinitionId.mockReturnValueOnce(null);
    mockGetSystemAgentDefinition.mockResolvedValueOnce(SYSTEM_AGENT_DEFINITIONS['system.agent']);

    const state = await AgentThreadRuntimeControlsService.getState({
      threadId: 'thread-1',
      userIdentity,
    });

    expect(mockGetSystemAgentDefinition).toHaveBeenCalledWith('system.agent');
    expect(mockGetUserDefinition).not.toHaveBeenCalled();
    expect(state.tools.required.map((choice) => choice.label)).toEqual(
      expect.arrayContaining(['Read/context', 'Workspace files', 'Command tools', 'Source control'])
    );
  });

  it.each(['Agent thread not found', 'Agent session not found'])(
    'maps "%s" dependency errors to a typed not_found response',
    async (message) => {
      mockGetOwnedThreadWithSession.mockRejectedValueOnce(new Error(message));
      const statePromise = AgentThreadRuntimeControlsService.getState({
        threadId: 'missing-thread',
        userIdentity,
      });

      await expect(statePromise).rejects.toBeInstanceOf(AgentThreadRuntimeControlsError);
      await expect(statePromise).rejects.toMatchObject({
        name: 'AgentThreadRuntimeControlsError',
        code: 'not_found',
        httpStatus: 404,
        message,
      });
    }
  );

  it('preserves unexpected thread lookup failures', async () => {
    const lookupError = new Error('database unavailable');
    mockGetOwnedThreadWithSession.mockRejectedValueOnce(lookupError);

    await expect(
      AgentThreadRuntimeControlsService.getState({
        threadId: 'thread-1',
        userIdentity,
      })
    ).rejects.toBe(lookupError);
  });

  it.each([
    { name: 'missing', sourceRecord: null },
    { name: 'not ready', sourceRecord: { ...source, status: 'preparing' } },
  ])('rejects a $name session source before resolving agent or capability context', async ({ sourceRecord }) => {
    mockGetSessionSource.mockResolvedValueOnce(sourceRecord);

    await expect(
      AgentThreadRuntimeControlsService.getState({
        threadId: 'thread-1',
        userIdentity,
      })
    ).rejects.toMatchObject({
      code: 'policy_denied',
      httpStatus: 403,
      message: 'Session source is not ready yet.',
    });

    expect(mockGetUserDefinition).not.toHaveBeenCalled();
    expect(mockResolveSessionContext).not.toHaveBeenCalled();
    expect(mockHasActiveRun).not.toHaveBeenCalled();
    expect(mockListEnabledConnectionsForUser).not.toHaveBeenCalled();
  });
});
