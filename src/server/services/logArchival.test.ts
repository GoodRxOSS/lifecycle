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

const send = jest.fn();
const warn = jest.fn();
const info = jest.fn();

jest.mock('server/lib/objectStore/s3Client', () => ({ getS3Client: () => ({ send }) }));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ warn, info }) }));

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { ArchivedJobMetadata } from './types/logArchival';
import { getLogArchivalService, LogArchivalService } from './logArchival';

const archivedLogIdentity: [namespace: string, jobType: 'build' | 'deploy', serviceName: string, jobName: string] = [
  'env-1',
  'deploy',
  'api',
  'deploy-1',
];

const metadata: ArchivedJobMetadata = {
  namespace: 'env-1',
  jobType: 'deploy',
  serviceName: 'api',
  jobName: 'deploy-1',
  status: 'Complete',
  sha: 'abc123',
  archivedAt: '2026-08-27T00:00:00.000Z',
};

describe('LogArchivalService', () => {
  beforeEach(() => {
    send.mockReset();
    warn.mockReset();
    info.mockReset();
  });

  describe('bucket initialization', () => {
    it('verifies an existing bucket only once per service instance', async () => {
      send.mockResolvedValue({});
      const archival = new LogArchivalService();

      await archival.ensureBucket();
      await archival.ensureBucket();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
      expect((send.mock.calls[0][0] as HeadBucketCommand).input).toEqual({ Bucket: expect.any(String) });
    });

    it.each(['NotFound', 'NoSuchBucket'])('creates a missing non-S3 bucket after a %s response', async (name) => {
      send.mockRejectedValueOnce({ name }).mockResolvedValueOnce({});
      const archival = new LogArchivalService();

      await archival.ensureBucket();
      await archival.ensureBucket();

      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
      expect(send.mock.calls[1][0]).toBeInstanceOf(CreateBucketCommand);
      expect((send.mock.calls[1][0] as CreateBucketCommand).input).toEqual({ Bucket: expect.any(String) });
      expect(info).toHaveBeenCalledWith(expect.stringContaining('created bucket'));
    });

    it('propagates unexpected bucket verification failures', async () => {
      const failure = new Error('access denied');
      send.mockRejectedValue(failure);

      await expect(new LogArchivalService().ensureBucket()).rejects.toBe(failure);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it('archives logs and metadata under the same stable job prefix', async () => {
    send.mockResolvedValue({});

    await new LogArchivalService().archiveLogs(metadata, 'deployment output');

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    const logsCommand = send.mock.calls[1][0] as PutObjectCommand;
    const metadataCommand = send.mock.calls[2][0] as PutObjectCommand;
    expect(logsCommand).toBeInstanceOf(PutObjectCommand);
    expect(logsCommand.input).toMatchObject({
      Key: 'env-1/deploy/api/deploy-1/logs.txt',
      Body: 'deployment output',
      ContentType: 'text/plain',
    });
    expect(metadataCommand).toBeInstanceOf(PutObjectCommand);
    expect(metadataCommand.input).toMatchObject({
      Key: 'env-1/deploy/api/deploy-1/metadata.json',
      Body: JSON.stringify(metadata, null, 2),
      ContentType: 'application/json',
    });
  });

  describe('full object reads', () => {
    it('returns archived log text from the expected object key', async () => {
      send.mockResolvedValue({ Body: { transformToString: async () => 'archived output' } });

      await expect(new LogArchivalService().getArchivedLogs(...archivedLogIdentity)).resolves.toBe('archived output');
      expect((send.mock.calls[0][0] as GetObjectCommand).input).toMatchObject({
        Key: 'env-1/deploy/api/deploy-1/logs.txt',
      });
    });

    it('returns null for empty, missing, and unreadable log objects', async () => {
      const failure = new Error('storage unavailable');
      send
        .mockResolvedValueOnce({ Body: undefined })
        .mockRejectedValueOnce({ name: 'NoSuchKey' })
        .mockRejectedValueOnce(failure);
      const archival = new LogArchivalService();

      await expect(archival.getArchivedLogs(...archivedLogIdentity)).resolves.toBeNull();
      await expect(archival.getArchivedLogs(...archivedLogIdentity)).resolves.toBeNull();
      await expect(archival.getArchivedLogs(...archivedLogIdentity)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('empty body'));
      expect(warn).toHaveBeenCalledWith({ error: failure }, expect.stringContaining('failed to fetch logs'));
    });
  });

  describe('metadata reads', () => {
    it('parses archived metadata from the expected object key', async () => {
      send.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify(metadata) } });

      await expect(new LogArchivalService().getArchivedMetadata(...archivedLogIdentity)).resolves.toEqual(metadata);
      expect((send.mock.calls[0][0] as GetObjectCommand).input).toMatchObject({
        Key: 'env-1/deploy/api/deploy-1/metadata.json',
      });
    });

    it('returns null for empty, missing, malformed, and unreadable metadata', async () => {
      const failure = new Error('storage unavailable');
      send
        .mockResolvedValueOnce({ Body: undefined })
        .mockRejectedValueOnce({ name: 'NoSuchKey' })
        .mockResolvedValueOnce({ Body: { transformToString: async () => '{not json' } })
        .mockRejectedValueOnce(failure);
      const archival = new LogArchivalService();

      await expect(archival.getArchivedMetadata(...archivedLogIdentity)).resolves.toBeNull();
      await expect(archival.getArchivedMetadata(...archivedLogIdentity)).resolves.toBeNull();
      await expect(archival.getArchivedMetadata(...archivedLogIdentity)).resolves.toBeNull();
      await expect(archival.getArchivedMetadata(...archivedLogIdentity)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('empty body'));
      expect(warn).toHaveBeenCalledWith({ error: failure }, expect.stringContaining('failed to fetch metadata'));
    });
  });

  describe('archive listing', () => {
    it('paginates metadata keys, ignores non-metadata objects, and contains individual read failures', async () => {
      const secondMetadata = { ...metadata, jobName: 'deploy-2', sha: 'def456' };
      send.mockImplementation(async (command) => {
        if (command instanceof ListObjectsV2Command) {
          if (!command.input.ContinuationToken) {
            return {
              Contents: [
                { Key: 'env-1/deploy/api/deploy-1/metadata.json' },
                { Key: 'env-1/deploy/api/deploy-1/logs.txt' },
                { Key: undefined },
              ],
              IsTruncated: true,
              NextContinuationToken: 'next-page',
            };
          }
          return {
            Contents: [
              { Key: 'env-1/deploy/api/deploy-2/metadata.json' },
              { Key: 'env-1/deploy/api/deploy-3/metadata.json' },
            ],
            IsTruncated: false,
          };
        }

        const key = (command as GetObjectCommand).input.Key;
        if (key?.includes('deploy-1')) {
          return { Body: { transformToString: async () => JSON.stringify(metadata) } };
        }
        if (key?.includes('deploy-2')) {
          return { Body: { transformToString: async () => JSON.stringify(secondMetadata) } };
        }
        throw new Error('one corrupt archive');
      });

      await expect(new LogArchivalService().listArchivedJobs('env-1', 'deploy', 'api')).resolves.toEqual([
        metadata,
        secondMetadata,
      ]);

      const listCommands = send.mock.calls
        .map(([command]) => command)
        .filter((command) => command instanceof ListObjectsV2Command) as ListObjectsV2Command[];
      expect(listCommands).toHaveLength(2);
      expect(listCommands[0].input).toMatchObject({ Prefix: 'env-1/deploy/api/' });
      expect(listCommands[1].input).toMatchObject({ ContinuationToken: 'next-page' });
      expect(warn).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        expect.stringContaining('failed to read metadata')
      );
    });

    it('skips metadata objects with empty bodies', async () => {
      send
        .mockResolvedValueOnce({ Contents: [{ Key: 'env-1/build/api/job-1/metadata.json' }] })
        .mockResolvedValueOnce({ Body: undefined });

      await expect(new LogArchivalService().listArchivedJobs('env-1', 'build', 'api')).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('empty body'));
    });

    it('returns an empty list when storage omits contents for an empty page', async () => {
      send.mockResolvedValue({});

      await expect(new LogArchivalService().listArchivedJobs('env-1', 'build', 'api')).resolves.toEqual([]);
    });

    it('contains list failures and returns the results collected so far', async () => {
      const failure = new Error('listing denied');
      send.mockRejectedValue(failure);

      await expect(new LogArchivalService().listArchivedJobs('env-1', 'build', 'api')).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith({ error: failure }, expect.stringContaining('failed to list jobs'));
    });
  });

  it('reuses the process-level service instance', () => {
    expect(getLogArchivalService()).toBe(getLogArchivalService());
  });
});

describe('LogArchivalService bounded reads', () => {
  beforeEach(() => {
    send.mockReset();
    warn.mockReset();
    info.mockReset();
  });

  it('requests a bounded range, restores a UTF-8 boundary, and marks an earlier range as truncated', async () => {
    send.mockResolvedValue({
      Body: { transformToByteArray: async () => Buffer.from([0x80, 0x80, ...Buffer.from('é tail')]) },
      ContentRange: 'bytes 10-20/21',
    });

    await expect(new LogArchivalService().getArchivedLogsTail(...archivedLogIdentity, 7)).resolves.toEqual({
      logs: 'é tail',
      truncated: true,
    });
    const command = send.mock.calls[0][0] as GetObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: expect.any(String),
      Key: 'env-1/deploy/api/deploy-1/logs.txt',
      Range: 'bytes=-7',
    });
  });

  it('clamps a nonsensical byte limit, treats a complete range as untruncated, and returns null for absent or empty logs', async () => {
    const archival = new LogArchivalService();
    send
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => Buffer.from('x') },
      })
      .mockResolvedValueOnce({ Body: undefined })
      .mockRejectedValueOnce({ name: 'NoSuchKey' });

    await expect(archival.getArchivedLogsTail(...archivedLogIdentity, 0)).resolves.toEqual({
      logs: 'x',
      truncated: false,
    });
    expect((send.mock.calls[0][0] as GetObjectCommand).input.Range).toBe('bytes=-1');
    await expect(archival.getArchivedLogsTail(...archivedLogIdentity, 5)).resolves.toBeNull();
    await expect(archival.getArchivedLogsTail(...archivedLogIdentity, 5)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('empty body'));
  });

  it('marks a clean bounded response as truncated when its content range starts after zero', async () => {
    send.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => Buffer.from('tail') },
      ContentRange: 'bytes 10-13/14',
    });

    await expect(new LogArchivalService().getArchivedLogsTail(...archivedLogIdentity, 4)).resolves.toEqual({
      logs: 'tail',
      truncated: true,
    });
  });

  it('warns and returns null for non-not-found storage failures', async () => {
    send.mockRejectedValueOnce(new Error('storage unavailable')).mockRejectedValueOnce(undefined);
    await expect(new LogArchivalService().getArchivedLogsTail(...archivedLogIdentity, 5)).resolves.toBeNull();
    await expect(new LogArchivalService().getArchivedLogsTail(...archivedLogIdentity, 5)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.stringContaining('bounded logs')
    );
    expect(warn).toHaveBeenLastCalledWith({ error: undefined }, expect.stringContaining('bounded logs'));
  });
});
