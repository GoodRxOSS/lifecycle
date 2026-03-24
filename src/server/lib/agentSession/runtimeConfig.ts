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
  AgentSessionClaudeAttribution,
  AgentSessionClaudeConfig,
  AgentSessionClaudePermissions,
  AgentSessionSchedulingConfig,
} from 'server/services/types/globalConfig';

export interface AgentSessionRuntimeConfig {
  image: string;
  editorImage: string;
  nodeSelector?: Record<string, string>;
  claude: ResolvedAgentSessionClaudeConfig;
}

export interface ResolvedAgentSessionClaudePermissions {
  allow: string[];
  deny: string[];
}

export interface ResolvedAgentSessionClaudeAttribution {
  commitTemplate: string;
  prTemplate: string;
}

export interface ResolvedAgentSessionClaudeConfig {
  permissions: ResolvedAgentSessionClaudePermissions;
  attribution: ResolvedAgentSessionClaudeAttribution;
  appendSystemPrompt?: string;
}

const DEFAULT_CLAUDE_PERMISSION_ALLOW = ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)'];
const DEFAULT_CLAUDE_PERMISSION_DENY: string[] = [];
const DEFAULT_CLAUDE_COMMIT_ATTRIBUTION_TEMPLATE = 'Generated with ({appName})';
const DEFAULT_CLAUDE_PR_ATTRIBUTION_TEMPLATE = 'Generated with ({appName})';

function normalizeStringArray(values: unknown, fallback: string[]): string[] {
  if (!Array.isArray(values)) {
    return [...fallback];
  }

  const normalized = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);

  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeAttributionTemplate(template: unknown, fallback: string): string {
  return typeof template === 'string' && template.trim() ? template.trim() : fallback;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

export function resolveAgentSessionClaudeConfigFromDefaults(
  claudeDefaults?: AgentSessionClaudeConfig | null
): ResolvedAgentSessionClaudeConfig {
  const permissions: AgentSessionClaudePermissions | undefined = claudeDefaults?.permissions;
  const attribution: AgentSessionClaudeAttribution | undefined = claudeDefaults?.attribution;

  return {
    permissions: {
      allow: normalizeStringArray(permissions?.allow, DEFAULT_CLAUDE_PERMISSION_ALLOW),
      deny: normalizeStringArray(permissions?.deny, DEFAULT_CLAUDE_PERMISSION_DENY),
    },
    attribution: {
      commitTemplate: normalizeAttributionTemplate(
        attribution?.commitTemplate,
        DEFAULT_CLAUDE_COMMIT_ATTRIBUTION_TEMPLATE
      ),
      prTemplate: normalizeAttributionTemplate(attribution?.prTemplate, DEFAULT_CLAUDE_PR_ATTRIBUTION_TEMPLATE),
    },
    appendSystemPrompt: normalizeOptionalString(claudeDefaults?.appendSystemPrompt),
  };
}

export async function resolveAgentSessionClaudeConfig(): Promise<ResolvedAgentSessionClaudeConfig> {
  const { agentSessionDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  return resolveAgentSessionClaudeConfigFromDefaults(agentSessionDefaults?.claude);
}

export function renderAgentSessionClaudeAttribution(template: string, appName: string | null): string {
  const trimmedTemplate = template.trim();
  if (!trimmedTemplate) {
    return '';
  }

  if (trimmedTemplate.includes('{appName}')) {
    const trimmedAppName = appName?.trim();
    if (!trimmedAppName) {
      return '';
    }

    return trimmedTemplate.replace(/\{appName\}/g, trimmedAppName).trim();
  }

  return trimmedTemplate;
}

export class AgentSessionRuntimeConfigError extends Error {
  readonly missingFields: Array<'image' | 'editorImage'>;

  constructor(missingFields: Array<'image' | 'editorImage'>) {
    super(`Agent session runtime is not configured. Missing ${missingFields.join(' and ')}.`);
    this.name = 'AgentSessionRuntimeConfigError';
    this.missingFields = missingFields;
  }
}

export async function resolveAgentSessionRuntimeConfig(): Promise<AgentSessionRuntimeConfig> {
  const { agentSessionDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  const image = agentSessionDefaults?.image?.trim() || '';
  const editorImage = agentSessionDefaults?.editorImage?.trim() || '';
  const missingFields: Array<'image' | 'editorImage'> = [];

  if (!image) {
    missingFields.push('image');
  }

  if (!editorImage) {
    missingFields.push('editorImage');
  }

  if (missingFields.length > 0) {
    throw new AgentSessionRuntimeConfigError(missingFields);
  }

  return {
    image,
    editorImage,
    nodeSelector: normalizeNodeSelector(agentSessionDefaults?.scheduling),
    claude: resolveAgentSessionClaudeConfigFromDefaults(agentSessionDefaults?.claude),
  };
}
