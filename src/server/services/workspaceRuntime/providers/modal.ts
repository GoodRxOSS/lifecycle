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
import { SESSION_POD_MCP_CONFIG_ENV } from 'server/services/agentRuntime/mcp/sessionPod';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import type {
  ResolvedAgentSessionModalBackendConfig,
  ResolvedAgentSessionWorkspaceBackendConfig,
} from 'server/lib/agentSession/runtimeConfig';
import { getLogger } from 'server/lib/logger';
import {
  LIFECYCLE_GATEWAY_TOKEN_ENV,
  decryptSessionSecretEnv,
  decryptWorkspaceGatewayToken,
  encryptSessionSecretEnv,
  encryptWorkspaceGatewayToken,
  mintWorkspaceGatewayToken,
} from '../gatewayToken';
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
  type WorkspaceRuntimeEndpoint,
} from '../types';
import {
  assertGatewayTokenEnforced,
  assertGatewayTokenAccepted,
  assertNoExternalSecretRefs,
  buildBootstrapScript,
  buildInitScriptOpts,
  buildSessionRuntimeEnv,
  buildShellEnvFile,
  buildUserIdentityEnv,
  isRecord,
  joinUrl,
  normalizeEnv,
  readString,
  scrubSecrets,
  shellQuote,
  waitForHttp,
} from './shared';

export const MODAL_PROVIDER = 'modal';

// Modal is gRPC-only; the SDK (nice-grpc/protobufjs) is loaded lazily and confined to this module.
// Exact-pinned at modal@0.7.6 in package.json — npm's modal@1.x is an unrelated squatted 2015 package.
type ModalSdk = typeof import('modal');
type ModalClientInstance = InstanceType<ModalSdk['ModalClient']>;
type ModalSandbox = Awaited<ReturnType<ModalClientInstance['sandboxes']['fromId']>>;

let modalSdkPromise: Promise<ModalSdk> | null = null;

function loadModalSdk(): Promise<ModalSdk> {
  modalSdkPromise ??= import('modal');
  return modalSdkPromise;
}

const SNAPSHOT_ENV_FILE = '/opt/lifecycle/instance.env';
const BOOTSTRAP_SCRIPT_PATH = '/opt/lifecycle/bootstrap.sh';
const INIT_SCRIPT_PATH = '/opt/lifecycle/init-workspace.sh';
const SEED_SCRIPT_PATH = '/opt/lifecycle/runtime-seed.sh';
const SKILLS_SCRIPT_PATH = '/opt/lifecycle/skills-bootstrap.sh';
// Bootstrap (clone/install) runs inside the sandbox command before the gateway starts.
const GATEWAY_READY_TIMEOUT_MS = 10 * 60 * 1000;
const TUNNEL_TIMEOUT_MS = 50000;
const SNAPSHOT_TIMEOUT_MS = 2 * 60 * 1000;

export const MODAL_DECLARED_CAPABILITIES: WorkspaceBackendCapabilities = {
  newChatWorkspaces: { supported: true },
  developWorkspaces: { supported: false },
  environmentSessions: { supported: false },
  sandboxSessions: { supported: true },
  editor: { supported: false, note: 'Modal tunnels have no request auth (v1).' },
  previewPorts: { supported: true, note: 'Served through the authenticated workspace gateway preview proxy.' },
  hibernateResume: {
    supported: true,
    note: 'Filesystem checkpointed; resume recreates the sandbox (changes since the last checkpoint may be lost at the 24h wall).',
  },
  prewarm: { supported: false },
};

export interface ModalRuntimeProviderState {
  [key: string]: unknown;
  appName: string;
  /** Absent while suspended (the sandbox was terminated after its filesystem snapshot). */
  sandboxId?: string;
  /** Built base image id (registry pull/conversion cache). */
  imageId?: string;
  /** Latest filesystem snapshot (suspend or 24h-wall checkpoint). */
  snapshotImageId?: string;
  checkpointAt?: string;
  gatewayUrl?: string;
  /** Sandbox creation time + lifetime drive the cleanup job's 24h-wall checkpoint pass. */
  createdAt?: string;
  timeoutMs?: number;
  /** Encrypted gateway bearer token (ciphertext only; resume re-mints provider-side). */
  gatewayToken?: string;
  /** Encrypted session secrets (GitHub token, credentialEnv, MCP config) re-injected at resume; never snapshotted. */
  sessionSecretEnv?: string;
}

const STATE_STRING_KEYS = [
  'sandboxId',
  'imageId',
  'snapshotImageId',
  'checkpointAt',
  'gatewayUrl',
  'createdAt',
  'gatewayToken',
  'sessionSecretEnv',
] as const;

export function readModalProviderState(value: unknown): ModalRuntimeProviderState | null {
  if (!isRecord(value)) {
    return null;
  }

  const appName = readString(value.appName);
  if (!appName) {
    return null;
  }

  const state: ModalRuntimeProviderState = { appName };
  for (const key of STATE_STRING_KEYS) {
    const parsed = readString(value[key]);
    if (parsed) {
      state[key] = parsed;
    }
  }
  if (typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) {
    state.timeoutMs = value.timeoutMs;
  }
  return state;
}

function isModalNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError';
}

function base64WriteLine(path: string, content: string): string {
  return `printf '%s' '${Buffer.from(content, 'utf8').toString('base64')}' | base64 -d > ${shellQuote(path)}`;
}

export class ModalRuntimeService implements RemoteWorkspaceRuntimeProvider {
  readonly backendId = MODAL_PROVIDER;

  constructor(private readonly config: ResolvedAgentSessionModalBackendConfig) {}

  private requireState(state: unknown): ModalRuntimeProviderState {
    const parsed = readModalProviderState(state);
    if (!parsed) {
      throw new Error('Modal provider state is missing required fields');
    }
    return parsed;
  }

  private requireCredentials(): void {
    if (!this.config.tokenId || !this.config.tokenSecret) {
      throw new Error('Modal workspace backend requires token credentials.');
    }
    if (!this.config.image) {
      throw new Error('Modal workspace backend requires an image.');
    }
  }

  private async withClient<T>(fn: (sdk: ModalSdk, client: ModalClientInstance) => Promise<T>): Promise<T> {
    const sdk = await loadModalSdk();
    const client = new sdk.ModalClient({
      tokenId: this.config.tokenId,
      tokenSecret: this.config.tokenSecret,
      ...(this.config.environment ? { environment: this.config.environment } : {}),
    });
    try {
      return await fn(sdk, client);
    } finally {
      client.close();
    }
  }

  private toHandle(state: ModalRuntimeProviderState): RemoteRuntimeHandle {
    return {
      providerState: state,
      capabilitySnapshot: this.capabilities(state),
      podNameAlias: state.sandboxId,
    };
  }

  /** Non-secret runtime + identity env, safe to bake into the filesystem snapshot at rest. */
  private buildSnapshotEnv(plan: WorkspaceRuntimePlan, ctx: RemoteProvisionContext): Record<string, string> {
    return normalizeEnv({
      ...buildUserIdentityEnv(ctx.userIdentity),
      ...buildSessionRuntimeEnv(plan, this.config.gatewayPort),
    });
  }

  /** Session secrets delivered as create-time env only; persisted encrypted in providerState, never snapshotted. */
  private buildSessionSecretEnv(plan: WorkspaceRuntimePlan): Record<string, string> {
    return normalizeEnv({
      ...plan.provider.credentialEnv,
      ...plan.forwardedEnv.env,
      ...(plan.credentials.githubToken
        ? { GITHUB_TOKEN: plan.credentials.githubToken, GH_TOKEN: plan.credentials.githubToken }
        : {}),
      [SESSION_POD_MCP_CONFIG_ENV]: plan.startupMcp.serializedConfig,
    });
  }

  private buildSandboxEnv(plan: WorkspaceRuntimePlan, ctx: RemoteProvisionContext): Record<string, string> {
    return {
      ...this.buildSnapshotEnv(plan, ctx),
      ...this.buildSessionSecretEnv(plan),
      ...(ctx.gatewayToken ? { [LIFECYCLE_GATEWAY_TOKEN_ENV]: ctx.gatewayToken } : {}),
    };
  }

  /**
   * The provision command bootstraps the workspace, persists only non-secret runtime env to the
   * filesystem so it survives snapshot/recreate, then starts the gateway. Secrets ride as create-time
   * env (re-injected from encrypted providerState at resume), so they never land in the snapshot image.
   */
  private provisionCommand(plan: WorkspaceRuntimePlan, ctx: RemoteProvisionContext): string[] {
    const initScriptOpts = buildInitScriptOpts(plan, ctx);

    const script = [
      'set -e',
      `mkdir -p ${shellQuote(SESSION_WORKSPACE_SHARED_HOME_DIR)} ${shellQuote(
        SESSION_WORKSPACE_ROOT
      )} /tmp /opt/lifecycle`,
      base64WriteLine(INIT_SCRIPT_PATH, generateInitScript(initScriptOpts)),
      base64WriteLine(SEED_SCRIPT_PATH, generateRuntimeSeedScript(initScriptOpts)),
      ...((plan.skillPlan?.skills || []).length > 0
        ? [
            base64WriteLine(
              SKILLS_SCRIPT_PATH,
              generateSkillBootstrapCommand(plan.skillPlan, { useGitHubToken: plan.credentials.hasGitHubToken })
            ),
          ]
        : []),
      base64WriteLine(
        SESSION_WORKSPACE_EDITOR_PROJECT_FILE,
        buildSessionWorkspaceEditorContents(plan.servicePlan.workspaceRepos)
      ),
      base64WriteLine(SNAPSHOT_ENV_FILE, buildShellEnvFile(this.buildSnapshotEnv(plan, ctx))),
      base64WriteLine(
        BOOTSTRAP_SCRIPT_PATH,
        buildBootstrapScript(plan, { init: INIT_SCRIPT_PATH, seed: SEED_SCRIPT_PATH, skills: SKILLS_SCRIPT_PATH })
      ),
      `sh ${BOOTSTRAP_SCRIPT_PATH}`,
      'exec node /opt/lifecycle-workspace-gateway/index.mjs',
    ].join('\n');
    return ['/bin/sh', '-c', script];
  }

  /** Resume command: the snapshot already holds the bootstrapped workspace and env file. */
  private resumeCommand(): string[] {
    const script = [
      'set -e',
      'mkdir -p /tmp',
      `if [ -f ${SNAPSHOT_ENV_FILE} ]; then set -a; . ${SNAPSHOT_ENV_FILE}; set +a; fi`,
      'exec node /opt/lifecycle-workspace-gateway/index.mjs',
    ].join('\n');
    return ['/bin/sh', '-c', script];
  }

  private createParams(
    sdk: ModalSdk,
    command: string[],
    env: Record<string, string>,
    name?: string,
    tags?: Record<string, string>
  ) {
    return {
      command,
      timeoutMs: this.config.timeoutSeconds * 1000,
      env,
      // Gateway port ONLY in v1: tunnels are public-random with no request auth, so the editor
      // stays unexposed and the gateway relies on the enforced bearer token.
      encryptedPorts: [this.config.gatewayPort],
      readinessProbe: sdk.Probe.withTcp(this.config.gatewayPort),
      ...(name ? { name } : {}),
      ...(tags ? { tags } : {}),
      ...(this.config.cpu !== undefined ? { cpu: this.config.cpu } : {}),
      ...(this.config.memoryMiB !== undefined ? { memoryMiB: this.config.memoryMiB } : {}),
      ...(this.config.inboundCidrAllowlist?.length ? { inboundCidrAllowlist: this.config.inboundCidrAllowlist } : {}),
    };
  }

  private async verifyRuntime(
    sb: ModalSandbox,
    state: ModalRuntimeProviderState,
    opts: { expectEnforcement: boolean; expectedGatewayToken?: string }
  ): Promise<ModalRuntimeProviderState> {
    await sb.waitUntilReady(GATEWAY_READY_TIMEOUT_MS);
    const tunnels = await sb.tunnels(TUNNEL_TIMEOUT_MS);
    const tunnel = tunnels[this.config.gatewayPort];
    if (!tunnel) {
      throw new Error(`Modal sandbox ${state.sandboxId} did not expose a tunnel on port ${this.config.gatewayPort}`);
    }

    const gatewayUrl = tunnel.url;
    await waitForHttp(joinUrl(gatewayUrl, '/health'), {}, GATEWAY_READY_TIMEOUT_MS);
    // Fail closed: the tunnel is public on the internet, so token enforcement is non-negotiable.
    if (opts.expectEnforcement) {
      await assertGatewayTokenEnforced(gatewayUrl, {});
      if (!opts.expectedGatewayToken) {
        throw new WorkspaceRuntimeSecurityError('Workspace gateway token is required to verify Modal gateway access.');
      }
      await assertGatewayTokenAccepted(gatewayUrl, {}, opts.expectedGatewayToken);
    }

    return { ...state, gatewayUrl };
  }

  async provision(ctx: RemoteProvisionContext): Promise<RemoteRuntimeHandle> {
    const { plan } = ctx;
    this.requireCredentials();
    assertNoExternalSecretRefs(plan, 'Modal');

    return this.withClient(async (sdk, client) => {
      const app = await client.apps.fromName(this.config.appName, { createIfMissing: true });
      const registrySecret = this.config.imageRegistrySecret
        ? await client.secrets.fromName(this.config.imageRegistrySecret)
        : undefined;
      const image = client.images.fromRegistry(this.config.image, registrySecret);

      const sb = await client.sandboxes.create(
        app,
        image,
        this.createParams(sdk, this.provisionCommand(plan, ctx), this.buildSandboxEnv(plan, ctx), undefined, {
          lifecycleSessionUuid: plan.sessionUuid,
          lifecycleKind: plan.kind,
        })
      );

      try {
        const sessionSecretEnv = this.buildSessionSecretEnv(plan);
        const state: ModalRuntimeProviderState = {
          appName: this.config.appName,
          sandboxId: sb.sandboxId,
          ...(readString(image.imageId) ? { imageId: readString(image.imageId) } : {}),
          createdAt: new Date().toISOString(),
          timeoutMs: this.config.timeoutSeconds * 1000,
          ...(Object.keys(sessionSecretEnv).length > 0
            ? { sessionSecretEnv: encryptSessionSecretEnv(sessionSecretEnv) }
            : {}),
        };
        return this.toHandle(
          await this.verifyRuntime(sb, state, {
            expectEnforcement: Boolean(ctx.gatewayToken),
            expectedGatewayToken: ctx.gatewayToken,
          })
        );
      } catch (error) {
        await sb.terminate().catch(() => {});
        throw error;
      }
    });
  }

  /**
   * Reconnects to a running sandbox; a dead sandbox with a live snapshot resumes from it (the
   * snapshot holds the user's workspace). Returns null — provision fresh — only when neither the
   * sandbox nor a snapshot exists.
   */
  async reattach(state: unknown, _readiness: ReadinessProfile): Promise<RemoteRuntimeHandle | null> {
    const parsed = readModalProviderState(state);
    if (!parsed) {
      return null;
    }

    return this.withClient(async (sdk, client) => {
      if (parsed.sandboxId) {
        try {
          const sb = await client.sandboxes.fromId(parsed.sandboxId);
          if ((await sb.poll()) === null) {
            return this.toHandle(
              await this.verifyRuntime(sb, parsed, {
                expectEnforcement: Boolean(parsed.gatewayToken),
                expectedGatewayToken: parsed.gatewayToken
                  ? decryptWorkspaceGatewayToken(parsed.gatewayToken)
                  : undefined,
              })
            );
          }
          // Finished (timeout wall or crash): fall through to the snapshot.
        } catch (error) {
          if (!isModalNotFoundError(error)) {
            throw error;
          }
        }
      }

      if (parsed.snapshotImageId) {
        try {
          return await this.resumeFromSnapshot(sdk, client, parsed);
        } catch (error) {
          // Snapshot expired/deleted: provision fresh.
          if (error instanceof WorkspaceRuntimeGoneError || isModalNotFoundError(error)) {
            return null;
          }
          throw error;
        }
      }

      return null;
    });
  }

  async resume(state: unknown, _readiness: ReadinessProfile): Promise<RemoteRuntimeHandle> {
    const parsed = this.requireState(state);
    if (!parsed.snapshotImageId) {
      throw new WorkspaceRuntimeGoneError(`Modal sandbox for app ${parsed.appName} has no filesystem snapshot`);
    }

    return this.withClient((sdk, client) => this.resumeFromSnapshot(sdk, client, parsed));
  }

  /** Recreates the sandbox from its snapshot: new sandboxId, new tunnel URL, fresh gateway token. */
  private async resumeFromSnapshot(
    sdk: ModalSdk,
    client: ModalClientInstance,
    state: ModalRuntimeProviderState
  ): Promise<RemoteRuntimeHandle> {
    let image: Awaited<ReturnType<ModalClientInstance['images']['fromId']>>;
    try {
      image = await client.images.fromId(state.snapshotImageId as string);
    } catch (error) {
      if (isModalNotFoundError(error)) {
        throw new WorkspaceRuntimeGoneError(
          `Modal snapshot ${state.snapshotImageId} no longer exists; the workspace expired`,
          error
        );
      }
      throw error;
    }

    // Resume has no minting context (the orchestration token rides only on provision), and the
    // recreated sandbox needs a fresh create-time token — so this provider mints provider-side
    // and hands the ciphertext back on the new handle.
    const gatewayToken = mintWorkspaceGatewayToken();
    const encryptedGatewayToken = encryptWorkspaceGatewayToken(gatewayToken);
    // Re-inject session secrets as create-time env (they are not baked into the snapshot image).
    const sessionSecretEnv = state.sessionSecretEnv ? decryptSessionSecretEnv(state.sessionSecretEnv) : {};

    const app = await client.apps.fromName(state.appName, { createIfMissing: true });
    const sb = await client.sandboxes.create(
      app,
      image,
      this.createParams(sdk, this.resumeCommand(), {
        ...sessionSecretEnv,
        [LIFECYCLE_GATEWAY_TOKEN_ENV]: gatewayToken,
      })
    );

    try {
      const nextState: ModalRuntimeProviderState = {
        ...state,
        sandboxId: sb.sandboxId,
        createdAt: new Date().toISOString(),
        timeoutMs: this.config.timeoutSeconds * 1000,
        gatewayToken: encryptedGatewayToken,
      };
      return this.toHandle(
        await this.verifyRuntime(sb, nextState, { expectEnforcement: true, expectedGatewayToken: gatewayToken })
      );
    } catch (error) {
      await sb.terminate().catch(() => {});
      throw error;
    }
  }

  /** Suspend = filesystem snapshot + terminate; the snapshot id rides back on the handle. */
  async suspend(state: unknown, _opts: { retainForMs: number }): Promise<RemoteRuntimeHandle> {
    const parsed = this.requireState(state);
    if (!parsed.sandboxId) {
      throw new Error('Modal sandbox is not running');
    }

    return this.withClient(async (_sdk, client) => {
      let sb: ModalSandbox;
      try {
        sb = await client.sandboxes.fromId(parsed.sandboxId as string);
      } catch (error) {
        if (isModalNotFoundError(error)) {
          throw new WorkspaceRuntimeGoneError(`Modal sandbox ${parsed.sandboxId} no longer exists`, error);
        }
        throw error;
      }

      const snapshot = await sb.snapshotFilesystem(SNAPSHOT_TIMEOUT_MS);
      await sb.terminate();
      await this.deleteSnapshotIfReplaced(client, parsed.snapshotImageId, snapshot.imageId);

      return {
        // Explicit nulls: persisted remote state is shallow-merged, so omitted keys would linger.
        providerState: {
          ...parsed,
          sandboxId: null,
          gatewayUrl: null,
          snapshotImageId: snapshot.imageId,
          checkpointAt: new Date().toISOString(),
        },
        capabilitySnapshot: this.capabilities(parsed),
      };
    });
  }

  /** Non-destructive snapshot (24h-wall protection): the sandbox keeps running. */
  async checkpoint(state: unknown): Promise<RemoteRuntimeHandle> {
    const parsed = this.requireState(state);
    if (!parsed.sandboxId) {
      throw new Error('Modal sandbox is not running');
    }

    return this.withClient(async (_sdk, client) => {
      let sb: ModalSandbox;
      try {
        sb = await client.sandboxes.fromId(parsed.sandboxId as string);
      } catch (error) {
        if (isModalNotFoundError(error)) {
          throw new WorkspaceRuntimeGoneError(`Modal sandbox ${parsed.sandboxId} no longer exists`, error);
        }
        throw error;
      }

      const snapshot = await sb.snapshotFilesystem(SNAPSHOT_TIMEOUT_MS);
      await this.deleteSnapshotIfReplaced(client, parsed.snapshotImageId, snapshot.imageId);

      return this.toHandle({
        ...parsed,
        snapshotImageId: snapshot.imageId,
        checkpointAt: new Date().toISOString(),
      });
    });
  }

  async destroy(state: unknown): Promise<void> {
    // Mirror reattach's null contract: a never-provisioned/unparseable state has nothing to destroy.
    const parsed = readModalProviderState(state);
    if (!parsed) {
      return;
    }

    await this.withClient(async (_sdk, client) => {
      if (parsed.sandboxId) {
        try {
          const sb = await client.sandboxes.fromId(parsed.sandboxId as string);
          await sb.terminate();
        } catch (error) {
          if (!isModalNotFoundError(error)) {
            throw error;
          }
        }
      }
      if (parsed.snapshotImageId) {
        // Best-effort GC for snapshots we created.
        await client.images.delete(parsed.snapshotImageId).catch(() => {});
      }
    });
  }

  private async deleteSnapshotIfReplaced(
    client: ModalClientInstance,
    previousSnapshotImageId: string | undefined,
    nextSnapshotImageId: string
  ): Promise<void> {
    if (previousSnapshotImageId && previousSnapshotImageId !== nextSnapshotImageId) {
      await client.images.delete(previousSnapshotImageId).catch((error) => {
        getLogger().warn({ error, imageId: previousSnapshotImageId }, 'Modal: snapshot GC failed');
      });
    }
  }

  resolveGatewayEndpoint(state: unknown): WorkspaceRuntimeEndpoint | null {
    const parsed = readModalProviderState(state);
    if (!parsed?.gatewayUrl) {
      return null;
    }
    // No backend access headers: the tunnel is public-random; auth is the orchestration bearer.
    return { url: parsed.gatewayUrl };
  }

  resolveEditorEndpoint(_state: unknown): WorkspaceRuntimeEndpoint | null {
    return null;
  }

  hasPersistedHandle(state: unknown): boolean {
    // appName is present once provisioned (and survives suspend, where resume recreates from snapshot).
    return readModalProviderState(state) !== null;
  }

  capabilities(_state?: unknown): WorkspaceBackendCapabilitySnapshot {
    return {
      ...MODAL_DECLARED_CAPABILITIES,
      backend: MODAL_PROVIDER,
      editorAccess: false,
    };
  }
}

export function createModalRuntimeService(config: ResolvedAgentSessionModalBackendConfig): ModalRuntimeService {
  return new ModalRuntimeService(config);
}

export async function testModalConnection(
  config: ResolvedAgentSessionWorkspaceBackendConfig
): Promise<WorkspaceBackendTestConnectionResult> {
  const modal = config.modal;
  if (!modal?.tokenId || !modal.tokenSecret) {
    return { ok: false, message: 'Modal token credentials are not configured.' };
  }
  if (!modal.image) {
    return { ok: false, message: 'Modal workspace image is not configured.' };
  }

  try {
    const sdk = await loadModalSdk();
    const client = new sdk.ModalClient({
      tokenId: modal.tokenId,
      tokenSecret: modal.tokenSecret,
      ...(modal.environment ? { environment: modal.environment } : {}),
    });
    try {
      // Cheapest unary; createIfMissing is idempotent and the app is a provisioning prerequisite.
      await client.apps.fromName(modal.appName, { createIfMissing: true });
    } finally {
      client.close();
    }

    return {
      ok: true,
      message: 'Modal connection verified.',
      details: {
        appName: modal.appName,
        image: modal.image,
        ...(modal.environment ? { environment: modal.environment } : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unauthenticated/i.test(message)) {
      return { ok: false, message: 'Modal rejected the configured token credentials.' };
    }
    return { ok: false, message: scrubSecrets(message, [modal.tokenId, modal.tokenSecret]) };
  }
}
