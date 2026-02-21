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

import * as k8s from '@kubernetes/client-node';

const mockReadRuntimeClass = jest.fn();

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({
        readRuntimeClass: mockReadRuntimeClass,
      }),
    })),
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { isGvisorAvailable, resetGvisorCache } from '../gvisorCheck';

describe('isGvisorAvailable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetGvisorCache();
  });

  it('returns true when RuntimeClass exists', async () => {
    mockReadRuntimeClass.mockResolvedValue({ metadata: { name: 'gvisor' } });
    const result = await isGvisorAvailable();
    expect(result).toBe(true);
    expect(mockReadRuntimeClass).toHaveBeenCalledWith('gvisor');
  });

  it('returns false when RuntimeClass returns 404', async () => {
    const error = new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404);
    mockReadRuntimeClass.mockRejectedValue(error);
    const result = await isGvisorAvailable();
    expect(result).toBe(false);
  });

  it('returns false and logs warning on other errors', async () => {
    mockReadRuntimeClass.mockRejectedValue(new Error('connection refused'));
    const result = await isGvisorAvailable();
    expect(result).toBe(false);
  });

  it('caches results within TTL', async () => {
    mockReadRuntimeClass.mockResolvedValue({ metadata: { name: 'gvisor' } });
    await isGvisorAvailable();
    await isGvisorAvailable();
    expect(mockReadRuntimeClass).toHaveBeenCalledTimes(1);
  });
});
