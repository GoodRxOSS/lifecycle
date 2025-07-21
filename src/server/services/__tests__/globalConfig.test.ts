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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

import GlobalConfigService from '../globalConfig';

jest.mock('redlock', () => {
  return jest.fn().mockImplementation(() => ({}));
});
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    hgetall: jest.fn(),
    hmset: jest.fn(),
  }));
});

jest.mock('server/database');
jest.mock('bull', () => {
  return jest.fn().mockImplementation(() => ({
    process: jest.fn(),
    add: jest.fn(),
  }));
});

describe('GlobalConfigService', () => {
  let service;

  beforeEach(() => {
    service = GlobalConfigService.getInstance();
  });

  describe('getAllConfigs', () => {
    it('should fetch configs from cache if they exist', async () => {
      service.redis.hgetall.mockResolvedValueOnce({
        key1: JSON.stringify('value1'),
        key2: JSON.stringify('value2'),
      });

      const result = await service.getAllConfigs();

      expect(result).toEqual({ key1: 'value1', key2: 'value2' });
    });

    it('should fetch configs from database if cache is empty', async () => {
      service.redis.hgetall.mockResolvedValueOnce({});

      const mockGetAllConfigsFromDb = jest.spyOn(service, 'getAllConfigsFromDb').mockResolvedValueOnce({
        key1: JSON.stringify('value1'),
        key2: JSON.stringify('value2'),
      });

      const result = await service.getAllConfigs();

      expect(result).toEqual({ key1: 'value1', key2: 'value2' });
      expect(mockGetAllConfigsFromDb).toHaveBeenCalled();

      mockGetAllConfigsFromDb.mockRestore(); // Clean up after the test
    });
  });

  describe('setupCacheRefreshJob', () => {
    it('should set up a cache refresh job', async () => {
      await service.setupCacheRefreshJob();

      expect(service.cacheRefreshQueue.process).toHaveBeenCalled();
      expect(service.cacheRefreshQueue.add).toHaveBeenCalled();
    });
  });

  describe('getLabels', () => {
    it('should return labels configuration from global config', async () => {
      const mockLabelsConfig = {
        deploy: ['lifecycle-deploy!', 'custom-deploy!'],
        disabled: ['lifecycle-disabled!', 'no-deploy!'],
        statusComments: ['lifecycle-status-comments!', 'show-status!'],
        defaultStatusComments: true,
        defaultControlComments: true,
      };

      const mockGetAllConfigs = jest.spyOn(service, 'getAllConfigs').mockResolvedValueOnce({
        labels: mockLabelsConfig,
      });

      const result = await service.getLabels();

      expect(result).toEqual(mockLabelsConfig);
      expect(mockGetAllConfigs).toHaveBeenCalled();

      mockGetAllConfigs.mockRestore();
    });

    it('should return fallback defaults when labels config does not exist', async () => {
      const mockGetAllConfigs = jest.spyOn(service, 'getAllConfigs').mockResolvedValueOnce({
        // no labels config
      });

      const result = await service.getLabels();

      expect(result).toEqual({
        deploy: ['lifecycle-deploy!'],
        disabled: ['lifecycle-disabled!'],
        statusComments: ['lifecycle-status-comments!'],
        defaultStatusComments: true,
        defaultControlComments: true,
      });
      expect(mockGetAllConfigs).toHaveBeenCalled();

      mockGetAllConfigs.mockRestore();
    });

    it('should return fallback defaults when getAllConfigs throws an error', async () => {
      const mockGetAllConfigs = jest.spyOn(service, 'getAllConfigs').mockRejectedValueOnce(new Error('DB error'));

      const result = await service.getLabels();

      expect(result).toEqual({
        deploy: ['lifecycle-deploy!'],
        disabled: ['lifecycle-disabled!'],
        statusComments: ['lifecycle-status-comments!'],
        defaultStatusComments: true,
        defaultControlComments: true,
      });
      expect(mockGetAllConfigs).toHaveBeenCalled();

      mockGetAllConfigs.mockRestore();
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });
});
