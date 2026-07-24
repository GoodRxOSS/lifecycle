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

jest.mock('server/lib/encryption', () => ({
  encrypt: jest.fn((value: string) => `enc:${value}`),
  decrypt: jest.fn((value: string) => value.replace(/^enc:/, '')),
}));

import setupFetchMock, { res } from 'server/lib/__mocks__/fetchMock';
import type { ResolvedAgentSessionE2bBackendConfig } from 'server/lib/agentSession/runtimeConfig';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import { WorkspaceRuntimeGoneError, WorkspaceRuntimeSecurityError } from '../types';
import {
  E2bApiError,
  E2bRuntimeService,
  readE2bProviderState,
  listE2bWorkspaceSources,
  testE2bConnection,
  type E2bRuntimeProviderState,
} from '../providers/e2b';

const baseConfig: ResolvedAgentSessionE2bBackendConfig = {
  domain: 'e2b.app',
  apiKey: 'e2b-test-key',
  templateId: 'lifecycle-workspace',
  timeoutSeconds: 3600,
  autoPause: true,
  gatewayPort: 13338,
  editorPort: 13337,
};

const state: E2bRuntimeProviderState = {
  sandboxId: 'sb-1',
  domain: 'e2b.app',
  envdAccessToken: 'envd-tok',
  trafficAccessToken: 'traffic-tok',
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

function provisionRoutes(mcpResponses: Response[]) {
  routeFetch([
    ['POST', '49983-sb-new.e2b.app/files', [res(200, [])]],
    ['GET', '49983-sb-new.e2b.app/health', [res(204)]],
    ['GET', '13338-sb-new.e2b.app/health', [res(200, 'ok')]],
    ['POST', '13338-sb-new.e2b.app/mcp', mcpResponses],
    ['GET', '13337-sb-new.e2b.app/healthz', [res(200, 'ok')]],
    ['DELETE', '/sandboxes/sb-new', [res(204)]],
    [
      'POST',
      '/sandboxes',
      [
        res(200, {
          sandboxID: 'sb-new',
          envdAccessToken: 'envd-new',
          trafficAccessToken: 'traffic-new',
          endAt: '2026-06-09T13:00:00.000Z',
        }),
      ],
    ],
  ]);
}

describe('readE2bProviderState', () => {
  it('round-trips a fully populated state', () => {
    const value = {
      sandboxId: 'sb-1',
      domain: 'e2b.app',
      envdAccessToken: 'envd-tok',
      trafficAccessToken: 'traffic-tok',
      expiresAt: '2026-06-09T13:00:00.000Z',
      editorUrl: 'https://13337-sb-1.e2b.app',
      editorHeaders: { 'x-h': 'v' },
      gatewayToken: 'enc:ciphertext',
    };

    expect(readE2bProviderState(value)).toEqual(value);
  });

  it.each([
    ['null', null],
    ['missing sandboxId', { domain: 'e2b.app' }],
    ['missing domain', { sandboxId: 'sb-1' }],
  ])('returns null for %s', (_label, value) => {
    expect(readE2bProviderState(value)).toBeNull();
  });
});

describe('provision', () => {
  it('creates a locked-down sandbox, delivers instance.env last, and verifies gateway auth both ways', async () => {
    provisionRoutes([res(401, { error: 'Unauthorized' }), res(200, {})]);
    const service = new E2bRuntimeService(baseConfig);

    const handle = await service.provision({ plan, readiness, gatewayToken: 'plain-token' });

    const [, createInit] = callsMatching('POST', '/sandboxes')[0];
    expect(createInit?.headers).toEqual(expect.objectContaining({ 'X-API-Key': 'e2b-test-key' }));
    const createBody = JSON.parse(createInit?.body as string);
    expect(createBody).toMatchObject({
      templateID: 'lifecycle-workspace',
      timeout: 3600,
      autoPause: true,
      secure: true,
      network: { allowPublicTraffic: false },
      metadata: { lifecycleSessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    });
    // Secrets never ride in envVars; they go through the envd-delivered instance.env.
    expect(createBody.envVars.LIFECYCLE_SESSION_WORKSPACE).toBeDefined();
    expect(createBody.envVars.ANTHROPIC_API_KEY).toBeUndefined();
    expect(createBody.envVars.LIFECYCLE_GATEWAY_TOKEN).toBeUndefined();

    const uploads = callsMatching('POST', '49983-sb-new.e2b.app/files');
    const uploadPaths = uploads.map(([url]) => new URL(String(url)).searchParams.get('path'));
    expect(uploadPaths[uploadPaths.length - 1]).toBe('/tmp/lifecycle/instance.env');
    expect(uploadPaths).toContain('/tmp/lifecycle/bootstrap.sh');
    for (const [, init] of uploads) {
      expect(init?.headers).toEqual(expect.objectContaining({ 'X-Access-Token': 'envd-new' }));
    }
    const instanceEnvForm = uploads[uploads.length - 1][1]?.body as FormData;
    const instanceEnv = await (instanceEnvForm.get('file') as Blob).text();
    expect(instanceEnv).toContain("LIFECYCLE_GATEWAY_TOKEN='plain-token'");
    expect(instanceEnv).toContain("ANTHROPIC_API_KEY='provider-key'");

    const [, healthInit] = callsMatching('GET', '13338-sb-new.e2b.app/health')[0];
    expect(healthInit?.headers).toEqual({ 'e2b-traffic-access-token': 'traffic-new' });
    const mcpCalls = callsMatching('POST', '13338-sb-new.e2b.app/mcp');
    expect(mcpCalls).toHaveLength(2);
    const [, probeInit] = mcpCalls[0];
    expect(probeInit?.headers).toEqual(expect.objectContaining({ 'e2b-traffic-access-token': 'traffic-new' }));
    expect(probeInit?.headers).not.toHaveProperty('Authorization');
    const [, acceptedProbeInit] = mcpCalls[1];
    expect(acceptedProbeInit?.headers).toEqual(
      expect.objectContaining({
        'e2b-traffic-access-token': 'traffic-new',
        Authorization: 'Bearer plain-token',
        'x-lifecycle-gateway-token': 'plain-token',
      })
    );

    expect(handle.podNameAlias).toBe('sb-new');
    expect(handle.providerState).toMatchObject({
      sandboxId: 'sb-new',
      domain: 'e2b.app',
      envdAccessToken: 'envd-new',
      trafficAccessToken: 'traffic-new',
      expiresAt: '2026-06-09T13:00:00.000Z',
      editorUrl: 'https://13337-sb-new.e2b.app',
    });
    expect(handle.capabilitySnapshot).toMatchObject({ backend: 'e2b', editorAccess: true });
  });

  it('fails closed and kills the sandbox when the gateway does not enforce the token', async () => {
    provisionRoutes([res(200, {})]);
    const service = new E2bRuntimeService(baseConfig);

    await expect(service.provision({ plan, readiness, gatewayToken: 'plain-token' })).rejects.toBeInstanceOf(
      WorkspaceRuntimeSecurityError
    );
    expect(callsMatching('DELETE', '/sandboxes/sb-new')).toHaveLength(1);
  });

  it('fails closed and kills the sandbox when the configured token is rejected', async () => {
    provisionRoutes([res(401, { error: 'Unauthorized' }), res(403, { error: 'Forbidden' })]);
    const service = new E2bRuntimeService(baseConfig);

    await expect(service.provision({ plan, readiness, gatewayToken: 'plain-token' })).rejects.toBeInstanceOf(
      WorkspaceRuntimeSecurityError
    );
    expect(callsMatching('DELETE', '/sandboxes/sb-new')).toHaveLength(1);
  });
});

describe('resume', () => {
  it('re-reads rotated tokens from /connect and re-verifies the gateway with them', async () => {
    routeFetch([
      [
        'POST',
        '/sandboxes/sb-1/connect',
        [res(201, { sandboxID: 'sb-1', envdAccessToken: 'envd-rotated', trafficAccessToken: 'traffic-rotated' })],
      ],
      ['GET', '49983-sb-1.e2b.app/health', [res(204)]],
      ['GET', '13338-sb-1.e2b.app/health', [res(200, 'ok')]],
      ['POST', '13338-sb-1.e2b.app/mcp', [res(401, { error: 'Unauthorized' }), res(200, {})]],
      ['GET', '13337-sb-1.e2b.app/healthz', [res(404, '')]],
    ]);
    const service = new E2bRuntimeService(baseConfig);

    const handle = await service.resume({ ...state, gatewayToken: 'enc:ciphertext' }, readiness);

    const [, connectInit] = callsMatching('POST', '/connect')[0];
    expect(JSON.parse(connectInit?.body as string)).toEqual({ timeout: 3600 });
    expect(handle.providerState).toMatchObject({
      envdAccessToken: 'envd-rotated',
      trafficAccessToken: 'traffic-rotated',
      gatewayToken: 'enc:ciphertext',
    });
    const [, healthInit] = callsMatching('GET', '13338-sb-1.e2b.app/health')[0];
    expect(healthInit?.headers).toEqual({ 'e2b-traffic-access-token': 'traffic-rotated' });
    const mcpCalls = callsMatching('POST', '13338-sb-1.e2b.app/mcp');
    expect(mcpCalls).toHaveLength(2);
    const [, acceptedProbeInit] = mcpCalls[1];
    expect(acceptedProbeInit?.headers).toEqual(
      expect.objectContaining({
        'e2b-traffic-access-token': 'traffic-rotated',
        Authorization: 'Bearer ciphertext',
        'x-lifecycle-gateway-token': 'ciphertext',
      })
    );
  });

  it('throws WorkspaceRuntimeGoneError when the sandbox expired', async () => {
    routeFetch([['POST', '/sandboxes/sb-1/connect', [res(404, { message: 'not found' })]]]);
    const service = new E2bRuntimeService(baseConfig);

    const error = await service.resume(state, readiness).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkspaceRuntimeGoneError);
    expect(error.cause).toBeInstanceOf(E2bApiError);
  });

  it('emits null (not delete) editor keys when the editor is absent so the shallow merge cannot revive a stale editor', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/connect', [res(201, { sandboxID: 'sb-1', trafficAccessToken: 'traffic-rotated' })]],
      ['GET', '49983-sb-1.e2b.app/health', [res(204)]],
      ['GET', '13338-sb-1.e2b.app/health', [res(200, 'ok')]],
      ['GET', '13337-sb-1.e2b.app/healthz', [res(404, '')]],
    ]);
    const service = new E2bRuntimeService(baseConfig);

    const handle = await service.resume(state, readiness);

    expect(handle.providerState.editorUrl).toBeNull();
    expect(handle.providerState.editorHeaders).toBeNull();
    expect(handle.capabilitySnapshot.editorAccess).toBe(false);
    expect(service.resolveEditorEndpoint(handle.providerState)).toBeNull();
  });
});

describe('reattach', () => {
  it('returns null when the sandbox is gone', async () => {
    routeFetch([['GET', '/sandboxes/sb-1', [res(404, { message: 'gone' })]]]);
    const service = new E2bRuntimeService(baseConfig);

    await expect(service.reattach(state, readiness)).resolves.toBeNull();
  });

  it('returns null for unparsable state without touching the API', async () => {
    const service = new E2bRuntimeService(baseConfig);

    await expect(service.reattach({ bogus: true }, readiness)).resolves.toBeNull();
    expect(harness.fetch()).not.toHaveBeenCalled();
  });

  it('connects a paused sandbox and re-verifies endpoints (no probe without a token)', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/connect', [res(201, { sandboxID: 'sb-1', trafficAccessToken: 'traffic-rotated' })]],
      ['GET', '49983-sb-1.e2b.app/health', [res(204)]],
      ['GET', '13338-sb-1.e2b.app/health', [res(200, 'ok')]],
      ['GET', '13337-sb-1.e2b.app/healthz', [res(404, '')]],
      ['GET', '/sandboxes/sb-1', [res(200, { sandboxID: 'sb-1', state: 'paused' })]],
    ]);
    const service = new E2bRuntimeService(baseConfig);

    const handle = await service.reattach(state, readiness);

    expect(handle).toMatchObject({
      podNameAlias: 'sb-1',
      providerState: { trafficAccessToken: 'traffic-rotated' },
    });
    expect(callsMatching('POST', '/mcp')).toHaveLength(0);
  });
});

describe('suspend', () => {
  it('pauses the sandbox', async () => {
    routeFetch([['POST', '/sandboxes/sb-1/pause', [res(204)]]]);
    const service = new E2bRuntimeService(baseConfig);

    await expect(service.suspend(state, { retainForMs: 120_000 })).resolves.toBeUndefined();
  });

  it('treats 409 as success when the sandbox is already paused', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/pause', [res(409, { message: 'already paused' })]],
      ['GET', '/sandboxes/sb-1', [res(200, { sandboxID: 'sb-1', state: 'paused' })]],
    ]);
    const service = new E2bRuntimeService(baseConfig);

    await expect(service.suspend(state, { retainForMs: 120_000 })).resolves.toBeUndefined();
  });

  it('throws WorkspaceRuntimeGoneError on 404', async () => {
    routeFetch([['POST', '/sandboxes/sb-1/pause', [res(404, { message: 'gone' })]]]);
    const service = new E2bRuntimeService(baseConfig);

    await expect(service.suspend(state, { retainForMs: 120_000 })).rejects.toBeInstanceOf(WorkspaceRuntimeGoneError);
  });
});

describe('renewLease', () => {
  it('resets the TTL from now', async () => {
    routeFetch([['POST', '/sandboxes/sb-1/timeout', [res(204)]]]);
    const service = new E2bRuntimeService(baseConfig);

    await service.renewLease(state);

    const [, init] = callsMatching('POST', '/timeout')[0];
    expect(JSON.parse(init?.body as string)).toEqual({ timeout: 3600 });
  });

  it('is a no-op when the timeout is disabled', async () => {
    const service = new E2bRuntimeService({ ...baseConfig, timeoutSeconds: null });

    await service.renewLease(state);

    expect(harness.fetch()).not.toHaveBeenCalled();
  });

  it('swallows API failures and logs a warning', async () => {
    routeFetch([['POST', '/sandboxes/sb-1/timeout', [res(500, { message: 'api down' })]]]);
    const service = new E2bRuntimeService(baseConfig);

    await expect(service.renewLease(state)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe('destroy and endpoints', () => {
  it('tolerates 404 on destroy', async () => {
    routeFetch([['DELETE', '/sandboxes/sb-1', [res(404, { message: 'gone' })]]]);
    const service = new E2bRuntimeService(baseConfig);

    await expect(service.destroy(state)).resolves.toBeUndefined();
  });

  it('returns without throwing when provider state was never populated', async () => {
    const service = new E2bRuntimeService(baseConfig);

    await expect(service.destroy({})).resolves.toBeUndefined();
    await expect(service.destroy(null)).resolves.toBeUndefined();
  });

  it('resolves gateway/editor endpoints with the traffic token header', () => {
    const service = new E2bRuntimeService(baseConfig);

    expect(service.resolveGatewayEndpoint(state)).toEqual({
      url: 'https://13338-sb-1.e2b.app',
      headers: { 'e2b-traffic-access-token': 'traffic-tok' },
    });
    expect(service.resolveEditorEndpoint(state)).toBeNull();
    expect(service.resolveEditorEndpoint({ ...state, editorUrl: 'https://13337-sb-1.e2b.app' })).toEqual({
      url: 'https://13337-sb-1.e2b.app',
      headers: { 'e2b-traffic-access-token': 'traffic-tok' },
    });
  });
});

describe('listE2bWorkspaceSources', () => {
  const config = {
    provider: 'lifecycle_kubernetes',
    e2b: baseConfig,
  } as unknown as Parameters<typeof listE2bWorkspaceSources>[0];

  it('prefers the durable alias over the rotating template id and sorts ready first', async () => {
    routeFetch([
      [
        'GET',
        '/templates',
        [
          res(200, [
            { templateID: 'tpl-2', names: ['zeta'], buildStatus: 'building' },
            {
              templateID: 'tpl-1',
              aliases: ['lifecycle-workspace'],
              buildStatus: 'ready',
              cpuCount: 2,
              memoryMB: 4096,
            },
            { templateID: 'tpl-3', buildStatus: 'ready' },
          ]),
        ],
      ],
    ]);

    await expect(listE2bWorkspaceSources(config)).resolves.toEqual([
      { id: 'lifecycle-workspace', label: 'lifecycle-workspace', detail: '2 CPU · 4096 MB', ready: true },
      { id: 'tpl-3', label: 'tpl-3', detail: undefined, ready: true },
      { id: 'zeta', label: 'zeta', detail: undefined, ready: false },
    ]);
  });

  it('requires a configured API key', async () => {
    const keyless = { provider: 'lifecycle_kubernetes', e2b: {} } as unknown as Parameters<
      typeof listE2bWorkspaceSources
    >[0];
    await expect(listE2bWorkspaceSources(keyless)).rejects.toThrow('E2B API key is not configured.');
  });
});

describe('testE2bConnection', () => {
  const config = {
    provider: 'lifecycle_kubernetes',
    e2b: baseConfig,
  } as unknown as Parameters<typeof testE2bConnection>[0];

  it('verifies the key and the configured template', async () => {
    routeFetch([
      ['GET', '/v2/sandboxes', [res(200, [])]],
      [
        'GET',
        '/templates',
        [
          res(200, [
            { templateID: 'tpl-1', names: ['lifecycle-workspace'], buildStatus: 'ready', cpuCount: 2, memoryMB: 4096 },
          ]),
        ],
      ],
    ]);

    await expect(testE2bConnection(config)).resolves.toEqual({
      ok: true,
      message: 'E2B connection verified.',
      details: { templateId: 'lifecycle-workspace', buildStatus: 'ready', cpuCount: 2, memoryMB: 4096 },
    });
  });

  it('reports a rejected API key', async () => {
    routeFetch([['GET', '/v2/sandboxes', [res(401, { message: 'invalid api key' })]]]);

    await expect(testE2bConnection(config)).resolves.toEqual({
      ok: false,
      message: 'E2B rejected the configured API key.',
    });
  });

  it('reports a missing or unbuilt template', async () => {
    routeFetch([
      ['GET', '/v2/sandboxes', [res(200, [])]],
      ['GET', '/templates', [res(200, [{ templateID: 'tpl-2', names: ['other'], buildStatus: 'ready' }])]],
    ]);

    await expect(testE2bConnection(config)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('was not found'),
    });
  });

  it('scrubs the API key from error messages', async () => {
    routeFetch([['GET', '/v2/sandboxes', [res(500, { message: 'boom token e2b-test-key leaked' })]]]);

    const result = await testE2bConnection(config);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('e2b-test-key');
    expect(result.message).toContain('[redacted]');
  });

  it('fails fast without credentials', async () => {
    await expect(
      testE2bConnection({ e2b: { ...baseConfig, apiKey: undefined } } as unknown as Parameters<
        typeof testE2bConnection
      >[0])
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('API key') });
    expect(harness.fetch()).not.toHaveBeenCalled();
  });
});
