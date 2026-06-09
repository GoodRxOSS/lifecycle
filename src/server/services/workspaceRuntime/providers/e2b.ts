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
import { DEFAULT_E2B_TIMEOUT_SECONDS } from 'server/lib/agentSession/runtimeDefaults';
import type {
  ResolvedAgentSessionE2bBackendConfig,
  ResolvedAgentSessionWorkspaceBackendConfig,
} from 'server/lib/agentSession/runtimeConfig';
import { getLogger } from 'server/lib/logger';
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
  buildShellEnvFile,
  extractHttpErrorMessage,
  isGoneError,
  isHttpReady,
  isRecord,
  joinUrl,
  readResponseBody,
  readString,
  readStringRecord,
  scrubSecrets,
  waitForHttp,
  waitForHttpReady,
} from './shared';

export { ProviderApiError as E2bApiError } from './shared';

export const E2B_PROVIDER = 'e2b';

export const E2B_TRAFFIC_TOKEN_HEADER = 'e2b-traffic-access-token';
const ENVD_ACCESS_TOKEN_HEADER = 'X-Access-Token';
const ENVD_PORT = 49983;
const INSTANCE_ENV_PATH = '/tmp/lifecycle/instance.env';
const BOOTSTRAP_SCRIPT_PATH = '/tmp/lifecycle/bootstrap.sh';
const INIT_SCRIPT_PATH = '/tmp/lifecycle/init-workspace.sh';
const SEED_SCRIPT_PATH = '/tmp/lifecycle/runtime-seed.sh';
const SKILLS_SCRIPT_PATH = '/tmp/lifecycle/skills-bootstrap.sh';
// The launcher runs clone+install before starting the gateway, so the gateway wait covers bootstrap.
const GATEWAY_READY_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_EDITOR_WAIT_MS = 15000;

export const E2B_DECLARED_CAPABILITIES: WorkspaceBackendCapabilities = {
  newChatWorkspaces: { supported: true },
  developWorkspaces: { supported: false },
  environmentSessions: { supported: false },
  sandboxSessions: { supported: true },
  editor: { supported: true, note: 'Available when the workspace image bundles code-server.' },
  previewPorts: { supported: true },
  hibernateResume: { supported: true, note: 'Pause/connect.' },
  prewarm: { supported: false },
};

export interface E2bRuntimeProviderState {
  [key: string]: unknown;
  sandboxId: string;
  domain: string;
  envdAccessToken?: string;
  trafficAccessToken?: string;
  expiresAt?: string;
  // null clears a stale editor across the shallow merge (delete would leave the old value lingering).
  editorUrl?: string | null;
  editorHeaders?: Record<string, string> | null;
  /** Encrypted gateway bearer token (ciphertext only; merged by orchestration). */
  gatewayToken?: string;
}

const STATE_STRING_KEYS = ['envdAccessToken', 'trafficAccessToken', 'expiresAt', 'editorUrl', 'gatewayToken'] as const;

export function readE2bProviderState(value: unknown): E2bRuntimeProviderState | null {
  if (!isRecord(value)) {
    return null;
  }

  const sandboxId = readString(value.sandboxId);
  const domain = readString(value.domain);
  if (!sandboxId || !domain) {
    return null;
  }

  const state: E2bRuntimeProviderState = { sandboxId, domain };
  for (const key of STATE_STRING_KEYS) {
    const parsed = readString(value[key]);
    if (parsed) {
      state[key] = parsed;
    }
  }
  const editorHeaders = readStringRecord(value.editorHeaders);
  if (editorHeaders) {
    state.editorHeaders = editorHeaders;
  }
  return state;
}

interface E2bSandboxResponse {
  sandboxID?: string;
  domain?: string | null;
  envdAccessToken?: string | null;
  trafficAccessToken?: string | null;
  state?: string;
  endAt?: string;
}

function e2bControlRequest<T = unknown>(
  config: ResolvedAgentSessionE2bBackendConfig,
  pathname: string,
  init: RequestInit,
  errorPrefix: string
): Promise<T> {
  return apiRequest<T>(
    `https://api.${config.domain}`,
    { 'X-API-Key': config.apiKey || '' },
    pathname,
    init,
    errorPrefix,
    E2B_PROVIDER
  );
}

export class E2bRuntimeService implements RemoteWorkspaceRuntimeProvider {
  readonly backendId = E2B_PROVIDER;

  constructor(private readonly config: ResolvedAgentSessionE2bBackendConfig) {}

  private requireState(state: unknown): E2bRuntimeProviderState {
    const parsed = readE2bProviderState(state);
    if (!parsed) {
      throw new Error('E2B provider state is missing required fields');
    }
    return parsed;
  }

  private host(state: E2bRuntimeProviderState, port: number): string {
    return `https://${port}-${state.sandboxId}.${state.domain}`;
  }

  private trafficHeaders(state: E2bRuntimeProviderState): Record<string, string> {
    return state.trafficAccessToken ? { [E2B_TRAFFIC_TOKEN_HEADER]: state.trafficAccessToken } : {};
  }

  private controlRequest<T = unknown>(pathname: string, init: RequestInit, errorPrefix: string): Promise<T> {
    return e2bControlRequest<T>(this.config, pathname, init, errorPrefix);
  }

  private toHandle(state: E2bRuntimeProviderState): RemoteRuntimeHandle {
    return {
      providerState: state,
      capabilitySnapshot: this.capabilities(state),
      podNameAlias: state.sandboxId,
    };
  }

  async provision(ctx: RemoteProvisionContext): Promise<RemoteRuntimeHandle> {
    const { plan } = ctx;
    if (!this.config.apiKey) {
      throw new Error('E2B workspace backend requires an API key.');
    }
    if (!this.config.templateId) {
      throw new Error('E2B workspace backend requires a template.');
    }
    assertNoExternalSecretRefs(plan, 'E2B');

    const created = await this.controlRequest<E2bSandboxResponse>(
      '/sandboxes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          templateID: this.config.templateId,
          // REST default is 15 seconds; an implicit timeout would reap the sandbox mid-bootstrap.
          timeout: this.config.timeoutSeconds ?? DEFAULT_E2B_TIMEOUT_SECONDS,
          autoPause: this.config.autoPause,
          // SECURITY: secure gates envd behind X-Access-Token; without it envd is public arbitrary exec.
          secure: true,
          network: { allowPublicTraffic: false },
          metadata: {
            lifecycleSessionUuid: plan.sessionUuid,
            lifecycleKind: plan.kind,
          },
          envVars: this.runtimeEnv(plan),
        }),
      },
      'E2B create failed'
    );
    const sandboxId = readString(created?.sandboxID);
    if (!sandboxId) {
      throw new Error('E2B create failed: missing sandbox id');
    }

    let state: E2bRuntimeProviderState = {
      sandboxId,
      domain: readString(created?.domain) || this.config.domain,
      ...(readString(created?.envdAccessToken) ? { envdAccessToken: readString(created?.envdAccessToken) } : {}),
      ...(readString(created?.trafficAccessToken)
        ? { trafficAccessToken: readString(created?.trafficAccessToken) }
        : {}),
      ...(readString(created?.endAt) ? { expiresAt: readString(created?.endAt) } : {}),
    };

    try {
      await waitForHttp(joinUrl(this.host(state, ENVD_PORT), '/health'), {}, ctx.readiness.timeoutMs);
      await this.deliverBootstrapFiles(state, plan, ctx);
      state = await this.verifyRuntimeEndpoints(state, {
        expectEnforcement: Boolean(ctx.gatewayToken),
        expectedGatewayToken: ctx.gatewayToken,
        editorWaitMs: DEFAULT_EDITOR_WAIT_MS,
      });
      return this.toHandle(state);
    } catch (error) {
      await this.deleteSandbox(sandboxId).catch(() => {});
      throw error;
    }
  }

  /** Reconnects (resuming if paused); null when the sandbox is gone so the caller provisions fresh. */
  async reattach(state: unknown, readiness: ReadinessProfile): Promise<RemoteRuntimeHandle | null> {
    const parsed = readE2bProviderState(state);
    if (!parsed) {
      return null;
    }

    try {
      await this.controlRequest<E2bSandboxResponse>(
        `/sandboxes/${encodeURIComponent(parsed.sandboxId)}`,
        { method: 'GET' },
        'E2B get sandbox failed'
      );
    } catch (error) {
      if (isGoneError(error)) {
        return null;
      }
      throw error;
    }

    try {
      const nextState = await this.connectSandbox(parsed, readiness);
      return this.toHandle(nextState);
    } catch (error) {
      // Raced its TTL while reattaching: treat as gone so the caller provisions fresh.
      if (isGoneError(error)) {
        return null;
      }
      throw error;
    }
  }

  async resume(state: unknown, readiness: ReadinessProfile): Promise<RemoteRuntimeHandle> {
    const parsed = this.requireState(state);
    try {
      const nextState = await this.connectSandbox(parsed, readiness);
      return this.toHandle(nextState);
    } catch (error) {
      if (isGoneError(error)) {
        throw new WorkspaceRuntimeGoneError(`E2B sandbox ${parsed.sandboxId} no longer exists`, error);
      }
      throw error;
    }
  }

  /** POST /connect resumes a paused sandbox (201) or extends a running one (200); tokens may rotate. */
  private async connectSandbox(
    state: E2bRuntimeProviderState,
    readiness: ReadinessProfile
  ): Promise<E2bRuntimeProviderState> {
    const connected = await this.controlRequest<E2bSandboxResponse>(
      `/sandboxes/${encodeURIComponent(state.sandboxId)}/connect`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeout: this.config.timeoutSeconds ?? DEFAULT_E2B_TIMEOUT_SECONDS }),
      },
      'E2B connect failed'
    );
    let nextState: E2bRuntimeProviderState = {
      ...state,
      ...(readString(connected?.domain) ? { domain: readString(connected?.domain) as string } : {}),
      ...(readString(connected?.envdAccessToken) ? { envdAccessToken: readString(connected?.envdAccessToken) } : {}),
      ...(readString(connected?.trafficAccessToken)
        ? { trafficAccessToken: readString(connected?.trafficAccessToken) }
        : {}),
      ...(readString(connected?.endAt) ? { expiresAt: readString(connected?.endAt) } : {}),
    };
    await waitForHttp(joinUrl(this.host(nextState, ENVD_PORT), '/health'), {}, readiness.timeoutMs);
    nextState = await this.verifyRuntimeEndpoints(nextState, {
      expectEnforcement: Boolean(state.gatewayToken),
      expectedGatewayToken: state.gatewayToken ? decryptWorkspaceGatewayToken(state.gatewayToken) : undefined,
      // Pause preserves processes: an editor that never came up will not appear after resume.
      editorWaitMs: state.editorUrl ? DEFAULT_EDITOR_WAIT_MS : 0,
    });
    return nextState;
  }

  async suspend(state: unknown, _opts: { retainForMs: number }): Promise<void> {
    // Paused sandboxes are retained indefinitely and free; retainForMs needs no TTL renewal here.
    const parsed = this.requireState(state);
    try {
      await this.controlRequest(
        `/sandboxes/${encodeURIComponent(parsed.sandboxId)}/pause`,
        { method: 'POST' },
        'E2B pause failed'
      );
    } catch (error) {
      if (isGoneError(error)) {
        throw new WorkspaceRuntimeGoneError(`E2B sandbox ${parsed.sandboxId} no longer exists`, error);
      }
      if (error instanceof ProviderApiError && error.status === 409) {
        // Already paused/terminating: reconcile via GET.
        const info = await this.controlRequest<E2bSandboxResponse>(
          `/sandboxes/${encodeURIComponent(parsed.sandboxId)}`,
          { method: 'GET' },
          'E2B get sandbox failed'
        );
        if (info?.state === 'paused') {
          return;
        }
      }
      throw error;
    }
  }

  async destroy(state: unknown): Promise<void> {
    // Mirror reattach's null contract: a never-provisioned/unparseable state has nothing to destroy.
    const parsed = readE2bProviderState(state);
    if (!parsed) {
      return;
    }
    await this.deleteSandbox(parsed.sandboxId);
  }

  /**
   * Resets the TTL to now + timeoutSeconds. Non-fatal like the OpenSandbox lease renewal: a missed
   * renewal only matters if it keeps failing until the TTL, and autoPause is the dead-man fallback.
   */
  async renewLease(state: unknown): Promise<void> {
    const parsed = readE2bProviderState(state);
    if (!parsed || this.config.timeoutSeconds === null) {
      return;
    }

    try {
      await this.controlRequest(
        `/sandboxes/${encodeURIComponent(parsed.sandboxId)}/timeout`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ timeout: this.config.timeoutSeconds }),
        },
        'E2B set timeout failed'
      );
    } catch (error) {
      getLogger().warn({ error, sandboxId: parsed.sandboxId }, 'E2B: lease renewal failed');
    }
  }

  resolveGatewayEndpoint(state: unknown): WorkspaceRuntimeEndpoint | null {
    const parsed = readE2bProviderState(state);
    if (!parsed) {
      return null;
    }
    const headers = this.trafficHeaders(parsed);
    return {
      url: this.host(parsed, this.config.gatewayPort),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  resolveEditorEndpoint(state: unknown): WorkspaceRuntimeEndpoint | null {
    const parsed = readE2bProviderState(state);
    if (!parsed?.editorUrl) {
      return null;
    }
    const headers = { ...this.trafficHeaders(parsed), ...(parsed.editorHeaders || {}) };
    return {
      url: parsed.editorUrl,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  hasPersistedHandle(state: unknown): boolean {
    return readE2bProviderState(state) !== null;
  }

  capabilities(state?: unknown): WorkspaceBackendCapabilitySnapshot {
    const parsed = readE2bProviderState(state);
    return {
      ...E2B_DECLARED_CAPABILITIES,
      backend: E2B_PROVIDER,
      editorAccess: Boolean(parsed?.editorUrl),
    };
  }

  private runtimeEnv(plan: WorkspaceRuntimePlan): Record<string, string> {
    return buildSessionRuntimeEnv(plan, this.config.gatewayPort, {
      LIFECYCLE_EDITOR_PORT: String(this.config.editorPort),
      LIFECYCLE_EDITOR_PROJECT_FILE: SESSION_WORKSPACE_EDITOR_PROJECT_FILE,
    });
  }

  /** Everything the launcher sources: secrets ride here (HTTPS + X-Access-Token), never in envVars. */
  private buildInstanceEnv(ctx: RemoteProvisionContext): Record<string, string> {
    return buildSandboxBaseEnv(ctx.plan, ctx, this.runtimeEnv(ctx.plan));
  }

  /** The launcher polls for instance.env, so it must be uploaded LAST (it is the start trigger). */
  private async deliverBootstrapFiles(
    state: E2bRuntimeProviderState,
    plan: WorkspaceRuntimePlan,
    ctx: RemoteProvisionContext
  ): Promise<void> {
    const initScriptOpts = buildInitScriptOpts(plan, ctx);

    await this.uploadFile(state, INIT_SCRIPT_PATH, generateInitScript(initScriptOpts));
    await this.uploadFile(state, SEED_SCRIPT_PATH, generateRuntimeSeedScript(initScriptOpts));
    if ((plan.skillPlan?.skills || []).length > 0) {
      await this.uploadFile(
        state,
        SKILLS_SCRIPT_PATH,
        generateSkillBootstrapCommand(plan.skillPlan, { useGitHubToken: plan.credentials.hasGitHubToken })
      );
    }
    await this.uploadFile(
      state,
      SESSION_WORKSPACE_EDITOR_PROJECT_FILE,
      buildSessionWorkspaceEditorContents(plan.servicePlan.workspaceRepos)
    );
    await this.uploadFile(
      state,
      BOOTSTRAP_SCRIPT_PATH,
      buildBootstrapScript(
        plan,
        { init: INIT_SCRIPT_PATH, seed: SEED_SCRIPT_PATH, skills: SKILLS_SCRIPT_PATH },
        {
          includeMkdir: true,
        }
      )
    );
    await this.uploadFile(state, INSTANCE_ENV_PATH, buildShellEnvFile(this.buildInstanceEnv(ctx)));
  }

  private async uploadFile(state: E2bRuntimeProviderState, path: string, content: string): Promise<void> {
    const formData = new FormData();
    formData.append('file', new Blob([content], { type: 'application/octet-stream' }), path.split('/').pop() || 'file');
    const response = await fetch(
      `${this.host(state, ENVD_PORT)}/files?path=${encodeURIComponent(path)}&username=user`,
      {
        method: 'POST',
        headers: {
          ...(state.envdAccessToken ? { [ENVD_ACCESS_TOKEN_HEADER]: state.envdAccessToken } : {}),
        },
        body: formData,
      }
    );
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new ProviderApiError(
        `E2B file upload failed: ${extractHttpErrorMessage(response, body)} (status=${response.status})`,
        response.status,
        E2B_PROVIDER
      );
    }
  }

  private async verifyRuntimeEndpoints(
    state: E2bRuntimeProviderState,
    opts: { expectEnforcement: boolean; expectedGatewayToken?: string; editorWaitMs: number }
  ): Promise<E2bRuntimeProviderState> {
    const gatewayUrl = this.host(state, this.config.gatewayPort);
    const trafficHeaders = this.trafficHeaders(state);
    await waitForHttp(joinUrl(gatewayUrl, '/health'), trafficHeaders, GATEWAY_READY_TIMEOUT_MS);

    // Fail closed on the public internet: a gateway that was given a token must enforce it.
    if (opts.expectEnforcement) {
      await assertGatewayTokenEnforced(gatewayUrl, trafficHeaders);
      if (!opts.expectedGatewayToken) {
        throw new WorkspaceRuntimeSecurityError('Workspace gateway token is required to verify E2B gateway access.');
      }
      await assertGatewayTokenAccepted(gatewayUrl, trafficHeaders, opts.expectedGatewayToken);
    }

    const editorUrl = this.host(state, this.config.editorPort);
    let editorReady = await isHttpReady(joinUrl(editorUrl, '/healthz'), trafficHeaders, 1000);
    if (!editorReady && opts.editorWaitMs > 0) {
      editorReady = await waitForHttpReady(joinUrl(editorUrl, '/healthz'), trafficHeaders, opts.editorWaitMs);
    }

    const nextState: E2bRuntimeProviderState = { ...state };
    if (editorReady) {
      nextState.editorUrl = editorUrl;
    } else {
      // Explicit nulls: persisted remote state is shallow-merged, so deletes would leave a stale editor.
      nextState.editorUrl = null;
      nextState.editorHeaders = null;
    }
    return nextState;
  }

  private async deleteSandbox(sandboxId: string): Promise<void> {
    try {
      await this.controlRequest(`/sandboxes/${encodeURIComponent(sandboxId)}`, { method: 'DELETE' }, 'E2B kill failed');
    } catch (error) {
      if (!isGoneError(error)) {
        throw error;
      }
    }
  }
}

export function createE2bRuntimeService(config: ResolvedAgentSessionE2bBackendConfig): E2bRuntimeService {
  return new E2bRuntimeService(config);
}

type E2bTemplateEntry = {
  templateID?: string;
  names?: string[];
  aliases?: string[];
  buildStatus?: string;
  cpuCount?: number;
  memoryMB?: number;
};

export async function listE2bWorkspaceSources(
  config: ResolvedAgentSessionWorkspaceBackendConfig
): Promise<WorkspaceSourceOption[]> {
  const e2b = config.e2b;
  if (!e2b?.apiKey) {
    throw new Error('E2B API key is not configured.');
  }

  const templates = await e2bControlRequest<E2bTemplateEntry[]>(
    e2b,
    '/templates',
    { method: 'GET' },
    'E2B template list failed'
  );

  return (Array.isArray(templates) ? templates : [])
    .filter((entry) => readString(entry?.templateID))
    .map((entry) => {
      const alias = entry.aliases?.[0] || entry.names?.[0];
      const specs = [entry.cpuCount ? `${entry.cpuCount} CPU` : null, entry.memoryMB ? `${entry.memoryMB} MB` : null]
        .filter(Boolean)
        .join(' · ');
      return {
        // The alias is the durable selector (template ids rotate on rebuild under v2).
        id: alias || (entry.templateID as string),
        label: alias || (entry.templateID as string),
        detail: specs || undefined,
        ready: !entry.buildStatus || entry.buildStatus === 'ready',
      };
    })
    .sort((left, right) => Number(right.ready) - Number(left.ready) || left.label.localeCompare(right.label));
}

export async function testE2bConnection(
  config: ResolvedAgentSessionWorkspaceBackendConfig
): Promise<WorkspaceBackendTestConnectionResult> {
  const e2b = config.e2b;
  if (!e2b?.apiKey) {
    return { ok: false, message: 'E2B API key is not configured.' };
  }
  if (!e2b.templateId) {
    return { ok: false, message: 'E2B template is not configured.' };
  }

  try {
    await e2bControlRequest(e2b, '/v2/sandboxes?limit=1', { method: 'GET' }, 'E2B sandbox list failed');
    const templates = await e2bControlRequest<
      Array<{
        templateID?: string;
        names?: string[];
        aliases?: string[];
        buildStatus?: string;
        cpuCount?: number;
        memoryMB?: number;
      }>
    >(e2b, '/templates', { method: 'GET' }, 'E2B template list failed');

    const template = (Array.isArray(templates) ? templates : []).find(
      (entry) =>
        entry?.templateID === e2b.templateId ||
        (entry?.names || []).includes(e2b.templateId as string) ||
        (entry?.aliases || []).includes(e2b.templateId as string)
    );
    if (!template) {
      return { ok: false, message: `E2B template "${e2b.templateId}" was not found for this API key.` };
    }
    if (template.buildStatus && template.buildStatus !== 'ready') {
      return {
        ok: false,
        message: `E2B template "${e2b.templateId}" is not ready (buildStatus: ${template.buildStatus}).`,
      };
    }

    return {
      ok: true,
      message: 'E2B connection verified.',
      details: {
        templateId: e2b.templateId,
        ...(template.buildStatus ? { buildStatus: template.buildStatus } : {}),
        ...(template.cpuCount !== undefined ? { cpuCount: template.cpuCount } : {}),
        ...(template.memoryMB !== undefined ? { memoryMB: template.memoryMB } : {}),
      },
    };
  } catch (error) {
    if (error instanceof ProviderApiError && error.status === 401) {
      return { ok: false, message: 'E2B rejected the configured API key.' };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: scrubSecrets(message, [e2b.apiKey]) };
  }
}
