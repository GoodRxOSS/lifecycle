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

import { Readable } from 'stream';

const mockSend = jest.fn();
const mockWarn = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ warn: mockWarn })),
}));

import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ResolvedSitesConfig } from './config';
import { SitesObjectNotFoundError, SitesStorage } from './storage';

function config(overrides: Partial<ResolvedSitesConfig['storage']> = {}): ResolvedSitesConfig {
  return {
    enabled: true,
    domain: 'sites.example.com',
    port: null,
    hostPrefix: 'site',
    ttl: { enabled: true, defaultDays: 7, extensionDays: 7 },
    upload: { maxUploadBytes: 1024, maxExtractedBytes: 2048, maxFiles: 10, allowedExtensions: ['html'] },
    cleanup: { enabled: true, intervalMinutes: 15 },
    storage: {
      backend: 'minio',
      bucket: 'sites-bucket',
      prefix: 'sites',
      region: 'us-west-2',
      endpoint: 'http://minio:9000',
      forcePathStyle: true,
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      ...overrides,
    },
  };
}

function commands<T>(constructor: new (...args: any[]) => T): T[] {
  return mockSend.mock.calls.map(([command]) => command).filter((command) => command instanceof constructor);
}

describe('SitesStorage', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockWarn.mockReset();
    (S3Client as jest.Mock).mockClear();
  });

  it('configures the object-store client and builds normalized storage keys', () => {
    const storage = new SitesStorage(config());

    expect(S3Client).toHaveBeenCalledWith({
      region: 'us-west-2',
      endpoint: 'http://minio:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    });
    expect(storage.objectKey('sites/site-1///', '///index.html')).toBe('sites/site-1/index.html');
    expect(storage.versionPrefix('site-1', 'version-1')).toBe('sites/site-1/versions/version-1');
    expect(storage.sitePrefix('site-1')).toBe('sites/site-1');
  });

  it('omits optional endpoint and credentials for an uncredentialed S3 client', () => {
    const storage = new SitesStorage(
      config({
        backend: 's3',
        endpoint: null,
        forcePathStyle: false,
        accessKeyId: undefined,
        secretAccessKey: undefined,
        prefix: '',
      })
    );

    expect(S3Client).toHaveBeenLastCalledWith({
      region: 'us-west-2',
      endpoint: undefined,
      forcePathStyle: false,
      credentials: undefined,
    });
    expect(storage.versionPrefix('site-1', 'version-1')).toBe('site-1/versions/version-1');
    expect(storage.sitePrefix('site-1')).toBe('site-1');
    expect(storage.objectKey('prefix', 'file.html')).toBe('prefix/file.html');
  });

  it('verifies an existing bucket only once per storage instance', async () => {
    mockSend.mockResolvedValue({});
    const storage = new SitesStorage(config());

    await storage.ensureBucket();
    await storage.ensureBucket();

    expect(commands(HeadBucketCommand)).toHaveLength(1);
    expect((commands(HeadBucketCommand)[0] as HeadBucketCommand).input).toEqual({ Bucket: 'sites-bucket' });
    expect(commands(CreateBucketCommand)).toHaveLength(0);
  });

  it('creates a missing MinIO bucket and caches the successful verification', async () => {
    mockSend.mockImplementation(async (command) => {
      if (command instanceof HeadBucketCommand) throw new Error('missing bucket');
      return {};
    });
    const storage = new SitesStorage(config());

    await storage.ensureBucket();
    await storage.ensureBucket();

    expect(commands(HeadBucketCommand)).toHaveLength(1);
    expect(commands(CreateBucketCommand)).toHaveLength(1);
    expect((commands(CreateBucketCommand)[0] as CreateBucketCommand).input).toEqual({ Bucket: 'sites-bucket' });
  });

  it('leaves S3 bucket provisioning external and retries verification later', async () => {
    const headError = new Error('access denied');
    mockSend.mockRejectedValue(headError);
    const storage = new SitesStorage(config({ backend: 's3' }));

    await storage.ensureBucket();
    await storage.ensureBucket();

    expect(commands(HeadBucketCommand)).toHaveLength(2);
    expect(commands(CreateBucketCommand)).toHaveLength(0);
    expect(mockWarn).toHaveBeenCalledTimes(2);
    expect(mockWarn).toHaveBeenLastCalledWith(
      { error: headError },
      'SitesStorage: bucket=sites-bucket not verified; ensure it is provisioned'
    );
  });

  it('uploads every validated file with its key, bytes, and content type', async () => {
    mockSend.mockResolvedValue({});
    const storage = new SitesStorage(config());
    const files = [
      { path: 'index.html', content: Buffer.from('home'), sizeBytes: 4, contentType: 'text/html' },
      { path: '/assets/app.js', content: Buffer.from('app'), sizeBytes: 3, contentType: 'text/javascript' },
    ];

    await storage.putFiles('sites/site-1/versions/version-1/', files);

    expect(commands(PutObjectCommand).map((command) => command.input)).toEqual([
      {
        Bucket: 'sites-bucket',
        Key: 'sites/site-1/versions/version-1/index.html',
        Body: files[0].content,
        ContentType: 'text/html',
      },
      {
        Bucket: 'sites-bucket',
        Key: 'sites/site-1/versions/version-1/assets/app.js',
        Body: files[1].content,
        ContentType: 'text/javascript',
      },
    ]);
  });

  it('waits for all uploads and rejects with the object-store failure', async () => {
    const uploadError = new Error('put failed');
    mockSend.mockImplementation(async (command) => {
      if (command instanceof PutObjectCommand && command.input.Key?.endsWith('index.html')) throw uploadError;
      return {};
    });
    const storage = new SitesStorage(config());

    await expect(
      storage.putFiles('prefix', [
        { path: 'index.html', content: Buffer.from('home'), sizeBytes: 4, contentType: 'text/html' },
        { path: 'app.js', content: Buffer.from('app'), sizeBytes: 3, contentType: 'text/javascript' },
      ])
    ).rejects.toBe(uploadError);
    expect(commands(PutObjectCommand)).toHaveLength(2);
  });

  it('returns an object stream and preserves object metadata', async () => {
    const body = Readable.from('hello');
    mockSend.mockResolvedValue({ Body: body, ContentType: 'text/plain', ContentLength: 5 });
    const storage = new SitesStorage(config());

    await expect(storage.getObject('prefix/', '/hello.txt')).resolves.toEqual({
      body,
      contentType: 'text/plain',
      contentLength: 5,
    });
    expect((commands(GetObjectCommand)[0] as GetObjectCommand).input).toEqual({
      Bucket: 'sites-bucket',
      Key: 'prefix/hello.txt',
    });
  });

  it('uses the binary content type when object metadata omits it', async () => {
    const body = Readable.from('hello');
    mockSend.mockResolvedValue({ Body: body });

    await expect(new SitesStorage(config()).getObject('prefix', 'hello.bin')).resolves.toEqual({
      body,
      contentType: 'application/octet-stream',
      contentLength: undefined,
    });
  });

  it('reports a missing response body as an object-not-found error', async () => {
    mockSend.mockResolvedValue({ ContentType: 'text/plain' });

    await expect(new SitesStorage(config()).getObject('prefix', 'missing.txt')).rejects.toEqual(
      expect.objectContaining({
        name: 'Error',
        message: 'Object not found: missing.txt',
        statusCode: 404,
      })
    );
  });

  it.each(['NoSuchKey', 'NotFound'])('normalizes an S3 %s error to object-not-found', async (name) => {
    mockSend.mockRejectedValue(Object.assign(new Error('missing'), { name }));

    await expect(new SitesStorage(config()).getObject('prefix', 'missing.txt')).rejects.toBeInstanceOf(
      SitesObjectNotFoundError
    );
  });

  it('does not hide unrelated object-store read failures', async () => {
    const objectStoreError = new Error('object store unavailable');
    mockSend.mockRejectedValue(objectStoreError);

    await expect(new SitesStorage(config()).getObject('prefix', 'index.html')).rejects.toBe(objectStoreError);
  });

  it('forwards a non-Error object-store rejection unchanged', async () => {
    mockSend.mockRejectedValue(null);

    await expect(new SitesStorage(config()).getObject('prefix', 'index.html')).rejects.toBeNull();
  });

  it('deletes every keyed object across all listing pages', async () => {
    mockSend.mockImplementation(async (command) => {
      if (command instanceof ListObjectsV2Command && !command.input.ContinuationToken) {
        return {
          Contents: [{ Key: 'prefix/index.html' }, {}, { Key: 'prefix/app.js' }],
          IsTruncated: true,
          NextContinuationToken: 'next-page',
        };
      }
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [], IsTruncated: false };
      }
      return {};
    });
    const storage = new SitesStorage(config());

    await storage.deletePrefix('prefix///');

    expect(commands(ListObjectsV2Command).map((command) => command.input)).toEqual([
      { Bucket: 'sites-bucket', Prefix: 'prefix/', ContinuationToken: undefined },
      { Bucket: 'sites-bucket', Prefix: 'prefix/', ContinuationToken: 'next-page' },
    ]);
    expect(commands(DeleteObjectsCommand).map((command) => command.input)).toEqual([
      {
        Bucket: 'sites-bucket',
        Delete: {
          Objects: [{ Key: 'prefix/index.html' }, { Key: 'prefix/app.js' }],
          Quiet: true,
        },
      },
    ]);
  });

  it('does not issue a delete request when a prefix is empty', async () => {
    mockSend.mockResolvedValue({});

    await new SitesStorage(config()).deletePrefix('empty-prefix');

    expect(commands(ListObjectsV2Command)).toHaveLength(1);
    expect(commands(DeleteObjectsCommand)).toHaveLength(0);
  });
});
