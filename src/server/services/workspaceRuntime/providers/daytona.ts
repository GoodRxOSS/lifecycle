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
  buildSessionWorkspaceEditorContents,
} from 'server/lib/agentSession/workspace';
import { generateInitScript, generateRuntimeSeedScript } from 'server/lib/agentSession/configSeeder';
import { generateSkillBootstrapCommand } from 'server/lib/agentSession/skillBootstrap';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import type {
  ResolvedAgentSessionDaytonaBackendConfig,
  ResolvedAgentSessionWorkspaceBackendConfig,
} from 'server/lib/agentSession/runtimeConfig';
import { decryptWorkspaceGatewayToken } from '../gatewayToken';
import {
  WorkspaceRuntimeGoneError,
  WorkspaceRuntimeSecurityError,
  type ReadinessProfile,
  type RemoteProvisionContext,
  type RemoteRuntimeHandle,
  type RemoteWorkspaceRuntimeProvider,
  type WorkspaceBackendCapabilities,
  type WorkspaceBackendCapabilitySnapshot,
  type WorkspaceBackendTestConnectionResult,
  type WorkspaceSourceOption,
  type WorkspaceRuntimeEndpoint,
} from '../types';
import {
  ProviderApiError,
  apiRequest,
  assertGatewayTokenEnforced,
  assertGatewayTokenAccepted,
  assertNoExternalSecretRefs,
  buildBootstrapScript,
  buildInitScriptOpts,
  buildSandboxBaseEnv,
  buildSessionRuntimeEnv,
  codeServerCommand,
  isGoneError,
  isHttpReady,
  isRecord,
  joinUrl,
  readString,
  readStringRecord,
  scrubSecrets,
  waitForHttp,
  waitForHttpReady,
} from './shared';

export const DAYTONA_PROVIDER = 'daytona';

export const DAYTONA_PREVIEW_TOKEN_HEADER = 'x-daytona-preview-token';
const BOOTSTRAP_SESSION_ID = 'lifecycle-bootstrap';
const GATEWAY_SESSION_ID = 'lifecycle-gateway';
const EDITOR_SESSION_ID = 'lifecycle-editor';
const BOOTSTRAP_SCRIPT_PATH = '/run/lifecycle/bootstrap.sh';
const INIT_SCRIPT_PATH = '/run/lifecycle/init-workspace.sh';
const SEED_SCRIPT_PATH = '/run/lifecycle/runtime-seed.sh';
const SKILLS_SCRIPT_PATH = '/run/lifecycle/skills-bootstrap.sh';
const BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000;
const GATEWAY_WAIT_MS = 30000;
const DEFAULT_EDITOR_WAIT_MS = 15000;
const DEFAULT_SUSPEND_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SUSPEND_POLL_MS = 2000;
// Archived sandboxes restore from object storage; give them a longer runway than warm starts.
const ARCHIVED_RESTORE_TIMEOUT_MULTIPLIER = 3;
const COMMAND_ERROR_OUTPUT_LIMIT = 2000;

export const DAYTONA_DECLARED_CAPABILITIES: WorkspaceBackendCapabilities = {
  newChatWorkspaces: { supported: true },
  developWorkspaces: { supported: false },
  environmentSessions: { supported: false },
  sandboxSessions: { supported: true },
  editor: { supported: true, note: 'Available when the workspace image bundles code-server.' },
  previewPorts: { supported: true },
  hibernateResume: { supported: true, note: 'Stop/start.' },
  prewarm: { supported: false },
};

export interface DaytonaRuntimeProviderState {
  [key: string]: unknown;
  sandboxId: string;
  apiUrl: string;
  gatewayUrl?: string;
  gatewayHeaders?: Record<string, string>;
  // null clears a stale editor across the shallow merge (delete would leave the old value lingering).
  editorUrl?: string | null;
  editorHeaders?: Record<string, string> | null;
  /** Encrypted gateway bearer token (ciphertext only; merged by orchestration). */
  gatewayToken?: string;
}

const STATE_STRING_KEYS = ['gatewayUrl', 'editorUrl', 'gatewayToken'] as const;
const STATE_RECORD_KEYS = ['gatewayHeaders', 'editorHeaders'] as const;

export function readDaytonaProviderState(value: unknown): DaytonaRuntimeProviderState | null {
  if (!isRecord(value)) {
    return null;
  }

  const sandboxId = readString(value.sandboxId);
  const apiUrl = readString(value.apiUrl);
  if (!sandboxId || !apiUrl) {
    return null;
  }

  const state: DaytonaRuntimeProviderState = { sandboxId, apiUrl };
  for (const key of STATE_STRING_KEYS) {
    const parsed = readString(value[key]);
    if (parsed) {
      state[key] = parsed;
    }
  }
  for (const key of STATE_RECORD_KEYS) {
    const parsed = readStringRecord(value[key]);
    if (parsed) {
      state[key] = parsed;
    }
  }
  return state;
}

interface DaytonaSandboxResponse {
  id?: string;
  state?: string;
  errorReason?: string | null;
}

interface DaytonaPreviewUrlResponse {
  url?: string;
  token?: string;
}

function previewHeaders(token?: string): Record<string, string> {
  return token ? { [DAYTONA_PREVIEW_TOKEN_HEADER]: token } : {};
}

const GONE_SANDBOX_STATES = new Set(['destroyed', 'destroying']);
const FAILED_SANDBOX_STATES = new Set(['error', 'build_failed']);

function daytonaRequest<T = unknown>(
  config: ResolvedAgentSessionDaytonaBackendConfig,
  pathname: string,
  init: RequestInit,
  errorPrefix: string
): Promise<T> {
  return apiRequest<T>(
    config.apiUrl,
    { Authorization: `Bearer ${config.apiKey || ''}` },
    pathname,
    init,
    errorPrefix,
    DAYTONA_PROVIDER
  );
}

export class DaytonaRuntimeService implements RemoteWorkspaceRuntimeProvider {
  readonly backendId = DAYTONA_PROVIDER;

  constructor(private readonly config: ResolvedAgentSessionDaytonaBackendConfig) {}

  private requireState(state: unknown): DaytonaRuntimeProviderState {
    const parsed = readDaytonaProviderState(state);
    if (!parsed) {
      throw new Error('Daytona provider state is missing required fields');
    }
    return parsed;
  }

  private request<T = unknown>(pathname: string, init: RequestInit, errorPrefix: string): Promise<T> {
    return daytonaRequest<T>(this.config, pathname, init, errorPrefix);
  }

  private toolboxPath(sandboxId: string, pathname: string): string {
    return `/toolbox/${encodeURIComponent(sandboxId)}/toolbox${pathname}`;
  }

  private toHandle(state: DaytonaRuntimeProviderState): RemoteRuntimeHandle {
    return {
      providerState: state,
      capabilitySnapshot: this.capabilities(state),
      podNameAlias: state.sandboxId,
    };
  }

  async provision(ctx: RemoteProvisionContext): Promise<RemoteRuntimeHandle> {
    const { plan } = ctx;
    if (!this.config.apiKey) {
      throw new Error('Daytona workspace backend requires an API key.');
    }
    if (!this.config.snapshot) {
      throw new Error('Daytona workspace backend requires a snapshot.');
    }
    assertNoExternalSecretRefs(plan, 'Daytona');

    const created = await this.createSandbox(plan, ctx);
    const sandboxId = readString(created?.id);
    if (!sandboxId) {
      throw new Error('Daytona create failed: missing sandbox id');
    }

    let state: DaytonaRuntimeProviderState = { sandboxId, apiUrl: this.config.apiUrl };
    try {
      await this.waitForSandboxState(sandboxId, 'started', ctx.readiness.timeoutMs, ctx.readiness.pollMs);
      await this.runBootstrap(state, plan, ctx);
      state = await this.ensureRuntimeEndpoints(state, {
        expectEnforcement: Boolean(ctx.gatewayToken),
        expectedGatewayToken: ctx.gatewayToken,
      });
      return this.toHandle(state);
    } catch (error) {
      await this.deleteSandbox(sandboxId).catch(() => {});
      throw error;
    }
  }

  /** Reconnects (starting a stopped/archived sandbox); null when gone so the caller provisions fresh. */
  async reattach(state: unknown, readiness: ReadinessProfile): Promise<RemoteRuntimeHandle | null> {
    const parsed = readDaytonaProviderState(state);
    if (!parsed) {
      return null;
    }

    let info: DaytonaSandboxResponse;
    try {
      info = await this.getSandbox(parsed.sandboxId);
    } catch (error) {
      if (isGoneError(error)) {
        return null;
      }
      throw error;
    }

    if (GONE_SANDBOX_STATES.has(info.state || '')) {
      return null;
    }
    if (FAILED_SANDBOX_STATES.has(info.state || '')) {
      await this.deleteSandbox(parsed.sandboxId).catch(() => {});
      return null;
    }

    try {
      const nextState = await this.startAndVerify(parsed, info, readiness);
      return this.toHandle(nextState);
    } catch (error) {
      // Raced into destruction while reattaching: treat as gone so the caller provisions fresh.
      if (isGoneError(error)) {
        return null;
      }
      throw error;
    }
  }

  async resume(state: unknown, readiness: ReadinessProfile): Promise<RemoteRuntimeHandle> {
    const parsed = this.requireState(state);
    try {
      const info = await this.getSandbox(parsed.sandboxId);
      if (GONE_SANDBOX_STATES.has(info.state || '')) {
        throw new WorkspaceRuntimeGoneError(`Daytona sandbox ${parsed.sandboxId} was destroyed`);
      }
      const nextState = await this.startAndVerify(parsed, info, readiness);
      return this.toHandle(nextState);
    } catch (error) {
      if (isGoneError(error)) {
        throw new WorkspaceRuntimeGoneError(`Daytona sandbox ${parsed.sandboxId} no longer exists`, error);
      }
      throw error;
    }
  }

  /** Sessions (and the gateway they ran) die on stop; preview tokens rotate on restart. */
  private async startAndVerify(
    state: DaytonaRuntimeProviderState,
    info: DaytonaSandboxResponse,
    readiness: ReadinessProfile
  ): Promise<DaytonaRuntimeProviderState> {
    if (info.state !== 'started') {
      await this.request(
        `/sandbox/${encodeURIComponent(state.sandboxId)}/start`,
        { method: 'POST' },
        'Daytona start failed'
      );
      const timeoutMs =
        info.state === 'archived' ? readiness.timeoutMs * ARCHIVED_RESTORE_TIMEOUT_MULTIPLIER : readiness.timeoutMs;
      await this.waitForSandboxState(state.sandboxId, 'started', timeoutMs, readiness.pollMs);
    }

    return this.ensureRuntimeEndpoints(state, {
      expectEnforcement: Boolean(state.gatewayToken),
      expectedGatewayToken: state.gatewayToken ? decryptWorkspaceGatewayToken(state.gatewayToken) : undefined,
    });
  }

  async suspend(state: unknown, _opts: { retainForMs: number }): Promise<void> {
    // Stopped sandboxes persist their filesystem; auto-archive (≤30 days stopped) stays resumable.
    const parsed = this.requireState(state);
    try {
      await this.request(
        `/sandbox/${encodeURIComponent(parsed.sandboxId)}/stop`,
        { method: 'POST' },
        'Daytona stop failed'
      );
      await this.waitForSandboxState(parsed.sandboxId, 'stopped', DEFAULT_SUSPEND_TIMEOUT_MS, DEFAULT_SUSPEND_POLL_MS);
    } catch (error) {
      if (isGoneError(error)) {
        throw new WorkspaceRuntimeGoneError(`Daytona sandbox ${parsed.sandboxId} no longer exists`, error);
      }
      throw error;
    }
  }

  async destroy(state: unknown): Promise<void> {
    // Mirror reattach's null contract: a never-provisioned/unparseable state has nothing to destroy.
    const parsed = readDaytonaProviderState(state);
    if (!parsed) {
      return;
    }
    await this.deleteSandbox(parsed.sandboxId);
  }

  resolveGatewayEndpoint(state: unknown): WorkspaceRuntimeEndpoint | null {
    const parsed = readDaytonaProviderState(state);
    if (!parsed?.gatewayUrl) {
      return null;
    }
    return {
      url: parsed.gatewayUrl,
      ...(parsed.gatewayHeaders ? { headers: parsed.gatewayHeaders } : {}),
    };
  }

  resolveEditorEndpoint(state: unknown): WorkspaceRuntimeEndpoint | null {
    const parsed = readDaytonaProviderState(state);
    if (!parsed?.editorUrl) {
      return null;
    }
    return {
      url: parsed.editorUrl,
      ...(parsed.editorHeaders ? { headers: parsed.editorHeaders } : {}),
    };
  }

  hasPersistedHandle(state: unknown): boolean {
    return readDaytonaProviderState(state) !== null;
  }

  capabilities(state?: unknown): WorkspaceBackendCapabilitySnapshot {
    const parsed = readDaytonaProviderState(state);
    return {
      ...DAYTONA_DECLARED_CAPABILITIES,
      backend: DAYTONA_PROVIDER,
      editorAccess: Boolean(parsed?.editorUrl),
    };
  }

  private async createSandbox(
    plan: WorkspaceRuntimePlan,
    ctx: RemoteProvisionContext
  ): Promise<DaytonaSandboxResponse> {
    const body = {
      snapshot: this.config.snapshot,
      env: this.buildSandboxEnv(plan, ctx),
      labels: {
        lifecycleSessionUuid: plan.sessionUuid,
        lifecycleKind: plan.kind,
      },
      // Only Lifecycle decides when a workspace stops; auto-archive caps cold-storage retention.
      autoStopInterval: 0,
      autoArchiveInterval: this.config.autoArchiveInterval,
      autoDeleteInterval: -1,
      public: false,
      ...(this.config.target ? { target: this.config.target } : {}),
    };

    try {
      return await this.request<DaytonaSandboxResponse>(
        '/sandbox',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        'Daytona create failed'
      );
    } catch (error) {
      // Snapshots auto-deactivate after two weeks unused; activate and retry once.
      if (error instanceof ProviderApiError && /inactive/i.test(error.message)) {
        await this.request(
          `/snapshots/${encodeURIComponent(this.config.snapshot as string)}/activate`,
          { method: 'POST' },
          'Daytona snapshot activate failed'
        );
        return this.request<DaytonaSandboxResponse>(
          '/sandbox',
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
          'Daytona create failed'
        );
      }
      throw error;
    }
  }

  private buildSandboxEnv(plan: WorkspaceRuntimePlan, ctx: RemoteProvisionContext): Record<string, string> {
    // Create-time env reaches the entrypoint and every toolbox session shell.
    return buildSandboxBaseEnv(plan, ctx, buildSessionRuntimeEnv(plan, this.config.gatewayPort));
  }

  private async runBootstrap(
    state: DaytonaRuntimeProviderState,
    plan: WorkspaceRuntimePlan,
    ctx: RemoteProvisionContext
  ): Promise<void> {
    const initScriptOpts = buildInitScriptOpts(plan, ctx);

    const files: Array<{ path: string; content: string }> = [
      { path: INIT_SCRIPT_PATH, content: generateInitScript(initScriptOpts) },
      { path: SEED_SCRIPT_PATH, content: generateRuntimeSeedScript(initScriptOpts) },
      ...((plan.skillPlan?.skills || []).length > 0
        ? [
            {
              path: SKILLS_SCRIPT_PATH,
              content: generateSkillBootstrapCommand(plan.skillPlan, {
                useGitHubToken: plan.credentials.hasGitHubToken,
              }),
            },
          ]
        : []),
      {
        path: SESSION_WORKSPACE_EDITOR_PROJECT_FILE,
        content: buildSessionWorkspaceEditorContents(plan.servicePlan.workspaceRepos),
      },
      {
        path: BOOTSTRAP_SCRIPT_PATH,
        content: buildBootstrapScript(
          plan,
          { init: INIT_SCRIPT_PATH, seed: SEED_SCRIPT_PATH, skills: SKILLS_SCRIPT_PATH },
          { includeMkdir: true }
        ),
      },
    ];
    await this.bulkUploadFiles(state.sandboxId, files);
    for (const file of files) {
      if (file.path.endsWith('.sh')) {
        await this.request(
          this.toolboxPath(state.sandboxId, `/files/permissions?path=${encodeURIComponent(file.path)}&mode=0755`),
          { method: 'POST' },
          'Daytona file permissions failed'
        );
      }
    }

    await this.createSession(state.sandboxId, BOOTSTRAP_SESSION_ID);
    const { cmdId } = await this.execSessionCommand(
      state.sandboxId,
      BOOTSTRAP_SESSION_ID,
      `sh ${BOOTSTRAP_SCRIPT_PATH}`
    );
    await this.waitForCommandSuccess(state.sandboxId, BOOTSTRAP_SESSION_ID, cmdId);
    // The bootstrap command has exited; deleting its session kills nothing that is still needed.
    await this.deleteSession(state.sandboxId, BOOTSTRAP_SESSION_ID).catch(() => {});
  }

  private gatewayCommand(): string {
    return ['mkdir -p /tmp', 'node /opt/lifecycle-workspace-gateway/index.mjs'].join('\n');
  }

  /**
   * One dedicated session per background process; deleting a session kills its whole process
   * group, so the gateway/editor sessions are recreated (never reused) and then left alive.
   */
  private async restartBackgroundSession(sandboxId: string, sessionId: string, command: string): Promise<void> {
    await this.deleteSession(sandboxId, sessionId).catch(() => {});
    await this.createSession(sandboxId, sessionId);
    await this.execSessionCommand(sandboxId, sessionId, command);
  }

  private async ensureRuntimeEndpoints(
    state: DaytonaRuntimeProviderState,
    opts: { expectEnforcement: boolean; expectedGatewayToken?: string }
  ): Promise<DaytonaRuntimeProviderState> {
    // Preview URLs/tokens rotate on restart: always re-resolve, never reuse the persisted ones.
    const gatewayPreview = await this.getPortPreviewUrl(state.sandboxId, this.config.gatewayPort);
    const gatewayHeaders = previewHeaders(gatewayPreview.token);

    if (!(await isHttpReady(joinUrl(gatewayPreview.url, '/health'), gatewayHeaders, 1000))) {
      await this.restartBackgroundSession(state.sandboxId, GATEWAY_SESSION_ID, this.gatewayCommand());
      await waitForHttp(joinUrl(gatewayPreview.url, '/health'), gatewayHeaders, GATEWAY_WAIT_MS);
    }

    if (opts.expectEnforcement) {
      await assertGatewayTokenEnforced(gatewayPreview.url, gatewayHeaders);
      if (!opts.expectedGatewayToken) {
        throw new WorkspaceRuntimeSecurityError(
          'Workspace gateway token is required to verify Daytona gateway access.'
        );
      }
      await assertGatewayTokenAccepted(gatewayPreview.url, gatewayHeaders, opts.expectedGatewayToken);
    }

    let nextState: DaytonaRuntimeProviderState = {
      ...state,
      gatewayUrl: gatewayPreview.url,
      gatewayHeaders,
      // Explicit nulls: persisted remote state is shallow-merged, so deletes would leave a stale editor
      // (with a rotated, invalid preview token) presented as 'ready'.
      editorUrl: null,
      editorHeaders: null,
    };

    const editorPreview = await this.getPortPreviewUrl(state.sandboxId, this.config.editorPort).catch(() => null);
    if (!editorPreview) {
      return nextState;
    }

    const editorHeaders = previewHeaders(editorPreview.token);
    let editorReady = await isHttpReady(joinUrl(editorPreview.url, '/healthz'), editorHeaders, 1000);
    if (!editorReady) {
      await this.restartBackgroundSession(
        state.sandboxId,
        EDITOR_SESSION_ID,
        codeServerCommand(this.config.editorPort, 'Daytona')
      );
      editorReady = await waitForHttpReady(
        joinUrl(editorPreview.url, '/healthz'),
        editorHeaders,
        DEFAULT_EDITOR_WAIT_MS
      );
    }

    if (editorReady) {
      nextState = {
        ...nextState,
        editorUrl: editorPreview.url,
        editorHeaders,
      };
    }

    return nextState;
  }

  private async getPortPreviewUrl(sandboxId: string, port: number): Promise<{ url: string; token?: string }> {
    const preview = await this.request<DaytonaPreviewUrlResponse>(
      `/sandbox/${encodeURIComponent(sandboxId)}/ports/${port}/preview-url`,
      { method: 'GET' },
      `Daytona preview-url resolution failed for port ${port}`
    );
    const url = readString(preview?.url);
    if (!url) {
      throw new Error(`Daytona preview-url resolution failed for port ${port}: missing url`);
    }
    return { url, ...(readString(preview?.token) ? { token: readString(preview?.token) } : {}) };
  }

  private async createSession(sandboxId: string, sessionId: string): Promise<void> {
    await this.request(
      this.toolboxPath(sandboxId, '/process/session'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      },
      'Daytona session create failed'
    );
  }

  private async deleteSession(sandboxId: string, sessionId: string): Promise<void> {
    await this.request(
      this.toolboxPath(sandboxId, `/process/session/${encodeURIComponent(sessionId)}`),
      { method: 'DELETE' },
      'Daytona session delete failed'
    );
  }

  private async execSessionCommand(sandboxId: string, sessionId: string, command: string): Promise<{ cmdId: string }> {
    const result = await this.request<{ cmdId?: string }>(
      this.toolboxPath(sandboxId, `/process/session/${encodeURIComponent(sessionId)}/exec`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, runAsync: true }),
      },
      'Daytona session exec failed'
    );
    const cmdId = readString(result?.cmdId);
    if (!cmdId) {
      throw new Error('Daytona session exec failed: missing command id');
    }
    return { cmdId };
  }

  private async waitForCommandSuccess(sandboxId: string, sessionId: string, cmdId: string): Promise<void> {
    const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const command = await this.request<{ exitCode?: number | null }>(
        this.toolboxPath(sandboxId, `/process/session/${encodeURIComponent(sessionId)}/command/${cmdId}`),
        { method: 'GET' },
        'Daytona command status failed'
      );
      const exitCode = command?.exitCode;
      if (typeof exitCode === 'number') {
        if (exitCode === 0) {
          return;
        }
        const logs = await this.request<unknown>(
          this.toolboxPath(sandboxId, `/process/session/${encodeURIComponent(sessionId)}/command/${cmdId}/logs`),
          { method: 'GET' },
          'Daytona command logs failed'
        ).catch(() => '');
        const output = typeof logs === 'string' ? logs : JSON.stringify(logs);
        throw new Error(
          `Daytona bootstrap failed (exit code ${exitCode})${
            output ? `: ${output.trim().slice(-COMMAND_ERROR_OUTPUT_LIMIT)}` : ''
          }`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error('Daytona bootstrap did not complete in time');
  }

  private async bulkUploadFiles(sandboxId: string, files: Array<{ path: string; content: string }>): Promise<void> {
    const formData = new FormData();
    files.forEach((file, index) => {
      // The path part must precede its file part.
      formData.append(`files[${index}].path`, file.path);
      formData.append(
        `files[${index}].file`,
        new Blob([file.content], { type: 'application/octet-stream' }),
        file.path.split('/').pop() || 'file'
      );
    });
    await this.request(
      this.toolboxPath(sandboxId, '/files/bulk-upload'),
      { method: 'POST', body: formData },
      'Daytona file upload failed'
    );
  }

  private async getSandbox(sandboxId: string): Promise<DaytonaSandboxResponse> {
    return this.request<DaytonaSandboxResponse>(
      `/sandbox/${encodeURIComponent(sandboxId)}`,
      { method: 'GET' },
      'Daytona get sandbox failed'
    );
  }

  private async waitForSandboxState(
    sandboxId: string,
    expectedState: 'started' | 'stopped',
    timeoutMs: number,
    pollMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastState = 'unknown';
    let lastReason = '';

    while (Date.now() <= deadline) {
      const info = await this.getSandbox(sandboxId);
      lastState = info.state || 'unknown';
      lastReason = readString(info.errorReason) || '';
      if (lastState === expectedState) {
        return;
      }
      if (FAILED_SANDBOX_STATES.has(lastState)) {
        throw new Error(
          `Daytona sandbox ${sandboxId} entered ${lastState} while waiting for ${expectedState}${
            lastReason ? `: ${lastReason}` : ''
          }`
        );
      }
      if (GONE_SANDBOX_STATES.has(lastState)) {
        throw new ProviderApiError(`Daytona sandbox ${sandboxId} was destroyed`, 404, DAYTONA_PROVIDER);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error(
      `Daytona sandbox ${sandboxId} did not become ${expectedState}; last state=${lastState}${
        lastReason ? `: ${lastReason}` : ''
      }`
    );
  }

  private async deleteSandbox(sandboxId: string): Promise<void> {
    try {
      await this.request(`/sandbox/${encodeURIComponent(sandboxId)}`, { method: 'DELETE' }, 'Daytona delete failed');
    } catch (error) {
      if (!isGoneError(error)) {
        throw error;
      }
    }
  }
}

export function createDaytonaRuntimeService(config: ResolvedAgentSessionDaytonaBackendConfig): DaytonaRuntimeService {
  return new DaytonaRuntimeService(config);
}

const REQUIRED_DAYTONA_SCOPES = ['write:sandboxes', 'delete:sandboxes'];

export async function listDaytonaWorkspaceSources(
  config: ResolvedAgentSessionWorkspaceBackendConfig
): Promise<WorkspaceSourceOption[]> {
  const daytona = config.daytona;
  if (!daytona?.apiKey) {
    throw new Error('Daytona API key is not configured.');
  }

  const snapshots = await daytonaRequest<unknown>(
    daytona,
    '/snapshots',
    { method: 'GET' },
    'Daytona snapshot list failed'
  );
  const items = Array.isArray(snapshots)
    ? snapshots
    : isRecord(snapshots) && Array.isArray(snapshots.items)
    ? snapshots.items
    : [];

  return items
    .filter((entry: unknown): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => {
      const name = readString(entry.name);
      const id = readString(entry.id);
      const state = readString(entry.state);
      return {
        // Stored config matches by name first; fall back to the raw id.
        id: name || id || '',
        label: name || id || '',
        detail: state || undefined,
        ready: !state || state === 'active',
      };
    })
    .filter((option) => option.id)
    .sort((left, right) => Number(right.ready) - Number(left.ready) || left.label.localeCompare(right.label));
}

export async function testDaytonaConnection(
  config: ResolvedAgentSessionWorkspaceBackendConfig
): Promise<WorkspaceBackendTestConnectionResult> {
  const daytona = config.daytona;
  if (!daytona?.apiKey) {
    return { ok: false, message: 'Daytona API key is not configured.' };
  }
  if (!daytona.snapshot) {
    return { ok: false, message: 'Daytona snapshot is not configured.' };
  }

  try {
    const apiKeyInfo = await daytonaRequest<{ permissions?: string[] }>(
      daytona,
      '/api-keys/current',
      { method: 'GET' },
      'Daytona api-key check failed'
    );
    const permissions = Array.isArray(apiKeyInfo?.permissions) ? apiKeyInfo.permissions : [];
    const missingScopes = REQUIRED_DAYTONA_SCOPES.filter((scope) => !permissions.includes(scope));
    if (missingScopes.length > 0) {
      return {
        ok: false,
        message: `Daytona API key is missing required scopes: ${missingScopes.join(', ')}.`,
        details: { permissions },
      };
    }

    const snapshots = await daytonaRequest<unknown>(
      daytona,
      `/snapshots?name=${encodeURIComponent(daytona.snapshot)}`,
      { method: 'GET' },
      'Daytona snapshot lookup failed'
    );
    const items = Array.isArray(snapshots)
      ? snapshots
      : isRecord(snapshots) && Array.isArray(snapshots.items)
      ? snapshots.items
      : [];
    const snapshot = items.find(
      (entry: unknown) => isRecord(entry) && (entry.name === daytona.snapshot || entry.id === daytona.snapshot)
    ) as { state?: string } | undefined;
    if (!snapshot) {
      return { ok: false, message: `Daytona snapshot "${daytona.snapshot}" was not found.` };
    }
    if (snapshot.state && snapshot.state !== 'active') {
      return {
        ok: false,
        message: `Daytona snapshot "${daytona.snapshot}" is not active (state: ${snapshot.state}); provisioning will attempt activation automatically.`,
        details: { permissions, snapshotState: snapshot.state },
      };
    }

    return {
      ok: true,
      message: 'Daytona connection verified.',
      details: { permissions, snapshotState: snapshot.state || 'active' },
    };
  } catch (error) {
    if (error instanceof ProviderApiError && error.status === 401) {
      return { ok: false, message: 'Daytona rejected the configured API key.' };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: scrubSecrets(message, [daytona.apiKey]) };
  }
}
