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
const mockResolveServersForRepo = jest.fn();
const mockConnect = jest.fn();
const mockListTools = jest.fn();
const mockCallTool = jest.fn();
const mockClose = jest.fn();
const mockLoggerWarn = jest.fn();
const mockModeForCapability = jest.fn(() => 'allow');

let currentTransport: Record<string, unknown> | null = null;

jest.mock('ai', () => ({
  dynamicTool: (...args: unknown[]) => mockDynamicTool(...args),
  jsonSchema: (...args: unknown[]) => mockJsonSchema(...args),
}));

jest.mock('server/services/ai/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    resolveServersForRepo: (...args: unknown[]) => mockResolveServersForRepo(...args),
  })),
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

jest.mock('../PolicyService', () => ({
  __esModule: true,
  default: {
    capabilityForMcpTool: jest.fn(() => 'external_mcp_read'),
    modeForCapability: (...args: unknown[]) => mockModeForCapability(...args),
  },
}));

import AgentCapabilityService from '../CapabilityService';

describe('AgentCapabilityService.buildToolSet', () => {
  const session = {
    uuid: 'session-123',
    podName: 'agent-123',
    namespace: 'env-sample',
    status: 'active',
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
    mockResolveServersForRepo.mockResolvedValue([stdioServer]);
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

  it('omits session-pod stdio connectors when the sandbox gateway is unavailable', async () => {
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

    const tools = await AgentCapabilityService.buildToolSet({
      session,
      repoFullName: 'example-org/example-repo',
      userIdentity,
      approvalPolicy: {} as any,
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 15000,
    });

    expect(tools.mcp__figma__get_design_context).toBeUndefined();
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
});
