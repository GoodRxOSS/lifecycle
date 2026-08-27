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

const mockDebug = jest.fn();
const mockWarn = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    warn: mockWarn,
    info: jest.fn(),
    debug: mockDebug,
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
  createOpenSandboxRuntimeService,
  readOpenSandboxProviderState,
  testOpenSandboxConnection,
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

const provisionPlan = {
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

function streamResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

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
      primaryRepoPath: '/workspace/repos/example',
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

describe('public provider contracts', () => {
  it('rejects provisioning before network access when the workspace image is missing', async () => {
    const service = new OpenSandboxRuntimeService({ ...baseConfig, image: undefined });

    await expect(service.provision({ plan: provisionPlan, readiness })).rejects.toThrow(
      'OpenSandbox workspace backend requires an image.'
    );
    expect(harness.fetch()).not.toHaveBeenCalled();
  });

  it.each([
    ['resume', (service: OpenSandboxRuntimeService) => service.resume({ bogus: true }, readiness)],
    ['suspend', (service: OpenSandboxRuntimeService) => service.suspend(null, { retainForMs: 60_000 })],
  ])('requires persisted provider state to %s', async (_operation, invoke) => {
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(invoke(service)).rejects.toThrow('OpenSandbox provider state is missing required fields');
    expect(harness.fetch()).not.toHaveBeenCalled();
  });

  it('reports persisted handles and state-derived capabilities', () => {
    const service = new OpenSandboxRuntimeService(baseConfig);

    expect(service.hasPersistedHandle(state)).toBe(true);
    expect(service.hasPersistedHandle({ sandboxId: 'incomplete' })).toBe(false);
    expect(service.capabilities()).toMatchObject({ backend: 'opensandbox', editorAccess: false });
    expect(service.capabilities({ ...state, editorUrl: 'https://editor.example.com' })).toMatchObject({
      backend: 'opensandbox',
      editorAccess: true,
    });
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

  it('does not duplicate /v1 or send an auth header for a keyless fully-qualified domain', async () => {
    routeFetch([['DELETE', '/sandboxes/sb-1', [res(200, {})]]]);
    const service = new OpenSandboxRuntimeService({
      ...baseConfig,
      domain: 'https://sandbox.example.com/v1/',
      apiKey: undefined,
    });

    await service.destroy(state);

    expect(harness.fetch()).toHaveBeenCalledWith('https://sandbox.example.com/v1/sandboxes/sb-1', {
      method: 'DELETE',
      headers: {},
    });
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

describe('provision', () => {
  it('creates, prepares, and cold-starts a pooled sandbox from streamed command events', async () => {
    const plan = {
      ...provisionPlan,
      credentials: { hasGitHubToken: true, githubToken: 'github-token' },
      skillPlan: {
        version: 1 as const,
        skills: [
          {
            repo: 'example/skills',
            repoUrl: 'https://github.com/example/skills.git',
            branch: 'main',
            path: 'skills/sample',
            source: 'environment' as const,
          },
        ],
      },
    } as WorkspaceRuntimePlan;
    routeFetch([
      ['POST', '/files/upload', [res(200, {})]],
      [
        'POST',
        'execd.example.com/command',
        [
          streamResponse(
            ': keepalive\nevent: message\nid: ignored\n\n',
            'data:\nnot-json\n',
            'data: {"type":"init","text":"prepare-cmd"}\n',
            '{"type":"stdout"}\n{"type":"stderr"}\n{"type":"noop"}'
          ),
          streamResponse(''),
          streamResponse('not-json'),
          streamResponse('{"type":"noop"}'),
          streamResponse('data: {"type":"init","text":"gateway-cmd"}\n'),
          streamResponse('data: {"type":"init","text":"editor-cmd"}'),
        ],
      ],
      ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
      ['GET', 'gw.example.com/health', [res(503, 'starting'), res(200, 'ok')]],
      ['GET', 'editor.example.com/healthz', [res(503, 'starting'), res(200, 'ok')]],
      [
        'GET',
        '/endpoints/9001?use_server_proxy=true',
        [res(200, { endpoint: 'execd.example.com', headers: { 'x-execd-token': 'execd-token' } })],
      ],
      [
        'GET',
        '/endpoints/8989?use_server_proxy=true',
        [res(200, { endpoint: 'gw.example.com', headers: { 'x-gateway-token': 'gateway-token' } })],
      ],
      [
        'GET',
        '/endpoints/8443?use_server_proxy=true',
        [res(200, { endpoint: 'https://editor.example.com', headers: { 'x-editor-token': 'editor-token' } })],
      ],
      ['POST', '/sandboxes', [res(200, { id: 'sb-new' })]],
      ['GET', '/sandboxes/sb-new', [res(200, { id: 'sb-new', status: { state: 'Running' } })]],
    ]);
    const service = new OpenSandboxRuntimeService({
      ...baseConfig,
      timeoutSeconds: 600,
      poolRef: 'warm-pool',
      useServerProxy: true,
      resourceLimits: { cpu: '2', memory: '4Gi' },
    });

    const handle = await service.provision({
      plan,
      readiness,
      userIdentity: null,
      installCommand: 'pnpm install',
    });

    expect(handle).toMatchObject({
      podNameAlias: 'sb-new',
      capabilitySnapshot: { backend: 'opensandbox', editorAccess: true },
      providerState: {
        sandboxId: 'sb-new',
        lifecycleBaseUrl: 'https://sandbox.example.com/v1',
        execdBaseUrl: 'https://execd.example.com',
        execdHeaders: { 'x-execd-token': 'execd-token' },
        gatewayUrl: 'https://gw.example.com',
        gatewayHeaders: { 'x-gateway-token': 'gateway-token' },
        gatewayCommandId: 'gateway-cmd',
        editorUrl: 'https://editor.example.com',
        editorHeaders: { 'x-editor-token': 'editor-token' },
        editorCommandId: 'editor-cmd',
      },
    });

    const [, createInit] = callsMatching('POST', '/sandboxes')[0];
    const createBody = JSON.parse(createInit?.body as string);
    expect(createBody).toMatchObject({
      image: { uri: 'workspace:latest' },
      entrypoint: ['tail', '-f', '/dev/null'],
      resourceLimits: { cpu: '2', memory: '4Gi' },
      secureAccess: true,
      extensions: { poolRef: 'warm-pool' },
      timeout: 600,
      metadata: {
        name: 'lifecycle-aaaaaaaa',
        lifecycleSession: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        lifecycleKind: 'chat',
      },
    });
    expect(createBody.env).toEqual(
      expect.objectContaining({
        ANTHROPIC_API_KEY: 'provider-key',
        GITHUB_TOKEN: 'github-token',
        GH_TOKEN: 'github-token',
      })
    );

    const commandBodies = callsMatching('POST', 'execd.example.com/command').map(([, init]) =>
      JSON.parse(init?.body as string)
    );
    expect(commandBodies).toHaveLength(6);
    expect(commandBodies.some(({ command }) => command.includes('skills-bootstrap.mjs'))).toBe(true);
    expect(
      commandBodies.find(({ command }) => command.includes('exec node /opt/lifecycle-workspace-gateway/index.mjs'))
    ).toMatchObject({
      background: true,
      cwd: '/workspace',
    });
    expect(commandBodies.find(({ command }) => command.includes('code-server'))).toMatchObject({
      background: true,
      cwd: '/workspace',
    });

    const uploadCalls = callsMatching('POST', '/files/upload');
    expect(uploadCalls).toHaveLength(3);
    expect(uploadCalls[0][1]?.headers).toEqual(
      expect.objectContaining({
        'OPEN-SANDBOX-API-KEY': 'test-api-key',
        'x-execd-token': 'execd-token',
      })
    );
    const uploadMetadata = await Promise.all(
      uploadCalls.map(async ([, init]) => JSON.parse(await ((init?.body as FormData).get('metadata') as Blob).text()))
    );
    expect(uploadMetadata).toEqual(
      expect.arrayContaining([
        { path: '/tmp/lifecycle-init-workspace.sh', mode: 700 },
        { path: '/tmp/lifecycle-runtime-seed.sh', mode: 700 },
        expect.objectContaining({ mode: 644 }),
      ])
    );
  });

  it.each([
    ['an empty object', {}],
    ['an empty response', undefined],
  ])('rejects a create response containing %s before attempting cleanup', async (_label, createResponse) => {
    routeFetch([['POST', '/sandboxes', [res(200, createResponse)]]]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.provision({ plan: provisionPlan, readiness })).rejects.toThrow(
      'OpenSandbox create failed: missing sandbox id'
    );
    expect(callsMatching('DELETE', '/sandboxes')).toHaveLength(0);
  });

  it.each([
    ['an empty object', {}],
    ['an empty response', undefined],
  ])('cleans up when endpoint discovery returns %s', async (_label, endpointResponse) => {
    routeFetch([
      ['DELETE', '/sandboxes/sb-new', [res(200, {})]],
      ['POST', '/sandboxes', [res(200, { id: 'sb-new' })]],
      ['GET', '/sandboxes/sb-new/endpoints/9001', [res(200, endpointResponse)]],
      ['GET', '/sandboxes/sb-new', [res(200, { id: 'sb-new', status: { state: 'Running' } })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.provision({ plan: provisionPlan, readiness })).rejects.toThrow(
      'OpenSandbox endpoint resolution failed for port 9001: missing endpoint'
    );
    expect(callsMatching('DELETE', '/sandboxes/sb-new')).toHaveLength(1);
  });

  it('maps a workspace upload failure and deletes the created sandbox', async () => {
    routeFetch([
      ['POST', '/files/upload', [res(413, { message: 'file too large' })]],
      ['POST', 'execd.example.com/command', [streamResponse('')]],
      ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
      ['GET', '/endpoints/9001', [res(200, { endpoint: 'execd.example.com' })]],
      ['DELETE', '/sandboxes/sb-new', [res(200, {})]],
      ['POST', '/sandboxes', [res(200, { id: 'sb-new' })]],
      ['GET', '/sandboxes/sb-new', [res(200, { id: 'sb-new', status: { state: 'Running' } })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const error = await service.provision({ plan: provisionPlan, readiness }).catch((caught) => caught);

    expect(error).toBeInstanceOf(OpenSandboxApiError);
    expect(error).toMatchObject({ status: 413, provider: 'opensandbox' });
    expect(error.message).toBe('OpenSandbox file upload failed: file too large (status=413)');
    expect(callsMatching('DELETE', '/sandboxes/sb-new')).toHaveLength(1);
  });

  it('maps a command HTTP failure and deletes the created sandbox', async () => {
    routeFetch([
      ['POST', 'execd.example.com/command', [res(500, { error: { message: 'execd unavailable' } })]],
      ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
      ['GET', '/endpoints/9001', [res(200, { endpoint: 'execd.example.com' })]],
      ['DELETE', '/sandboxes/sb-new', [res(200, {})]],
      ['POST', '/sandboxes', [res(200, { id: 'sb-new' })]],
      ['GET', '/sandboxes/sb-new', [res(200, { id: 'sb-new', status: { state: 'Running' } })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const error = await service.provision({ plan: provisionPlan, readiness }).catch((caught) => caught);

    expect(error).toBeInstanceOf(OpenSandboxApiError);
    expect(error.message).toBe('OpenSandbox command failed: execd unavailable (status=500)');
    expect(callsMatching('DELETE', '/sandboxes/sb-new')).toHaveLength(1);
  });

  it.each([
    ['evalue', { evalue: 'process exited 9' }, 'process exited 9'],
    ['value', { value: 'process exited 8' }, 'process exited 8'],
    ['message', { message: 'process exited 7' }, 'process exited 7'],
    ['missing SDK detail', {}, 'command failed'],
    ['missing error object', undefined, 'command failed', false],
  ])(
    'preserves a streamed command error from %s and keeps cleanup best-effort',
    async (_label, detail, message, includeOutput = true) => {
      routeFetch([
        [
          'POST',
          'execd.example.com/command',
          [
            streamResponse(
              includeOutput ? 'data: {"type":"stderr","text":" stderr output "}\n' : '',
              includeOutput ? 'data: {"type":"stdout","text":"stdout output"}\n' : '',
              `data: ${JSON.stringify({ type: 'error', error: detail })}\n`
            ),
          ],
        ],
        ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
        ['GET', '/endpoints/9001', [res(200, { endpoint: 'execd.example.com' })]],
        ['DELETE', '/sandboxes/sb-new', [res(500, { message: 'cleanup failed' })]],
        ['POST', '/sandboxes', [res(200, { id: 'sb-new' })]],
        ['GET', '/sandboxes/sb-new', [res(200, { id: 'sb-new', status: { state: 'Running' } })]],
      ]);
      const service = new OpenSandboxRuntimeService(baseConfig);

      await expect(service.provision({ plan: provisionPlan, readiness })).rejects.toThrow(
        `OpenSandbox command failed (${message})${includeOutput ? ': stderr output stdout output' : ''}`
      );
      expect(callsMatching('DELETE', '/sandboxes/sb-new')).toHaveLength(1);
    }
  );
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

  it('throws immediately when the sandbox enters Terminated without an upstream message', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/resume', [res(200, {})]],
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', status: { state: 'Terminated' } })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.resume(state, readiness)).rejects.toThrow(
      'OpenSandbox sandbox sb-1 entered Terminated while waiting for Running'
    );
  });

  it('reports the last observed state and reason when readiness times out', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/resume', [res(200, {})]],
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', status: { state: 'Pending', reason: 'scheduling' } })]],
    ]);
    const now = jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValue(1002);
    const service = new OpenSandboxRuntimeService(baseConfig);

    try {
      await expect(service.resume(state, { timeoutMs: 1, pollMs: 0 })).rejects.toThrow(
        'OpenSandbox sandbox sb-1 did not become Running; last state=Pending: scheduling'
      );
    } finally {
      now.mockRestore();
    }
  });

  it('omits the message suffix when readiness times out without an upstream reason', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/resume', [res(200, {})]],
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', status: { state: 'Pending' } })]],
    ]);
    const now = jest.spyOn(Date, 'now').mockReturnValueOnce(2000).mockReturnValueOnce(2000).mockReturnValue(2002);
    const service = new OpenSandboxRuntimeService(baseConfig);

    try {
      await expect(service.resume(state, { timeoutMs: 1, pollMs: 0 })).rejects.toThrow(
        'OpenSandbox sandbox sb-1 did not become Running; last state=Pending'
      );
    } finally {
      now.mockRestore();
    }
  });

  it('restarts a missing gateway with the persisted primary repository path', async () => {
    routeFetch([
      ['POST', '/sandboxes/sb-1/resume', [res(200, {})]],
      ['POST', 'execd.example.com/command', [streamResponse('data: {"type":"init","text":"gateway-cmd"}\n')]],
      ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
      ['GET', 'gw.example.com/health', [res(503, 'starting'), res(200, 'ok')]],
      ['GET', '/endpoints/9001', [res(200, { endpoint: 'execd.example.com' })]],
      ['GET', '/endpoints/8989', [res(200, { endpoint: 'gw.example.com' })]],
      ['GET', '/endpoints/8443', [res(404, { message: 'no editor' })]],
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', status: { state: 'Running' } })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const handle = await service.resume({ ...state, primaryRepoPath: '/workspace/repos/primary' }, readiness);

    expect(handle.providerState).toMatchObject({
      primaryRepoPath: '/workspace/repos/primary',
      gatewayCommandId: 'gateway-cmd',
    });
    const [, commandInit] = callsMatching('POST', 'execd.example.com/command')[0];
    const command = JSON.parse(commandInit?.body as string).command as string;
    expect(command).toContain("export LIFECYCLE_SESSION_PRIMARY_REPO_PATH='/workspace/repos/primary'");
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

  it('keeps deletion best-effort for an unrecoverable sandbox', async () => {
    routeFetch([
      ['DELETE', '/sandboxes/sb-1', [res(500, { message: 'cleanup unavailable' })]],
      ['GET', '/sandboxes/sb-1', [res(200, { id: 'sb-1', status: { state: 'Failed' } })]],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.reattach(state, readiness)).resolves.toBeNull();
    expect(callsMatching('DELETE', '/sandboxes/sb-1')).toHaveLength(1);
  });

  it('returns null when the sandbox expires after the initial reattach lookup', async () => {
    routeFetch([
      [
        'GET',
        '/sandboxes/sb-1',
        [res(200, { id: 'sb-1', status: { state: 'Running' } }), res(404, { message: 'expired' })],
      ],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    await expect(service.reattach(state, readiness)).resolves.toBeNull();
    expect(callsMatching('GET', '/sandboxes/sb-1')).toHaveLength(4);
  });

  it('rethrows a non-gone endpoint failure after the initial reattach lookup', async () => {
    routeFetch([
      ['GET', '/endpoints/9001', [res(500, { message: 'endpoint service unavailable' })]],
      [
        'GET',
        '/sandboxes/sb-1',
        [
          res(200, { id: 'sb-1', status: { state: 'Running' } }),
          res(200, { id: 'sb-1', status: { state: 'Running' } }),
        ],
      ],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const error = await service.reattach(state, readiness).catch((caught) => caught);

    expect(error).toBeInstanceOf(OpenSandboxApiError);
    expect(error).toMatchObject({ status: 500, provider: 'opensandbox' });
    expect(error.message).toContain('endpoint service unavailable');
  });

  it('reattaches from an unknown status and records a cold editor without a command id', async () => {
    routeFetch([
      ['POST', 'execd.example.com/command', [streamResponse('')]],
      ['GET', 'execd.example.com/ping', [res(200, 'pong')]],
      ['GET', 'gw.example.com/health', [res(200, 'ok')]],
      ['GET', 'editor.example.com/healthz', [res(503, 'starting'), res(200, 'ok')]],
      ['GET', '/endpoints/9001', [res(200, { endpoint: 'execd.example.com' })]],
      ['GET', '/endpoints/8989', [res(200, { endpoint: 'gw.example.com' })]],
      ['GET', '/endpoints/8443', [res(200, { endpoint: 'editor.example.com' })]],
      [
        'GET',
        '/sandboxes/sb-1',
        [res(200, { id: 'sb-1' }), res(200, { id: 'sb-1' }), res(200, { id: 'sb-1', status: { state: 'Running' } })],
      ],
    ]);
    const service = new OpenSandboxRuntimeService(baseConfig);

    const handle = await service.reattach(state, readiness);

    expect(handle?.providerState).toMatchObject({
      gatewayUrl: 'https://gw.example.com',
      editorUrl: 'https://editor.example.com',
    });
    expect(handle?.providerState).not.toHaveProperty('editorCommandId');
    expect(callsMatching('POST', '/resume')).toHaveLength(0);
    expect(callsMatching('POST', 'execd.example.com/command')).toHaveLength(1);
  });

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
    expect(service.resolveEditorEndpoint({ bogus: true })).toBeNull();
  });

  it('omits endpoint headers when neither the backend nor endpoint needs them', () => {
    const keylessService = new OpenSandboxRuntimeService({ ...baseConfig, apiKey: undefined });

    expect(keylessService.resolveGatewayEndpoint({ ...state, gatewayUrl: 'https://gw.example.com' })).toEqual({
      url: 'https://gw.example.com',
    });
    expect(keylessService.resolveEditorEndpoint({ ...state, editorUrl: 'https://editor.example.com' })).toEqual({
      url: 'https://editor.example.com',
    });
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

describe('testOpenSandboxConnection', () => {
  it('lists sandboxes and reports the configured server, pool, and image', async () => {
    routeFetch([['GET', '/sandboxes', [res(200, [])]]]);
    const opensandbox = {
      ...baseConfig,
      domain: 'https://sandbox.example.com/v1/',
      poolRef: 'warm-pool',
    };
    const config = { provider: 'opensandbox', opensandbox } as unknown as Parameters<
      typeof testOpenSandboxConnection
    >[0];

    await expect(testOpenSandboxConnection(config)).resolves.toEqual({
      ok: true,
      message: 'Connected to OpenSandbox.',
      details: {
        server: 'https://sandbox.example.com/v1',
        pool: 'warm-pool',
        image: 'workspace:latest',
      },
    });
    expect(harness.fetch()).toHaveBeenCalledWith('https://sandbox.example.com/v1/sandboxes', {
      method: 'GET',
      headers: { 'OPEN-SANDBOX-API-KEY': 'test-api-key' },
    });
  });

  it('supports a keyless server without optional pool or image details', async () => {
    routeFetch([['GET', '/sandboxes', [res(200, [])]]]);
    const opensandbox = {
      ...baseConfig,
      domain: 'http://sandbox.example.com/api/',
      apiKey: undefined,
      image: undefined,
      poolRef: undefined,
    };
    const config = { provider: 'opensandbox', opensandbox } as unknown as Parameters<
      typeof testOpenSandboxConnection
    >[0];

    await expect(testOpenSandboxConnection(config)).resolves.toEqual({
      ok: true,
      message: 'Connected to OpenSandbox.',
      details: { server: 'http://sandbox.example.com/api/v1' },
    });
    expect(harness.fetch()).toHaveBeenCalledWith('http://sandbox.example.com/api/v1/sandboxes', {
      method: 'GET',
      headers: {},
    });
  });

  it('returns the provider API error when the sandbox list request fails', async () => {
    routeFetch([['GET', '/sandboxes', [res(503, { message: 'control plane unavailable' })]]]);
    const config = { provider: 'opensandbox', opensandbox: baseConfig } as unknown as Parameters<
      typeof testOpenSandboxConnection
    >[0];

    await expect(testOpenSandboxConnection(config)).resolves.toEqual({
      ok: false,
      message: 'OpenSandbox sandbox list failed: control plane unavailable (status=503)',
    });
  });

  it('normalizes a non-Error network rejection into the connection result', async () => {
    harness.fetch().mockRejectedValueOnce('network offline');
    const config = { provider: 'opensandbox', opensandbox: baseConfig } as unknown as Parameters<
      typeof testOpenSandboxConnection
    >[0];

    await expect(testOpenSandboxConnection(config)).resolves.toEqual({
      ok: false,
      message: 'network offline',
    });
  });
});

describe('createOpenSandboxRuntimeService', () => {
  it('logs the non-secret connection shape and returns an OpenSandbox provider', () => {
    mockDebug.mockClear();

    const service = createOpenSandboxRuntimeService(baseConfig);

    expect(service).toBeInstanceOf(OpenSandboxRuntimeService);
    expect(service.backendId).toBe('opensandbox');
    expect(mockDebug).toHaveBeenCalledWith(
      {
        domain: 'sandbox.example.com',
        protocol: 'https',
        useServerProxy: false,
      },
      'OpenSandbox: runtime service configured'
    );
  });
});
