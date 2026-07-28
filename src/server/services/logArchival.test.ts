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

jest.mock('server/lib/objectStore/s3Client', () => ({ getS3Client: () => ({ send }) }));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ warn, info: jest.fn() }) }));

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { LogArchivalService } from './logArchival';

const archivedLogIdentity: [namespace: string, jobType: 'build' | 'deploy', serviceName: string, jobName: string] = [
  'env-1',
  'deploy',
  'api',
  'deploy-1',
];

describe('LogArchivalService bounded reads', () => {
  beforeEach(() => {
    send.mockReset();
    warn.mockReset();
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
