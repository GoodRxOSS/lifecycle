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

const mockGetConfig = jest.fn();
const mockSetConfig = jest.fn();

jest.mock('./globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getConfig: (...args: unknown[]) => mockGetConfig(...args),
      setConfig: (...args: unknown[]) => mockSetConfig(...args),
    })),
  },
}));

import SitesConfigService, { DEFAULT_SITES_CONFIG } from './sitesConfig';

// Exercises the (module-private) normalizer through the public read path.
async function normalizeViaGetConfig(stored: Partial<SitesConfig> | undefined): Promise<SitesConfig> {
  mockGetConfig.mockResolvedValueOnce(stored);
  return SitesConfigService.getInstance().getConfig();
}

describe('SitesConfigService normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the full default config when nothing is stored', async () => {
    const result = await normalizeViaGetConfig(undefined);
    expect(result).toEqual(DEFAULT_SITES_CONFIG);
  });

  describe('port', () => {
    it('keeps a valid in-range port', async () => {
      expect((await normalizeViaGetConfig({ port: 8080 })).port).toBe(8080);
    });

    it('coerces a numeric string port', async () => {
      expect((await normalizeViaGetConfig({ port: '8080' as unknown as number })).port).toBe(8080);
    });

    it('rejects an out-of-range port as null', async () => {
      expect((await normalizeViaGetConfig({ port: 70000 })).port).toBeNull();
    });

    it('rejects a non-positive port as null', async () => {
      expect((await normalizeViaGetConfig({ port: 0 })).port).toBeNull();
    });
  });

  describe('hostPrefix', () => {
    it('slugifies illegal characters and collapses dashes', async () => {
      expect((await normalizeViaGetConfig({ hostPrefix: 'My Site!!' })).hostPrefix).toBe('my-site');
    });

    it('strips leading and trailing dashes', async () => {
      expect((await normalizeViaGetConfig({ hostPrefix: '--preview--' })).hostPrefix).toBe('preview');
    });

    it('falls back to the default when the value normalizes to empty', async () => {
      expect((await normalizeViaGetConfig({ hostPrefix: '---' })).hostPrefix).toBe(DEFAULT_SITES_CONFIG.hostPrefix);
    });
  });

  describe('upload.allowedExtensions', () => {
    it('lowercases, strips leading dots, and de-duplicates', async () => {
      const result = await normalizeViaGetConfig({
        upload: { ...DEFAULT_SITES_CONFIG.upload!, allowedExtensions: ['.HTML', 'html', 'CSS ', '  ', '.png'] },
      });
      expect(result.upload?.allowedExtensions).toEqual(['html', 'css', 'png']);
    });

    it('falls back to defaults when the provided extension list is empty', async () => {
      const result = await normalizeViaGetConfig({
        upload: { ...DEFAULT_SITES_CONFIG.upload!, allowedExtensions: [] },
      });
      expect(result.upload?.allowedExtensions).toEqual(DEFAULT_SITES_CONFIG.upload?.allowedExtensions);
    });
  });

  describe('upload positive integers', () => {
    it('falls back to defaults for non-positive / non-integer values', async () => {
      const result = await normalizeViaGetConfig({
        upload: { ...DEFAULT_SITES_CONFIG.upload!, maxFiles: 0, maxUploadBytes: -5 },
      });
      expect(result.upload?.maxFiles).toBe(DEFAULT_SITES_CONFIG.upload?.maxFiles);
      expect(result.upload?.maxUploadBytes).toBe(DEFAULT_SITES_CONFIG.upload?.maxUploadBytes);
    });
  });

  describe('storage', () => {
    it('strips leading/trailing slashes and collapses duplicate slashes in the prefix', async () => {
      const result = await normalizeViaGetConfig({
        storage: { ...DEFAULT_SITES_CONFIG.storage!, prefix: '/sites//foo/' },
      });
      expect(result.storage?.prefix).toBe('sites/foo');
    });

    it('coerces an unknown backend to minio', async () => {
      const result = await normalizeViaGetConfig({
        storage: { ...DEFAULT_SITES_CONFIG.storage!, backend: 'weird' as unknown as 'minio' },
      });
      expect(result.storage?.backend).toBe('minio');
    });

    it('defaults forcePathStyle to true for minio when explicitly null', async () => {
      const result = await normalizeViaGetConfig({
        storage: { ...DEFAULT_SITES_CONFIG.storage!, backend: 'minio', forcePathStyle: null },
      });
      expect(result.storage?.forcePathStyle).toBe(true);
    });

    it('defaults forcePathStyle to false for s3 when explicitly null', async () => {
      const result = await normalizeViaGetConfig({
        storage: { ...DEFAULT_SITES_CONFIG.storage!, backend: 's3', forcePathStyle: null },
      });
      expect(result.storage?.forcePathStyle).toBe(false);
    });

    it('preserves an explicit forcePathStyle override', async () => {
      const result = await normalizeViaGetConfig({
        storage: { ...DEFAULT_SITES_CONFIG.storage!, backend: 'minio', forcePathStyle: false },
      });
      expect(result.storage?.forcePathStyle).toBe(false);
    });

    it('falls back to the default endpoint handling (null) when blank', async () => {
      const result = await normalizeViaGetConfig({
        storage: { ...DEFAULT_SITES_CONFIG.storage!, endpoint: '   ' },
      });
      expect(result.storage?.endpoint).toBeNull();
    });
  });

  describe('setConfig', () => {
    it('persists the normalized config under the sites key', async () => {
      mockSetConfig.mockResolvedValueOnce(undefined);
      const result = await SitesConfigService.getInstance().setConfig({
        ...DEFAULT_SITES_CONFIG,
        hostPrefix: 'My Site!!',
        port: 70000,
      });

      expect(result.hostPrefix).toBe('my-site');
      expect(result.port).toBeNull();
      expect(mockSetConfig).toHaveBeenCalledWith(
        'sites',
        expect.objectContaining({ hostPrefix: 'my-site', port: null })
      );
    });
  });
});
