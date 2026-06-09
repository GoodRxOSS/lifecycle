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
import { SESSION_WORKSPACE_EDITOR_PROJECT_FILE, SESSION_WORKSPACE_ROOT } from 'server/lib/agentSession/workspace';
import { SESSION_WORKSPACE_SHARED_HOME_DIR, type InitScriptOpts } from 'server/lib/agentSession/configSeeder';
import { SESSION_POD_MCP_CONFIG_ENV } from 'server/services/agentRuntime/mcp/sessionPod';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import { buildWorkspaceGatewayAuthHeaders, LIFECYCLE_GATEWAY_TOKEN_ENV } from '../gatewayToken';
import { WorkspaceRuntimeSecurityError, type RemoteProvisionContext } from '../types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const record = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => entry[0].trim().length > 0 && typeof entry[1] === 'string'
    )
  );
  return Object.keys(record).length > 0 ? record : undefined;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function extractHttpErrorMessage(response: Response, body: unknown): string {
  if (isRecord(body) && typeof body.message === 'string') {
    return body.message;
  }
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  if (typeof body === 'string' && body.trim()) {
    return body.trim();
  }
  return response.statusText;
}

export function joinUrl(baseUrl: string, pathname: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

export async function isHttpReady(url: string, headers: Record<string, string>, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForHttpReady(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await isHttpReady(url, headers, 1000)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function waitForHttp(url: string, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  if (!(await waitForHttpReady(url, headers, timeoutMs))) {
    throw new Error(`Workspace endpoint did not become ready: ${url}`);
  }
}

/**
 * Verifies a freshly started gateway rejects unauthenticated MCP requests. A workspace image whose
 * gateway ignores LIFECYCLE_GATEWAY_TOKEN would otherwise expose unauthenticated exec on the
 * public internet, so remote backends must fail provisioning closed.
 */
export async function assertGatewayTokenEnforced(
  gatewayUrl: string,
  accessHeaders: Record<string, string>
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(joinUrl(gatewayUrl, '/mcp'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...accessHeaders,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'lifecycle-token-probe', version: '0.0.0' },
        },
      }),
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) {
      throw new WorkspaceRuntimeSecurityError(
        'Workspace gateway accepted an unauthenticated MCP request; it is not enforcing the gateway token. ' +
          'The workspace image likely ships an outdated lifecycle-workspace-gateway — update the image before using this backend.'
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Verifies the same proxy path accepts the configured gateway token. The negative probe above only
 * proves auth is enforced; this catches proxies that strip Authorization before chat tools use it.
 */
export async function assertGatewayTokenAccepted(
  gatewayUrl: string,
  accessHeaders: Record<string, string>,
  gatewayToken: string
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(joinUrl(gatewayUrl, '/mcp'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...accessHeaders,
        ...buildWorkspaceGatewayAuthHeaders(gatewayToken),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'lifecycle-token-positive-probe', version: '0.0.0' },
        },
      }),
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      throw new WorkspaceRuntimeSecurityError(
        `Workspace gateway rejected the configured gateway token (status=${response.status}). ` +
          'Verify the workspace image accepts x-lifecycle-gateway-token and the backend proxy forwards it.'
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Shared REST error for the HTTP-based providers (e2b/daytona/opensandbox). */
export class ProviderApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly provider: string) {
    super(message);
    this.name = 'ProviderApiError';
  }
}

/** The runtime no longer exists upstream (HTTP 404); providers map this to WorkspaceRuntimeGoneError. */
export function isGoneError(error: unknown): boolean {
  return error instanceof ProviderApiError && error.status === 404;
}

/** Authenticated JSON request: auth headers first, per-call headers override; throws ProviderApiError on !ok. */
export async function apiRequest<T = unknown>(
  baseUrl: string,
  authHeaders: Record<string, string>,
  pathname: string,
  init: RequestInit,
  errorPrefix: string,
  provider: string
): Promise<T> {
  const response = await fetch(joinUrl(baseUrl, pathname), {
    ...init,
    headers: { ...authHeaders, ...((init.headers || {}) as Record<string, string>) },
  });
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new ProviderApiError(
      `${errorPrefix}: ${extractHttpErrorMessage(response, body)} (status=${response.status})`,
      response.status,
      provider
    );
  }
  return body as T;
}

export function buildUserIdentityEnv(userIdentity?: RequestUserIdentity | null): Record<string, string> {
  if (!userIdentity) {
    return {};
  }

  return {
    LIFECYCLE_USER_ID: userIdentity.userId,
    LIFECYCLE_USER_NAME: userIdentity.displayName,
    GIT_AUTHOR_NAME: userIdentity.gitUserName,
    GIT_AUTHOR_EMAIL: userIdentity.gitUserEmail,
    GIT_COMMITTER_NAME: userIdentity.gitUserName,
    GIT_COMMITTER_EMAIL: userIdentity.gitUserEmail,
    ...(userIdentity.githubUsername ? { LIFECYCLE_GITHUB_USERNAME: userIdentity.githubUsername } : {}),
    ...(userIdentity.email ? { LIFECYCLE_USER_EMAIL: userIdentity.email } : {}),
  };
}

export function normalizeEnv(env: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === 'string' && entry[0].trim().length > 0 && typeof entry[1] === 'string'
    )
  );
}

/** Non-secret workspace runtime env shared by every remote provider; `extra` slots in after MCP_PORT. */
export function buildSessionRuntimeEnv(
  plan: WorkspaceRuntimePlan | undefined,
  gatewayPort: number,
  extra?: Record<string, string>
): Record<string, string> {
  const primaryWorkspaceRepo =
    plan?.servicePlan.workspaceRepos.find((repo) => repo.primary) || plan?.servicePlan.workspaceRepos[0];
  return {
    LIFECYCLE_SESSION_WORKSPACE: SESSION_WORKSPACE_ROOT,
    LIFECYCLE_SESSION_HOME: SESSION_WORKSPACE_SHARED_HOME_DIR,
    LIFECYCLE_SESSION_PRIMARY_REPO_PATH: primaryWorkspaceRepo?.mountPath || SESSION_WORKSPACE_ROOT,
    MCP_PORT: String(gatewayPort),
    ...(extra || {}),
    HOME: SESSION_WORKSPACE_SHARED_HOME_DIR,
    TMPDIR: '/tmp',
    TMP: '/tmp',
    TEMP: '/tmp',
    NODE_OPTIONS: process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS || '--max-old-space-size=2048',
  };
}

/** Credential-bearing sandbox env (provider/forwarded creds, identity, GitHub token, MCP config, gateway token). */
export function buildSandboxBaseEnv(
  plan: WorkspaceRuntimePlan,
  ctx: Pick<RemoteProvisionContext, 'userIdentity' | 'gatewayToken'>,
  runtimeEnv: Record<string, string>
): Record<string, string> {
  return normalizeEnv({
    ...plan.provider.credentialEnv,
    ...plan.forwardedEnv.env,
    ...buildUserIdentityEnv(ctx.userIdentity),
    ...(plan.credentials.githubToken
      ? { GITHUB_TOKEN: plan.credentials.githubToken, GH_TOKEN: plan.credentials.githubToken }
      : {}),
    [SESSION_POD_MCP_CONFIG_ENV]: plan.startupMcp.serializedConfig,
    ...(ctx.gatewayToken ? { [LIFECYCLE_GATEWAY_TOKEN_ENV]: ctx.gatewayToken } : {}),
    ...runtimeEnv,
  });
}

export function buildInitScriptOpts(
  plan: WorkspaceRuntimePlan,
  ctx: Pick<RemoteProvisionContext, 'userIdentity' | 'installCommand'>
): InitScriptOpts {
  const primaryWorkspaceRepo =
    plan.servicePlan.workspaceRepos.find((repo) => repo.primary) || plan.servicePlan.workspaceRepos[0];
  return {
    workspacePath: SESSION_WORKSPACE_ROOT,
    workspaceRepos: plan.servicePlan.workspaceRepos,
    repoUrl: primaryWorkspaceRepo?.repoUrl,
    branch: primaryWorkspaceRepo?.branch,
    revision: primaryWorkspaceRepo?.revision || undefined,
    installCommand: ctx.installCommand,
    gitUserName: ctx.userIdentity?.gitUserName,
    gitUserEmail: ctx.userIdentity?.gitUserEmail,
    githubUsername: ctx.userIdentity?.githubUsername || undefined,
    useGitHubToken: plan.credentials.hasGitHubToken,
  };
}

/** clone/seed/skills launcher; `includeMkdir` for providers that do not pre-create the dirs in an outer script. */
export function buildBootstrapScript(
  plan: WorkspaceRuntimePlan,
  paths: { init: string; seed: string; skills: string },
  opts: { includeMkdir?: boolean } = {}
): string {
  return [
    '#!/bin/sh',
    'set -e',
    ...(opts.includeMkdir
      ? [`mkdir -p ${shellQuote(SESSION_WORKSPACE_SHARED_HOME_DIR)} ${shellQuote(SESSION_WORKSPACE_ROOT)} /tmp`]
      : []),
    `cd ${shellQuote(SESSION_WORKSPACE_ROOT)}`,
    `sh ${paths.init}`,
    `sh ${paths.seed}`,
    ...((plan.skillPlan?.skills || []).length > 0 ? [`sh ${paths.skills}`] : []),
    '',
  ].join('\n');
}

/** code-server launch guarded by a not-installed check; `exec` replaces the shell (background-session owners). */
export function codeServerCommand(editorPort: number, backendLabel: string, opts: { exec?: boolean } = {}): string {
  const args = [
    shellQuote(SESSION_WORKSPACE_EDITOR_PROJECT_FILE),
    '--auth',
    'none',
    '--bind-addr',
    `0.0.0.0:${editorPort}`,
    '--disable-telemetry',
    '--disable-update-check',
  ].join(' ');
  return [
    'if ! command -v code-server >/dev/null 2>&1; then',
    `  echo "code-server not installed in ${backendLabel} workspace image"`,
    '  exit 0',
    'fi',
    `${opts.exec ? 'exec ' : ''}code-server ${args}`,
  ].join('\n');
}

export function buildShellEnvFile(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n')}\n`;
}

/** Remote backends cannot resolve Lifecycle external secret references yet; fail provisioning loudly if any. */
export function assertNoExternalSecretRefs(plan: WorkspaceRuntimePlan, backendDisplayName: string): void {
  if (plan.forwardedEnv.secretRefs.length > 0) {
    const keys = plan.forwardedEnv.secretRefs.map((ref) => ref.envKey).join(', ');
    throw new Error(`${backendDisplayName} backend cannot resolve Lifecycle external secret references yet: ${keys}`);
  }
}

export function scrubSecrets(message: string, secrets: Array<string | undefined>): string {
  return secrets.reduce<string>((acc, secret) => (secret ? acc.split(secret).join('[redacted]') : acc), message);
}
