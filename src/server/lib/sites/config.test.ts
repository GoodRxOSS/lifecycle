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
});
