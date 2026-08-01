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

import type { Transaction } from 'objection';
import { BadRequestError } from 'server/lib/appError';
import { resolveSitesConfig } from 'server/lib/sites/config';
import type { LifecycleMcpConfig, McpAdminCapability, McpRuntimePolicy, McpToolDefinition } from 'server/mcp/contracts';
import { buildMcpAdminCatalog } from 'server/mcp/registry';
import { createLifecycleMcpToolDefinitions } from 'server/mcp/tools';
import AuthAuditEvent from 'server/models/AuthAuditEvent';
import { recordAuthAuditEventInTransaction } from './authAudit';
import GlobalConfigService from './globalConfig';
import {
  hasMcpApplicationSigningKey,
  enableMcp,
  inspectMcpEnablement,
  McpEnablementError,
  type McpEnablementIssue,
  type McpEnablementOptions,
  type McpEnablementResult,
} from './mcpEnablement';

const MCP_CONFIG_KEY = 'mcp';

export interface LifecycleMcpSettings {
  enabled: boolean;
  allowChanges: boolean;
  endpoint: string | null;
  issue: McpEnablementIssue | null;
  capabilities: McpAdminCapability[];
}

interface GlobalConfigPort {
  getConfig(key: string): Promise<unknown>;
  setConfig(key: string, value: unknown, trx?: Transaction): Promise<void>;
  invalidateCache(): Promise<void>;
}

export interface McpConfigServiceDependencies {
  globalConfig: GlobalConfigPort;
  inspectEnablement: (options: McpEnablementOptions) => McpEnablementResult;
  enableMcp: (options: McpEnablementOptions) => Promise<McpEnablementResult>;
  loadToolDefinitions: () => McpToolDefinition[];
  loadSitesAvailable: () => Promise<boolean>;
  hasApplicationSigningKey: () => boolean;
  transact: <T>(callback: (trx: Transaction) => Promise<T>) => Promise<T>;
  recordAudit: typeof recordAuthAuditEventInTransaction;
}

function defaultDependencies(): McpConfigServiceDependencies {
  const globalConfig = GlobalConfigService.getInstance();
  return {
    globalConfig,
    inspectEnablement: (options) => inspectMcpEnablement(options),
    enableMcp: (options) => enableMcp(options),
    loadToolDefinitions: () => createLifecycleMcpToolDefinitions(),
    loadSitesAvailable: async () =>
      resolveSitesConfig((await globalConfig.getConfig('sites')) as Parameters<typeof resolveSitesConfig>[0]).enabled,
    hasApplicationSigningKey: () => hasMcpApplicationSigningKey(),
    transact: (callback) => AuthAuditEvent.transaction(callback),
    recordAudit: recordAuthAuditEventInTransaction,
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function normalizeMcpConfig(value: unknown): LifecycleMcpConfig {
  const config = objectRecord(value);
  return {
    enabled: config.enabled === true,
    allowChanges: config.allowChanges === true,
  };
}

export function exactMcpConfig(value: unknown): LifecycleMcpConfig {
  const config = objectRecord(value);
  const keys = Object.keys(config);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(config, 'enabled') ||
    !Object.prototype.hasOwnProperty.call(config, 'allowChanges') ||
    typeof config.enabled !== 'boolean' ||
    typeof config.allowChanges !== 'boolean'
  ) {
    throw new BadRequestError(
      'MCP configuration must contain exactly enabled and allowChanges booleans.',
      'invalid_mcp_config'
    );
  }
  return { enabled: config.enabled, allowChanges: config.allowChanges };
}

function storedRowConfig(row: unknown): unknown {
  if (!row || typeof row !== 'object') return undefined;
  const config = (row as { config?: unknown }).config;
  if (typeof config !== 'string') return config;
  try {
    return JSON.parse(config) as unknown;
  } catch {
    return undefined;
  }
}

function configsEqual(left: LifecycleMcpConfig, right: LifecycleMcpConfig): boolean {
  return left.enabled === right.enabled && left.allowChanges === right.allowChanges;
}

function adminSettings(
  config: LifecycleMcpConfig,
  sitesAvailable: boolean,
  readiness: McpEnablementResult,
  definitions: McpToolDefinition[]
): LifecycleMcpSettings {
  return {
    enabled: config.enabled,
    allowChanges: config.allowChanges,
    endpoint: readiness.endpoint,
    issue: readiness.ok === false ? readiness.issue : null,
    capabilities: buildMcpAdminCatalog(definitions, { sitesAvailable }),
  };
}

export default class McpConfigService {
  private static instance: McpConfigService;

  static getInstance(): McpConfigService {
    if (!this.instance) this.instance = new McpConfigService();
    return this.instance;
  }

  constructor(private readonly dependencies: McpConfigServiceDependencies = defaultDependencies()) {}

  private async getStoredConfig(): Promise<LifecycleMcpConfig> {
    return normalizeMcpConfig(await this.dependencies.globalConfig.getConfig(MCP_CONFIG_KEY));
  }

  /** Missing configuration fails closed; a missing signing key disables changes without affecting reads. */
  async getRuntimePolicy(): Promise<McpRuntimePolicy> {
    const [config, sitesAvailable] = await Promise.all([
      this.getStoredConfig(),
      this.dependencies.loadSitesAvailable(),
    ]);
    return {
      enabled: config.enabled,
      allowChanges: config.allowChanges && this.dependencies.hasApplicationSigningKey(),
      sitesAvailable,
    };
  }

  async getSettings(): Promise<LifecycleMcpSettings> {
    const [config, sitesAvailable] = await Promise.all([
      this.getStoredConfig(),
      this.dependencies.loadSitesAvailable(),
    ]);
    const readiness = this.dependencies.inspectEnablement({
      requireChanges: config.allowChanges,
    });
    return adminSettings(config, sitesAvailable, readiness, this.dependencies.loadToolDefinitions());
  }

  async setConfig(value: unknown, actorId: string, requestId: string | null): Promise<LifecycleMcpSettings> {
    const config = exactMcpConfig(value);
    const current = await this.getStoredConfig();
    if (
      config.enabled &&
      current.enabled &&
      config.allowChanges &&
      !current.allowChanges &&
      !this.dependencies.hasApplicationSigningKey()
    ) {
      throw new McpEnablementError(
        'mcp_change_confirmation_unavailable',
        'Configure Lifecycle application encryption before allowing MCP changes.',
        409
      );
    }
    if (config.enabled && !current.enabled) {
      const enabled = await this.dependencies.enableMcp({
        requireChanges: config.allowChanges,
        requestId,
      });
      if (enabled.ok === false) {
        throw new McpEnablementError(enabled.issue.code, enabled.issue.message, 409);
      }
    }

    await this.dependencies.transact(async (trx) => {
      const row = await trx('global_config').where({ key: MCP_CONFIG_KEY }).forUpdate().first();
      const before = normalizeMcpConfig(storedRowConfig(row));
      await this.dependencies.globalConfig.setConfig(MCP_CONFIG_KEY, config, trx);
      await this.dependencies.recordAudit(trx, {
        event: 'mcp.config_updated',
        principalKind: 'user',
        principalId: actorId,
        actorId,
        requestId,
        route: 'PUT /api/v2/config/mcp',
        outcome: configsEqual(before, config) ? 'noop' : 'updated',
        meta: { before, after: config },
      });
    });
    await this.dependencies.globalConfig.invalidateCache();
    const sitesAvailable = await this.dependencies.loadSitesAvailable();
    const finalReadiness = this.dependencies.inspectEnablement({ requireChanges: config.allowChanges });
    return adminSettings(config, sitesAvailable, finalReadiness, this.dependencies.loadToolDefinitions());
  }
}
