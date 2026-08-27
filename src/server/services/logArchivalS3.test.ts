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

jest.mock('shared/config', () => ({
  OBJECT_STORE_BUCKET: 'production-logs',
  OBJECT_STORE_TYPE: 's3',
}));
jest.mock('server/lib/objectStore/s3Client', () => ({ getS3Client: () => ({ send }) }));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ warn, info: jest.fn() }) }));

import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { LogArchivalService } from './logArchival';

describe('LogArchivalService with S3 storage', () => {
  it('never creates a missing S3 bucket and leaves verification retryable', async () => {
    send.mockRejectedValue({ name: 'NotFound' });
    const archival = new LogArchivalService();

    await archival.ensureBucket();
    await archival.ensureBucket();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([command]) => command instanceof HeadBucketCommand)).toBe(true);
    expect(send.mock.calls.some(([command]) => command instanceof CreateBucketCommand)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('LogArchival: bucket=production-logs not found — ensure it is pre-provisioned');
  });
});
