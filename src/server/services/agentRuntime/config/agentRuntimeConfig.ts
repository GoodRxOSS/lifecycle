/**
 * Copyright 2025 GoodRx, Inc.
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

import BaseService from '../../_service';
import GlobalConfigService from '../../globalConfig';
import { getLogger } from 'server/lib/logger';
import type {
  AgentRuntimeConfig,
  AgentRuntimeRepoOverride,
  AgentRuntimeRepoConfigRow,
  ApprovalPolicyConfig,
  CapabilityPolicyConfig,
  CustomAgentCreationPolicyConfig,
} from 'server/services/types/agentRuntimeConfig';
import {
  validateAgentRuntimeConfig,
  validateAgentRuntimeRepoOverride,
} from 'server/lib/validation/agentRuntimeConfigValidator';

const REDIS_KEY_PREFIX = 'agent_runtime_repo_config:';

export class AgentRuntimeConfigService extends BaseService {
  private static instance: AgentRuntimeConfigService;

  private memoryCache: Map<string, { data: AgentRuntimeConfig; expiry: number }> = new Map();
  private globalCache: { data: AgentRuntimeConfig | null; expiry: number } = { data: null, expiry: 0 };
  private static MEMORY_CACHE_TTL_MS = 30000;

  static getInstance(): AgentRuntimeConfigService {
    if (!this.instance) {
      this.instance = new AgentRuntimeConfigService();
    }
    return this.instance;
  }

  async getEffectiveConfig(repoFullName?: string): Promise<AgentRuntimeConfig> {
    const globalDefaults = await this.getGlobalDefaults();

    if (!repoFullName) {
      return globalDefaults;
    }

    const normalized = repoFullName.toLowerCase();

    const now = Date.now();
    const cached = this.memoryCache.get(normalized);
    if (cached && now < cached.expiry) {
      return cached.data;
    }

    try {
      const redisKey = `${REDIS_KEY_PREFIX}${normalized}`;
      const redisValue = await this.redis.get(redisKey);

      if (redisValue) {
        const repoOverride = JSON.parse(redisValue) as Partial<AgentRuntimeRepoOverride>;
        const merged = this.mergeConfigs(globalDefaults, repoOverride);
        this.memoryCache.set(normalized, { data: merged, expiry: now + AgentRuntimeConfigService.MEMORY_CACHE_TTL_MS });
        return merged;
      }

      const row = await this.db
        .knex('agent_runtime_repo_config')
        .where({ repositoryFullName: normalized })
        .whereNull('deletedAt')
        .first();

      if (row) {
        const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
        await this.redis.set(redisKey, JSON.stringify(config), 'EX', 300);
        const merged = this.mergeConfigs(globalDefaults, config as Partial<AgentRuntimeRepoOverride>);
        this.memoryCache.set(normalized, { data: merged, expiry: now + AgentRuntimeConfigService.MEMORY_CACHE_TTL_MS });
        return merged;
      }

      return globalDefaults;
    } catch (error) {
      getLogger().warn(`AgentRuntimeConfig: repo config lookup failed repo=${normalized} error=${error}`);
      return globalDefaults;
    }
  }

  private async getGlobalDefaults(): Promise<AgentRuntimeConfig> {
    const now = Date.now();
    if (this.globalCache.data && now < this.globalCache.expiry) {
      return this.globalCache.data;
    }

    const config = await GlobalConfigService.getInstance().getConfig('agentRuntime');
    this.globalCache = { data: config, expiry: now + AgentRuntimeConfigService.MEMORY_CACHE_TTL_MS };
    return config;
  }

  private mergeApprovalPolicy(
    globalPolicy?: ApprovalPolicyConfig,
    repoPolicy?: ApprovalPolicyConfig
  ): ApprovalPolicyConfig | undefined {
    if (!globalPolicy && !repoPolicy) {
      return undefined;
    }

    return {
      defaultMode: repoPolicy?.defaultMode ?? globalPolicy?.defaultMode,
      rules: {
        ...(globalPolicy?.rules || {}),
        ...(repoPolicy?.rules || {}),
      },
    };
  }

  private mergeCapabilityPolicy(
    globalPolicy?: CapabilityPolicyConfig,
    repoPolicy?: CapabilityPolicyConfig
  ): CapabilityPolicyConfig | undefined {
    if (!globalPolicy && !repoPolicy) {
      return undefined;
    }

    return {
      availability: {
        ...(globalPolicy?.availability || {}),
        ...(repoPolicy?.availability || {}),
      },
    };
  }

  private mergeConfigs(
    global: AgentRuntimeConfig,
    repoOverride: Partial<AgentRuntimeRepoOverride>
  ): AgentRuntimeConfig {
    const result = { ...global };

    if (repoOverride.enabled !== undefined) {
      result.enabled = repoOverride.enabled;
    }
    if (repoOverride.maxMessagesPerSession !== undefined) {
      result.maxMessagesPerSession = repoOverride.maxMessagesPerSession;
    }
    if (repoOverride.sessionTTL !== undefined) {
      result.sessionTTL = repoOverride.sessionTTL;
    }
    result.approvalPolicy = this.mergeApprovalPolicy(global.approvalPolicy, repoOverride.approvalPolicy);
    result.capabilityPolicy = this.mergeCapabilityPolicy(global.capabilityPolicy, repoOverride.capabilityPolicy);
    if (repoOverride.systemPromptOverride !== undefined) {
      result.systemPromptOverride = repoOverride.systemPromptOverride;
    }
    const arrayFields: (keyof AgentRuntimeRepoOverride)[] = [
      'additiveRules',
      'excludedTools',
      'excludedFilePatterns',
      'allowedWritePatterns',
    ];

    for (const field of arrayFields) {
      const globalArray = (global as any)[field] as string[] | undefined;
      const repoArray = repoOverride[field] as string[] | undefined;
      if (repoArray && repoArray.length > 0) {
        const combined = [...(globalArray || []), ...repoArray];
        (result as any)[field] = [...new Set(combined)];
      }
    }

    return result;
  }

  async getGlobalConfig(): Promise<AgentRuntimeConfig> {
    const config = await GlobalConfigService.getInstance().getConfig('agentRuntime');
    if (!config) {
      return {
        enabled: false,
        providers: [],
        maxMessagesPerSession: 50,
        sessionTTL: 3600,
        allowedWritePatterns: ['lifecycle.yaml', 'lifecycle.yml'],
      };
    }
    return config as AgentRuntimeConfig;
  }

  async setGlobalConfig(config: AgentRuntimeConfig): Promise<void> {
    validateAgentRuntimeConfig(config);
    await GlobalConfigService.getInstance().setConfig('agentRuntime', config);
    this.invalidateCaches();
    getLogger().info('AgentRuntimeConfig: global config updated via=api');
  }

  async updateGlobalAdditiveRules(additiveRules: string[]): Promise<AgentRuntimeConfig> {
    validateAgentRuntimeRepoOverride({ additiveRules });

    const currentConfig = await this.getGlobalConfig();
    const nextConfig: AgentRuntimeConfig = {
      ...currentConfig,
      additiveRules,
    };

    await GlobalConfigService.getInstance().setConfig('agentRuntime', nextConfig);
    this.invalidateCaches();
    getLogger().info(`AgentRuntimeConfig: global additive rules updated count=${additiveRules.length} via=api`);

    return nextConfig;
  }

  async updateGlobalApprovalPolicy(approvalPolicy: ApprovalPolicyConfig): Promise<AgentRuntimeConfig> {
    validateAgentRuntimeRepoOverride({ approvalPolicy });

    const currentConfig = await this.getGlobalConfig();
    const nextApprovalPolicy = this.normalizeApprovalPolicy(approvalPolicy);
    const nextConfig: AgentRuntimeConfig = {
      ...currentConfig,
    };

    if (nextApprovalPolicy) {
      nextConfig.approvalPolicy = nextApprovalPolicy;
    } else {
      delete nextConfig.approvalPolicy;
    }

    await GlobalConfigService.getInstance().setConfig('agentRuntime', nextConfig);
    this.invalidateCaches();
    getLogger().info('AgentRuntimeConfig: global approval policy updated via=api');

    return nextConfig;
  }

  async updateGlobalCapabilityPolicy(capabilityPolicy: CapabilityPolicyConfig): Promise<AgentRuntimeConfig> {
    validateAgentRuntimeRepoOverride({ capabilityPolicy });

    const currentConfig = await this.getGlobalConfig();
    const nextCapabilityPolicy = this.normalizeCapabilityPolicy(capabilityPolicy);
    const nextConfig: AgentRuntimeConfig = {
      ...currentConfig,
    };

    if (nextCapabilityPolicy) {
      nextConfig.capabilityPolicy = nextCapabilityPolicy;
    } else {
      delete nextConfig.capabilityPolicy;
    }

    await GlobalConfigService.getInstance().setConfig('agentRuntime', nextConfig);
    this.invalidateCaches();
    getLogger().info('AgentRuntimeConfig: global capability policy updated via=api');

    return nextConfig;
  }

  async updateGlobalCustomAgentCreationPolicy(
    customAgentCreationPolicy: CustomAgentCreationPolicyConfig
  ): Promise<AgentRuntimeConfig> {
    validateAgentRuntimeConfig({
      enabled: false,
      providers: [],
      maxMessagesPerSession: 50,
      sessionTTL: 3600,
      customAgentCreationPolicy,
    });

    const currentConfig = await this.getGlobalConfig();
    const nextCustomAgentCreationPolicy = this.normalizeCustomAgentCreationPolicy(customAgentCreationPolicy);
    const nextConfig: AgentRuntimeConfig = {
      ...currentConfig,
    };

    if (nextCustomAgentCreationPolicy) {
      nextConfig.customAgentCreationPolicy = nextCustomAgentCreationPolicy;
    } else {
      delete nextConfig.customAgentCreationPolicy;
    }

    await GlobalConfigService.getInstance().setConfig('agentRuntime', nextConfig);
    this.invalidateCaches();
    getLogger().info('AgentRuntimeConfig: global custom agent creation policy updated via=api');

    return nextConfig;
  }

  async listRepoConfigs(): Promise<AgentRuntimeRepoConfigRow[]> {
    const rows = await this.db
      .knex('agent_runtime_repo_config')
      .whereNull('deletedAt')
      .orderBy('repositoryFullName', 'asc');

    return rows.map((row: any) => ({
      id: row.id,
      repositoryFullName: row.repositoryFullName,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async getRepoConfig(repoFullName: string): Promise<Partial<AgentRuntimeRepoOverride> | null> {
    const normalized = repoFullName.toLowerCase();
    const row = await this.db
      .knex('agent_runtime_repo_config')
      .where({ repositoryFullName: normalized })
      .whereNull('deletedAt')
      .first();

    if (!row) {
      return null;
    }

    return typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
  }

  async setRepoConfig(repoFullName: string, config: Partial<AgentRuntimeRepoOverride>): Promise<void> {
    const normalized = repoFullName.toLowerCase();
    validateAgentRuntimeRepoOverride(config);
    await this.upsertRepoConfig(normalized, config);
  }

  async updateRepoAdditiveRules(
    repoFullName: string,
    additiveRules: string[]
  ): Promise<Partial<AgentRuntimeRepoOverride>> {
    const normalized = repoFullName.toLowerCase();
    validateAgentRuntimeRepoOverride({ additiveRules });

    const currentConfig = (await this.getRepoConfig(normalized)) ?? {};
    const nextConfig: Partial<AgentRuntimeRepoOverride> = {
      ...currentConfig,
      additiveRules,
    };

    await this.upsertRepoConfig(normalized, nextConfig);
    getLogger().info(
      `AgentRuntimeConfig: repo additive rules updated repo=${normalized} count=${additiveRules.length} via=api`
    );

    return nextConfig;
  }

  async updateRepoCapabilityPolicy(
    repoFullName: string,
    capabilityPolicy: CapabilityPolicyConfig
  ): Promise<Partial<AgentRuntimeRepoOverride>> {
    const normalized = repoFullName.toLowerCase();
    validateAgentRuntimeRepoOverride({ capabilityPolicy });

    const currentConfig = (await this.getRepoConfig(normalized)) ?? {};
    const nextCapabilityPolicy = this.normalizeCapabilityPolicy(capabilityPolicy);
    const nextConfig: Partial<AgentRuntimeRepoOverride> = {
      ...currentConfig,
    };

    if (nextCapabilityPolicy) {
      nextConfig.capabilityPolicy = nextCapabilityPolicy;
    } else {
      delete nextConfig.capabilityPolicy;
    }

    await this.upsertRepoConfig(normalized, nextConfig);
    getLogger().info(`AgentRuntimeConfig: repo capability policy updated repo=${normalized} via=api`);

    return nextConfig;
  }

  private async upsertRepoConfig(
    normalizedRepoFullName: string,
    config: Partial<AgentRuntimeRepoOverride>
  ): Promise<void> {
    await this.db
      .knex('agent_runtime_repo_config')
      .insert({
        repositoryFullName: normalizedRepoFullName,
        config: JSON.stringify(config),
        createdAt: this.db.knex.fn.now(),
        updatedAt: this.db.knex.fn.now(),
      })
      .onConflict('repositoryFullName')
      .merge({
        config: JSON.stringify(config),
        updatedAt: this.db.knex.fn.now(),
        deletedAt: null,
      });

    const redisKey = `${REDIS_KEY_PREFIX}${normalizedRepoFullName}`;
    await this.redis.del(redisKey);
    this.memoryCache.delete(normalizedRepoFullName);
  }

  async deleteRepoConfig(repoFullName: string): Promise<void> {
    const normalized = repoFullName.toLowerCase();
    await this.db
      .knex('agent_runtime_repo_config')
      .where({ repositoryFullName: normalized })
      .update({ deletedAt: this.db.knex.fn.now() });

    const redisKey = `${REDIS_KEY_PREFIX}${normalized}`;
    await this.redis.del(redisKey);
    this.memoryCache.delete(normalized);
  }

  clearCache(repoFullName?: string): void {
    if (repoFullName) {
      const normalized = repoFullName.toLowerCase();
      this.memoryCache.delete(normalized);
      const redisKey = `${REDIS_KEY_PREFIX}${normalized}`;
      this.redis.del(redisKey);
    } else {
      this.invalidateCaches();
    }
  }

  private normalizeApprovalPolicy(approvalPolicy?: ApprovalPolicyConfig): ApprovalPolicyConfig | undefined {
    if (!approvalPolicy) {
      return undefined;
    }

    const normalizedRules =
      approvalPolicy.rules && Object.keys(approvalPolicy.rules).length > 0 ? approvalPolicy.rules : undefined;

    if (!approvalPolicy.defaultMode && !normalizedRules) {
      return undefined;
    }

    return {
      ...(approvalPolicy.defaultMode ? { defaultMode: approvalPolicy.defaultMode } : {}),
      ...(normalizedRules ? { rules: normalizedRules } : {}),
    };
  }

  private normalizeCapabilityPolicy(capabilityPolicy?: CapabilityPolicyConfig): CapabilityPolicyConfig | undefined {
    if (!capabilityPolicy) {
      return undefined;
    }

    const normalizedAvailability =
      capabilityPolicy.availability && Object.keys(capabilityPolicy.availability).length > 0
        ? capabilityPolicy.availability
        : undefined;

    if (!normalizedAvailability) {
      return undefined;
    }

    return {
      availability: normalizedAvailability,
    };
  }

  private normalizeCustomAgentCreationPolicy(
    customAgentCreationPolicy?: CustomAgentCreationPolicyConfig
  ): CustomAgentCreationPolicyConfig | undefined {
    if (!customAgentCreationPolicy) {
      return undefined;
    }

    const allowedUserIds = this.normalizeStringList(customAgentCreationPolicy.allowedUserIds);
    const allowedGithubUsernames = this.normalizeStringList(customAgentCreationPolicy.allowedGithubUsernames, {
      lowercase: true,
    });
    const capabilityAvailability =
      customAgentCreationPolicy.capabilityAvailability &&
      Object.keys(customAgentCreationPolicy.capabilityAvailability).length > 0
        ? customAgentCreationPolicy.capabilityAvailability
        : undefined;

    if (!customAgentCreationPolicy.mode && !allowedUserIds && !allowedGithubUsernames && !capabilityAvailability) {
      return undefined;
    }

    return {
      ...(customAgentCreationPolicy.mode ? { mode: customAgentCreationPolicy.mode } : {}),
      ...(allowedUserIds ? { allowedUserIds } : {}),
      ...(allowedGithubUsernames ? { allowedGithubUsernames } : {}),
      ...(capabilityAvailability ? { capabilityAvailability } : {}),
    };
  }

  private normalizeStringList(values?: string[], options: { lowercase?: boolean } = {}): string[] | undefined {
    const normalized = [
      ...new Set(
        (values || [])
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => (options.lowercase ? value.toLowerCase() : value))
      ),
    ];

    return normalized.length > 0 ? normalized : undefined;
  }

  private invalidateCaches(): void {
    this.globalCache = { data: null, expiry: 0 };
    this.memoryCache.clear();
  }
}

export default AgentRuntimeConfigService;
