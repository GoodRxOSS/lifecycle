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

const mockDynamicTool = jest.fn((config) => config);
const mockJsonSchema = jest.fn((schema) => schema);
const mockResolveServers = jest.fn();
const mockConnect = jest.fn();
const mockListTools = jest.fn();
const mockCallTool = jest.fn();
const mockClose = jest.fn();
const mockLoggerWarn = jest.fn();
const mockModeForCapability = jest.fn((_policy?: unknown, _capability?: unknown) => 'allow');
const mockGetEffectivePolicy = jest.fn();
const mockGetEffectiveAgentConfig = jest.fn();
const mockCapabilityForExternalMcpTool = jest.fn((_toolName?: string) => 'external_mcp_read');
const mockPublishChatHttpPort = jest.fn();
const mockFetch = jest.fn();
const mockFindSession = jest.fn();
const mockResolveWorkspaceGatewayBaseUrl = jest.fn();
const mockEnsureChatSandbox = jest.fn();
const mockDiagnosticToolExecute = jest.fn();
const mockParseYamlConfigFromBranch = jest.fn();
const mockGithubOctokitRequest = jest.fn();
const mockBuildFindOne = jest.fn();
const mockGithubClientInstances: Array<{
  setAllowedBranch: jest.Mock;
  setReferencedFiles: jest.Mock;
  setExcludedFilePatterns: jest.Mock;
  setAllowedWritePatterns: jest.Mock;
  setAllowedRepos: jest.Mock;
  setDefaultRepo: jest.Mock;
  setAllowedPullRequestNumber: jest.Mock;
  setRequestAuth: jest.Mock;
  __requestAuth?: {
    resolveApprovalAuth?: (context: { toolCallId?: string | null }) => Promise<unknown>;
  };
  isFilePathAllowed: jest.Mock;
  validateBranch: jest.Mock;
  getOctokit: jest.Mock;
  getOctokitWithAuth: jest.Mock;
}> = [];
const mockK8sClientInstances: Array<{ setAllowedNamespace: jest.Mock }> = [];
const mockDatabaseClientInstances: Array<{ setBuildScope: jest.Mock }> = [];

let currentTransport: Record<string, unknown> | null = null;

function mockMakeDiagnosticToolClass(name: string, description = `${name} description`) {
  return jest.fn().mockImplementation((client?: { __requestAuth?: { resolveApprovalAuth?: Function } }) => ({
    name,
    description,
    parameters: {
      type: 'object',
      properties: {},
    },
    // get_lifecycle_logs is scoped to the build's UUID at registration; expose the setter.
    setAllowedBuildUuid: jest.fn(),
    execute: async (args: Record<string, unknown>, signal?: AbortSignal, context?: { toolCallId?: string | null }) => {
      if (client?.__requestAuth?.resolveApprovalAuth && context?.toolCallId) {
        await client.__requestAuth.resolveApprovalAuth({ toolCallId: context.toolCallId });
      }
      return mockDiagnosticToolExecute(name, args, signal, context);
    },
  }));
}

jest.mock('ai', () => ({
  dynamicTool: (config: unknown) => mockDynamicTool(config),
  jsonSchema: (schema: unknown) => mockJsonSchema(schema),
}));

jest.mock('server/services/agentRuntime/mcp/config', () => {
  const actual = jest.requireActual('server/services/agentRuntime/mcp/config');
  return {
    __esModule: true,
    ...actual,
    McpConfigService: jest.fn().mockImplementation(() => ({
      resolveServers: (...args: unknown[]) => mockResolveServers(...args),
    })),
  };
});

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => ({
      findOne: (...args: unknown[]) => mockFindSession(...args),
    })),
  },
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    publishChatHttpPort: (...args: unknown[]) => mockPublishChatHttpPort(...args),
  },
}));

jest.mock('../SandboxService', () => ({
  __esModule: true,
  default: {
    resolveWorkspaceGatewayBaseUrl: (...args: unknown[]) => mockResolveWorkspaceGatewayBaseUrl(...args),
    resolveWorkspaceGatewayEndpoint: async (...args: unknown[]) => {
      const url = await mockResolveWorkspaceGatewayBaseUrl(...args);
      return url ? { url } : null;
    },
    ensureChatSandbox: (...args: unknown[]) => mockEnsureChatSandbox(...args),
  },
}));

jest.mock('server/services/agentRuntime/mcp/client', () => ({
  McpClientManager: jest.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockConnect(...args),
    listTools: (...args: unknown[]) => mockListTools(...args),
    callTool: (...args: unknown[]) => mockCallTool(...args),
    close: (...args: unknown[]) => mockClose(...args),
  })),
}));

jest.mock('server/services/agent/tools/shared/k8sClient', () => ({
  K8sClient: jest.fn().mockImplementation(() => {
    const client = {
      setAllowedNamespace: jest.fn(),
      resolveNamespace: jest.fn(),
    };
    mockK8sClientInstances.push(client);
    return client;
  }),
}));
jest.mock('server/services/agent/tools/shared/githubClient', () => ({
  GitHubClient: jest.fn().mockImplementation(() => {
    const client = {
      setAllowedBranch: jest.fn(),
      setReferencedFiles: jest.fn(),
      setExcludedFilePatterns: jest.fn(),
      setAllowedWritePatterns: jest.fn(),
      setAllowedRepos: jest.fn(),
      setDefaultRepo: jest.fn(),
      setAllowedPullRequestNumber: jest.fn(),
      setRequestAuth: jest.fn(function setRequestAuth(this: any, auth: unknown) {
        this.__requestAuth = auth;
      }),
      getDefaultRepo: jest.fn().mockReturnValue(null),
      isFilePathAllowed: jest.fn(),
      validateBranch: jest.fn(),
      getOctokit: jest.fn().mockResolvedValue({ request: mockGithubOctokitRequest }),
      getOctokitWithAuth: jest.fn().mockResolvedValue({
        octokit: { request: mockGithubOctokitRequest },
        auth: { provider: 'github', source: 'user', required: false },
      }),
    };
    mockGithubClientInstances.push(client);
    return client;
  }),
}));

jest.mock('server/lib/yamlConfigParser', () => ({
  YamlConfigParser: jest.fn().mockImplementation(() => ({
    parseYamlConfigFromBranch: (...args: unknown[]) => mockParseYamlConfigFromBranch(...args),
  })),
}));
jest.mock('server/services/agent/tools/shared/databaseClient', () => ({
  DatabaseClient: jest.fn().mockImplementation(() => {
    const client = {
      setBuildScope: jest.fn(),
      queryTable: jest.fn(),
    };
    mockDatabaseClientInstances.push(client);
    return client;
  }),
}));

jest.mock('server/models/Build', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => ({
      findOne: jest.fn(() => ({
        withGraphFetched: (...args: unknown[]) => mockBuildFindOne(...args),
      })),
    })),
  },
}));
jest.mock('server/services/agent/tools/codefresh/getCodefreshLogs', () => ({
  GetCodefreshLogsTool: mockMakeDiagnosticToolClass('get_codefresh_logs'),
}));
jest.mock('server/services/agent/tools/k8s/getK8sResources', () => ({
  GetK8sResourcesTool: mockMakeDiagnosticToolClass('get_k8s_resources'),
}));
jest.mock('server/services/agent/tools/k8s/getPodLogs', () => ({
  GetPodLogsTool: mockMakeDiagnosticToolClass('get_pod_logs'),
}));
jest.mock('server/services/agent/tools/k8s/getLifecycleLogs', () => ({
  GetLifecycleLogsTool: mockMakeDiagnosticToolClass('get_lifecycle_logs'),
}));
jest.mock('server/services/agent/tools/lifecycle/getBuildLogs', () => ({
  GetBuildLogsTool: mockMakeDiagnosticToolClass('get_build_logs'),
}));
jest.mock('server/services/agent/tools/k8s/queryDatabase', () => ({
  QueryDatabaseTool: mockMakeDiagnosticToolClass('query_database'),
}));
jest.mock('server/services/agent/tools/github/getFile', () => ({
  GetFileTool: mockMakeDiagnosticToolClass('get_file'),
}));
jest.mock('server/services/agent/tools/github/listDirectory', () => ({
  ListDirectoryTool: mockMakeDiagnosticToolClass('list_directory'),
}));
jest.mock('server/services/agent/tools/github/getIssueComment', () => ({
  GetIssueCommentTool: mockMakeDiagnosticToolClass('get_issue_comment'),
}));
jest.mock('server/services/agent/tools/github/updateFile', () => ({
  UpdateFileTool: mockMakeDiagnosticToolClass('update_file'),
}));
jest.mock('server/services/agent/tools/github/updatePrLabels', () => ({
  UpdatePrLabelsTool: mockMakeDiagnosticToolClass('update_pr_labels'),
}));
jest.mock('server/services/agent/tools/k8s/patchK8sResource', () => ({
  PatchK8sResourceTool: mockMakeDiagnosticToolClass('patch_k8s_resource'),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  return {
    __esModule: true,
    resolveAgentSessionDurabilityConfig: jest.fn().mockResolvedValue({
      runExecutionLeaseMs: 30 * 60 * 1000,
      queuedRunDispatchStaleMs: 30 * 1000,
      dispatchRecoveryLimit: 50,
      maxDurablePayloadBytes: 64 * 1024,
      payloadPreviewBytes: 16 * 1024,
      fileChangePreviewChars: 4000,
    }),
  };
});

jest.mock('../PolicyService', () => ({
  __esModule: true,
  default: {
    getEffectivePolicy: (...args: unknown[]) => (mockGetEffectivePolicy as any)(...args),
    capabilityForSessionWorkspaceTool: jest.fn(() => 'read'),
    capabilityForExternalMcpTool: (...args: unknown[]) => (mockCapabilityForExternalMcpTool as any)(...args),
    modeForCapability: (...args: unknown[]) => (mockModeForCapability as any)(...args),
  },
}));

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getEffectiveConfig: (...args: unknown[]) => mockGetEffectiveAgentConfig(...args),
    })),
  },
}));

import AgentCapabilityService from '../CapabilityService';
import { SessionWorkspaceGatewayUnavailableError } from '../errors';
import { WORKSPACE_CORE_MCP_FEATURE_FLAG } from 'server/services/workspaceCoreMcp/config';
import { REQUIRED_WORKSPACE_GATEWAY_TOOLS } from 'server/services/workspaceRuntime/gatewayContract';

const defaultResolvedCapabilityAccess = [
  'read_context',
  'diagnostics_logs',
  'diagnostics_codefresh',
  'diagnostics_kubernetes',
  'diagnostics_database',
  'github_read',
  'github_write',
  'workspace_files',
  'workspace_shell',
  'workspace_git',
  'network_access',
  'preview_publish',
  'external_mcp_read',
  'external_mcp_write',
  'approval_controls',
].map((capabilityId) => ({
  capabilityId,
  effectiveAvailability: 'all_users' as const,
  allowed: true,
  approvalMode: 'allow' as const,
}));

function buildToolSetForTest(args: Parameters<typeof AgentCapabilityService.buildToolSet>[0]) {
  return AgentCapabilityService.buildToolSet({
    resolvedCapabilityAccess: defaultResolvedCapabilityAccess,
    ...args,
  });
}

function buildToolSetWithMetadataForTest(args: Parameters<typeof AgentCapabilityService.buildToolSetWithMetadata>[0]) {
  return AgentCapabilityService.buildToolSetWithMetadata({
    resolvedCapabilityAccess: defaultResolvedCapabilityAccess,
    ...args,
  });
}

function expectUserApproval(toolApproval: Record<string, unknown>, toolKey: string) {
  expect(toolApproval[toolKey]).toBe('user-approval');
}

function expectNoToolApproval(toolApproval: Record<string, unknown>, toolKey: string) {
  expect(toolApproval[toolKey]).toBeUndefined();
}

function workspaceGatewayTool(name: string) {
  return {
    name,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations:
      name.includes('status') || name.includes('list') || name.includes('logs') || name.includes('read')
        ? { readOnlyHint: true }
        : {},
  };
}

function workspaceGatewayContractTools() {
  return REQUIRED_WORKSPACE_GATEWAY_TOOLS.map((name) => workspaceGatewayTool(name));
}

async function resolveToolApproval(
  toolApproval: Record<string, unknown>,
  toolKey: string,
  input: Record<string, unknown>
) {
  const approval = toolApproval[toolKey];
  if (typeof approval === 'function') {
    return approval(input);
  }

  return approval;
}

describe('AgentCapabilityService.buildToolSet', () => {
  const session = {
    uuid: 'session-123',
    podName: 'agent-123',
    namespace: 'env-sample',
    status: 'active',
    sessionKind: 'environment',
    workspaceStatus: 'ready',
  } as any;
  const userIdentity = {
    userId: 'sample-user',
    githubUsername: 'sample-user',
  } as any;
  const stdioServer = {
    scope: 'global',
    slug: 'figma',
    name: 'Figma',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'figma-developer-mcp', '--stdio'],
      env: {
        FIGMA_API_KEY: 'figma-pat-token',
      },
    },
    timeout: 30000,
    defaultArgs: {},
    env: {
      FIGMA_API_KEY: 'figma-pat-token',
    },
    discoveredTools: [
      {
        name: 'get_design_context',
        description: 'Read the selected Figma file context.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        annotations: {
          readOnlyHint: true,
        },
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[WORKSPACE_CORE_MCP_FEATURE_FLAG];
    mockGithubClientInstances.length = 0;
    mockK8sClientInstances.length = 0;
    mockDatabaseClientInstances.length = 0;
    mockBuildFindOne.mockResolvedValue(null);
    mockGithubOctokitRequest.mockResolvedValue({
      data: {
        sha: 'existing-file-sha',
        content: Buffer.from('services:\n  sample-service:\n    branch: main').toString('base64'),
      },
    });
    mockModeForCapability.mockReturnValue('allow');
    mockGetEffectivePolicy.mockResolvedValue({ rules: {} });
    mockGetEffectiveAgentConfig.mockResolvedValue({});
    mockParseYamlConfigFromBranch.mockResolvedValue({ services: [] });
    mockCapabilityForExternalMcpTool.mockReturnValue('external_mcp_read');
    currentTransport = null;
    mockResolveServers.mockResolvedValue([stdioServer]);
    mockFindSession.mockResolvedValue(session);
    mockPublishChatHttpPort.mockResolvedValue({
      url: 'https://chat-session.example.test',
      host: 'chat-session.example.test',
      path: '/',
      port: 3000,
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        cancel: jest.fn().mockResolvedValue(undefined),
      },
    });
    (global as any).fetch = mockFetch;
    mockResolveWorkspaceGatewayBaseUrl.mockImplementation(async (sessionUuid: string) => {
      if (sessionUuid === 'session-chat') {
        return 'http://agent-chat.chat-sample.svc.cluster.local:13338';
      }

      return 'http://agent-123.env-sample.svc.cluster.local:13338';
    });
    mockEnsureChatSandbox.mockResolvedValue({
      session: {
        uuid: 'session-chat',
        sessionKind: 'chat',
        workspaceStatus: 'ready',
        status: 'active',
        podName: 'agent-chat',
        namespace: 'chat-sample',
        pvcName: 'agent-pvc-sample',
      },
      sandbox: null,
    });
    mockConnect.mockImplementation(async (transport) => {
      currentTransport = transport as Record<string, unknown>;
    });
    mockDiagnosticToolExecute.mockResolvedValue({
      success: true,
      agentContent: JSON.stringify({ ok: true }),
    });
    mockListTools.mockImplementation(async () => {
      if (
        currentTransport &&
        currentTransport.type === 'http' &&
        currentTransport.url === 'http://agent-123.env-sample.svc.cluster.local:13338/mcp'
      ) {
        return workspaceGatewayContractTools();
      }

      if (
        currentTransport &&
        currentTransport.type === 'http' &&
        currentTransport.url === 'http://agent-chat.chat-sample.svc.cluster.local:13338/mcp'
      ) {
        return workspaceGatewayContractTools();
      }

      return [];
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    mockClose.mockResolvedValue(undefined);
  });

  it('resolves repo-scoped context from build-context chat workspaceRepos', async () => {
    mockFindSession.mockResolvedValueOnce({
      uuid: 'session-build-context',
      userId: 'sample-user',
      sessionKind: 'chat',
      workspaceRepos: [
        {
          repo: 'example-org/example-repo',
          repoUrl: 'https://github.com/example-org/example-repo.git',
          branch: 'feature/sample',
          revision: 'commit-sha-1',
          mountPath: '/workspace',
          primary: true,
        },
      ],
      selectedServices: [],
    });
    const policy = { rules: { deploy_k8s_read: 'allow' } };
    mockGetEffectivePolicy.mockResolvedValueOnce(policy);

    const result = await AgentCapabilityService.resolveSessionContext('session-build-context', userIdentity);

    expect(mockFindSession).toHaveBeenCalledWith({
      uuid: 'session-build-context',
      userId: 'sample-user',
    });
    expect(mockGetEffectivePolicy).toHaveBeenCalledWith('example-org/example-repo');
    expect(result).toEqual({
      session: expect.objectContaining({
        uuid: 'session-build-context',
      }),
      repoFullName: 'example-org/example-repo',
      approvalPolicy: policy,
      capabilityPolicy: undefined,
      customAgentCreationPolicy: undefined,
    });
  });

  it('routes stdio MCP execution through the session-pod proxy endpoint', async () => {
    const tools = await buildToolSetForTest({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(mockConnect).toHaveBeenCalledWith(
      {
        type: 'http',
        url: 'http://agent-123.env-sample.svc.cluster.local:13338/mcp',
      },
      4500
    );
    expect(mockListTools).toHaveBeenCalledWith(4500);

    const tool = tools.mcp__figma__get_design_context as unknown as {
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    };
    expect(tool).toBeDefined();

    await tool.execute({});

    expect(mockConnect).toHaveBeenCalledWith(
      {
        type: 'http',
        url: 'http://agent-123.env-sample.svc.cluster.local:13338/servers/figma/mcp',
      },
      30000
    );
    expect(mockCallTool).toHaveBeenCalledWith('get_design_context', {}, 30000);
  });

  it('does not expose external runtime MCP tools without resolved run-plan capabilities', async () => {
    const tools = await AgentCapabilityService.buildToolSet({
      session: {
        ...session,
        sessionKind: 'chat',
        workspaceStatus: 'none',
        podName: null,
        namespace: null,
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__figma__get_design_context).toBeUndefined();
    expect(tools.mcp__workspace_core__exec).toBeDefined();
    expect(tools.mcp__workspace_core__write_file).toBeDefined();
    expect(tools.mcp__workspace_core__publish_http).toBeDefined();
  });

  it('omits external MCP tools whose resolved catalog capability is unavailable', async () => {
    mockCapabilityForExternalMcpTool.mockImplementation((toolName: string) =>
      toolName === 'update_design' ? 'external_mcp_write' : 'external_mcp_read'
    );
    mockResolveServers.mockResolvedValue([
      {
        ...stdioServer,
        discoveredTools: [
          {
            name: 'get_design_context',
            description: 'Read design context',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
          {
            name: 'update_design',
            description: 'Update design context',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      },
    ]);

    const tools = await buildToolSetForTest({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      resolvedCapabilityAccess: [
        {
          capabilityId: 'external_mcp_read',
          effectiveAvailability: 'all_users',
          allowed: true,
          approvalMode: 'allow',
        },
        {
          capabilityId: 'external_mcp_write',
          effectiveAvailability: 'admin_only',
          allowed: false,
          reason: 'admin_only',
        },
      ],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__figma__get_design_context).toBeDefined();
    expect(tools.mcp__figma__update_design).toBeUndefined();
  });

  it('skips optional external MCP tools for explicit empty runtime MCP selections', async () => {
    const tools = await buildToolSetForTest({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      selectedRuntimeMcpConnectionRefs: [],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__figma__get_design_context).toBeUndefined();
    expect(tools.mcp__workspace_core__read_file).toBeDefined();
  });

  it('registers only the selected runtime MCP connection tools', async () => {
    mockResolveServers.mockResolvedValue([
      stdioServer,
      {
        ...stdioServer,
        slug: 'docs',
        name: 'Docs',
        discoveredTools: [
          {
            name: 'search_docs',
            description: 'Search docs',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      },
    ]);

    const tools = await buildToolSetForTest({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      selectedRuntimeMcpConnectionRefs: ['global:docs'],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__figma__get_design_context).toBeUndefined();
    expect(tools.mcp__docs__search_docs).toBeDefined();
    expect(tools.mcp__workspace_core__read_file).toBeDefined();
  });

  it('filters selected runtime MCP connections by scope and slug', async () => {
    mockResolveServers.mockResolvedValue([
      {
        ...stdioServer,
        slug: 'docs',
        name: 'Global Docs',
        discoveredTools: [
          {
            name: 'search_global_docs',
            description: 'Search global docs',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      },
      {
        ...stdioServer,
        scope: 'example-org/example-repo',
        slug: 'docs',
        name: 'Repo Docs',
        discoveredTools: [
          {
            name: 'search_repo_docs',
            description: 'Search repo docs',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      },
    ]);

    const tools = await buildToolSetForTest({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      selectedRuntimeMcpConnectionRefs: ['example-org/example-repo:docs'],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__docs__search_global_docs).toBeUndefined();
    expect(tools.mcp__docs__search_repo_docs).toBeDefined();
  });

  it('uses the configured workspace execution timeout for workspace_core tools', async () => {
    const tools = await buildToolSetForTest({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    const tool = tools.mcp__workspace_core__read_file as unknown as {
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    };
    expect(tool).toBeDefined();

    await tool.execute({ path: 'README.md' });

    expect(mockConnect).toHaveBeenLastCalledWith(
      {
        type: 'http',
        url: 'http://agent-123.env-sample.svc.cluster.local:13338/mcp',
      },
      22000
    );
    expect(mockCallTool).toHaveBeenCalledWith('workspace.read_file', { path: 'README.md' }, 22000);
  });

  it('fails the session tool setup when the sandbox gateway is unavailable', async () => {
    mockConnect.mockImplementation(async (transport) => {
      currentTransport = transport as Record<string, unknown>;
      if (
        currentTransport &&
        currentTransport.type === 'http' &&
        currentTransport.url === 'http://agent-123.env-sample.svc.cluster.local:13338/mcp'
      ) {
        throw new Error('sandbox unavailable');
      }
    });

    await expect(
      buildToolSetForTest({
        session,
        repoFullName: 'example-org/example-repo',
        userIdentity,
        approvalPolicy: {} as any,
        workspaceToolDiscoveryTimeoutMs: 3000,
        workspaceToolExecutionTimeoutMs: 15000,
      })
    ).rejects.toBeInstanceOf(SessionWorkspaceGatewayUnavailableError);

    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('lets session tool rules override the family approval mode for workspace_core tools', async () => {
    mockModeForCapability.mockReturnValue('deny');

    const { tools, toolApproval } = await buildToolSetWithMetadataForTest({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      toolRules: [
        {
          toolKey: 'mcp__workspace_core__read_file',
          mode: 'allow',
        },
      ],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__workspace_core__read_file).toBeDefined();
    expectNoToolApproval(toolApproval, 'mcp__workspace_core__read_file');
  });

  it('registers feature-gated workspace_core tools through the shared approval path', async () => {
    const previousFlag = process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED;
    process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED = 'true';
    mockModeForCapability.mockImplementation((_policy, capability) =>
      capability === 'shell_exec' || capability === 'workspace_write' ? 'require_approval' : 'allow'
    );

    try {
      const { tools, metadata, toolApproval } = await buildToolSetWithMetadataForTest({
        session: {
          ...session,
          sessionKind: 'chat',
          podName: 'agent-123',
          namespace: 'env-sample',
          workspaceStatus: 'ready',
        } as any,
        repoFullName: 'example-org/example-repo',
        userIdentity,
        approvalPolicy: {} as any,
        workspaceToolDiscoveryTimeoutMs: 4500,
        workspaceToolExecutionTimeoutMs: 22000,
      });

      expect(tools.mcp__workspace_core__exec).toBeDefined();
      expect(tools.mcp__workspace_core__read_file).toBeDefined();
      expect(tools.mcp__workspace_core__write_file).toBeDefined();
      expect(metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolKey: 'mcp__workspace_core__exec',
            serverSlug: 'workspace_core',
            sourceToolName: 'exec',
            catalogCapabilityId: 'workspace_shell',
            capabilityKey: 'shell_exec',
            approvalMode: 'require_approval',
          }),
          expect.objectContaining({
            toolKey: 'mcp__workspace_core__read_file',
            serverSlug: 'workspace_core',
            sourceToolName: 'read_file',
            catalogCapabilityId: 'read_context',
            capabilityKey: 'read',
            approvalMode: 'allow',
          }),
        ])
      );
      expectUserApproval(toolApproval, 'mcp__workspace_core__exec');
      expectUserApproval(toolApproval, 'mcp__workspace_core__write_file');
      expectNoToolApproval(toolApproval, 'mcp__workspace_core__read_file');
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED;
      } else {
        process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED = previousFlag;
      }
    }
  });

  it('uses workspace_core by default for ready chat workspaces', async () => {
    delete process.env[WORKSPACE_CORE_MCP_FEATURE_FLAG];
    mockModeForCapability.mockImplementation((_policy, capability) =>
      capability === 'shell_exec' || capability === 'workspace_write' ? 'require_approval' : 'allow'
    );

    const { tools, toolApproval } = await buildToolSetWithMetadataForTest({
      session: {
        ...session,
        uuid: 'session-chat',
        sessionKind: 'chat',
        podName: 'agent-chat',
        namespace: 'chat-sample',
        workspaceStatus: 'ready',
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__workspace_core__exec).toBeDefined();
    expect(tools.mcp__workspace_core__read_file).toBeDefined();
    expect(tools.mcp__workspace_core__apply_patch).toBeDefined();
    expect(tools.mcp__workspace_core__write_file).toBeDefined();
    expect(tools.mcp__workspace_core__publish_http).toBeDefined();
    expectUserApproval(toolApproval, 'mcp__workspace_core__exec');
    expectUserApproval(toolApproval, 'mcp__workspace_core__apply_patch');
    expectUserApproval(toolApproval, 'mcp__workspace_core__write_file');

    expect(tools.mcp__lifecycle__request_workspace).toBeUndefined();
  });

  it('uses request_workspace by default before chat workspace readiness', async () => {
    delete process.env[WORKSPACE_CORE_MCP_FEATURE_FLAG];
    mockResolveServers.mockResolvedValue([]);

    const { tools } = await buildToolSetWithMetadataForTest({
      session: {
        uuid: 'session-chat',
        sessionKind: 'chat',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
      } as any,
      repoFullName: undefined,
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__lifecycle__request_workspace).toBeDefined();
    expect(tools.mcp__workspace_core__exec).toBeDefined();
    expect(tools.mcp__workspace_core__apply_patch).toBeDefined();
  });

  it('request_workspace returns a ready result when the workspace runtime is available', async () => {
    const previousFlag = process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED;
    process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED = 'true';
    mockResolveServers.mockResolvedValue([]);
    mockFindSession.mockResolvedValue({
      uuid: 'session-chat',
      sessionKind: 'chat',
      workspaceStatus: 'none',
      status: 'active',
      podName: null,
      namespace: null,
    });
    const onWorkspaceEscalated = jest.fn().mockResolvedValue(undefined);

    try {
      const { tools, toolApproval } = await buildToolSetWithMetadataForTest({
        session: {
          uuid: 'session-chat',
          sessionKind: 'chat',
          workspaceStatus: 'none',
          status: 'active',
          podName: null,
          namespace: null,
        } as any,
        repoFullName: undefined,
        userIdentity,
        approvalPolicy: {} as any,
        workspaceToolDiscoveryTimeoutMs: 4500,
        workspaceToolExecutionTimeoutMs: 22000,
        requestGitHubToken: 'sample-gh-token',
        hooks: {
          getActiveRunUuid: () => 'run-current',
          onWorkspaceEscalated,
        },
      });

      const tool = tools.mcp__lifecycle__request_workspace as {
        execute: (input: Record<string, unknown>, context?: { toolCallId?: string }) => Promise<unknown>;
      };
      expect(tool).toBeDefined();
      expectNoToolApproval(toolApproval, 'mcp__lifecycle__request_workspace');

      await expect(
        tool.execute({ reason: 'edit files', timeout_ms: 1000 }, { toolCallId: 'tool-request-workspace' })
      ).resolves.toMatchObject({
        status: 'ready',
        workspaceStatus: 'ready',
        workspace_status: 'ready',
        reason: 'edit files',
      });

      expect(mockEnsureChatSandbox).toHaveBeenCalledWith({
        sessionId: 'session-chat',
        userId: 'sample-user',
        userIdentity,
        githubToken: 'sample-gh-token',
        allowedActiveRunUuid: 'run-current',
      });
      expect(onWorkspaceEscalated).not.toHaveBeenCalled();
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED;
      } else {
        process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED = previousFlag;
      }
    }
  });

  it('workspace_core tools lazily resolve the gateway after request_workspace creates a runtime', async () => {
    const previousFlag = process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED;
    process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED = 'true';
    mockResolveServers.mockResolvedValue([]);
    mockFindSession.mockResolvedValue({
      uuid: 'session-chat',
      sessionKind: 'chat',
      workspaceStatus: 'ready',
      status: 'active',
      podName: 'agent-chat',
      namespace: 'chat-sample',
    });
    mockCallTool.mockResolvedValue({
      content: [],
      structuredContent: {
        ok: true,
        path: 'src',
        entries: [{ path: 'src/app.ts', kind: 'file' }],
        truncated: false,
      },
    });

    try {
      const { tools } = await buildToolSetWithMetadataForTest({
        session: {
          uuid: 'session-chat',
          sessionKind: 'chat',
          workspaceStatus: 'none',
          status: 'active',
          podName: null,
          namespace: null,
        } as any,
        repoFullName: undefined,
        userIdentity,
        approvalPolicy: {} as any,
        workspaceToolDiscoveryTimeoutMs: 4500,
        workspaceToolExecutionTimeoutMs: 22000,
      });

      const listFilesTool = tools.mcp__workspace_core__list_files as {
        execute: (
          input: Record<string, unknown>,
          context?: { toolCallId?: string }
        ) => Promise<{
          structuredContent?: unknown;
        }>;
      };

      const result = await listFilesTool.execute({ path: 'src', limit: 10 }, { toolCallId: 'tool-list-files' });

      expect(mockListTools).toHaveBeenCalledWith(4500);
      expect(mockCallTool).toHaveBeenCalledWith('workspace.list_files', { path: 'src', limit: 10 }, 22000);
      expect(result.structuredContent).toEqual({
        path: 'src',
        entries: [{ path: 'src/app.ts', kind: 'file' }],
        truncated: false,
      });
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED;
      } else {
        process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED = previousFlag;
      }
    }
  });

  it('does not equip workspace tools for build-context profiles when workspace_core is enabled', async () => {
    const previousFlag = process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED;
    process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED = 'true';
    mockResolveServers.mockResolvedValue([]);

    try {
      const { tools } = await buildToolSetWithMetadataForTest({
        session: {
          uuid: 'session-chat',
          sessionKind: 'chat',
          workspaceStatus: 'none',
          status: 'active',
          podName: null,
          namespace: null,
        } as any,
        repoFullName: undefined,
        userIdentity,
        approvalPolicy: {} as any,
        workspaceToolDiscoveryTimeoutMs: 4500,
        workspaceToolExecutionTimeoutMs: 22000,
        agentDefinitionId: 'system.agent',
        agentSourceKind: 'build_context_chat',
      });

      expect(tools.mcp__lifecycle__request_workspace).toBeUndefined();
      expect(tools.mcp__workspace_core__exec).toBeUndefined();
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED;
      } else {
        process.env.AGENT_WORKSPACE_CORE_MCP_ENABLED = previousFlag;
      }
    }
  });

  it('keeps global MCP tools available even when the session has no primary repo', async () => {
    mockModeForCapability.mockImplementation((_policy, capability) =>
      capability === 'deploy_k8s_mutation' ? 'require_approval' : 'allow'
    );
    mockResolveServers.mockResolvedValue([
      {
        slug: 'docs',
        name: 'Docs',
        transport: {
          type: 'http',
          url: 'https://mcp.example.test',
        },
        timeout: 30000,
        defaultArgs: {},
        env: {},
        discoveredTools: [
          {
            name: 'search_docs',
            description: 'Search docs',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      },
    ]);

    const { tools, toolApproval } = await buildToolSetWithMetadataForTest({
      session: {
        ...session,
        sessionKind: 'chat',
        podName: null,
        namespace: null,
        workspaceStatus: 'none',
      } as any,
      repoFullName: undefined,
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(mockResolveServers).toHaveBeenCalledWith(undefined, undefined, userIdentity);
    expect(tools.mcp__docs__search_docs).toBeDefined();
    expect(tools.mcp__lifecycle__request_workspace).toBeDefined();
    expect(tools.mcp__workspace_core__exec).toBeDefined();
    expect(tools.mcp__workspace_core__publish_http).toBeDefined();
    expectUserApproval(toolApproval, 'mcp__workspace_core__publish_http');
    expect(tools.mcp__lifecycle__get_codefresh_logs).toBeUndefined();
    expect(Object.keys(tools).some((key) => key.includes('__source_'))).toBe(false);
  });

  it('registers Lifecycle diagnostic read tools for build-context chat sessions', async () => {
    mockResolveServers.mockResolvedValue([]);
    const onToolStarted = jest.fn();
    const onToolFinished = jest.fn();

    const { tools, toolApproval } = await buildToolSetWithMetadataForTest({
      session: {
        uuid: 'session-build-context',
        sessionKind: 'chat',
        buildUuid: 'sample-build-1',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
      hooks: {
        onToolStarted,
        onToolFinished,
      },
    });

    expect(tools.mcp__lifecycle__get_codefresh_logs).toBeDefined();
    expectNoToolApproval(toolApproval, 'mcp__lifecycle__get_codefresh_logs');
    expect(tools.mcp__lifecycle__get_k8s_resources).toBeDefined();
    expect(tools.mcp__lifecycle__get_pod_logs).toBeDefined();
    expect(tools.mcp__lifecycle__get_lifecycle_logs).toBeDefined();
    expect(tools.mcp__lifecycle__get_build_logs).toBeDefined();
    expect(tools.mcp__lifecycle__query_database).toBeDefined();
    expect(tools.mcp__lifecycle__get_file).toBeDefined();
    expect(tools.mcp__lifecycle__list_directory).toBeDefined();
    expect(tools.mcp__lifecycle__get_issue_comment).toBeDefined();
    expect(typeof toolApproval.mcp__lifecycle__update_file).toBe('function');
    expectUserApproval(toolApproval, 'mcp__lifecycle__update_pr_labels');
    expectUserApproval(toolApproval, 'mcp__lifecycle__patch_k8s_resource');

    const tool = tools.mcp__lifecycle__get_codefresh_logs as {
      execute: (input: Record<string, unknown>, context?: { toolCallId?: string }) => Promise<unknown>;
    };
    await tool.execute({ pipeline_id: 'pipeline-1' }, { toolCallId: 'tool-codefresh' });

    expect(mockDiagnosticToolExecute).toHaveBeenCalledWith(
      'get_codefresh_logs',
      { pipeline_id: 'pipeline-1' },
      undefined,
      { toolCallId: 'tool-codefresh' }
    );
    expect(onToolStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'mcp',
        serverSlug: 'lifecycle',
        toolName: 'get_codefresh_logs',
        toolCallId: 'tool-codefresh',
        capabilityKey: 'read',
      })
    );
    expect(onToolFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'get_codefresh_logs',
        status: 'completed',
      })
    );
  });

  it('returns central metadata for read and approval-gated diagnostic repair tools', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockModeForCapability.mockReturnValue('allow');

    const { tools, metadata, toolsContext } = await buildToolSetWithMetadataForTest({
      session: {
        uuid: 'session-build-context',
        sessionKind: 'chat',
        buildUuid: 'sample-build-1',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__lifecycle__get_codefresh_logs).toBeDefined();
    expect(tools.mcp__lifecycle__update_file).toBeDefined();
    expect(tools.mcp__lifecycle__patch_k8s_resource).toBeDefined();
    expect((tools.mcp__lifecycle__update_file as { contextSchema?: unknown }).contextSchema).toEqual(
      expect.objectContaining({
        type: 'object',
        required: expect.arrayContaining(['toolKey', 'serverSlug', 'sourceToolName']),
      })
    );
    expect(toolsContext.mcp__lifecycle__update_file).toEqual(
      expect.objectContaining({
        toolKey: 'mcp__lifecycle__update_file',
        serverSlug: 'lifecycle',
        sourceToolName: 'update_file',
        catalogCapabilityId: 'github_write',
        capabilityKey: 'git_write',
        approvalMode: 'require_approval',
        resourceDomain: 'github',
        workspaceNeed: 'none',
        exposure: 'repair',
      })
    );
    expect(metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolKey: 'mcp__lifecycle__get_codefresh_logs',
          catalogCapabilityId: 'diagnostics_codefresh',
          capabilityKey: 'read',
          approvalMode: 'allow',
          exposure: 'read',
        }),
        expect.objectContaining({
          toolKey: 'mcp__lifecycle__update_file',
          catalogCapabilityId: 'github_write',
          capabilityKey: 'git_write',
          approvalMode: 'require_approval',
          exposure: 'repair',
        }),
        expect.objectContaining({
          toolKey: 'mcp__lifecycle__patch_k8s_resource',
          catalogCapabilityId: 'diagnostics_kubernetes',
          capabilityKey: 'deploy_k8s_mutation',
          approvalMode: 'require_approval',
          exposure: 'repair',
        }),
      ])
    );
  });

  it('does not register Lifecycle diagnostic read tools for generic no-build chats', async () => {
    mockResolveServers.mockResolvedValue([]);

    const tools = await buildToolSetForTest({
      session: {
        uuid: 'session-chat',
        sessionKind: 'chat',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
      } as any,
      repoFullName: undefined,
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__lifecycle__get_codefresh_logs).toBeUndefined();
    expect(tools.mcp__lifecycle__query_database).toBeUndefined();
    expect(tools.mcp__lifecycle__get_file).toBeUndefined();
    expect(tools.mcp__lifecycle__update_file).toBeUndefined();
    expect(tools.mcp__lifecycle__patch_k8s_resource).toBeUndefined();
  });

  it('lets tool rules deny individual Lifecycle diagnostic read tools', async () => {
    mockResolveServers.mockResolvedValue([]);

    const tools = await buildToolSetForTest({
      session: {
        uuid: 'session-build-context',
        sessionKind: 'chat',
        buildUuid: 'sample-build-1',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      toolRules: [
        {
          toolKey: 'mcp__lifecycle__query_database',
          mode: 'deny',
        },
      ],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__lifecycle__query_database).toBeUndefined();
    expect(tools.mcp__lifecycle__get_codefresh_logs).toBeDefined();
  });

  it('omits Lifecycle diagnostic tools whose resolved catalog capability is unavailable', async () => {
    mockResolveServers.mockResolvedValue([]);

    const tools = await buildToolSetForTest({
      session: {
        uuid: 'session-build-context',
        sessionKind: 'chat',
        buildUuid: 'sample-build-1',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      resolvedCapabilityAccess: [
        {
          capabilityId: 'diagnostics_codefresh',
          effectiveAvailability: 'system_only',
          allowed: true,
          approvalMode: 'allow',
        },
        {
          capabilityId: 'diagnostics_database',
          effectiveAvailability: 'system_only',
          allowed: false,
          reason: 'disabled',
        },
      ],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__lifecycle__get_codefresh_logs).toBeDefined();
    expect(tools.mcp__lifecycle__query_database).toBeUndefined();
  });

  it('requires approval for Lifecycle diagnostic fix tools even when capability policy allows them', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockModeForCapability.mockReturnValue('allow');
    const onToolStarted = jest.fn();
    const onToolFinished = jest.fn();
    const onFileChange = jest.fn();
    const resolveApprovalGitHubAuth = jest.fn().mockResolvedValue(null);

    const { tools, toolApproval } = await buildToolSetWithMetadataForTest({
      session: {
        uuid: 'session-build-context',
        sessionKind: 'chat',
        buildUuid: 'sample-build-1',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
      requestGitHubAuth: {
        githubToken: 'submit-token',
        source: 'user',
        githubUsername: 'submitter',
        writeAuthorized: false,
      },
      resolveApprovalGitHubAuth,
      hooks: {
        onToolStarted,
        onToolFinished,
        onFileChange,
        getActiveRunUuid: () => 'run-current',
      },
    });

    expect(typeof toolApproval.mcp__lifecycle__update_file).toBe('function');
    expectUserApproval(toolApproval, 'mcp__lifecycle__update_pr_labels');
    expectUserApproval(toolApproval, 'mcp__lifecycle__patch_k8s_resource');

    const updateFileTool = tools.mcp__lifecycle__update_file as unknown as {
      onInputAvailable: (input: { input: Record<string, unknown>; toolCallId?: string }) => Promise<void>;
      execute: (input: Record<string, unknown>, context?: { toolCallId?: string }) => Promise<unknown>;
    };

    await updateFileTool.onInputAvailable({
      input: {
        repository_owner: 'example-org',
        repository_name: 'example-repo',
        branch: 'feature/sample',
        file_path: './lifecycle.yaml',
        new_content: 'services:\\n  sample-service:\\n    branch: feature/sample',
      },
      toolCallId: 'tool-update-file',
    });
    await updateFileTool.execute(
      {
        repository_owner: 'example-org',
        repository_name: 'example-repo',
        branch: 'feature/sample',
        file_path: './lifecycle.yaml',
        new_content: 'services:\\n  sample-service:\\n    branch: feature/sample',
      },
      { toolCallId: 'tool-update-file' }
    );

    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tool-update-file',
        sourceTool: 'update_file',
        displayPath: 'lifecycle.yaml',
        stage: 'awaiting-approval',
        additions: 1,
        deletions: 1,
        beforeTextPreview: 'services:\n  sample-service:\n    branch: main',
        afterTextPreview: 'services:\n  sample-service:\n    branch: feature/sample',
        unifiedDiff: expect.stringContaining('-    branch: main'),
      })
    );
    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        unifiedDiff: expect.stringContaining('+    branch: feature/sample'),
      })
    );
    const proposedFileChange = onFileChange.mock.calls[0]?.[0] as { unifiedDiff?: string | null };
    expect(proposedFileChange.unifiedDiff?.match(/^\+\+\+ b\/lifecycle\.yaml$/gm)).toHaveLength(1);
    expect(resolveApprovalGitHubAuth).toHaveBeenCalledWith({
      runUuid: 'run-current',
      toolCallId: 'tool-update-file',
    });
    expect(mockDiagnosticToolExecute).toHaveBeenCalledWith(
      'update_file',
      {
        repository_owner: 'example-org',
        repository_name: 'example-repo',
        branch: 'feature/sample',
        file_path: './lifecycle.yaml',
        new_content: 'services:\\n  sample-service:\\n    branch: feature/sample',
      },
      undefined,
      { toolCallId: 'tool-update-file' }
    );
    expect(onToolStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'update_file',
        toolCallId: 'tool-update-file',
        capabilityKey: 'git_write',
      })
    );
    expect(onToolFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'update_file',
        status: 'completed',
      })
    );
  });

  it('configures Lifecycle diagnostic GitHub writes with the session branch and allowed config files', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockGetEffectiveAgentConfig.mockResolvedValue({
      allowedWritePatterns: ['sysops/dockerfiles/**'],
      excludedFilePatterns: ['secrets/**'],
    });
    mockParseYamlConfigFromBranch.mockResolvedValue({
      services: [
        {
          name: 'sample-service',
          github: {
            docker: {
              app: {
                dockerfilePath: 'services/sample/Dockerfile',
              },
            },
          },
        },
      ],
    });

    const { toolApproval } = await buildToolSetWithMetadataForTest({
      session: {
        uuid: 'session-build-context',
        sessionKind: 'chat',
        buildUuid: 'sample-build-1',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/sample',
            revision: null,
            mountPath: '/workspace',
            primary: true,
          },
        ],
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(mockParseYamlConfigFromBranch).toHaveBeenCalledWith('example-org/example-repo', 'feature/sample');
    const fixToolClient = mockGithubClientInstances.at(-1);
    expect(fixToolClient?.setAllowedBranch).toHaveBeenCalledWith('feature/sample');
    expect(fixToolClient?.setAllowedWritePatterns).toHaveBeenCalledWith(
      expect.arrayContaining(['lifecycle.yaml', 'lifecycle.yml', 'sysops/dockerfiles/**'])
    );
    expect(fixToolClient?.setExcludedFilePatterns).toHaveBeenCalledWith(['secrets/**']);
    expect(fixToolClient?.setReferencedFiles).toHaveBeenCalledWith(['services/sample/Dockerfile']);

    fixToolClient?.isFilePathAllowed.mockReturnValue(true);
    fixToolClient?.validateBranch.mockReturnValue({ valid: true });
    await expect(
      resolveToolApproval(toolApproval, 'mcp__lifecycle__update_file', {
        branch: 'feature/sample',
        file_path: 'services/sample/Dockerfile',
        new_content: 'FROM scratch\n',
      })
    ).resolves.toBe('user-approval');

    fixToolClient?.isFilePathAllowed.mockReturnValue(false);
    await expect(
      resolveToolApproval(toolApproval, 'mcp__lifecycle__update_file', {
        branch: 'feature/sample',
        file_path: 'secrets/token.txt',
      })
    ).resolves.toBe('not-applicable');
  });

  it('uses the workspace repo and branch for diagnostic GitHub safety while preserving selected deploy referenced files', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockParseYamlConfigFromBranch.mockResolvedValue({ services: [] });

    await buildToolSetForTest({
      session: {
        uuid: 'session-build-context',
        sessionKind: 'chat',
        buildUuid: 'sample-build-1',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/sample-fix',
            revision: null,
            mountPath: '/workspace',
            primary: true,
          },
        ],
        selectedServices: [
          {
            name: 'sample-service',
            deployId: 41,
            deployUuid: 'deploy-1',
            repo: 'example-org/example-repo',
            branch: 'main',
            revision: 'service-sha-1',
            workspacePath: '/workspace',
            dockerfilePath: 'services/sample/Dockerfile',
            initDockerfilePath: 'services/sample/init.Dockerfile',
            chartValueFiles: ['helm/sample-values.yaml'],
          },
        ],
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(mockParseYamlConfigFromBranch).toHaveBeenCalledWith('example-org/example-repo', 'feature/sample-fix');
    const fixToolClient = mockGithubClientInstances.at(-1);
    expect(fixToolClient?.setAllowedBranch).toHaveBeenCalledWith('feature/sample-fix');
    expect(fixToolClient?.setReferencedFiles).toHaveBeenCalledWith([
      'services/sample/Dockerfile',
      'services/sample/init.Dockerfile',
      'helm/sample-values.yaml',
    ]);
  });

  it('lets tool rules deny individual Lifecycle diagnostic fix tools', async () => {
    mockResolveServers.mockResolvedValue([]);

    const { tools, toolApproval } = await buildToolSetWithMetadataForTest({
      session: {
        uuid: 'session-build-context',
        sessionKind: 'chat',
        buildUuid: 'sample-build-1',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      toolRules: [
        {
          toolKey: 'mcp__lifecycle__update_file',
          mode: 'deny',
        },
      ],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__lifecycle__update_file).toBeUndefined();
    expect(toolApproval.mcp__lifecycle__update_file).toBeUndefined();
    expectUserApproval(toolApproval, 'mcp__lifecycle__update_pr_labels');
    expectUserApproval(toolApproval, 'mcp__lifecycle__patch_k8s_resource');
  });

  it('locks diagnostic tools to the build namespace, repos, and DB scope resolved from the Build', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockBuildFindOne.mockResolvedValue({
      id: 99,
      uuid: 'sample-build-1',
      namespace: 'env-sample-build-1',
      environmentId: 5,
      pullRequestId: 21,
      pullRequest: {
        id: 21,
        pullRequestNumber: 751,
        fullName: 'example-org/example-repo',
        repository: { id: 100, fullName: 'example-org/example-repo' },
      },
      deploys: [
        { repository: { id: 100, fullName: 'example-org/example-repo' } },
        { repository: { id: 200, fullName: 'example-org/secondary-repo' } },
      ],
    });

    await buildToolSetForTest({
      session: {
        uuid: 'session-build-context',
        sessionKind: 'chat',
        buildUuid: 'sample-build-1',
        workspaceStatus: 'none',
        status: 'active',
        podName: null,
        namespace: null,
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/sample',
            revision: null,
            mountPath: '/workspace',
            primary: true,
          },
        ],
      } as any,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    // k8s clients (read + fix factories) locked to the build's namespace.
    expect(mockK8sClientInstances.length).toBeGreaterThan(0);
    for (const client of mockK8sClientInstances) {
      expect(client.setAllowedNamespace).toHaveBeenCalledWith('env-sample-build-1');
    }

    // github clients locked to the FULL set of repos the build spans (multi-repo).
    for (const client of mockGithubClientInstances) {
      expect(client.setAllowedRepos).toHaveBeenCalledWith(
        expect.arrayContaining(['example-org/example-repo', 'example-org/secondary-repo'])
      );
      expect(client.setAllowedPullRequestNumber).toHaveBeenCalledWith(751);
    }

    // database client scoped to this build's records.
    expect(mockDatabaseClientInstances.length).toBeGreaterThan(0);
    expect(mockDatabaseClientInstances[0].setBuildScope).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: 99,
        buildUuid: 'sample-build-1',
        pullRequestId: 21,
        environmentId: 5,
        repositoryIds: expect.arrayContaining([100, 200]),
      })
    );
  });

  it('redacts MCP default args from tool audit hooks while preserving runtime execution args', async () => {
    mockResolveServers.mockResolvedValue([
      {
        slug: 'docs',
        name: 'Docs',
        transport: {
          type: 'http',
          url: 'https://mcp.example.test',
        },
        timeout: 30000,
        defaultArgs: {
          token: 'shared-secret-token',
          project: 'secret-project',
        },
        env: {},
        discoveredTools: [
          {
            name: 'lookup',
            description: 'Lookup docs',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                token: { type: 'string' },
                project: { type: 'string' },
              },
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      },
    ]);
    const onToolStarted = jest.fn();
    const onToolFinished = jest.fn();

    const tools = await buildToolSetForTest({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
      hooks: {
        onToolStarted,
        onToolFinished,
      },
    });

    const tool = tools.mcp__docs__lookup as {
      execute: (input: Record<string, unknown>, context?: { toolCallId?: string }) => Promise<unknown>;
    };
    await tool.execute({ query: 'routing' }, { toolCallId: 'tool-defaults' });

    expect(mockCallTool).toHaveBeenCalledWith(
      'lookup',
      {
        query: 'routing',
        token: 'shared-secret-token',
        project: 'secret-project',
      },
      30000
    );
    expect(onToolStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {
          query: 'routing',
          token: '******',
          project: '******',
        },
      })
    );
    expect(onToolFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {
          query: 'routing',
          token: '******',
          project: '******',
        },
      })
    );
  });

  it('redacts transport and env secrets from MCP tool failure audit output', async () => {
    mockResolveServers.mockResolvedValue([
      {
        slug: 'docs',
        name: 'Docs',
        transport: {
          type: 'http',
          url: 'https://mcp.example.test?api_key=query/secret+value',
          headers: {
            Authorization: 'Bearer transport-secret',
          },
        },
        timeout: 30000,
        defaultArgs: {
          token: 'shared-secret-token',
        },
        env: {
          SAMPLE_ENV_TOKEN: 'env-secret',
        },
        discoveredTools: [
          {
            name: 'lookup',
            description: 'Lookup docs',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                token: { type: 'string' },
              },
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      },
    ]);
    mockCallTool.mockRejectedValueOnce(
      new Error(
        'failed Authorization=Bearer transport-secret query=query/secret+value encoded=query%2Fsecret%2Bvalue env=env-secret token=shared-secret-token'
      )
    );
    const onToolFinished = jest.fn();

    const tools = await buildToolSetForTest({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
      hooks: {
        onToolFinished,
      },
    });

    const tool = tools.mcp__docs__lookup as {
      execute: (input: Record<string, unknown>, context?: { toolCallId?: string }) => Promise<unknown>;
    };
    await expect(tool.execute({ query: 'routing' }, { toolCallId: 'tool-failed' })).rejects.toThrow(
      'failed Authorization=****** query=****** encoded=****** env=****** token=******'
    );

    expect(onToolFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        result: {
          error: 'failed Authorization=****** query=****** encoded=****** env=****** token=******',
        },
      })
    );
  });

  it('redacts transport and env secrets from non-throwing MCP error results', async () => {
    mockResolveServers.mockResolvedValue([
      {
        slug: 'docs',
        name: 'Docs',
        transport: {
          type: 'http',
          url: 'https://mcp.example.test?api_key=query/secret+value',
          headers: {
            Authorization: 'Bearer transport-secret',
          },
        },
        timeout: 30000,
        defaultArgs: {
          token: 'shared-secret-token',
        },
        env: {
          SAMPLE_ENV_TOKEN: 'env-secret',
        },
        discoveredTools: [
          {
            name: 'lookup',
            description: 'Lookup docs',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                token: { type: 'string' },
              },
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      },
    ]);
    mockCallTool.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error:
              'failed Authorization=Bearer transport-secret query=query/secret+value encoded=query%2Fsecret%2Bvalue env=env-secret token=shared-secret-token',
            fileChanges: [
              {
                path: 'docs-output.txt',
                kind: 'created',
                additions: 1,
                deletions: 0,
                afterTextPreview: 'query=query/secret+value env=env-secret token=shared-secret-token',
                summary: 'Created with Authorization=Bearer transport-secret',
              },
            ],
          }),
        },
      ],
      isError: true,
    });
    const onToolFinished = jest.fn();
    const onFileChange = jest.fn();

    const tools = await buildToolSetForTest({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
      hooks: {
        onToolFinished,
        onFileChange,
      },
    });

    const tool = tools.mcp__docs__lookup as {
      execute: (input: Record<string, unknown>, context?: { toolCallId?: string }) => Promise<unknown>;
    };
    const result = await tool.execute({ query: 'routing' }, { toolCallId: 'tool-error-result' });
    const serializedResult = JSON.stringify(result);

    expect(serializedResult).toContain('Authorization=******');
    expect(serializedResult).toContain('query=******');
    expect(serializedResult).toContain('encoded=******');
    expect(serializedResult).toContain('env=******');
    expect(serializedResult).toContain('token=******');
    expect(serializedResult).not.toContain('Bearer transport-secret');
    expect(serializedResult).not.toContain('query/secret+value');
    expect(serializedResult).not.toContain('query%2Fsecret%2Bvalue');
    expect(serializedResult).not.toContain('env-secret');
    expect(serializedResult).not.toContain('shared-secret-token');
    expect(onToolFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        result,
      })
    );
    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tool-error-result',
        sourceTool: 'lookup',
        stage: 'failed',
        afterTextPreview: 'query=****** env=****** token=******',
        summary: 'Created with Authorization=******',
      })
    );
  });

  it('lets tool rules require approval for workspace_core HTTP publishing', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockModeForCapability.mockReturnValue('allow');

    const { tools, toolApproval } = await buildToolSetWithMetadataForTest({
      session: {
        uuid: 'session-chat',
        sessionKind: 'chat',
        workspaceStatus: 'ready',
        status: 'active',
        podName: 'agent-chat',
        namespace: 'chat-sample',
      } as any,
      repoFullName: undefined,
      userIdentity,
      approvalPolicy: {} as any,
      toolRules: [
        {
          toolKey: 'mcp__workspace_core__publish_http',
          mode: 'require_approval',
        },
      ],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__workspace_core__publish_http).toBeDefined();
    expectUserApproval(toolApproval, 'mcp__workspace_core__publish_http');
  });

  it('degrades a ready chat runtime to base tools when the gateway does not satisfy the workspace contract', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockListTools.mockResolvedValueOnce([
      workspaceGatewayTool('workspace.exec'),
      workspaceGatewayTool('workspace.write_file'),
      workspaceGatewayTool('workspace.edit_file'),
    ]);

    // A gateway problem for a chat (here a contract violation) must not abort the whole tool build and
    // leave the model with zero tools — base tools still register and the failure is logged, not thrown.
    const { tools } = await buildToolSetWithMetadataForTest({
      session: {
        uuid: 'session-chat',
        sessionKind: 'chat',
        workspaceStatus: 'ready',
        status: 'active',
        podName: 'agent-chat',
        namespace: 'chat-sample',
      } as any,
      repoFullName: undefined,
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(Object.keys(tools).length).toBeGreaterThan(0);
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(mockEnsureChatSandbox).not.toHaveBeenCalled();
  });
});
