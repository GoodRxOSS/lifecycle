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

import BaseService from './_service';
import AgentSandbox from 'server/models/AgentSandbox';
import McpServerConfig from 'server/models/McpServerConfig';
import UserMcpConnection from 'server/models/UserMcpConnection';
import GlobalConfigService from './globalConfig';
import { ConflictError } from 'server/lib/appError';
import { encryptConfigSecret, isEncryptedConfigSecret } from 'server/lib/encryption';
import { normalizeRepoFullName } from 'server/lib/normalizeRepoFullName';
import { getWorkspaceBackendDescriptor, listWorkspaceBackendDescriptors } from './workspaceRuntime/registry';
import { clearBackendVerifications } from './workspaceRuntime/verificationState';
import type { WorkspaceBackendId } from './workspaceRuntime/types';
import {
  AgentSessionConfigValidationError,
  validateAgentSessionControlPlaneConfig,
  validateAgentSessionRuntimeSettings,
} from 'server/lib/validation/agentSessionConfigValidator';
import type {
  AgentCapabilityInventoryEntry,
  AgentCapabilityInventoryToolEntry,
  AgentSessionControlPlaneConfigValue,
  AgentSessionDaytonaBackendSettingsValue,
  AgentSessionE2bBackendSettingsValue,
  AgentSessionModalBackendSettingsValue,
  AgentSessionOpenSandboxBackendSettingsValue,
  AgentSessionRuntimeSettingsValue,
  AgentSessionWorkspaceBackendSettingsValue,
  AgentSessionToolInventoryEntry,
  AgentSessionToolRule,
  AgentSessionToolRuleSelection,
  EffectiveAgentSessionControlPlaneConfig,
} from './types/agentSessionConfig';
import AgentRuntimeConfigService from 'server/services/agentRuntime/config/agentRuntimeConfig';
import type { CapabilityPolicyConfig } from './types/agentRuntimeConfig';
import type { AgentSessionDefaults, AgentSessionWorkspaceBackendConfig, GlobalConfig } from './types/globalConfig';
import {
  DEFAULT_AGENT_SESSION_AUTO_PROVISION_WORKSPACE,
  DEFAULT_AGENT_SESSION_CONTROL_PLANE_APPEND_SYSTEM_PROMPT,
  DEFAULT_AGENT_SESSION_CONTROL_PLANE_SYSTEM_PROMPT,
  DEFAULT_AGENT_SESSION_MAX_ITERATIONS,
  DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_DISCOVERY_TIMEOUT_MS,
  DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_EXECUTION_TIMEOUT_MS,
  resolveAgentSessionWorkspaceBackendFromDefaults,
  type ResolvedAgentSessionDaytonaBackendConfig,
  type ResolvedAgentSessionE2bBackendConfig,
  type ResolvedAgentSessionModalBackendConfig,
  type ResolvedAgentSessionOpenSandboxBackendConfig,
} from 'server/lib/agentSession/runtimeConfig';
import { McpConfigService } from 'server/services/agentRuntime/mcp/config';
import { normalizeAuthConfig, requiresUserConnection } from 'server/services/agentRuntime/mcp/connectionConfig';
import AgentPolicyService from './agent/PolicyService';
import {
  listAgentCapabilityCatalogEntries,
  type AgentCapabilityCatalogEntry,
  type AgentCapabilityCatalogId,
} from './agent/capabilityCatalog';
import { buildAgentToolKey, LIFECYCLE_BUILTIN_SERVER_NAME, LIFECYCLE_BUILTIN_SERVER_SLUG } from './agent/toolKeys';
import type { McpDiscoveredTool } from 'server/services/agentRuntime/mcp/types';
import {
  getWorkspaceCoreToolDefinition,
  WORKSPACE_CORE_SERVER_NAME,
  WORKSPACE_CORE_SERVER_SLUG,
  WORKSPACE_CORE_TOOL_DEFINITIONS,
} from './workspaceCoreMcp/toolDefinitions';

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeNullablePositiveInteger(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  return normalizePositiveInteger(value);
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
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

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, entryValue]) =>
          typeof key === 'string' && key.trim() && typeof entryValue === 'string' && entryValue.trim()
      )
      .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = Array.from(
    new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()))
  ).filter(Boolean);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeWorkspaceStorageAccessMode(value: unknown): 'ReadWriteOnce' | 'ReadWriteMany' | undefined {
  return value === 'ReadWriteOnce' || value === 'ReadWriteMany' ? value : undefined;
}

function normalizeWorkspaceBackendProvider(
  value: unknown
): AgentSessionWorkspaceBackendSettingsValue['provider'] | undefined {
  return value === 'lifecycle_kubernetes' ||
    value === 'opensandbox' ||
    value === 'e2b' ||
    value === 'daytona' ||
    value === 'modal'
    ? value
    : undefined;
}

function normalizeOpenSandboxProtocol(value: unknown): AgentSessionOpenSandboxBackendSettingsValue['protocol'] {
  return value === 'http' || value === 'https' ? value : undefined;
}

function normalizeResourceRequirements(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const requests = normalizeStringRecord((value as { requests?: unknown }).requests);
  const limits = normalizeStringRecord((value as { limits?: unknown }).limits);

  if (!requests && !limits) {
    return undefined;
  }

  return {
    ...(requests ? { requests } : {}),
    ...(limits ? { limits } : {}),
  };
}

function normalizeOpenSandboxBackend(value: unknown): AgentSessionOpenSandboxBackendSettingsValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const domain = normalizeOptionalString((value as { domain?: unknown }).domain);
  const protocol = normalizeOpenSandboxProtocol((value as { protocol?: unknown }).protocol);
  const apiKey = normalizeOptionalString((value as { apiKey?: unknown }).apiKey);
  const image = normalizeOptionalString((value as { image?: unknown }).image);
  const poolRef = normalizeOptionalString((value as { poolRef?: unknown }).poolRef);
  const timeoutSeconds = normalizeNullablePositiveInteger((value as { timeoutSeconds?: unknown }).timeoutSeconds);
  const useServerProxy = normalizeBoolean((value as { useServerProxy?: unknown }).useServerProxy);
  const secureAccess = normalizeBoolean((value as { secureAccess?: unknown }).secureAccess);
  const resourceLimits = normalizeStringRecord((value as { resourceLimits?: unknown }).resourceLimits);
  const execdPort = normalizePositiveInteger((value as { execdPort?: unknown }).execdPort);
  const gatewayPort = normalizePositiveInteger((value as { gatewayPort?: unknown }).gatewayPort);
  const editorPort = normalizePositiveInteger((value as { editorPort?: unknown }).editorPort);

  if (
    !domain &&
    !protocol &&
    !apiKey &&
    !image &&
    !poolRef &&
    timeoutSeconds === undefined &&
    useServerProxy === undefined &&
    secureAccess === undefined &&
    !resourceLimits &&
    execdPort === undefined &&
    gatewayPort === undefined &&
    editorPort === undefined
  ) {
    return undefined;
  }

  return {
    ...(domain ? { domain } : {}),
    ...(protocol ? { protocol } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(image ? { image } : {}),
    ...(poolRef ? { poolRef } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(useServerProxy !== undefined ? { useServerProxy } : {}),
    ...(secureAccess !== undefined ? { secureAccess } : {}),
    ...(resourceLimits ? { resourceLimits } : {}),
    ...(execdPort !== undefined ? { execdPort } : {}),
    ...(gatewayPort !== undefined ? { gatewayPort } : {}),
    ...(editorPort !== undefined ? { editorPort } : {}),
  };
}

function redactOpenSandboxSettings(
  opensandbox: AgentSessionOpenSandboxBackendSettingsValue | ResolvedAgentSessionOpenSandboxBackendConfig
): AgentSessionOpenSandboxBackendSettingsValue {
  const { apiKey, ...rest } = opensandbox;
  return {
    ...rest,
    apiKeyConfigured: Boolean(apiKey) || Boolean(normalizeOptionalString(process.env.OPEN_SANDBOX_API_KEY)),
  };
}

function normalizeE2bBackend(value: unknown): AgentSessionE2bBackendSettingsValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const apiKey = normalizeOptionalString((value as { apiKey?: unknown }).apiKey);
  const templateId = normalizeOptionalString((value as { templateId?: unknown }).templateId);
  const domain = normalizeOptionalString((value as { domain?: unknown }).domain);
  const timeoutSeconds = normalizeNullablePositiveInteger((value as { timeoutSeconds?: unknown }).timeoutSeconds);
  const autoPause = normalizeBoolean((value as { autoPause?: unknown }).autoPause);

  if (!apiKey && !templateId && !domain && timeoutSeconds === undefined && autoPause === undefined) {
    return undefined;
  }

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(templateId ? { templateId } : {}),
    ...(domain ? { domain } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(autoPause !== undefined ? { autoPause } : {}),
  };
}

function normalizeDaytonaBackend(value: unknown): AgentSessionDaytonaBackendSettingsValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const apiKey = normalizeOptionalString((value as { apiKey?: unknown }).apiKey);
  const snapshot = normalizeOptionalString((value as { snapshot?: unknown }).snapshot);
  const apiUrl = normalizeOptionalString((value as { apiUrl?: unknown }).apiUrl);
  const target = normalizeOptionalString((value as { target?: unknown }).target);
  const autoArchiveInterval = normalizeNonNegativeInteger(
    (value as { autoArchiveInterval?: unknown }).autoArchiveInterval
  );

  if (!apiKey && !snapshot && !apiUrl && !target && autoArchiveInterval === undefined) {
    return undefined;
  }

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(target ? { target } : {}),
    ...(autoArchiveInterval !== undefined ? { autoArchiveInterval } : {}),
  };
}

function redactE2bSettings(
  e2b: AgentSessionE2bBackendSettingsValue | ResolvedAgentSessionE2bBackendConfig
): AgentSessionE2bBackendSettingsValue {
  // gatewayPort/editorPort are env-resolved, not admin-writable; drop them so GET output round-trips the PUT schema.
  const {
    apiKey,
    gatewayPort: _gatewayPort,
    editorPort: _editorPort,
    ...rest
  } = e2b as ResolvedAgentSessionE2bBackendConfig;
  return {
    ...rest,
    apiKeyConfigured: Boolean(apiKey) || Boolean(normalizeOptionalString(process.env.E2B_API_KEY)),
  };
}

function redactDaytonaSettings(
  daytona: AgentSessionDaytonaBackendSettingsValue | ResolvedAgentSessionDaytonaBackendConfig
): AgentSessionDaytonaBackendSettingsValue {
  const {
    apiKey,
    gatewayPort: _gatewayPort,
    editorPort: _editorPort,
    ...rest
  } = daytona as ResolvedAgentSessionDaytonaBackendConfig;
  return {
    ...rest,
    apiKeyConfigured: Boolean(apiKey) || Boolean(normalizeOptionalString(process.env.DAYTONA_API_KEY)),
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

function normalizeModalBackend(value: unknown): AgentSessionModalBackendSettingsValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const tokenId = normalizeOptionalString((value as { tokenId?: unknown }).tokenId);
  const tokenSecret = normalizeOptionalString((value as { tokenSecret?: unknown }).tokenSecret);
  const environment = normalizeOptionalString((value as { environment?: unknown }).environment);
  const appName = normalizeOptionalString((value as { appName?: unknown }).appName);
  const image = normalizeOptionalString((value as { image?: unknown }).image);
  const imageRegistrySecret = normalizeOptionalString((value as { imageRegistrySecret?: unknown }).imageRegistrySecret);
  const timeoutSeconds = normalizePositiveInteger((value as { timeoutSeconds?: unknown }).timeoutSeconds);
  const cpu = normalizePositiveNumber((value as { cpu?: unknown }).cpu);
  const memoryMiB = normalizePositiveInteger((value as { memoryMiB?: unknown }).memoryMiB);
  const inboundCidrAllowlist = normalizeStringArray((value as { inboundCidrAllowlist?: unknown }).inboundCidrAllowlist);

  if (
    !tokenId &&
    !tokenSecret &&
    !environment &&
    !appName &&
    !image &&
    !imageRegistrySecret &&
    timeoutSeconds === undefined &&
    cpu === undefined &&
    memoryMiB === undefined &&
    !inboundCidrAllowlist
  ) {
    return undefined;
  }

  return {
    ...(tokenId ? { tokenId } : {}),
    ...(tokenSecret ? { tokenSecret } : {}),
    ...(environment ? { environment } : {}),
    ...(appName ? { appName } : {}),
    ...(image ? { image } : {}),
    ...(imageRegistrySecret ? { imageRegistrySecret } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(cpu !== undefined ? { cpu } : {}),
    ...(memoryMiB !== undefined ? { memoryMiB } : {}),
    ...(inboundCidrAllowlist ? { inboundCidrAllowlist } : {}),
  };
}

function redactModalSettings(
  modal: AgentSessionModalBackendSettingsValue | ResolvedAgentSessionModalBackendConfig
): AgentSessionModalBackendSettingsValue {
  // gatewayPort is env-resolved, not admin-writable; drop it so GET output round-trips the PUT schema.
  const { tokenId, tokenSecret, gatewayPort: _gatewayPort, ...rest } = modal as ResolvedAgentSessionModalBackendConfig;
  return {
    ...rest,
    tokenIdConfigured: Boolean(tokenId) || Boolean(normalizeOptionalString(process.env.MODAL_TOKEN_ID)),
    tokenSecretConfigured: Boolean(tokenSecret) || Boolean(normalizeOptionalString(process.env.MODAL_TOKEN_SECRET)),
  };
}

function normalizeWorkspaceBackend(value: unknown): AgentSessionWorkspaceBackendSettingsValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const provider = normalizeWorkspaceBackendProvider((value as { provider?: unknown }).provider);
  const opensandbox = normalizeOpenSandboxBackend((value as { opensandbox?: unknown }).opensandbox);
  const e2b = normalizeE2bBackend((value as { e2b?: unknown }).e2b);
  const daytona = normalizeDaytonaBackend((value as { daytona?: unknown }).daytona);
  const modal = normalizeModalBackend((value as { modal?: unknown }).modal);

  if (!provider && !opensandbox && !e2b && !daytona && !modal) {
    return undefined;
  }

  return {
    ...(provider ? { provider } : {}),
    ...(opensandbox ? { opensandbox } : {}),
    ...(e2b ? { e2b } : {}),
    ...(daytona ? { daytona } : {}),
    ...(modal ? { modal } : {}),
  };
}

type WorkspaceBackendBlockKey = Exclude<keyof AgentSessionWorkspaceBackendSettingsValue, 'provider'>;

const WORKSPACE_BACKEND_BLOCK_KEYS = listWorkspaceBackendDescriptors()
  .filter((descriptor) => descriptor.createProvider)
  .map((descriptor) => descriptor.id) as WorkspaceBackendBlockKey[];

/**
 * Merge-not-replace: a PUT lacking a backend's block preserves the stored block (incl. ciphertext);
 * present blocks replace the stored block as a whole; null sentinels delete the stored block.
 */
function mergeWorkspaceBackendSettings(
  stored: AgentSessionWorkspaceBackendConfig | undefined,
  incoming: AgentSessionWorkspaceBackendSettingsValue | undefined,
  removedBackends: ReadonlySet<string>
): AgentSessionWorkspaceBackendConfig | undefined {
  const merged: AgentSessionWorkspaceBackendConfig = {};
  const provider = incoming?.provider ?? normalizeWorkspaceBackendProvider(stored?.provider);
  if (provider) {
    merged.provider = provider;
  }

  for (const key of WORKSPACE_BACKEND_BLOCK_KEYS) {
    if (removedBackends.has(key)) {
      continue;
    }
    const block = incoming?.[key] ?? stored?.[key];
    if (block) {
      (merged as Record<string, unknown>)[key] = { ...block };
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

// GET never returns secrets, so clients can't echo them back: a present block that omits a secret
// field keeps the stored value (ciphertext untouched).
function preserveWorkspaceBackendSecrets(
  merged: AgentSessionWorkspaceBackendConfig,
  stored: AgentSessionWorkspaceBackendConfig | undefined
): void {
  const mergedBlocks = merged as Record<string, Record<string, unknown> | undefined>;
  const storedBlocks = stored as Record<string, Record<string, unknown> | undefined> | undefined;
  for (const descriptor of listWorkspaceBackendDescriptors()) {
    const block = mergedBlocks[descriptor.id];
    if (!block) {
      continue;
    }
    for (const field of descriptor.secretFields) {
      const value =
        normalizeOptionalString(block[field]) || normalizeOptionalString(storedBlocks?.[descriptor.id]?.[field]);
      if (value) {
        block[field] = value;
      } else {
        delete block[field];
      }
    }
  }
}

// Write-commit path only (after validation): encrypt at rest; legacy plaintext migrates on write.
function encryptWorkspaceBackendSecrets(merged: AgentSessionWorkspaceBackendConfig): void {
  const mergedBlocks = merged as Record<string, Record<string, unknown> | undefined>;
  for (const descriptor of listWorkspaceBackendDescriptors()) {
    const block = mergedBlocks[descriptor.id];
    if (!block) {
      continue;
    }
    for (const field of descriptor.secretFields) {
      const value = block[field];
      if (typeof value === 'string' && value && !isEncryptedConfigSecret(value)) {
        block[field] = encryptConfigSecret(value);
      }
    }
  }
}

// Selecting an unconfigured or unavailable provider is validated against the merged payload ∨ stored ∨ env config.
function validateSelectedWorkspaceBackend(
  mergedBackend: AgentSessionWorkspaceBackendConfig | undefined,
  workspaceImage: string | null
): void {
  const resolved = resolveAgentSessionWorkspaceBackendFromDefaults(mergedBackend, workspaceImage, {
    decryptSecrets: false,
  });
  const descriptor = getWorkspaceBackendDescriptor(resolved.provider);
  if (!descriptor || descriptor.status !== 'available') {
    throw new AgentSessionConfigValidationError(
      `Workspace backend "${resolved.provider}" is not available for selection.`
    );
  }

  const missingFields = descriptor.missingConfigFields?.(resolved) ?? [];
  if (missingFields.length > 0) {
    throw new AgentSessionConfigValidationError(
      `The ${descriptor.displayName} workspace backend is not configured. ` +
        `Missing required fields: ${missingFields.join(', ')}.`
    );
  }
}

function validateRequiredRuntimeImages(config: Partial<AgentSessionDefaults>): void {
  const missingFields: string[] = [];

  if (!normalizeOptionalString(config.workspaceImage)) {
    missingFields.push('workspaceImage');
  }

  if (!normalizeOptionalString(config.workspaceEditorImage)) {
    missingFields.push('workspaceEditorImage');
  }

  if (missingFields.length > 0) {
    throw new AgentSessionConfigValidationError(`Missing required runtime fields: ${missingFields.join(', ')}.`);
  }
}

function normalizeToolRules(value: unknown): AgentSessionToolRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = new Map<string, AgentSessionToolRule>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const toolKey =
      typeof (entry as { toolKey?: unknown }).toolKey === 'string' ? (entry as { toolKey: string }).toolKey : '';
    const mode = (entry as { mode?: unknown }).mode;
    if (!toolKey || (mode !== 'allow' && mode !== 'require_approval' && mode !== 'deny')) {
      continue;
    }
    deduped.set(toolKey, { toolKey, mode });
  }

  return Array.from(deduped.values()).sort((left, right) => left.toolKey.localeCompare(right.toolKey));
}

function normalizeControlPlaneConfig(value: unknown): AgentSessionControlPlaneConfigValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return {
    systemPrompt: normalizeOptionalString((value as { systemPrompt?: unknown }).systemPrompt),
    appendSystemPrompt: normalizeOptionalString((value as { appendSystemPrompt?: unknown }).appendSystemPrompt),
    maxIterations: normalizePositiveInteger((value as { maxIterations?: unknown }).maxIterations),
    workspaceToolDiscoveryTimeoutMs: normalizePositiveInteger(
      (value as { workspaceToolDiscoveryTimeoutMs?: unknown }).workspaceToolDiscoveryTimeoutMs
    ),
    workspaceToolExecutionTimeoutMs: normalizePositiveInteger(
      (value as { workspaceToolExecutionTimeoutMs?: unknown }).workspaceToolExecutionTimeoutMs
    ),
    autoProvisionWorkspace: normalizeBoolean((value as { autoProvisionWorkspace?: unknown }).autoProvisionWorkspace),
    toolRules: normalizeToolRules((value as { toolRules?: unknown }).toolRules),
  };
}

function normalizeRuntimeSettings(value: unknown): AgentSessionRuntimeSettingsValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const workspaceImage = normalizeOptionalString((value as { workspaceImage?: unknown }).workspaceImage);
  const workspaceEditorImage = normalizeOptionalString(
    (value as { workspaceEditorImage?: unknown }).workspaceEditorImage
  );
  const workspaceGatewayImage = normalizeOptionalString(
    (value as { workspaceGatewayImage?: unknown }).workspaceGatewayImage
  );
  const nodeSelector = normalizeStringRecord(
    (value as { scheduling?: { nodeSelector?: unknown } }).scheduling?.nodeSelector
  );
  const keepAttachedServicesOnSessionNode = normalizeBoolean(
    (value as { scheduling?: { keepAttachedServicesOnSessionNode?: unknown } }).scheduling
      ?.keepAttachedServicesOnSessionNode
  );
  const readinessTimeoutMs = normalizeNonNegativeInteger(
    (value as { readiness?: { timeoutMs?: unknown } }).readiness?.timeoutMs
  );
  const readinessPollMs = normalizeNonNegativeInteger(
    (value as { readiness?: { pollMs?: unknown } }).readiness?.pollMs
  );
  const workspaceResources = normalizeResourceRequirements(
    (value as { resources?: { workspace?: unknown } }).resources?.workspace
  );
  const editorResources = normalizeResourceRequirements(
    (value as { resources?: { editor?: unknown } }).resources?.editor
  );
  const workspaceGatewayResources = normalizeResourceRequirements(
    (value as { resources?: { workspaceGateway?: unknown } }).resources?.workspaceGateway
  );
  const workspaceStorageDefaultSize = normalizeOptionalString(
    (value as { workspaceStorage?: { defaultSize?: unknown } }).workspaceStorage?.defaultSize
  );
  const workspaceStorageAllowedSizes = normalizeStringArray(
    (value as { workspaceStorage?: { allowedSizes?: unknown } }).workspaceStorage?.allowedSizes
  );
  const workspaceStorageAllowClientOverride = normalizeBoolean(
    (value as { workspaceStorage?: { allowClientOverride?: unknown } }).workspaceStorage?.allowClientOverride
  );
  const workspaceStorageAccessMode = normalizeWorkspaceStorageAccessMode(
    (value as { workspaceStorage?: { accessMode?: unknown } }).workspaceStorage?.accessMode
  );
  const workspaceBackend = normalizeWorkspaceBackend((value as { workspaceBackend?: unknown }).workspaceBackend);
  const cleanupActiveIdleSuspendMs = normalizePositiveInteger(
    (value as { cleanup?: { activeIdleSuspendMs?: unknown } }).cleanup?.activeIdleSuspendMs
  );
  const cleanupStartingTimeoutMs = normalizePositiveInteger(
    (value as { cleanup?: { startingTimeoutMs?: unknown } }).cleanup?.startingTimeoutMs
  );
  const cleanupHibernatedRetentionMs = normalizePositiveInteger(
    (value as { cleanup?: { hibernatedRetentionMs?: unknown } }).cleanup?.hibernatedRetentionMs
  );
  const cleanupIdleArchiveMs = normalizePositiveInteger(
    (value as { cleanup?: { idleArchiveMs?: unknown } }).cleanup?.idleArchiveMs
  );
  const cleanupIntervalMs = normalizePositiveInteger(
    (value as { cleanup?: { intervalMs?: unknown } }).cleanup?.intervalMs
  );
  const cleanupRedisTtlSeconds = normalizePositiveInteger(
    (value as { cleanup?: { redisTtlSeconds?: unknown } }).cleanup?.redisTtlSeconds
  );
  const durabilityRunExecutionLeaseMs = normalizePositiveInteger(
    (value as { durability?: { runExecutionLeaseMs?: unknown } }).durability?.runExecutionLeaseMs
  );
  const durabilityQueuedRunDispatchStaleMs = normalizePositiveInteger(
    (value as { durability?: { queuedRunDispatchStaleMs?: unknown } }).durability?.queuedRunDispatchStaleMs
  );
  const durabilityDispatchRecoveryLimit = normalizePositiveInteger(
    (value as { durability?: { dispatchRecoveryLimit?: unknown } }).durability?.dispatchRecoveryLimit
  );
  const durabilityMaxDurablePayloadBytes = normalizePositiveInteger(
    (value as { durability?: { maxDurablePayloadBytes?: unknown } }).durability?.maxDurablePayloadBytes
  );
  const durabilityPayloadPreviewBytes = normalizePositiveInteger(
    (value as { durability?: { payloadPreviewBytes?: unknown } }).durability?.payloadPreviewBytes
  );
  const durabilityFileChangePreviewChars = normalizePositiveInteger(
    (value as { durability?: { fileChangePreviewChars?: unknown } }).durability?.fileChangePreviewChars
  );

  return {
    ...(workspaceImage ? { workspaceImage } : {}),
    ...(workspaceEditorImage ? { workspaceEditorImage } : {}),
    ...(workspaceGatewayImage ? { workspaceGatewayImage } : {}),
    ...(nodeSelector || keepAttachedServicesOnSessionNode !== undefined
      ? {
          scheduling: {
            ...(nodeSelector ? { nodeSelector } : {}),
            ...(keepAttachedServicesOnSessionNode !== undefined ? { keepAttachedServicesOnSessionNode } : {}),
          },
        }
      : {}),
    ...(readinessTimeoutMs !== undefined || readinessPollMs !== undefined
      ? {
          readiness: {
            ...(readinessTimeoutMs !== undefined ? { timeoutMs: readinessTimeoutMs } : {}),
            ...(readinessPollMs !== undefined ? { pollMs: readinessPollMs } : {}),
          },
        }
      : {}),
    ...(workspaceResources || editorResources || workspaceGatewayResources
      ? {
          resources: {
            ...(workspaceResources ? { workspace: workspaceResources } : {}),
            ...(editorResources ? { editor: editorResources } : {}),
            ...(workspaceGatewayResources ? { workspaceGateway: workspaceGatewayResources } : {}),
          },
        }
      : {}),
    ...(workspaceStorageDefaultSize ||
    workspaceStorageAllowedSizes ||
    workspaceStorageAllowClientOverride !== undefined ||
    workspaceStorageAccessMode
      ? {
          workspaceStorage: {
            ...(workspaceStorageDefaultSize ? { defaultSize: workspaceStorageDefaultSize } : {}),
            ...(workspaceStorageAllowedSizes ? { allowedSizes: workspaceStorageAllowedSizes } : {}),
            ...(workspaceStorageAllowClientOverride !== undefined
              ? { allowClientOverride: workspaceStorageAllowClientOverride }
              : {}),
            ...(workspaceStorageAccessMode ? { accessMode: workspaceStorageAccessMode } : {}),
          },
        }
      : {}),
    ...(workspaceBackend ? { workspaceBackend } : {}),
    ...(cleanupActiveIdleSuspendMs !== undefined ||
    cleanupStartingTimeoutMs !== undefined ||
    cleanupHibernatedRetentionMs !== undefined ||
    cleanupIdleArchiveMs !== undefined ||
    cleanupIntervalMs !== undefined ||
    cleanupRedisTtlSeconds !== undefined
      ? {
          cleanup: {
            ...(cleanupActiveIdleSuspendMs !== undefined ? { activeIdleSuspendMs: cleanupActiveIdleSuspendMs } : {}),
            ...(cleanupStartingTimeoutMs !== undefined ? { startingTimeoutMs: cleanupStartingTimeoutMs } : {}),
            ...(cleanupHibernatedRetentionMs !== undefined
              ? { hibernatedRetentionMs: cleanupHibernatedRetentionMs }
              : {}),
            ...(cleanupIdleArchiveMs !== undefined ? { idleArchiveMs: cleanupIdleArchiveMs } : {}),
            ...(cleanupIntervalMs !== undefined ? { intervalMs: cleanupIntervalMs } : {}),
            ...(cleanupRedisTtlSeconds !== undefined ? { redisTtlSeconds: cleanupRedisTtlSeconds } : {}),
          },
        }
      : {}),
    ...(durabilityRunExecutionLeaseMs !== undefined ||
    durabilityQueuedRunDispatchStaleMs !== undefined ||
    durabilityDispatchRecoveryLimit !== undefined ||
    durabilityMaxDurablePayloadBytes !== undefined ||
    durabilityPayloadPreviewBytes !== undefined ||
    durabilityFileChangePreviewChars !== undefined
      ? {
          durability: {
            ...(durabilityRunExecutionLeaseMs !== undefined
              ? { runExecutionLeaseMs: durabilityRunExecutionLeaseMs }
              : {}),
            ...(durabilityQueuedRunDispatchStaleMs !== undefined
              ? { queuedRunDispatchStaleMs: durabilityQueuedRunDispatchStaleMs }
              : {}),
            ...(durabilityDispatchRecoveryLimit !== undefined
              ? { dispatchRecoveryLimit: durabilityDispatchRecoveryLimit }
              : {}),
            ...(durabilityMaxDurablePayloadBytes !== undefined
              ? { maxDurablePayloadBytes: durabilityMaxDurablePayloadBytes }
              : {}),
            ...(durabilityPayloadPreviewBytes !== undefined
              ? { payloadPreviewBytes: durabilityPayloadPreviewBytes }
              : {}),
            ...(durabilityFileChangePreviewChars !== undefined
              ? { fileChangePreviewChars: durabilityFileChangePreviewChars }
              : {}),
          },
        }
      : {}),
  };
}

function mergeToolRules(
  globalRules: AgentSessionToolRule[] = [],
  repoRules: AgentSessionToolRule[] = []
): AgentSessionToolRule[] {
  const merged = new Map<string, AgentSessionToolRule>();
  for (const rule of globalRules) {
    merged.set(rule.toolKey, rule);
  }
  for (const rule of repoRules) {
    merged.set(rule.toolKey, rule);
  }

  return Array.from(merged.values()).sort((left, right) => left.toolKey.localeCompare(right.toolKey));
}

function toRuleSelection(toolRules: AgentSessionToolRule[], toolKey: string): AgentSessionToolRuleSelection {
  return toolRules.find((rule) => rule.toolKey === toolKey)?.mode || 'inherit';
}

function catalogCapabilityForTool(entry: AgentSessionToolInventoryEntry): AgentCapabilityCatalogId {
  if (entry.sourceType === 'mcp') {
    return entry.capabilityKey === 'external_mcp_read' ? 'external_mcp_read' : 'external_mcp_write';
  }

  if (entry.serverSlug === WORKSPACE_CORE_SERVER_SLUG) {
    return getWorkspaceCoreToolDefinition(entry.toolName)?.catalogCapabilityId || 'read_context';
  }

  return 'read_context';
}

function getWorkspaceCoreToolSortKey(toolName: string): number {
  const index = WORKSPACE_CORE_TOOL_DEFINITIONS.findIndex((tool) => tool.name === toolName);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function buildCatalogCapabilityToolEntries(entry: AgentCapabilityCatalogEntry): AgentCapabilityInventoryToolEntry[] {
  return (entry.toolKeys || []).map((toolName) => ({
    toolKey: `catalog__${entry.id}__${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    toolName,
    description: null,
    serverSlug: LIFECYCLE_BUILTIN_SERVER_SLUG,
    serverName: LIFECYCLE_BUILTIN_SERVER_NAME,
    sourceType: 'builtin',
    sourceScope: 'catalog',
  }));
}

function hasConfigValues(config: Partial<AgentSessionControlPlaneConfigValue>): boolean {
  return Boolean(
    normalizeOptionalString(config.systemPrompt) ||
      normalizeOptionalString(config.appendSystemPrompt) ||
      normalizePositiveInteger(config.maxIterations) ||
      normalizePositiveInteger(config.workspaceToolDiscoveryTimeoutMs) ||
      normalizePositiveInteger(config.workspaceToolExecutionTimeoutMs) ||
      config.autoProvisionWorkspace !== undefined ||
      (config.toolRules && config.toolRules.length > 0)
  );
}

function normalizeMcpToolSet(tools: McpDiscoveredTool[]): McpDiscoveredTool[] {
  const deduped = new Map<string, McpDiscoveredTool>();
  for (const tool of tools) {
    if (!tool?.name) {
      continue;
    }
    deduped.set(tool.name, tool);
  }

  return Array.from(deduped.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export default class AgentSessionConfigService extends BaseService {
  private static instance: AgentSessionConfigService;

  static getInstance(): AgentSessionConfigService {
    if (!this.instance) {
      this.instance = new AgentSessionConfigService();
    }
    return this.instance;
  }

  async getGlobalConfig(): Promise<AgentSessionControlPlaneConfigValue> {
    const defaults = (await GlobalConfigService.getInstance().getConfig('agentSessionDefaults')) as
      | AgentSessionDefaults
      | undefined;
    return normalizeControlPlaneConfig(defaults?.controlPlane);
  }

  async getGlobalRuntimeConfig(): Promise<AgentSessionRuntimeSettingsValue> {
    const defaults = (await GlobalConfigService.getInstance().getConfig('agentSessionDefaults')) as
      | AgentSessionDefaults
      | undefined;
    const normalized = normalizeRuntimeSettings(defaults);

    // Surface the EFFECTIVE workspace backend (DB > env > default) so env-driven deployments show
    // the active provider. Presence-only resolution: the read path never decrypts; redaction
    // computes the *Configured flags from ciphertext/env presence.
    const resolvedBackend = resolveAgentSessionWorkspaceBackendFromDefaults(
      defaults?.workspaceBackend,
      // Match the provisioning paths' opensandbox image fallback so the admin GET reflects the effective image.
      defaults?.workspaceImage?.trim() || null,
      { decryptSecrets: false }
    );
    return {
      ...normalized,
      workspaceBackend: {
        provider: resolvedBackend.provider,
        opensandbox: redactOpenSandboxSettings(resolvedBackend.opensandbox),
        e2b: redactE2bSettings(resolvedBackend.e2b),
        daytona: redactDaytonaSettings(resolvedBackend.daytona),
        modal: redactModalSettings(resolvedBackend.modal),
      },
    };
  }

  /** Narrow write for managed template builds: sets only e2b.templateId; stored blocks (incl. ciphertext) are copied verbatim. */
  async setStoredE2bTemplateId(templateId: string): Promise<void> {
    const currentDefaults = ((await GlobalConfigService.getInstance().getConfig('agentSessionDefaults')) ||
      {}) as Partial<GlobalConfig['agentSessionDefaults']>;
    const workspaceBackend: AgentSessionWorkspaceBackendConfig = {
      ...(currentDefaults.workspaceBackend || {}),
      e2b: { ...(currentDefaults.workspaceBackend?.e2b || {}), templateId },
    };
    await GlobalConfigService.getInstance().setConfig('agentSessionDefaults', {
      ...currentDefaults,
      workspaceBackend,
    });
  }

  async setGlobalConfig(config: AgentSessionControlPlaneConfigValue): Promise<AgentSessionControlPlaneConfigValue> {
    const normalized = normalizeControlPlaneConfig(config);
    validateAgentSessionControlPlaneConfig(normalized);

    const currentDefaults = ((await GlobalConfigService.getInstance().getConfig('agentSessionDefaults')) ||
      {}) as Partial<GlobalConfig['agentSessionDefaults']>;
    const nextDefaults = {
      ...currentDefaults,
      controlPlane: normalized,
    };

    await GlobalConfigService.getInstance().setConfig('agentSessionDefaults', nextDefaults);
    return normalized;
  }

  async setGlobalRuntimeConfig(config: AgentSessionRuntimeSettingsValue): Promise<AgentSessionRuntimeSettingsValue> {
    // `<backend>: null` is the explicit remove-stored-block sentinel (normalization drops it).
    const rawBackend = (config as { workspaceBackend?: Record<string, unknown> | null } | null | undefined)
      ?.workspaceBackend;
    const removedBackends = new Set<string>(WORKSPACE_BACKEND_BLOCK_KEYS.filter((key) => rawBackend?.[key] === null));

    const normalized = normalizeRuntimeSettings(config);
    validateAgentSessionRuntimeSettings(normalized);

    const currentDefaults = ((await GlobalConfigService.getInstance().getConfig('agentSessionDefaults')) ||
      {}) as Partial<GlobalConfig['agentSessionDefaults']>;

    await this.assertWorkspaceBackendsRemovable(removedBackends);

    const mergedBackend = mergeWorkspaceBackendSettings(
      currentDefaults?.workspaceBackend,
      normalized.workspaceBackend,
      removedBackends
    );
    if (mergedBackend) {
      preserveWorkspaceBackendSecrets(mergedBackend, currentDefaults?.workspaceBackend);
    }

    // Captured pre-encryption: encryptWorkspaceBackendSecrets mutates mergedBackend in place.
    const changedBackendBlocks = WORKSPACE_BACKEND_BLOCK_KEYS.filter((key) => {
      if (removedBackends.has(key)) {
        return true;
      }
      const stored = (currentDefaults?.workspaceBackend as Record<string, unknown> | undefined)?.[key];
      const merged = (mergedBackend as Record<string, unknown> | undefined)?.[key];
      return JSON.stringify(stored ?? null) !== JSON.stringify(merged ?? null);
    });

    const nextDefaults: Partial<GlobalConfig['agentSessionDefaults']> = {
      ...currentDefaults,
    };

    delete nextDefaults.workspaceImage;
    delete nextDefaults.workspaceEditorImage;
    delete nextDefaults.workspaceGatewayImage;
    delete nextDefaults.scheduling;
    delete nextDefaults.readiness;
    delete nextDefaults.resources;
    delete nextDefaults.workspaceStorage;
    delete nextDefaults.workspaceBackend;
    delete nextDefaults.cleanup;
    delete nextDefaults.durability;

    if (normalized.workspaceImage) {
      nextDefaults.workspaceImage = normalized.workspaceImage;
    }
    if (normalized.workspaceEditorImage) {
      nextDefaults.workspaceEditorImage = normalized.workspaceEditorImage;
    }
    if (normalized.workspaceGatewayImage) {
      nextDefaults.workspaceGatewayImage = normalized.workspaceGatewayImage;
    }
    if (normalized.scheduling) {
      nextDefaults.scheduling = normalized.scheduling;
    }
    if (normalized.readiness) {
      nextDefaults.readiness = normalized.readiness;
    }
    if (normalized.resources) {
      nextDefaults.resources = normalized.resources;
    }
    if (normalized.workspaceStorage) {
      nextDefaults.workspaceStorage = normalized.workspaceStorage;
    }
    if (mergedBackend) {
      nextDefaults.workspaceBackend = mergedBackend;
    }
    if (normalized.cleanup) {
      nextDefaults.cleanup = normalized.cleanup;
    }
    if (normalized.durability) {
      nextDefaults.durability = normalized.durability;
    }

    validateRequiredRuntimeImages(nextDefaults);
    if (rawBackend !== undefined && rawBackend !== null) {
      validateSelectedWorkspaceBackend(mergedBackend, nextDefaults.workspaceImage ?? null);
    }

    if (mergedBackend) {
      encryptWorkspaceBackendSecrets(mergedBackend);
    }

    await GlobalConfigService.getInstance().setConfig('agentSessionDefaults', nextDefaults);
    // A verification describes the config it ran against; drop records for changed backends.
    await clearBackendVerifications(changedBackendBlocks as WorkspaceBackendId[]);

    const responseBackend = normalizeWorkspaceBackend(mergedBackend);
    const { workspaceBackend: _omitted, ...responseRest } = normalized;
    if (!responseBackend) {
      return responseRest;
    }
    return {
      ...responseRest,
      workspaceBackend: {
        ...responseBackend,
        ...(responseBackend.opensandbox ? { opensandbox: redactOpenSandboxSettings(responseBackend.opensandbox) } : {}),
        ...(responseBackend.e2b ? { e2b: redactE2bSettings(responseBackend.e2b) } : {}),
        ...(responseBackend.daytona ? { daytona: redactDaytonaSettings(responseBackend.daytona) } : {}),
        ...(responseBackend.modal ? { modal: redactModalSettings(responseBackend.modal) } : {}),
      },
    };
  }

  /** Explicit `<backend>: null` removal is refused while non-ended sandboxes still reference that provider. */
  private async assertWorkspaceBackendsRemovable(backendIds: ReadonlySet<string>): Promise<void> {
    for (const id of backendIds) {
      const activeCount = await AgentSandbox.query().where('provider', id).whereNot('status', 'ended').resultSize();
      if (activeCount > 0) {
        const displayName = getWorkspaceBackendDescriptor(id)?.displayName ?? id;
        throw new ConflictError(
          `Cannot remove the ${displayName} workspace backend configuration: ` +
            `${activeCount} workspace sandbox(es) that are not ended still reference it.`,
          'workspace_backend_in_use'
        );
      }
    }
  }

  async getRepoConfig(repoFullName: string): Promise<Partial<AgentSessionControlPlaneConfigValue> | null> {
    const normalizedRepo = normalizeRepoFullName(repoFullName);
    const row = await this.db
      .knex('agent_session_repo_config')
      .where({ repositoryFullName: normalizedRepo })
      .whereNull('deletedAt')
      .first();

    if (!row) {
      return null;
    }

    return normalizeControlPlaneConfig(typeof row.config === 'string' ? JSON.parse(row.config) : row.config);
  }

  async setRepoConfig(
    repoFullName: string,
    config: Partial<AgentSessionControlPlaneConfigValue>
  ): Promise<Partial<AgentSessionControlPlaneConfigValue>> {
    const normalizedRepo = normalizeRepoFullName(repoFullName);
    const normalized = normalizeControlPlaneConfig(config);
    validateAgentSessionControlPlaneConfig(normalized);

    if (!hasConfigValues(normalized)) {
      await this.deleteRepoConfig(normalizedRepo);
      return {};
    }

    await this.db
      .knex('agent_session_repo_config')
      .insert({
        repositoryFullName: normalizedRepo,
        config: JSON.stringify(normalized),
        createdAt: this.db.knex.fn.now(),
        updatedAt: this.db.knex.fn.now(),
      })
      .onConflict('repositoryFullName')
      .merge({
        config: JSON.stringify(normalized),
        updatedAt: this.db.knex.fn.now(),
        deletedAt: null,
      });

    return normalized;
  }

  async deleteRepoConfig(repoFullName: string): Promise<void> {
    const normalizedRepo = normalizeRepoFullName(repoFullName);
    await this.db
      .knex('agent_session_repo_config')
      .where({ repositoryFullName: normalizedRepo })
      .update({ deletedAt: this.db.knex.fn.now(), updatedAt: this.db.knex.fn.now() });
  }

  async getEffectiveConfig(repoFullName?: string): Promise<EffectiveAgentSessionControlPlaneConfig> {
    const globalConfig = await this.getGlobalConfig();
    const repoConfig = repoFullName ? await this.getRepoConfig(repoFullName) : null;

    return {
      systemPrompt:
        normalizeOptionalString(repoConfig?.systemPrompt) ||
        normalizeOptionalString(globalConfig.systemPrompt) ||
        DEFAULT_AGENT_SESSION_CONTROL_PLANE_SYSTEM_PROMPT,
      appendSystemPrompt:
        normalizeOptionalString(repoConfig?.appendSystemPrompt) ||
        normalizeOptionalString(globalConfig.appendSystemPrompt) ||
        DEFAULT_AGENT_SESSION_CONTROL_PLANE_APPEND_SYSTEM_PROMPT,
      maxIterations:
        normalizePositiveInteger(repoConfig?.maxIterations) ||
        normalizePositiveInteger(globalConfig.maxIterations) ||
        DEFAULT_AGENT_SESSION_MAX_ITERATIONS,
      workspaceToolDiscoveryTimeoutMs:
        normalizePositiveInteger(repoConfig?.workspaceToolDiscoveryTimeoutMs) ||
        normalizePositiveInteger(globalConfig.workspaceToolDiscoveryTimeoutMs) ||
        DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_DISCOVERY_TIMEOUT_MS,
      workspaceToolExecutionTimeoutMs:
        normalizePositiveInteger(repoConfig?.workspaceToolExecutionTimeoutMs) ||
        normalizePositiveInteger(globalConfig.workspaceToolExecutionTimeoutMs) ||
        DEFAULT_AGENT_SESSION_WORKSPACE_TOOL_EXECUTION_TIMEOUT_MS,
      autoProvisionWorkspace:
        repoConfig?.autoProvisionWorkspace ??
        globalConfig.autoProvisionWorkspace ??
        DEFAULT_AGENT_SESSION_AUTO_PROVISION_WORKSPACE,
      toolRules: mergeToolRules(globalConfig.toolRules || [], repoConfig?.toolRules || []),
    };
  }

  async listToolInventory(scope: string): Promise<AgentSessionToolInventoryEntry[]> {
    const repoFullName = scope === 'global' ? undefined : normalizeRepoFullName(scope);
    const [globalConfig, repoConfig, effectiveConfig, approvalPolicy, mcpDefinitions] = await Promise.all([
      this.getGlobalConfig(),
      repoFullName ? this.getRepoConfig(repoFullName) : Promise.resolve(null),
      this.getEffectiveConfig(repoFullName),
      AgentPolicyService.getEffectivePolicy(repoFullName),
      new McpConfigService().listEffectiveDefinitions(repoFullName),
    ]);
    const activeScopeConfig = repoFullName ? repoConfig || {} : globalConfig;
    const entries: AgentSessionToolInventoryEntry[] = [];

    const appendEntry = ({
      toolName,
      description,
      serverSlug,
      serverName,
      sourceType,
      sourceScope,
      capabilityKey: capabilityKeyOverride,
      annotations,
    }: {
      toolName: string;
      description: string;
      serverSlug: string;
      serverName: string;
      sourceType: 'builtin' | 'mcp';
      sourceScope: string;
      capabilityKey?: AgentSessionToolInventoryEntry['capabilityKey'];
      annotations?: McpDiscoveredTool['annotations'];
    }) => {
      const toolKey = buildAgentToolKey(serverSlug, toolName);
      const capabilityKey =
        capabilityKeyOverride ||
        (sourceType === 'builtin'
          ? AgentPolicyService.capabilityForSessionWorkspaceTool(toolName, annotations)
          : AgentPolicyService.capabilityForExternalMcpTool(toolName, annotations));
      const approvalMode = AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey);
      const scopeRuleMode = toRuleSelection(activeScopeConfig.toolRules || [], toolKey);
      const effectiveRuleMode = toRuleSelection(effectiveConfig.toolRules, toolKey);
      const resolvedApprovalMode = effectiveRuleMode === 'inherit' ? approvalMode : effectiveRuleMode;
      const availability =
        resolvedApprovalMode === 'deny'
          ? effectiveRuleMode === 'deny'
            ? 'blocked_by_tool_rule'
            : 'blocked_by_policy'
          : 'available';

      entries.push({
        toolKey,
        toolName,
        description: description || null,
        serverSlug,
        serverName,
        sourceType,
        sourceScope,
        capabilityKey,
        approvalMode,
        scopeRuleMode,
        effectiveRuleMode,
        availability,
      });
    };

    for (const tool of WORKSPACE_CORE_TOOL_DEFINITIONS) {
      appendEntry({
        toolName: tool.name,
        description: tool.description,
        serverSlug: WORKSPACE_CORE_SERVER_SLUG,
        serverName: WORKSPACE_CORE_SERVER_NAME,
        sourceType: 'builtin',
        sourceScope: 'session',
        annotations: tool.annotations,
        capabilityKey: tool.capabilityKey,
      });
    }

    for (const config of mcpDefinitions) {
      const tools = await this.listDiscoveredToolsForDefinition(config);
      for (const tool of tools) {
        appendEntry({
          toolName: tool.name,
          description: tool.description || `MCP tool ${tool.name} from ${config.name}`,
          serverSlug: config.slug,
          serverName: config.name,
          sourceType: 'mcp',
          sourceScope: config.scope,
          annotations: tool.annotations,
        });
      }
    }

    return entries.sort((left, right) => {
      if (left.sourceType !== right.sourceType) {
        return left.sourceType === 'builtin' ? -1 : 1;
      }

      if (left.sourceType === 'builtin' && right.sourceType === 'builtin') {
        const orderCompare = getWorkspaceCoreToolSortKey(left.toolName) - getWorkspaceCoreToolSortKey(right.toolName);
        if (orderCompare !== 0) {
          return orderCompare;
        }
      }

      const serverCompare = left.serverName.localeCompare(right.serverName);
      if (serverCompare !== 0) {
        return serverCompare;
      }
      return left.toolName.localeCompare(right.toolName);
    });
  }

  async listCapabilityInventory(scope: string): Promise<AgentCapabilityInventoryEntry[]> {
    const repoFullName = scope === 'global' ? undefined : normalizeRepoFullName(scope);
    const agentRuntimeConfigService = AgentRuntimeConfigService.getInstance();
    const [globalAgentConfig, repoAgentConfig, effectiveAgentConfig, approvalPolicy, toolInventory] = await Promise.all(
      [
        agentRuntimeConfigService.getGlobalConfig(),
        repoFullName ? agentRuntimeConfigService.getRepoConfig(repoFullName) : Promise.resolve(null),
        agentRuntimeConfigService.getEffectiveConfig(repoFullName),
        AgentPolicyService.getEffectivePolicy(repoFullName),
        this.listToolInventory(scope),
      ]
    );
    const globalPolicy = globalAgentConfig.capabilityPolicy;
    const repoPolicy = repoAgentConfig?.capabilityPolicy as CapabilityPolicyConfig | undefined;
    const activePolicy = repoFullName ? repoPolicy : globalPolicy;
    const effectivePolicy = effectiveAgentConfig.capabilityPolicy;
    const toolsByCapability = new Map<AgentCapabilityCatalogId, AgentSessionToolInventoryEntry[]>();

    for (const tool of toolInventory) {
      const capabilityId = catalogCapabilityForTool(tool);
      const existing = toolsByCapability.get(capabilityId) || [];
      existing.push(tool);
      toolsByCapability.set(capabilityId, existing);
    }

    return listAgentCapabilityCatalogEntries().map((entry) => {
      const configuredAvailability = activePolicy?.availability?.[entry.id];
      const inheritedAvailability = repoFullName
        ? globalPolicy?.availability?.[entry.id] || entry.defaultAvailability
        : undefined;
      const effectiveAvailability =
        effectivePolicy?.availability?.[entry.id] || inheritedAvailability || entry.defaultAvailability;
      const resolvedAccess = AgentPolicyService.resolveCapabilityAccess({
        capabilityId: entry.id,
        capabilityPolicy: { availability: { [entry.id]: effectiveAvailability } },
        approvalPolicy,
        definitionOwnerKind: 'system',
        sourceKind: entry.sourceKinds?.[0],
      });
      const mappedTools = toolsByCapability.get(entry.id) || [];
      const tools =
        mappedTools.length > 0
          ? mappedTools.map((tool) => ({
              toolKey: tool.toolKey,
              toolName: tool.toolName,
              description: tool.description,
              serverSlug: tool.serverSlug,
              serverName: tool.serverName,
              sourceType: tool.sourceType,
              sourceScope: tool.sourceScope,
            }))
          : buildCatalogCapabilityToolEntries(entry);

      return {
        capabilityId: entry.id,
        label: entry.label,
        description: entry.description,
        category: entry.category,
        defaultAvailability: entry.defaultAvailability,
        ...(configuredAvailability ? { configuredAvailability } : {}),
        ...(inheritedAvailability ? { inheritedAvailability } : {}),
        effectiveAvailability,
        approvalMode: resolvedAccess.approvalMode || entry.defaultApprovalMode,
        ...(entry.runtimeCapabilityKey ? { runtimeCapabilityKey: entry.runtimeCapabilityKey } : {}),
        userSelectable: entry.userSelectable,
        toolCount: tools.length,
        resourceCount: entry.resourceGrants?.length || 0,
        resourceGrants: [...(entry.resourceGrants || [])],
        tools,
        ...(effectiveAvailability === 'disabled' ||
        effectiveAvailability === 'system_only' ||
        effectiveAvailability === 'admin_only'
          ? { blockedReason: effectiveAvailability }
          : {}),
      };
    });
  }

  private async listDiscoveredToolsForDefinition(
    config: Pick<McpServerConfig, 'scope' | 'slug' | 'authConfig' | 'sharedDiscoveredTools'>
  ): Promise<McpDiscoveredTool[]> {
    const authConfig = normalizeAuthConfig(config.authConfig);
    if (!requiresUserConnection(authConfig)) {
      return normalizeMcpToolSet(config.sharedDiscoveredTools || []);
    }

    const rows = await UserMcpConnection.query()
      .where({ scope: config.scope, slug: config.slug })
      .orderBy('updatedAt', 'desc');
    return normalizeMcpToolSet(rows.flatMap((row) => row.discoveredTools || []));
  }
}
