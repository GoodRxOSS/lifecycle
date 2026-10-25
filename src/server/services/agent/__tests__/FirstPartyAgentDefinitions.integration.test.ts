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

const mockDefinitionUpsert = jest.fn();
const mockDefinitionFindOne = jest.fn();
const mockDefinitionOrderBy = jest.fn();
const mockDefinitionWhere = jest.fn();
const mockDefinitionWhereIn = jest.fn();
const mockDefinitionQuery = jest.fn(() => ({
  findOne: (...args: unknown[]) => mockDefinitionFindOne(...args),
  whereIn: (...args: unknown[]) => {
    mockDefinitionWhereIn(...args);
    return {
      where: (...whereArgs: unknown[]) => {
        mockDefinitionWhere(...whereArgs);
        return {
          orderBy: (...orderArgs: unknown[]) => mockDefinitionOrderBy(...orderArgs),
        };
      },
    };
  },
}));

const mockResolveSessionContext = jest.fn();
const mockResolveSelection = jest.fn();
const mockThreadTransaction = jest.fn();
const mockThreadQuery = jest.fn();
const mockPatchAndFetchById = jest.fn();
const mockRunQuery = jest.fn();
const mockMessageQuery = jest.fn();
const mockInsertAndFetch = jest.fn();
const mockGetSessionSource = jest.fn();
const mockGetOwnedThreadWithSession = jest.fn();
const mockSeedSystemTemplates = jest.fn();
const mockResolveInstructionRefs = jest.fn();
const mockWarn = jest.fn();
const mockResolveMcpServers = jest.fn();
const mockListMcpConnections = jest.fn();
const mockDiscoverPendingServerTools = jest.fn();

let mockDefinitionRows: any[] = [];
let mockActiveRunResults: any[] = [];

jest.mock('server/models/AgentDefinition', () => ({
  __esModule: true,
  default: {
    upsert: (...args: unknown[]) => mockDefinitionUpsert(...args),
    query: (...args: unknown[]) => mockDefinitionQuery.apply(null, args),
  },
}));

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

jest.mock('server/models/AgentMessage', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockMessageQuery(...args),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    warn: mockWarn,
  })),
}));

jest.mock('../CapabilityService', () => ({
  __esModule: true,
  default: {
    resolveSessionContext: (...args: unknown[]) => mockResolveSessionContext(...args),
    buildToolSetWithMetadata: (options: unknown) =>
      jest.requireActual('../CapabilityService').default.buildToolSetWithMetadata(options),
  },
}));

jest.mock('../aiSdkRuntime', () => ({
  loadAiSdk: async () => ({ dynamicTool: (config: unknown) => config, jsonSchema: (schema: unknown) => schema }),
}));

jest.mock('server/services/agentRuntime/mcp/config', () => {
  const actual = jest.requireActual('server/services/agentRuntime/mcp/config');
  return {
    ...actual,
    McpConfigService: jest.fn().mockImplementation(() => ({
      resolveServers: (...args: unknown[]) => mockResolveMcpServers(...args),
      listEnabledConnectionsForUser: (...args: unknown[]) => mockListMcpConnections(...args),
      discoverPendingServerTools: (...args: unknown[]) => mockDiscoverPendingServerTools(...args),
    })),
  };
});

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getEffectiveConfig: async () => ({}) }) },
}));

jest.mock('../diagnosticTools', () => ({
  registerLifecycleDiagnosticReadTools: jest.fn(),
  registerLifecycleDiagnosticFixTools: jest.fn(),
}));

jest.mock('server/services/workspaceCoreMcp/config', () => ({ isWorkspaceCoreMcpEnabled: () => false }));

jest.mock('../chatWorkspaceToolRegistration', () => ({
  isChatWorkspaceRuntimeReady: () => true,
  resolveSessionWorkspaceGatewayServer: async () => ({ slug: 'workspace', discoveredTools: [] }),
  resolveSessionGatewayEndpoint: async () => ({ url: 'http://workspace-gateway.test' }),
  resolveSessionExecutionServer: async (_session: unknown, server: Record<string, unknown>) => ({
    ...server,
    transport: { type: 'http', url: 'http://workspace-gateway.test/servers/sample/mcp' },
  }),
}));

jest.mock('../InstructionTemplateService', () => {
  class MockInstructionTemplateServiceError extends Error {
    statusCode: number;
    details?: Record<string, unknown>;

    constructor(
      public readonly code: string,
      message: string,
      options: { statusCode?: number; details?: Record<string, unknown> } = {}
    ) {
      super(message);
      this.name = 'InstructionTemplateServiceError';
      this.statusCode = options.statusCode ?? (code === 'unknown_ref' ? 404 : 400);
      this.details = options.details;
    }
  }

  return {
    __esModule: true,
    default: {
      seedSystemTemplates: (...args: unknown[]) => mockSeedSystemTemplates(...args),
      resolveRefs: (...args: unknown[]) => mockResolveInstructionRefs(...args),
    },
    InstructionTemplateServiceError: MockInstructionTemplateServiceError,
  };
});

jest.mock('../InstructionRuleService', () => ({
  __esModule: true,
  default: {
    resolveForRun: jest.fn(async () => []),
  },
}));

jest.mock('../ProviderRegistry', () => ({
  __esModule: true,
  default: {
    resolveSelection: (...args: unknown[]) => mockResolveSelection(...args),
  },
}));

jest.mock('../SourceService', () => ({
  __esModule: true,
  default: {
    getSessionSource: (...args: unknown[]) => mockGetSessionSource(...args),
  },
}));

jest.mock('../ThreadService', () => {
  const actual = jest.requireActual('../ThreadService');
  return {
    __esModule: true,
    ...actual,
    default: {
      getOwnedThreadWithSession: (...args: unknown[]) => mockGetOwnedThreadWithSession(...args),
      getSelectedAgentDefinitionId: actual.getSelectedAgentDefinitionId,
      getRuntimeControlChoices: actual.getRuntimeControlChoices,
      serializeThread: jest.fn(),
    },
  };
});

jest.mock('uuid', () => ({
  v4: jest.fn(() => '11111111-1111-4111-8111-111111111111'),
}));

import { AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';
import {
  ensureSystemAgentDefinitionsSeeded,
  getSystemAgentDefinition,
  serializeAgentDefinitionSummary,
} from '../AgentDefinitionRegistry';
import AgentRunPlanResolver, { AgentRunPlanAgentUnavailableError } from '../RunPlanResolver';
import AgentPolicyService from '../PolicyService';
import { serializeRunPlanSummary } from '../runPlanSummary';
import { SYSTEM_AGENT_DEFINITIONS, SYSTEM_AGENT_DEFINITION_IDS } from '../systemAgentDefinitions';
import type { AgentDefinitionContract } from '../agentDefinitionTypes';
import type { AgentCapabilityCatalogId } from '../capabilityCatalog';
import AgentCapabilityService from '../CapabilityService';
import AgentThreadRuntimeControlsService from '../ThreadRuntimeControlsService';
import type { ResolvedAgentCapabilityAccess } from '../PolicyService';
import { DEFAULT_AGENT_APPROVAL_POLICY, type AgentApprovalMode } from '../types';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';

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

function buildDefinitionRow(definition: AgentDefinitionContract) {
  return {
    definitionId: definition.id,
    version: definition.version,
    ownerKind: definition.owner.kind,
    ownerUserId: definition.owner.userId || null,
    ownerOrganizationId: definition.owner.organizationId || null,
    name: definition.name,
    description: definition.description || null,
    instructionRefs: definition.instructionRefs,
    instructionAddendum: definition.instructionAddendum || null,
    capabilityRefs: definition.capabilityRefs,
    requiredCapabilityRefs: definition.requiredCapabilityRefs || definition.capabilityRefs,
    optionalCapabilityRefs: definition.optionalCapabilityRefs || [],
    resourcePolicy: definition.resourcePolicy,
    modelPreference: definition.modelPreference || null,
    status: definition.status,
    codeOwned: Boolean(definition.codeOwned),
    readOnly: Boolean(definition.readOnly),
  };
}

function buildThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    uuid: 'sample-thread',
    sessionId: 17,
    metadata: {},
    ...overrides,
  } as any;
}

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    uuid: 'sample-session',
    userId: 'sample-user',
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
    uuid: 'sample-source',
    adapter: 'blank_workspace',
    status: 'ready',
    input: {},
    preparedSource: {},
    sandboxRequirements: {},
    preparedAt: null,
    ...overrides,
  } as any;
}

function mockActiveRuns(...results: any[]) {
  mockActiveRunResults = [...results];
}

async function resolveRunPlan({
  thread = {},
  session = {},
  source = {},
}: {
  thread?: Record<string, unknown>;
  session?: Record<string, unknown>;
  source?: Record<string, unknown>;
} = {}) {
  return AgentRunPlanResolver.resolveForRunAdmission({
    thread: buildThread(thread),
    session: buildSession(session),
    source: buildSource(source),
    userIdentity,
    requestedProvider: null,
    requestedModel: null,
    runtimeOptions: { maxIterations: 12 },
  });
}

function getCapabilityAccess(
  result: Awaited<ReturnType<typeof resolveRunPlan>>,
  capabilityId: AgentCapabilityCatalogId
) {
  return result.runPlanSnapshot.capabilities.resolvedCapabilityAccess.find(
    (capability) => capability.capabilityId === capabilityId
  );
}

describe('First-party agent definition integration regressions', () => {
  let thread: ReturnType<typeof buildThread>;
  let session: ReturnType<typeof buildSession>;
  let source: ReturnType<typeof buildSource>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockDefinitionRows = SYSTEM_AGENT_DEFINITION_IDS.map((agentId) =>
      buildDefinitionRow(SYSTEM_AGENT_DEFINITIONS[agentId])
    );
    thread = buildThread();
    session = buildSession();
    source = buildSource();
    mockActiveRuns();
    mockResolveMcpServers.mockResolvedValue([]);
    mockListMcpConnections.mockResolvedValue([]);
    mockDiscoverPendingServerTools.mockResolvedValue([]);

    mockDefinitionUpsert.mockImplementation(async (row) => row);
    mockDefinitionFindOne.mockImplementation(async ({ definitionId, ownerKind }) => {
      return mockDefinitionRows.find((row) => row.definitionId === definitionId && row.ownerKind === ownerKind) || null;
    });
    mockDefinitionOrderBy.mockImplementation(async () => mockDefinitionRows);

    mockResolveSessionContext.mockResolvedValue({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      capabilityPolicy: undefined,
    });
    mockResolveSelection.mockResolvedValue({
      provider: 'openai',
      modelId: 'gpt-5.4',
    });
    mockSeedSystemTemplates.mockResolvedValue([]);
    mockResolveInstructionRefs.mockImplementation(async (refs: string[]) =>
      refs.map((ref) => ({
        ref,
        source: 'default',
        content: `Resolved instructions for ${ref}`,
        version: 1,
        hash: 'a'.repeat(64),
      }))
    );

    mockGetOwnedThreadWithSession.mockImplementation(async () => ({ thread, session }));
    mockGetSessionSource.mockImplementation(async () => source);
    mockThreadTransaction.mockImplementation(async (callback) => callback({ trx: true }));
    mockPatchAndFetchById.mockImplementation(async (_id, patch) => ({
      ...thread,
      ...patch,
    }));
    mockThreadQuery.mockImplementation(() => ({
      patchAndFetchById: mockPatchAndFetchById,
    }));
    mockRunQuery.mockImplementation(() => {
      const query = {
        where: jest.fn(() => query),
        whereNotIn: jest.fn(() => query),
        first: jest.fn(async () => (mockActiveRunResults.length > 0 ? mockActiveRunResults.shift() : null)),
      };
      return query;
    });
    mockInsertAndFetch.mockResolvedValue({ uuid: 'sample-switch-message' });
    mockMessageQuery.mockImplementation(() => ({
      insertAndFetch: mockInsertAndFetch,
    }));
  });

  async function buildWorkspaceMcpTools({
    selection = 'default',
    writeMode = 'require_approval',
    writeDisabled = false,
    transport = 'stdio',
    toolRules,
  }: {
    selection?: 'default' | 'selected' | 'none';
    writeMode?: AgentApprovalMode;
    writeDisabled?: boolean;
    transport?: 'stdio' | 'http' | 'sse';
    toolRules?: AgentSessionToolRule[];
  } = {}) {
    session = buildSession({
      workspaceStatus: AgentWorkspaceStatus.READY,
      podName: 'agent-session-pod',
      pvcName: 'agent-session-pvc',
    });
    const approvalPolicy = {
      ...DEFAULT_AGENT_APPROVAL_POLICY,
      rules: { ...DEFAULT_AGENT_APPROVAL_POLICY.rules, external_mcp_write: writeMode },
    };
    mockResolveSessionContext.mockResolvedValue({
      repoFullName: 'example-org/example-repo',
      approvalPolicy,
      capabilityPolicy: writeDisabled ? { availability: { external_mcp_write: 'disabled' } } : undefined,
    });
    const discoveredTools = [
      {
        name: 'sample_tool',
        description: 'A sample MCP tool.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: transport === 'stdio' },
      },
    ];
    const server = {
      scope: 'global',
      slug: 'sample',
      name: 'Sample MCP',
      transport:
        transport === 'stdio'
          ? { type: 'stdio', command: 'node', args: ['server.mjs'] }
          : { type: transport, url: 'https://mcp.example.test' },
      timeout: 5000,
      env: {},
      defaultArgs: {},
      discoveredTools: transport === 'stdio' ? [] : discoveredTools,
      discoveryPending: transport === 'stdio',
    };
    mockResolveMcpServers.mockResolvedValue([server]);
    mockDiscoverPendingServerTools.mockResolvedValue(discoveredTools);
    mockListMcpConnections.mockResolvedValue([
      { ...server, connectionRequired: false, configured: true, stale: false, sharedDiscoveredTools: [] },
    ]);

    const controls = await AgentThreadRuntimeControlsService.getState({ threadId: thread.uuid, userIdentity });
    if (selection !== 'default') {
      thread = buildThread({
        metadata: {
          runtimeControlChoices: {
            version: 1,
            toolChoiceIds: [],
            mcpChoiceIds: selection === 'selected' ? [controls.mcp.connections[0].id] : [],
          },
        },
      });
    }
    const result = await resolveRunPlan({ session, thread, source });
    const runPlan = result.runPlanSnapshot;
    const toolSet = await AgentCapabilityService.buildToolSetWithMetadata({
      session,
      userIdentity,
      repoFullName: result.repoFullName,
      approvalPolicy: result.approvalPolicy,
      resolvedCapabilityAccess: runPlan.capabilities.resolvedCapabilityAccess as ResolvedAgentCapabilityAccess[],
      selectedRuntimeMcpConnectionRefs: runPlan.capabilities.selectedRuntimeMcpConnectionRefs,
      agentDefinitionId: runPlan.agent.id,
      agentSourceKind: runPlan.agent.sourceKind,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
      toolRules,
    });
    return { result, toolSet, controls };
  }

  it.each(['default', 'selected'] as const)(
    'registers workspace MCP tools from the actual Develop plan with %s selection',
    async (selection) => {
      const { result, toolSet, controls } = await buildWorkspaceMcpTools({ selection });
      expect(result.runPlanSnapshot.agent.sourceKind).toBe('workspace_session');
      expect(getCapabilityAccess(result, 'external_mcp_write')).toMatchObject({
        allowed: true,
        availability: 'admin_only',
        approvalMode: 'require_approval',
      });
      expect(controls.mcp.connections[0]).toMatchObject({ selected: true, available: true });
      expect(toolSet.tools.mcp__sample__sample_tool).toBeDefined();
      expect(toolSet.metadata).toEqual([
        expect.objectContaining({
          capabilityKey: 'external_mcp_write',
          catalogCapabilityId: 'external_mcp_write',
          approvalMode: 'require_approval',
        }),
      ]);
      expect(toolSet.toolApproval.mcp__sample__sample_tool).toBe('user-approval');
      expect(mockDiscoverPendingServerTools).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps explicit MCP deselection authoritative for Develop', async () => {
    const { result, toolSet } = await buildWorkspaceMcpTools({ selection: 'none' });
    expect(getCapabilityAccess(result, 'external_mcp_write')).toBeUndefined();
    expect(getCapabilityAccess(result, 'external_mcp_read')).toMatchObject({ allowed: true });
    expect(result.runPlanSnapshot.capabilities.selectedRuntimeMcpConnectionRefs).toEqual([]);
    expect(toolSet.tools).toEqual({});
    expect(mockDiscoverPendingServerTools).not.toHaveBeenCalled();
  });

  it.each(['default', 'selected'] as const)(
    'omits disabled optional MCP write without blocking the workspace: %s selection',
    async (selection) => {
      const { result, toolSet, controls } = await buildWorkspaceMcpTools({
        selection,
        writeDisabled: true,
        toolRules: [{ toolKey: 'mcp__sample__sample_tool', mode: 'allow' }],
      });
      expect(getCapabilityAccess(result, 'workspace_files')).toMatchObject({ allowed: true });
      expect(getCapabilityAccess(result, 'external_mcp_write')).toBeUndefined();
      expect(controls.mcp.connections[0]).toMatchObject({ available: false, selected: false });
      expect(toolSet.tools).toEqual({});
      if (selection === 'selected') {
        expect(result.runPlanSnapshot.capabilities.selectedRuntimeMcpConnectionRefs).toEqual([]);
      }
    }
  );

  it.each([
    { writeMode: 'deny' as const, rule: undefined, exposed: false, approval: false },
    { writeMode: 'allow' as const, rule: undefined, exposed: true, approval: false },
    { writeMode: 'deny' as const, rule: 'allow' as const, exposed: true, approval: false },
    { writeMode: 'allow' as const, rule: 'deny' as const, exposed: false, approval: false },
    { writeMode: 'allow' as const, rule: 'require_approval' as const, exposed: true, approval: true },
  ])(
    'preserves configured MCP policy and exact tool precedence: %j',
    async ({ writeMode, rule, exposed, approval }) => {
      const { result, toolSet, controls } = await buildWorkspaceMcpTools({
        selection: 'selected',
        writeMode,
        toolRules: rule ? [{ toolKey: 'mcp__sample__sample_tool', mode: rule }] : undefined,
      });
      expect(getCapabilityAccess(result, 'external_mcp_write')).toMatchObject({
        allowed: true,
        approvalMode: writeMode,
      });
      expect(controls.mcp.connections[0].available).toBe(true);
      expect(Boolean(toolSet.tools.mcp__sample__sample_tool)).toBe(exposed);
      expect(toolSet.toolApproval.mcp__sample__sample_tool).toBe(approval ? 'user-approval' : undefined);
    }
  );

  it.each(['http', 'sse'] as const)(
    'admits selected %s write tools under the Develop write policy',
    async (transport) => {
      const { toolSet } = await buildWorkspaceMcpTools({ selection: 'selected', transport });
      expect(toolSet.tools.mcp__sample__sample_tool).toBeDefined();
      expect(toolSet.toolApproval.mcp__sample__sample_tool).toBe('user-approval');
      expect(mockDiscoverPendingServerTools).not.toHaveBeenCalled();
    }
  );

  it('seeds the one visible system agent plus legacy readable system definitions', async () => {
    const seeded = await ensureSystemAgentDefinitionsSeeded();

    expect(mockDefinitionUpsert).toHaveBeenCalledTimes(4);
    expect(seeded.map((definition) => definition.id).sort()).toEqual([
      'system.agent',
      'system.debug',
      'system.develop',
      'system.freeform',
    ]);
    expect(seeded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'system.agent',
          owner: { kind: 'system', userId: null, organizationId: null },
          codeOwned: true,
          readOnly: true,
        }),
        expect.objectContaining({
          id: 'system.debug',
          owner: { kind: 'system', userId: null, organizationId: null },
          codeOwned: true,
          readOnly: true,
        }),
        expect.objectContaining({
          id: 'system.develop',
          owner: { kind: 'system', userId: null, organizationId: null },
          codeOwned: true,
          readOnly: true,
        }),
        expect.objectContaining({
          id: 'system.freeform',
          owner: { kind: 'system', userId: null, organizationId: null },
          codeOwned: true,
          readOnly: true,
        }),
      ])
    );

    expect(seeded.map((definition) => serializeAgentDefinitionSummary(definition).id).sort()).toEqual([
      'system.agent',
      'system.debug',
      'system.develop',
      'system.freeform',
    ]);
  });

  it('keeps Debug diagnostic and protected fix capability refs with workspaceRequired false', async () => {
    const debug = await getSystemAgentDefinition('system.debug');

    expect(debug).toEqual(
      expect.objectContaining({
        codeOwned: true,
        readOnly: true,
        instructionRefs: ['system:debug'],
      })
    );
    expect(debug.resourcePolicy.workspaceRequired).toBe(false);
    expect(debug.requiredCapabilityRefs).toEqual(
      expect.arrayContaining([
        'diagnostics_logs',
        'diagnostics_codefresh',
        'diagnostics_kubernetes',
        'diagnostics_database',
        'github_write',
      ])
    );
    // Debug repairs go through github_write, not external MCP writes (least privilege).
    expect(debug.requiredCapabilityRefs).not.toContain('read_context');
    expect(debug.requiredCapabilityRefs).not.toContain('external_mcp_write');

    const result = await resolveRunPlan({
      source: {
        input: { buildUuid: 'sample-build', branchName: 'main' },
      },
    });

    expect(result.runPlanSnapshot.agent.id).toBe('system.agent');
    expect(result.runPlanSnapshot.profile).toEqual({
      kind: 'debug',
      intent: 'diagnose',
      workspaceCore: 'absent',
    });
    expect(result.runPlanSnapshot.source.repoFullName).toBe('example-org/example-repo');
    expect(getCapabilityAccess(result, 'diagnostics_kubernetes')).toEqual(
      expect.objectContaining({
        allowed: true,
        availability: 'system_only',
      })
    );
    expect(getCapabilityAccess(result, 'github_write')).toEqual(
      expect.objectContaining({
        allowed: true,
        availability: 'system_only',
        approvalMode: 'require_approval',
      })
    );
    expect(getCapabilityAccess(result, 'external_mcp_write')?.allowed).not.toBe(true);
  });

  it('keeps legacy system ids readable while default chat resolves to the one Lifecycle Agent', async () => {
    const develop = await getSystemAgentDefinition('system.develop');
    const freeform = await getSystemAgentDefinition('system.freeform');

    expect(develop.resourcePolicy.workspaceRequired).toBe(true);
    expect(develop.resourcePolicy.sandboxRequired).toBe(true);
    expect(freeform.requiredCapabilityRefs).toEqual(['read_context', 'external_mcp_read']);

    const freeformRun = await resolveRunPlan();
    expect(freeformRun.runPlanSnapshot.agent.id).toBe('system.agent');
    expect(freeformRun.runPlanSnapshot.profile).toEqual({
      kind: 'answer',
      intent: 'chat',
      workspaceCore: 'absent',
    });
    expect(freeformRun.runPlanSnapshot.capabilities.provisionalCapabilityIds).toEqual([
      'read_context',
      'external_mcp_read',
      'external_mcp_write',
      'workspace_files',
      'workspace_shell',
      'workspace_git',
      'network_access',
      'preview_publish',
    ]);
    expect(getCapabilityAccess(freeformRun, 'external_mcp_write')).toEqual(
      expect.objectContaining({
        allowed: true,
        availability: 'admin_only',
        approvalMode: 'require_approval',
      })
    );
    expect(serializeRunPlanSummary(freeformRun.runPlanSnapshot)?.agent.id).toBe('system.agent');

    await expect(
      resolveRunPlan({
        thread: {
          metadata: { selectedAgentDefinitionId: 'system.develop' },
        },
      })
    ).rejects.toMatchObject({
      name: AgentRunPlanAgentUnavailableError.name,
      agentId: 'system.develop',
      reason: 'source_incompatible',
      details: { sourceKind: 'freeform_chat' },
    });
  });

  it('allows system_only capabilities for system definitions and denies user-definition privilege escalation', () => {
    const systemAccess = AgentPolicyService.resolveCapabilitySetAccess(
      ['diagnostics_database', 'github_write', 'approval_controls'],
      {
        definitionOwnerKind: 'system',
        sourceKind: 'build_context_chat',
      }
    );
    expect(systemAccess).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: 'diagnostics_database',
          allowed: true,
          effectiveAvailability: 'system_only',
        }),
        expect.objectContaining({
          capabilityId: 'github_write',
          allowed: true,
          effectiveAvailability: 'system_only',
        }),
      ])
    );

    const syntheticUserDefinition: AgentDefinitionContract = {
      id: 'user.sample-agent',
      version: 1,
      owner: { kind: 'user', userId: 'sample-user' },
      name: 'Sample agent',
      instructionRefs: [],
      capabilityRefs: ['diagnostics_database'],
      requiredCapabilityRefs: ['diagnostics_database'],
      optionalCapabilityRefs: [],
      resourcePolicy: {
        sourceKinds: ['build_context_chat'],
        workspaceRequired: false,
        sandboxRequired: false,
      },
      status: 'active',
    };
    const userAccess = AgentPolicyService.resolveCapabilitySetAccess(syntheticUserDefinition.requiredCapabilityRefs!, {
      definitionOwnerKind: syntheticUserDefinition.owner.kind,
      sourceKind: 'build_context_chat',
    });

    expect(userAccess).toEqual([
      expect.objectContaining({
        capabilityId: 'diagnostics_database',
        allowed: false,
        reason: 'system_only',
        effectiveAvailability: 'system_only',
      }),
    ]);
  });
});
