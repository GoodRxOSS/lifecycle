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

import GlobalConfigService from 'server/services/globalConfig';
import { decryptConfigSecret, isEncryptedConfigSecret } from 'server/lib/encryption';
import { getLogger } from 'server/lib/logger';
import { DEFAULT_E2B_TIMEOUT_SECONDS } from './runtimeDefaults';
import type {
  AgentSessionControlPlaneConfig,
  AgentSessionCleanupConfig,
  AgentSessionDaytonaBackendConfig,
  AgentSessionDefaults,
  AgentSessionDurabilityConfig,
  AgentSessionE2bBackendConfig,
  AgentSessionModalBackendConfig,
  AgentSessionReadinessConfig,
  AgentSessionResourcesConfig,
  AgentSessionSchedulingConfig,
  AgentSessionOpenSandboxBackendConfig,
  AgentSessionWorkspaceBackendConfig,
  AgentSessionWorkspaceBackendProvider,
  AgentSessionWorkspaceStorageAccessMode,
  AgentSessionWorkspaceStorageConfig,
  ResourceRequirements,
} from 'server/services/types/globalConfig';

export { DEFAULT_E2B_TIMEOUT_SECONDS } from './runtimeDefaults';

export interface AgentSessionRuntimeConfig {
  workspaceImage: string;
  workspaceEditorImage: string;
  workspaceGatewayImage: string;
  workspaceBackend: ResolvedAgentSessionWorkspaceBackendConfig;
  nodeSelector?: Record<string, string>;
  keepAttachedServicesOnSessionNode: boolean;
  readiness: ResolvedAgentSessionReadinessConfig;
  resources: ResolvedAgentSessionResources;
  workspaceStorage: ResolvedAgentSessionWorkspaceStorageConfig;
  cleanup: ResolvedAgentSessionCleanupConfig;
  durability: ResolvedAgentSessionDurabilityConfig;
}

export interface ResolvedAgentSessionReadinessConfig {
  timeoutMs: number;
  pollMs: number;
}

export interface ResolvedAgentSessionResourceRequirements {
  requests: Record<string, string>;
  limits: Record<string, string>;
}

export interface ResolvedAgentSessionResources {
  workspace: ResolvedAgentSessionResourceRequirements;
  editor: ResolvedAgentSessionResourceRequirements;
  workspaceGateway: ResolvedAgentSessionResourceRequirements;
}

export interface ResolvedAgentSessionWorkspaceStorageConfig {
  defaultSize: string;
  allowedSizes: string[];
  allowClientOverride: boolean;
  accessMode: AgentSessionWorkspaceStorageAccessMode;
}

export interface ResolvedAgentSessionWorkspaceStorageIntent {
  requestedSize: string | null;
  storageSize: string;
  accessMode: AgentSessionWorkspaceStorageAccessMode;
}

export interface ResolvedAgentSessionCleanupConfig {
  activeIdleSuspendMs: number;
  startingTimeoutMs: number;
  hibernatedRetentionMs: number;
  intervalMs: number;
  redisTtlSeconds: number;
}

export interface ResolvedAgentSessionDurabilityConfig {
  runExecutionLeaseMs: number;
  queuedRunDispatchStaleMs: number;
  dispatchRecoveryLimit: number;
  maxDurablePayloadBytes: number;
  payloadPreviewBytes: number;
  fileChangePreviewChars: number;
}

export type { AgentSessionWorkspaceBackendProvider } from 'server/services/types/globalConfig';

export interface ResolvedAgentSessionOpenSandboxBackendConfig {
  domain: string;
  protocol: 'http' | 'https';
  apiKey?: string;
  image?: string;
  poolRef?: string;
  timeoutSeconds: number | null;
  useServerProxy: boolean;
  secureAccess: boolean;
  resourceLimits: Record<string, string>;
  execdPort: number;
  gatewayPort: number;
  editorPort: number;
}

export interface ResolvedAgentSessionE2bBackendConfig {
  domain: string;
  apiKey?: string;
  templateId?: string;
  timeoutSeconds: number | null;
  autoPause: boolean;
  gatewayPort: number;
  editorPort: number;
}

export interface ResolvedAgentSessionDaytonaBackendConfig {
  apiUrl: string;
  apiKey?: string;
  snapshot?: string;
  target?: string;
  /** Minutes continuously stopped before auto-archive; 0 = platform maximum (30 days). */
  autoArchiveInterval: number;
  gatewayPort: number;
  editorPort: number;
}

export interface ResolvedAgentSessionModalBackendConfig {
  tokenId?: string;
  tokenSecret?: string;
  environment?: string;
  appName: string;
  image: string;
  imageRegistrySecret?: string;
  /** Sandbox lifetime; Modal hard-caps at 24h with no extension API. */
  timeoutSeconds: number;
  cpu?: number;
  memoryMiB?: number;
  inboundCidrAllowlist?: string[];
  gatewayPort: number;
}

export interface ResolvedAgentSessionWorkspaceBackendConfig {
  provider: AgentSessionWorkspaceBackendProvider;
  opensandbox: ResolvedAgentSessionOpenSandboxBackendConfig;
  e2b: ResolvedAgentSessionE2bBackendConfig;
  daytona: ResolvedAgentSessionDaytonaBackendConfig;
  modal: ResolvedAgentSessionModalBackendConfig;
}

export interface ResolvedAgentSessionControlPlaneConfig {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxIterations: number;
  workspaceToolDiscoveryTimeoutMs: number;
  workspaceToolExecutionTimeoutMs: number;
}

export const DEFAULT_AGENT_SESSION_CONTROL_PLANE_SYSTEM_PROMPT = [
  'You are a Lifecycle agent operating through tool calls. Your identity, surface, and capabilities are defined by the agent instructions that follow — only the tools actually registered in this conversation exist.',
  'Do not emit pseudo-tool markup or pretend execution happened. Never write things like <read_file>, <write_file>, <attempt_completion>, <result>, or shell commands as if they were already executed.',
  'Do not claim that a file was read, a command was run, or a change was made unless that happened through an actual tool call in this conversation.',
  'A local git commit is not a remote branch update. Only say a PR branch, GitHub commit URL, webhook rebuild, or Lifecycle build changed after a successful push, GitHub API call, or observed Lifecycle state confirms it.',
  'If a tool call fails or a capability is unavailable, say that plainly and explain what failed.',
  'Never offer to perform an action you have no registered tool for; point to the visible UI action instead.',
].join('\n');

export const DEFAULT_AGENT_SESSION_CONTROL_PLANE_APPEND_SYSTEM_PROMPT = [
  'When a tool execution is not approved, do not retry the denied action. Use the denial reason as updated guidance and continue from there.',
  'When showing multi-line exact text such as file contents, command output, diffs, or JSON, use a fenced code block instead of inline code.',
].join('\n');
export const DEFAULT_AGENT_SESSION_MAX_ITERATIONS = 20;
// Cumulative input-token budget per run; the tool loop forces a tools-off answer step once exceeded.
export const DEFAULT_AGENT_SESSION_MAX_RUN_INPUT_TOKENS = 400_000;
export const DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_DISCOVERY_TIMEOUT_MS = 3000;
export const DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_EXECUTION_TIMEOUT_MS = 15000;
// Model-initiated workspace requests auto-provision by default; admins can require per-tool approval by disabling it.
export const DEFAULT_AGENT_SESSION_AUTO_PROVISION_WORKSPACE = true;
export const DEFAULT_AGENT_SESSION_KEEP_ATTACHED_SERVICES_ON_SESSION_NODE = true;

const DEFAULT_AGENT_READY_TIMEOUT_MS = 60000;
const DEFAULT_AGENT_READY_POLL_MS = 1000;
export const DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_SIZE = '10Gi';
export const DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_ACCESS_MODE: AgentSessionWorkspaceStorageAccessMode =
  'ReadWriteOnce';
export const DEFAULT_AGENT_SESSION_ACTIVE_IDLE_SUSPEND_MS = 30 * 60 * 1000;
export const DEFAULT_AGENT_SESSION_STARTING_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_AGENT_SESSION_HIBERNATED_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AGENT_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_AGENT_SESSION_REDIS_TTL_SECONDS = 7200;
export const DEFAULT_AGENT_SESSION_RUN_EXECUTION_LEASE_MS = 30 * 60 * 1000;
export const DEFAULT_AGENT_SESSION_QUEUED_RUN_DISPATCH_STALE_MS = 30 * 1000;
export const DEFAULT_AGENT_SESSION_DISPATCH_RECOVERY_LIMIT = 50;
export const DEFAULT_AGENT_SESSION_MAX_DURABLE_PAYLOAD_BYTES = 64 * 1024;
export const DEFAULT_AGENT_SESSION_PAYLOAD_PREVIEW_BYTES = 16 * 1024;
export const DEFAULT_AGENT_SESSION_FILE_CHANGE_PREVIEW_CHARS = 4000;
export const DEFAULT_AGENT_SESSION_WORKSPACE_BACKEND_PROVIDER: AgentSessionWorkspaceBackendProvider =
  'lifecycle_kubernetes';
export const DEFAULT_OPEN_SANDBOX_DOMAIN = 'localhost:8080';
export const DEFAULT_OPEN_SANDBOX_PROTOCOL: 'http' | 'https' = 'http';
export const DEFAULT_OPEN_SANDBOX_EXECD_PORT = 44772;
export const DEFAULT_OPEN_SANDBOX_TIMEOUT_SECONDS = 60 * 60;
export const DEFAULT_E2B_DOMAIN = 'e2b.app';
export const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api';
export const DEFAULT_DAYTONA_AUTO_ARCHIVE_INTERVAL = 0;
export const DEFAULT_MODAL_APP_NAME = 'lifecycle-workspaces';
// Published workspace image; operators should pin a tag for reproducible sandboxes.
export const DEFAULT_MODAL_IMAGE = 'lifecycleoss/workspace:latest';
export const DEFAULT_MODAL_TIMEOUT_SECONDS = 4 * 60 * 60;
export const MAX_MODAL_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_WORKSPACE_RESOURCES: ResolvedAgentSessionResourceRequirements = {
  requests: {
    cpu: '500m',
    memory: '1Gi',
  },
  limits: {
    cpu: '2',
    memory: '4Gi',
  },
};
const DEFAULT_EDITOR_RESOURCES: ResolvedAgentSessionResourceRequirements = {
  requests: {
    cpu: '250m',
    memory: '512Mi',
  },
  limits: {
    cpu: '1',
    memory: '1Gi',
  },
};
const DEFAULT_WORKSPACE_GATEWAY_RESOURCES: ResolvedAgentSessionResourceRequirements = {
  requests: {
    cpu: '100m',
    memory: '256Mi',
  },
  limits: {
    cpu: '500m',
    memory: '512Mi',
  },
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface ResolveWorkspaceBackendOptions {
  /** false = presence-only resolution (catalog/redaction paths); ciphertext passes through untouched. */
  decryptSecrets?: boolean;
}

// Legacy plaintext secrets pass through as-is and migrate to ciphertext on the next config save.
function resolveStoredSecret(value: unknown, decryptSecrets: boolean): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized || !isEncryptedConfigSecret(normalized)) {
    return normalized;
  }
  return decryptSecrets ? decryptConfigSecret(normalized) : normalized;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const normalized = normalizeNonNegativeInteger(value);

  if (normalized === undefined || normalized <= 0) {
    return undefined;
  }

  return normalized;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  return undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()))
  ).filter(Boolean);
}

function normalizeAccessMode(value: unknown): AgentSessionWorkspaceStorageAccessMode | undefined {
  return value === 'ReadWriteMany' || value === 'ReadWriteOnce' ? value : undefined;
}

function normalizeWorkspaceBackendProvider(value: unknown): AgentSessionWorkspaceBackendProvider | undefined {
  return value === 'opensandbox' ||
    value === 'lifecycle_kubernetes' ||
    value === 'e2b' ||
    value === 'daytona' ||
    value === 'modal'
    ? value
    : undefined;
}

function normalizeProtocol(value: unknown): 'http' | 'https' | undefined {
  return value === 'http' || value === 'https' ? value : undefined;
}

function normalizeResourceQuantityMap(values: unknown): Record<string, string> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(values)
      .filter(([key, value]) => typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim())
      .map(([key, value]) => [key.trim(), value.trim()])
  );
}

function mergeResourceRequirements(
  fallback: ResolvedAgentSessionResourceRequirements,
  overrides?: ResourceRequirements | null
): ResolvedAgentSessionResourceRequirements {
  return {
    requests: {
      ...fallback.requests,
      ...normalizeResourceQuantityMap(overrides?.requests),
    },
    limits: {
      ...fallback.limits,
      ...normalizeResourceQuantityMap(overrides?.limits),
    },
  };
}

function normalizeNodeSelector(scheduling?: AgentSessionSchedulingConfig | null): Record<string, string> | undefined {
  const nodeSelector = scheduling?.nodeSelector;

  if (!nodeSelector || typeof nodeSelector !== 'object' || Array.isArray(nodeSelector)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(nodeSelector)
      .filter(([key, value]) => typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim())
      .map(([key, value]) => [key.trim(), value.trim()])
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function resolveKeepAttachedServicesOnSessionNode(scheduling?: AgentSessionSchedulingConfig | null): boolean {
  return (
    normalizeBoolean(scheduling?.keepAttachedServicesOnSessionNode) ??
    DEFAULT_AGENT_SESSION_KEEP_ATTACHED_SERVICES_ON_SESSION_NODE
  );
}

function getDefaultReadinessConfig(): ResolvedAgentSessionReadinessConfig {
  return {
    timeoutMs:
      normalizeNonNegativeInteger(process.env.AGENT_SESSION_WORKSPACE_READY_TIMEOUT_MS) ??
      DEFAULT_AGENT_READY_TIMEOUT_MS,
    pollMs:
      normalizeNonNegativeInteger(process.env.AGENT_SESSION_WORKSPACE_READY_POLL_MS) ?? DEFAULT_AGENT_READY_POLL_MS,
  };
}

export function resolveAgentSessionReadinessFromDefaults(
  readinessDefaults?: AgentSessionReadinessConfig | null
): ResolvedAgentSessionReadinessConfig {
  const defaults = getDefaultReadinessConfig();

  return {
    timeoutMs: normalizeNonNegativeInteger(readinessDefaults?.timeoutMs) ?? defaults.timeoutMs,
    pollMs: normalizeNonNegativeInteger(readinessDefaults?.pollMs) ?? defaults.pollMs,
  };
}

export function mergeAgentSessionReadinessForServices(
  baseReadiness: ResolvedAgentSessionReadinessConfig,
  overrides: Array<AgentSessionReadinessConfig | null | undefined>
): ResolvedAgentSessionReadinessConfig {
  const timeoutOverrides = overrides
    .map((override) => normalizeNonNegativeInteger(override?.timeoutMs))
    .filter((value): value is number => value !== undefined);
  const pollOverrides = overrides
    .map((override) => normalizeNonNegativeInteger(override?.pollMs))
    .filter((value): value is number => value !== undefined);

  return {
    timeoutMs: timeoutOverrides.length > 0 ? Math.max(...timeoutOverrides) : baseReadiness.timeoutMs,
    pollMs: pollOverrides.length > 0 ? Math.min(...pollOverrides) : baseReadiness.pollMs,
  };
}

export function resolveAgentSessionResourcesFromDefaults(
  resourceDefaults?: AgentSessionResourcesConfig | null
): ResolvedAgentSessionResources {
  return {
    workspace: mergeResourceRequirements(DEFAULT_WORKSPACE_RESOURCES, resourceDefaults?.workspace),
    editor: mergeResourceRequirements(DEFAULT_EDITOR_RESOURCES, resourceDefaults?.editor),
    workspaceGateway: mergeResourceRequirements(
      DEFAULT_WORKSPACE_GATEWAY_RESOURCES,
      resourceDefaults?.workspaceGateway
    ),
  };
}

export function mergeAgentSessionResources(
  baseResources: ResolvedAgentSessionResources,
  overrides?: AgentSessionResourcesConfig | null
): ResolvedAgentSessionResources {
  return {
    workspace: mergeResourceRequirements(baseResources.workspace, overrides?.workspace),
    editor: mergeResourceRequirements(baseResources.editor, overrides?.editor),
    workspaceGateway: mergeResourceRequirements(baseResources.workspaceGateway, overrides?.workspaceGateway),
  };
}

export function resolveAgentSessionWorkspaceStorageFromDefaults(
  storageDefaults?: AgentSessionWorkspaceStorageConfig | null
): ResolvedAgentSessionWorkspaceStorageConfig {
  const defaultSize =
    normalizeOptionalString(storageDefaults?.defaultSize) || DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_SIZE;
  const configuredAllowedSizes = normalizeStringArray(storageDefaults?.allowedSizes);
  const allowedSizes = configuredAllowedSizes.includes(defaultSize)
    ? configuredAllowedSizes
    : [defaultSize, ...configuredAllowedSizes];

  return {
    defaultSize,
    allowedSizes,
    allowClientOverride: normalizeBoolean(storageDefaults?.allowClientOverride) ?? false,
    accessMode:
      normalizeAccessMode(storageDefaults?.accessMode) ||
      normalizeAccessMode(process.env.AGENT_SESSION_PVC_ACCESS_MODE) ||
      DEFAULT_AGENT_SESSION_WORKSPACE_STORAGE_ACCESS_MODE,
  };
}

function normalizeOpenSandboxConfig(
  defaults: AgentSessionOpenSandboxBackendConfig | null | undefined,
  workspaceImage: string | null | undefined,
  decryptSecrets: boolean
): ResolvedAgentSessionOpenSandboxBackendConfig {
  const envUseServerProxy = normalizeBoolean(process.env.OPEN_SANDBOX_USE_SERVER_PROXY);
  const envSecureAccess = normalizeBoolean(process.env.OPEN_SANDBOX_SECURE_ACCESS);
  const apiKey =
    resolveStoredSecret(defaults?.apiKey, decryptSecrets) || normalizeOptionalString(process.env.OPEN_SANDBOX_API_KEY);
  const image =
    normalizeOptionalString(defaults?.image) ||
    normalizeOptionalString(process.env.OPEN_SANDBOX_IMAGE) ||
    workspaceImage ||
    undefined;
  const poolRef =
    normalizeOptionalString(defaults?.poolRef) || normalizeOptionalString(process.env.OPEN_SANDBOX_POOL_REF);
  const configuredResourceLimits = normalizeResourceQuantityMap(defaults?.resourceLimits);
  const resourceLimits =
    Object.keys(configuredResourceLimits).length > 0
      ? configuredResourceLimits
      : {
          cpu: DEFAULT_WORKSPACE_RESOURCES.limits.cpu,
          memory: DEFAULT_WORKSPACE_RESOURCES.limits.memory,
        };
  const timeoutSeconds =
    defaults?.timeoutSeconds === null || process.env.OPEN_SANDBOX_TIMEOUT_SECONDS === 'null'
      ? null
      : normalizePositiveInteger(defaults?.timeoutSeconds) ??
        normalizePositiveInteger(process.env.OPEN_SANDBOX_TIMEOUT_SECONDS) ??
        DEFAULT_OPEN_SANDBOX_TIMEOUT_SECONDS;

  return {
    domain:
      normalizeOptionalString(defaults?.domain) ||
      normalizeOptionalString(process.env.OPEN_SANDBOX_DOMAIN) ||
      DEFAULT_OPEN_SANDBOX_DOMAIN,
    protocol:
      normalizeProtocol(defaults?.protocol) ||
      normalizeProtocol(process.env.OPEN_SANDBOX_PROTOCOL) ||
      DEFAULT_OPEN_SANDBOX_PROTOCOL,
    ...(apiKey ? { apiKey } : {}),
    ...(image ? { image } : {}),
    ...(poolRef ? { poolRef } : {}),
    timeoutSeconds,
    useServerProxy: normalizeBoolean(defaults?.useServerProxy) ?? envUseServerProxy ?? true,
    // Fail-safe default: the execd data plane is an arbitrary-exec surface.
    secureAccess: normalizeBoolean(defaults?.secureAccess) ?? envSecureAccess ?? true,
    resourceLimits,
    execdPort:
      normalizePositiveInteger(defaults?.execdPort) ??
      normalizePositiveInteger(process.env.OPEN_SANDBOX_EXECD_PORT) ??
      DEFAULT_OPEN_SANDBOX_EXECD_PORT,
    gatewayPort:
      normalizePositiveInteger(defaults?.gatewayPort) ??
      normalizePositiveInteger(process.env.AGENT_SESSION_WORKSPACE_GATEWAY_PORT) ??
      13338,
    editorPort:
      normalizePositiveInteger(defaults?.editorPort) ??
      normalizePositiveInteger(process.env.AGENT_SESSION_WORKSPACE_EDITOR_PORT) ??
      13337,
  };
}

function resolveWorkspaceGatewayPort(): number {
  return normalizePositiveInteger(process.env.AGENT_SESSION_WORKSPACE_GATEWAY_PORT) ?? 13338;
}

function resolveWorkspaceEditorPort(): number {
  return normalizePositiveInteger(process.env.AGENT_SESSION_WORKSPACE_EDITOR_PORT) ?? 13337;
}

function normalizeE2bConfig(
  defaults: AgentSessionE2bBackendConfig | null | undefined,
  decryptSecrets: boolean
): ResolvedAgentSessionE2bBackendConfig {
  const apiKey =
    resolveStoredSecret(defaults?.apiKey, decryptSecrets) || normalizeOptionalString(process.env.E2B_API_KEY);
  const templateId = normalizeOptionalString(defaults?.templateId);
  const timeoutSeconds =
    defaults?.timeoutSeconds === null
      ? null
      : normalizePositiveInteger(defaults?.timeoutSeconds) ?? DEFAULT_E2B_TIMEOUT_SECONDS;
  // E2B has no infinite TTL (null = "create with default TTL, never renew"), so a null timeout MUST
  // pair with autoPause to avoid a hard kill mid-session at the 1h wall with no dead-man fallback.
  const autoPause = timeoutSeconds === null ? true : normalizeBoolean(defaults?.autoPause) ?? true;

  return {
    domain: normalizeOptionalString(defaults?.domain) || DEFAULT_E2B_DOMAIN,
    ...(apiKey ? { apiKey } : {}),
    ...(templateId ? { templateId } : {}),
    timeoutSeconds,
    autoPause,
    gatewayPort: resolveWorkspaceGatewayPort(),
    editorPort: resolveWorkspaceEditorPort(),
  };
}

function normalizeDaytonaConfig(
  defaults: AgentSessionDaytonaBackendConfig | null | undefined,
  decryptSecrets: boolean
): ResolvedAgentSessionDaytonaBackendConfig {
  const apiKey =
    resolveStoredSecret(defaults?.apiKey, decryptSecrets) || normalizeOptionalString(process.env.DAYTONA_API_KEY);
  const snapshot = normalizeOptionalString(defaults?.snapshot);
  const target = normalizeOptionalString(defaults?.target);

  return {
    apiUrl: normalizeOptionalString(defaults?.apiUrl) || DEFAULT_DAYTONA_API_URL,
    ...(apiKey ? { apiKey } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(target ? { target } : {}),
    autoArchiveInterval:
      normalizeNonNegativeInteger(defaults?.autoArchiveInterval) ?? DEFAULT_DAYTONA_AUTO_ARCHIVE_INTERVAL,
    gatewayPort: resolveWorkspaceGatewayPort(),
    editorPort: resolveWorkspaceEditorPort(),
  };
}

function normalizePositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeModalConfig(
  defaults: AgentSessionModalBackendConfig | null | undefined,
  decryptSecrets: boolean
): ResolvedAgentSessionModalBackendConfig {
  // Modal credentials are valid only as a pair, so resolve both halves from the SAME source: a DB
  // tokenId paired with an env tokenSecret (or vice versa) fails auth confusingly. Use the DB pair
  // only when both are stored; otherwise fall back to env for both, warning on a partial DB pair.
  const dbTokenId = resolveStoredSecret(defaults?.tokenId, decryptSecrets);
  const dbTokenSecret = resolveStoredSecret(defaults?.tokenSecret, decryptSecrets);
  let tokenId: string | undefined;
  let tokenSecret: string | undefined;
  if (dbTokenId && dbTokenSecret) {
    tokenId = dbTokenId;
    tokenSecret = dbTokenSecret;
  } else {
    if (dbTokenId || dbTokenSecret) {
      getLogger().warn(
        'Modal credentials are incomplete in config (only one of tokenId/tokenSecret stored); falling back to MODAL_TOKEN_ID/MODAL_TOKEN_SECRET env for both.'
      );
    }
    tokenId = normalizeOptionalString(process.env.MODAL_TOKEN_ID);
    tokenSecret = normalizeOptionalString(process.env.MODAL_TOKEN_SECRET);
  }
  const environment = normalizeOptionalString(defaults?.environment);
  const imageRegistrySecret = normalizeOptionalString(defaults?.imageRegistrySecret);
  const cpu = normalizePositiveNumber(defaults?.cpu);
  const memoryMiB = normalizePositiveInteger(defaults?.memoryMiB);
  const inboundCidrAllowlist = normalizeStringArray(defaults?.inboundCidrAllowlist);

  return {
    ...(tokenId ? { tokenId } : {}),
    ...(tokenSecret ? { tokenSecret } : {}),
    ...(environment ? { environment } : {}),
    appName: normalizeOptionalString(defaults?.appName) || DEFAULT_MODAL_APP_NAME,
    image: normalizeOptionalString(defaults?.image) || DEFAULT_MODAL_IMAGE,
    ...(imageRegistrySecret ? { imageRegistrySecret } : {}),
    timeoutSeconds: Math.min(
      normalizePositiveInteger(defaults?.timeoutSeconds) ?? DEFAULT_MODAL_TIMEOUT_SECONDS,
      MAX_MODAL_TIMEOUT_SECONDS
    ),
    ...(cpu !== undefined ? { cpu } : {}),
    ...(memoryMiB !== undefined ? { memoryMiB } : {}),
    ...(inboundCidrAllowlist.length > 0 ? { inboundCidrAllowlist } : {}),
    gatewayPort: resolveWorkspaceGatewayPort(),
  };
}

export function resolveAgentSessionWorkspaceBackendFromDefaults(
  backendDefaults?: AgentSessionWorkspaceBackendConfig | null,
  workspaceImage?: string | null,
  opts: ResolveWorkspaceBackendOptions = {}
): ResolvedAgentSessionWorkspaceBackendConfig {
  const decryptSecrets = opts.decryptSecrets ?? true;
  const storedProvider = normalizeWorkspaceBackendProvider(backendDefaults?.provider);
  const envProvider = normalizeWorkspaceBackendProvider(process.env.AGENT_SESSION_WORKSPACE_BACKEND);
  // Surface a bad stored/env provider instead of silently defaulting to K8s (no-silent-fallback posture).
  if (!storedProvider && backendDefaults?.provider) {
    getLogger().warn(
      `Unknown workspace backend provider '${backendDefaults.provider}' in config; using the default backend.`
    );
  } else if (!storedProvider && !envProvider && process.env.AGENT_SESSION_WORKSPACE_BACKEND) {
    getLogger().warn(
      `Unknown AGENT_SESSION_WORKSPACE_BACKEND '${process.env.AGENT_SESSION_WORKSPACE_BACKEND}'; using the default backend.`
    );
  }
  const provider = storedProvider || envProvider || DEFAULT_AGENT_SESSION_WORKSPACE_BACKEND_PROVIDER;

  return {
    provider,
    opensandbox: normalizeOpenSandboxConfig(backendDefaults?.opensandbox, workspaceImage, decryptSecrets),
    e2b: normalizeE2bConfig(backendDefaults?.e2b, decryptSecrets),
    daytona: normalizeDaytonaConfig(backendDefaults?.daytona, decryptSecrets),
    modal: normalizeModalConfig(backendDefaults?.modal, decryptSecrets),
  };
}

/**
 * Resolves every backend's config block from global config + env fallback WITHOUT requiring the
 * workspace images: existing-row operations (suspend/resume/destroy/leases) must stay possible
 * even when session provisioning config is incomplete or the selected provider changed.
 */
export async function resolveAgentSessionWorkspaceBackendConfig(
  opts: ResolveWorkspaceBackendOptions = {}
): Promise<ResolvedAgentSessionWorkspaceBackendConfig> {
  const { agentSessionDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  return resolveAgentSessionWorkspaceBackendFromDefaults(
    agentSessionDefaults?.workspaceBackend,
    agentSessionDefaults?.workspaceImage?.trim() || null,
    opts
  );
}

export class AgentSessionWorkspaceStorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSessionWorkspaceStorageConfigError';
  }
}

export function resolveAgentSessionWorkspaceStorageIntent({
  requestedSize,
  storage,
}: {
  requestedSize?: string | null;
  storage: ResolvedAgentSessionWorkspaceStorageConfig;
}): ResolvedAgentSessionWorkspaceStorageIntent {
  const normalizedRequestedSize = normalizeOptionalString(requestedSize) || null;

  if (!normalizedRequestedSize) {
    return {
      requestedSize: null,
      storageSize: storage.defaultSize,
      accessMode: storage.accessMode,
    };
  }

  if (!storage.allowClientOverride) {
    throw new AgentSessionWorkspaceStorageConfigError('workspace.storageSize overrides are not enabled.');
  }

  if (!storage.allowedSizes.includes(normalizedRequestedSize)) {
    throw new AgentSessionWorkspaceStorageConfigError(
      `workspace.storageSize must be one of: ${storage.allowedSizes.join(', ')}.`
    );
  }

  return {
    requestedSize: normalizedRequestedSize,
    storageSize: normalizedRequestedSize,
    accessMode: storage.accessMode,
  };
}

export function resolveAgentSessionCleanupFromDefaults(
  cleanupDefaults?: AgentSessionCleanupConfig | null
): ResolvedAgentSessionCleanupConfig {
  return {
    activeIdleSuspendMs:
      normalizePositiveInteger(cleanupDefaults?.activeIdleSuspendMs) ?? DEFAULT_AGENT_SESSION_ACTIVE_IDLE_SUSPEND_MS,
    startingTimeoutMs:
      normalizePositiveInteger(cleanupDefaults?.startingTimeoutMs) ?? DEFAULT_AGENT_SESSION_STARTING_TIMEOUT_MS,
    hibernatedRetentionMs:
      normalizePositiveInteger(cleanupDefaults?.hibernatedRetentionMs) ?? DEFAULT_AGENT_SESSION_HIBERNATED_RETENTION_MS,
    intervalMs: normalizePositiveInteger(cleanupDefaults?.intervalMs) ?? DEFAULT_AGENT_SESSION_CLEANUP_INTERVAL_MS,
    redisTtlSeconds:
      normalizePositiveInteger(cleanupDefaults?.redisTtlSeconds) ?? DEFAULT_AGENT_SESSION_REDIS_TTL_SECONDS,
  };
}

export function resolveAgentSessionDurabilityFromDefaults(
  durabilityDefaults?: AgentSessionDurabilityConfig | null
): ResolvedAgentSessionDurabilityConfig {
  return {
    runExecutionLeaseMs:
      normalizePositiveInteger(durabilityDefaults?.runExecutionLeaseMs) ?? DEFAULT_AGENT_SESSION_RUN_EXECUTION_LEASE_MS,
    queuedRunDispatchStaleMs:
      normalizePositiveInteger(durabilityDefaults?.queuedRunDispatchStaleMs) ??
      DEFAULT_AGENT_SESSION_QUEUED_RUN_DISPATCH_STALE_MS,
    dispatchRecoveryLimit:
      normalizePositiveInteger(durabilityDefaults?.dispatchRecoveryLimit) ??
      DEFAULT_AGENT_SESSION_DISPATCH_RECOVERY_LIMIT,
    maxDurablePayloadBytes:
      normalizePositiveInteger(durabilityDefaults?.maxDurablePayloadBytes) ??
      DEFAULT_AGENT_SESSION_MAX_DURABLE_PAYLOAD_BYTES,
    payloadPreviewBytes:
      normalizePositiveInteger(durabilityDefaults?.payloadPreviewBytes) ?? DEFAULT_AGENT_SESSION_PAYLOAD_PREVIEW_BYTES,
    fileChangePreviewChars:
      normalizePositiveInteger(durabilityDefaults?.fileChangePreviewChars) ??
      DEFAULT_AGENT_SESSION_FILE_CHANGE_PREVIEW_CHARS,
  };
}

export function resolveAgentSessionControlPlaneConfigFromDefaults(
  agentSessionDefaults?: AgentSessionDefaults | null
): ResolvedAgentSessionControlPlaneConfig {
  const controlPlaneDefaults: AgentSessionControlPlaneConfig | undefined = agentSessionDefaults?.controlPlane;
  const systemPrompt =
    normalizeOptionalString(controlPlaneDefaults?.systemPrompt) || DEFAULT_AGENT_SESSION_CONTROL_PLANE_SYSTEM_PROMPT;
  const appendSystemPrompt =
    normalizeOptionalString(controlPlaneDefaults?.appendSystemPrompt) ||
    DEFAULT_AGENT_SESSION_CONTROL_PLANE_APPEND_SYSTEM_PROMPT;
  const maxIterations =
    normalizePositiveInteger(controlPlaneDefaults?.maxIterations) || DEFAULT_AGENT_SESSION_MAX_ITERATIONS;
  const workspaceToolDiscoveryTimeoutMs =
    normalizePositiveInteger(controlPlaneDefaults?.workspaceToolDiscoveryTimeoutMs) ||
    DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_DISCOVERY_TIMEOUT_MS;
  const workspaceToolExecutionTimeoutMs =
    normalizePositiveInteger(controlPlaneDefaults?.workspaceToolExecutionTimeoutMs) ||
    DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_EXECUTION_TIMEOUT_MS;

  return {
    systemPrompt,
    appendSystemPrompt,
    maxIterations,
    workspaceToolDiscoveryTimeoutMs,
    workspaceToolExecutionTimeoutMs,
  };
}

export async function resolveAgentSessionControlPlaneConfig(): Promise<ResolvedAgentSessionControlPlaneConfig> {
  const { agentSessionDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  return resolveAgentSessionControlPlaneConfigFromDefaults(agentSessionDefaults);
}

export async function resolveAgentSessionCleanupConfig(): Promise<ResolvedAgentSessionCleanupConfig> {
  const { agentSessionDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  return resolveAgentSessionCleanupFromDefaults(agentSessionDefaults?.cleanup);
}

export async function resolveAgentSessionDurabilityConfig(): Promise<ResolvedAgentSessionDurabilityConfig> {
  const { agentSessionDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  return resolveAgentSessionDurabilityFromDefaults(agentSessionDefaults?.durability);
}

export class AgentSessionRuntimeConfigError extends Error {
  readonly missingFields: Array<'workspaceImage' | 'workspaceEditorImage'>;

  constructor(missingFields: Array<'workspaceImage' | 'workspaceEditorImage'>) {
    super(`Agent session workspace is not configured. Missing ${missingFields.join(' and ')}.`);
    this.name = 'AgentSessionRuntimeConfigError';
    this.missingFields = missingFields;
  }
}

export async function resolveAgentSessionRuntimeConfig(): Promise<AgentSessionRuntimeConfig> {
  const { agentSessionDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  const workspaceImage = agentSessionDefaults?.workspaceImage?.trim() || '';
  const workspaceEditorImage = agentSessionDefaults?.workspaceEditorImage?.trim() || '';
  const workspaceGatewayImage = agentSessionDefaults?.workspaceGatewayImage?.trim() || workspaceImage;
  const missingFields: Array<'workspaceImage' | 'workspaceEditorImage'> = [];

  if (!workspaceImage) {
    missingFields.push('workspaceImage');
  }

  if (!workspaceEditorImage) {
    missingFields.push('workspaceEditorImage');
  }

  if (missingFields.length > 0) {
    throw new AgentSessionRuntimeConfigError(missingFields);
  }

  return {
    workspaceImage,
    workspaceEditorImage,
    workspaceGatewayImage,
    workspaceBackend: resolveAgentSessionWorkspaceBackendFromDefaults(
      agentSessionDefaults?.workspaceBackend,
      workspaceImage
    ),
    nodeSelector: normalizeNodeSelector(agentSessionDefaults?.scheduling),
    keepAttachedServicesOnSessionNode: resolveKeepAttachedServicesOnSessionNode(agentSessionDefaults?.scheduling),
    readiness: resolveAgentSessionReadinessFromDefaults(agentSessionDefaults?.readiness),
    resources: resolveAgentSessionResourcesFromDefaults(agentSessionDefaults?.resources),
    workspaceStorage: resolveAgentSessionWorkspaceStorageFromDefaults(agentSessionDefaults?.workspaceStorage),
    cleanup: resolveAgentSessionCleanupFromDefaults(agentSessionDefaults?.cleanup),
    durability: resolveAgentSessionDurabilityFromDefaults(agentSessionDefaults?.durability),
  };
}
