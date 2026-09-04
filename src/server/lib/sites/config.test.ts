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

jest.mock('shared/config', () => ({
  OBJECT_STORE_ACCESS_KEY: 'minioadmin',
  OBJECT_STORE_ENDPOINT: 'minio',
  OBJECT_STORE_PORT: '9000',
  OBJECT_STORE_REGION: 'us-west-2',
  OBJECT_STORE_SECRET_KEY: 'minioadmin',
  OBJECT_STORE_TYPE: 'minio',
  OBJECT_STORE_USE_SSL: 'false',
}));

import { buildSiteUrl, parseSiteIdFromHost, resolveSitesConfig } from './config';

describe('sites config host prefix', () => {
  it('defaults to disabled when sites config is missing', () => {
    expect(resolveSitesConfig().enabled).toBe(false);
  });

  it('uses the configured host prefix for site URLs and host parsing', () => {
    const config = resolveSitesConfig({
      domain: 'sites.example.com',
      hostPrefix: 'artifact',
    });

    expect(buildSiteUrl('abc123', config)).toBe('https://artifact-abc123.sites.example.com');
    expect(parseSiteIdFromHost('artifact-abc123.sites.example.com', config)).toBe('abc123');
    expect(parseSiteIdFromHost('site-abc123.sites.example.com', config)).toBeNull();
  });

  it('normalizes domain, port, and host prefix before building and parsing URLs', () => {
    const config = resolveSitesConfig({
      domain: 'https://*.sites.example.com:8443/assets/index.html',
      port: 'not-a-port',
      hostPrefix: ' My__Artifacts ',
    });

    expect(config).toMatchObject({
      domain: 'sites.example.com',
      port: 8443,
      hostPrefix: 'my-artifacts',
    });
    expect(buildSiteUrl('abc123', config)).toBe('https://my-artifacts-abc123.sites.example.com:8443');
    expect(parseSiteIdFromHost('MY-ARTIFACTS-ABC123.SITES.EXAMPLE.COM:8443', config)).toBe('abc123');
  });

  it('uses HTTP for localhost site URLs', () => {
    const config = resolveSitesConfig({ domain: 'http://localhost:4100' });

    expect(buildSiteUrl('local123', config)).toBe('http://site-local123.localhost:4100');
  });

  it('preserves explicit limits and falls back from blank domain and host prefix values', () => {
    const config = resolveSitesConfig({
      enabled: true,
      domain: '   ',
      port: '9443',
      hostPrefix: '***',
      ttl: {
        enabled: false,
        defaultDays: 0,
        extensionDays: 30,
      },
      upload: {
        maxUploadBytes: 1024,
        maxExtractedBytes: 4096,
        maxFiles: 0,
        allowedExtensions: ['.HTML', ' html ', '.JS', ''],
      },
      cleanup: {
        enabled: false,
        intervalMinutes: 0,
      },
    });

    expect(config).toMatchObject({
      enabled: true,
      domain: 'localhost',
      port: 9443,
      hostPrefix: 'site',
      ttl: {
        enabled: false,
        defaultDays: 0,
        extensionDays: 30,
      },
      upload: {
        maxUploadBytes: 1024,
        maxExtractedBytes: 4096,
        maxFiles: 0,
        allowedExtensions: ['html', 'js'],
      },
      cleanup: {
        enabled: false,
        intervalMinutes: 0,
      },
    });
    expect(buildSiteUrl('local123', config)).toBe('http://site-local123.localhost:9443');
  });

  it('rejects absent, malformed, foreign, and empty-site hosts', () => {
    const config = resolveSitesConfig({ domain: 'sites.example.com' });

    expect(parseSiteIdFromHost(undefined, config)).toBeNull();
    expect(parseSiteIdFromHost(':9000', config)).toBeNull();
    expect(parseSiteIdFromHost('site-abc123.other.example.com', config)).toBeNull();
    expect(parseSiteIdFromHost('site-.sites.example.com', config)).toBeNull();
  });
});

describe('sites storage configuration', () => {
  it('preserves an explicit S3-compatible endpoint and storage overrides', () => {
    const config = resolveSitesConfig({
      storage: {
        backend: 's3',
        bucket: 'team-sites',
        prefix: '/published/sites/',
        region: 'us-east-1',
        endpoint: 'https://objects.example.com',
        forcePathStyle: true,
      },
    });

    expect(config.storage).toMatchObject({
      backend: 's3',
      bucket: 'team-sites',
      prefix: 'published/sites',
      region: 'us-east-1',
      endpoint: 'https://objects.example.com',
      forcePathStyle: true,
    });
    expect(config.storage.accessKeyId).toBeUndefined();
    expect(config.storage.secretAccessKey).toBeUndefined();
  });

  it('uses the AWS SDK endpoint behavior for S3 when no endpoint is configured', () => {
    const config = resolveSitesConfig({ storage: { backend: 's3' } });

    expect(config.storage).toMatchObject({
      backend: 's3',
      endpoint: null,
      forcePathStyle: false,
    });
    expect(config.storage.accessKeyId).toBeUndefined();
    expect(config.storage.secretAccessKey).toBeUndefined();
  });
});
