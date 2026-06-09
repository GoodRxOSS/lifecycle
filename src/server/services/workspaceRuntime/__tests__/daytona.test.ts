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

import setupFetchMock, { res, type FetchRoute } from 'server/lib/__mocks__/fetchMock';
import type { ResolvedAgentSessionDaytonaBackendConfig } from 'server/lib/agentSession/runtimeConfig';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import {
  WorkspaceRuntimeGoneError,
  WorkspaceRuntimeSecurityError,
  type RemoteWorkspaceRuntimeProvider,
} from '../types';
import {
  DaytonaRuntimeService,
  readDaytonaProviderState,
  testDaytonaConnection,
  type DaytonaRuntimeProviderState,
} from '../providers/daytona';

jest.mock('server/lib/encryption', () => ({
  encrypt: jest.fn((value: string) => `enc:${value}`),
  decrypt: jest.fn((value: string) => value.replace(/^enc:/, '')),
}));

const baseConfig: ResolvedAgentSessionDaytonaBackendConfig = {
  apiUrl: 'https://app.daytona.io/api',
  apiKey: 'dtn-test-key',
  snapshot: 'lifecycle-workspace-1.0',
  autoArchiveInterval: 0,
  gatewayPort: 13338,
  editorPort: 13337,
};

const state: DaytonaRuntimeProviderState = {
  sandboxId: 'dtn-1',
  apiUrl: 'https://app.daytona.io/api',
  gatewayUrl: 'https://13338-dtn-1.proxy.daytona.work',
  gatewayHeaders: { 'x-daytona-preview-token': 'pv-old' },
};

const readiness = { timeoutMs: 5000, pollMs: 1 };

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

const harness = setupFetchMock();
const { routeFetch, callsMatching } = harness;

function provisionRoutes(overrides: { create?: Response[]; mcp?: Response[]; bootstrapStatus?: Response[] } = {}) {
  const routes: FetchRoute[] = [
    ['POST', '/files/bulk-upload', [res(200, { files: [] })]],
    ['POST', '/files/permissions', [res(200, {})]],
    ['POST', '/process/session/lifecycle-bootstrap/exec', [res(202, { cmdId: 'cmd-boot' })]],
    ['POST', '/process/session/lifecycle-gateway/exec', [res(202, { cmdId: 'cmd-gw' })]],
    ['POST', '/process/session/lifecycle-editor/exec', [res(202, { cmdId: 'cmd-ed' })]],
    ['GET', '/command/cmd-boot/logs', [res(200, 'bootstrap output')]],
    ['GET', '/command/cmd-boot', overrides.bootstrapStatus ?? [res(200, { exitCode: 0 })]],
    ['DELETE', '/process/session/lifecycle-bootstrap', [res(204)]],
    ['DELETE', '/process/session/lifecycle-gateway', [res(404, { message: 'not found' })]],
    ['DELETE', '/process/session/lifecycle-editor', [res(404, { message: 'not found' })]],
    ['POST', '/process/session', [res(201, '')]],
    ['POST', '/snapshots/lifecycle-workspace-1.0/activate', [res(200, {})]],
    [
      'GET',
      '/ports/13338/preview-url',
      [res(200, { url: 'https://13338-dtn-1.proxy.daytona.work', token: 'pv-gw-1' })],
    ],
    [
      'GET',
      '/ports/13337/preview-url',
      [res(200, { url: 'https://13337-dtn-1.proxy.daytona.work', token: 'pv-ed-1' })],
    ],
    ['GET', '13338-dtn-1.proxy.daytona.work/health', [res(500, ''), res(200, 'ok')]],
    [
      'POST',
      '13338-dtn-1.proxy.daytona.work/mcp',
      overrides.mcp ?? [res(401, { error: 'Unauthorized' }), res(200, {})],
    ],
    ['GET', '13337-dtn-1.proxy.daytona.work/healthz', [res(200, 'ok')]],
    ['DELETE', '/sandbox/dtn-1', [res(200, {})]],
    ['POST', '/sandbox', overrides.create ?? [res(200, { id: 'dtn-1', state: 'creating' })]],
    [
      'GET',
      '/sandbox/dtn-1',
      [res(200, { id: 'dtn-1', state: 'creating' }), res(200, { id: 'dtn-1', state: 'started' })],
    ],
  ];
  routeFetch(routes);
}

describe('readDaytonaProviderState', () => {
  it('round-trips a fully populated state', () => {
    const value = {
      sandboxId: 'dtn-1',
      apiUrl: 'https://app.daytona.io/api',
      gatewayUrl: 'https://13338-dtn-1.proxy.daytona.work',
      gatewayHeaders: { 'x-daytona-preview-token': 't' },
      editorUrl: 'https://13337-dtn-1.proxy.daytona.work',
      editorHeaders: { 'x-daytona-preview-token': 'e' },
      gatewayToken: 'enc:ciphertext',
    };

    expect(readDaytonaProviderState(value)).toEqual(value);
  });

  it.each([
    ['null', null],
    ['missing sandboxId', { apiUrl: 'https://app.daytona.io/api' }],
    ['missing apiUrl', { sandboxId: 'dtn-1' }],
  ])('returns null for %s', (_label, value) => {
    expect(readDaytonaProviderState(value)).toBeNull();
  });
});

describe('provision', () => {
  it('creates the sandbox with lifecycle-owned intervals, bootstraps via sessions, and verifies gateway auth both ways', async () => {
    provisionRoutes();
    const service = new DaytonaRuntimeService(baseConfig);

    const handle = await service.provision({ plan, readiness, gatewayToken: 'plain-token' });

    const [, createInit] = callsMatching('POST', '/sandbox')[0];
    expect(createInit?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer dtn-test-key' }));
    const createBody = JSON.parse(createInit?.body as string);
    expect(createBody).toMatchObject({
      snapshot: 'lifecycle-workspace-1.0',
      autoStopInterval: 0,
      autoArchiveInterval: 0,
      autoDeleteInterval: -1,
      public: false,
      labels: { lifecycleSessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    });
    // Create-time env reaches every session shell, so the gateway token rides here.
    expect(createBody.env.LIFECYCLE_GATEWAY_TOKEN).toBe('plain-token');
    expect(createBody.env.ANTHROPIC_API_KEY).toBe('provider-key');

    const [, uploadInit] = callsMatching('POST', '/files/bulk-upload')[0];
    const uploadForm = uploadInit?.body as FormData;
    expect(uploadForm.get('files[0].path')).toBe('/run/lifecycle/init-workspace.sh');
    expect(callsMatching('POST', '/files/permissions').length).toBeGreaterThanOrEqual(3);

    const [, bootstrapExecInit] = callsMatching('POST', '/process/session/lifecycle-bootstrap/exec')[0];
    expect(JSON.parse(bootstrapExecInit?.body as string)).toEqual({
      command: 'sh /run/lifecycle/bootstrap.sh',
      runAsync: true,
    });
    expect(callsMatching('DELETE', '/process/session/lifecycle-bootstrap')).toHaveLength(1);

    const [, gatewayExecInit] = callsMatching('POST', '/process/session/lifecycle-gateway/exec')[0];
    expect(JSON.parse(gatewayExecInit?.body as string).command).toContain('lifecycle-workspace-gateway');
    // The gateway session is the background process owner: it must never be deleted afterwards.
    expect(callsMatching('DELETE', '/process/session/lifecycle-gateway')).toHaveLength(1); // pre-exec reset only

    const mcpCalls = callsMatching('POST', '13338-dtn-1.proxy.daytona.work/mcp');
    expect(mcpCalls).toHaveLength(2);
    const [, probeInit] = mcpCalls[0];
    expect(probeInit?.headers).toEqual(expect.objectContaining({ 'x-daytona-preview-token': 'pv-gw-1' }));
    expect(probeInit?.headers).not.toHaveProperty('Authorization');
    const [, acceptedProbeInit] = mcpCalls[1];
    expect(acceptedProbeInit?.headers).toEqual(
      expect.objectContaining({
        'x-daytona-preview-token': 'pv-gw-1',
        Authorization: 'Bearer plain-token',
        'x-lifecycle-gateway-token': 'plain-token',
      })
    );

    expect(handle.podNameAlias).toBe('dtn-1');
    expect(handle.providerState).toMatchObject({
      sandboxId: 'dtn-1',
      gatewayUrl: 'https://13338-dtn-1.proxy.daytona.work',
      gatewayHeaders: { 'x-daytona-preview-token': 'pv-gw-1' },
      editorUrl: 'https://13337-dtn-1.proxy.daytona.work',
      editorHeaders: { 'x-daytona-preview-token': 'pv-ed-1' },
    });
    expect(handle.capabilitySnapshot).toMatchObject({ backend: 'daytona', editorAccess: true });
  });

  it('activates an inactive snapshot and retries the create once', async () => {
    provisionRoutes({
      create: [res(400, { message: 'Snapshot is inactive' }), res(200, { id: 'dtn-1', state: 'creating' })],
    });
    const service = new DaytonaRuntimeService(baseConfig);

    await service.provision({ plan, readiness, gatewayToken: 'plain-token' });

    expect(callsMatching('POST', '/snapshots/lifecycle-workspace-1.0/activate')).toHaveLength(1);
    expect(callsMatching('POST', '/sandbox')).toHaveLength(2);
  });

  it('fails with the bootstrap output and deletes the sandbox when bootstrap exits non-zero', async () => {
    provisionRoutes({ bootstrapStatus: [res(200, { exitCode: 1 })] });
    const service = new DaytonaRuntimeService(baseConfig);

    await expect(service.provision({ plan, readiness, gatewayToken: 'plain-token' })).rejects.toThrow(
      /Daytona bootstrap failed \(exit code 1\): bootstrap output/
    );
    expect(callsMatching('DELETE', '/sandbox/dtn-1')).toHaveLength(1);
  });

  it('fails closed and deletes the sandbox when the gateway does not enforce the token', async () => {
    provisionRoutes({ mcp: [res(200, {})] });
    const service = new DaytonaRuntimeService(baseConfig);

    await expect(service.provision({ plan, readiness, gatewayToken: 'plain-token' })).rejects.toBeInstanceOf(
      WorkspaceRuntimeSecurityError
    );
    expect(callsMatching('DELETE', '/sandbox/dtn-1')).toHaveLength(1);
  });

  it('fails closed and deletes the sandbox when the configured token is rejected', async () => {
    provisionRoutes({ mcp: [res(401, { error: 'Unauthorized' }), res(403, { error: 'Forbidden' })] });
    const service = new DaytonaRuntimeService(baseConfig);

    await expect(service.provision({ plan, readiness, gatewayToken: 'plain-token' })).rejects.toBeInstanceOf(
      WorkspaceRuntimeSecurityError
    );
    expect(callsMatching('DELETE', '/sandbox/dtn-1')).toHaveLength(1);
  });
});

describe('resume', () => {
  it('starts a stopped sandbox, restarts the gateway session, and re-resolves rotated preview tokens', async () => {
    routeFetch([
      ['POST', '/process/session/lifecycle-gateway/exec', [res(202, { cmdId: 'cmd-gw' })]],
      ['DELETE', '/process/session/lifecycle-gateway', [res(404, { message: 'not found' })]],
      ['POST', '/process/session', [res(201, '')]],
      [
        'GET',
        '/ports/13338/preview-url',
        [res(200, { url: 'https://13338-dtn-1.proxy.daytona.work', token: 'pv-gw-2' })],
      ],
      ['GET', '/ports/13337/preview-url', [res(404, { message: 'no preview' })]],
      ['GET', '13338-dtn-1.proxy.daytona.work/health', [res(500, ''), res(200, 'ok')]],
      ['POST', '13338-dtn-1.proxy.daytona.work/mcp', [res(401, { error: 'Unauthorized' }), res(200, {})]],
      ['POST', '/sandbox/dtn-1/start', [res(200, { id: 'dtn-1', state: 'starting' })]],
      [
        'GET',
        '/sandbox/dtn-1',
        [res(200, { id: 'dtn-1', state: 'stopped' }), res(200, { id: 'dtn-1', state: 'started' })],
      ],
    ]);
    const service = new DaytonaRuntimeService(baseConfig);

    const handle = await service.resume(
      {
        ...state,
        gatewayToken: 'enc:ciphertext',
        editorUrl: 'https://13337-dtn-1.proxy.daytona.work',
        editorHeaders: { 'x-daytona-preview-token': 'stale-rotated' },
      },
      readiness
    );

    expect(callsMatching('POST', '/sandbox/dtn-1/start')).toHaveLength(1);
    // Stale preview token is never reused; the rotated one rides on the new handle.
    expect(handle.providerState).toMatchObject({
      gatewayUrl: 'https://13338-dtn-1.proxy.daytona.work',
      gatewayHeaders: { 'x-daytona-preview-token': 'pv-gw-2' },
      gatewayToken: 'enc:ciphertext',
    });
    // Editor did not come back: explicit null (not delete) so the shallow merge cannot revive a dead,
    // rotated-token editor exposure presented as 'ready'.
    expect(handle.providerState.editorUrl).toBeNull();
    expect(handle.providerState.editorHeaders).toBeNull();
    expect(handle.capabilitySnapshot.editorAccess).toBe(false);
    expect(service.resolveEditorEndpoint(handle.providerState)).toBeNull();
    const mcpCalls = callsMatching('POST', '13338-dtn-1.proxy.daytona.work/mcp');
    expect(mcpCalls).toHaveLength(2);
    const [, acceptedProbeInit] = mcpCalls[1];
    expect(acceptedProbeInit?.headers).toEqual(
      expect.objectContaining({
        'x-daytona-preview-token': 'pv-gw-2',
        Authorization: 'Bearer ciphertext',
        'x-lifecycle-gateway-token': 'ciphertext',
      })
    );
  });

  it('throws WorkspaceRuntimeGoneError when the sandbox no longer exists', async () => {
    routeFetch([['GET', '/sandbox/dtn-1', [res(404, { message: 'not found' })]]]);
    const service = new DaytonaRuntimeService(baseConfig);

    const error = await service.resume(state, readiness).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkspaceRuntimeGoneError);
  });

  it('throws WorkspaceRuntimeGoneError when the sandbox was destroyed', async () => {
    routeFetch([['GET', '/sandbox/dtn-1', [res(200, { id: 'dtn-1', state: 'destroyed' })]]]);
    const service = new DaytonaRuntimeService(baseConfig);

    await expect(service.resume(state, readiness)).rejects.toBeInstanceOf(WorkspaceRuntimeGoneError);
  });
});

describe('reattach', () => {
  it('returns null when the sandbox is gone or destroyed', async () => {
    routeFetch([['GET', '/sandbox/dtn-1', [res(404, { message: 'gone' })]]]);
    const service = new DaytonaRuntimeService(baseConfig);
    await expect(service.reattach(state, readiness)).resolves.toBeNull();

    routeFetch([['GET', '/sandbox/dtn-1', [res(200, { id: 'dtn-1', state: 'destroyed' })]]]);
    await expect(service.reattach(state, readiness)).resolves.toBeNull();
  });

  it('re-verifies a started sandbox without touching sessions when the gateway is healthy', async () => {
    routeFetch([
      [
        'GET',
        '/ports/13338/preview-url',
        [res(200, { url: 'https://13338-dtn-1.proxy.daytona.work', token: 'pv-gw-3' })],
      ],
      ['GET', '/ports/13337/preview-url', [res(404, { message: 'no preview' })]],
      ['GET', '13338-dtn-1.proxy.daytona.work/health', [res(200, 'ok')]],
      ['GET', '/sandbox/dtn-1', [res(200, { id: 'dtn-1', state: 'started' })]],
    ]);
    const service = new DaytonaRuntimeService(baseConfig);

    const handle = await service.reattach(state, readiness);

    expect(handle).toMatchObject({
      podNameAlias: 'dtn-1',
      providerState: { gatewayHeaders: { 'x-daytona-preview-token': 'pv-gw-3' } },
    });
    expect(callsMatching('POST', '/process/session')).toHaveLength(0);
    expect(callsMatching('POST', '/mcp')).toHaveLength(0);
  });
});

describe('suspend and destroy', () => {
  it('stops the sandbox and waits for stopped', async () => {
    routeFetch([
      ['POST', '/sandbox/dtn-1/stop', [res(200, {})]],
      [
        'GET',
        '/sandbox/dtn-1',
        [res(200, { id: 'dtn-1', state: 'stopping' }), res(200, { id: 'dtn-1', state: 'stopped' })],
      ],
    ]);
    const service = new DaytonaRuntimeService(baseConfig);

    await expect(service.suspend(state, { retainForMs: 120_000 })).resolves.toBeUndefined();
  });

  it('throws WorkspaceRuntimeGoneError when stop hits 404', async () => {
    routeFetch([['POST', '/sandbox/dtn-1/stop', [res(404, { message: 'gone' })]]]);
    const service = new DaytonaRuntimeService(baseConfig);

    await expect(service.suspend(state, { retainForMs: 120_000 })).rejects.toBeInstanceOf(WorkspaceRuntimeGoneError);
  });

  it('tolerates 404 on destroy and has no renewLease', async () => {
    routeFetch([['DELETE', '/sandbox/dtn-1', [res(404, { message: 'gone' })]]]);
    const service = new DaytonaRuntimeService(baseConfig);

    await expect(service.destroy(state)).resolves.toBeUndefined();
    expect((service as RemoteWorkspaceRuntimeProvider).renewLease).toBeUndefined();
  });

  it('returns without throwing when provider state was never populated', async () => {
    const service = new DaytonaRuntimeService(baseConfig);

    await expect(service.destroy({})).resolves.toBeUndefined();
    await expect(service.destroy(null)).resolves.toBeUndefined();
  });
});

describe('endpoints', () => {
  it('serves gateway/editor endpoints from the handle-generation cache', () => {
    const service = new DaytonaRuntimeService(baseConfig);

    expect(service.resolveGatewayEndpoint(state)).toEqual({
      url: 'https://13338-dtn-1.proxy.daytona.work',
      headers: { 'x-daytona-preview-token': 'pv-old' },
    });
    expect(service.resolveEditorEndpoint(state)).toBeNull();
  });
});

describe('testDaytonaConnection', () => {
  const config = {
    provider: 'lifecycle_kubernetes',
    daytona: baseConfig,
  } as unknown as Parameters<typeof testDaytonaConnection>[0];

  it('verifies scopes and the configured snapshot', async () => {
    routeFetch([
      ['GET', '/api-keys/current', [res(200, { permissions: ['write:sandboxes', 'delete:sandboxes'] })]],
      ['GET', '/snapshots', [res(200, { items: [{ name: 'lifecycle-workspace-1.0', state: 'active' }] })]],
    ]);

    await expect(testDaytonaConnection(config)).resolves.toEqual({
      ok: true,
      message: 'Daytona connection verified.',
      details: { permissions: ['write:sandboxes', 'delete:sandboxes'], snapshotState: 'active' },
    });
  });

  it('reports missing scopes', async () => {
    routeFetch([['GET', '/api-keys/current', [res(200, { permissions: ['read:sandboxes'] })]]]);

    await expect(testDaytonaConnection(config)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('missing required scopes'),
    });
  });

  it('reports a missing snapshot', async () => {
    routeFetch([
      ['GET', '/api-keys/current', [res(200, { permissions: ['write:sandboxes', 'delete:sandboxes'] })]],
      ['GET', '/snapshots', [res(200, { items: [] })]],
    ]);

    await expect(testDaytonaConnection(config)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('was not found'),
    });
  });

  it('reports a rejected API key and scrubs it from errors', async () => {
    routeFetch([['GET', '/api-keys/current', [res(401, { message: 'bad key' })]]]);
    await expect(testDaytonaConnection(config)).resolves.toEqual({
      ok: false,
      message: 'Daytona rejected the configured API key.',
    });

    routeFetch([['GET', '/api-keys/current', [res(500, { message: 'boom dtn-test-key leaked' })]]]);
    const result = await testDaytonaConnection(config);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('dtn-test-key');
    expect(result.message).toContain('[redacted]');
  });
});
