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

const mockConnect = jest.fn();
const mockListTools = jest.fn();
const mockClose = jest.fn();
const mockResolveWorkspaceGatewayEndpoint = jest.fn();
const mockEnsureChatSandbox = jest.fn();
const mockUsesSessionWorkspaceGatewayExecution = jest.fn(
  (transport?: { type?: string }) => transport?.type === 'stdio'
);
const mockResolveAgentSessionDurabilityConfig = jest.fn();
const mockModeForCapability = jest.fn();
const mockIsCatalogCapabilityAllowed = jest.fn();
const mockResolveToolApprovalMode = jest.fn();
const mockToAiDynamicTool = jest.fn((config) => config);
const mockToAiJsonSchema = jest.fn((schema) => schema);
const mockToAiRuntimeToolContextSchema = jest.fn(() => ({ type: 'runtime-context' }));
const mockRecordToolMetadata = jest.fn();
const mockRecordToolApproval = jest.fn();
const mockLoadLatestSession = jest.fn();
const mockBuildAgentRuntimeToolContextFromMetadataInput = jest.fn((metadata) => ({ ...metadata }));
const mockResolveAgentRuntimeToolContext = jest.fn((context, fallback) =>
  context && typeof context === 'object' ? { ...fallback, ...context } : fallback
);
const mockReconcileLostChatWorkspaceRuntime = jest.fn();
const mockFindMissingWorkspaceGatewayTools = jest.fn();
const mockBuildWorkspaceGatewayContractFailureMessage = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('server/services/agentRuntime/mcp/client', () => ({
  McpClientManager: jest.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockConnect(...args),
    listTools: (...args: unknown[]) => mockListTools(...args),
    close: (...args: unknown[]) => mockClose(...args),
  })),
}));

jest.mock('../SandboxService', () => ({
  __esModule: true,
  default: {
    resolveWorkspaceGatewayEndpoint: (...args: unknown[]) => mockResolveWorkspaceGatewayEndpoint(...args),
    ensureChatSandbox: (...args: unknown[]) => mockEnsureChatSandbox(...args),
  },
}));

jest.mock('server/services/agentRuntime/mcp/sessionPod', () => ({
  usesSessionWorkspaceGatewayExecution: (...args: unknown[]) => mockUsesSessionWorkspaceGatewayExecution(...args),
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  resolveAgentSessionDurabilityConfig: (...args: unknown[]) => mockResolveAgentSessionDurabilityConfig(...args),
}));

jest.mock('../PolicyService', () => ({
  __esModule: true,
  default: {
    modeForCapability: (...args: unknown[]) => mockModeForCapability(...args),
  },
}));

jest.mock('../capabilityToolHelpers', () => ({
  isCatalogCapabilityAllowed: (...args: unknown[]) => mockIsCatalogCapabilityAllowed(...args),
  recordToolApproval: (...args: unknown[]) => mockRecordToolApproval(...args),
  recordToolMetadata: (...args: unknown[]) => mockRecordToolMetadata(...args),
  resolveToolApprovalMode: (...args: unknown[]) => mockResolveToolApprovalMode(...args),
  toAiDynamicTool: (...args: unknown[]) => mockToAiDynamicTool(...args),
  toAiJsonSchema: (...args: unknown[]) => mockToAiJsonSchema(...args),
  toAiRuntimeToolContextSchema: (...args: unknown[]) => mockToAiRuntimeToolContextSchema(...args),
}));

jest.mock('../capabilitySessionContext', () => ({
  loadLatestSession: (...args: unknown[]) => mockLoadLatestSession(...args),
}));

jest.mock('../runtimeContext', () => ({
  buildAgentRuntimeToolContextFromMetadataInput: (...args: unknown[]) =>
    mockBuildAgentRuntimeToolContextFromMetadataInput(...args),
  resolveAgentRuntimeToolContext: (...args: unknown[]) => mockResolveAgentRuntimeToolContext(...args),
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    reconcileLostChatWorkspaceRuntime: (...args: unknown[]) => mockReconcileLostChatWorkspaceRuntime(...args),
  },
}));

jest.mock('server/services/workspaceRuntime/gatewayContract', () => ({
  findMissingWorkspaceGatewayTools: (...args: unknown[]) => mockFindMissingWorkspaceGatewayTools(...args),
  buildWorkspaceGatewayContractFailureMessage: (...args: unknown[]) =>
    mockBuildWorkspaceGatewayContractFailureMessage(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

type GatewayModule = typeof import('../chatWorkspaceToolRegistration');

const DISCOVERED_TOOLS = [{ name: 'workspace.exec', description: 'exec', inputSchema: {} }];
const TIMEOUTS = { discoveryTimeoutMs: 3000, executionTimeoutMs: 30000 };
const REQUEST_WORKSPACE_TOOL_KEY = 'mcp__lifecycle__request_workspace';
const USER_IDENTITY = {
  userId: 'sample-user',
  githubUsername: 'octocat',
  displayName: 'Sample User',
} as never;

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'session-1',
    sessionKind: 'chat',
    status: 'active',
    workspaceStatus: 'ready',
    podName: 'pod-a',
    namespace: 'ns-a',
    ...overrides,
  } as never;
}

function loadModule(): GatewayModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../chatWorkspaceToolRegistration') as GatewayModule;
}

function resetModuleMocks() {
  jest.resetModules();
  jest.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockListTools.mockResolvedValue(DISCOVERED_TOOLS);
  mockClose.mockResolvedValue(undefined);
  mockResolveWorkspaceGatewayEndpoint.mockResolvedValue({ url: 'http://gateway:8080' });
  mockEnsureChatSandbox.mockResolvedValue({ session: buildSession() });
  mockUsesSessionWorkspaceGatewayExecution.mockImplementation(
    (transport?: { type?: string }) => transport?.type === 'stdio'
  );
  mockResolveAgentSessionDurabilityConfig.mockResolvedValue({ fileChangePreviewChars: 4096 });
  mockModeForCapability.mockReturnValue('allow');
  mockIsCatalogCapabilityAllowed.mockReturnValue(true);
  mockResolveToolApprovalMode.mockReturnValue('allow');
  mockToAiDynamicTool.mockImplementation((config) => config);
  mockToAiJsonSchema.mockImplementation((schema) => schema);
  mockToAiRuntimeToolContextSchema.mockReturnValue({ type: 'runtime-context' });
  mockRecordToolMetadata.mockImplementation((target, metadata) => target?.push(metadata));
  mockRecordToolApproval.mockImplementation((target, { toolKey, mode }) => {
    if (target && mode === 'require_approval') {
      target[toolKey] = 'user-approval';
    }
  });
  mockBuildAgentRuntimeToolContextFromMetadataInput.mockImplementation((metadata) => ({ ...metadata }));
  mockResolveAgentRuntimeToolContext.mockImplementation((context, fallback) =>
    context && typeof context === 'object' ? { ...fallback, ...context } : fallback
  );
  mockReconcileLostChatWorkspaceRuntime.mockResolvedValue(null);
  mockFindMissingWorkspaceGatewayTools.mockReturnValue([]);
  mockBuildWorkspaceGatewayContractFailureMessage.mockReturnValue('missing required workspace tools');
}

function buildServer(transport: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    scope: 'global',
    slug: 'example/server',
    name: 'Example server',
    transport,
    timeout: 15000,
    defaultArgs: {},
    env: {},
    discoveredTools: [],
    ...overrides,
  } as never;
}

function registerWorkspaceTool(
  gatewayModule: GatewayModule,
  overrides: Record<string, unknown> = {}
): {
  tools: Record<string, any>;
  toolMetadata: Array<Record<string, unknown>>;
  toolApproval: Record<string, unknown>;
} {
  const tools: Record<string, any> = {};
  const toolMetadata: Array<Record<string, unknown>> = [];
  const toolApproval: Record<string, unknown> = {};

  gatewayModule.registerChatRequestWorkspaceTool({
    tools,
    session: buildSession(),
    userIdentity: USER_IDENTITY,
    approvalPolicy: { defaultMode: 'allow', rules: {} } as never,
    autoProvisionWorkspace: true,
    resolvedCapabilityAccess: [{ capabilityId: 'read_context', allowed: true }],
    toolMetadata: toolMetadata as never,
    toolApproval: toolApproval as never,
    ...overrides,
  } as never);

  return { tools, toolMetadata, toolApproval };
}

describe('resolveSessionWorkspaceGatewayServer discovery cache', () => {
  beforeEach(() => {
    // Fresh module per test so the module-level discovery cache starts empty.
    resetModuleMocks();
  });

  it('discovers live by default and populates the cache for approval resumes', async () => {
    const gatewayModule = loadModule();
    const session = buildSession();

    const liveServer = await gatewayModule.resolveSessionWorkspaceGatewayServer(session, TIMEOUTS);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(liveServer?.discoveredTools).toEqual(DISCOVERED_TOOLS);

    const cachedServer = await gatewayModule.resolveSessionWorkspaceGatewayServer(session, TIMEOUTS, {
      discoveryMode: 'prefer_cached',
    });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockListTools).toHaveBeenCalledTimes(1);
    expect(cachedServer?.discoveredTools).toEqual(DISCOVERED_TOOLS);
    expect(cachedServer?.transport).toEqual({ type: 'http', url: 'http://gateway:8080/mcp' });
  });

  it('falls back to live discovery when nothing is cached', async () => {
    const gatewayModule = loadModule();

    const server = await gatewayModule.resolveSessionWorkspaceGatewayServer(buildSession(), TIMEOUTS, {
      discoveryMode: 'prefer_cached',
    });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(server?.discoveredTools).toEqual(DISCOVERED_TOOLS);
  });

  it('misses the cache when the workspace pod or status changes', async () => {
    const gatewayModule = loadModule();

    await gatewayModule.resolveSessionWorkspaceGatewayServer(buildSession(), TIMEOUTS);
    await gatewayModule.resolveSessionWorkspaceGatewayServer(buildSession({ podName: 'pod-b' }), TIMEOUTS, {
      discoveryMode: 'prefer_cached',
    });
    expect(mockConnect).toHaveBeenCalledTimes(2);

    await gatewayModule.resolveSessionWorkspaceGatewayServer(
      buildSession({ workspaceStatus: 'provisioning' }),
      TIMEOUTS,
      {
        discoveryMode: 'prefer_cached',
      }
    );
    expect(mockConnect).toHaveBeenCalledTimes(3);
  });

  it('expires cached discovery after the TTL', async () => {
    const gatewayModule = loadModule();
    const session = buildSession();
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1_000_000);
    await gatewayModule.resolveSessionWorkspaceGatewayServer(session, TIMEOUTS);

    nowSpy.mockReturnValue(1_000_000 + 6 * 60 * 1000);
    await gatewayModule.resolveSessionWorkspaceGatewayServer(session, TIMEOUTS, { discoveryMode: 'prefer_cached' });
    expect(mockConnect).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('does not read the cache in live mode', async () => {
    const gatewayModule = loadModule();
    const session = buildSession();

    await gatewayModule.resolveSessionWorkspaceGatewayServer(session, TIMEOUTS);
    await gatewayModule.resolveSessionWorkspaceGatewayServer(session, TIMEOUTS);
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('returns null without opening a client when no workspace endpoint exists', async () => {
    const gatewayModule = loadModule();
    mockResolveWorkspaceGatewayEndpoint.mockResolvedValue(null);

    await expect(
      gatewayModule.resolveSessionWorkspaceGatewayServer(
        buildSession({ status: 'error', podName: null, namespace: null }),
        TIMEOUTS
      )
    ).resolves.toBeNull();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockListTools).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('uses endpoint headers and configured execution timeout in the discovered server', async () => {
    const gatewayModule = loadModule();
    mockResolveWorkspaceGatewayEndpoint.mockResolvedValue({
      url: 'https://gateway.example.test/',
      headers: { authorization: 'Bearer workspace-token' },
    });

    const server = await gatewayModule.resolveSessionWorkspaceGatewayServer(buildSession(), TIMEOUTS);

    expect(mockConnect).toHaveBeenCalledWith(
      {
        type: 'http',
        url: 'https://gateway.example.test/mcp',
        headers: { authorization: 'Bearer workspace-token' },
      },
      3000
    );
    expect(server).toMatchObject({
      scope: 'session',
      slug: 'sandbox',
      name: 'Session Workspace',
      timeout: 30000,
      transport: {
        type: 'http',
        url: 'https://gateway.example.test/mcp',
        headers: { authorization: 'Bearer workspace-token' },
      },
      discoveredTools: DISCOVERED_TOOLS,
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('wraps a gateway contract violation and still closes the client', async () => {
    const gatewayModule = loadModule();
    mockFindMissingWorkspaceGatewayTools.mockReturnValue(['workspace.write']);

    await expect(gatewayModule.resolveSessionWorkspaceGatewayServer(buildSession(), TIMEOUTS)).rejects.toMatchObject({
      name: 'SessionWorkspaceGatewayUnavailableError',
      sessionId: 'session-1',
      message: 'Session workspace gateway unavailable: missing required workspace tools',
    });
    expect(mockBuildWorkspaceGatewayContractFailureMessage).toHaveBeenCalledWith(['workspace.write']);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { error: expect.objectContaining({ message: 'missing required workspace tools' }) },
      expect.stringContaining('sessionId=session-1 namespace=ns-a podName=pod-a')
    );
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('wraps connection failures and does not attempt discovery', async () => {
    const gatewayModule = loadModule();
    mockConnect.mockRejectedValueOnce(new Error('connection refused'));

    await expect(gatewayModule.resolveSessionWorkspaceGatewayServer(buildSession(), TIMEOUTS)).rejects.toMatchObject({
      name: 'SessionWorkspaceGatewayUnavailableError',
      sessionId: 'session-1',
      message: 'Session workspace gateway unavailable: connection refused',
    });
    expect(mockListTools).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('prunes stale entries while writing a different live cache entry', async () => {
    const gatewayModule = loadModule();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

    await gatewayModule.resolveSessionWorkspaceGatewayServer(buildSession({ uuid: 'session-a' }), TIMEOUTS);
    nowSpy.mockReturnValue(1_000_000 + 6 * 60 * 1000);
    await gatewayModule.resolveSessionWorkspaceGatewayServer(buildSession({ uuid: 'session-b' }), TIMEOUTS);
    await gatewayModule.resolveSessionWorkspaceGatewayServer(buildSession({ uuid: 'session-a' }), TIMEOUTS, {
      discoveryMode: 'prefer_cached',
    });

    expect(mockConnect).toHaveBeenCalledTimes(3);
    nowSpy.mockRestore();
  });

  it('caches an externally resolved gateway without Kubernetes pod coordinates', async () => {
    const gatewayModule = loadModule();
    const session = buildSession({ workspaceStatus: 'none', podName: null, namespace: null });
    mockResolveWorkspaceGatewayEndpoint.mockResolvedValue({
      url: 'https://external-workspace.example.test',
      headers: { authorization: 'Bearer external-token' },
    });

    await gatewayModule.resolveSessionWorkspaceGatewayServer(session, TIMEOUTS);
    await gatewayModule.resolveSessionWorkspaceGatewayServer(session, TIMEOUTS, {
      discoveryMode: 'prefer_cached',
    });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockListTools).toHaveBeenCalledTimes(1);
  });
});

describe('chat workspace endpoint and execution resolution', () => {
  beforeEach(() => {
    resetModuleMocks();
  });

  it('prefers the sandbox service endpoint and preserves its headers', async () => {
    const gatewayModule = loadModule();
    const endpoint = {
      url: 'https://workspace.example.test',
      headers: { authorization: 'Bearer token' },
    };
    mockResolveWorkspaceGatewayEndpoint.mockResolvedValue(endpoint);

    await expect(gatewayModule.resolveSessionGatewayEndpoint(buildSession())).resolves.toEqual(endpoint);
    expect(mockResolveWorkspaceGatewayEndpoint).toHaveBeenCalledWith('session-1');
  });

  it('falls back to the in-cluster pod endpoint for an active legacy session', async () => {
    const gatewayModule = loadModule();
    mockResolveWorkspaceGatewayEndpoint.mockResolvedValue(null);

    await expect(gatewayModule.resolveSessionGatewayEndpoint(buildSession())).resolves.toEqual({
      url: expect.stringMatching(/^http:\/\/pod-a\.ns-a\.svc\.cluster\.local:\d+$/),
    });
  });

  it.each([
    ['missing pod', { podName: null }],
    ['missing namespace', { namespace: null }],
    ['inactive session', { status: 'error' }],
  ])('does not derive a pod endpoint for an active-shape session with %s', async (_name, overrides) => {
    const gatewayModule = loadModule();
    mockResolveWorkspaceGatewayEndpoint.mockResolvedValue(null);

    await expect(gatewayModule.resolveSessionGatewayEndpoint(buildSession(overrides))).resolves.toBeNull();
  });

  it('wraps endpoint lookup failures in the workspace-unavailable error', async () => {
    const gatewayModule = loadModule();
    mockResolveWorkspaceGatewayEndpoint.mockRejectedValueOnce(new Error('token decryption failed'));

    await expect(gatewayModule.resolveSessionGatewayEndpoint(buildSession())).rejects.toMatchObject({
      name: 'SessionWorkspaceGatewayUnavailableError',
      sessionId: 'session-1',
      message: 'Session workspace gateway unavailable: token decryption failed',
    });
  });

  it.each([
    ['ready chat runtime', {}, true],
    ['non-chat session', { sessionKind: 'deploy' }, false],
    ['inactive session', { status: 'error' }, false],
    ['workspace still provisioning', { workspaceStatus: 'provisioning' }, false],
    ['missing namespace', { namespace: null }, false],
    ['missing pod', { podName: null }, false],
  ])('reports %s readiness', (_name, overrides, expected) => {
    const gatewayModule = loadModule();
    expect(gatewayModule.isChatWorkspaceRuntimeReady(buildSession(overrides))).toBe(expected);
  });

  it('leaves non-session transports unchanged without resolving an endpoint', async () => {
    const gatewayModule = loadModule();
    const server = buildServer({ type: 'http', url: 'https://mcp.example.test' });

    await expect(gatewayModule.resolveSessionExecutionServer(buildSession(), server)).resolves.toBe(server);
    expect(mockResolveWorkspaceGatewayEndpoint).not.toHaveBeenCalled();
  });

  it('routes a session transport through a supplied gateway endpoint', async () => {
    const gatewayModule = loadModule();
    const server = buildServer({ type: 'stdio', command: 'node', args: ['server.js'] });

    await expect(
      gatewayModule.resolveSessionExecutionServer(buildSession(), server, {
        url: 'https://gateway.example.test/',
        headers: { authorization: 'Bearer token' },
      })
    ).resolves.toEqual({
      ...server,
      transport: {
        type: 'http',
        url: 'https://gateway.example.test/servers/example%2Fserver/mcp',
        headers: { authorization: 'Bearer token' },
      },
    });
    expect(mockResolveWorkspaceGatewayEndpoint).not.toHaveBeenCalled();
  });

  it('returns null for a session transport when the supplied endpoint is unavailable', async () => {
    const gatewayModule = loadModule();
    const server = buildServer({ type: 'stdio', command: 'node', args: ['server.js'] });

    await expect(gatewayModule.resolveSessionExecutionServer(buildSession(), server, null)).resolves.toBeNull();
    expect(mockResolveWorkspaceGatewayEndpoint).not.toHaveBeenCalled();
  });

  it('resolves the session endpoint when the caller does not supply one', async () => {
    const gatewayModule = loadModule();
    const server = buildServer({ type: 'stdio', command: 'node', args: ['server.js'] }, { slug: 'shell' });
    mockResolveWorkspaceGatewayEndpoint.mockResolvedValue({ url: 'http://gateway:8080' });

    await expect(gatewayModule.resolveSessionExecutionServer(buildSession(), server)).resolves.toMatchObject({
      transport: { type: 'http', url: 'http://gateway:8080/servers/shell/mcp' },
    });
    expect(mockResolveWorkspaceGatewayEndpoint).toHaveBeenCalledWith('session-1');
  });

  it('returns the configured file-change preview limit', async () => {
    const gatewayModule = loadModule();
    mockResolveAgentSessionDurabilityConfig.mockResolvedValue({ fileChangePreviewChars: 12345 });

    await expect(gatewayModule.getFileChangePreviewChars()).resolves.toBe(12345);
  });
});

describe('registerChatRequestWorkspaceTool', () => {
  beforeEach(() => {
    resetModuleMocks();
  });

  it('does not register the tool for a non-chat session', () => {
    const gatewayModule = loadModule();
    const { tools } = registerWorkspaceTool(gatewayModule, {
      session: buildSession({ sessionKind: 'deploy' }),
    });

    expect(tools).toEqual({});
    expect(mockIsCatalogCapabilityAllowed).not.toHaveBeenCalled();
    expect(mockResolveToolApprovalMode).not.toHaveBeenCalled();
    expect(mockToAiDynamicTool).not.toHaveBeenCalled();
  });

  it('does not register the tool when read-context capability access is denied', () => {
    const gatewayModule = loadModule();
    mockIsCatalogCapabilityAllowed.mockReturnValue(false);

    const { tools } = registerWorkspaceTool(gatewayModule);

    expect(tools).toEqual({});
    expect(mockIsCatalogCapabilityAllowed).toHaveBeenCalledWith(
      [{ capabilityId: 'read_context', allowed: true }],
      'read_context'
    );
    expect(mockResolveToolApprovalMode).not.toHaveBeenCalled();
    expect(mockToAiDynamicTool).not.toHaveBeenCalled();
  });

  it('does not register or record a policy-denied tool', () => {
    const gatewayModule = loadModule();
    const toolRules = [{ toolKey: REQUEST_WORKSPACE_TOOL_KEY, mode: 'deny' }];
    mockModeForCapability.mockReturnValue('require_approval');
    mockResolveToolApprovalMode.mockReturnValue('deny');

    const { tools, toolMetadata, toolApproval } = registerWorkspaceTool(gatewayModule, { toolRules });

    expect(mockModeForCapability).toHaveBeenCalledWith(expect.anything(), 'read');
    expect(mockResolveToolApprovalMode).toHaveBeenCalledWith({
      toolRules,
      toolKey: REQUEST_WORKSPACE_TOOL_KEY,
      capabilityMode: 'require_approval',
    });
    expect(tools).toEqual({});
    expect(toolMetadata).toEqual([]);
    expect(toolApproval).toEqual({});
    expect(mockRecordToolMetadata).not.toHaveBeenCalled();
    expect(mockRecordToolApproval).not.toHaveBeenCalled();
  });

  it('registers the allow-mode tool with its schema and metadata contract', () => {
    const gatewayModule = loadModule();
    const { tools, toolMetadata, toolApproval } = registerWorkspaceTool(gatewayModule);
    const tool = tools[REQUEST_WORKSPACE_TOOL_KEY];

    expect(tool).toMatchObject({
      description: expect.stringContaining('Request a Lifecycle workspace'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: expect.objectContaining({ type: 'string' }),
          timeout_ms: expect.objectContaining({ type: 'integer', minimum: 1000, maximum: 1800000 }),
        },
      },
      contextSchema: { type: 'runtime-context' },
      execute: expect.any(Function),
    });
    expect(mockToAiJsonSchema).toHaveBeenCalledWith(tool.inputSchema);
    expect(mockBuildAgentRuntimeToolContextFromMetadataInput).toHaveBeenCalledWith({
      toolKey: REQUEST_WORKSPACE_TOOL_KEY,
      serverSlug: 'lifecycle',
      sourceToolName: 'request_workspace',
      catalogCapabilityId: 'read_context',
      capabilityKey: 'read',
      approvalMode: 'allow',
    });
    expect(toolMetadata).toEqual([
      {
        toolKey: REQUEST_WORKSPACE_TOOL_KEY,
        serverSlug: 'lifecycle',
        sourceToolName: 'request_workspace',
        catalogCapabilityId: 'read_context',
        capabilityKey: 'read',
        approvalMode: 'allow',
      },
    ]);
    expect(mockRecordToolApproval).toHaveBeenCalledWith(toolApproval, {
      toolKey: REQUEST_WORKSPACE_TOOL_KEY,
      mode: 'allow',
    });
    expect(toolApproval).toEqual({});
  });

  it.each([
    ['policy requires approval', 'require_approval', true],
    ['automatic provisioning is disabled', 'allow', false],
  ])('records user approval when %s', (_name, resolvedMode, autoProvisionWorkspace) => {
    const gatewayModule = loadModule();
    mockResolveToolApprovalMode.mockReturnValue(resolvedMode);

    const { tools, toolMetadata, toolApproval } = registerWorkspaceTool(gatewayModule, {
      autoProvisionWorkspace,
    });

    expect(tools[REQUEST_WORKSPACE_TOOL_KEY]).toBeDefined();
    expect(toolMetadata).toEqual([expect.objectContaining({ approvalMode: 'require_approval' })]);
    expect(mockRecordToolApproval).toHaveBeenCalledWith(toolApproval, {
      toolKey: REQUEST_WORKSPACE_TOOL_KEY,
      mode: 'require_approval',
    });
    expect(toolApproval).toEqual({ [REQUEST_WORKSPACE_TOOL_KEY]: 'user-approval' });
  });
});

describe('request_workspace execution', () => {
  beforeEach(() => {
    resetModuleMocks();
  });

  it('returns a verified ready runtime and audits using the supplied runtime tool context', async () => {
    const gatewayModule = loadModule();
    const initialSession = buildSession({ workspaceStatus: 'none', podName: null, namespace: null });
    const readySession = buildSession();
    const onToolStarted = jest.fn().mockResolvedValue(undefined);
    const onToolFinished = jest.fn().mockResolvedValue(undefined);
    const getActiveRunUuid = jest.fn(() => 'run-current');
    mockLoadLatestSession.mockResolvedValue(initialSession);
    mockEnsureChatSandbox.mockResolvedValue({ session: readySession });

    const { tools } = registerWorkspaceTool(gatewayModule, {
      session: initialSession,
      requestGitHubToken: 'github-token',
      hooks: { onToolStarted, onToolFinished, getActiveRunUuid },
    });
    const tool = tools[REQUEST_WORKSPACE_TOOL_KEY];
    const runtimeContext = {
      toolKey: REQUEST_WORKSPACE_TOOL_KEY,
      serverSlug: 'runtime-lifecycle',
      sourceToolName: 'runtime-request-workspace',
      capabilityKey: 'workspace_write',
    };

    await expect(
      tool.execute(
        { reason: '  edit files  ', timeout_ms: 1500 },
        { toolCallId: 'tool-call-1', context: runtimeContext }
      )
    ).resolves.toEqual({
      status: 'ready',
      workspaceStatus: 'ready',
      workspace_status: 'ready',
      message: 'Workspace is ready. Use workspace_core tools for commands, files, git, and previews.',
      reason: 'edit files',
    });

    const expectedAudit = {
      source: 'mcp',
      serverSlug: 'runtime-lifecycle',
      toolName: 'runtime-request-workspace',
      toolCallId: 'tool-call-1',
      args: { reason: '  edit files  ', timeout_ms: 1500 },
      capabilityKey: 'workspace_write',
    };
    expect(onToolStarted).toHaveBeenCalledWith(expectedAudit);
    expect(mockLoadLatestSession).toHaveBeenCalledWith('session-1');
    expect(mockEnsureChatSandbox).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'sample-user',
      userIdentity: USER_IDENTITY,
      githubToken: 'github-token',
      allowedActiveRunUuid: 'run-current',
    });
    expect(mockConnect).toHaveBeenCalledWith({ type: 'http', url: 'http://gateway:8080/mcp' }, 5000);
    expect(onToolFinished).toHaveBeenCalledWith({
      ...expectedAudit,
      result: {
        status: 'ready',
        workspaceStatus: 'ready',
        workspace_status: 'ready',
        message: 'Workspace is ready. Use workspace_core tools for commands, files, git, and previews.',
        reason: 'edit files',
      },
      status: 'completed',
    });
  });

  it('returns an immediate failed result and audits with registration metadata by default', async () => {
    const gatewayModule = loadModule();
    const failedSession = buildSession({ workspaceStatus: 'failed', podName: null, namespace: null });
    const onToolStarted = jest.fn().mockResolvedValue(undefined);
    const onToolFinished = jest.fn().mockResolvedValue(undefined);
    mockLoadLatestSession.mockResolvedValue(failedSession);
    mockEnsureChatSandbox.mockResolvedValue({ session: failedSession });

    const { tools } = registerWorkspaceTool(gatewayModule, {
      hooks: { onToolStarted, onToolFinished },
    });
    const tool = tools[REQUEST_WORKSPACE_TOOL_KEY];

    await expect(tool.execute({ timeout_ms: 1800000 })).resolves.toEqual({
      status: 'failed',
      workspaceStatus: 'failed',
      workspace_status: 'failed',
      message: 'Workspace failed to become ready.',
      reason: null,
    });

    const expectedAudit = {
      source: 'mcp',
      serverSlug: 'lifecycle',
      toolName: 'request_workspace',
      toolCallId: undefined,
      args: { timeout_ms: 1800000 },
      capabilityKey: 'read',
    };
    expect(mockResolveAgentRuntimeToolContext).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ toolKey: REQUEST_WORKSPACE_TOOL_KEY, approvalMode: 'allow' })
    );
    expect(onToolStarted).toHaveBeenCalledWith(expectedAudit);
    expect(onToolFinished).toHaveBeenCalledWith({
      ...expectedAudit,
      result: expect.objectContaining({ status: 'failed', workspace_status: 'failed', reason: null }),
      status: 'failed',
    });
    expect(mockEnsureChatSandbox).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'sample-user',
      userIdentity: USER_IDENTITY,
      githubToken: undefined,
    });
    expect(mockResolveWorkspaceGatewayEndpoint).not.toHaveBeenCalled();
  });

  it('returns a non-waitable provisioning error without polling or probing the gateway', async () => {
    const gatewayModule = loadModule();
    mockLoadLatestSession.mockResolvedValue(buildSession({ workspaceStatus: 'none' }));
    mockEnsureChatSandbox.mockRejectedValueOnce(new Error('workspace quota exceeded'));
    const { tools } = registerWorkspaceTool(gatewayModule);

    await expect(tools[REQUEST_WORKSPACE_TOOL_KEY].execute({ reason: 'run commands' })).resolves.toEqual({
      status: 'failed',
      workspaceStatus: 'failed',
      workspace_status: 'failed',
      message: 'workspace quota exceeded',
      reason: 'run commands',
    });
    expect(mockLoadLatestSession).toHaveBeenCalledTimes(1);
    expect(mockResolveWorkspaceGatewayEndpoint).not.toHaveBeenCalled();
    expect(mockReconcileLostChatWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it('normalizes a non-Error provisioning rejection into the failed tool result', async () => {
    const gatewayModule = loadModule();
    mockLoadLatestSession.mockResolvedValue(buildSession({ workspaceStatus: 'none' }));
    mockEnsureChatSandbox.mockRejectedValueOnce('workspace backend unavailable');
    const { tools } = registerWorkspaceTool(gatewayModule);

    await expect(tools[REQUEST_WORKSPACE_TOOL_KEY].execute({})).resolves.toEqual({
      status: 'failed',
      workspaceStatus: 'failed',
      workspace_status: 'failed',
      message: 'workspace backend unavailable',
      reason: null,
    });
    expect(mockLoadLatestSession).toHaveBeenCalledTimes(1);
    expect(mockResolveWorkspaceGatewayEndpoint).not.toHaveBeenCalled();
  });

  it('propagates an audit-start failure before provisioning any workspace', async () => {
    const gatewayModule = loadModule();
    const onToolStarted = jest.fn().mockRejectedValueOnce(new Error('audit unavailable'));
    const onToolFinished = jest.fn();
    const { tools } = registerWorkspaceTool(gatewayModule, {
      hooks: { onToolStarted, onToolFinished },
    });

    await expect(tools[REQUEST_WORKSPACE_TOOL_KEY].execute({ reason: 'edit files' })).rejects.toThrow(
      'audit unavailable'
    );
    expect(mockLoadLatestSession).not.toHaveBeenCalled();
    expect(mockEnsureChatSandbox).not.toHaveBeenCalled();
    expect(onToolFinished).not.toHaveBeenCalled();
  });

  it.each([
    ['already-provisioning message', new Error('workspace already provisioning')],
    ['action-finish message', new Error('waiting for workspace action to finish')],
    ['action-in-progress reason', Object.assign(new Error('workspace conflict'), { reason: 'action_in_progress' })],
  ])('waits after a recognized %s and returns the subsequently ready runtime', async (_name, waitableError) => {
    const gatewayModule = loadModule();
    const provisioningSession = buildSession({ workspaceStatus: 'provisioning', podName: null, namespace: null });
    const readySession = buildSession();
    mockLoadLatestSession.mockResolvedValueOnce(provisioningSession).mockResolvedValueOnce(readySession);
    mockEnsureChatSandbox.mockRejectedValueOnce(waitableError);
    const { tools } = registerWorkspaceTool(gatewayModule, { session: provisioningSession });

    await expect(
      tools[REQUEST_WORKSPACE_TOOL_KEY].execute({ reason: 'edit files', timeout_ms: 1000 })
    ).resolves.toMatchObject({
      status: 'ready',
      workspaceStatus: 'ready',
      workspace_status: 'ready',
      reason: 'edit files',
    });
    expect(mockLoadLatestSession).toHaveBeenCalledTimes(2);
    expect(mockEnsureChatSandbox).toHaveBeenCalledTimes(1);
    expect(mockResolveWorkspaceGatewayEndpoint).toHaveBeenCalledWith('session-1');
  });

  it('polls a provisioning workspace until its gateway becomes live', async () => {
    jest.useFakeTimers();
    try {
      const gatewayModule = loadModule();
      const provisioningSession = buildSession({ workspaceStatus: 'provisioning', podName: null, namespace: null });
      const readySession = buildSession();
      mockLoadLatestSession
        .mockResolvedValueOnce(provisioningSession)
        .mockResolvedValueOnce(provisioningSession)
        .mockResolvedValueOnce(readySession);
      mockEnsureChatSandbox.mockResolvedValue({ session: provisioningSession });
      const { tools } = registerWorkspaceTool(gatewayModule, { session: provisioningSession });

      const resultPromise = tools[REQUEST_WORKSPACE_TOOL_KEY].execute({ timeout_ms: 2000 });
      await jest.advanceTimersByTimeAsync(1000);

      await expect(resultPromise).resolves.toMatchObject({
        status: 'ready',
        workspaceStatus: 'ready',
        workspace_status: 'ready',
      });
      expect(mockLoadLatestSession).toHaveBeenCalledTimes(3);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reconciles a falsely ready runtime and succeeds on the second ensure attempt', async () => {
    const gatewayModule = loadModule();
    const readySession = buildSession();
    mockLoadLatestSession.mockResolvedValue(readySession);
    mockEnsureChatSandbox.mockResolvedValue({ session: readySession });
    mockListTools.mockRejectedValueOnce(new Error('gateway unavailable')).mockResolvedValue(DISCOVERED_TOOLS);
    mockReconcileLostChatWorkspaceRuntime.mockResolvedValue({
      ...readySession,
      workspaceStatus: 'failed',
    });
    const getActiveRunUuid = jest.fn(() => 'run-current');
    const { tools } = registerWorkspaceTool(gatewayModule, {
      hooks: { getActiveRunUuid },
    });

    await expect(tools[REQUEST_WORKSPACE_TOOL_KEY].execute({ reason: 'run tests' })).resolves.toMatchObject({
      status: 'ready',
      workspaceStatus: 'ready',
      workspace_status: 'ready',
    });
    expect(mockReconcileLostChatWorkspaceRuntime).toHaveBeenCalledWith('session-1', {
      allowedActiveRunUuid: 'run-current',
    });
    expect(mockEnsureChatSandbox).toHaveBeenCalledTimes(2);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockClose).toHaveBeenCalledTimes(2);
  });

  it('reports failure when a falsely ready runtime cannot be reconciled', async () => {
    const gatewayModule = loadModule();
    const readySession = buildSession();
    mockLoadLatestSession.mockResolvedValue(readySession);
    mockEnsureChatSandbox.mockResolvedValue({ session: readySession });
    mockListTools.mockRejectedValueOnce(new Error('gateway unavailable'));
    mockReconcileLostChatWorkspaceRuntime.mockResolvedValue(null);
    const { tools } = registerWorkspaceTool(gatewayModule);

    await expect(tools[REQUEST_WORKSPACE_TOOL_KEY].execute({})).resolves.toEqual({
      status: 'failed',
      workspaceStatus: 'ready',
      workspace_status: 'ready',
      message: 'Workspace is marked ready but its runtime is unreachable. Request the workspace again to re-provision.',
      reason: null,
    });
    expect(mockEnsureChatSandbox).toHaveBeenCalledTimes(1);
    expect(mockReconcileLostChatWorkspaceRuntime).toHaveBeenCalledWith('session-1', {
      allowedActiveRunUuid: null,
    });
  });

  it('reports the settled failure when the reconciled retry is also unreachable', async () => {
    const gatewayModule = loadModule();
    const readySession = buildSession();
    const settledProvisioning = buildSession({ workspaceStatus: 'provisioning' });
    const settledFailure = buildSession({ workspaceStatus: 'failed' });
    mockLoadLatestSession.mockResolvedValue(readySession);
    mockEnsureChatSandbox.mockResolvedValue({ session: readySession });
    mockListTools.mockRejectedValue(new Error('gateway unavailable'));
    mockReconcileLostChatWorkspaceRuntime
      .mockResolvedValueOnce(settledProvisioning)
      .mockResolvedValueOnce(settledFailure);
    const { tools } = registerWorkspaceTool(gatewayModule);

    await expect(tools[REQUEST_WORKSPACE_TOOL_KEY].execute({})).resolves.toEqual({
      status: 'failed',
      workspaceStatus: 'failed',
      workspace_status: 'failed',
      message: 'Workspace is marked ready but its runtime is unreachable. Request the workspace again to re-provision.',
      reason: null,
    });
    expect(mockEnsureChatSandbox).toHaveBeenCalledTimes(2);
    expect(mockReconcileLostChatWorkspaceRuntime).toHaveBeenNthCalledWith(2, 'session-1', {
      allowedActiveRunUuid: null,
    });
  });

  it('stops polling when the latest session is archived', async () => {
    const gatewayModule = loadModule();
    const provisioningSession = buildSession({ workspaceStatus: 'provisioning', podName: null, namespace: null });
    const archivedSession = buildSession({
      status: 'archived',
      workspaceStatus: 'provisioning',
      podName: null,
      namespace: null,
    });
    mockLoadLatestSession.mockResolvedValueOnce(provisioningSession).mockResolvedValueOnce(archivedSession);
    mockEnsureChatSandbox.mockResolvedValue({ session: provisioningSession });
    const { tools } = registerWorkspaceTool(gatewayModule, { session: provisioningSession });

    await expect(tools[REQUEST_WORKSPACE_TOOL_KEY].execute({ timeout_ms: 1000 })).resolves.toMatchObject({
      status: 'failed',
      workspaceStatus: 'provisioning',
      workspace_status: 'provisioning',
      message: 'Workspace failed to become ready.',
    });
    expect(mockResolveWorkspaceGatewayEndpoint).not.toHaveBeenCalled();
  });

  it('uses the default timeout and returns a neutral timeout message without a prior error', async () => {
    const gatewayModule = loadModule();
    const provisioningSession = buildSession({ workspaceStatus: 'provisioning', podName: null, namespace: null });
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(600000);
    mockLoadLatestSession.mockResolvedValue(provisioningSession);
    mockEnsureChatSandbox.mockResolvedValue({ session: provisioningSession });
    const { tools } = registerWorkspaceTool(gatewayModule, { session: provisioningSession });

    await expect(tools[REQUEST_WORKSPACE_TOOL_KEY].execute({ reason: '   ' })).resolves.toEqual({
      status: 'timed_out',
      workspaceStatus: 'provisioning',
      workspace_status: 'provisioning',
      message: 'Workspace did not become ready before timeout.',
      reason: null,
    });
    expect(mockLoadLatestSession).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('includes the last waitable error when the requested timeout elapses', async () => {
    const gatewayModule = loadModule();
    const provisioningSession = buildSession({ workspaceStatus: 'provisioning', podName: null, namespace: null });
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(1000);
    mockLoadLatestSession.mockResolvedValue(provisioningSession);
    mockEnsureChatSandbox.mockRejectedValueOnce(new Error('workspace already provisioning'));
    const { tools } = registerWorkspaceTool(gatewayModule, { session: provisioningSession });

    await expect(tools[REQUEST_WORKSPACE_TOOL_KEY].execute({ timeout_ms: 1000 })).resolves.toMatchObject({
      status: 'timed_out',
      workspaceStatus: 'provisioning',
      workspace_status: 'provisioning',
      message: 'Workspace did not become ready before timeout. Last status: workspace already provisioning',
    });
    nowSpy.mockRestore();
  });
});
