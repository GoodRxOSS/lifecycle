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
  },
}));

jest.mock('server/services/workspaceRuntime/gatewayContract', () => ({
  findMissingWorkspaceGatewayTools: jest.fn(() => []),
  buildWorkspaceGatewayContractFailureMessage: jest.fn(() => 'missing tools'),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

type GatewayModule = typeof import('../chatWorkspaceToolRegistration');

const DISCOVERED_TOOLS = [{ name: 'workspace.exec', description: 'exec', inputSchema: {} }];
const TIMEOUTS = { discoveryTimeoutMs: 3000, executionTimeoutMs: 30000 };

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

describe('resolveSessionWorkspaceGatewayServer discovery cache', () => {
  beforeEach(() => {
    // Fresh module per test so the module-level discovery cache starts empty.
    jest.resetModules();
    jest.clearAllMocks();
    mockResolveWorkspaceGatewayEndpoint.mockResolvedValue({ url: 'http://gateway:8080' });
    mockListTools.mockResolvedValue(DISCOVERED_TOOLS);
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
});
