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

import { createAppAuth } from '@octokit/auth-app';
import rootLogger from 'server/lib/logger';
import BaseService from './_service';
import { GlobalConfig, LabelsConfig } from './types/globalConfig';
import { GITHUB_APP_INSTALLATION_ID, APP_AUTH, APP_ENV } from 'shared/config';
import { Metrics } from 'server/lib/metrics';
import { redisClient } from 'server/lib/dependencies';

const logger = rootLogger.child({
  filename: 'services/globalConfig.ts',
});

const REDIS_CACHE_KEY = 'global_config';
const GITHUB_CACHED_CLIENT_TOKEN = 'github_cached_client_token';

export default class GlobalConfigService extends BaseService {
  private static instance: GlobalConfigService;

  static getInstance(): GlobalConfigService {
    if (!this.instance) {
      this.instance = new GlobalConfigService();
    }
    return this.instance;
  }

  protected cacheRefreshQueue = this.queueManager.registerQueue('globalConfigCacheRefresh', {
    createClient: redisClient.getBullCreateClient(),
  });
  protected githubClient = this.queueManager.registerQueue('githubClientTokenCacheRefresh', {
    createClient: redisClient.getBullCreateClient(),
  });

  /**
   * Get all configs from DB
   * @returns A map of all config keys values.
   **/
  protected async getAllConfigsFromDb(): Promise<GlobalConfig> {
    const lifecycleDefaultConfigs = await this.db.knex.select().from('global_config');
    const configMap = {} as GlobalConfig;
    for (const lifecycleDefaultConfig of lifecycleDefaultConfigs) {
      configMap[lifecycleDefaultConfig.key] = JSON.stringify(lifecycleDefaultConfig.config);
    }
    return configMap;
  }

  /**
   * Get all global configs. First, it will try to retrieve them from the cache.
   * If they are not available if cache is empty, it will fetch them from the DB, cache them, and then return them.
   * @returns A map of all config keys values.
   **/
  async getAllConfigs(refreshCache: boolean = false): Promise<GlobalConfig> {
    const cachedConfigs = await this.redis.hgetall(REDIS_CACHE_KEY);
    if (Object.keys(cachedConfigs).length === 0 || refreshCache) {
      logger.debug('Cache miss for all configs, fetching from DB');
      const configsFromDb = await this.getAllConfigsFromDb();

      // to delete keys removed from database
      // this is not a common scenario that happens with global config table, but just to be safe
      const keysFromDb = new Set(Object.keys(configsFromDb));
      const keysToRemove = Object.keys(cachedConfigs).filter((key) => !keysFromDb.has(key));
      if (keysToRemove.length > 0) {
        await this.redis.hdel(REDIS_CACHE_KEY, ...keysToRemove);
        logger.debug(`Deleted stale keys from cache: ${keysToRemove.join(', ')}`);
      }

      await this.redis.hmset(REDIS_CACHE_KEY, configsFromDb);
      return this.deserialize(configsFromDb);
    }
    return this.deserialize(cachedConfigs);
  }

  /**
   * Retrieves `orgChart.name` config from config cache.
   * While most other configs are fetched directly using getAllConfigs() method, this config value might undergo further changes so
   * keeping the fetch DRY here
   * This should be refactored later when we have a better way to configure internal or private helm app charts
   * */
  async getOrgChartName(): Promise<string> {
    const {
      orgChart: { name: orgChartName },
    } = await this.getAllConfigs();
    return orgChartName;
  }

  /**
   * Returns a boolean value based on feature value. will return false if feature name doesnt exist
   * would like to extend this better in the future to be repo specific for more control
   * @param name feature flag name
   * @returns Promise<boolean>
   * */
  async isFeatureEnabled(name: string): Promise<boolean> {
    const { features } = await this.getAllConfigs();
    if (!features) return false;
    return Boolean(features[name]);
  }

  /**
   * Retrieves labels configuration from global config with fallback defaults
   * @returns Promise<LabelsConfig> The labels configuration
   */
  async getLabels(): Promise<LabelsConfig> {
    try {
      const { labels } = await this.getAllConfigs();
      if (!labels) throw new Error('Labels configuration not found in global config');
      return labels;
    } catch (error) {
      logger.error('Error retrieving labels configuration, using fallback defaults', error);
      // Return fallback defaults on error
      return {
        deploy: ['lifecycle-deploy!'],
        disabled: ['lifecycle-disabled!'],
        statusComments: ['lifecycle-status-comments!'],
        defaultStatusComments: true,
      };
    }
  }

  private deserialize(config: unknown): GlobalConfig {
    const deserializedConfigs = {};
    for (const [key, value] of Object.entries(config)) {
      try {
        deserializedConfigs[key as keyof GlobalConfig] = JSON.parse(value as string);
      } catch (e) {
        logger.error(`Error deserializing config for key ${key}: ${e.message}`);
      }
    }
    return deserializedConfigs as GlobalConfig;
  }

  async getGithubClientToken(refreshCache = false) {
    const cachedGithubClientToken = (await this.redis.hgetall(GITHUB_CACHED_CLIENT_TOKEN)) || {};
    const metrics = new Metrics('github.api.rate_limit', {});
    if (Object.keys(cachedGithubClientToken).length === 0 || refreshCache) {
      const app = createAppAuth(APP_AUTH);
      const { token } = await app({
        type: 'installation',
        installationId: GITHUB_APP_INSTALLATION_ID,
      });
      await this.redis.hmset(GITHUB_CACHED_CLIENT_TOKEN, { token });
      return token;
    }
    metrics.increment('cache_hit');
    return cachedGithubClientToken?.token;
  }

  /**
   * Setup a job to refresh the global config cache every hour
   *
   * @returns void
   **/
  async setupCacheRefreshJob() {
    const isDev = APP_ENV?.includes('dev') ?? false;
    if (isDev) {
      try {
        await this.getGithubClientToken(true);
      } catch (error) {
        logger.child({ error }).error(`Error refreshing GlobalConfig cache during boot: ${error}`);
      }
    }
    this.cacheRefreshQueue.process(async () => {
      try {
        await this.getAllConfigs(true);
        await this.getGithubClientToken(true);
        logger.debug('GlobalConfig and Github cache refreshed successfully.');
      } catch (error) {
        logger.child({ error }).error('Error refreshing GlobalConfig cache');
      }
    });

    this.cacheRefreshQueue.add(
      {},
      {
        repeat: {
          every: 30000 * 60,
          // uncomment below for quick testing
          // every: 10000,
        },
      }
    );
  }

  /**
   * Set a config value by key directly in the database.
   * If the key already exists, it will be updated.
   * @param key The config key to set.
   * @param value The value to set for the key.
   * @throws Error if an unexpected database error occurs.
   */
  async setConfig(key: string, value: any): Promise<void> {
    try {
      await this.db.knex('global_config').insert({ key, config: value }).onConflict('key').merge();
      logger.info(`Set global config value for key: ${key}`);
    } catch (err: any) {
      logger.child({ err }).error(`Error setting global config value for key: ${key}`);
      throw err;
    }
  }

  /**
   * Fetch a config value by key directly from the database (not cache).
   * @param key The config key to fetch.
   * @returns The parsed config value, or undefined if not found.
   */
  async getConfig(key: string): Promise<any | undefined> {
    try {
      const row = await this.db.knex('global_config').where({ key }).first();
      if (!row) return undefined;
      return typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    } catch {
      return undefined;
    }
  }
}
