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

const mockWarn = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    warn: mockWarn,
  })),
}));

const mockResolveSessionContext = jest.fn();

jest.mock('server/services/agent/CapabilityService', () => ({
  __esModule: true,
  default: {
    resolveSessionContext: (...args: unknown[]) => mockResolveSessionContext(...args),
  },
}));

const mockResolveSelection = jest.fn();
const mockEnsureSystemAgentDefinitionsSeeded = jest.fn();
const mockGetSystemAgentDefinition = jest.fn();
const mockGetUserDefinition = jest.fn();
const mockResolveRunAdmissionChoices = jest.fn();

jest.mock('server/services/agent/ProviderRegistry', () => ({
  __esModule: true,
  default: {
    resolveSelection: (...args: unknown[]) => mockResolveSelection(...args),
  },
}));

jest.mock('../AgentDefinitionRegistry', () => {
  const actual = jest.requireActual('../AgentDefinitionRegistry');
  return {
    __esModule: true,
    ...actual,
    ensureSystemAgentDefinitionsSeeded: (...args: unknown[]) => mockEnsureSystemAgentDefinitionsSeeded(...args),
    getSystemAgentDefinition: (...args: unknown[]) => mockGetSystemAgentDefinition(...args),
  };
});

jest.mock('../CustomAgentDefinitionService', () => {
  class MockCustomAgentDefinitionServiceError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = 'CustomAgentDefinitionServiceError';
      this.code = code;
    }
  }

  return {
    __esModule: true,
    CustomAgentDefinitionServiceError: MockCustomAgentDefinitionServiceError,
    customAgentDefinitionService: {
      getUserDefinition: (...args: unknown[]) => mockGetUserDefinition(...args),
    },
  };
});

jest.mock('../ThreadRuntimeControlsService', () => ({
  __esModule: true,
  default: {
    resolveRunAdmissionChoices: (...args: unknown[]) => mockResolveRunAdmissionChoices(...args),
  },
}));

import AgentRunPlanResolver, {
  AgentRunPlanCapabilityUnavailableError,
  AgentRunPlanAgentUnavailableError,
} from '../RunPlanResolver';
import { CustomAgentDefinitionServiceError } from '../CustomAgentDefinitionService';
import { serializeRunPlanSummary } from '../runPlanSummary';
import { SYSTEM_AGENT_DEFINITIONS } from '../systemAgentDefinitions';
import { AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';

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

const customDefinition = {
  id: 'custom.sample-agent',
  version: 3,
  owner: { kind: 'user' as const, userId: 'sample-user' },
  name: 'Sample custom agent',
  description: 'Custom agent description',
  instructionRefs: [],
  instructionAddendum: 'Use the sample custom instructions.',
  capabilityRefs: ['read_context'],
  requiredCapabilityRefs: [],
  optionalCapabilityRefs: ['read_context'],
  resourcePolicy: {
    sourceKinds: ['freeform_chat'],
    workspaceRequired: false,
    sandboxRequired: false,
  },
  modelPreference: {
    provider: 'openai',
    model: 'gpt-5.4',
  },
  status: 'active' as const,
  codeOwned: false,
  readOnly: false,
};

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    uuid: 'session-1',
    sessionKind: AgentSessionKind.CHAT,
    defaultHarness: 'lifecycle_ai_sdk',
    defaultModel: 'gpt-5.4',
    buildUuid: null,
    namespace: 'sample-namespace',
    workspaceRepos: [
      {
        repo: 'example-org/example-repo',
        branch: 'main',
        primary: true,
      },
    ],
    selectedServices: [
      {
        name: 'sample-service',
        repo: 'example-org/example-repo',
        branch: 'main',
      },
    ],
    ...overrides,
  } as any;
}

function buildSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    uuid: 'source-1',
    adapter: 'blank_workspace',
    status: 'ready',
    input: {},
    preparedSource: {},
    sandboxRequirements: { filesystem: 'persistent' },
    preparedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  } as any;
}

async function resolve(
  overrides: {
    thread?: Record<string, unknown>;
    session?: Record<string, unknown>;
    source?: Record<string, unknown>;
  } = {}
) {
  return AgentRunPlanResolver.resolveForRunAdmission({
    thread: { id: 7, uuid: 'thread-1', metadata: {}, ...overrides.thread } as any,
    session: buildSession(overrides.session),
    source: buildSource(overrides.source),
    userIdentity,
    requestedProvider: null,
    requestedModel: null,
    runtimeOptions: { maxIterations: 12 },
  });
}

describe('AgentRunPlanResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveSessionContext.mockResolvedValue({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      capabilityPolicy: undefined,
    });
    mockResolveSelection.mockResolvedValue({
      provider: 'openai',
      modelId: 'gpt-5.4',
    });
    mockEnsureSystemAgentDefinitionsSeeded.mockResolvedValue(Object.values(SYSTEM_AGENT_DEFINITIONS));
    mockGetSystemAgentDefinition.mockImplementation(async (agentId) => SYSTEM_AGENT_DEFINITIONS[agentId]);
    mockGetUserDefinition.mockResolvedValue(customDefinition);
    mockResolveRunAdmissionChoices.mockResolvedValue({
      metadataPresent: false,
      selectedRuntimeToolChoiceIds: undefined,
      selectedRuntimeMcpChoiceIds: undefined,
      selectedRuntimeCapabilityIds: undefined,
      selectedRuntimeMcpConnectionRefs: undefined,
    });
  });

  it('infers Debug for build-context chat before generic chat', async () => {
    const result = await resolve({
      source: {
        input: { buildUuid: 'build-1', branchName: 'feature-branch' },
      },
    });

    expect(result.runPlanSnapshot.agent.id).toBe('system.debug');
    expect(result.runPlanSnapshot.agent.label).toBe('Debug');
    expect(result.runPlanSnapshot.agent.sourceKind).toBe('build_context_chat');
    expect(result.runPlanSnapshot.source.buildUuid).toBe('build-1');
    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(
      expect.arrayContaining(['diagnostics_codefresh', 'diagnostics_kubernetes', 'diagnostics_database'])
    );
    expect(result.runPlanSnapshot.capabilities.resolvedCapabilityAccess).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: 'diagnostics_codefresh',
          availability: 'system_only',
          allowed: true,
          runtimeCapabilityKey: 'read',
        }),
      ])
    );
  });

  it('infers Free-form for chat sessions without build context', async () => {
    const result = await resolve();

    expect(result.runPlanSnapshot.agent.id).toBe('system.freeform');
    expect(result.runPlanSnapshot.agent.label).toBe('Free-form');
    expect(result.runPlanSnapshot.agent.sourceKind).toBe('freeform_chat');
    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(['read_context', 'external_mcp_read']);
    expect(serializeRunPlanSummary(result.runPlanSnapshot)?.agent).toEqual(
      expect.objectContaining({
        id: 'system.freeform',
        label: 'Free-form',
      })
    );
  });

  it('does not apply creator-reserved policy to system agent definitions during run admission', async () => {
    mockResolveSessionContext.mockResolvedValueOnce({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      customAgentCreationPolicy: {
        capabilityAvailability: {
          external_mcp_read: 'reserved',
        },
      },
    });

    const result = await resolve();

    expect(result.runPlanSnapshot.agent.id).toBe('system.freeform');
    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(['read_context', 'external_mcp_read']);
    expect(result.runPlanSnapshot.capabilities.resolvedCapabilityAccess).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: 'external_mcp_read',
          allowed: true,
        }),
      ])
    );
  });

  it('infers Develop for environment and sandbox workspace sessions', async () => {
    const environment = await resolve({
      session: {
        sessionKind: AgentSessionKind.ENVIRONMENT,
      },
      source: {
        adapter: 'lifecycle_environment',
      },
    });
    const sandbox = await resolve({
      session: {
        sessionKind: AgentSessionKind.SANDBOX,
      },
      source: {
        adapter: 'lifecycle_fork',
      },
    });

    expect(environment.runPlanSnapshot.agent.id).toBe('system.develop');
    expect(environment.runPlanSnapshot.agent.sourceKind).toBe('workspace_session');
    expect(environment.runPlanSnapshot.source).toEqual(
      expect.objectContaining({
        adapter: 'lifecycle_environment',
        sessionKind: AgentSessionKind.ENVIRONMENT,
        repoFullName: 'example-org/example-repo',
        namespace: 'sample-namespace',
      })
    );
    expect(environment.runPlanSnapshot.source.workspaceLayout).toEqual(
      expect.objectContaining({
        repoCount: 1,
        selectedServiceCount: 1,
        primaryService: 'sample-service',
      })
    );
    expect(sandbox.runPlanSnapshot.agent.id).toBe('system.develop');
    expect(sandbox.runPlanSnapshot.agent.sourceKind).toBe('workspace_session');
    expect(sandbox.runPlanSnapshot.source).toEqual(
      expect.objectContaining({
        adapter: 'lifecycle_fork',
        sessionKind: AgentSessionKind.SANDBOX,
      })
    );
  });

  it('uses a valid selected thread agent preference for future run admission', async () => {
    const result = await resolve({
      thread: {
        metadata: { selectedAgentDefinitionId: 'system.debug' },
      },
      source: {
        input: { buildUuid: 'build-1' },
      },
    });

    expect(result.runPlanSnapshot.agent.id).toBe('system.debug');
    expect(mockGetSystemAgentDefinition).toHaveBeenCalledWith('system.debug');
  });

  it('resolves selected owned custom agents and snapshots definition details for run admission', async () => {
    const result = await resolve({
      thread: {
        metadata: { selectedAgentDefinitionId: 'custom.sample-agent' },
      },
    });

    expect(mockGetUserDefinition).toHaveBeenCalledWith('custom.sample-agent', 'sample-user');
    expect(result.runPlanSnapshot.agent).toEqual(
      expect.objectContaining({
        id: 'custom.sample-agent',
        label: 'Sample custom agent',
        ownerKind: 'user',
        version: 3,
        modelPreference: {
          provider: 'openai',
          model: 'gpt-5.4',
        },
        resourcePolicy: expect.objectContaining({
          sourceKinds: ['freeform_chat'],
        }),
      })
    );
    expect(result.runPlanSnapshot.prompt).toEqual(
      expect.objectContaining({
        instructionAddendum: 'Use the sample custom instructions.',
        renderedSummary: 'Custom agent description',
      })
    );
    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(['read_context']);
    expect(result.runPlanSnapshot.source).toEqual(
      expect.objectContaining({
        adapter: 'blank_workspace',
        sessionKind: AgentSessionKind.CHAT,
        buildUuid: null,
      })
    );
    expect(serializeRunPlanSummary(result.runPlanSnapshot)?.agent).toEqual(
      expect.objectContaining({
        id: 'custom.sample-agent',
        label: 'Sample custom agent',
      })
    );
  });

  it('never loads another user custom id across ownership and falls back to the source default', async () => {
    mockGetUserDefinition.mockRejectedValueOnce(new CustomAgentDefinitionServiceError('not_found', 'Agent not found.'));

    const result = await resolve({
      thread: {
        metadata: { selectedAgentDefinitionId: 'custom.another-user-agent' },
      },
    });

    expect(mockGetUserDefinition).toHaveBeenCalledWith('custom.another-user-agent', 'sample-user');
    expect(result.runPlanSnapshot.agent.id).toBe('system.freeform');
    expect(result.runPlanSnapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'selected_agent_unavailable',
        }),
      ])
    );
  });

  it('falls back from archived selected custom agents with selected_agent_unavailable warning', async () => {
    mockGetUserDefinition.mockRejectedValueOnce(new CustomAgentDefinitionServiceError('not_found', 'Agent not found.'));

    const result = await resolve({
      thread: {
        metadata: { selectedAgentDefinitionId: 'custom.archived-agent' },
      },
    });

    expect(result.runPlanSnapshot.agent.id).toBe('system.freeform');
    expect(result.runPlanSnapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'selected_agent_unavailable',
          message: expect.not.stringContaining('custom.archived-agent'),
        }),
      ])
    );
  });

  it('fails closed when selected custom-agent lookup has an unexpected error', async () => {
    mockGetUserDefinition.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      resolve({
        thread: {
          metadata: { selectedAgentDefinitionId: 'custom.sample-agent' },
        },
      })
    ).rejects.toThrow('database unavailable');

    expect(mockGetSystemAgentDefinition).not.toHaveBeenCalledWith('system.freeform');
  });

  it('rejects restricted required capability refs on custom definitions before admission fields are returned', async () => {
    mockResolveSessionContext.mockResolvedValueOnce({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      capabilityPolicy: {
        availability: {
          external_mcp_write: 'admin_only',
        },
      },
    });
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      capabilityRefs: ['external_mcp_write'],
      requiredCapabilityRefs: ['external_mcp_write'],
      optionalCapabilityRefs: [],
    });

    await expect(
      resolve({
        thread: {
          metadata: { selectedAgentDefinitionId: 'custom.sample-agent' },
        },
      })
    ).rejects.toThrow(AgentRunPlanCapabilityUnavailableError);
  });

  it('rejects creator-reserved required capability refs on user custom definitions before admission fields are returned', async () => {
    mockResolveSessionContext.mockResolvedValueOnce({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      capabilityPolicy: {
        availability: {
          read_context: 'all_users',
        },
      },
      customAgentCreationPolicy: {
        capabilityAvailability: {
          read_context: 'reserved',
        },
      },
    });
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      capabilityRefs: ['read_context'],
      requiredCapabilityRefs: ['read_context'],
      optionalCapabilityRefs: [],
    });

    await expect(
      resolve({
        thread: {
          metadata: { selectedAgentDefinitionId: 'custom.sample-agent' },
        },
      })
    ).rejects.toMatchObject({
      capabilityId: 'read_context',
      reason: 'creator_capability_reserved',
    });
  });

  it('skips optional custom capabilities that become unavailable at runtime', async () => {
    mockResolveSessionContext.mockResolvedValueOnce({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      capabilityPolicy: {
        availability: {
          external_mcp_write: 'disabled',
        },
      },
    });
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      capabilityRefs: ['read_context', 'external_mcp_write'],
      requiredCapabilityRefs: [],
      optionalCapabilityRefs: ['read_context', 'external_mcp_write'],
    });

    const result = await resolve({
      thread: {
        metadata: { selectedAgentDefinitionId: 'custom.sample-agent' },
      },
    });

    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(['read_context']);
    expect(result.runPlanSnapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'optional_capability_unavailable',
        }),
      ])
    );
  });

  it('skips creator-reserved optional custom capabilities with sanitized warnings', async () => {
    mockResolveSessionContext.mockResolvedValueOnce({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      capabilityPolicy: {
        availability: {
          external_mcp_read: 'all_users',
        },
      },
      customAgentCreationPolicy: {
        capabilityAvailability: {
          external_mcp_read: 'reserved',
        },
      },
    });
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      capabilityRefs: ['read_context', 'external_mcp_read'],
      requiredCapabilityRefs: ['read_context'],
      optionalCapabilityRefs: ['external_mcp_read'],
    });

    const result = await resolve({
      thread: {
        metadata: { selectedAgentDefinitionId: 'custom.sample-agent' },
      },
    });

    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(['read_context']);
    expect(result.runPlanSnapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'optional_capability_unavailable',
          message: 'MCP read is unavailable and was skipped.',
          detail: {
            reason: 'creator_capability_reserved',
          },
        }),
      ])
    );
    expect(JSON.stringify(serializeRunPlanSummary(result.runPlanSnapshot))).not.toContain('external_mcp_read');
  });

  it('blocks Develop when the selected agent lacks prepared workspace resources', async () => {
    await expect(
      resolve({
        thread: {
          metadata: { selectedAgentDefinitionId: 'system.develop' },
        },
      })
    ).rejects.toThrow(AgentRunPlanAgentUnavailableError);
  });

  it('allows Develop when a chat session workspace runtime is ready', async () => {
    const result = await resolve({
      session: {
        workspaceStatus: AgentWorkspaceStatus.READY,
        podName: 'agent-session-pod',
        pvcName: 'agent-session-pvc',
      },
      thread: {
        metadata: { selectedAgentDefinitionId: 'system.develop' },
      },
    });

    expect(result.runPlanSnapshot.agent.id).toBe('system.develop');
    expect(result.runPlanSnapshot.agent.sourceKind).toBe('workspace_session');
    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(
      expect.arrayContaining(['workspace_files', 'workspace_shell', 'workspace_git'])
    );
  });

  it('stores compact repo and service summaries instead of full arrays', async () => {
    const result = await resolve({
      session: {
        workspaceRepos: [
          { repo: 'example-org/secondary-repo', branch: 'main' },
          { repo: 'example-org/primary-repo', branch: 'feature-branch', primary: true },
        ],
        selectedServices: [
          { name: 'sample-service', repo: 'example-org/primary-repo', branch: 'feature-branch' },
          { name: 'sample-worker', repo: 'example-org/primary-repo', branch: 'feature-branch' },
        ],
      },
    });

    expect(result.runPlanSnapshot.source.workspaceLayout).toEqual(
      expect.objectContaining({
        repoCount: 2,
        primaryRepo: 'example-org/primary-repo',
        selectedServiceCount: 2,
        primaryService: 'sample-service',
      })
    );
    expect(JSON.stringify(result.runPlanSnapshot.source)).not.toContain('sample-worker');
  });

  it('warns and continues when the session harness default is not supported', async () => {
    const result = await resolve({
      session: {
        defaultHarness: 'legacy_harness',
      },
    });

    expect(result.resolvedHarness).toBe('lifecycle_ai_sdk');
    expect(result.runPlanSnapshot.warnings).toEqual([
      expect.objectContaining({
        code: 'unsupported_harness_default',
      }),
    ]);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('rejects unavailable capability refs before admission fields are returned', async () => {
    mockResolveSessionContext.mockResolvedValueOnce({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      capabilityPolicy: {
        availability: {
          diagnostics_codefresh: 'disabled',
        },
      },
    });

    await expect(
      resolve({
        source: {
          input: { buildUuid: 'build-1' },
        },
      })
    ).rejects.toThrow(AgentRunPlanCapabilityUnavailableError);
  });

  it('blocks disabled selected agents before admission fields are returned', async () => {
    mockGetSystemAgentDefinition.mockResolvedValueOnce({
      ...SYSTEM_AGENT_DEFINITIONS['system.freeform'],
      status: 'disabled',
    });

    await expect(resolve()).rejects.toThrow(AgentRunPlanAgentUnavailableError);
  });

  it('resolves policy and model selection from current services', async () => {
    const result = await AgentRunPlanResolver.resolveForRunAdmission({
      thread: { id: 7, uuid: 'thread-1' } as any,
      session: buildSession(),
      source: buildSource(),
      userIdentity,
      requestedProvider: 'openai',
      requestedModel: 'gpt-5.4',
      runtimeOptions: {},
    });

    expect(mockResolveSessionContext).toHaveBeenCalledWith('session-1', userIdentity);
    expect(mockResolveSelection).toHaveBeenCalledWith({
      repoFullName: 'example-org/example-repo',
      requestedProvider: 'openai',
      requestedModelId: 'gpt-5.4',
    });
    expect(result.runPlanSnapshot.prompt.renderedHash).toEqual(expect.any(String));
    expect(JSON.stringify(result.runPlanSnapshot.prompt)).not.toContain('DB prompt as stored');
  });

  it('uses durable session default provider when a run omits provider', async () => {
    await AgentRunPlanResolver.resolveForRunAdmission({
      thread: { id: 7, uuid: 'thread-1' } as any,
      session: buildSession({ defaultModel: 'shared-model' }),
      source: buildSource({
        input: {
          defaults: {
            provider: 'sample-provider-b',
            model: 'shared-model',
          },
        },
      }),
      userIdentity,
      requestedProvider: null,
      requestedModel: null,
      runtimeOptions: {},
    });

    expect(mockResolveSelection).toHaveBeenCalledWith({
      repoFullName: 'example-org/example-repo',
      requestedProvider: 'sample-provider-b',
      requestedModelId: 'shared-model',
    });
  });

  it('snapshots explicit empty runtime choices without removing required capabilities', async () => {
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      capabilityRefs: ['read_context', 'external_mcp_read'],
      requiredCapabilityRefs: ['read_context'],
      optionalCapabilityRefs: ['external_mcp_read'],
    });
    mockResolveRunAdmissionChoices.mockResolvedValueOnce({
      metadataPresent: true,
      selectedRuntimeToolChoiceIds: ['choice-required-read-context'],
      selectedRuntimeMcpChoiceIds: [],
      selectedRuntimeCapabilityIds: ['read_context'],
      selectedRuntimeMcpConnectionRefs: [],
    });

    const result = await resolve({
      thread: {
        metadata: {
          selectedAgentDefinitionId: 'custom.sample-agent',
          runtimeControlChoices: {
            version: 1,
            toolChoiceIds: [],
            mcpChoiceIds: [],
          },
        },
      },
    });

    expect(mockResolveRunAdmissionChoices).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ uuid: 'thread-1' }),
        definition: expect.objectContaining({ id: 'custom.sample-agent' }),
        sourceKind: 'freeform_chat',
      })
    );
    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(['read_context']);
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeToolChoiceIds).toEqual(['choice-required-read-context']);
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeCapabilityIds).toEqual(['read_context']);
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeMcpChoiceIds).toEqual([]);
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeMcpConnectionRefs).toEqual([]);
  });

  it('adds selected optional runtime tool capabilities to the next run snapshot', async () => {
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      capabilityRefs: ['read_context', 'external_mcp_read'],
      requiredCapabilityRefs: ['read_context'],
      optionalCapabilityRefs: ['external_mcp_read'],
    });
    mockResolveRunAdmissionChoices.mockResolvedValueOnce({
      metadataPresent: true,
      selectedRuntimeToolChoiceIds: ['choice-required-read-context', 'choice-mcp-read'],
      selectedRuntimeMcpChoiceIds: ['choice-mcp-sample'],
      selectedRuntimeCapabilityIds: ['read_context', 'external_mcp_read'],
      selectedRuntimeMcpConnectionRefs: ['user:sample-mcp'],
    });

    const result = await resolve({
      thread: {
        metadata: {
          selectedAgentDefinitionId: 'custom.sample-agent',
          runtimeControlChoices: {
            version: 1,
            toolChoiceIds: ['choice-mcp-read'],
            mcpChoiceIds: ['choice-mcp-sample'],
          },
        },
      },
    });

    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(['read_context', 'external_mcp_read']);
    expect(result.runPlanSnapshot.capabilities.resolvedCapabilityAccess).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: 'external_mcp_read',
          allowed: true,
        }),
      ])
    );
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeCapabilityIds).toEqual([
      'read_context',
      'external_mcp_read',
    ]);
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeMcpConnectionRefs).toEqual(['user:sample-mcp']);
  });

  it('preserves current optional capability and MCP behavior when runtime metadata is absent', async () => {
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      capabilityRefs: ['read_context', 'external_mcp_read'],
      requiredCapabilityRefs: ['read_context'],
      optionalCapabilityRefs: ['external_mcp_read'],
    });

    const result = await resolve({
      thread: {
        metadata: { selectedAgentDefinitionId: 'custom.sample-agent' },
      },
    });

    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(['read_context', 'external_mcp_read']);
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeToolChoiceIds).toBeUndefined();
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeMcpChoiceIds).toBeUndefined();
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeMcpConnectionRefs).toBeUndefined();
  });

  it('omits policy-denied selected optional choices with sanitized warnings', async () => {
    mockResolveSessionContext.mockResolvedValueOnce({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      capabilityPolicy: {
        availability: {
          external_mcp_write: 'disabled',
        },
      },
    });
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      capabilityRefs: ['read_context', 'external_mcp_write'],
      requiredCapabilityRefs: ['read_context'],
      optionalCapabilityRefs: ['external_mcp_write'],
    });
    mockResolveRunAdmissionChoices.mockResolvedValueOnce({
      metadataPresent: true,
      selectedRuntimeToolChoiceIds: ['choice-required-read-context', 'choice-mcp-write'],
      selectedRuntimeMcpChoiceIds: [],
      selectedRuntimeCapabilityIds: ['read_context', 'external_mcp_write'],
      selectedRuntimeMcpConnectionRefs: [],
    });

    const result = await resolve({
      thread: {
        metadata: {
          selectedAgentDefinitionId: 'custom.sample-agent',
          runtimeControlChoices: {
            version: 1,
            toolChoiceIds: ['choice-mcp-write'],
            mcpChoiceIds: [],
          },
        },
      },
    });

    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(['read_context']);
    expect(result.runPlanSnapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'optional_capability_unavailable',
          message: expect.stringContaining('MCP write'),
        }),
      ])
    );
    expect(JSON.stringify(serializeRunPlanSummary(result.runPlanSnapshot))).not.toContain('external_mcp_write');
    expect(JSON.stringify(serializeRunPlanSummary(result.runPlanSnapshot))).not.toContain('choice-mcp-write');
    expect(result.runPlanSnapshot.capabilities.resolvedCapabilityAccess).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: 'external_mcp_write',
        }),
      ])
    );
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeToolChoiceIds).toEqual([]);
  });

  it('omits creator-reserved selected optional MCP choices with sanitized warnings', async () => {
    mockResolveSessionContext.mockResolvedValueOnce({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      customAgentCreationPolicy: {
        capabilityAvailability: {
          external_mcp_read: 'reserved',
        },
      },
    });
    mockGetUserDefinition.mockResolvedValueOnce({
      ...customDefinition,
      capabilityRefs: ['read_context', 'external_mcp_read'],
      requiredCapabilityRefs: ['read_context'],
      optionalCapabilityRefs: ['external_mcp_read'],
    });
    mockResolveRunAdmissionChoices.mockResolvedValueOnce({
      metadataPresent: true,
      selectedRuntimeToolChoiceIds: ['choice-required-read-context'],
      selectedRuntimeMcpChoiceIds: ['choice-mcp-sample'],
      selectedRuntimeCapabilityIds: ['read_context', 'external_mcp_read'],
      selectedRuntimeMcpConnectionRefs: ['user:sample-mcp'],
    });

    const result = await resolve({
      thread: {
        metadata: {
          selectedAgentDefinitionId: 'custom.sample-agent',
          runtimeControlChoices: {
            version: 1,
            toolChoiceIds: [],
            mcpChoiceIds: ['choice-mcp-sample'],
          },
        },
      },
    });

    expect(result.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual(['read_context']);
    expect(result.runPlanSnapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'optional_capability_unavailable',
          detail: {
            reason: 'creator_capability_reserved',
          },
        }),
      ])
    );
    expect(JSON.stringify(serializeRunPlanSummary(result.runPlanSnapshot))).not.toContain('external_mcp_read');
    expect(JSON.stringify(serializeRunPlanSummary(result.runPlanSnapshot))).not.toContain('choice-mcp-sample');
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeToolChoiceIds).toEqual([]);
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeMcpChoiceIds).toEqual([]);
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeMcpConnectionRefs).toEqual([]);
  });
});
