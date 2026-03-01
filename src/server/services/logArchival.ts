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

import { Readable } from 'stream';
import { getMinioClient } from 'server/lib/objectStore/s3Client';
import { MINIO_BUCKET } from 'shared/config';
import { getLogger } from 'server/lib/logger';
import { ArchivedJobMetadata } from './types/logArchival';

function objectPrefix(namespace: string, jobType: 'build' | 'deploy', serviceName: string, jobName: string): string {
  return `${namespace}/${jobType}/${serviceName}/${jobName}`;
}

async function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

export class LogArchivalService {
  private bucket: string;

  constructor() {
    this.bucket = MINIO_BUCKET;
  }

  async ensureBucket(): Promise<void> {
    const client = getMinioClient();
    const exists = await client.bucketExists(this.bucket);
    if (!exists) {
      await client.makeBucket(this.bucket);
      getLogger().info(`LogArchival: created bucket=${this.bucket}`);
    }
  }

  async configureRetention(days: number): Promise<void> {
    const client = getMinioClient();
    const config = {
      Rule: [
        {
          ID: 'lifecycle-log-expiration',
          Status: 'Enabled',
          Filter: { Prefix: '' },
          Expiration: { Days: days },
        },
      ],
    };
    await client.setBucketLifecycle(this.bucket, config);
    getLogger().info(`LogArchival: set retention days=${days} bucket=${this.bucket}`);
  }

  async archiveLogs(metadata: ArchivedJobMetadata, logs: string): Promise<void> {
    const client = getMinioClient();
    const prefix = objectPrefix(metadata.namespace, metadata.jobType, metadata.serviceName, metadata.jobName);

    const logsBuffer = Buffer.from(logs, 'utf8');
    await client.putObject(this.bucket, `${prefix}/logs.txt`, logsBuffer, logsBuffer.length, {
      'Content-Type': 'text/plain',
    });

    const metaBuffer = Buffer.from(JSON.stringify(metadata, null, 2), 'utf8');
    await client.putObject(this.bucket, `${prefix}/metadata.json`, metaBuffer, metaBuffer.length, {
      'Content-Type': 'application/json',
    });

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
    const client = getMinioClient();
    const key = `${objectPrefix(namespace, jobType, serviceName, jobName)}/logs.txt`;
    try {
      const stream = await client.getObject(this.bucket, key);
      return await streamToString(stream);
    } catch (error) {
      if (error?.code === 'NoSuchKey') return null;
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
    const client = getMinioClient();
    const key = `${objectPrefix(namespace, jobType, serviceName, jobName)}/metadata.json`;
    try {
      const stream = await client.getObject(this.bucket, key);
      const text = await streamToString(stream);
      return JSON.parse(text) as ArchivedJobMetadata;
    } catch (error) {
      if (error?.code === 'NoSuchKey') return null;
      getLogger().warn({ error }, `LogArchival: failed to fetch metadata key=${key}`);
      return null;
    }
  }

  async listArchivedJobs(
    namespace: string,
    jobType: 'build' | 'deploy',
    serviceName: string
  ): Promise<ArchivedJobMetadata[]> {
    const client = getMinioClient();
    const prefix = `${namespace}/${jobType}/${serviceName}/`;
    const results: ArchivedJobMetadata[] = [];

    try {
      const stream = client.listObjectsV2(this.bucket, prefix, true);
      const keys: string[] = await new Promise((resolve, reject) => {
        const collected: string[] = [];
        stream.on('data', (obj) => {
          if (obj.name?.endsWith('/metadata.json')) {
            collected.push(obj.name);
          }
        });
        stream.on('end', () => resolve(collected));
        stream.on('error', reject);
      });

      await Promise.all(
        keys.map(async (key) => {
          try {
            const metaStream = await client.getObject(this.bucket, key);
            const text = await streamToString(metaStream);
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
