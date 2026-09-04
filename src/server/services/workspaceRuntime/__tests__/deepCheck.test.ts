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

const mockGetWorkspaceBackendDescriptor = jest.fn();
const mockListWorkspaceBackendDescriptors = jest.fn();
const mockResolveAgentSessionRuntimeConfig = jest.fn();
const mockResolveAgentSessionControlPlaneConfig = jest.fn();
const mockResolveAgentSessionWorkspaceBackendConfig = jest.fn();
const mockRecordBackendVerification = jest.fn();
const mockMcpConnect = jest.fn();
const mockMcpListTools = jest.fn();
const mockMcpClose = jest.fn();
const mockProvision = jest.fn();
const mockDestroy = jest.fn();
const mockResolveGatewayEndpoint = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('../registry', () => ({
  getWorkspaceBackendDescriptor: (...args: unknown[]) => mockGetWorkspaceBackendDescriptor(...args),
  listWorkspaceBackendDescriptors: (...args: unknown[]) => mockListWorkspaceBackendDescriptors(...args),
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  resolveAgentSessionRuntimeConfig: (...args: unknown[]) => mockResolveAgentSessionRuntimeConfig(...args),
  resolveAgentSessionControlPlaneConfig: (...args: unknown[]) => mockResolveAgentSessionControlPlaneConfig(...args),
  resolveAgentSessionWorkspaceBackendConfig: (...args: unknown[]) =>
    mockResolveAgentSessionWorkspaceBackendConfig(...args),
}));

jest.mock('../verificationState', () => ({
  recordBackendVerification: (...args: unknown[]) => mockRecordBackendVerification(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: (...args: unknown[]) => mockLoggerWarn(...args) }),
}));

jest.mock('server/services/agentRuntime/mcp/client', () => ({
  McpClientManager: jest.fn(() => ({
    connect: (...args: unknown[]) => mockMcpConnect(...args),
    listTools: (...args: unknown[]) => mockMcpListTools(...args),
    close: (...args: unknown[]) => mockMcpClose(...args),
  })),
}));

import { runWorkspaceBackendDeepCheck } from '../deepCheck';
import { REQUIRED_WORKSPACE_GATEWAY_TOOLS } from '../gatewayContract';
import type {
  AgentSessionRuntimeConfig,
  ResolvedAgentSessionWorkspaceBackendConfig,
} from 'server/lib/agentSession/runtimeConfig';

const workspaceBackendConfig: ResolvedAgentSessionWorkspaceBackendConfig = {
  provider: 'opensandbox',
  opensandbox: {
    domain: 'sandbox.example.test',
    protocol: 'https',
    apiKey: 'opensandbox-secret',
    image: 'lifecycle/workspace:test',
    timeoutSeconds: 3600,
    useServerProxy: false,
    secureAccess: true,
    resourceLimits: {},
    execdPort: 44772,
    gatewayPort: 14001,
    editorPort: 14002,
  },
  e2b: {
    domain: 'e2b.example.test',
    apiKey: 'e2b-secret',
    templateId: 'template-1',
    timeoutSeconds: 3600,
    autoPause: true,
    gatewayPort: 14003,
    editorPort: 14004,
  },
  daytona: {
    apiUrl: 'https://daytona.example.test/api',
    apiKey: 'daytona-secret',
    snapshot: 'snapshot-1',
    autoArchiveInterval: 0,
    gatewayPort: 14005,
    editorPort: 14006,
  },
  modal: {
    tokenId: 'modal-id',
    tokenSecret: 'modal-secret',
    appName: 'lifecycle-workspaces',
    image: 'lifecycle/workspace:test',
    timeoutSeconds: 3600,
    gatewayPort: 14007,
  },
};

const runtimeConfig: AgentSessionRuntimeConfig = {
  workspaceImage: 'lifecycle/workspace:test',
  workspaceEditorImage: 'lifecycle/editor:test',
  workspaceGatewayImage: 'lifecycle/gateway:test',
  workspaceBackend: workspaceBackendConfig,
  keepAttachedServicesOnSessionNode: true,
  readiness: { timeoutMs: 60_000, pollMs: 1_000 },
  resources: {
    workspace: { requests: {}, limits: {} },
    editor: { requests: {}, limits: {} },
    workspaceGateway: { requests: {}, limits: {} },
  },
  workspaceStorage: {
    defaultSize: '10Gi',
    allowedSizes: ['10Gi'],
    allowClientOverride: true,
    accessMode: 'ReadWriteOnce',
  },
  cleanup: {
    activeIdleSuspendMs: 1_800_000,
    startingTimeoutMs: 900_000,
    hibernatedRetentionMs: 86_400_000,
    idleArchiveMs: 2_592_000_000,
    intervalMs: 300_000,
    redisTtlSeconds: 7_200,
  },
  durability: {
    runExecutionLeaseMs: 1_800_000,
    queuedRunDispatchStaleMs: 30_000,
    dispatchRecoveryLimit: 50,
    maxDurablePayloadBytes: 65_536,
    payloadPreviewBytes: 16_384,
    fileChangePreviewChars: 4_000,
  },
};

function installDescriptor(
  overrides: {
    id?: string;
    displayName?: string;
    status?: string;
    secretFields?: string[];
    supportsTestSandbox?: boolean;
    backendId?: string;
  } = {}
) {
  const id = overrides.id ?? 'fake';
  const provider = {
    backendId: overrides.backendId ?? id,
    provision: (...args: unknown[]) => mockProvision(...args),
    destroy: (...args: unknown[]) => mockDestroy(...args),
    resolveGatewayEndpoint: (...args: unknown[]) => mockResolveGatewayEndpoint(...args),
  };
  const createProvider = jest.fn(() => provider);
  const descriptor = {
    id,
    displayName: overrides.displayName ?? 'Fake',
    status: overrides.status ?? 'available',
    secretFields: overrides.secretFields ?? [],
    ...(overrides.supportsTestSandbox === false ? {} : { createProvider }),
  };
  mockGetWorkspaceBackendDescriptor.mockReturnValue(descriptor);
  mockListWorkspaceBackendDescriptors.mockReturnValue([descriptor]);
  return { descriptor, provider, createProvider };
}

describe('runWorkspaceBackendDeepCheck', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    installDescriptor();
    mockResolveAgentSessionRuntimeConfig.mockResolvedValue(runtimeConfig);
    mockResolveAgentSessionControlPlaneConfig.mockResolvedValue({
      workspaceToolDiscoveryTimeoutMs: 250,
    });
    mockResolveAgentSessionWorkspaceBackendConfig.mockResolvedValue(workspaceBackendConfig);
    mockProvision.mockResolvedValue({
      providerState: { sandboxId: 'sandbox-1' },
      capabilitySnapshot: { editorAccess: true },
    });
    mockDestroy.mockResolvedValue(undefined);
    mockResolveGatewayEndpoint.mockReturnValue({
      url: 'https://gateway.example.test/base/',
      headers: { 'x-provider-token': 'provider-token' },
    });
    mockMcpConnect.mockResolvedValue(undefined);
    mockMcpClose.mockResolvedValue(undefined);
    mockRecordBackendVerification.mockResolvedValue(undefined);
    (global as typeof globalThis & { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    const dateNow = Date.now as typeof Date.now & { mockRestore?: () => void };
    dateNow.mockRestore?.();
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  it('rejects an unknown backend before resolving configuration', async () => {
    mockGetWorkspaceBackendDescriptor.mockReturnValue(undefined);

    await expect(runWorkspaceBackendDeepCheck('unknown')).rejects.toMatchObject({
      name: 'NotFoundError',
      httpStatus: 404,
      code: 'workspace_backend_not_found',
      message: 'Unknown workspace backend: unknown',
    });
    expect(mockResolveAgentSessionWorkspaceBackendConfig).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });

  it('rejects a backend that is not yet available before resolving configuration', async () => {
    installDescriptor({ id: 'substrate', displayName: 'Substrate', status: 'coming_soon' });

    await expect(runWorkspaceBackendDeepCheck('substrate')).rejects.toMatchObject({
      name: 'BadRequestError',
      httpStatus: 400,
      message: 'The Substrate workspace backend is not available yet.',
    });
    expect(mockResolveAgentSessionWorkspaceBackendConfig).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });

  it('rejects an available backend that cannot create test sandboxes', async () => {
    installDescriptor({ id: 'native', displayName: 'Native', supportsTestSandbox: false });

    await expect(runWorkspaceBackendDeepCheck('native')).rejects.toMatchObject({
      name: 'BadRequestError',
      httpStatus: 400,
      message: 'The Native workspace backend does not support test sandboxes.',
    });
    expect(mockResolveAgentSessionWorkspaceBackendConfig).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });

  it('rejects an unsafe configured probe target before constructing a provider', async () => {
    const { createProvider } = installDescriptor({ id: 'daytona', backendId: 'daytona' });
    mockResolveAgentSessionWorkspaceBackendConfig.mockResolvedValue({
      ...workspaceBackendConfig,
      daytona: { ...workspaceBackendConfig.daytona, apiUrl: 'http://169.254.169.254/latest' },
    });

    await expect(runWorkspaceBackendDeepCheck('daytona')).rejects.toMatchObject({
      name: 'BadRequestError',
      message: expect.stringContaining('link-local/metadata address'),
    });
    expect(createProvider).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).not.toHaveBeenCalled();
  });

  it.each([
    ['opensandbox', 14001],
    ['e2b', 14003],
    ['daytona', 14005],
    ['modal', 14007],
  ])('completes a successful %s check using its configured gateway port', async (backendId, gatewayPort) => {
    const { createProvider } = installDescriptor({ id: backendId, backendId });
    const endpointHeaders = backendId === 'modal' ? undefined : { 'x-provider-token': 'provider-token' };
    mockResolveGatewayEndpoint.mockReturnValue({
      url: 'https://gateway.example.test/base/',
      headers: endpointHeaders,
    });
    mockMcpListTools.mockResolvedValue(REQUIRED_WORKSPACE_GATEWAY_TOOLS.map((name) => ({ name })));
    jest.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_500).mockReturnValue(3_000);

    const result = await runWorkspaceBackendDeepCheck(backendId);

    expect(createProvider).toHaveBeenCalledWith(workspaceBackendConfig);
    const provisionContext = mockProvision.mock.calls[0][0];
    expect(provisionContext).toMatchObject({
      plan: {
        version: 1,
        kind: 'chat',
        sessionUuid: expect.stringMatching(/^deepcheck-/),
        forwardedEnv: { env: {}, secretRefs: [] },
        credentials: { hasGitHubToken: false, githubToken: null },
        servicePlan: { workspaceRepos: [] },
        skillPlan: { version: 1, skills: [] },
      },
      readiness: runtimeConfig.readiness,
      gatewayToken: expect.any(String),
    });
    const gatewayToken = provisionContext.gatewayToken;
    expect(mockMcpConnect).toHaveBeenCalledWith(
      {
        type: 'http',
        url: 'https://gateway.example.test/base/mcp',
        headers: {
          ...(endpointHeaders || {}),
          Authorization: `Bearer ${gatewayToken}`,
          'x-lifecycle-gateway-token': gatewayToken,
        },
      },
      250
    );
    expect(mockMcpListTools).toHaveBeenCalledWith(250);
    expect(mockMcpClose).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(`https://gateway.example.test/base/preview/${gatewayPort}/health`, {
      method: 'GET',
      headers: {
        ...(endpointHeaders || {}),
        Authorization: `Bearer ${gatewayToken}`,
        'x-lifecycle-gateway-token': gatewayToken,
      },
      signal: expect.any(AbortSignal),
    });
    expect(mockDestroy).toHaveBeenCalledWith({ sandboxId: 'sandbox-1' });
    expect(result).toEqual({
      ok: true,
      message: 'Booted a test sandbox in 1.5s.',
      durationMs: 2_000,
      stages: [
        { name: 'Provision & gateway', status: 'passed', detail: 'Ready in 1.5s' },
        {
          name: 'Gateway tools',
          status: 'passed',
          detail: `${REQUIRED_WORKSPACE_GATEWAY_TOOLS.length} MCP tools discovered.`,
        },
        {
          name: 'Gateway preview proxy',
          status: 'passed',
          detail: 'Authenticated /preview/:port route can proxy to the workspace gateway.',
        },
        { name: 'Editor', status: 'passed' },
        { name: 'Teardown', status: 'passed' },
      ],
    });
    expect(mockRecordBackendVerification).toHaveBeenCalledWith(backendId, { ok: true, kind: 'deep' });
  });

  it.each([
    ['create', new Error('Create failed: missing sandbox id'), 'Create sandbox', 'Create failed: missing sandbox id'],
    [
      'gateway authentication',
      new Error('Gateway image is outdated and not enforcing authentication'),
      'Gateway auth',
      'Gateway image is outdated and not enforcing authentication',
    ],
    [
      'gateway readiness',
      new Error('Gateway did not become ready before timeout'),
      'Gateway ready',
      'Gateway did not become ready before timeout',
    ],
    ['generic non-Error', 'Provision opensandbox-secret exploded', 'Provision', 'Provision [redacted] exploded'],
  ])('classifies a %s provisioning failure', async (_label, rejection, expectedStage, expectedMessage) => {
    installDescriptor({ id: 'opensandbox', backendId: 'opensandbox', secretFields: ['apiKey'] });
    mockProvision.mockRejectedValue(rejection);
    jest.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(1_750);

    const result = await runWorkspaceBackendDeepCheck('opensandbox');

    expect(result).toEqual({
      ok: false,
      message: expectedMessage,
      durationMs: 750,
      stages: [{ name: expectedStage, status: 'failed', detail: expectedMessage }],
    });
    expect(mockMcpConnect).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockRecordBackendVerification).toHaveBeenCalledWith('opensandbox', { ok: false, kind: 'deep' });
  });

  it('fails the tools stage without opening an MCP client when no gateway endpoint is available', async () => {
    mockResolveGatewayEndpoint.mockReturnValue(null);

    const result = await runWorkspaceBackendDeepCheck('fake');

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Workspace gateway endpoint could not be resolved after provisioning.');
    expect(result.stages).toEqual(
      expect.arrayContaining([
        {
          name: 'Gateway tools',
          status: 'failed',
          detail: 'Workspace gateway endpoint could not be resolved after provisioning.',
        },
        {
          name: 'Gateway preview proxy',
          status: 'skipped',
          detail: 'Gateway tools check failed.',
        },
      ])
    );
    expect(mockMcpConnect).not.toHaveBeenCalled();
    expect(mockMcpListTools).not.toHaveBeenCalled();
    expect(mockMcpClose).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalledWith({ sandboxId: 'sandbox-1' });
  });

  it('fails the preview stage without fetching when its second endpoint resolution fails', async () => {
    mockMcpListTools.mockResolvedValue(REQUIRED_WORKSPACE_GATEWAY_TOOLS.map((name) => ({ name })));
    mockResolveGatewayEndpoint
      .mockReturnValueOnce({ url: 'https://gateway.example.test/base', headers: undefined })
      .mockReturnValueOnce(null);
    mockProvision.mockResolvedValue({
      providerState: { sandboxId: 'sandbox-1' },
      capabilitySnapshot: { editorAccess: false },
    });

    const result = await runWorkspaceBackendDeepCheck('fake');

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Workspace gateway endpoint could not be resolved after provisioning.');
    expect(mockMcpConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://gateway.example.test/base/mcp',
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer /),
          'x-lifecycle-gateway-token': expect.any(String),
        }),
      }),
      250
    );
    expect(result.stages).toEqual(
      expect.arrayContaining([
        {
          name: 'Gateway preview proxy',
          status: 'failed',
          detail: 'Workspace gateway endpoint could not be resolved after provisioning.',
        },
        {
          name: 'Editor',
          status: 'skipped',
          detail: 'No editor (image may not bundle code-server)',
        },
      ])
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalledWith({ sandboxId: 'sandbox-1' });
  });

  it.each([
    ['Error', new Error('MCP connection exposed opensandbox-secret'), 'MCP connection exposed [redacted]'],
    ['non-Error', 'MCP connection exposed opensandbox-secret', 'MCP connection exposed [redacted]'],
  ])('reports and scrubs an MCP client %s rejection', async (_label, rejection, expectedDetail) => {
    installDescriptor({ id: 'opensandbox', backendId: 'opensandbox', secretFields: ['apiKey'] });
    mockMcpConnect.mockRejectedValue(rejection);

    const result = await runWorkspaceBackendDeepCheck('opensandbox');

    expect(result.ok).toBe(false);
    expect(result.message).toBe(expectedDetail);
    expect(result.stages).toEqual(
      expect.arrayContaining([
        { name: 'Gateway tools', status: 'failed', detail: expectedDetail },
        { name: 'Gateway preview proxy', status: 'skipped', detail: 'Gateway tools check failed.' },
      ])
    );
    expect(mockMcpListTools).not.toHaveBeenCalled();
    expect(mockMcpClose).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalledWith({ sandboxId: 'sandbox-1' });
  });

  it('fails the gateway tools stage and skips preview probing when required tools are missing', async () => {
    mockMcpListTools.mockResolvedValue(
      REQUIRED_WORKSPACE_GATEWAY_TOOLS.filter((name) => name !== 'workspace.apply_patch').map((name) => ({ name }))
    );

    const result = await runWorkspaceBackendDeepCheck('fake');

    expect(result.ok).toBe(false);
    expect(result.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Provision & gateway', status: 'passed' }),
        expect.objectContaining({
          name: 'Gateway tools',
          status: 'failed',
          detail: expect.stringContaining('workspace.apply_patch'),
        }),
        expect.objectContaining({
          name: 'Gateway preview proxy',
          status: 'skipped',
          detail: 'Gateway tools check failed.',
        }),
      ])
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalledWith({ sandboxId: 'sandbox-1' });
    expect(mockRecordBackendVerification).toHaveBeenCalledWith('fake', { ok: false, kind: 'deep' });
  });

  it('fails the preview proxy stage when authenticated /preview/:port/health does not return the contract status', async () => {
    mockMcpListTools.mockResolvedValue(REQUIRED_WORKSPACE_GATEWAY_TOOLS.map((name) => ({ name })));
    (global as typeof globalThis & { fetch: jest.Mock }).fetch.mockResolvedValueOnce({ status: 404 });
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    try {
      const result = await runWorkspaceBackendDeepCheck('fake');

      expect(result.ok).toBe(false);
      expect(result.stages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Gateway tools', status: 'passed' }),
          expect.objectContaining({
            name: 'Gateway preview proxy',
            status: 'failed',
            detail: expect.stringContaining('Received HTTP 404'),
          }),
        ])
      );
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15000);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://gateway.example.test/base/preview/13338/health',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'x-provider-token': 'provider-token',
            'x-lifecycle-gateway-token': expect.any(String),
          }),
        })
      );
      expect(mockRecordBackendVerification).toHaveBeenCalledWith('fake', { ok: false, kind: 'deep' });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each([
    ['regular Error', new Error('proxy failed with opensandbox-secret')],
    ['non-Error', 'proxy failed with opensandbox-secret'],
  ])('scrubs preview proxy failures represented by %s', async (_label, rejection) => {
    installDescriptor({ id: 'opensandbox', backendId: 'opensandbox', secretFields: ['apiKey'] });
    mockMcpListTools.mockResolvedValue(REQUIRED_WORKSPACE_GATEWAY_TOOLS.map((name) => ({ name })));
    (global as typeof globalThis & { fetch: jest.Mock }).fetch.mockRejectedValue(rejection);

    const result = await runWorkspaceBackendDeepCheck('opensandbox');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Missing required HTTP route: /preview/:port/*.');
    expect(result.message).toContain('proxy failed with [redacted]');
    expect(result.message).not.toContain('opensandbox-secret');
    expect(result.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Gateway preview proxy',
          status: 'failed',
          detail: expect.stringContaining('proxy failed with [redacted]'),
        }),
        { name: 'Teardown', status: 'passed' },
      ])
    );
    expect(mockDestroy).toHaveBeenCalledWith({ sandboxId: 'sandbox-1' });
    expect(mockRecordBackendVerification).toHaveBeenCalledWith('opensandbox', { ok: false, kind: 'deep' });
  });

  it('aborts a preview proxy request after the minimum deep-check deadline', async () => {
    jest.useFakeTimers();
    mockMcpListTools.mockResolvedValue(REQUIRED_WORKSPACE_GATEWAY_TOOLS.map((name) => ({ name })));
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    (global as typeof globalThis & { fetch: jest.Mock }).fetch.mockImplementation(
      (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          markFetchStarted();
        })
    );

    const resultPromise = runWorkspaceBackendDeepCheck('fake');
    await fetchStarted;
    jest.advanceTimersByTime(15_000);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Gateway preview proxy',
          status: 'failed',
          detail: expect.stringContaining('AbortError'),
        }),
      ])
    );
    expect(mockDestroy).toHaveBeenCalledWith({ sandboxId: 'sandbox-1' });
  });

  it.each([
    ['regular Error rejection', new Error('destroy exposed opensandbox-secret'), 'destroy exposed [redacted]'],
    ['non-Error rejection', 'destroy exposed opensandbox-secret', 'destroy exposed [redacted]'],
  ])('keeps the result successful after a teardown %s', async (_label, rejection, expectedDetail) => {
    installDescriptor({ id: 'opensandbox', backendId: 'opensandbox', secretFields: ['apiKey'] });
    mockMcpListTools.mockResolvedValue(REQUIRED_WORKSPACE_GATEWAY_TOOLS.map((name) => ({ name })));
    mockDestroy.mockRejectedValue(rejection);

    const result = await runWorkspaceBackendDeepCheck('opensandbox');

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Booted a test sandbox in /);
    expect(result.stages).toEqual(
      expect.arrayContaining([{ name: 'Teardown', status: 'failed', detail: expectedDetail }])
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith({ error: rejection }, 'Workspace deep check: teardown failed');
    expect(mockRecordBackendVerification).toHaveBeenCalledWith('opensandbox', { ok: true, kind: 'deep' });
  });
});
