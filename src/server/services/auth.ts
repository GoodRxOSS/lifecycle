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

import Service from './_service';
import ApiKey from '../models/ApiKey';
import GlobalConfigService from './globalConfig';
import { generateApiKey, parseApiKey, validateSecret } from '../lib/auth/keyGenerator';
import rootLogger from '../lib/logger';

const logger = rootLogger.child({
  filename: 'services/auth.ts',
});

export interface ApiConfig {
  rate_limit: number;
  rate_limit_window: number;
  bcrypt_rounds: number;
  require_https: boolean;
}

const DEFAULT_API_CONFIG: ApiConfig = {
  rate_limit: 1000,
  rate_limit_window: 600,
  bcrypt_rounds: 12,
  require_https: true,
};

export interface CreateApiKeyOptions {
  name: string;
  description?: string;
  githubUserId?: number;
  githubLogin?: string;
  scopes?: string[];
}

export default class AuthService extends Service {
  /**
   * Get API configuration from global_config table using GlobalConfigService cache
   */
  async getApiConfig(): Promise<ApiConfig> {
    try {
      const globalConfigService = GlobalConfigService.getInstance();
      const allConfigs = await globalConfigService.getAllConfigs();

      if (allConfigs.apiConfig) {
        return { ...DEFAULT_API_CONFIG, ...allConfigs.apiConfig };
      } else {
        // If no config exists, create default using GlobalConfigService
        await globalConfigService.setConfig('apiConfig', DEFAULT_API_CONFIG);
        return DEFAULT_API_CONFIG;
      }
    } catch (error) {
      logger.error('Failed to fetch API config, using defaults:', error);
      return DEFAULT_API_CONFIG;
    }
  }

  /**
   * Create a new API key
   */
  async createApiKey(options: CreateApiKeyOptions): Promise<{ apiKey: ApiKey; fullKey: string }> {
    const config = await this.getApiConfig();
    const generated = await generateApiKey(config.bcrypt_rounds);

    const apiKey = await ApiKey.query().insert({
      keyId: generated.keyId,
      secretHash: generated.secretHash,
      name: options.name,
      description: options.description,
      githubUserId: options.githubUserId,
      githubLogin: options.githubLogin,
      scopes: options.scopes || [],
      active: true,
    });

    return {
      apiKey,
      fullKey: generated.fullKey, // Only returned on creation, never again
    };
  }

  /**
   * Validate an API key and return the key record if valid
   */
  async validateApiKey(apiKeyString: string): Promise<ApiKey | null> {
    const parsed = parseApiKey(apiKeyString);
    if (!parsed) {
      return null;
    }

    const { keyId, secret } = parsed;

    const apiKey = await ApiKey.query().where('key_id', keyId).where('active', true).first();

    if (!apiKey) {
      return null;
    }

    const isValid = await validateSecret(secret, apiKey.secretHash);
    if (!isValid) {
      return null;
    }

    return apiKey;
  }

  /**
   * Update last used timestamp (throttled)
   */
  async updateLastUsed(apiKey: ApiKey): Promise<void> {
    const THRESHOLD = 5 * 60 * 1000; // 5 minutes
    const now = new Date();

    if (!apiKey.lastUsedAt || now.getTime() - new Date(apiKey.lastUsedAt).getTime() > THRESHOLD) {
      // Async update - don't await
      setImmediate(async () => {
        try {
          await ApiKey.query().where('id', apiKey.id).patch({ lastUsedAt: now.toISOString() });
        } catch (error) {
          logger.error('Failed to update last_used_at:', error);
        }
      });
    }
  }

  /**
   * List all API keys (masked)
   */
  async listApiKeys(): Promise<ApiKey[]> {
    return ApiKey.query()
      .select(
        'id',
        'key_id',
        'name',
        'description',
        'active',
        'github_user_id',
        'github_login',
        'created_at',
        'updated_at',
        'last_used_at'
      )
      .orderBy('created_at', 'desc');
  }

  /**
   * Revoke an API key
   */
  async revokeApiKey(id: number): Promise<boolean> {
    const result = await ApiKey.query().where('id', id).patch({ active: false });

    return result > 0;
  }

  /**
   * Update an API key
   */
  async updateApiKey(id: number, updates: Partial<CreateApiKeyOptions>): Promise<ApiKey | null> {
    const apiKey = await ApiKey.query().patchAndFetchById(id, {
      name: updates.name,
      description: updates.description,
      scopes: updates.scopes,
    });

    return apiKey;
  }
}
