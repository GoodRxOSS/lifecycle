/**
 * Copyright 2025 GoodRx, Inc.
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
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getS3Client } from 'server/lib/objectStore/s3Client';
import { OBJECT_STORE_BUCKET, OBJECT_STORE_TYPE } from 'shared/config';
import { getLogger } from 'server/lib/logger';
import { ArchivedJobMetadata } from './types/logArchival';

function objectPrefix(namespace: string, jobType: 'build' | 'deploy', serviceName: string, jobName: string): string {
  return `${namespace}/${jobType}/${serviceName}/${jobName}`;
}

export class LogArchivalService {
  private bucket: string;
  private bucketVerified = false;

  constructor() {
    this.bucket = OBJECT_STORE_BUCKET;
  }

  async ensureBucket(): Promise<void> {
    if (this.bucketVerified) return;
    const client = getS3Client();
    try {
      await client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.bucketVerified = true;
    } catch (error) {
      if (error?.name === 'NotFound' || error?.name === 'NoSuchBucket') {
        if (OBJECT_STORE_TYPE === 's3') {
          getLogger().warn(`LogArchival: bucket=${this.bucket} not found — ensure it is pre-provisioned`);
          return;
        }
        await client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        getLogger().info(`LogArchival: created bucket=${this.bucket}`);
        this.bucketVerified = true;
      } else {
        throw error;
      }
    }
  }

  async archiveLogs(metadata: ArchivedJobMetadata, logs: string): Promise<void> {
    await this.ensureBucket();
    const client = getS3Client();
    const prefix = objectPrefix(metadata.namespace, metadata.jobType, metadata.serviceName, metadata.jobName);

    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${prefix}/logs.txt`,
        Body: logs,
        ContentType: 'text/plain',
      })
    );

    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${prefix}/metadata.json`,
        Body: JSON.stringify(metadata, null, 2),
        ContentType: 'application/json',
      })
    );

    getLogger().info(
      `LogArchival: archived jobName=${metadata.jobName} jobType=${metadata.jobType} service=${metadata.serviceName}`
    );
  }

  async getArchivedLogs(
    namespace: string,
    jobType: 'build' | 'deploy',
    serviceName: string,
    jobName: string
  ): Promise<string | null> {
    const client = getS3Client();
    const key = `${objectPrefix(namespace, jobType, serviceName, jobName)}/logs.txt`;
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!response.Body) {
        getLogger().warn(`LogArchival: empty body for key=${key}`);
        return null;
      }
      return await response.Body.transformToString();
    } catch (error) {
      if (error?.name === 'NoSuchKey') return null;
      getLogger().warn({ error }, `LogArchival: failed to fetch logs key=${key}`);
      return null;
    }
  }

  async getArchivedMetadata(
    namespace: string,
    jobType: 'build' | 'deploy',
    serviceName: string,
    jobName: string
  ): Promise<ArchivedJobMetadata | null> {
    const client = getS3Client();
    const key = `${objectPrefix(namespace, jobType, serviceName, jobName)}/metadata.json`;
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!response.Body) {
        getLogger().warn(`LogArchival: empty body for key=${key}`);
        return null;
      }
      const text = await response.Body.transformToString();
      return JSON.parse(text) as ArchivedJobMetadata;
    } catch (error) {
      if (error?.name === 'NoSuchKey') return null;
      getLogger().warn({ error }, `LogArchival: failed to fetch metadata key=${key}`);
      return null;
    }
  }

  async listArchivedJobs(
    namespace: string,
    jobType: 'build' | 'deploy',
    serviceName: string
  ): Promise<ArchivedJobMetadata[]> {
    const client = getS3Client();
    const prefix = `${namespace}/${jobType}/${serviceName}/`;
    const results: ArchivedJobMetadata[] = [];
    const allKeys: string[] = [];

    try {
      let continuationToken: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken })
        );
        const keys = (response.Contents ?? [])
          .map((obj) => obj.Key)
          .filter((key): key is string => key?.endsWith('/metadata.json') ?? false);
        allKeys.push(...keys);
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);

      await Promise.all(
        allKeys.map(async (key) => {
          try {
            const metaResponse = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            if (!metaResponse.Body) {
              getLogger().warn(`LogArchival: empty body for key=${key}`);
              return;
            }
            const text = await metaResponse.Body.transformToString();
            results.push(JSON.parse(text) as ArchivedJobMetadata);
          } catch (err) {
            getLogger().warn({ error: err }, `LogArchival: failed to read metadata key=${key}`);
          }
        })
      );
    } catch (error) {
      getLogger().warn({ error }, `LogArchival: failed to list jobs prefix=${prefix}`);
    }

    return results;
  }
}

let _instance: LogArchivalService | null = null;

export function getLogArchivalService(): LogArchivalService {
  if (!_instance) {
    _instance = new LogArchivalService();
  }
  return _instance;
}
