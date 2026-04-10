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
import McpServerConfig from 'server/models/McpServerConfig';
import UserMcpConnection from 'server/models/UserMcpConnection';
import GlobalConfigService from './globalConfig';
import { normalizeRepoFullName } from 'server/lib/normalizeRepoFullName';
import { validateAgentSessionControlPlaneConfig } from 'server/lib/validation/agentSessionConfigValidator';
import type {
  AgentSessionControlPlaneConfigValue,
  AgentSessionToolInventoryEntry,
  AgentSessionToolRule,
  AgentSessionToolRuleSelection,
  EffectiveAgentSessionControlPlaneConfig,
} from './types/agentSessionConfig';
import type { GlobalConfig, AgentSessionDefaults } from './types/globalConfig';
import {
  DEFAULT_AGENT_SESSION_CONTROL_PLANE_APPEND_SYSTEM_PROMPT,
  DEFAULT_AGENT_SESSION_CONTROL_PLANE_SYSTEM_PROMPT,
} from 'server/lib/agentSession/runtimeConfig';
import { McpConfigService } from 'server/services/ai/mcp/config';
import { normalizeAuthConfig, requiresUserConnection } from 'server/services/ai/mcp/connectionConfig';
import AgentPolicyService from './agent/PolicyService';
import { buildAgentToolKey, SESSION_WORKSPACE_SERVER_NAME, SESSION_WORKSPACE_SERVER_SLUG } from './agent/toolKeys';
import type { McpDiscoveredTool } from 'server/services/ai/mcp/types';
import {
  getSessionWorkspaceToolSortKey,
  listAdminVisibleSessionWorkspaceToolCatalog,
} from './agent/sandboxToolCatalog';

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
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
    if (!toolKey || (mode !== 'allow' && mode !== 'deny')) {
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
    toolRules: normalizeToolRules((value as { toolRules?: unknown }).toolRules),
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

function hasConfigValues(config: Partial<AgentSessionControlPlaneConfigValue>): boolean {
  return Boolean(
    normalizeOptionalString(config.systemPrompt) ||
      normalizeOptionalString(config.appendSystemPrompt) ||
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
      annotations,
    }: {
      toolName: string;
      description: string;
      serverSlug: string;
      serverName: string;
      sourceType: 'builtin' | 'mcp';
      sourceScope: string;
      annotations?: McpDiscoveredTool['annotations'];
    }) => {
      const toolKey = buildAgentToolKey(serverSlug, toolName);
      const capabilityKey = AgentPolicyService.capabilityForMcpTool(toolName, annotations);
      const approvalMode = AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey);
      const scopeRuleMode = toRuleSelection(activeScopeConfig.toolRules || [], toolKey);
      const effectiveRuleMode = toRuleSelection(effectiveConfig.toolRules, toolKey);
      const availability =
        approvalMode === 'deny'
          ? 'blocked_by_policy'
          : effectiveRuleMode === 'deny'
          ? 'blocked_by_tool_rule'
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

    for (const tool of listAdminVisibleSessionWorkspaceToolCatalog(SESSION_WORKSPACE_SERVER_NAME)) {
      appendEntry({
        toolName: tool.toolName,
        description: tool.description,
        serverSlug: SESSION_WORKSPACE_SERVER_SLUG,
        serverName: SESSION_WORKSPACE_SERVER_NAME,
        sourceType: 'builtin',
        sourceScope: 'session',
        annotations: tool.annotations,
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
        const orderCompare =
          getSessionWorkspaceToolSortKey(left.toolName) - getSessionWorkspaceToolSortKey(right.toolName);
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
