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
import type {
  AgentSessionControlPlaneConfig,
  AgentSessionDefaults,
  AgentSessionReadinessConfig,
  AgentSessionResourcesConfig,
  AgentSessionSchedulingConfig,
  ResourceRequirements,
} from 'server/services/types/globalConfig';

export interface AgentSessionRuntimeConfig {
  workspaceImage: string;
  workspaceEditorImage: string;
  workspaceGatewayImage: string;
  nodeSelector?: Record<string, string>;
  readiness: ResolvedAgentSessionReadinessConfig;
  resources: ResolvedAgentSessionResources;
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

export interface ResolvedAgentSessionControlPlaneConfig {
  systemPrompt?: string;
  appendSystemPrompt?: string;
}

export const DEFAULT_AGENT_SESSION_CONTROL_PLANE_SYSTEM_PROMPT = [
  'You are Lifecycle Agent Session, a coding agent operating on a real workspace through tool calls.',
  'Use the available tools directly when you need to inspect files, search the workspace, run commands, or modify code.',
  'Do not emit pseudo-tool markup or pretend execution happened. Never write things like <read_file>, <write_file>, <attempt_completion>, <result>, or shell commands as if they were already executed.',
  'Do not claim that a file was read, a command was run, or a change was made unless that happened through an actual tool call in this conversation.',
  'If a tool call fails or a capability is unavailable, say that plainly and explain what failed.',
].join('\n');

export const DEFAULT_AGENT_SESSION_CONTROL_PLANE_APPEND_SYSTEM_PROMPT =
  'When a tool execution is not approved, do not retry the denied action. Use the denial reason as updated guidance and continue from there.';

const DEFAULT_AGENT_READY_TIMEOUT_MS = 60000;
const DEFAULT_AGENT_READY_POLL_MS = 2000;
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

export function mergeAgentSessionReadiness(
  baseReadiness: ResolvedAgentSessionReadinessConfig,
  overrides?: AgentSessionReadinessConfig | null
): ResolvedAgentSessionReadinessConfig {
  return {
    timeoutMs: normalizeNonNegativeInteger(overrides?.timeoutMs) ?? baseReadiness.timeoutMs,
    pollMs: normalizeNonNegativeInteger(overrides?.pollMs) ?? baseReadiness.pollMs,
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

export function resolveAgentSessionControlPlaneConfigFromDefaults(
  agentSessionDefaults?: AgentSessionDefaults | null
): ResolvedAgentSessionControlPlaneConfig {
  const controlPlaneDefaults: AgentSessionControlPlaneConfig | undefined = agentSessionDefaults?.controlPlane;
  const systemPrompt =
    normalizeOptionalString(controlPlaneDefaults?.systemPrompt) || DEFAULT_AGENT_SESSION_CONTROL_PLANE_SYSTEM_PROMPT;
  const appendSystemPrompt =
    normalizeOptionalString(controlPlaneDefaults?.appendSystemPrompt) ||
    DEFAULT_AGENT_SESSION_CONTROL_PLANE_APPEND_SYSTEM_PROMPT;

  return {
    systemPrompt,
    appendSystemPrompt,
  };
}

export async function resolveAgentSessionControlPlaneConfig(): Promise<ResolvedAgentSessionControlPlaneConfig> {
  const { agentSessionDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  return resolveAgentSessionControlPlaneConfigFromDefaults(agentSessionDefaults);
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
    nodeSelector: normalizeNodeSelector(agentSessionDefaults?.scheduling),
    readiness: resolveAgentSessionReadinessFromDefaults(agentSessionDefaults?.readiness),
    resources: resolveAgentSessionResourcesFromDefaults(agentSessionDefaults?.resources),
  };
}
