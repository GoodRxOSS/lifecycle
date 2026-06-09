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

const mockThreadTransaction = jest.fn();
const mockThreadQuery = jest.fn();
const mockRunQuery = jest.fn();
const mockResolveSessionContext = jest.fn();
const mockEnsureSeeded = jest.fn();
const mockListSystemDefinitions = jest.fn();
const mockInferDefaultAgentDefinitionId = jest.fn();
const mockInferDefaultAgentSourceKind = jest.fn();
const mockCreateAgentSwitchEvent = jest.fn();
const mockGetSessionSource = jest.fn();
const mockGetOwnedThreadWithSession = jest.fn();
const mockListUserDefinitions = jest.fn();

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockThreadQuery(...args),
    transaction: (...args: unknown[]) => mockThreadTransaction(...args),
  },
}));

jest.mock('server/models/AgentRun', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockRunQuery(...args),
  },
}));

jest.mock('../CapabilityService', () => ({
  __esModule: true,
  default: {
    resolveSessionContext: (...args: unknown[]) => mockResolveSessionContext(...args),
  },
}));

jest.mock('../AgentDefinitionRegistry', () => {
  const actual = jest.requireActual('../AgentDefinitionRegistry');
  return {
    __esModule: true,
    ...actual,
    ensureSystemAgentDefinitionsSeeded: (...args: unknown[]) => mockEnsureSeeded(...args),
    listSystemAgentDefinitions: (...args: unknown[]) => mockListSystemDefinitions(...args),
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
  },
}));

jest.mock('../MessageStore', () => ({
  __esModule: true,
  default: {
    createAgentSwitchEvent: (...args: unknown[]) => mockCreateAgentSwitchEvent(...args),
  },
}));

jest.mock('../SourceService', () => ({
  __esModule: true,
  default: {
    getSessionSource: (...args: unknown[]) => mockGetSessionSource(...args),
  },
}));

jest.mock('../ThreadService', () => ({
  __esModule: true,
  default: {
    getOwnedThreadWithSession: (...args: unknown[]) => mockGetOwnedThreadWithSession(...args),
    getSelectedAgentDefinitionId: (thread: { metadata?: Record<string, unknown> }) => {
      const selectedDefinitionId = thread.metadata?.selectedAgentDefinitionId;
      if (typeof selectedDefinitionId === 'string' && selectedDefinitionId.trim()) {
        return selectedDefinitionId;
      }
      return null;
    },
    buildSelectedAgentDefinitionMetadataPatch: (agentId: string) => ({
      selectedAgentDefinitionId: agentId,
    }),
  },
}));

import AgentSelectionService, { AgentThreadAgentSwitchError } from '../AgentSelectionService';
import { SYSTEM_AGENT_DEFINITIONS } from '../systemAgentDefinitions';

const userIdentity = {
  userId: 'sample-user',
  githubUsername: 'sample-user',
  preferredUsername: 'sample-user',
  email: 'sample-user@example.com',
  firstName: 'Sample',
  lastName: 'User',
  displayName: '',
  gitUserName: 'Sample User',
  gitUserEmail: 'sample-user@example.com',
  roles: [],
};

const thread = {
  id: 7,
  uuid: 'thread-1',
  metadata: {},
};

const session = {
  id: 17,
  uuid: 'session-1',
};

const source = {
  id: 3,
  status: 'ready',
  input: {},
};

const customDefinition = {
  id: 'custom.sample-agent',
  version: 2,
  owner: { kind: 'user' as const, userId: 'sample-user' },
  name: 'Sample custom agent',
  description: 'Uses allowed capabilities',
  instructionRefs: [],
  instructionAddendum: 'Focus on concise answers.',
  capabilityRefs: ['general_chat'],
  requiredCapabilityRefs: [],
  optionalCapabilityRefs: ['general_chat'],
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

function mockNoActiveRun() {
  const query = {
    where: jest.fn(() => query),
    whereNotIn: jest.fn(() => query),
    first: jest.fn().mockResolvedValue(null),
  };
  mockRunQuery.mockReturnValue(query);
}

describe('AgentSelectionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThreadTransaction.mockImplementation(async (callback) => callback({ trx: true }));
    mockThreadQuery.mockReturnValue({
      patchAndFetchById: jest
        .fn()
        .mockResolvedValue({ ...thread, metadata: { selectedAgentDefinitionId: 'custom.sample-agent' } }),
    });
    mockNoActiveRun();
    mockResolveSessionContext.mockResolvedValue({
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      capabilityPolicy: undefined,
    });
    mockEnsureSeeded.mockResolvedValue(Object.values(SYSTEM_AGENT_DEFINITIONS));
    mockListSystemDefinitions.mockResolvedValue(Object.values(SYSTEM_AGENT_DEFINITIONS));
    mockInferDefaultAgentDefinitionId.mockReturnValue('system.agent');
    mockInferDefaultAgentSourceKind.mockReturnValue('freeform_chat');
    mockGetOwnedThreadWithSession.mockResolvedValue({ thread, session });
    mockGetSessionSource.mockResolvedValue(source);
    mockListUserDefinitions.mockResolvedValue([customDefinition]);
    mockCreateAgentSwitchEvent.mockResolvedValue({ uuid: 'message-1' });
  });

  it('returns built_in and my_agents groups with selected, default, and current ids', async () => {
    const state = await AgentSelectionService.getThreadAgentState({ threadId: 'thread-1', userIdentity });

    expect(mockGetOwnedThreadWithSession).toHaveBeenCalledWith('thread-1', 'sample-user');
    expect(mockListUserDefinitions).toHaveBeenCalledWith({ userId: 'sample-user' });
    expect(state).toEqual(
      expect.objectContaining({
        selectedId: null,
        defaultId: 'system.agent',
        currentId: 'system.agent',
      })
    );
    expect(state.groups.map((group) => group.id)).toEqual(['built_in', 'my_agents']);
    expect(state.groups[0].agents.map((agent) => agent.id)).toEqual(['system.agent']);
    expect(state.groups[1].agents).toEqual([
      expect.objectContaining({
        id: 'custom.sample-agent',
        ownerKind: 'user',
        group: 'my_agents',
        label: 'Sample custom agent',
      }),
    ]);
  });

  it('marks user custom agents unavailable when a required capability becomes creator-reserved', async () => {
    mockResolveSessionContext.mockResolvedValueOnce({
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      capabilityPolicy: undefined,
      customAgentCreationPolicy: {
        capabilityAvailability: {
          read_context: 'reserved',
        },
      },
    });
    mockListUserDefinitions.mockResolvedValueOnce([
      {
        ...customDefinition,
        capabilityRefs: ['read_context'],
        requiredCapabilityRefs: ['read_context'],
        optionalCapabilityRefs: [],
      },
    ]);

    const state = await AgentSelectionService.getThreadAgentState({ threadId: 'thread-1', userIdentity });

    expect(state.groups[1].agents).toEqual([
      expect.objectContaining({
        id: 'custom.sample-agent',
        available: false,
        unavailableReason: 'disabled_by_policy',
        unavailableMessage: 'Sample custom agent is unavailable because a required capability is disabled.',
      }),
    ]);
  });

  it('switches to an owned custom agent and clears stale agent metadata', async () => {
    const result = await AgentSelectionService.switchThreadAgent({
      threadId: 'thread-1',
      userIdentity,
      agentId: 'custom.sample-agent',
    });

    expect(result.switched).toBe(true);
    expect(mockThreadQuery().patchAndFetchById).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        metadata: { selectedAgentDefinitionId: 'custom.sample-agent' },
      })
    );
    expect(mockCreateAgentSwitchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeAgent: { id: 'system.agent', label: 'Lifecycle Agent' },
        afterAgent: { id: 'custom.sample-agent', label: 'Sample custom agent' },
      })
    );
  });

  it('rejects another user custom id and writes no preference', async () => {
    await expect(
      AgentSelectionService.switchThreadAgent({
        threadId: 'thread-1',
        userIdentity,
        agentId: 'custom.another-user-agent',
      })
    ).rejects.toMatchObject({
      reason: 'unknown_agent',
    });

    expect(mockThreadQuery().patchAndFetchById).not.toHaveBeenCalled();
    expect(mockCreateAgentSwitchEvent).not.toHaveBeenCalled();
  });

  it('marks workspace custom agents as needing conversion and writes no preference', async () => {
    mockListUserDefinitions.mockResolvedValueOnce([
      {
        ...customDefinition,
        resourcePolicy: {
          sourceKinds: ['workspace_session'],
          workspaceRequired: true,
          sandboxRequired: true,
        },
      },
    ]);

    await expect(
      AgentSelectionService.switchThreadAgent({
        threadId: 'thread-1',
        userIdentity,
        agentId: 'custom.sample-agent',
      })
    ).rejects.toMatchObject({
      reason: 'needs_conversion',
    });

    expect(mockThreadQuery().patchAndFetchById).not.toHaveBeenCalled();
    expect(mockCreateAgentSwitchEvent).not.toHaveBeenCalled();
  });

  it('rejects active run switches and leaves the old selection visible', async () => {
    const query = {
      where: jest.fn(() => query),
      whereNotIn: jest.fn(() => query),
      first: jest.fn().mockResolvedValue({ id: 99, status: 'running' }),
    };
    mockRunQuery.mockReturnValue(query);

    await expect(
      AgentSelectionService.switchThreadAgent({
        threadId: 'thread-1',
        userIdentity,
        agentId: 'custom.sample-agent',
      })
    ).rejects.toMatchObject({
      reason: 'active_run',
    });

    expect(mockThreadQuery().patchAndFetchById).not.toHaveBeenCalled();
  });

  it('excludes archived custom definitions from my_agents state', async () => {
    mockListUserDefinitions.mockResolvedValueOnce([
      customDefinition,
      { ...customDefinition, id: 'custom.archived-agent', name: 'Archived', status: 'archived' },
    ]);

    const state = await AgentSelectionService.getThreadAgentState({ threadId: 'thread-1', userIdentity });

    expect(JSON.stringify(state.groups)).not.toContain('custom.archived-agent');
    expect(state.groups[1].agents).toHaveLength(1);
  });

  it('does not write an event for no-op switches', async () => {
    mockGetOwnedThreadWithSession.mockResolvedValueOnce({
      thread: { ...thread, metadata: { selectedAgentDefinitionId: 'custom.sample-agent' } },
      session,
    });

    const result = await AgentSelectionService.switchThreadAgent({
      threadId: 'thread-1',
      userIdentity,
      agentId: 'custom.sample-agent',
    });

    expect(result.switched).toBe(false);
    expect(mockCreateAgentSwitchEvent).not.toHaveBeenCalled();
  });

  it('raises typed unknown-agent errors', async () => {
    await expect(
      AgentSelectionService.switchThreadAgent({
        threadId: 'thread-1',
        userIdentity,
        agentId: 'custom.missing',
      })
    ).rejects.toBeInstanceOf(AgentThreadAgentSwitchError);
  });
});
