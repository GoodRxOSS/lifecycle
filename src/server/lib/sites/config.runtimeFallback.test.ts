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
  OBJECT_STORE_ACCESS_KEY: 'runtime-access-key',
  OBJECT_STORE_ENDPOINT: 'objects.internal',
  OBJECT_STORE_PORT: '9443',
  OBJECT_STORE_REGION: '',
  OBJECT_STORE_SECRET_KEY: 'runtime-secret-key',
  OBJECT_STORE_TYPE: '',
  OBJECT_STORE_USE_SSL: 'true',
}));

import { resolveSitesConfig } from './config';

describe('sites runtime storage fallbacks', () => {
  it('uses TLS and stable MinIO and region defaults for empty runtime values', () => {
    expect(resolveSitesConfig().storage).toEqual({
      backend: 'minio',
      bucket: 'lifecycle-sites',
      prefix: 'sites',
      region: 'us-west-2',
      endpoint: 'https://objects.internal:9443',
      forcePathStyle: true,
      accessKeyId: 'runtime-access-key',
      secretAccessKey: 'runtime-secret-key',
    });
  });
});
