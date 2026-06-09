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
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  })),
}));

import setupFetchMock, { res } from 'server/lib/__mocks__/fetchMock';
import type { ResolvedAgentSessionOpenSandboxBackendConfig } from 'server/lib/agentSession/runtimeConfig';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import { WorkspaceRuntimeGoneError, WorkspaceRuntimeSecurityError } from '../types';
import {
  OpenSandboxApiError,
  OpenSandboxRuntimeService,
  buildOpenSandboxCapabilitySnapshot,
  readOpenSandboxProviderState,
  type OpenSandboxRuntimeProviderState,
} from '../providers/opensandbox';

const baseConfig: ResolvedAgentSessionOpenSandboxBackendConfig = {
  domain: 'sandbox.example.com',
  protocol: 'https',
  apiKey: 'test-api-key',
  image: 'workspace:latest',
  timeoutSeconds: null,
  useServerProxy: false,
  secureAccess: true,
  resourceLimits: {},
  execdPort: 9001,
  gatewayPort: 8989,
  editorPort: 8443,
};

const state: OpenSandboxRuntimeProviderState = {
  sandboxId: 'sb-1',
  lifecycleBaseUrl: 'https://sandbox.example.com/v1',
};

const readiness = { timeoutMs: 5000, pollMs: 1 };

const harness = setupFetchMock();
const { routeFetch, callsMatching } = harness;

describe('readOpenSandboxProviderState', () => {
  it('round-trips a fully populated state', () => {
    const value = {
      sandboxId: 'sb-1',
      lifecycleBaseUrl: 'https://api.example.com/v1',
      execdBaseUrl: 'https://execd.example.com',
      execdHeaders: { 'x-token': 'abc' },
      gatewayUrl: 'https://gw.example.com',
      gatewayHeaders: { 'x-gw': 'g' },
      editorUrl: 'https://editor.example.com',
      editorHeaders: { 'x-ed': 'e' },
      gatewayCommandId: 'cmd-1',
      editorCommandId: 'cmd-2',
      gatewayToken: 'enc:ciphertext',
    };

    expect(readOpenSandboxProviderState(value)).toEqual(value);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'sb-1'],
    ['missing sandboxId', { lifecycleBaseUrl: 'https://api.example.com/v1' }],
    ['missing lifecycleBaseUrl', { sandboxId: 'sb-1' }],
    ['blank sandboxId', { sandboxId: '   ', lifecycleBaseUrl: 'https://api.example.com/v1' }],
  ])('returns null for %s', (_label, value) => {
    expect(readOpenSandboxProviderState(value)).toBeNull();
  });

  it('strips OPEN-SANDBOX-API-KEY entries from header records regardless of case', () => {
    const parsed = readOpenSandboxProviderState({
      sandboxId: 'sb-1',
      lifecycleBaseUrl: 'https://api.example.com/v1',
      execdHeaders: { 'x-token': 'abc', 'open-sandbox-api-key': 'secret', 'OPEN-SANDBOX-API-KEY': 'secret' },
      gatewayHeaders: { 'OPEN-SANDBOX-API-KEY': 'secret' },
    });

    expect(parsed).toEqual({
      sandboxId: 'sb-1',
      lifecycleBaseUrl: 'https://api.example.com/v1',
      execdHeaders: { 'x-token': 'abc' },
    });
  });

  it('drops non-string entries, blank strings, and unknown keys', () => {
    const parsed = readOpenSandboxProviderState({
      sandboxId: 'sb-1',
      lifecycleBaseUrl: 'https://api.example.com/v1',
      execdHeaders: { 'x-token': 'abc', count: 5, nested: { a: 1 } },
      gatewayCommandId: 42,
      editorUrl: '   ',
      extra: 'dropped',
    });

    expect(parsed).toEqual({
      sandboxId: 'sb-1',
      lifecycleBaseUrl: 'https://api.example.com/v1',
      execdHeaders: { 'x-token': 'abc' },
    });
  });
});

describe('buildOpenSandboxCapabilitySnapshot', () => {
  it('reports editorAccess from editorUrl on top of the declared capabilities', () => {
    const snapshot = buildOpenSandboxCapabilitySnapshot({ editorUrl: 'https://editor.example.com' });

    expect(snapshot).toMatchObject({
      backend: 'opensandbox',
      editorAccess: true,
      newChatWorkspaces: { supported: true },
      sandboxSessions: { supported: true },
      environmentSessions: { supported: false },
      developWorkspaces: { supported: false },
      previewPorts: { supported: true },
      hibernateResume: { supported: true },
      prewarm: { supported: false },
    });
    expect(snapshot.editor.supported).toBe(true);
    expect(buildOpenSandboxCapabilitySnapshot({}).editorAccess).toBe(false);
  });
});

describe('destroy (delete error mapping)', () => {
  it('tolerates 404 and sends the API key to the v1 sandbox URL', async () => {
    routeFetch([['DELETE', '/sandboxes/sb-1', [res(404, { message: 'gone' })]]]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.destroy(state)).resolves.toBeUndefined();

    expect(harness.fetch()).toHaveBeenCalledWith(
      'https://sandbox.example.com/v1/sandboxes/sb-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ 'OPEN-SANDBOX-API-KEY': 'test-api-key' }),
      })
    );
  });

  it.each([
    ['body.message', { message: 'top-level msg' }, 'top-level msg'],
    ['body.error.message', { error: { message: 'nested msg' } }, 'nested msg'],
    ['raw text body', 'plain text failure', 'plain text failure'],
    ['statusText fallback', undefined, 'status-500'],
  ])('rethrows 500 with the message from %s', async (_label, body, expectedMessage) => {
    routeFetch([['DELETE', '/sandboxes/sb-1', [res(500, body)]]]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const error = await service.destroy(state).catch((caught) => caught);

    expect(error).toBeInstanceOf(OpenSandboxApiError);
    expect(error.status).toBe(500);
    expect(error.message).toBe(`OpenSandbox delete failed: ${expectedMessage} (status=500)`);
  });

  it('returns without throwing when provider state was never populated', async () => {
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.destroy({})).resolves.toBeUndefined();
    await expect(service.destroy(null)).resolves.toBeUndefined();
    expect(harness.fetch()).not.toHaveBeenCalled();
  });
});

describe('resume (waitForSandboxState)', () => {
  it('tolerates a transient 500, waits for Running, and reconnects endpoints', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/resume', [res(200, {})]],
      ['GET', '/endpoints/9001', [res(200, { endpoint: 'execd.example.com', headers: { 'x-execd-token': 'tok' } })]],
      ['GET', '/endpoints/8989', [res(200, { endpoint: 'https://gw.example.com' })]],
      ['GET', '/endpoints/8443', [res(404, { message: 'no editor' })]],
      ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
      ['GET', 'gw.example.com/health', [res(200, 'ok')]],
      [
        'GET',
        '/sandboxes/sb-1',
        [res(500, { message: 'blip' }), res(200, { id: 'sb-1', status: { state: 'Running' } })],
      ],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const resumed = await service.resume(state, readiness);

    expect(resumed.providerState).toEqual({
      sandboxId: 'sb-1',
      lifecycleBaseUrl: 'https://sandbox.example.com/v1',
      execdBaseUrl: 'https://execd.example.com',
      execdHeaders: { 'x-execd-token': 'tok' },
      gatewayUrl: 'https://gw.example.com',
    });
    expect(resumed.podNameAlias).toBe('sb-1');
    expect(resumed.capabilitySnapshot).toMatchObject({ backend: 'opensandbox', editorAccess: false });
    expect(callsMatching('POST', '/resume')).toHaveLength(1);
    expect(callsMatching('GET', '/sandboxes/sb-1')[0]).toBeDefined();
    const [, pingInit] = callsMatching('GET', 'execd.example.com/ping')[0];
    expect(pingInit?.headers).toEqual(
      expect.objectContaining({ 'OPEN-SANDBOX-API-KEY': 'test-api-key', 'x-execd-token': 'tok' })
    );
  });

  it('throws WorkspaceRuntimeGoneError after three consecutive 404s while polling', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/resume', [res(200, {})]],
      ['GET', '/sandboxes/sb-1', [res(404, { message: 'not found' })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const error = await service.resume(state, readiness).catch((caught) => caught);

    expect(error).toBeInstanceOf(WorkspaceRuntimeGoneError);
    expect(error.cause).toBeInstanceOf(OpenSandboxApiError);
    expect(error.cause.status).toBe(404);
    expect(callsMatching('GET', '/sandboxes/sb-1')).toHaveLength(3);
  });

  it('throws WorkspaceRuntimeGoneError when the resume call itself reports the sandbox gone', async () => {
    routeFetch([['POST', '/sandboxes/sb-1/resume', [res(404, { message: 'gone' })]]]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.resume(state, readiness)).rejects.toBeInstanceOf(WorkspaceRuntimeGoneError);
  });

  it('throws immediately when the sandbox enters Failed', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/resume', [res(200, {})]],
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', status: { state: 'Failed', message: 'oom killed' } })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.resume(state, readiness)).rejects.toThrow(
      'OpenSandbox sandbox sb-1 entered Failed while waiting for Running: oom killed'
    );
    expect(callsMatching('GET', '/sandboxes/sb-1')).toHaveLength(1);
  });
});

describe('reattach', () => {
  it('returns null when the sandbox is gone (404) without deleting', async () => {
    routeFetch([['GET', '/sandboxes/sb-1', [res(404, { message: 'gone' })]]]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.reattach(state, readiness)).resolves.toBeNull();
    expect(callsMatching('DELETE', '/sandboxes/sb-1')).toHaveLength(0);
  });

  it('returns null for unparsable provider state without touching the API', async () => {
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.reattach({ bogus: true }, readiness)).resolves.toBeNull();
    expect(harness.fetch()).not.toHaveBeenCalled();
  });

  it('rethrows non-404 getSandbox failures', async () => {
    routeFetch([['GET', '/sandboxes/sb-1', [res(500, { message: 'api down' })]]]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const error = await service.reattach(state, readiness).catch((caught) => caught);

    expect(error).toBeInstanceOf(OpenSandboxApiError);
    expect(error.status).toBe(500);
  });

  it.each(['Failed', 'Terminated', 'Stopping'])(
    'deletes the sandbox and returns null when %s',
    async (sandboxState) => {
      routeFetch([
        ['DELETE', '/sandboxes/sb-1', [res(200, {})]],
        ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', status: { state: sandboxState } })]],
      ]);
      const service = new OpenSandboxRuntimeService(baseConfig);

      await expect(service.reattach(state, readiness)).resolves.toBeNull();
      expect(callsMatching('DELETE', '/sandboxes/sb-1')).toHaveLength(1);
    }
  );

  it('resumes a Paused sandbox, reconnects, and reports editor access', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/resume', [res(200, {})]],
      ['GET', '/endpoints/9001', [res(200, { endpoint: 'execd.example.com' })]],
      ['GET', '/endpoints/8989', [res(200, { endpoint: 'gw.example.com' })]],
      ['GET', '/endpoints/8443', [res(200, { endpoint: 'editor.example.com' })]],
      ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
      ['GET', 'gw.example.com/health', [res(200, 'ok')]],
      ['GET', 'editor.example.com/healthz', [res(200, 'ok')]],
      [
        'GET',
        '/sandboxes/sb-1',
        [res(200, { id: 'sb-1', status: { state: 'Paused' } }), res(200, { id: 'sb-1', status: { state: 'Running' } })],
      ],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const result = await service.reattach(state, readiness);

    expect(callsMatching('POST', '/resume')).toHaveLength(1);
    expect(result).toMatchObject({
      podNameAlias: 'sb-1',
      providerState: {
        execdBaseUrl: 'https://execd.example.com',
        gatewayUrl: 'https://gw.example.com',
        editorUrl: 'https://editor.example.com',
      },
      capabilitySnapshot: expect.objectContaining({ editorAccess: true, backend: 'opensandbox' }),
    });
  });
});

describe('renewExpiration', () => {
  it('is a no-op when timeoutSeconds is null and no ttlMs is given', async () => {
    const service = new OpenSandboxRuntimeService(baseConfig);

    await service.renewExpiration(state);

    expect(harness.fetch()).not.toHaveBeenCalled();
  });

  it('skips the POST when the current expiry is already later than the target', async () => {
    routeFetch([
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', expiresAt: new Date(Date.now() + 7_200_000).toISOString() })]],
    ]);
    const service = new OpenSandboxRuntimeService({ ...baseConfig, timeoutSeconds: 60 });

    await service.renewExpiration(state);

    expect(callsMatching('POST', '/renew-expiration')).toHaveLength(0);
    expect(harness.fetch()).toHaveBeenCalledTimes(1);
  });

  it('skips the POST when the sandbox has no expiry', async () => {
    routeFetch([['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1' })]]]);
    const service = new OpenSandboxRuntimeService({ ...baseConfig, timeoutSeconds: 60 });

    await service.renewExpiration(state);

    expect(callsMatching('POST', '/renew-expiration')).toHaveLength(0);
  });

  it('POSTs renew-expiration with now + ttlMs when the expiry is sooner', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/renew-expiration', [res(200, {})]],
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', expiresAt: new Date(Date.now() + 1000).toISOString() })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const before = Date.now();
    await service.renewExpiration(state, 60_000);
    const after = Date.now();

    const [, init] = callsMatching('POST', '/renew-expiration')[0];
    const expiresAt = new Date(JSON.parse(init?.body as string).expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 60_000);
  });

  it('swallows API failures and logs a warning', async () => {
    routeFetch([['GET', '/sandboxes/sb-1', [res(500, { message: 'api down' })]]]);
    const service = new OpenSandboxRuntimeService({ ...baseConfig, timeoutSeconds: 60 });

    await expect(service.renewExpiration(state)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe('renewLease', () => {
  it('skips unparsable provider state silently', async () => {
    const service = new OpenSandboxRuntimeService({ ...baseConfig, timeoutSeconds: 60 });

    await expect(service.renewLease({ bogus: true })).resolves.toBeUndefined();
    expect(harness.fetch()).not.toHaveBeenCalled();
  });

  it('renews the expiration for valid state', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/renew-expiration', [res(200, {})]],
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', expiresAt: new Date(Date.now() + 1000).toISOString() })]],
    ]);
    const service = new OpenSandboxRuntimeService({ ...baseConfig, timeoutSeconds: 60 });

    await service.renewLease(state);

    expect(callsMatching('POST', '/renew-expiration')).toHaveLength(1);
  });
});

describe('suspend', () => {
  it('renews expiration before pausing, then waits for Paused', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/renew-expiration', [res(200, {})]],
      ['POST', '/sandboxes/sb-1/pause', [res(200, {})]],
      [
        'GET',
        '/sandboxes/sb-1',
        [
          res(200, { id: 'sb-1', expiresAt: new Date(Date.now() + 1000).toISOString() }),
          res(200, { id: 'sb-1', status: { state: 'Paused' } }),
        ],
      ],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await service.suspend(state, { retainForMs: 120_000 });

    const urls = harness
      .fetch()
      .mock.calls.map(
        ([url, init]: [string, RequestInit | undefined]) => `${(init?.method || 'GET').toUpperCase()} ${url}`
      );
    const renewIndex = urls.findIndex((entry) => entry.includes('/renew-expiration'));
    const pauseIndex = urls.findIndex((entry) => entry.includes('/pause'));
    expect(renewIndex).toBeGreaterThanOrEqual(0);
    expect(pauseIndex).toBeGreaterThan(renewIndex);
    expect(callsMatching('GET', '/sandboxes/sb-1')).toHaveLength(2);

    const [, renewInit] = callsMatching('POST', '/renew-expiration')[0];
    const expiresAt = new Date(JSON.parse(renewInit?.body as string).expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now() + 110_000);
  });

  it('fails the suspend (sandbox keeps running) when the retention renewal fails, instead of pausing with a short TTL', async () => {
    routeFetch([
      ['GET', '/sandboxes/sb-1', [res(500, { message: 'renew api down' })]],
      ['POST', '/sandboxes/sb-1/pause', [res(200, {})]],
    ]);
    const service = new OpenSandboxRuntimeService({ ...baseConfig, timeoutSeconds: 60 });

    await expect(service.suspend(state, { retainForMs: 120_000 })).rejects.toThrow();
    // The sandbox is never paused, so it keeps running with its current (longer) TTL.
    expect(callsMatching('POST', '/pause')).toHaveLength(0);
  });
});

describe('endpoint resolution', () => {
  const service = new OpenSandboxRuntimeService(baseConfig);
  const fullState = {
    ...state,
    gatewayUrl: 'https://gw.example.com',
    gatewayHeaders: { Host: 'gw.internal' },
    editorUrl: 'https://editor.example.com',
    editorHeaders: { Host: 'editor.internal' },
  };

  it('merges the platform api key into gateway and editor endpoint headers', () => {
    expect(service.resolveGatewayEndpoint(fullState)).toEqual({
      url: 'https://gw.example.com',
      headers: { 'OPEN-SANDBOX-API-KEY': 'test-api-key', Host: 'gw.internal' },
    });
    expect(service.resolveEditorEndpoint(fullState)).toEqual({
      url: 'https://editor.example.com',
      headers: { 'OPEN-SANDBOX-API-KEY': 'test-api-key', Host: 'editor.internal' },
    });
  });

  it('returns null when the endpoint url is missing from state', () => {
    expect(service.resolveGatewayEndpoint(state)).toBeNull();
    expect(service.resolveEditorEndpoint(state)).toBeNull();
    expect(service.resolveGatewayEndpoint({ bogus: true })).toBeNull();
  });
});

describe('gateway token (D9)', () => {
  const plan = {
    version: 1,
    kind: 'chat',
    sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    forwardedEnv: { env: {}, secretRefs: [], secretProviders: [], secretServiceName: 'agent-env-svc' },
    provider: {
      selection: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
      apiKey: 'provider-key',
      credentialEnv: { ANTHROPIC_API_KEY: 'provider-key' },
    },
    credentials: { hasGitHubToken: false, githubToken: null },
    startupMcp: { servers: [], serializedConfig: '[]' },
    servicePlan: { workspaceRepos: [], services: undefined, selectedServices: [] },
    skillPlan: { version: 1, skills: [] },
    runtimeConfig: { readiness },
  } as unknown as WorkspaceRuntimePlan;

  function provisionRoutes(mcpResponses: Response[]) {
    routeFetch([
      ['POST', '/files/upload', [res(200, {})]],
      ['POST', 'execd.example.com/command', [res(200, '')]],
      ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
      ['GET', '/endpoints/9001', [res(200, { endpoint: 'execd.example.com' })]],
      ['GET', '/endpoints/8989', [res(200, { endpoint: 'gw.example.com' })]],
      ['GET', '/endpoints/8443', [res(404, { message: 'no editor' })]],
      ['GET', 'gw.example.com/health', [res(500, ''), res(200, 'ok')]],
      ['POST', 'gw.example.com/mcp', mcpResponses],
      ['DELETE', '/sandboxes/sb-new', [res(200, {})]],
      ['POST', '/sandboxes', [res(200, { id: 'sb-new' })]],
      ['GET', '/sandboxes/sb-new', [res(200, { id: 'sb-new', status: { state: 'Running' } })]],
    ]);
  }

  it('injects the token into the create-time env and gateway start command, then probes auth both ways', async () => {
    provisionRoutes([res(401, { error: 'Unauthorized' }), res(200, {})]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const handle = await service.provision({ plan, readiness, gatewayToken: 'plain-token' });

    expect(handle.podNameAlias).toBe('sb-new');
    // Ciphertext persistence belongs to orchestration; the provider never sees it.
    expect(handle.providerState.gatewayToken).toBeUndefined();

    const [, createInit] = callsMatching('POST', '/sandboxes').filter(([url]) => !String(url).includes('execd'))[0];
    const createBody = JSON.parse(createInit?.body as string);
    expect(createBody.env.LIFECYCLE_GATEWAY_TOKEN).toBe('plain-token');

    const commandBodies = callsMatching('POST', 'execd.example.com/command').map(
      ([, init]) => JSON.parse(init?.body as string).command as string
    );
    const gatewayStart = commandBodies.find((command) => command.includes('lifecycle-workspace-gateway'));
    expect(gatewayStart).toContain("export LIFECYCLE_GATEWAY_TOKEN='plain-token'");

    const mcpCalls = callsMatching('POST', 'gw.example.com/mcp');
    const [, negativeProbeInit] = mcpCalls[0];
    expect(negativeProbeInit?.headers).toEqual(expect.objectContaining({ 'OPEN-SANDBOX-API-KEY': 'test-api-key' }));
    expect(negativeProbeInit?.headers).not.toHaveProperty('Authorization');
    expect(negativeProbeInit?.headers).not.toHaveProperty('x-lifecycle-gateway-token');

    const [, positiveProbeInit] = mcpCalls[1];
    expect(positiveProbeInit?.headers).toEqual(
      expect.objectContaining({
        'OPEN-SANDBOX-API-KEY': 'test-api-key',
        Authorization: 'Bearer plain-token',
        'x-lifecycle-gateway-token': 'plain-token',
      })
    );
  });

  it('fails provisioning closed and deletes the sandbox when the gateway does not enforce the token', async () => {
    provisionRoutes([res(200, {})]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.provision({ plan, readiness, gatewayToken: 'plain-token' })).rejects.toBeInstanceOf(
      WorkspaceRuntimeSecurityError
    );
    expect(callsMatching('DELETE', '/sandboxes/sb-new')).toHaveLength(1);
  });

  it('fails provisioning closed and deletes the sandbox when the configured token is rejected', async () => {
    provisionRoutes([res(401, { error: 'Unauthorized' }), res(401, { error: 'Unauthorized' })]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.provision({ plan, readiness, gatewayToken: 'plain-token' })).rejects.toBeInstanceOf(
      WorkspaceRuntimeSecurityError
    );
    expect(callsMatching('DELETE', '/sandboxes/sb-new')).toHaveLength(1);
  });

  it('re-verifies enforcement on resume when the persisted state carries a token', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/resume', [res(200, {})]],
      ['GET', '/endpoints/9001', [res(200, { endpoint: 'execd.example.com' })]],
      ['GET', '/endpoints/8989', [res(200, { endpoint: 'gw.example.com' })]],
      ['GET', '/endpoints/8443', [res(404, { message: 'no editor' })]],
      ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
      ['GET', 'gw.example.com/health', [res(200, 'ok')]],
      ['POST', 'gw.example.com/mcp', [res(401, { error: 'Unauthorized' })]],
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', status: { state: 'Running' } })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const handle = await service.resume({ ...state, gatewayToken: 'enc:ciphertext' }, readiness);

    // The ciphertext rides through resume so token-bearing sandboxes stay verifiable and authable.
    expect(handle.providerState.gatewayToken).toBe('enc:ciphertext');
    expect(callsMatching('POST', 'gw.example.com/mcp')).toHaveLength(1);
  });

  it('fails resume with a security error when the gateway accepts unauthenticated requests', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/resume', [res(200, {})]],
      ['GET', '/endpoints/9001', [res(200, { endpoint: 'execd.example.com' })]],
      ['GET', '/endpoints/8989', [res(200, { endpoint: 'gw.example.com' })]],
      ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
      ['GET', 'gw.example.com/health', [res(200, 'ok')]],
      ['POST', 'gw.example.com/mcp', [res(200, {})]],
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', status: { state: 'Running' } })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.resume({ ...state, gatewayToken: 'enc:ciphertext' }, readiness)).rejects.toBeInstanceOf(
      WorkspaceRuntimeSecurityError
    );
  });
});
