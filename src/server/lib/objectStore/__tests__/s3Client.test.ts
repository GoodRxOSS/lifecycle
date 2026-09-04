/**
 * Copyright 2026 Lifecycle contributors
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

const mockS3Client = jest.fn().mockImplementation((config) => ({ config }));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: mockS3Client,
}));

async function loadClient(config: Record<string, string>) {
  jest.resetModules();
  jest.doMock('shared/config', () => ({
    OBJECT_STORE_ACCESS_KEY: 'access-key',
    OBJECT_STORE_ENDPOINT: 'object-store.internal',
    OBJECT_STORE_PORT: '9000',
    OBJECT_STORE_REGION: 'us-west-2',
    OBJECT_STORE_SECRET_KEY: 'secret-key',
    OBJECT_STORE_TYPE: 'minio',
    OBJECT_STORE_USE_SSL: 'false',
    ...config,
  }));
  return import('../s3Client');
}

describe('getS3Client', () => {
  beforeEach(() => {
    mockS3Client.mockClear();
  });

  afterEach(() => {
    jest.resetModules();
    jest.dontMock('shared/config');
  });

  it('uses the configured region for AWS S3 and reuses one client', async () => {
    const { getS3Client } = await loadClient({
      OBJECT_STORE_REGION: 'eu-west-1',
      OBJECT_STORE_TYPE: 's3',
    });

    const first = getS3Client();
    const second = getS3Client();

    expect(first).toBe(second);
    expect(mockS3Client).toHaveBeenCalledTimes(1);
    expect(mockS3Client).toHaveBeenCalledWith({ region: 'eu-west-1' });
  });

  it('configures an HTTP path-style client for an S3-compatible object store', async () => {
    const { getS3Client } = await loadClient({});

    expect(getS3Client()).toEqual({
      config: {
        endpoint: 'http://object-store.internal:9000',
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: {
          accessKeyId: 'access-key',
          secretAccessKey: 'secret-key',
        },
      },
    });
  });

  it('uses HTTPS for an S3-compatible store when SSL is enabled', async () => {
    const { getS3Client } = await loadClient({ OBJECT_STORE_USE_SSL: 'true' });

    getS3Client();

    expect(mockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://object-store.internal:9000' })
    );
  });
});
