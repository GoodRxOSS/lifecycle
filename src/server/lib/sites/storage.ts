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
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import { getLogger } from 'server/lib/logger';
import type { ResolvedSitesConfig } from './config';
import type { SiteUploadFile } from './validation';

export type SitesObject = {
  body: Readable;
  contentType: string;
  contentLength?: number;
};

export class SitesObjectNotFoundError extends Error {
  statusCode = 404;
}

export class SitesStorage {
  private client: S3Client;
  private bucketVerified = false;

  constructor(private config: ResolvedSitesConfig) {
    this.client = new S3Client({
      region: config.storage.region,
      endpoint: config.storage.endpoint || undefined,
      forcePathStyle: config.storage.forcePathStyle,
      credentials:
        config.storage.accessKeyId && config.storage.secretAccessKey
          ? {
              accessKeyId: config.storage.accessKeyId,
              secretAccessKey: config.storage.secretAccessKey,
            }
          : undefined,
    });
  }

  objectKey(storagePrefix: string, filePath: string): string {
    return `${storagePrefix.replace(/\/+$/g, '')}/${filePath.replace(/^\/+/g, '')}`;
  }

  versionPrefix(siteId: string, versionId: string): string {
    return [this.config.storage.prefix, siteId, 'versions', versionId].filter(Boolean).join('/').replace(/\/+/g, '/');
  }

  sitePrefix(siteId: string): string {
    return [this.config.storage.prefix, siteId].filter(Boolean).join('/').replace(/\/+/g, '/');
  }

  async ensureBucket(): Promise<void> {
    if (this.bucketVerified) return;

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.storage.bucket }));
      this.bucketVerified = true;
    } catch (error) {
      if (this.config.storage.backend === 's3') {
        getLogger().warn(
          { error },
          `SitesStorage: bucket=${this.config.storage.bucket} not verified; ensure it is provisioned`
        );
        return;
      }

      await this.client.send(new CreateBucketCommand({ Bucket: this.config.storage.bucket }));
      this.bucketVerified = true;
    }
  }

  async putFiles(storagePrefix: string, files: SiteUploadFile[]): Promise<void> {
    await this.ensureBucket();
    const results = await Promise.allSettled(
      files.map((file) =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.config.storage.bucket,
            Key: this.objectKey(storagePrefix, file.path),
            Body: file.content,
            ContentType: file.contentType,
          })
        )
      )
    );

    const failedUpload = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failedUpload) {
      throw failedUpload.reason;
    }
  }

  async getObject(storagePrefix: string, filePath: string): Promise<SitesObject> {
    const key = this.objectKey(storagePrefix, filePath);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.storage.bucket, Key: key }));
      if (!result.Body) {
        throw new SitesObjectNotFoundError(`Object not found: ${filePath}`);
      }

      return {
        body: result.Body as Readable,
        contentType: result.ContentType || 'application/octet-stream',
        contentLength: result.ContentLength,
      };
    } catch (error) {
      if (error?.name === 'NoSuchKey' || error?.name === 'NotFound') {
        throw new SitesObjectNotFoundError(`Object not found: ${filePath}`);
      }
      throw error;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.storage.bucket,
          Prefix: `${prefix.replace(/\/+$/g, '')}/`,
          ContinuationToken: continuationToken,
        })
      );

      const objects = (result.Contents || [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key))
        .map((Key) => ({ Key }));

      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.config.storage.bucket,
            Delete: { Objects: objects, Quiet: true },
          })
        );
      }

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}
