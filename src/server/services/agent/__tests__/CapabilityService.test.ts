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
const mockModeForCapability = jest.fn(() => 'allow');
const mockPublishChatHttpPort = jest.fn();
const mockFindSession = jest.fn();
const mockResolveWorkspaceGatewayBaseUrl = jest.fn();
const mockEnsureChatSandbox = jest.fn();

let currentTransport: Record<string, unknown> | null = null;

jest.mock('ai', () => ({
  dynamicTool: (...args: unknown[]) => mockDynamicTool(...args),
  jsonSchema: (...args: unknown[]) => mockJsonSchema(...args),
}));

jest.mock('server/services/ai/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    resolveServers: (...args: unknown[]) => mockResolveServers(...args),
  })),
}));

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
    ensureChatSandbox: (...args: unknown[]) => mockEnsureChatSandbox(...args),
  },
}));

jest.mock('server/services/ai/mcp/client', () => ({
  McpClientManager: jest.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockConnect(...args),
    listTools: (...args: unknown[]) => mockListTools(...args),
    callTool: (...args: unknown[]) => mockCallTool(...args),
    close: (...args: unknown[]) => mockClose(...args),
  })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  const actual = jest.requireActual('server/lib/agentSession/runtimeConfig');
  return {
    __esModule: true,
    ...actual,
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
    capabilityForSessionWorkspaceTool: jest.fn(() => 'read'),
    capabilityForExternalMcpTool: jest.fn(() => 'external_mcp_read'),
    modeForCapability: (...args: unknown[]) => mockModeForCapability(...args),
  },
}));

import AgentCapabilityService from '../CapabilityService';
import { SessionWorkspaceGatewayUnavailableError } from '../errors';

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
    mockModeForCapability.mockReturnValue('allow');
    currentTransport = null;
    mockResolveServers.mockResolvedValue([stdioServer]);
    mockFindSession.mockResolvedValue(session);
    mockPublishChatHttpPort.mockResolvedValue({
      url: 'https://chat-session.example.test',
      host: 'chat-session.example.test',
      path: '/',
      port: 3000,
      serviceName: 'agent-preview-sample',
      ingressName: 'agent-preview-ingress-sample',
    });
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
    mockListTools.mockImplementation(async () => {
      if (
        currentTransport &&
        currentTransport.type === 'http' &&
        currentTransport.url === 'http://agent-123.env-sample.svc.cluster.local:13338/mcp'
      ) {
        return [
          {
            name: 'workspace.read_file',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ];
      }

      return [];
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    mockClose.mockResolvedValue(undefined);
  });

  it('routes stdio MCP execution through the session-pod proxy endpoint', async () => {
    const tools = await AgentCapabilityService.buildToolSet({
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

    const tool = tools.mcp__figma__get_design_context as {
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

  it('uses the configured workspace execution timeout for sandbox tools', async () => {
    const tools = await AgentCapabilityService.buildToolSet({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    const tool = tools.mcp__sandbox__workspace_read_file as {
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    };
    expect(tool).toBeDefined();

    await tool.execute({});

    expect(mockConnect).toHaveBeenLastCalledWith(
      {
        type: 'http',
        url: 'http://agent-123.env-sample.svc.cluster.local:13338/mcp',
      },
      22000
    );
    expect(mockCallTool).toHaveBeenCalledWith('workspace.read_file', {}, 22000);
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
      AgentCapabilityService.buildToolSet({
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

  it('lets session tool rules override the family approval mode for sandbox tools', async () => {
    mockModeForCapability.mockReturnValue('deny');

    const tools = await AgentCapabilityService.buildToolSet({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      toolRules: [
        {
          toolKey: 'mcp__sandbox__workspace_read_file',
          mode: 'allow',
        },
      ],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__sandbox__workspace_read_file).toEqual(
      expect.objectContaining({
        needsApproval: false,
      })
    );
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

    const tools = await AgentCapabilityService.buildToolSet({
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
    expect(tools.mcp__sandbox__workspace_exec).toEqual(
      expect.objectContaining({
        needsApproval: false,
      })
    );
    expect(tools.mcp__sandbox__workspace_exec_mutation).toEqual(
      expect.objectContaining({
        needsApproval: false,
      })
    );
    expect(tools.mcp__lifecycle__publish_http).toEqual(
      expect.objectContaining({
        needsApproval: true,
      })
    );
    expect(Object.keys(tools).some((key) => key.includes('__source_'))).toBe(false);
    expect(tools.mcp__lifecycle__workspace_provision).toBeUndefined();
  });

  it('lets tool rules require approval for chat HTTP publishing', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockModeForCapability.mockReturnValue('allow');

    const tools = await AgentCapabilityService.buildToolSet({
      session: {
        ...session,
        sessionKind: 'chat',
      } as any,
      repoFullName: undefined,
      userIdentity,
      approvalPolicy: {} as any,
      toolRules: [
        {
          toolKey: 'mcp__lifecycle__publish_http',
          mode: 'require_approval',
        },
      ],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__lifecycle__publish_http).toEqual(
      expect.objectContaining({
        needsApproval: true,
      })
    );
  });

  it('exposes lazy chat workspace tools before runtime without provisioning during setup', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockFindSession.mockResolvedValue({
      uuid: 'session-chat',
      sessionKind: 'chat',
      workspaceStatus: 'none',
      status: 'active',
      podName: null,
      namespace: null,
    });

    const tools = await AgentCapabilityService.buildToolSet({
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
    });

    expect(tools.mcp__lifecycle__workspace_provision).toBeUndefined();
    expect(mockEnsureChatSandbox).not.toHaveBeenCalled();
    expect(tools.mcp__sandbox__workspace_exec).toEqual(
      expect.objectContaining({
        needsApproval: false,
      })
    );
    expect(tools.mcp__sandbox__workspace_exec_mutation).toEqual(
      expect.objectContaining({
        needsApproval: false,
      })
    );
    expect(tools.mcp__sandbox__workspace_write_file).toEqual(
      expect.objectContaining({
        needsApproval: false,
      })
    );
    expect(tools.mcp__sandbox__workspace_edit_file).toEqual(
      expect.objectContaining({
        needsApproval: false,
      })
    );
    expect(tools.mcp__lifecycle__publish_http).toEqual(
      expect.objectContaining({
        needsApproval: false,
      })
    );
    expect(Object.keys(tools).some((key) => key.includes('__source_'))).toBe(false);

    const tool = tools.mcp__sandbox__workspace_write_file as {
      execute: (input: Record<string, unknown>, context?: { toolCallId?: string }) => Promise<unknown>;
    };

    await expect(
      tool.execute(
        {
          path: 'sample.txt',
          content: 'hello',
        },
        { toolCallId: 'tool-write' }
      )
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });

    expect(mockEnsureChatSandbox).toHaveBeenCalledWith({
      sessionId: 'session-chat',
      userId: 'sample-user',
      userIdentity,
      githubToken: 'sample-gh-token',
    });
    expect(mockCallTool).toHaveBeenCalledWith(
      'workspace.write_file',
      {
        path: 'sample.txt',
        content: 'hello',
      },
      22000
    );
  });

  it('lets tool rules require approval for lazy chat workspace tools before runtime exists', async () => {
    mockResolveServers.mockResolvedValue([]);

    const tools = await AgentCapabilityService.buildToolSet({
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
      toolRules: [
        {
          toolKey: 'mcp__sandbox__workspace_write_file',
          mode: 'require_approval',
        },
      ],
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
    });

    expect(tools.mcp__sandbox__workspace_write_file).toEqual(
      expect.objectContaining({
        needsApproval: true,
      })
    );
  });

  it('runs GitHub CLI commands through the generic workspace mutation tool with request GitHub auth', async () => {
    mockResolveServers.mockResolvedValue([]);

    const tools = await AgentCapabilityService.buildToolSet({
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
    });

    const tool = tools.mcp__sandbox__workspace_exec_mutation as {
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    };
    mockFindSession.mockResolvedValueOnce({
      uuid: 'session-chat',
      sessionKind: 'chat',
      workspaceStatus: 'none',
      status: 'active',
      podName: null,
      namespace: null,
    });

    await tool.execute({
      command: 'gh repo clone example-org/private-repo private-repo',
      cwd: '.',
    });

    expect(mockEnsureChatSandbox).toHaveBeenCalledWith({
      sessionId: 'session-chat',
      userId: 'sample-user',
      userIdentity,
      githubToken: 'sample-gh-token',
    });
    expect(mockCallTool).toHaveBeenCalledWith(
      'workspace.exec',
      {
        command: 'gh repo clone example-org/private-repo private-repo',
        cwd: '.',
        captureFileChanges: true,
      },
      22000
    );
  });

  it('emits file changes returned by lazy chat workspace mutation commands', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockCallTool.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            command: "printf 'number 1\\n' > fresh-e2e-artifacts/numbers.txt",
            success: true,
            fileChanges: [
              {
                path: 'fresh-e2e-artifacts/numbers.txt',
                kind: 'created',
                additions: 1,
                deletions: 0,
                beforeTextPreview: '',
                afterTextPreview: 'number 1\n',
                summary: 'Created fresh-e2e-artifacts/numbers.txt',
              },
            ],
          }),
        },
      ],
      isError: false,
    });
    const onFileChange = jest.fn();

    const tools = await AgentCapabilityService.buildToolSet({
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
      hooks: {
        onFileChange,
      },
    });

    const tool = tools.mcp__sandbox__workspace_exec_mutation as {
      execute: (input: Record<string, unknown>, context?: { toolCallId?: string }) => Promise<unknown>;
    };

    await tool.execute(
      {
        command: "printf 'number 1\\n' > fresh-e2e-artifacts/numbers.txt",
      },
      { toolCallId: 'tool-call-1' }
    );

    expect(mockCallTool).toHaveBeenCalledWith(
      'workspace.exec',
      {
        command: "printf 'number 1\\n' > fresh-e2e-artifacts/numbers.txt",
        captureFileChanges: true,
      },
      22000
    );
    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool-call-1:fresh-e2e-artifacts/numbers.txt',
        toolCallId: 'tool-call-1',
        sourceTool: 'workspace.exec_mutation',
        path: 'fresh-e2e-artifacts/numbers.txt',
        kind: 'created',
        additions: 1,
        stage: 'applied',
      })
    );
  });

  it('emits file changes returned by discovered workspace mutation commands', async () => {
    mockResolveServers.mockResolvedValue([]);
    mockListTools.mockResolvedValueOnce([
      {
        name: 'workspace.exec',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
        },
        annotations: {
          destructiveHint: true,
        },
      },
    ]);
    mockCallTool.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            command: "printf 'number 1\\n' > fresh-e2e-artifacts/numbers.txt",
            success: true,
            fileChanges: [
              {
                path: 'fresh-e2e-artifacts/numbers.txt',
                kind: 'created',
                additions: 1,
                deletions: 0,
              },
            ],
          }),
        },
      ],
      isError: false,
    });
    const onFileChange = jest.fn();

    const tools = await AgentCapabilityService.buildToolSet({
      session,
      repoFullName: undefined,
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
      hooks: {
        onFileChange,
      },
    });

    const tool = tools.mcp__sandbox__workspace_exec_mutation as {
      execute: (input: Record<string, unknown>, context?: { toolCallId?: string }) => Promise<unknown>;
    };

    await tool.execute(
      {
        command: "printf 'number 1\\n' > fresh-e2e-artifacts/numbers.txt",
      },
      { toolCallId: 'tool-call-2' }
    );

    expect(mockCallTool).toHaveBeenCalledWith(
      'workspace.exec',
      {
        command: "printf 'number 1\\n' > fresh-e2e-artifacts/numbers.txt",
        captureFileChanges: true,
      },
      22000
    );
    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool-call-2:fresh-e2e-artifacts/numbers.txt',
        toolCallId: 'tool-call-2',
        sourceTool: 'workspace.exec_mutation',
        path: 'fresh-e2e-artifacts/numbers.txt',
        kind: 'created',
        stage: 'applied',
      })
    );
  });

  it('blocks unsafe broad process kill commands before they reach the workspace gateway', async () => {
    mockResolveServers.mockResolvedValue([]);

    const tools = await AgentCapabilityService.buildToolSet({
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

    const tool = tools.mcp__sandbox__workspace_exec_mutation as {
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    };

    mockConnect.mockClear();
    mockCallTool.mockClear();
    await expect(tool.execute({ command: 'kill -9 $(pidof node)' })).rejects.toThrow('workspace gateway');
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});
