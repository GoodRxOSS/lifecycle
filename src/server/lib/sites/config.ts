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

import {
  OBJECT_STORE_ACCESS_KEY,
  OBJECT_STORE_ENDPOINT,
  OBJECT_STORE_PORT,
  OBJECT_STORE_REGION,
  OBJECT_STORE_SECRET_KEY,
  OBJECT_STORE_TYPE,
  OBJECT_STORE_USE_SSL,
} from 'shared/config';
import type { SitesConfig } from 'server/services/types/globalConfig';

export const TEN_MIB = 10 * 1024 * 1024;
export const DEFAULT_HOST_PREFIX = 'site';
export const DEFAULT_ALLOWED_EXTENSIONS = [
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
];

export type ResolvedSitesConfig = {
  enabled: boolean;
  domain: string;
  port: number | null;
  hostPrefix: string;
  ttl: {
    enabled: boolean;
    defaultDays: number;
    extensionDays: number;
  };
  upload: {
    maxUploadBytes: number;
    maxExtractedBytes: number;
    maxFiles: number;
    allowedExtensions: string[];
  };
  storage: {
    backend: 's3' | 'minio';
    bucket: string;
    prefix: string;
    region: string;
    endpoint: string | null;
    forcePathStyle: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  cleanup: {
    enabled: boolean;
    intervalMinutes: number;
  };
};

function normalizeDomain(domain?: string | null): { domain: string; port: number | null } {
  const rawDomain = (domain || 'localhost')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '')
    .replace(/\.$/, '');
  const portMatch = rawDomain.match(/:(\d+)$/);
  const parsedPort = portMatch ? Number(portMatch[1]) : null;
  const normalizedDomain = portMatch ? rawDomain.slice(0, -portMatch[0].length) : rawDomain;

  return {
    domain: normalizedDomain || 'localhost',
    port:
      parsedPort !== null && Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : null,
  };
}

function normalizePort(port?: number | string | null): number | null {
  const value = typeof port === 'string' ? Number(port) : port;
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : null;
}

function normalizeHostPrefix(prefix?: string | null): string {
  const normalized = (prefix || DEFAULT_HOST_PREFIX)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return normalized || DEFAULT_HOST_PREFIX;
}

function normalizeAllowedExtensions(config?: SitesConfig | null): string[] {
  const extensions = config?.upload?.allowedExtensions || config?.upload?.allowedTypes || DEFAULT_ALLOWED_EXTENSIONS;
  return Array.from(
    new Set(extensions.map((extension) => extension.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))
  );
}

function resolveEndpoint(config: SitesConfig | undefined): string | null {
  if (config?.storage?.endpoint) {
    return config.storage.endpoint;
  }

  if ((config?.storage?.backend || OBJECT_STORE_TYPE) === 's3') {
    return null;
  }

  const protocol = OBJECT_STORE_USE_SSL === 'true' ? 'https' : 'http';
  return `${protocol}://${OBJECT_STORE_ENDPOINT}:${OBJECT_STORE_PORT}`;
}

export function resolveSitesConfig(config?: SitesConfig | null): ResolvedSitesConfig {
  const backend = (config?.storage?.backend || OBJECT_STORE_TYPE || 'minio') === 's3' ? 's3' : 'minio';
  const domain = normalizeDomain(config?.domain);

  return {
    enabled: config?.enabled ?? false,
    domain: domain.domain,
    port: normalizePort(config?.port) ?? domain.port,
    hostPrefix: normalizeHostPrefix(config?.hostPrefix),
    ttl: {
      enabled: config?.ttl?.enabled ?? true,
      defaultDays: config?.ttl?.defaultDays ?? 7,
      extensionDays: config?.ttl?.extensionDays ?? 7,
    },
    upload: {
      maxUploadBytes: config?.upload?.maxUploadBytes ?? TEN_MIB,
      maxExtractedBytes: config?.upload?.maxExtractedBytes ?? TEN_MIB,
      maxFiles: config?.upload?.maxFiles ?? 500,
      allowedExtensions: normalizeAllowedExtensions(config),
    },
    storage: {
      backend,
      bucket: config?.storage?.bucket || 'lifecycle-sites',
      prefix: (config?.storage?.prefix || 'sites').replace(/^\/+|\/+$/g, ''),
      region: config?.storage?.region || OBJECT_STORE_REGION || 'us-west-2',
      endpoint: resolveEndpoint(config || undefined),
      forcePathStyle: config?.storage?.forcePathStyle ?? backend === 'minio',
      accessKeyId: backend === 'minio' ? OBJECT_STORE_ACCESS_KEY : undefined,
      secretAccessKey: backend === 'minio' ? OBJECT_STORE_SECRET_KEY : undefined,
    },
    cleanup: {
      enabled: config?.cleanup?.enabled ?? true,
      intervalMinutes: config?.cleanup?.intervalMinutes ?? 15,
    },
  };
}

export function buildSiteUrl(siteId: string, config: ResolvedSitesConfig): string {
  const protocol = config.domain === 'localhost' || config.domain.endsWith('.localhost') ? 'http' : 'https';
  const port = config.port ? `:${config.port}` : '';
  return `${protocol}://${config.hostPrefix}-${siteId}.${config.domain}${port}`;
}

export function parseSiteIdFromHost(hostHeader: string | undefined, config: ResolvedSitesConfig): string | null {
  if (!hostHeader) {
    return null;
  }

  const host = hostHeader.split(':')[0]?.toLowerCase();
  if (!host) {
    return null;
  }

  const suffix = `.${config.domain.toLowerCase()}`;
  if (!host.endsWith(suffix)) {
    return null;
  }

  const label = host.slice(0, -suffix.length);
  const prefix = `${config.hostPrefix}-`;
  if (!label.startsWith(prefix)) {
    return null;
  }

  const siteId = label.slice(prefix.length);
  return /^[a-z0-9-]+$/.test(siteId) ? siteId : null;
}
