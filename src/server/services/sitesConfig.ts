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

import type { SitesConfig } from './types/globalConfig';
import GlobalConfigService from './globalConfig';

const SITES_CONFIG_KEY = 'sites';

export const DEFAULT_SITES_CONFIG: SitesConfig = {
  enabled: false,
  domain: 'localhost',
  port: null,
  hostPrefix: 'site',
  ttl: {
    enabled: true,
    defaultDays: 7,
    extensionDays: 7,
  },
  upload: {
    maxUploadBytes: 10 * 1024 * 1024,
    maxExtractedBytes: 10 * 1024 * 1024,
    maxFiles: 500,
    allowedExtensions: [
      'html',
      'zip',
      'json',
      'md',
      'markdown',
      'txt',
      'css',
      'js',
      'mjs',
      'map',
      'csv',
      'xml',
      'svg',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'avif',
      'ico',
      'webmanifest',
      'wasm',
      'woff',
      'woff2',
      'ttf',
      'otf',
      'pdf',
    ],
  },
  storage: {
    backend: 'minio',
    bucket: 'lifecycle-sites',
    prefix: 'sites',
    region: 'us-west-2',
    endpoint: null,
    forcePathStyle: true,
  },
  cleanup: {
    enabled: true,
    intervalMinutes: 15,
  },
};

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizePositiveInteger(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(parsed) && Number(parsed) > 0 ? Number(parsed) : fallback;
}

function normalizePort(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(parsed) && Number(parsed) > 0 && Number(parsed) <= 65535 ? Number(parsed) : null;
}

function normalizeHostPrefix(value: string | null | undefined): string {
  const normalized = (value || DEFAULT_SITES_CONFIG.hostPrefix || 'site')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return normalized || DEFAULT_SITES_CONFIG.hostPrefix || 'site';
}

function normalizeExtensions(values: string[] | undefined): string[] {
  const extensions = values?.length ? values : DEFAULT_SITES_CONFIG.upload?.allowedExtensions || [];
  return Array.from(
    new Set(extensions.map((extension) => extension.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))
  );
}

function mergeSitesConfig(config: SitesConfig | undefined): SitesConfig {
  return {
    ...DEFAULT_SITES_CONFIG,
    ...config,
    ttl: {
      ...DEFAULT_SITES_CONFIG.ttl,
      ...config?.ttl,
    },
    upload: {
      ...DEFAULT_SITES_CONFIG.upload,
      ...config?.upload,
    },
    storage: {
      ...DEFAULT_SITES_CONFIG.storage,
      ...config?.storage,
    },
    cleanup: {
      ...DEFAULT_SITES_CONFIG.cleanup,
      ...config?.cleanup,
    },
  };
}

function normalizeSitesConfig(config: SitesConfig | undefined): SitesConfig {
  const merged = mergeSitesConfig(config);
  const storageBackend = merged.storage?.backend === 's3' ? 's3' : 'minio';

  return {
    enabled: merged.enabled ?? false,
    domain: normalizeOptionalString(merged.domain) || DEFAULT_SITES_CONFIG.domain,
    port: normalizePort(merged.port),
    hostPrefix: normalizeHostPrefix(merged.hostPrefix),
    ttl: {
      enabled: merged.ttl?.enabled ?? true,
      defaultDays: normalizePositiveInteger(merged.ttl?.defaultDays, DEFAULT_SITES_CONFIG.ttl?.defaultDays || 7),
      extensionDays: normalizePositiveInteger(merged.ttl?.extensionDays, DEFAULT_SITES_CONFIG.ttl?.extensionDays || 7),
    },
    upload: {
      maxUploadBytes: normalizePositiveInteger(
        merged.upload?.maxUploadBytes,
        DEFAULT_SITES_CONFIG.upload?.maxUploadBytes || 10 * 1024 * 1024
      ),
      maxExtractedBytes: normalizePositiveInteger(
        merged.upload?.maxExtractedBytes,
        DEFAULT_SITES_CONFIG.upload?.maxExtractedBytes || 10 * 1024 * 1024
      ),
      maxFiles: normalizePositiveInteger(merged.upload?.maxFiles, DEFAULT_SITES_CONFIG.upload?.maxFiles || 500),
      allowedExtensions: normalizeExtensions(merged.upload?.allowedExtensions || merged.upload?.allowedTypes),
    },
    storage: {
      backend: storageBackend,
      bucket: normalizeOptionalString(merged.storage?.bucket) || DEFAULT_SITES_CONFIG.storage?.bucket,
      prefix: (normalizeOptionalString(merged.storage?.prefix) || DEFAULT_SITES_CONFIG.storage?.prefix || 'sites')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/{2,}/g, '/'),
      region: normalizeOptionalString(merged.storage?.region) || DEFAULT_SITES_CONFIG.storage?.region,
      endpoint: normalizeOptionalString(merged.storage?.endpoint),
      forcePathStyle: merged.storage?.forcePathStyle ?? storageBackend === 'minio',
    },
    cleanup: {
      enabled: merged.cleanup?.enabled ?? true,
      intervalMinutes: normalizePositiveInteger(
        merged.cleanup?.intervalMinutes,
        DEFAULT_SITES_CONFIG.cleanup?.intervalMinutes || 15
      ),
    },
  };
}

export default class SitesConfigService {
  private static instance: SitesConfigService;

  static getInstance(): SitesConfigService {
    if (!this.instance) {
      this.instance = new SitesConfigService();
    }
    return this.instance;
  }

  async getConfig(): Promise<SitesConfig> {
    const config = (await GlobalConfigService.getInstance().getConfig(SITES_CONFIG_KEY)) as SitesConfig | undefined;
    return normalizeSitesConfig(config);
  }

  async setConfig(config: SitesConfig): Promise<SitesConfig> {
    const normalized = normalizeSitesConfig(config);
    await GlobalConfigService.getInstance().setConfig(SITES_CONFIG_KEY, normalized);
    return normalized;
  }
}
