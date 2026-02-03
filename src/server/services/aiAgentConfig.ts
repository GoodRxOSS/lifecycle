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

import BaseService from './_service';
import GlobalConfigService from './globalConfig';
import { getLogger } from 'server/lib/logger';
import type { AIAgentConfig, AIAgentRepoOverride, AIAgentRepoConfigRow } from './types/aiAgentConfig';
import { validateFileExclusionPatterns } from 'server/lib/validation/filePatternValidator';

const REDIS_KEY_PREFIX = 'ai_agent_repo_config:';

export default class AIAgentConfigService extends BaseService {
  private static instance: AIAgentConfigService;

  private memoryCache: Map<string, { data: AIAgentConfig; expiry: number }> = new Map();
  private globalCache: { data: AIAgentConfig | null; expiry: number } = { data: null, expiry: 0 };
  private static MEMORY_CACHE_TTL_MS = 30000;

  static getInstance(): AIAgentConfigService {
    if (!this.instance) {
      this.instance = new AIAgentConfigService();
    }
    return this.instance;
  }

  async getEffectiveConfig(repoFullName?: string): Promise<AIAgentConfig> {
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
        const repoOverride = JSON.parse(redisValue) as Partial<AIAgentRepoOverride>;
        const merged = this.mergeConfigs(globalDefaults, repoOverride);
        this.memoryCache.set(normalized, { data: merged, expiry: now + AIAgentConfigService.MEMORY_CACHE_TTL_MS });
        return merged;
      }

      const row = await this.db
        .knex('ai_agent_repo_config')
        .where({ repositoryFullName: normalized })
        .whereNull('deletedAt')
        .first();

      if (row) {
        const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
        await this.redis.set(redisKey, JSON.stringify(config), 'EX', 300);
        const merged = this.mergeConfigs(globalDefaults, config as Partial<AIAgentRepoOverride>);
        this.memoryCache.set(normalized, { data: merged, expiry: now + AIAgentConfigService.MEMORY_CACHE_TTL_MS });
        return merged;
      }

      return globalDefaults;
    } catch (error) {
      getLogger().warn(`AIAgentConfig: repo config lookup failed repo=${normalized} error=${error}`);
      return globalDefaults;
    }
  }

  private async getGlobalDefaults(): Promise<AIAgentConfig> {
    const now = Date.now();
    if (this.globalCache.data && now < this.globalCache.expiry) {
      return this.globalCache.data;
    }

    const config = await GlobalConfigService.getInstance().getConfig('aiAgent');
    this.globalCache = { data: config, expiry: now + AIAgentConfigService.MEMORY_CACHE_TTL_MS };
    return config;
  }

  private mergeConfigs(global: AIAgentConfig, repoOverride: Partial<AIAgentRepoOverride>): AIAgentConfig {
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
    if (repoOverride.systemPromptOverride !== undefined) {
      result.systemPromptOverride = repoOverride.systemPromptOverride;
    }

    const arrayFields: (keyof AIAgentRepoOverride)[] = ['additiveRules', 'excludedTools', 'excludedFilePatterns'];

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

  async getGlobalConfig(): Promise<AIAgentConfig> {
    const config = await GlobalConfigService.getInstance().getConfig('aiAgent');
    if (!config) {
      return {
        enabled: false,
        providers: [],
        maxMessagesPerSession: 50,
        sessionTTL: 3600,
      };
    }
    return config as AIAgentConfig;
  }

  async setGlobalConfig(config: AIAgentConfig): Promise<void> {
    await GlobalConfigService.getInstance().setConfig('aiAgent', config);
    this.globalCache = { data: null, expiry: 0 };
    this.memoryCache.clear();
    getLogger().info('AIAgentConfig: global config updated via=api');
  }

  async listRepoConfigs(): Promise<AIAgentRepoConfigRow[]> {
    const rows = await this.db.knex('ai_agent_repo_config').whereNull('deletedAt').orderBy('repositoryFullName', 'asc');

    return rows.map((row: any) => ({
      id: row.id,
      repositoryFullName: row.repositoryFullName,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async getRepoConfig(repoFullName: string): Promise<Partial<AIAgentRepoOverride> | null> {
    const normalized = repoFullName.toLowerCase();
    const row = await this.db
      .knex('ai_agent_repo_config')
      .where({ repositoryFullName: normalized })
      .whereNull('deletedAt')
      .first();

    if (!row) {
      return null;
    }

    return typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
  }

  async setRepoConfig(repoFullName: string, config: Partial<AIAgentRepoOverride>): Promise<void> {
    const normalized = repoFullName.toLowerCase();
    if (config.systemPromptOverride !== undefined && config.systemPromptOverride.length > 50000) {
      throw new Error('systemPromptOverride exceeds maximum length of 50000 characters');
    }
    if (config.excludedTools && config.excludedTools.length > 0) {
      const CORE_TOOLS = ['query_database'];
      for (const tool of config.excludedTools) {
        if (CORE_TOOLS.includes(tool)) {
          throw new Error(`Cannot exclude core tool: "${tool}". Core tools are required for agent operation.`);
        }
      }
    }
    if (config.excludedFilePatterns && config.excludedFilePatterns.length > 0) {
      validateFileExclusionPatterns(config.excludedFilePatterns);
    }
    await this.db
      .knex('ai_agent_repo_config')
      .insert({
        repositoryFullName: normalized,
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

    const redisKey = `${REDIS_KEY_PREFIX}${normalized}`;
    await this.redis.del(redisKey);
    this.memoryCache.delete(normalized);
  }

  async deleteRepoConfig(repoFullName: string): Promise<void> {
    const normalized = repoFullName.toLowerCase();
    await this.db
      .knex('ai_agent_repo_config')
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
      this.memoryCache.clear();
      this.globalCache = { data: null, expiry: 0 };
    }
  }
}
