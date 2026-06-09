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

import {
  SESSION_WORKSPACE_EDITOR_PROJECT_FILE,
  SESSION_WORKSPACE_ROOT,
  buildSessionWorkspaceEditorContents,
} from 'server/lib/agentSession/workspace';
import {
  SESSION_WORKSPACE_SHARED_HOME_DIR,
  generateInitScript,
  generateRuntimeSeedScript,
} from 'server/lib/agentSession/configSeeder';
import { generateSkillBootstrapCommand } from 'server/lib/agentSession/skillBootstrap';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import type {
  ResolvedAgentSessionOpenSandboxBackendConfig,
  ResolvedAgentSessionWorkspaceBackendConfig,
} from 'server/lib/agentSession/runtimeConfig';
import { getLogger } from 'server/lib/logger';
import { LIFECYCLE_GATEWAY_TOKEN_ENV } from '../gatewayToken';
import {
  ProviderApiError,
  apiRequest,
  assertGatewayTokenAccepted,
  assertGatewayTokenEnforced,
  assertNoExternalSecretRefs,
  buildInitScriptOpts,
  buildSandboxBaseEnv,
  buildSessionRuntimeEnv,
  codeServerCommand,
  extractHttpErrorMessage,
  isGoneError,
  isHttpReady,
  isRecord,
  joinUrl,
  readResponseBody,
  readString,
  readStringRecord,
  shellQuote,
  waitForHttp,
  waitForHttpReady,
} from './shared';
import {
  OPEN_SANDBOX_PROVIDER,
  WorkspaceRuntimeGoneError,
  type ReadinessProfile,
  type RemoteProvisionContext,
  type RemoteRuntimeHandle,
  type RemoteWorkspaceRuntimeProvider,
  type WorkspaceBackendCapabilities,
  type WorkspaceBackendCapabilitySnapshot,
  type WorkspaceBackendTestConnectionResult,
  type WorkspaceRuntimeEndpoint,
} from '../types';

export { ProviderApiError as OpenSandboxApiError } from './shared';

export const OPEN_SANDBOX_DECLARED_CAPABILITIES: WorkspaceBackendCapabilities = {
  newChatWorkspaces: { supported: true },
  developWorkspaces: { supported: false },
  environmentSessions: { supported: false },
  sandboxSessions: { supported: true },
  editor: { supported: true, note: 'Available when the workspace image bundles code-server.' },
  previewPorts: { supported: true },
  hibernateResume: { supported: true },
  prewarm: { supported: false },
};

const DEFAULT_ENTRYPOINT = ['tail', '-f', '/dev/null'];
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 10 * 60;
const DEFAULT_EDITOR_WAIT_MS = 15000;
const DEFAULT_SUSPEND_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SUSPEND_POLL_MS = 2000;
const COMMAND_ERROR_OUTPUT_LIMIT = 2000;

interface OpenSandboxEndpoint {
  endpoint: string;
  headers?: Record<string, string>;
}

interface OpenSandboxStatus {
  state?: string;
  reason?: string;
  message?: string;
}

interface OpenSandboxInfo {
  id: string;
  status?: OpenSandboxStatus;
  expiresAt?: string;
}

export interface OpenSandboxRuntimeProviderState {
  [key: string]: unknown;
  sandboxId: string;
  lifecycleBaseUrl: string;
  execdBaseUrl?: string;
  execdHeaders?: Record<string, string>;
  gatewayUrl?: string;
  gatewayHeaders?: Record<string, string>;
  editorUrl?: string;
  editorHeaders?: Record<string, string>;
  gatewayCommandId?: string;
  editorCommandId?: string;
  /** Encrypted gateway bearer token (ciphertext only; plaintext never persists). */
  gatewayToken?: string;
}

type OpenSandboxProvisionOptions = Pick<RemoteProvisionContext, 'userIdentity' | 'installCommand' | 'gatewayToken'>;

/** Like the shared readStringRecord but strips any persisted platform api-key header (never re-store it). */
function readSafeHeaderRecord(value: unknown): Record<string, string> | undefined {
  const record = readStringRecord(value);
  if (!record) {
    return undefined;
  }
  const safe = Object.fromEntries(
    Object.entries(record).filter(([key]) => key.toUpperCase() !== 'OPEN-SANDBOX-API-KEY')
  );
  return Object.keys(safe).length > 0 ? safe : undefined;
}

const PROVIDER_STATE_STRING_KEYS = [
  'execdBaseUrl',
  'gatewayUrl',
  'editorUrl',
  'gatewayCommandId',
  'editorCommandId',
  'gatewayToken',
] as const;
const PROVIDER_STATE_RECORD_KEYS = ['execdHeaders', 'gatewayHeaders', 'editorHeaders'] as const;

export function readOpenSandboxProviderState(value: unknown): OpenSandboxRuntimeProviderState | null {
  if (!isRecord(value)) {
    return null;
  }

  const sandboxId = readString(value.sandboxId);
  const lifecycleBaseUrl = readString(value.lifecycleBaseUrl);
  if (!sandboxId || !lifecycleBaseUrl) {
    return null;
  }

  const state: OpenSandboxRuntimeProviderState = { sandboxId, lifecycleBaseUrl };
  for (const key of PROVIDER_STATE_STRING_KEYS) {
    const parsed = readString(value[key]);
    if (parsed) {
      state[key] = parsed;
    }
  }
  for (const key of PROVIDER_STATE_RECORD_KEYS) {
    const parsed = readSafeHeaderRecord(value[key]);
    if (parsed) {
      state[key] = parsed;
    }
  }
  return state;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
}

function lifecycleBaseUrl(config: ResolvedAgentSessionOpenSandboxBackendConfig): string {
  const domain = stripTrailingSlash(config.domain);
  if (domain.startsWith('http://') || domain.startsWith('https://')) {
    return domain.endsWith('/v1') ? domain : `${domain}/v1`;
  }
  return `${config.protocol}://${domain}/v1`;
}

function endpointToUrl(protocol: 'http' | 'https', endpoint: string): string {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }
  return `${protocol}://${endpoint}`;
}

function endpointAccessHeaders(
  config: ResolvedAgentSessionOpenSandboxBackendConfig,
  endpointHeaders?: Record<string, string>
): Record<string, string> {
  return {
    ...(config.apiKey ? { 'OPEN-SANDBOX-API-KEY': config.apiKey } : {}),
    ...(endpointHeaders || {}),
  };
}

function withAccessHeaders(
  endpoint: { url: string },
  config: ResolvedAgentSessionOpenSandboxBackendConfig,
  endpointHeaders?: Record<string, string>
): WorkspaceRuntimeEndpoint {
  const headers = endpointAccessHeaders(config, endpointHeaders);
  return Object.keys(headers).length > 0 ? { ...endpoint, headers } : endpoint;
}

/** Thin OpenSandbox-tagged wrapper over the shared error for the non-apiRequest fetches (upload/exec stream). */
function describeOpenSandboxError(prefix: string, response: Response, body: unknown): ProviderApiError {
  return new ProviderApiError(
    `${prefix}: ${extractHttpErrorMessage(response, body)} (status=${response.status})`,
    response.status,
    OPEN_SANDBOX_PROVIDER
  );
}

export function buildOpenSandboxCapabilitySnapshot(state: { editorUrl?: string }): WorkspaceBackendCapabilitySnapshot {
  return {
    ...OPEN_SANDBOX_DECLARED_CAPABILITIES,
    backend: OPEN_SANDBOX_PROVIDER,
    editorAccess: Boolean(state.editorUrl),
  };
}

interface ServerStreamEvent {
  type?: string;
  text?: string;
  error?: Record<string, unknown>;
}

interface CommandExecution {
  id?: string;
  stdout: string[];
  stderr: string[];
  error?: string;
}

async function* parseJsonEventStream(response: Response): AsyncIterable<ServerStreamEvent> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');

      if (!rawLine || rawLine.startsWith(':') || rawLine.startsWith('event:') || rawLine.startsWith('id:')) {
        continue;
      }

      const jsonLine = rawLine.startsWith('data:') ? rawLine.slice('data:'.length).trim() : rawLine;
      if (!jsonLine) {
        continue;
      }

      try {
        yield JSON.parse(jsonLine) as ServerStreamEvent;
      } catch {
        continue;
      }
    }
  }

  buffer += decoder.decode();
  const lastLine = buffer.trim();
  if (!lastLine) {
    return;
  }

  const jsonLine = lastLine.startsWith('data:') ? lastLine.slice('data:'.length).trim() : lastLine;
  try {
    yield JSON.parse(jsonLine) as ServerStreamEvent;
  } catch {
    return;
  }
}

function applyCommandEvent(execution: CommandExecution, event: ServerStreamEvent): void {
  if (event.type === 'init' && event.text) {
    execution.id = event.text;
    return;
  }

  if (event.type === 'stdout') {
    execution.stdout.push(event.text || '');
    return;
  }

  if (event.type === 'stderr') {
    execution.stderr.push(event.text || '');
    return;
  }

  if (event.type === 'error') {
    const errorValue = event.error?.evalue ?? event.error?.value ?? event.error?.message;
    execution.error = errorValue == null ? 'command failed' : String(errorValue);
  }
}

export class OpenSandboxRuntimeService implements RemoteWorkspaceRuntimeProvider {
  readonly backendId = OPEN_SANDBOX_PROVIDER;

  constructor(private readonly config: ResolvedAgentSessionOpenSandboxBackendConfig) {}

  private requireState(state: unknown): OpenSandboxRuntimeProviderState {
    const parsed = readOpenSandboxProviderState(state);
    if (!parsed) {
      throw new Error('OpenSandbox provider state is missing required fields');
    }
    return parsed;
  }

  private toHandle(state: OpenSandboxRuntimeProviderState): RemoteRuntimeHandle {
    return {
      providerState: state,
      capabilitySnapshot: this.capabilities(state),
      podNameAlias: state.sandboxId,
    };
  }

  async provision(ctx: RemoteProvisionContext): Promise<RemoteRuntimeHandle> {
    const { plan } = ctx;
    if (!this.config.image) {
      throw new Error('OpenSandbox workspace backend requires an image.');
    }
    assertNoExternalSecretRefs(plan, 'OpenSandbox');

    const created = await this.createSandbox(plan, ctx);
    let state: OpenSandboxRuntimeProviderState = {
      sandboxId: created.id,
      lifecycleBaseUrl: lifecycleBaseUrl(this.config),
    };

    try {
      await this.waitForSandboxRunning(created.id, ctx.readiness.timeoutMs, ctx.readiness.pollMs);
      state = await this.resolveExecdState(state);
      await this.prepareWorkspace(state, plan, ctx);
      state = await this.ensureRuntimeEndpoints(state, { plan, gatewayToken: ctx.gatewayToken });
      return this.toHandle(state);
    } catch (error) {
      await this.deleteSandbox(created.id).catch(() => {});
      throw error;
    }
  }

  async resume(state: unknown, readiness: ReadinessProfile): Promise<RemoteRuntimeHandle> {
    const parsed = this.requireState(state);
    try {
      await this.lifecycleRequest(
        `/sandboxes/${encodeURIComponent(parsed.sandboxId)}/resume`,
        { method: 'POST' },
        'OpenSandbox resume failed'
      );
      const resumedState = await this.connectRunningSandbox(parsed, readiness);
      await this.renewExpiration(parsed);
      return this.toHandle(resumedState);
    } catch (error) {
      if (isGoneError(error)) {
        throw new WorkspaceRuntimeGoneError(`OpenSandbox sandbox ${parsed.sandboxId} no longer exists`, error);
      }
      throw error;
    }
  }

  /**
   * Reconnects to an existing sandbox (resuming it if paused). Returns null when the sandbox is
   * gone or unrecoverable — after best-effort deletion — so the caller can provision a fresh one.
   */
  async reattach(state: unknown, readiness: ReadinessProfile): Promise<RemoteRuntimeHandle | null> {
    const parsed = readOpenSandboxProviderState(state);
    if (!parsed) {
      return null;
    }

    let info: OpenSandboxInfo;
    try {
      info = await this.getSandbox(parsed.sandboxId);
    } catch (error) {
      if (isGoneError(error)) {
        return null;
      }
      throw error;
    }

    const currentState = info.status?.state;
    if (currentState === 'Failed' || currentState === 'Terminated' || currentState === 'Stopping') {
      await this.deleteSandbox(parsed.sandboxId).catch(() => {});
      return null;
    }

    try {
      if (currentState === 'Paused') {
        await this.lifecycleRequest(
          `/sandboxes/${encodeURIComponent(parsed.sandboxId)}/resume`,
          { method: 'POST' },
          'OpenSandbox resume failed'
        );
      }
      const nextState = await this.connectRunningSandbox(parsed, readiness);
      await this.renewExpiration(parsed);
      return this.toHandle(nextState);
    } catch (error) {
      // Raced its TTL while reattaching: treat as gone so the caller provisions fresh.
      if (isGoneError(error)) {
        return null;
      }
      throw error;
    }
  }

  async suspend(state: unknown, opts: { retainForMs: number }): Promise<void> {
    const parsed = this.requireState(state);
    // Renew before pausing: TTL expiry terminates Paused sandboxes too, destroying the filesystem.
    // Strict: a failed renewal must fail the suspend (sandbox keeps running) rather than pause with a
    // short TTL that reaps the hibernated filesystem long before its retention window.
    await this.renewExpiration(parsed, opts.retainForMs, { strict: true });
    await this.lifecycleRequest(
      `/sandboxes/${encodeURIComponent(parsed.sandboxId)}/pause`,
      { method: 'POST' },
      'OpenSandbox pause failed'
    );
    await this.waitForSandboxPaused(parsed.sandboxId, DEFAULT_SUSPEND_TIMEOUT_MS, DEFAULT_SUSPEND_POLL_MS);
  }

  async renewLease(state: unknown): Promise<void> {
    const parsed = readOpenSandboxProviderState(state);
    if (!parsed) {
      return;
    }
    await this.renewExpiration(parsed);
  }

  /**
   * Extends the sandbox TTL to now + ttlMs (default: the configured create timeout), skipping
   * when the current expiry is already later (the API rejects earlier renewals). Non-fatal: a
   * missed renewal only matters if it keeps failing until the TTL runs out, so failures are
   * logged and swallowed.
   */
  async renewExpiration(
    state: OpenSandboxRuntimeProviderState,
    ttlMs?: number,
    opts: { strict?: boolean } = {}
  ): Promise<void> {
    const effectiveTtlMs = ttlMs ?? (this.config.timeoutSeconds !== null ? this.config.timeoutSeconds * 1000 : null);
    if (effectiveTtlMs === null) {
      return;
    }

    try {
      const expiresAt = new Date(Date.now() + effectiveTtlMs);
      const info = await this.getSandbox(state.sandboxId);
      if (!info.expiresAt || new Date(info.expiresAt) >= expiresAt) {
        return;
      }

      await this.lifecycleRequest(
        `/sandboxes/${encodeURIComponent(state.sandboxId)}/renew-expiration`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expiresAt: expiresAt.toISOString() }),
        },
        'OpenSandbox renew expiration failed'
      );
    } catch (error) {
      // The periodic lease pass swallows failures (it retries next tick); suspend cannot, so it opts in to strict.
      if (opts.strict) {
        throw error;
      }
      getLogger().warn({ error, sandboxId: state.sandboxId }, 'OpenSandbox: expiration renewal failed');
    }
  }

  private async connectRunningSandbox(
    state: OpenSandboxRuntimeProviderState,
    readiness: { timeoutMs: number; pollMs: number }
  ): Promise<OpenSandboxRuntimeProviderState> {
    await this.waitForSandboxRunning(state.sandboxId, readiness.timeoutMs, readiness.pollMs);
    const withExecd = await this.resolveExecdState(state);
    return this.ensureRuntimeEndpoints(withExecd);
  }

  async destroy(state: unknown): Promise<void> {
    // Mirror reattach's null contract: a never-provisioned/unparseable state has nothing to destroy.
    const parsed = readOpenSandboxProviderState(state);
    if (!parsed) {
      return;
    }
    await this.deleteSandbox(parsed.sandboxId);
  }

  resolveGatewayEndpoint(state: unknown): WorkspaceRuntimeEndpoint | null {
    const parsed = readOpenSandboxProviderState(state);
    if (!parsed?.gatewayUrl) {
      return null;
    }
    return withAccessHeaders({ url: parsed.gatewayUrl }, this.config, parsed.gatewayHeaders);
  }

  resolveEditorEndpoint(state: unknown): WorkspaceRuntimeEndpoint | null {
    const parsed = readOpenSandboxProviderState(state);
    if (!parsed?.editorUrl) {
      return null;
    }
    return withAccessHeaders({ url: parsed.editorUrl }, this.config, parsed.editorHeaders);
  }

  hasPersistedHandle(state: unknown): boolean {
    return readOpenSandboxProviderState(state) !== null;
  }

  capabilities(state?: unknown): WorkspaceBackendCapabilitySnapshot {
    return buildOpenSandboxCapabilitySnapshot(readOpenSandboxProviderState(state) || {});
  }

  private async createSandbox(
    plan: WorkspaceRuntimePlan,
    options: OpenSandboxProvisionOptions
  ): Promise<{ id: string }> {
    const env = this.buildSandboxEnv(plan, options);
    const body: Record<string, unknown> = {
      image: { uri: this.config.image },
      entrypoint: DEFAULT_ENTRYPOINT,
      resourceLimits: this.config.resourceLimits,
      secureAccess: this.config.secureAccess,
      env,
      ...(this.config.poolRef ? { extensions: { poolRef: this.config.poolRef } } : {}),
      metadata: {
        name: `lifecycle-${plan.sessionUuid.slice(0, 8)}`,
        lifecycleSession: plan.sessionUuid,
        lifecycleKind: plan.kind,
      },
    };
    if (this.config.timeoutSeconds !== null) {
      body.timeout = this.config.timeoutSeconds;
    }

    const data = await this.lifecycleRequest<{ id?: string }>(
      '/sandboxes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      'OpenSandbox create failed'
    );
    const id = readString(data?.id);
    if (!id) {
      throw new Error('OpenSandbox create failed: missing sandbox id');
    }
    return { id };
  }

  private gatewayRuntimeEnv(plan?: WorkspaceRuntimePlan): Record<string, string> {
    return buildSessionRuntimeEnv(plan, this.config.gatewayPort);
  }

  private buildSandboxEnv(plan: WorkspaceRuntimePlan, options: OpenSandboxProvisionOptions): Record<string, string> {
    // Container env persists across pause/resume, so a gateway restarted via execd inherits it.
    return buildSandboxBaseEnv(plan, options, this.gatewayRuntimeEnv(plan));
  }

  private async prepareWorkspace(
    state: OpenSandboxRuntimeProviderState,
    plan: WorkspaceRuntimePlan,
    options: OpenSandboxProvisionOptions
  ): Promise<void> {
    const initScriptOpts = buildInitScriptOpts(plan, options);
    const initScript = generateInitScript(initScriptOpts);
    const runtimeSeedScript = generateRuntimeSeedScript(initScriptOpts);
    const editorWorkspaceContents = buildSessionWorkspaceEditorContents(plan.servicePlan.workspaceRepos);

    await this.runCommand(
      state,
      `mkdir -p ${shellQuote(SESSION_WORKSPACE_SHARED_HOME_DIR)} ${shellQuote(SESSION_WORKSPACE_ROOT)} /tmp`,
      {
        workingDirectory: '/',
        timeoutSeconds: 60,
      }
    );
    await Promise.all([
      this.uploadTextFile(state, '/tmp/lifecycle-init-workspace.sh', initScript, 0o700),
      this.uploadTextFile(state, '/tmp/lifecycle-runtime-seed.sh', runtimeSeedScript, 0o700),
      this.uploadTextFile(state, SESSION_WORKSPACE_EDITOR_PROJECT_FILE, editorWorkspaceContents, 0o644),
    ]);
    await this.runCommand(state, 'sh /tmp/lifecycle-init-workspace.sh', {
      workingDirectory: SESSION_WORKSPACE_ROOT,
      timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
    });
    await this.runCommand(state, 'sh /tmp/lifecycle-runtime-seed.sh', {
      workingDirectory: SESSION_WORKSPACE_ROOT,
      timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
    });

    if ((plan.skillPlan?.skills || []).length > 0) {
      const skillBootstrapCommand = generateSkillBootstrapCommand(plan.skillPlan, {
        useGitHubToken: plan.credentials.hasGitHubToken,
      });
      await this.runCommand(state, skillBootstrapCommand, {
        workingDirectory: SESSION_WORKSPACE_ROOT,
        timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
      });
    }
  }

  private async ensureRuntimeEndpoints(
    state: OpenSandboxRuntimeProviderState,
    opts: { plan?: WorkspaceRuntimePlan; gatewayToken?: string } = {}
  ): Promise<OpenSandboxRuntimeProviderState> {
    let nextState = state;
    const gatewayEndpoint = await this.getEndpoint(state.sandboxId, this.config.gatewayPort);
    const gatewayUrl = endpointToUrl(this.config.protocol, gatewayEndpoint.endpoint);
    const gatewayHeaders = endpointAccessHeaders(this.config, gatewayEndpoint.headers);

    if (!(await isHttpReady(joinUrl(gatewayUrl, '/health'), gatewayHeaders, 1000))) {
      const gatewayCommand = await this.runCommand(state, this.gatewayCommand(opts.plan, opts.gatewayToken), {
        background: true,
        workingDirectory: SESSION_WORKSPACE_ROOT,
      });
      nextState = {
        ...nextState,
        ...(gatewayCommand.id ? { gatewayCommandId: gatewayCommand.id } : {}),
      };
      await waitForHttp(joinUrl(gatewayUrl, '/health'), gatewayHeaders, 30000);
    }

    // Fail closed on the public internet: a gateway that was given a token must enforce it.
    if (opts.gatewayToken || state.gatewayToken) {
      await assertGatewayTokenEnforced(gatewayUrl, gatewayHeaders);
      if (opts.gatewayToken) {
        await assertGatewayTokenAccepted(gatewayUrl, gatewayHeaders, opts.gatewayToken);
      }
    }

    nextState = {
      ...nextState,
      gatewayUrl,
      gatewayHeaders: gatewayEndpoint.headers,
    };

    const editorEndpoint = await this.getEndpoint(state.sandboxId, this.config.editorPort).catch(() => null);
    if (!editorEndpoint) {
      return nextState;
    }

    const editorUrl = endpointToUrl(this.config.protocol, editorEndpoint.endpoint);
    const editorHeaders = endpointAccessHeaders(this.config, editorEndpoint.headers);
    let editorReady = await isHttpReady(joinUrl(editorUrl, '/healthz'), editorHeaders, 1000);
    if (!editorReady) {
      const editorCommand = await this.runCommand(
        state,
        codeServerCommand(this.config.editorPort, 'OpenSandbox', {
          exec: true,
        }),
        {
          background: true,
          workingDirectory: SESSION_WORKSPACE_ROOT,
        }
      );
      nextState = {
        ...nextState,
        ...(editorCommand.id ? { editorCommandId: editorCommand.id } : {}),
      };
      editorReady = await waitForHttpReady(joinUrl(editorUrl, '/healthz'), editorHeaders, DEFAULT_EDITOR_WAIT_MS);
    }

    if (editorReady) {
      nextState = {
        ...nextState,
        editorUrl,
        editorHeaders: editorEndpoint.headers,
      };
    }

    return nextState;
  }

  private gatewayCommand(plan?: WorkspaceRuntimePlan, gatewayToken?: string): string {
    const exports = Object.entries({
      ...(gatewayToken ? { [LIFECYCLE_GATEWAY_TOKEN_ENV]: gatewayToken } : {}),
      ...this.gatewayRuntimeEnv(plan),
    }).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
    return ['mkdir -p /tmp', ...exports, 'exec node /opt/lifecycle-workspace-gateway/index.mjs'].join('\n');
  }

  private async waitForSandboxRunning(sandboxId: string, timeoutMs: number, pollMs: number): Promise<void> {
    await this.waitForSandboxState(sandboxId, 'Running', timeoutMs, pollMs);
  }

  private async waitForSandboxPaused(sandboxId: string, timeoutMs: number, pollMs: number): Promise<void> {
    await this.waitForSandboxState(sandboxId, 'Paused', timeoutMs, pollMs);
  }

  private async waitForSandboxState(
    sandboxId: string,
    expectedState: 'Running' | 'Paused',
    timeoutMs: number,
    pollMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastState = 'unknown';
    let lastMessage = '';
    let consecutiveNotFound = 0;

    while (Date.now() <= deadline) {
      try {
        const info = await this.getSandbox(sandboxId);
        consecutiveNotFound = 0;
        lastState = info.status?.state || 'unknown';
        lastMessage = info.status?.message || info.status?.reason || '';
        if (lastState === expectedState) {
          return;
        }
        if (lastState === 'Failed' || lastState === 'Terminated') {
          throw new Error(
            `OpenSandbox sandbox ${sandboxId} entered ${lastState} while waiting for ${expectedState}${
              lastMessage ? `: ${lastMessage}` : ''
            }`
          );
        }
      } catch (error) {
        if (error instanceof ProviderApiError) {
          // Tolerate transient API failures until the deadline; only a persistent 404 means gone.
          if (error.status === 404 && ++consecutiveNotFound >= 3) {
            throw error;
          }
          lastMessage = error.message;
        } else {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error(
      `OpenSandbox sandbox ${sandboxId} did not become ${expectedState}; last state=${lastState}${
        lastMessage ? `: ${lastMessage}` : ''
      }`
    );
  }

  private async resolveExecdState(state: OpenSandboxRuntimeProviderState): Promise<OpenSandboxRuntimeProviderState> {
    const endpoint = await this.getEndpoint(state.sandboxId, this.config.execdPort);
    const execdBaseUrl = endpointToUrl(this.config.protocol, endpoint.endpoint);
    const execdHeaders = endpoint.headers;
    await waitForHttp(joinUrl(execdBaseUrl, '/ping'), endpointAccessHeaders(this.config, execdHeaders), 30000);
    return {
      ...state,
      execdBaseUrl,
      execdHeaders,
    };
  }

  private async uploadTextFile(
    state: OpenSandboxRuntimeProviderState,
    path: string,
    content: string,
    mode: number
  ): Promise<void> {
    if (!state.execdBaseUrl) {
      throw new Error('OpenSandbox execd endpoint is not resolved');
    }

    // The API expects modes as decimal digits read as octal (0o700 -> 700).
    const uploadMode = Number.parseInt(mode.toString(8), 10);

    const formData = new FormData();
    formData.append(
      'metadata',
      new Blob([JSON.stringify({ path, mode: uploadMode })], { type: 'application/json' }),
      'metadata'
    );
    formData.append('file', new Blob([content], { type: 'application/octet-stream' }), path.split('/').pop() || 'file');
    const response = await fetch(joinUrl(state.execdBaseUrl, '/files/upload'), {
      method: 'POST',
      headers: endpointAccessHeaders(this.config, state.execdHeaders),
      body: formData,
    });
    if (!response.ok) {
      throw describeOpenSandboxError('OpenSandbox file upload failed', response, await readResponseBody(response));
    }
  }

  private async runCommand(
    state: OpenSandboxRuntimeProviderState,
    command: string,
    opts: {
      background?: boolean;
      workingDirectory?: string;
      timeoutSeconds?: number;
    } = {}
  ): Promise<CommandExecution> {
    if (!state.execdBaseUrl) {
      throw new Error('OpenSandbox execd endpoint is not resolved');
    }

    const response = await fetch(joinUrl(state.execdBaseUrl, '/command'), {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...endpointAccessHeaders(this.config, state.execdHeaders),
      },
      body: JSON.stringify({
        command,
        cwd: opts.workingDirectory,
        background: Boolean(opts.background),
        ...(opts.timeoutSeconds ? { timeout: Math.round(opts.timeoutSeconds * 1000) } : {}),
        envs: {},
      }),
    });

    if (!response.ok) {
      throw describeOpenSandboxError('OpenSandbox command failed', response, await readResponseBody(response));
    }

    const execution: CommandExecution = {
      stdout: [],
      stderr: [],
    };
    for await (const event of parseJsonEventStream(response)) {
      applyCommandEvent(execution, event);
    }

    if (execution.error) {
      const output = [...execution.stderr, ...execution.stdout].join('').trim().slice(-COMMAND_ERROR_OUTPUT_LIMIT);
      throw new Error(`OpenSandbox command failed (${execution.error})${output ? `: ${output}` : ''}`);
    }

    return execution;
  }

  private async getEndpoint(sandboxId: string, port: number): Promise<OpenSandboxEndpoint> {
    const query = this.config.useServerProxy ? '?use_server_proxy=true' : '';
    const data = await this.lifecycleRequest<OpenSandboxEndpoint>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/endpoints/${port}${query}`,
      { method: 'GET' },
      `OpenSandbox endpoint resolution failed for port ${port}`
    );
    if (!readString(data?.endpoint)) {
      throw new Error(`OpenSandbox endpoint resolution failed for port ${port}: missing endpoint`);
    }
    return data;
  }

  private async getSandbox(sandboxId: string): Promise<OpenSandboxInfo> {
    return this.lifecycleRequest<OpenSandboxInfo>(
      `/sandboxes/${encodeURIComponent(sandboxId)}`,
      { method: 'GET' },
      'OpenSandbox get sandbox failed'
    );
  }

  private async deleteSandbox(sandboxId: string): Promise<void> {
    try {
      await this.lifecycleRequest(
        `/sandboxes/${encodeURIComponent(sandboxId)}`,
        { method: 'DELETE' },
        'OpenSandbox delete failed'
      );
    } catch (error) {
      if (!isGoneError(error)) {
        throw error;
      }
    }
  }

  private lifecycleRequest<T = unknown>(pathname: string, init: RequestInit, errorPrefix: string): Promise<T> {
    return apiRequest<T>(
      lifecycleBaseUrl(this.config),
      this.config.apiKey ? { 'OPEN-SANDBOX-API-KEY': this.config.apiKey } : {},
      pathname,
      init,
      errorPrefix,
      OPEN_SANDBOX_PROVIDER
    );
  }
}

export async function testOpenSandboxConnection(
  config: ResolvedAgentSessionWorkspaceBackendConfig
): Promise<WorkspaceBackendTestConnectionResult> {
  const opensandbox = config.opensandbox;
  try {
    await apiRequest(
      lifecycleBaseUrl(opensandbox),
      opensandbox.apiKey ? { 'OPEN-SANDBOX-API-KEY': opensandbox.apiKey } : {},
      '/sandboxes',
      { method: 'GET' },
      'OpenSandbox sandbox list failed',
      OPEN_SANDBOX_PROVIDER
    );
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const details: Record<string, unknown> = { server: lifecycleBaseUrl(opensandbox) };
  if (opensandbox.poolRef) {
    details.pool = opensandbox.poolRef;
  }
  if (opensandbox.image) {
    details.image = opensandbox.image;
  }
  return { ok: true, message: 'Connected to OpenSandbox.', details };
}

export function createOpenSandboxRuntimeService(
  config: ResolvedAgentSessionOpenSandboxBackendConfig
): OpenSandboxRuntimeService {
  getLogger().debug(
    {
      domain: config.domain,
      protocol: config.protocol,
      useServerProxy: config.useServerProxy,
    },
    'OpenSandbox: runtime service configured'
  );
  return new OpenSandboxRuntimeService(config);
}
