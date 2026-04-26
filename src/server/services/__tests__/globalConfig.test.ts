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

const mockAppAuth = jest.fn();
const mockOctokitRequest = jest.fn();

import { Queue } from 'bullmq';
import GlobalConfigService from '../globalConfig';

jest.mock('redlock', () => {
  return jest.fn().mockImplementation(() => ({}));
});
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    hgetall: jest.fn(),
    hmset: jest.fn(),
    del: jest.fn(),
  }));
});
jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => mockAppAuth),
}));
jest.mock('@octokit/core', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    request: mockOctokitRequest,
  })),
}));

jest.mock('server/database');
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    close: jest.fn(),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    close: jest.fn(),
  })),
}));

describe('GlobalConfigService', () => {
  let service;

  beforeEach(() => {
    service = GlobalConfigService.getInstance();
    service.clearMemoryCache();
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

  describe('setConfig', () => {
    it('updates shared cache and clears the in-memory config cache after writing', async () => {
      const upsertQuery = {
        insert: jest.fn().mockReturnThis(),
        onConflict: jest.fn().mockReturnThis(),
        merge: jest.fn().mockResolvedValue(undefined),
      };
      service.db = {
        knex: jest.fn().mockReturnValue(upsertQuery),
      };
      service.memoryCache = { agentSessionDefaults: { workspaceImage: 'stale-image' } };
      service.memoryCacheExpiry = Date.now() + 10000;

      const config = { workspaceImage: 'workspace-image:v2' };
      await service.setConfig('agentSessionDefaults', config);

      expect(service.db.knex).toHaveBeenCalledWith('global_config');
      expect(upsertQuery.insert).toHaveBeenCalledWith({ key: 'agentSessionDefaults', config });
      expect(upsertQuery.onConflict).toHaveBeenCalledWith('key');
      expect(upsertQuery.merge).toHaveBeenCalledWith();
      expect(service.redis.del).toHaveBeenCalledWith('global_config');
      expect(service.memoryCache).toBeNull();
      expect(service.memoryCacheExpiry).toBe(0);
    });
  });

  describe('setupCacheRefreshJob', () => {
    it('should set up a cache refresh job', async () => {
      await service.setupCacheRefreshJob();

      const mockedQueueConstructor = Queue as unknown as jest.Mock;
      const createdQueue = mockedQueueConstructor.mock.results[0]?.value as { add: jest.Mock };

      expect(createdQueue.add).toHaveBeenCalled();
    });
  });

  describe('getLabels', () => {
    it('should return labels configuration from global config', async () => {
      const mockLabelsConfig = {
        deploy: ['lifecycle-deploy!', 'custom-deploy!'],
        disabled: ['lifecycle-disabled!', 'no-deploy!'],
        statusComments: ['lifecycle-status-comments!', 'show-status!'],
        defaultStatusComments: { enabled: true, overrides: {} },
        defaultControlComments: { enabled: true, overrides: {} },
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
        keep: ['lifecycle-keep!'],
        statusComments: ['lifecycle-status-comments!'],
        defaultStatusComments: { enabled: true, overrides: {} },
        defaultControlComments: { enabled: true, overrides: {} },
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
        keep: ['lifecycle-keep!'],
        statusComments: ['lifecycle-status-comments!'],
        defaultStatusComments: { enabled: true, overrides: {} },
        defaultControlComments: { enabled: true, overrides: {} },
      });
      expect(mockGetAllConfigs).toHaveBeenCalled();

      mockGetAllConfigs.mockRestore();
    });
  });

  describe('getGithubAppName', () => {
    it('returns the live GitHub app name when metadata lookup succeeds', async () => {
      service.redis.hgetall.mockResolvedValueOnce({});
      mockAppAuth.mockResolvedValueOnce({ token: 'app-token' });
      mockOctokitRequest.mockResolvedValueOnce({
        data: {
          name: 'Sample Lifecycle App',
          slug: 'sample-lifecycle-app',
        },
      });

      const result = await service.getGithubAppName();

      expect(result).toBe('Sample Lifecycle App');
      expect(service.redis.hmset).toHaveBeenCalledWith('github_cached_app_info', {
        name: 'Sample Lifecycle App',
      });
    });

    it('falls back to stored setup metadata when live lookup fails', async () => {
      service.redis.hgetall.mockResolvedValueOnce({});
      mockAppAuth.mockRejectedValueOnce(new Error('GitHub unavailable'));
      const mockGetAllConfigs = jest.spyOn(service, 'getAllConfigs').mockResolvedValueOnce({
        app_setup: {
          name: 'sample-lifecycle-app',
        },
      } as any);

      const result = await service.getGithubAppName();

      expect(result).toBe('sample-lifecycle-app');
      mockGetAllConfigs.mockRestore();
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });
});
