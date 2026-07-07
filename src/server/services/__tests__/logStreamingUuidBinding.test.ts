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

const mockFindOne = jest.fn();
const mockGetK8sJobStatusAndPod = jest.fn();

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    db: { models: { Build: { query: () => ({ findOne: mockFindOne }) } } },
  })),
}));
jest.mock('server/lib/logStreamingHelper', () => ({
  getK8sJobStatusAndPod: (...args: unknown[]) => mockGetK8sJobStatusAndPod(...args),
}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn() }),
}));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getAllConfigs: jest.fn().mockResolvedValue({ logArchival: { enabled: false } }) }) },
}));
jest.mock('server/services/logArchival', () => ({ getLogArchivalService: jest.fn() }));

import { LogStreamingService } from '../logStreaming';

describe('LogStreamingService UUID row binding', () => {
  it('requires the exact authorized live build before returning job information', async () => {
    const whereNull = jest.fn().mockResolvedValue({ id: 41, uuid: 'x' });
    mockFindOne.mockReturnValue({ whereNull });
    mockGetK8sJobStatusAndPod.mockResolvedValue({ status: 'NotFound', message: 'Job not found' });

    await new LogStreamingService().getLogStreamInfo('x', 'job-1', 'web', 'deploy', 41);

    expect(mockFindOne).toHaveBeenCalledWith({ uuid: 'x', id: 41 });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
  });
});
