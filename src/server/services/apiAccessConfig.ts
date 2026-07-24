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

import AuthAuditEvent from 'server/models/AuthAuditEvent';
import type { ApiEnvironmentsConfig, ApiKeysConfig } from './types/globalConfig';
import GlobalConfigService from './globalConfig';
import { recordAuthAuditEventInTransaction } from './authAudit';

const API_KEYS_CONFIG_KEY = 'api_keys';
const API_ENVIRONMENTS_CONFIG_KEY = 'api_environments';

export const DEFAULT_API_KEYS_CONFIG: Required<ApiKeysConfig> = {
  issuanceEnabled: false,
  personalAuthEnabled: false,
  serviceAuthEnabled: false,
  rateLimitPerMinute: 600,
  maxActivePersonalKeysPerUser: 10,
};

export const DEFAULT_API_ENVIRONMENTS_CONFIG: Required<ApiEnvironmentsConfig> = {
  enabled: false,
  defaultTtlHours: 72,
  maxTtlHours: 336,
  extensionHours: 24,
};

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function normalizeApiKeysConfig(config: ApiKeysConfig | undefined): Required<ApiKeysConfig> {
  return {
    issuanceEnabled: config?.issuanceEnabled === true,
    personalAuthEnabled: config?.personalAuthEnabled === true,
    serviceAuthEnabled: config?.serviceAuthEnabled === true,
    rateLimitPerMinute: positiveInteger(config?.rateLimitPerMinute, DEFAULT_API_KEYS_CONFIG.rateLimitPerMinute),
    maxActivePersonalKeysPerUser: positiveInteger(
      config?.maxActivePersonalKeysPerUser,
      DEFAULT_API_KEYS_CONFIG.maxActivePersonalKeysPerUser
    ),
  };
}

function normalizeApiEnvironmentsConfig(config: ApiEnvironmentsConfig | undefined): Required<ApiEnvironmentsConfig> {
  return {
    enabled: config?.enabled === true,
    defaultTtlHours: positiveInteger(config?.defaultTtlHours, DEFAULT_API_ENVIRONMENTS_CONFIG.defaultTtlHours),
    maxTtlHours: positiveInteger(config?.maxTtlHours, DEFAULT_API_ENVIRONMENTS_CONFIG.maxTtlHours),
    extensionHours: positiveInteger(config?.extensionHours, DEFAULT_API_ENVIRONMENTS_CONFIG.extensionHours),
  };
}

export default class ApiAccessConfigService {
  private static instance: ApiAccessConfigService;

  static getInstance(): ApiAccessConfigService {
    if (!this.instance) {
      this.instance = new ApiAccessConfigService();
    }
    return this.instance;
  }

  async getApiKeysConfig(): Promise<Required<ApiKeysConfig>> {
    const config = (await GlobalConfigService.getInstance().getConfig(API_KEYS_CONFIG_KEY)) as
      | ApiKeysConfig
      | undefined;
    return normalizeApiKeysConfig(config);
  }

  /** Config change + its audit row commit together; actorId is the admin performing the change. */
  async setApiKeysConfig(config: ApiKeysConfig, actorId: string): Promise<Required<ApiKeysConfig>> {
    const normalized = normalizeApiKeysConfig(config);
    const before = await this.getApiKeysConfig();
    await AuthAuditEvent.transaction(async (trx) => {
      await GlobalConfigService.getInstance().setConfig(API_KEYS_CONFIG_KEY, normalized, trx);
      await recordAuthAuditEventInTransaction(trx, {
        event: 'api_keys.config_updated',
        principalKind: 'user',
        principalId: actorId,
        actorId,
        outcome: 'updated',
        meta: { before, after: normalized },
      });
    });
    await GlobalConfigService.getInstance().invalidateCache();
    return normalized;
  }

  async getApiEnvironmentsConfig(): Promise<Required<ApiEnvironmentsConfig>> {
    const config = (await GlobalConfigService.getInstance().getConfig(API_ENVIRONMENTS_CONFIG_KEY)) as
      | ApiEnvironmentsConfig
      | undefined;
    return normalizeApiEnvironmentsConfig(config);
  }

  /** Config change + its audit row commit together; actorId is the admin performing the change. */
  async setApiEnvironmentsConfig(
    config: ApiEnvironmentsConfig,
    actorId: string
  ): Promise<Required<ApiEnvironmentsConfig>> {
    const normalized = normalizeApiEnvironmentsConfig(config);
    const before = await this.getApiEnvironmentsConfig();
    await AuthAuditEvent.transaction(async (trx) => {
      await GlobalConfigService.getInstance().setConfig(API_ENVIRONMENTS_CONFIG_KEY, normalized, trx);
      await recordAuthAuditEventInTransaction(trx, {
        event: 'api_environments.config_updated',
        principalKind: 'user',
        principalId: actorId,
        actorId,
        outcome: 'updated',
        meta: { before, after: normalized },
      });
    });
    await GlobalConfigService.getInstance().invalidateCache();
    return normalized;
  }
}
