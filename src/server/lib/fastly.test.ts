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

const mockGetAllConfigs = jest.fn();
const mockLogger = { warn: jest.fn() };

jest.mock('fastly/dist/index.js', () => {
  const authenticate = jest.fn();
  const searchService = jest.fn();
  const purgeAll = jest.fn();
  return {
    ApiClient: {
      instance: {
        authenticate,
      },
    },
    ServiceApi: jest.fn(() => ({ searchService })),
    PurgeApi: jest.fn(() => ({ purgeAll })),
    __mocks: { authenticate, searchService, purgeAll },
  };
});

jest.mock('shared/config', () => ({
  FASTLY_TOKEN: 'fastly-token',
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
    })),
  },
}));

import * as FastlySdk from 'fastly/dist/index.js';
import Fastly from './fastly';

const { searchService: mockSearchService, purgeAll: mockPurgeAll } = (FastlySdk as any).__mocks as Record<
  string,
  jest.Mock
>;

function createFastly() {
  const redis = {
    get: jest.fn(),
    set: jest.fn(),
    expire: jest.fn(),
  };
  return { fastly: new Fastly(redis as any), redis };
}

describe('Fastly', () => {
  beforeEach(() => {
    mockSearchService.mockReset();
    mockPurgeAll.mockReset();
    mockGetAllConfigs.mockReset().mockResolvedValue({ domainDefaults: { http: 'lifecycle.example.com' } });
    mockLogger.warn.mockReset();
  });

  it('authenticates the SDK once with the configured token at module initialization', () => {
    let isolatedSdk: any;
    jest.isolateModules(() => {
      isolatedSdk = require('fastly/dist/index.js');
      require('./fastly');
    });

    expect(isolatedSdk.ApiClient.instance.authenticate).toHaveBeenCalledWith('fastly-token');
  });

  it.each([
    ['removes the Lifecycle subdomain', 'lifecycle.example.com', 'fastly.example.com'],
    ['preserves a base domain', 'example.net', 'fastly.example.net'],
  ])('%s', async (_name, configuredDomain, expected) => {
    mockGetAllConfigs.mockResolvedValue({ domainDefaults: { http: configuredDomain } });
    const { fastly } = createFastly();

    await expect(fastly.getFastlyUrl()).resolves.toBe(expected);
  });

  describe('getCacheKey', () => {
    it('returns no key without an environment UUID and avoids configuration I/O', async () => {
      const { fastly } = createFastly();

      await expect(fastly.getCacheKey('', 'fastly')).resolves.toBeNull();
      expect(mockGetAllConfigs).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a full Fastly service name',
        'fastly-calm-waterfall-999.fastly.example.com',
        'fastly',
        'fastly-calm-waterfall-999.fastly.example.com-id',
      ],
      ['an environment UUID', 'calm-waterfall-123', 'fastly', 'fastly-calm-waterfall-123.fastly.example.com-id'],
      ['a null service type', 'calm-waterfall-123', null, 'fastly-calm-waterfall-123.fastly.example.com-id'],
      ['the public default service type', 'calm-waterfall-123', undefined, '-calm-waterfall-123.fastly.example.com-id'],
      ['an unrecognized value', 'singleword', 'fastly', null],
    ])('derives the cache key for %s', async (_name, uuid, serviceType, expected) => {
      const { fastly } = createFastly();

      await expect(fastly.getCacheKey(uuid, serviceType as any)).resolves.toBe(expected);
    });
  });

  describe('refresh', () => {
    it('looks up the environment service and caches its id for one day', async () => {
      mockSearchService.mockResolvedValue({ id: 'service-id' });
      const { fastly, redis } = createFastly();

      await expect(fastly.refresh('calm-waterfall-123', 'fastly')).resolves.toBe('service-id');

      expect(mockSearchService).toHaveBeenCalledWith({
        name: 'fastly-calm-waterfall-123.fastly.example.com',
      });
      expect(redis.set).toHaveBeenCalledWith('fastly-calm-waterfall-123.fastly.example.com-id', 'service-id');
      expect(redis.expire).toHaveBeenCalledWith('fastly-calm-waterfall-123.fastly.example.com-id', 86400);
    });

    it('does not cache a service when the UUID cannot produce a cache key', async () => {
      mockSearchService.mockResolvedValue({ id: 'service-id' });
      const { fastly, redis } = createFastly();

      await expect(fastly.refresh('unrecognized', 'fastly')).resolves.toBeUndefined();

      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.expire).not.toHaveBeenCalled();
    });

    it.each([
      ['returns no service', undefined],
      ['rejects the lookup', new Error('fastly unavailable')],
    ])('logs and returns no id when Fastly %s', async (_name, result) => {
      if (result instanceof Error) {
        mockSearchService.mockRejectedValue(result);
      } else {
        mockSearchService.mockResolvedValue(result);
      }
      const { fastly } = createFastly();

      await expect(fastly.refresh('calm-waterfall-123', 'fastly')).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        'Fastly: lookup failed service=fastly-calm-waterfall-123.fastly.example.com'
      );
    });
  });

  describe('getFastlyServiceId', () => {
    it('returns a cached service id without refreshing', async () => {
      const { fastly, redis } = createFastly();
      redis.get.mockResolvedValue('cached-id');
      jest.spyOn(fastly, 'getCacheKey').mockResolvedValue('cache-key');
      const refresh = jest.spyOn(fastly, 'refresh');

      await expect(fastly.getFastlyServiceId('calm-waterfall-123', 'fastly')).resolves.toBe('cached-id');
      expect(redis.get).toHaveBeenCalledWith('cache-key');
      expect(refresh).not.toHaveBeenCalled();
    });

    it('refreshes an empty cache and returns the discovered id', async () => {
      const { fastly, redis } = createFastly();
      redis.get.mockResolvedValue(null);
      jest.spyOn(fastly, 'getCacheKey').mockResolvedValue('cache-key');
      const refresh = jest.spyOn(fastly, 'refresh').mockResolvedValue('fresh-id');

      await expect(fastly.getFastlyServiceId('calm-waterfall-123', 'fastly')).resolves.toBe('fresh-id');
      expect(refresh).toHaveBeenCalledWith('calm-waterfall-123', 'fastly');
    });
  });

  describe('getServiceDashboardUrl', () => {
    it('returns the Fastly management URL when the service exists', async () => {
      const { fastly } = createFastly();
      jest.spyOn(fastly, 'getFastlyServiceId').mockResolvedValue('service-id');

      const result = await fastly.getServiceDashboardUrl('calm-waterfall-123', 'fastly');

      expect(result).toEqual(new URL('https://manage.fastly.com/configure/services/service-id'));
    });

    it('returns null when no service can be found', async () => {
      const { fastly, redis } = createFastly();
      redis.get.mockResolvedValue(null);
      mockSearchService.mockResolvedValue(undefined);

      await expect(fastly.getServiceDashboardUrl('calm-waterfall-123', 'fastly')).resolves.toBeNull();
    });
  });

  describe('purgeAllServiceCache', () => {
    it('purges every cached object for the service', async () => {
      mockPurgeAll.mockResolvedValue(undefined);
      const { fastly } = createFastly();

      await fastly.purgeAllServiceCache('service-id', 'calm-waterfall-123', 'fastly');

      expect(mockPurgeAll).toHaveBeenCalledWith({ service_id: 'service-id' });
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it.each([
      ['the service id is missing', null, undefined],
      ['Fastly rejects the purge', 'service-id', new Error('purge unavailable')],
    ])('logs without rejecting when %s', async (_name, serviceId, failure) => {
      if (failure) mockPurgeAll.mockRejectedValue(failure);
      const { fastly } = createFastly();

      await expect(
        fastly.purgeAllServiceCache(serviceId as any, 'calm-waterfall-123', 'fastly')
      ).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        `Fastly: purge failed serviceId=${serviceId} type=fastly`
      );
    });
  });
});
