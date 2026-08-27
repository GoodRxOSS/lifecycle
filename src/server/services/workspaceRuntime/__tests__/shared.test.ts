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

import type { RequestUserIdentity } from 'server/lib/get-user';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import { WorkspaceRuntimeSecurityError } from '../types';
import {
  apiRequest,
  assertGatewayTokenAccepted,
  assertGatewayTokenEnforced,
  assertNoExternalSecretRefs,
  buildBootstrapScript,
  buildInitScriptOpts,
  buildSandboxBaseEnv,
  buildSessionRuntimeEnv,
  buildShellEnvFile,
  buildUserIdentityEnv,
  codeServerCommand,
  extractHttpErrorMessage,
  isGoneError,
  isHttpReady,
  isRecord,
  joinUrl,
  normalizeEnv,
  ProviderApiError,
  readResponseBody,
  readString,
  readStringRecord,
  scrubSecrets,
  shellQuote,
  waitForHttp,
  waitForHttpReady,
} from '../providers/shared';

const userIdentity: RequestUserIdentity = {
  userId: 'user-1',
  githubUsername: 'octocat',
  preferredUsername: 'octocat',
  email: 'octocat@example.com',
  firstName: 'Octo',
  lastName: 'Cat',
  displayName: 'Octo Cat',
  gitUserName: 'Octo Cat',
  gitUserEmail: 'octocat@example.com',
  roles: ['user'],
};

const basePlan: WorkspaceRuntimePlan = {
  version: 1,
  kind: 'chat',
  sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  namespace: 'lifecycle',
  podName: 'agent-aaaaaaaa',
  apiKeySecretName: 'agent-secret-aaaaaaaa',
  runtimeConfig: {
    workspaceImage: 'lifecycle/workspace:test',
    workspaceEditorImage: 'lifecycle/editor:test',
    workspaceGatewayImage: 'lifecycle/gateway:test',
    workspaceBackend: {
      provider: 'lifecycle_kubernetes',
      opensandbox: {
        domain: 'localhost:8080',
        protocol: 'http',
        timeoutSeconds: 3600,
        useServerProxy: false,
        secureAccess: false,
        resourceLimits: {},
        execdPort: 44772,
        gatewayPort: 13338,
        editorPort: 13337,
      },
      e2b: {
        domain: 'e2b.app',
        timeoutSeconds: 3600,
        autoPause: true,
        gatewayPort: 13338,
        editorPort: 13337,
      },
      daytona: {
        apiUrl: 'https://app.daytona.io/api',
        autoArchiveInterval: 0,
        gatewayPort: 13338,
        editorPort: 13337,
      },
      modal: {
        appName: 'lifecycle-workspaces',
        image: 'lifecycle/workspace:test',
        timeoutSeconds: 3600,
        gatewayPort: 13338,
      },
    },
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
  },
  workspaceStorage: {
    requestedSize: null,
    storageSize: '10Gi',
    accessMode: 'ReadWriteOnce',
  },
  servicePlan: {
    workspaceRepos: [
      {
        repo: 'goodrx/secondary',
        repoUrl: 'https://github.com/goodrx/secondary.git',
        branch: 'develop',
        revision: null,
        mountPath: '/workspace/repos/goodrx/secondary',
        primary: false,
      },
      {
        repo: 'goodrx/lifecycle',
        repoUrl: 'https://github.com/goodrx/lifecycle.git',
        branch: 'main',
        revision: 'abc123',
        mountPath: '/workspace',
        primary: true,
      },
    ],
    services: undefined,
    selectedServices: [],
  },
  skillPlan: { version: 1, skills: [] },
  provider: {
    selection: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
    apiKey: 'provider-key',
    credentialEnv: { ANTHROPIC_API_KEY: 'provider-key' },
  },
  startupMcp: { servers: [], serializedConfig: '{"mcpServers":{}}' },
  forwardedEnv: {
    env: {},
    secretRefs: [],
    secretProviders: [],
    secretServiceName: 'agent-env-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  },
  credentials: { hasGitHubToken: false, githubToken: null },
  prewarm: {
    compatiblePrewarm: null,
    pvcName: 'agent-pvc-aaaaaaaa',
    skipWorkspaceBootstrap: false,
    ownsPvc: true,
  },
};

function buildPlan(
  overrides: {
    servicePlan?: Partial<WorkspaceRuntimePlan['servicePlan']>;
    skillPlan?: Partial<WorkspaceRuntimePlan['skillPlan']>;
    provider?: Partial<WorkspaceRuntimePlan['provider']>;
    startupMcp?: Partial<WorkspaceRuntimePlan['startupMcp']>;
    forwardedEnv?: Partial<WorkspaceRuntimePlan['forwardedEnv']>;
    credentials?: Partial<WorkspaceRuntimePlan['credentials']>;
  } = {}
): WorkspaceRuntimePlan {
  return {
    ...basePlan,
    servicePlan: { ...basePlan.servicePlan, ...overrides.servicePlan },
    skillPlan: { ...basePlan.skillPlan, ...overrides.skillPlan },
    provider: { ...basePlan.provider, ...overrides.provider },
    startupMcp: { ...basePlan.startupMcp, ...overrides.startupMcp },
    forwardedEnv: { ...basePlan.forwardedEnv, ...overrides.forwardedEnv },
    credentials: { ...basePlan.credentials, ...overrides.credentials },
  };
}

const originalNodeOptions = process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS;

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  if (originalNodeOptions === undefined) {
    delete process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS;
  } else {
    process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS = originalNodeOptions;
  }
});

describe('value readers', () => {
  it.each([
    [{ key: 'value' }, true],
    [Object.create(null), true],
    [null, false],
    [[], false],
    ['value', false],
    [0, false],
  ])('classifies record value %#', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });

  it.each([
    ['  value  ', 'value'],
    ['', undefined],
    ['   ', undefined],
    [42, undefined],
    [null, undefined],
  ])('reads trimmed strings from %#', (value, expected) => {
    expect(readString(value)).toBe(expected);
  });

  it('keeps string-valued entries with nonblank keys', () => {
    expect(
      readStringRecord({
        valid: ' value ',
        emptyValue: '',
        '': 'empty key',
        '   ': 'blank key',
        numeric: 42,
      })
    ).toEqual({ valid: ' value ', emptyValue: '' });
  });

  it.each([null, [], 'value', { ' ': 'ignored' }, { valid: 42 }])(
    'returns undefined when %# has no readable string entries',
    (value) => {
      expect(readStringRecord(value)).toBeUndefined();
    }
  );

  it('quotes shell values without allowing apostrophes to end the quoted argument', () => {
    expect(shellQuote("it's safe")).toBe("'it'\"'\"'s safe'");
    expect(shellQuote('')).toBe("''");
  });
});

describe('HTTP response helpers', () => {
  it('reads JSON, plain text, blank, and unreadable response bodies', async () => {
    const streamFailure = new Error('stream failed');
    const unreadable = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(streamFailure);
        },
      })
    );

    await expect(readResponseBody(new Response('{"ok":true}'))).resolves.toEqual({ ok: true });
    await expect(readResponseBody(new Response(' provider text '))).resolves.toBe(' provider text ');
    await expect(readResponseBody(new Response('  \n '))).resolves.toBeNull();
    await expect(readResponseBody(unreadable)).resolves.toBeNull();
  });

  it.each([
    [{ message: 'top-level' }, 'top-level'],
    [{ message: 42, error: { message: 'nested' } }, 'nested'],
    ['  provider text  ', 'provider text'],
    ['', 'Upstream Failure'],
    [{ error: { message: 42 } }, 'Upstream Failure'],
    [null, 'Upstream Failure'],
  ])('extracts provider error text from %#', (body, expected) => {
    const response = new Response(null, { status: 502, statusText: 'Upstream Failure' });

    expect(extractHttpErrorMessage(response, body)).toBe(expected);
  });

  it.each([
    ['https://provider.example/api', 'sandboxes', 'https://provider.example/api/sandboxes'],
    ['https://provider.example/api/', 'sandboxes', 'https://provider.example/api/sandboxes'],
    ['https://provider.example/api', '/sandboxes', 'https://provider.example/api/sandboxes'],
    ['https://provider.example/api/', '/sandboxes', 'https://provider.example/api/sandboxes'],
  ])('joins %s and %s without a duplicate or missing slash', (baseUrl, pathname, expected) => {
    expect(joinUrl(baseUrl, pathname)).toBe(expected);
  });
});

describe('HTTP readiness', () => {
  it('returns the response readiness and clears the abort deadline after completion', async () => {
    jest.useFakeTimers();
    const requestState: { signal: AbortSignal | null } = { signal: null };
    const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestState.signal = init?.signal ?? null;
      return new Response(null, { status: 204 });
    });

    await expect(isHttpReady('https://workspace.example/health', { 'x-access': 'token' }, 50)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith('https://workspace.example/health', {
      method: 'GET',
      headers: { 'x-access': 'token' },
      signal: expect.any(AbortSignal),
    });
    jest.advanceTimersByTime(50);
    expect(requestState.signal?.aborted).toBe(false);
  });

  it('returns false for an unhealthy response and for a timed-out request', async () => {
    jest.useFakeTimers();
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(isHttpReady('https://workspace.example/health', {}, 50)).resolves.toBe(false);

    fetcher.mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const pending = isHttpReady('https://workspace.example/health', {}, 25);
    jest.advanceTimersByTime(25);
    await expect(pending).resolves.toBe(false);
  });

  it('retries until the endpoint becomes ready', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const pending = waitForHttpReady('https://workspace.example/health', {}, 1_000);
    await (
      jest as typeof jest & { advanceTimersByTimeAsync(milliseconds: number): Promise<void> }
    ).advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('returns false and waitForHttp reports the URL when the deadline expires', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

    const readiness = waitForHttpReady('https://workspace.example/health', {}, 0);
    await (
      jest as typeof jest & { advanceTimersByTimeAsync(milliseconds: number): Promise<void> }
    ).advanceTimersByTimeAsync(500);
    await expect(readiness).resolves.toBe(false);

    jest.setSystemTime(0);
    const required = expect(waitForHttp('https://workspace.example/required', {}, 0)).rejects.toThrow(
      'Workspace endpoint did not become ready: https://workspace.example/required'
    );
    await (
      jest as typeof jest & { advanceTimersByTimeAsync(milliseconds: number): Promise<void> }
    ).advanceTimersByTimeAsync(500);
    await required;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('resolves waitForHttp as soon as the endpoint is ready', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    await expect(waitForHttp('https://workspace.example/health', {}, 1_000)).resolves.toBeUndefined();
  });
});

describe('gateway authentication probes', () => {
  function cancelableResponse(status: number): { response: Response; wasCancelled: () => boolean } {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status }
    );
    return { response, wasCancelled: () => cancelled };
  }

  it('uses the same proxy path for negative and positive probes and cancels both response bodies', async () => {
    const negative = cancelableResponse(401);
    const positive = cancelableResponse(200);
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(negative.response)
      .mockResolvedValueOnce(positive.response);

    await expect(
      assertGatewayTokenEnforced('https://gateway.example/', { 'x-proxy-access': 'preview-token' })
    ).resolves.toBeUndefined();
    await expect(
      assertGatewayTokenAccepted(
        'https://gateway.example/',
        {
          'x-proxy-access': 'preview-token',
          Authorization: 'Bearer proxy-value',
          'x-lifecycle-gateway-token': 'proxy-value',
        },
        'gateway-token'
      )
    ).resolves.toBeUndefined();

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://gateway.example/mcp',
      'https://gateway.example/mcp',
    ]);
    const negativeInit = fetcher.mock.calls[0][1];
    const positiveInit = fetcher.mock.calls[1][1];
    expect(new Headers(negativeInit?.headers)).toEqual(
      new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-proxy-access': 'preview-token',
      })
    );
    expect(new Headers(positiveInit?.headers)).toEqual(
      new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-proxy-access': 'preview-token',
        Authorization: 'Bearer gateway-token',
        'x-lifecycle-gateway-token': 'gateway-token',
      })
    );
    expect(JSON.parse(String(negativeInit?.body))).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'lifecycle-token-probe', version: '0.0.0' } },
    });
    expect(JSON.parse(String(positiveInit?.body))).toMatchObject({
      params: { clientInfo: { name: 'lifecycle-token-positive-probe', version: '0.0.0' } },
    });
    expect(negativeInit).toEqual(expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
    expect(positiveInit).toEqual(expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
    expect(negative.wasCancelled()).toBe(true);
    expect(positive.wasCancelled()).toBe(true);
  });

  it('fails closed when an unauthenticated request succeeds', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    await expect(assertGatewayTokenEnforced('https://gateway.example', {})).rejects.toEqual(
      expect.objectContaining({
        name: 'WorkspaceRuntimeSecurityError',
        message: expect.stringContaining('accepted an unauthenticated MCP request'),
      } satisfies Partial<WorkspaceRuntimeSecurityError>)
    );
  });

  it('fails closed when the configured token is rejected', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));

    await expect(assertGatewayTokenAccepted('https://gateway.example', {}, 'gateway-token')).rejects.toEqual(
      expect.objectContaining({
        name: 'WorkspaceRuntimeSecurityError',
        message: expect.stringContaining('status=403'),
      } satisfies Partial<WorkspaceRuntimeSecurityError>)
    );
  });

  it('propagates network failures from a probe', async () => {
    const networkFailure = new Error('connection refused');
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(networkFailure);

    await expect(assertGatewayTokenEnforced('https://gateway.example', {})).rejects.toBe(networkFailure);
  });

  it('aborts both gateway probes after their fixed deadline', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );

    const negativeProbe = expect(assertGatewayTokenEnforced('https://gateway.example', {})).rejects.toMatchObject({
      name: 'AbortError',
    });
    jest.advanceTimersByTime(10_000);
    await negativeProbe;

    const positiveProbe = expect(
      assertGatewayTokenAccepted('https://gateway.example', {}, 'gateway-token')
    ).rejects.toMatchObject({ name: 'AbortError' });
    jest.advanceTimersByTime(10_000);
    await positiveProbe;
  });

  it('ignores response-body cancellation failures after completing either probe', async () => {
    const cancellationFailure = new Error('cancel failed');
    const response = (status: number) =>
      new Response(
        new ReadableStream({
          cancel() {
            throw cancellationFailure;
          },
        }),
        { status }
      );
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200));

    await expect(assertGatewayTokenEnforced('https://gateway.example', {})).resolves.toBeUndefined();
    await expect(assertGatewayTokenAccepted('https://gateway.example', {}, 'gateway-token')).resolves.toBeUndefined();
  });
});

describe('provider API requests', () => {
  it('exposes stable ProviderApiError metadata and identifies only 404 as gone', () => {
    const gone = new ProviderApiError('missing', 404, 'daytona');

    expect(gone).toMatchObject({ name: 'ProviderApiError', message: 'missing', status: 404, provider: 'daytona' });
    expect(isGoneError(gone)).toBe(true);
    expect(isGoneError(new ProviderApiError('expired', 410, 'daytona'))).toBe(false);
    expect(isGoneError(new Error('missing'))).toBe(false);
  });

  it('merges per-call headers over auth headers and returns the parsed body', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"id":"sandbox-1"}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(
      apiRequest<{ id: string }>(
        'https://provider.example/api/',
        { Authorization: 'Bearer auth-token', 'x-shared': 'auth-value' },
        '/sandboxes',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer per-call-token', 'content-type': 'application/json' },
          body: '{"name":"sandbox"}',
        },
        'Create failed',
        'opensandbox'
      )
    ).resolves.toEqual({ id: 'sandbox-1' });
    expect(fetcher).toHaveBeenCalledWith('https://provider.example/api/sandboxes', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer per-call-token',
        'x-shared': 'auth-value',
        'content-type': 'application/json',
      },
      body: '{"name":"sandbox"}',
    });
  });

  it('uses only auth headers when a request has no per-call headers', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('plain result'));

    await expect(
      apiRequest(
        'https://provider.example',
        { Authorization: 'Bearer token' },
        'status',
        { method: 'GET' },
        'Read',
        'e2b'
      )
    ).resolves.toBe('plain result');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('throws provider metadata with the normalized HTTP error message', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"permission denied"}}', {
        status: 403,
        statusText: 'Forbidden',
      })
    );

    await expect(
      apiRequest('https://provider.example', {}, '/sandboxes/1', { method: 'DELETE' }, 'Delete failed', 'daytona')
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'ProviderApiError',
        message: 'Delete failed: permission denied (status=403)',
        status: 403,
        provider: 'daytona',
      } satisfies Partial<ProviderApiError>)
    );
  });

  it('does not wrap a transport failure', async () => {
    const networkFailure = new Error('network down');
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(networkFailure);

    await expect(
      apiRequest('https://provider.example', {}, '/status', { method: 'GET' }, 'Read failed', 'e2b')
    ).rejects.toBe(networkFailure);
  });
});

describe('environment builders', () => {
  it('builds identity environment variables and omits absent optional claims', () => {
    expect(buildUserIdentityEnv(undefined)).toEqual({});
    expect(buildUserIdentityEnv(null)).toEqual({});
    expect(buildUserIdentityEnv(userIdentity)).toEqual({
      LIFECYCLE_USER_ID: 'user-1',
      LIFECYCLE_USER_NAME: 'Octo Cat',
      GIT_AUTHOR_NAME: 'Octo Cat',
      GIT_AUTHOR_EMAIL: 'octocat@example.com',
      GIT_COMMITTER_NAME: 'Octo Cat',
      GIT_COMMITTER_EMAIL: 'octocat@example.com',
      LIFECYCLE_GITHUB_USERNAME: 'octocat',
      LIFECYCLE_USER_EMAIL: 'octocat@example.com',
    });
    expect(buildUserIdentityEnv({ ...userIdentity, githubUsername: null, email: null })).toEqual({
      LIFECYCLE_USER_ID: 'user-1',
      LIFECYCLE_USER_NAME: 'Octo Cat',
      GIT_AUTHOR_NAME: 'Octo Cat',
      GIT_AUTHOR_EMAIL: 'octocat@example.com',
      GIT_COMMITTER_NAME: 'Octo Cat',
      GIT_COMMITTER_EMAIL: 'octocat@example.com',
    });
  });

  it('normalizes environment entries without trimming valid values', () => {
    expect(normalizeEnv({ VALID: ' value ', EMPTY: '', NULL: null, UNDEFINED: undefined, '  ': 'blank key' })).toEqual({
      VALID: ' value ',
      EMPTY: '',
    });
  });

  it('builds default runtime environment without a workspace plan', () => {
    delete process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS;

    expect(buildSessionRuntimeEnv(undefined, 13338)).toEqual({
      LIFECYCLE_SESSION_WORKSPACE: '/workspace',
      LIFECYCLE_SESSION_HOME: '/home/agent/.lifecycle-session',
      LIFECYCLE_SESSION_PRIMARY_REPO_PATH: '/workspace',
      MCP_PORT: '13338',
      HOME: '/home/agent/.lifecycle-session',
      TMPDIR: '/tmp',
      TMP: '/tmp',
      TEMP: '/tmp',
      NODE_OPTIONS: '--max-old-space-size=2048',
    });
  });

  it('uses the primary repo and applies the documented runtime environment precedence', () => {
    process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS = '--max-old-space-size=4096';

    expect(
      buildSessionRuntimeEnv(basePlan, 13338, {
        MCP_PORT: '9000',
        CUSTOM: 'custom-value',
        HOME: '/caller-home',
        NODE_OPTIONS: '--caller-options',
      })
    ).toMatchObject({
      LIFECYCLE_SESSION_PRIMARY_REPO_PATH: '/workspace',
      MCP_PORT: '9000',
      CUSTOM: 'custom-value',
      HOME: '/home/agent/.lifecycle-session',
      NODE_OPTIONS: '--max-old-space-size=4096',
    });
  });

  it('falls back to the first repo when none is marked primary', () => {
    const plan = buildPlan({
      servicePlan: {
        workspaceRepos: basePlan.servicePlan.workspaceRepos.map((repo) => ({ ...repo, primary: false })),
      },
    });

    expect(buildSessionRuntimeEnv(plan, 13338).LIFECYCLE_SESSION_PRIMARY_REPO_PATH).toBe(
      '/workspace/repos/goodrx/secondary'
    );
  });

  it('combines sandbox credentials, identity, MCP, gateway, and runtime environment', () => {
    const plan = buildPlan({
      provider: { credentialEnv: { PROVIDER_KEY: 'provider', OVERRIDE: 'provider' } },
      forwardedEnv: { env: { FORWARDED: 'forwarded', OVERRIDE: 'forwarded' } },
      credentials: { hasGitHubToken: true, githubToken: 'github-token' },
    });

    expect(
      buildSandboxBaseEnv(
        plan,
        { userIdentity, gatewayToken: 'gateway-token' },
        {
          RUNTIME: 'runtime',
          OVERRIDE: 'runtime',
        }
      )
    ).toMatchObject({
      PROVIDER_KEY: 'provider',
      FORWARDED: 'forwarded',
      LIFECYCLE_USER_ID: 'user-1',
      GITHUB_TOKEN: 'github-token',
      GH_TOKEN: 'github-token',
      LIFECYCLE_SESSION_MCP_CONFIG_JSON: '{"mcpServers":{}}',
      LIFECYCLE_GATEWAY_TOKEN: 'gateway-token',
      RUNTIME: 'runtime',
      OVERRIDE: 'runtime',
    });
  });

  it('omits optional sandbox credentials when they are unavailable', () => {
    const env = buildSandboxBaseEnv(basePlan, {}, { RUNTIME: 'runtime' });

    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'provider-key',
      LIFECYCLE_SESSION_MCP_CONFIG_JSON: '{"mcpServers":{}}',
      RUNTIME: 'runtime',
    });
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('LIFECYCLE_GATEWAY_TOKEN');
    expect(env).not.toHaveProperty('LIFECYCLE_USER_ID');
  });
});

describe('workspace scripts and initialization', () => {
  it('builds init options from the primary repo and user context', () => {
    expect(buildInitScriptOpts(basePlan, { userIdentity, installCommand: 'pnpm install' })).toEqual({
      workspacePath: '/workspace',
      workspaceRepos: basePlan.servicePlan.workspaceRepos,
      repoUrl: 'https://github.com/goodrx/lifecycle.git',
      branch: 'main',
      revision: 'abc123',
      installCommand: 'pnpm install',
      gitUserName: 'Octo Cat',
      gitUserEmail: 'octocat@example.com',
      githubUsername: 'octocat',
      useGitHubToken: false,
    });
  });

  it('returns absent optional init values when a chat has no repositories or identity', () => {
    const plan = buildPlan({ servicePlan: { workspaceRepos: [] } });

    expect(buildInitScriptOpts(plan, {})).toEqual({
      workspacePath: '/workspace',
      workspaceRepos: [],
      repoUrl: undefined,
      branch: undefined,
      revision: undefined,
      installCommand: undefined,
      gitUserName: undefined,
      gitUserEmail: undefined,
      githubUsername: undefined,
      useGitHubToken: false,
    });
  });

  it('builds a bootstrap script with optional directory creation and skills', () => {
    const plan = buildPlan({
      skillPlan: {
        skills: [
          {
            repo: 'goodrx/skills',
            repoUrl: 'https://github.com/goodrx/skills.git',
            branch: 'main',
            path: 'skills/review',
            source: 'environment',
          },
        ],
      },
    });

    expect(
      buildBootstrapScript(
        plan,
        { init: '/run/lifecycle/init.sh', seed: '/run/lifecycle/seed.sh', skills: '/run/lifecycle/skills.sh' },
        { includeMkdir: true }
      )
    ).toBe(
      [
        '#!/bin/sh',
        'set -e',
        "mkdir -p '/home/agent/.lifecycle-session' '/workspace' /tmp",
        "cd '/workspace'",
        'sh /run/lifecycle/init.sh',
        'sh /run/lifecycle/seed.sh',
        'sh /run/lifecycle/skills.sh',
        '',
      ].join('\n')
    );
  });

  it('omits optional bootstrap steps when they are not requested', () => {
    expect(
      buildBootstrapScript(basePlan, {
        init: '/run/lifecycle/init.sh',
        seed: '/run/lifecycle/seed.sh',
        skills: '/run/lifecycle/skills.sh',
      })
    ).toBe(
      ['#!/bin/sh', 'set -e', "cd '/workspace'", 'sh /run/lifecycle/init.sh', 'sh /run/lifecycle/seed.sh', ''].join(
        '\n'
      )
    );
  });

  it('builds foreground and exec code-server commands', () => {
    const foreground = codeServerCommand(13337, 'E2B');
    const backgroundOwner = codeServerCommand(13339, 'Daytona', { exec: true });

    expect(foreground).toContain('echo "code-server not installed in E2B workspace image"');
    expect(foreground).toContain(
      "code-server '/tmp/agent-session.code-workspace' --auth none --bind-addr 0.0.0.0:13337 --disable-telemetry --disable-update-check"
    );
    expect(foreground).not.toContain('\nexec code-server');
    expect(backgroundOwner).toContain(
      "exec code-server '/tmp/agent-session.code-workspace' --auth none --bind-addr 0.0.0.0:13339 --disable-telemetry --disable-update-check"
    );
  });

  it('serializes a shell environment file with quoted values and a trailing newline', () => {
    expect(buildShellEnvFile({ PLAIN: 'value', QUOTE: "it's", EMPTY: '' })).toBe(
      "PLAIN='value'\nQUOTE='it'\"'\"'s'\nEMPTY=''\n"
    );
    expect(buildShellEnvFile({})).toBe('\n');
  });
});

describe('provider safety helpers', () => {
  it('accepts a plan without external secret references', () => {
    expect(() => assertNoExternalSecretRefs(basePlan, 'E2B')).not.toThrow();
  });

  it('lists every unresolved external secret key', () => {
    const plan = buildPlan({
      forwardedEnv: {
        secretRefs: [
          { envKey: 'DATABASE_PASSWORD', provider: 'aws', path: 'apps/lifecycle', key: 'password' },
          { envKey: 'NPM_TOKEN', provider: 'vault', path: 'ci/npm' },
        ],
        secretProviders: ['aws', 'vault'],
      },
    });

    expect(() => assertNoExternalSecretRefs(plan, 'Daytona')).toThrow(
      'Daytona backend cannot resolve Lifecycle external secret references yet: DATABASE_PASSWORD, NPM_TOKEN'
    );
  });

  it('redacts every occurrence of defined, nonempty secrets', () => {
    expect(scrubSecrets('token=abc; repeated=abc; other=$&', ['abc', undefined, '', '$&'])).toBe(
      'token=[redacted]; repeated=[redacted]; other=[redacted]'
    );
  });
});
