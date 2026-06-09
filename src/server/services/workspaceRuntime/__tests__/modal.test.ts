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

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    warn: jest.fn(),
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
import type { ResolvedAgentSessionModalBackendConfig } from 'server/lib/agentSession/runtimeConfig';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import {
  WorkspaceRuntimeGoneError,
  WorkspaceRuntimeSecurityError,
  type RemoteWorkspaceRuntimeProvider,
} from '../types';
import {
  ModalRuntimeService,
  readModalProviderState,
  testModalConnection,
  type ModalRuntimeProviderState,
} from '../providers/modal';

// Static import resolves to the manual mock (__mocks__/modal.ts) through the same jest module
// registry entry the provider's transpiled dynamic import('modal') hits — proving interception.
import * as modalSdkMock from 'modal';

const { modalMocks } = modalSdkMock as unknown as { modalMocks: Record<string, jest.Mock> };
const { NotFoundError } = modalSdkMock;

const baseConfig: ResolvedAgentSessionModalBackendConfig = {
  tokenId: 'ak-test-token-id',
  tokenSecret: 'as-test-token-secret',
  appName: 'lifecycle-workspaces',
  image: 'lifecycleoss/workspace:1.2.3',
  timeoutSeconds: 14400,
  gatewayPort: 13338,
};

const runningState: ModalRuntimeProviderState = {
  appName: 'lifecycle-workspaces',
  sandboxId: 'sb-1',
  snapshotImageId: 'im-old',
  gatewayUrl: 'https://old.modal.host',
  createdAt: '2026-06-09T00:00:00.000Z',
  timeoutMs: 14400000,
  gatewayToken: 'enc:old-token',
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

function fakeSandbox(sandboxId: string, overrides: Record<string, unknown> = {}) {
  return {
    sandboxId,
    waitUntilReady: jest.fn().mockResolvedValue(undefined),
    tunnels: jest.fn().mockResolvedValue({ 13338: { url: `https://${sandboxId}.modal.host` } }),
    snapshotFilesystem: jest.fn(),
    terminate: jest.fn().mockResolvedValue(undefined),
    poll: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(modalMocks)) {
    mock.mockReset();
  }
});

describe('readModalProviderState', () => {
  it('round-trips a fully populated state', () => {
    expect(readModalProviderState(runningState)).toEqual(runningState);
  });

  it.each([
    ['null', null],
    ['missing appName', { sandboxId: 'sb-1' }],
  ])('returns null for %s', (_label, value) => {
    expect(readModalProviderState(value)).toBeNull();
  });

  it('drops nulled-out keys from suspended states', () => {
    const parsed = readModalProviderState({
      appName: 'lifecycle-workspaces',
      sandboxId: null,
      gatewayUrl: null,
      snapshotImageId: 'im-snap',
    });

    expect(parsed).toEqual({ appName: 'lifecycle-workspaces', snapshotImageId: 'im-snap' });
  });
});

describe('provision', () => {
  it('creates a gateway-only sandbox with explicit lifetime and verifies gateway auth both ways', async () => {
    modalMocks.appsFromName.mockResolvedValue({ appId: 'ap-1' });
    modalMocks.imagesFromRegistry.mockReturnValue({ imageId: 'im-base' });
    const sb = fakeSandbox('sb-new');
    modalMocks.sandboxesCreate.mockResolvedValue(sb);
    routeFetch([
      ['GET', 'sb-new.modal.host/health', [res(200, 'ok')]],
      ['POST', 'sb-new.modal.host/mcp', [res(401, { error: 'Unauthorized' }), res(200, {})]],
    ]);
    const service = new ModalRuntimeService(baseConfig);

    const handle = await service.provision({ plan, readiness, gatewayToken: 'plain-token' });

    expect(modalMocks.clientCtor).toHaveBeenCalledWith({
      tokenId: 'ak-test-token-id',
      tokenSecret: 'as-test-token-secret',
    });
    expect(modalMocks.appsFromName).toHaveBeenCalledWith('lifecycle-workspaces', { createIfMissing: true });
    expect(modalMocks.imagesFromRegistry).toHaveBeenCalledWith('lifecycleoss/workspace:1.2.3', undefined);

    const [, , params] = modalMocks.sandboxesCreate.mock.calls[0];
    expect(params).toMatchObject({
      timeoutMs: 14400000,
      encryptedPorts: [13338],
      readinessProbe: { kind: 'tcp', port: 13338 },
      tags: { lifecycleSessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    });
    expect(params.env.LIFECYCLE_GATEWAY_TOKEN).toBe('plain-token');
    expect(params.env.ANTHROPIC_API_KEY).toBe('provider-key');
    const script = params.command[2] as string;
    expect(params.command[0]).toBe('/bin/sh');
    expect(script).toContain('exec node /opt/lifecycle-workspace-gateway/index.mjs');
    expect(script).toContain('/opt/lifecycle/bootstrap.sh');
    // The snapshot env file persisted to disk must never contain the gateway token or session secrets.
    expect(script).not.toContain('plain-token');
    expect(script).not.toContain(Buffer.from('plain-token').toString('base64'));
    expect(script).not.toContain('provider-key');
    expect(script).not.toContain(Buffer.from('provider-key').toString('base64'));
    // Session secrets are persisted encrypted in providerState for snapshot-recreate resumes.
    expect(handle.providerState.sessionSecretEnv).toEqual(expect.stringContaining('enc:'));
    expect(handle.providerState.sessionSecretEnv as string).toContain('provider-key');

    const mcpCalls = callsMatching('POST', 'sb-new.modal.host/mcp');
    expect(mcpCalls).toHaveLength(2);
    const [, probeInit] = mcpCalls[0];
    expect(probeInit?.headers).not.toHaveProperty('Authorization');
    const [, acceptedProbeInit] = mcpCalls[1];
    expect(acceptedProbeInit?.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer plain-token',
        'x-lifecycle-gateway-token': 'plain-token',
      })
    );

    expect(handle.podNameAlias).toBe('sb-new');
    expect(handle.providerState).toMatchObject({
      appName: 'lifecycle-workspaces',
      sandboxId: 'sb-new',
      imageId: 'im-base',
      timeoutMs: 14400000,
      gatewayUrl: 'https://sb-new.modal.host',
    });
    expect(handle.providerState.createdAt).toEqual(expect.any(String));
    expect(handle.capabilitySnapshot).toMatchObject({ backend: 'modal', editorAccess: false });
    expect(modalMocks.clientClose).toHaveBeenCalled();
  });

  it('fails closed and terminates the sandbox when the gateway does not enforce the token', async () => {
    modalMocks.appsFromName.mockResolvedValue({ appId: 'ap-1' });
    modalMocks.imagesFromRegistry.mockReturnValue({ imageId: 'im-base' });
    const sb = fakeSandbox('sb-new');
    modalMocks.sandboxesCreate.mockResolvedValue(sb);
    routeFetch([
      ['GET', 'sb-new.modal.host/health', [res(200, 'ok')]],
      ['POST', 'sb-new.modal.host/mcp', [res(200, {})]],
    ]);
    const service = new ModalRuntimeService(baseConfig);

    await expect(service.provision({ plan, readiness, gatewayToken: 'plain-token' })).rejects.toBeInstanceOf(
      WorkspaceRuntimeSecurityError
    );
    expect(sb.terminate).toHaveBeenCalled();
  });

  it('fails closed and terminates the sandbox when the configured token is rejected', async () => {
    modalMocks.appsFromName.mockResolvedValue({ appId: 'ap-1' });
    modalMocks.imagesFromRegistry.mockReturnValue({ imageId: 'im-base' });
    const sb = fakeSandbox('sb-new');
    modalMocks.sandboxesCreate.mockResolvedValue(sb);
    routeFetch([
      ['GET', 'sb-new.modal.host/health', [res(200, 'ok')]],
      ['POST', 'sb-new.modal.host/mcp', [res(401, { error: 'Unauthorized' }), res(403, {})]],
    ]);
    const service = new ModalRuntimeService(baseConfig);

    await expect(service.provision({ plan, readiness, gatewayToken: 'plain-token' })).rejects.toBeInstanceOf(
      WorkspaceRuntimeSecurityError
    );
    expect(sb.terminate).toHaveBeenCalled();
  });

  it('uses the configured registry secret for private images', async () => {
    modalMocks.appsFromName.mockResolvedValue({ appId: 'ap-1' });
    modalMocks.secretsFromName.mockResolvedValue({ secretId: 'sc-1' });
    modalMocks.imagesFromRegistry.mockReturnValue({ imageId: 'im-base' });
    const sb = fakeSandbox('sb-new');
    modalMocks.sandboxesCreate.mockResolvedValue(sb);
    routeFetch([
      ['GET', 'sb-new.modal.host/health', [res(200, 'ok')]],
      ['POST', 'sb-new.modal.host/mcp', [res(401, { error: 'Unauthorized' }), res(200, {})]],
    ]);
    const service = new ModalRuntimeService({ ...baseConfig, imageRegistrySecret: 'lifecycle-registry' });

    await service.provision({ plan, readiness, gatewayToken: 'plain-token' });

    expect(modalMocks.secretsFromName).toHaveBeenCalledWith('lifecycle-registry');
    expect(modalMocks.imagesFromRegistry).toHaveBeenCalledWith('lifecycleoss/workspace:1.2.3', { secretId: 'sc-1' });
  });
});

describe('suspend and checkpoint', () => {
  it('snapshots the filesystem before terminating and GCs the replaced snapshot', async () => {
    const sb = fakeSandbox('sb-1', {
      snapshotFilesystem: jest.fn().mockResolvedValue({ imageId: 'im-snap' }),
    });
    modalMocks.sandboxesFromId.mockResolvedValue(sb);
    modalMocks.imagesDelete.mockResolvedValue(undefined);
    const service = new ModalRuntimeService(baseConfig);

    const handle = await service.suspend(runningState, { retainForMs: 120_000 });

    expect(sb.snapshotFilesystem.mock.invocationCallOrder[0]).toBeLessThan(sb.terminate.mock.invocationCallOrder[0]);
    expect(modalMocks.imagesDelete).toHaveBeenCalledWith('im-old');
    expect(handle?.providerState).toMatchObject({
      appName: 'lifecycle-workspaces',
      sandboxId: null,
      gatewayUrl: null,
      snapshotImageId: 'im-snap',
      gatewayToken: 'enc:old-token',
    });
    expect(handle?.providerState.checkpointAt).toEqual(expect.any(String));
  });

  it('checkpoints without terminating and keeps the sandbox handle', async () => {
    const sb = fakeSandbox('sb-1', {
      snapshotFilesystem: jest.fn().mockResolvedValue({ imageId: 'im-ckpt' }),
    });
    modalMocks.sandboxesFromId.mockResolvedValue(sb);
    modalMocks.imagesDelete.mockResolvedValue(undefined);
    const service = new ModalRuntimeService(baseConfig);

    const handle = await service.checkpoint(runningState);

    expect(sb.terminate).not.toHaveBeenCalled();
    expect(modalMocks.imagesDelete).toHaveBeenCalledWith('im-old');
    expect(handle?.providerState).toMatchObject({ sandboxId: 'sb-1', snapshotImageId: 'im-ckpt' });
  });

  it('maps a missing sandbox to WorkspaceRuntimeGoneError on suspend', async () => {
    modalMocks.sandboxesFromId.mockRejectedValue(new NotFoundError('not found'));
    const service = new ModalRuntimeService(baseConfig);

    await expect(service.suspend(runningState, { retainForMs: 120_000 })).rejects.toBeInstanceOf(
      WorkspaceRuntimeGoneError
    );
  });
});

describe('resume', () => {
  it('recreates from the snapshot with a freshly minted provider-side token and a new tunnel', async () => {
    modalMocks.appsFromName.mockResolvedValue({ appId: 'ap-1' });
    modalMocks.imagesFromId.mockResolvedValue({ imageId: 'im-old' });
    const sb = fakeSandbox('sb-2');
    modalMocks.sandboxesCreate.mockResolvedValue(sb);
    routeFetch([
      ['GET', 'sb-2.modal.host/health', [res(200, 'ok')]],
      ['POST', 'sb-2.modal.host/mcp', [res(401, { error: 'Unauthorized' }), res(200, {})]],
    ]);
    const service = new ModalRuntimeService(baseConfig);

    const suspendedState = { ...runningState, sandboxId: undefined, gatewayUrl: undefined };
    const handle = await service.resume(suspendedState, readiness);

    expect(modalMocks.imagesFromId).toHaveBeenCalledWith('im-old');
    const [, , params] = modalMocks.sandboxesCreate.mock.calls[0];
    const mintedToken = params.env.LIFECYCLE_GATEWAY_TOKEN as string;
    expect(mintedToken).toMatch(/^[0-9a-f]{64}$/);
    const script = params.command[2] as string;
    expect(script).toContain('/opt/lifecycle/instance.env');
    expect(script).not.toContain('init-workspace');

    expect(handle.providerState).toMatchObject({
      sandboxId: 'sb-2',
      snapshotImageId: 'im-old',
      gatewayUrl: 'https://sb-2.modal.host',
      gatewayToken: `enc:${mintedToken}`,
    });
    expect(handle.providerState.gatewayToken).not.toBe('enc:old-token');
    const mcpCalls = callsMatching('POST', 'sb-2.modal.host/mcp');
    expect(mcpCalls).toHaveLength(2);
    const [, acceptedProbeInit] = mcpCalls[1];
    expect(acceptedProbeInit?.headers).toEqual(
      expect.objectContaining({
        Authorization: `Bearer ${mintedToken}`,
        'x-lifecycle-gateway-token': mintedToken,
      })
    );
  });

  it('re-injects decrypted session secrets as create-time env and carries the ciphertext forward', async () => {
    modalMocks.appsFromName.mockResolvedValue({ appId: 'ap-1' });
    modalMocks.imagesFromId.mockResolvedValue({ imageId: 'im-old' });
    const sb = fakeSandbox('sb-2');
    modalMocks.sandboxesCreate.mockResolvedValue(sb);
    routeFetch([
      ['GET', 'sb-2.modal.host/health', [res(200, 'ok')]],
      ['POST', 'sb-2.modal.host/mcp', [res(401, { error: 'Unauthorized' }), res(200, {})]],
    ]);
    const service = new ModalRuntimeService(baseConfig);

    const suspendedState = {
      ...runningState,
      sandboxId: undefined,
      gatewayUrl: undefined,
      sessionSecretEnv: `enc:${JSON.stringify({ GITHUB_TOKEN: 'gh-secret', ANTHROPIC_API_KEY: 'provider-key' })}`,
    };
    const handle = await service.resume(suspendedState, readiness);

    const [, , params] = modalMocks.sandboxesCreate.mock.calls[0];
    expect(params.env.GITHUB_TOKEN).toBe('gh-secret');
    expect(params.env.ANTHROPIC_API_KEY).toBe('provider-key');
    // The recreated sandbox does not re-bootstrap; secrets are not re-baked into the snapshot file.
    const script = params.command[2] as string;
    expect(script).not.toContain('gh-secret');
    expect(handle.providerState.sessionSecretEnv).toBe(suspendedState.sessionSecretEnv);
  });

  it('fails closed when the recreated gateway does not enforce the fresh token', async () => {
    modalMocks.appsFromName.mockResolvedValue({ appId: 'ap-1' });
    modalMocks.imagesFromId.mockResolvedValue({ imageId: 'im-old' });
    const sb = fakeSandbox('sb-2');
    modalMocks.sandboxesCreate.mockResolvedValue(sb);
    routeFetch([
      ['GET', 'sb-2.modal.host/health', [res(200, 'ok')]],
      ['POST', 'sb-2.modal.host/mcp', [res(200, {})]],
    ]);
    const service = new ModalRuntimeService(baseConfig);

    await expect(service.resume({ ...runningState, sandboxId: undefined }, readiness)).rejects.toBeInstanceOf(
      WorkspaceRuntimeSecurityError
    );
    expect(sb.terminate).toHaveBeenCalled();
  });

  it('maps a missing snapshot to WorkspaceRuntimeGoneError', async () => {
    const service = new ModalRuntimeService(baseConfig);

    await expect(
      service.resume({ appName: 'lifecycle-workspaces', sandboxId: 'sb-1' }, readiness)
    ).rejects.toBeInstanceOf(WorkspaceRuntimeGoneError);

    modalMocks.imagesFromId.mockRejectedValue(new NotFoundError('image gone'));
    await expect(
      service.resume({ appName: 'lifecycle-workspaces', snapshotImageId: 'im-gone' }, readiness)
    ).rejects.toBeInstanceOf(WorkspaceRuntimeGoneError);
  });
});

describe('reattach', () => {
  it('re-verifies a running sandbox', async () => {
    const sb = fakeSandbox('sb-1');
    modalMocks.sandboxesFromId.mockResolvedValue(sb);
    routeFetch([
      ['GET', 'sb-1.modal.host/health', [res(200, 'ok')]],
      ['POST', 'sb-1.modal.host/mcp', [res(401, { error: 'Unauthorized' }), res(200, {})]],
    ]);
    const service = new ModalRuntimeService(baseConfig);

    const handle = await service.reattach(runningState, readiness);

    expect(handle?.providerState).toMatchObject({ sandboxId: 'sb-1', gatewayUrl: 'https://sb-1.modal.host' });
    expect(modalMocks.sandboxesCreate).not.toHaveBeenCalled();
    const mcpCalls = callsMatching('POST', 'sb-1.modal.host/mcp');
    expect(mcpCalls).toHaveLength(2);
    const [, acceptedProbeInit] = mcpCalls[1];
    expect(acceptedProbeInit?.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer old-token',
        'x-lifecycle-gateway-token': 'old-token',
      })
    );
  });

  it('resumes from the snapshot when the sandbox is gone but the snapshot survives', async () => {
    modalMocks.sandboxesFromId.mockRejectedValue(new NotFoundError('sandbox gone'));
    modalMocks.appsFromName.mockResolvedValue({ appId: 'ap-1' });
    modalMocks.imagesFromId.mockResolvedValue({ imageId: 'im-old' });
    const sb = fakeSandbox('sb-2');
    modalMocks.sandboxesCreate.mockResolvedValue(sb);
    routeFetch([
      ['GET', 'sb-2.modal.host/health', [res(200, 'ok')]],
      ['POST', 'sb-2.modal.host/mcp', [res(401, { error: 'Unauthorized' }), res(200, {})]],
    ]);
    const service = new ModalRuntimeService(baseConfig);

    const handle = await service.reattach(runningState, readiness);

    expect(handle?.providerState).toMatchObject({ sandboxId: 'sb-2', snapshotImageId: 'im-old' });
  });

  it('falls through to the snapshot when the sandbox finished (24h wall)', async () => {
    const finished = fakeSandbox('sb-1', { poll: jest.fn().mockResolvedValue(137) });
    modalMocks.sandboxesFromId.mockResolvedValue(finished);
    modalMocks.appsFromName.mockResolvedValue({ appId: 'ap-1' });
    modalMocks.imagesFromId.mockResolvedValue({ imageId: 'im-old' });
    const sb = fakeSandbox('sb-2');
    modalMocks.sandboxesCreate.mockResolvedValue(sb);
    routeFetch([
      ['GET', 'sb-2.modal.host/health', [res(200, 'ok')]],
      ['POST', 'sb-2.modal.host/mcp', [res(401, { error: 'Unauthorized' }), res(200, {})]],
    ]);
    const service = new ModalRuntimeService(baseConfig);

    const handle = await service.reattach(runningState, readiness);

    expect(handle?.providerState.sandboxId).toBe('sb-2');
  });

  it('returns null only when neither the sandbox nor a snapshot exists', async () => {
    modalMocks.sandboxesFromId.mockRejectedValue(new NotFoundError('sandbox gone'));
    const service = new ModalRuntimeService(baseConfig);

    await expect(
      service.reattach({ appName: 'lifecycle-workspaces', sandboxId: 'sb-1' }, readiness)
    ).resolves.toBeNull();

    modalMocks.imagesFromId.mockRejectedValue(new NotFoundError('image gone'));
    await expect(service.reattach(runningState, readiness)).resolves.toBeNull();
  });
});

describe('destroy and endpoints', () => {
  it('terminates and GCs the snapshot best-effort', async () => {
    const sb = fakeSandbox('sb-1');
    modalMocks.sandboxesFromId.mockResolvedValue(sb);
    modalMocks.imagesDelete.mockRejectedValue(new Error('gc failed'));
    const service = new ModalRuntimeService(baseConfig);

    await expect(service.destroy(runningState)).resolves.toBeUndefined();
    expect(sb.terminate).toHaveBeenCalled();
    expect(modalMocks.imagesDelete).toHaveBeenCalledWith('im-old');
  });

  it('tolerates an already-gone sandbox on destroy', async () => {
    modalMocks.sandboxesFromId.mockRejectedValue(new NotFoundError('gone'));
    modalMocks.imagesDelete.mockResolvedValue(undefined);
    const service = new ModalRuntimeService(baseConfig);

    await expect(service.destroy(runningState)).resolves.toBeUndefined();
  });

  it('returns without throwing when provider state was never populated', async () => {
    const service = new ModalRuntimeService(baseConfig);

    await expect(service.destroy({})).resolves.toBeUndefined();
    await expect(service.destroy(null)).resolves.toBeUndefined();
    expect(modalMocks.sandboxesFromId).not.toHaveBeenCalled();
  });

  it('resolves the gateway endpoint without backend headers', () => {
    const service = new ModalRuntimeService(baseConfig);

    expect(service.resolveGatewayEndpoint(runningState)).toEqual({ url: 'https://old.modal.host' });
    expect(service.resolveEditorEndpoint(runningState)).toBeNull();
    expect((service as RemoteWorkspaceRuntimeProvider).renewLease).toBeUndefined();
  });
});

describe('testModalConnection', () => {
  const config = {
    provider: 'lifecycle_kubernetes',
    modal: baseConfig,
  } as unknown as Parameters<typeof testModalConnection>[0];

  it('verifies credentials via app lookup', async () => {
    modalMocks.appsFromName.mockResolvedValue({ appId: 'ap-1' });

    await expect(testModalConnection(config)).resolves.toEqual({
      ok: true,
      message: 'Modal connection verified.',
      details: { appName: 'lifecycle-workspaces', image: 'lifecycleoss/workspace:1.2.3' },
    });
    expect(modalMocks.clientClose).toHaveBeenCalled();
  });

  it('reports rejected credentials', async () => {
    modalMocks.appsFromName.mockRejectedValue(new Error('ClientError: /ModalClient/AppGetOrCreate UNAUTHENTICATED'));

    await expect(testModalConnection(config)).resolves.toEqual({
      ok: false,
      message: 'Modal rejected the configured token credentials.',
    });
  });

  it('scrubs both token secrets from error messages', async () => {
    modalMocks.appsFromName.mockRejectedValue(new Error('boom ak-test-token-id and as-test-token-secret leaked'));

    const result = await testModalConnection(config);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('ak-test-token-id');
    expect(result.message).not.toContain('as-test-token-secret');
    expect(result.message).toContain('[redacted]');
  });

  it('fails fast without credentials', async () => {
    await expect(
      testModalConnection({ modal: { ...baseConfig, tokenSecret: undefined } } as unknown as Parameters<
        typeof testModalConnection
      >[0])
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('token credentials') });
    expect(modalMocks.clientCtor).not.toHaveBeenCalled();
  });
});
