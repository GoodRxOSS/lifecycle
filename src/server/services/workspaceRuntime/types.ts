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
import type {
  ResolvedAgentSessionReadinessConfig,
  ResolvedAgentSessionWorkspaceBackendConfig,
} from 'server/lib/agentSession/runtimeConfig';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';

export const LIFECYCLE_KUBERNETES_PROVIDER = 'lifecycle_kubernetes';
export const OPEN_SANDBOX_PROVIDER = 'opensandbox';

export type WorkspaceBackendId = 'lifecycle_kubernetes' | 'opensandbox' | 'e2b' | 'modal' | 'daytona' | 'substrate';

export type WorkspaceBackendStatus = 'available' | 'coming_soon';

export const WORKSPACE_BACKEND_CAPABILITY_KEYS = [
  'newChatWorkspaces',
  'developWorkspaces',
  'environmentSessions',
  'sandboxSessions',
  'editor',
  'previewPorts',
  'hibernateResume',
  'prewarm',
] as const;

export type WorkspaceBackendCapabilityKey = (typeof WORKSPACE_BACKEND_CAPABILITY_KEYS)[number];

export interface WorkspaceBackendCapabilityEntry {
  supported: boolean;
  /** Declared-conditional detail, e.g. editor support that depends on the workspace image. */
  note?: string;
}

export type WorkspaceBackendCapabilities = Record<WorkspaceBackendCapabilityKey, WorkspaceBackendCapabilityEntry>;

/** Persisted per-instance snapshot: declared capabilities plus runtime-verified editor access. */
export type WorkspaceBackendCapabilitySnapshot = WorkspaceBackendCapabilities & {
  backend: WorkspaceBackendId;
  editorAccess: boolean;
};

export interface WorkspaceRuntimeEndpoint {
  url: string;
  headers?: Record<string, string>;
}

export type ReadinessProfile = ResolvedAgentSessionReadinessConfig;

export interface RemoteProvisionContext {
  plan: WorkspaceRuntimePlan;
  readiness: ReadinessProfile;
  userIdentity?: RequestUserIdentity | null;
  installCommand?: string;
  /** Per-instance gateway bearer token, minted by orchestration (D9 — lands in a later commit). */
  gatewayToken?: string;
}

export interface RemoteRuntimeHandle {
  providerState: Record<string, unknown>;
  capabilitySnapshot: WorkspaceBackendCapabilitySnapshot;
  /** Legacy `session.podName` display alias (e.g. the remote sandbox id). */
  podNameAlias?: string;
}

export interface RemoteWorkspaceRuntimeProvider {
  readonly backendId: WorkspaceBackendId;
  provision(ctx: RemoteProvisionContext): Promise<RemoteRuntimeHandle>;
  /** Reconnects to an existing runtime; null when it is gone/unrecoverable so the caller provisions fresh. */
  reattach(state: unknown, readiness: ReadinessProfile): Promise<RemoteRuntimeHandle | null>;
  /** Symmetric with reattach; may return a new handle/URLs. Throws WorkspaceRuntimeGoneError when the runtime expired. */
  resume(state: unknown, readiness: ReadinessProfile): Promise<RemoteRuntimeHandle>;
  /** May return an updated handle when suspension changes the persisted state (e.g. Modal snapshots). */
  suspend(state: unknown, opts: { retainForMs: number }): Promise<RemoteRuntimeHandle | void>;
  destroy(state: unknown): Promise<void>;
  renewLease?(state: unknown): Promise<void>;
  /** Non-destructive snapshot (Modal 24h-wall protection); may return an updated handle to persist. */
  checkpoint?(state: unknown): Promise<RemoteRuntimeHandle | void>;
  resolveGatewayEndpoint(state: unknown): WorkspaceRuntimeEndpoint | null;
  resolveEditorEndpoint(state: unknown): WorkspaceRuntimeEndpoint | null;
  capabilities(state?: unknown): WorkspaceBackendCapabilitySnapshot;
  /** True when the state holds a real provisioned handle (vs a row stamped at claim but never provisioned). */
  hasPersistedHandle(state: unknown): boolean;
}

export interface WorkspaceBackendTestConnectionResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** A selectable workspace source on the provider account (E2B template, Daytona snapshot, …). */
export interface WorkspaceSourceOption {
  id: string;
  label: string;
  detail?: string;
  ready: boolean;
}

export type WorkspaceBackendDeepCheckStageStatus = 'passed' | 'failed' | 'skipped';

export interface WorkspaceBackendDeepCheckStage {
  name: string;
  status: WorkspaceBackendDeepCheckStageStatus;
  detail?: string;
}

/** Result of booting a real throwaway sandbox end-to-end (provision → gateway → editor → destroy). */
export interface WorkspaceBackendDeepCheckResult {
  ok: boolean;
  message: string;
  durationMs: number;
  stages: WorkspaceBackendDeepCheckStage[];
  details?: Record<string, unknown>;
}

export interface WorkspaceBackendDescriptor {
  readonly id: WorkspaceBackendId;
  readonly displayName: string;
  readonly status: WorkspaceBackendStatus;
  readonly declaredCapabilities: WorkspaceBackendCapabilities;
  /** Config fields that carry credentials (encrypted at rest + redacted to presence flags on read). */
  readonly secretFields: string[];
  isConfigured(config: ResolvedAgentSessionWorkspaceBackendConfig): boolean;
  /** Required-but-unset config fields, evaluated against the merged (payload ∨ stored ∨ env) config. */
  missingConfigFields?(config: ResolvedAgentSessionWorkspaceBackendConfig): string[];
  testConnection?(config: ResolvedAgentSessionWorkspaceBackendConfig): Promise<WorkspaceBackendTestConnectionResult>;
  /** Lists the account's selectable workspace sources so admins pick instead of pasting ids. */
  listWorkspaceSources?(config: ResolvedAgentSessionWorkspaceBackendConfig): Promise<WorkspaceSourceOption[]>;
  /** Absent for the native Kubernetes path. */
  createProvider?(config: ResolvedAgentSessionWorkspaceBackendConfig): RemoteWorkspaceRuntimeProvider;
}

export class WorkspaceBackendCapabilityError extends Error {
  constructor(
    public readonly backendId: string,
    public readonly missingCapabilities: WorkspaceBackendCapabilityKey[],
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceBackendCapabilityError';
  }
}

/** The remote runtime no longer exists upstream (expired/terminated); maps to `workspace_expired`. */
export class WorkspaceRuntimeGoneError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'WorkspaceRuntimeGoneError';
  }
}

/**
 * A remote runtime failed a security verification (e.g. its gateway does not enforce the bearer
 * token). Always a non-retryable failure: the workspace must never be marked ready.
 */
export class WorkspaceRuntimeSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRuntimeSecurityError';
  }
}

/** A sandbox row references a provider id with no registered backend (typo / version skew / rollback). */
export class WorkspaceBackendUnknownError extends Error {
  constructor(public readonly provider: string) {
    super(`Unknown workspace backend provider '${provider}'; the sandbox row references an unregistered backend.`);
    this.name = 'WorkspaceBackendUnknownError';
  }
}

/**
 * Non-retryable failure code for an expired remote workspace. INVARIANT: chat sessions keep their
 * retry affordance because openChatRuntime's FAILED→retry is unconditional server-side and
 * provisions a fresh workspace; environment sessions hide retry on non-retryable failures, which
 * is safe because remote backends can never run them (environmentSessions capability floor).
 */
export const WORKSPACE_EXPIRED_FAILURE_CODE = 'workspace_expired';
