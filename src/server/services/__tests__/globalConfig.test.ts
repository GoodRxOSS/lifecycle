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
const mockMetricIncrement = jest.fn();
const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};
const mockWithLogContext = jest.fn((_context, callback) => callback());

import { Queue } from 'bullmq';
import GlobalConfigService from '../globalConfig';
import { AgentRuntimeConfigService } from '../agentRuntime/config/agentRuntimeConfig';

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
jest.mock('server/lib/metrics', () => ({
  Metrics: jest.fn().mockImplementation(() => ({ increment: mockMetricIncrement })),
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
  withLogContext: (context: unknown, callback: () => unknown) => mockWithLogContext(context, callback),
  LogStage: {
    CONFIG_REFRESH: 'config_refresh',
    CONFIG_FAILED: 'config_failed',
  },
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

function configurationStore(initialConfig?: object) {
  let stored = initialConfig;
  let tail = Promise.resolve();
  const readLocks = jest.fn();
  type TransactionState = { release?: () => void; next?: object; writes: boolean };
  const lock = async (transaction: TransactionState) => {
    if (transaction.release) return;
    const previous = tail;
    tail = new Promise((resolve) => {
      transaction.release = resolve;
    });
    await previous;
  };
  const query = (transaction?: TransactionState) => {
    let inserted;
    let locking = false;
    const builder = {
      insert: jest.fn((value) => {
        inserted = value.config;
        return builder;
      }),
      onConflict: jest.fn(() => builder),
      where: jest.fn(() => builder),
      forUpdate: jest.fn(() => {
        locking = true;
        readLocks();
        return builder;
      }),
      first: jest.fn(async () => {
        if (locking) await lock(transaction!);
        const config = transaction?.writes ? transaction.next : stored;
        return config === undefined ? undefined : { config: structuredClone(config) };
      }),
      ignore: jest.fn(async () => {
        if (stored === undefined) {
          await lock(transaction!);
          if (stored === undefined) {
            transaction!.next = structuredClone(inserted);
            transaction!.writes = true;
          }
        }
      }),
      merge: jest.fn(async () => {
        if (transaction) {
          await lock(transaction);
          transaction.next = structuredClone(inserted);
          transaction.writes = true;
        } else {
          stored = structuredClone(inserted);
        }
      }),
    };
    return builder;
  };
  const knex = Object.assign(
    jest.fn(() => query()),
    {
      transaction: jest.fn(async (callback) => {
        const state: TransactionState = { writes: false };
        try {
          const result = await callback(jest.fn(() => query(state)));
          if (state.writes) stored = state.next;
          return result;
        } finally {
          state.release?.();
        }
      }),
    }
  );
  return { knex, readLocks, read: () => stored };
}

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

    it('returns an unexpired in-memory value without reading Redis again', async () => {
      service.redis.hgetall.mockResolvedValueOnce({ key1: JSON.stringify('value1') });

      await expect(service.getAllConfigs()).resolves.toEqual({ key1: 'value1' });
      service.redis.hgetall.mockClear();

      await expect(service.getAllConfigs()).resolves.toEqual({ key1: 'value1' });
      expect(service.redis.hgetall).not.toHaveBeenCalled();
    });

    it('serializes database rows and deletes stale Redis fields during an explicit refresh', async () => {
      const from = jest.fn().mockResolvedValue([
        { key: 'features', config: { webhooks: true } },
        { key: 'orgChart', config: { name: 'lifecycle' } },
      ]);
      service.db = { knex: { select: jest.fn(() => ({ from })) } };
      service.redis.hgetall.mockResolvedValueOnce({
        features: JSON.stringify({ webhooks: false }),
        stale: JSON.stringify('remove-me'),
      });
      service.redis.hdel = jest.fn().mockResolvedValue(1);

      await expect(service.getAllConfigs(true)).resolves.toEqual({
        features: { webhooks: true },
        orgChart: { name: 'lifecycle' },
      });

      expect(service.db.knex.select).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith('global_config');
      expect(service.redis.hdel).toHaveBeenCalledWith('global_config', 'stale');
      expect(service.redis.hmset).toHaveBeenCalledWith('global_config', {
        features: JSON.stringify({ webhooks: true }),
        orgChart: JSON.stringify({ name: 'lifecycle' }),
      });
    });

    it('keeps valid cached fields and omits a corrupted JSON field', async () => {
      service.redis.hgetall.mockResolvedValueOnce({
        valid: JSON.stringify({ enabled: true }),
        corrupted: '{not-json',
      });

      await expect(service.getAllConfigs()).resolves.toEqual({ valid: { enabled: true } });

      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: expect.any(SyntaxError) },
        'Config: deserialize failed key=corrupted'
      );
    });
  });

  describe('config accessors', () => {
    it('returns the configured org chart name', async () => {
      const getAllConfigs = jest.spyOn(service, 'getAllConfigs').mockResolvedValueOnce({
        orgChart: { name: 'lifecycle-chart' },
      });

      await expect(service.getOrgChartName()).resolves.toBe('lifecycle-chart');

      getAllConfigs.mockRestore();
    });

    it.each([
      [{ webhooks: true }, 'webhooks', true],
      [{ webhooks: 0 }, 'webhooks', false],
      [{ webhooks: true }, 'missing', false],
      [undefined, 'webhooks', false],
    ])('coerces feature configuration %p for %s to %s', async (features, name, expected) => {
      const getAllConfigs = jest.spyOn(service, 'getAllConfigs').mockResolvedValueOnce({ features } as any);

      await expect(service.isFeatureEnabled(name)).resolves.toBe(expected);

      getAllConfigs.mockRestore();
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

    it('defers cache invalidation when the write belongs to a caller-owned transaction', async () => {
      const merge = jest.fn().mockResolvedValue(undefined);
      const transaction = jest.fn().mockReturnValue({
        insert: jest.fn().mockReturnValue({
          onConflict: jest.fn().mockReturnValue({ merge }),
        }),
      });
      service.memoryCache = { api_keys: { personalAuthEnabled: true } };
      service.memoryCacheExpiry = Date.now() + 10000;

      await service.setConfig('api_keys', { personalAuthEnabled: false }, transaction);

      expect(transaction).toHaveBeenCalledWith('global_config');
      expect(merge).toHaveBeenCalled();
      expect(service.redis.del).not.toHaveBeenCalled();
      expect(service.memoryCache).toEqual({ api_keys: { personalAuthEnabled: true } });
    });

    it('exposes a strict invalidation path that propagates Redis failures', async () => {
      service.memoryCache = { api_keys: { serviceAuthEnabled: true } };
      service.memoryCacheExpiry = Date.now() + 10000;
      service.redis.del.mockRejectedValueOnce(new Error('redis unavailable'));

      await expect(service.invalidateCache()).rejects.toThrow('redis unavailable');

      expect(service.memoryCache).toBeNull();
      expect(service.memoryCacheExpiry).toBe(0);
    });

    it('commits a database write even when best-effort cache invalidation fails', async () => {
      const merge = jest.fn().mockResolvedValue(undefined);
      const query = {
        insert: jest.fn().mockReturnThis(),
        onConflict: jest.fn().mockReturnThis(),
        merge,
      };
      service.db = { knex: jest.fn(() => query) };
      const cacheFailure = new Error('redis unavailable');
      const invalidateCache = jest.spyOn(service, 'invalidateCache').mockRejectedValueOnce(cacheFailure);

      await expect(service.setConfig('features', { webhooks: true })).resolves.toBeUndefined();

      expect(merge).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith({ error: cacheFailure }, 'Config: cache clear failed key=features');
      expect(mockLogger.info).toHaveBeenCalledWith('Config: set key=features');
      invalidateCache.mockRestore();
    });

    it('logs and propagates database write failures', async () => {
      const failure = new Error('database read-only');
      const query = {
        insert: jest.fn().mockReturnThis(),
        onConflict: jest.fn().mockReturnThis(),
        merge: jest.fn().mockRejectedValue(failure),
      };
      service.db = { knex: jest.fn(() => query) };

      await expect(service.setConfig('features', {})).rejects.toBe(failure);

      expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'Config: set failed key=features');
    });
  });

  describe('updateConfig', () => {
    it.each([true, false])(
      'preserves simultaneous approval and feedback updates with an existing row: %s',
      async (exists) => {
        const initial = {
          enabled: true,
          providers: [],
          maxMessagesPerSession: 50,
          sessionTTL: 3600,
          approvalPolicy: { defaultMode: 'require_approval' },
          feedbackScope: 'debug',
        };
        const store = configurationStore(exists ? initial : undefined);
        service.db = { knex: store.knex };
        const instance = jest.spyOn(GlobalConfigService, 'getInstance').mockReturnValue(service);
        const approvalWriter = new AgentRuntimeConfigService(service.db, service.redis, {} as any, {} as any);
        const feedbackWriter = new AgentRuntimeConfigService(service.db, service.redis, {} as any, {} as any);

        try {
          await Promise.all([
            approvalWriter.updateGlobalApprovalPolicy({ defaultMode: 'deny' }),
            feedbackWriter.updateGlobalFeedbackScope('all'),
          ]);

          expect(store.read()).toEqual({
            ...initial,
            ...(!exists && { enabled: false, allowedWritePatterns: ['lifecycle.yaml', 'lifecycle.yml'] }),
            approvalPolicy: { defaultMode: 'deny' },
            feedbackScope: 'all',
          });
          expect(store.readLocks).toHaveBeenCalledTimes(2);
        } finally {
          instance.mockRestore();
        }
      }
    );

    it('preserves independent sections when replacing or clearing another section', async () => {
      const store = configurationStore({
        enabled: true,
        providers: [],
        maxMessagesPerSession: 50,
        sessionTTL: 3600,
        approvalPolicy: { defaultMode: 'deny' },
        customAgentCreationPolicy: { mode: 'disabled' },
      });
      service.db = { knex: store.knex };
      const instance = jest.spyOn(GlobalConfigService, 'getInstance').mockReturnValue(service);
      const runtime = new AgentRuntimeConfigService(service.db, service.redis, {} as any, {} as any);

      try {
        await Promise.all([
          runtime.updateGlobalApprovalPolicy({}),
          runtime.updateGlobalCustomAgentCreationPolicy({ mode: 'admins_only' }),
          runtime.updateGlobalCapabilityPolicy({ availability: { workspace_shell: 'disabled' } }),
          runtime.updateGlobalFeedbackScope('all'),
        ]);

        expect(store.read()).toEqual({
          enabled: true,
          providers: [],
          maxMessagesPerSession: 50,
          sessionTTL: 3600,
          customAgentCreationPolicy: { mode: 'admins_only' },
          capabilityPolicy: { availability: { workspace_shell: 'disabled' } },
          feedbackScope: 'all',
        });
      } finally {
        instance.mockRestore();
      }
    });

    it.each([undefined, { enabled: true }])(
      'rolls back a failed transformation without invalidating cache: %p',
      async (initial) => {
        const store = configurationStore(initial);
        service.db = { knex: store.knex };
        const failure = new Error('invalid replacement');

        await expect(
          service.updateConfig('features', { enabled: false }, () => {
            throw failure;
          })
        ).rejects.toBe(failure);

        expect(store.read()).toEqual(initial);
        expect(service.redis.del).not.toHaveBeenCalled();
      }
    );

    it.each([JSON.stringify({ enabled: true }), null])(
      'normalizes a stored JSON string or null before updating: %p',
      async (stored) => {
        const store = configurationStore(stored as any);
        service.db = { knex: store.knex };

        const result = await service.updateConfig('features', { enabled: false }, (current) => ({
          ...current,
          feedback: true,
        }));

        expect(result).toEqual({ enabled: stored !== null, feedback: true });
      }
    );

    it('invalidates caches only after commit and preserves a committed update when Redis is unavailable', async () => {
      const store = configurationStore({ enabled: false });
      service.db = { knex: store.knex };
      service.memoryCache = { features: { enabled: false } };
      const cacheFailure = new Error('redis unavailable');
      service.redis.del.mockImplementationOnce(async () => {
        expect(store.read()).toEqual({ enabled: true });
        throw cacheFailure;
      });

      await expect(service.updateConfig('features', {}, () => ({ enabled: true }))).resolves.toEqual({ enabled: true });

      expect(service.memoryCache).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith({ error: cacheFailure }, 'Config: cache clear failed key=features');
    });
  });

  describe('setupCacheRefreshJob', () => {
    it('should set up a cache refresh job', async () => {
      await service.setupCacheRefreshJob();

      const mockedQueueConstructor = Queue as unknown as jest.Mock;
      const createdQueue = mockedQueueConstructor.mock.results[0]?.value as { add: jest.Mock };

      expect(createdQueue.add).toHaveBeenCalled();
    });

    it('warms both GitHub caches in development before scheduling refreshes', async () => {
      const getGithubClientToken = jest.spyOn(service, 'getGithubClientToken').mockResolvedValueOnce('token');
      const getGithubAppName = jest.spyOn(service, 'getGithubAppName').mockResolvedValueOnce('lifecycle-app');

      await service.setupCacheRefreshJob();

      expect(getGithubClientToken).toHaveBeenCalledWith(true);
      expect(getGithubAppName).toHaveBeenCalledWith(true);
      getGithubClientToken.mockRestore();
      getGithubAppName.mockRestore();
    });

    it('still schedules refreshes when the development boot warmup fails', async () => {
      const failure = new Error('GitHub unavailable');
      const getGithubClientToken = jest.spyOn(service, 'getGithubClientToken').mockRejectedValueOnce(failure);
      const getGithubAppName = jest.spyOn(service, 'getGithubAppName');

      await expect(service.setupCacheRefreshJob()).resolves.toBeUndefined();

      expect(getGithubAppName).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'Config: cache refresh failed during=boot');
      getGithubClientToken.mockRestore();
      getGithubAppName.mockRestore();
    });
  });

  describe('getGithubClientToken', () => {
    it('creates and caches an installation token after a cache miss', async () => {
      service.redis.hgetall.mockResolvedValueOnce(null);
      mockAppAuth.mockResolvedValueOnce({ token: 'installation-token' });

      await expect(service.getGithubClientToken()).resolves.toBe('installation-token');

      expect(mockAppAuth).toHaveBeenCalledWith({
        type: 'installation',
        installationId: expect.anything(),
      });
      expect(service.redis.hmset).toHaveBeenCalledWith('github_cached_client_token', {
        token: 'installation-token',
      });
    });

    it('returns a cached installation token and counts the cache hit', async () => {
      service.redis.hgetall.mockResolvedValueOnce({ token: 'cached-token' });

      await expect(service.getGithubClientToken()).resolves.toBe('cached-token');

      expect(mockAppAuth).not.toHaveBeenCalled();
      expect(mockMetricIncrement).toHaveBeenCalledWith('cache_hit');
    });

    it('refreshes an installation token even when a cached token exists', async () => {
      service.redis.hgetall.mockResolvedValueOnce({ token: 'stale-token' });
      mockAppAuth.mockResolvedValueOnce({ token: 'fresh-token' });

      await expect(service.getGithubClientToken(true)).resolves.toBe('fresh-token');

      expect(service.redis.hmset).toHaveBeenCalledWith('github_cached_client_token', { token: 'fresh-token' });
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
    it('returns a trimmed cached app name without contacting GitHub', async () => {
      service.redis.hgetall.mockResolvedValueOnce({ name: '  Cached Lifecycle App  ' });

      await expect(service.getGithubAppName()).resolves.toBe('Cached Lifecycle App');

      expect(mockAppAuth).not.toHaveBeenCalled();
      expect(mockOctokitRequest).not.toHaveBeenCalled();
    });

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

    it('uses the GitHub app slug when the metadata name is absent', async () => {
      service.redis.hgetall.mockResolvedValueOnce({});
      mockAppAuth.mockResolvedValueOnce({ token: 'app-token' });
      mockOctokitRequest.mockResolvedValueOnce({ data: { name: '', slug: 'sample-lifecycle-app' } });

      await expect(service.getGithubAppName()).resolves.toBe('sample-lifecycle-app');

      expect(service.redis.hmset).toHaveBeenCalledWith('github_cached_app_info', {
        name: 'sample-lifecycle-app',
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

    it('returns null when GitHub metadata and configured setup metadata have no name', async () => {
      service.redis.hgetall.mockResolvedValueOnce({ name: 42 });
      mockAppAuth.mockResolvedValueOnce({ token: 'app-token' });
      mockOctokitRequest.mockResolvedValueOnce({ data: {} });
      const getAllConfigs = jest.spyOn(service, 'getAllConfigs').mockResolvedValueOnce({ app_setup: {} } as any);

      await expect(service.getGithubAppName()).resolves.toBeNull();

      expect(service.redis.hmset).not.toHaveBeenCalledWith('github_cached_app_info', expect.anything());
      getAllConfigs.mockRestore();
    });

    it('returns null and warns when the setup fallback also fails', async () => {
      const liveFailure = new Error('GitHub unavailable');
      const fallbackFailure = new Error('config unavailable');
      service.redis.hgetall.mockResolvedValueOnce({});
      mockAppAuth.mockRejectedValueOnce(liveFailure);
      const getAllConfigs = jest.spyOn(service, 'getAllConfigs').mockRejectedValueOnce(fallbackFailure);

      await expect(service.getGithubAppName()).resolves.toBeNull();

      expect(mockLogger.warn).toHaveBeenCalledWith({ error: liveFailure }, 'Config: GitHub app metadata lookup failed');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { error: fallbackFailure },
        'Config: app setup fallback lookup failed'
      );
      getAllConfigs.mockRestore();
    });
  });

  describe('processCacheRefresh', () => {
    it('refreshes every cache inside the supplied correlation context', async () => {
      const getAllConfigs = jest.spyOn(service, 'getAllConfigs').mockResolvedValueOnce({});
      const getGithubClientToken = jest.spyOn(service, 'getGithubClientToken').mockResolvedValueOnce('token');
      const getGithubAppName = jest.spyOn(service, 'getGithubAppName').mockResolvedValueOnce('app');

      await service.processCacheRefresh({ data: { correlationId: 'correlation-id' } });

      expect(mockWithLogContext).toHaveBeenCalledWith({ correlationId: 'correlation-id' }, expect.any(Function));
      expect(getAllConfigs).toHaveBeenCalledWith(true);
      expect(getGithubClientToken).toHaveBeenCalledWith(true);
      expect(getGithubAppName).toHaveBeenCalledWith(true);
      expect(mockLogger.debug).toHaveBeenCalledWith('GlobalConfig and Github cache refreshed successfully');
      getAllConfigs.mockRestore();
      getGithubClientToken.mockRestore();
      getGithubAppName.mockRestore();
    });

    it('creates a deterministic fallback correlation id and contains refresh errors', async () => {
      const failure = new Error('database unavailable');
      const now = jest.spyOn(Date, 'now').mockReturnValue(12345);
      const getAllConfigs = jest.spyOn(service, 'getAllConfigs').mockRejectedValueOnce(failure);
      const getGithubClientToken = jest.spyOn(service, 'getGithubClientToken');

      await expect(service.processCacheRefresh(undefined)).resolves.toBeUndefined();

      expect(mockWithLogContext).toHaveBeenCalledWith({ correlationId: 'cache-refresh-12345' }, expect.any(Function));
      expect(getGithubClientToken).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'Config: cache refresh failed');
      getAllConfigs.mockRestore();
      getGithubClientToken.mockRestore();
      now.mockRestore();
    });
  });

  describe('getConfig', () => {
    function setRow(row: unknown, rejection?: Error) {
      const first = rejection ? jest.fn().mockRejectedValue(rejection) : jest.fn().mockResolvedValue(row);
      const where = jest.fn(() => ({ first }));
      service.db = { knex: jest.fn(() => ({ where })) };
      return { first, where };
    }

    it('returns undefined when the key is absent', async () => {
      const { where } = setRow(undefined);

      await expect(service.getConfig('missing')).resolves.toBeUndefined();

      expect(where).toHaveBeenCalledWith({ key: 'missing' });
    });

    it.each([
      [{ config: JSON.stringify({ enabled: true }) }, { enabled: true }],
      [{ config: { enabled: false } }, { enabled: false }],
    ])('returns the stored config from row %p', async (row, expected) => {
      setRow(row);

      await expect(service.getConfig('features')).resolves.toEqual(expected);
    });

    it.each([new Error('database unavailable'), undefined])(
      'returns undefined for a failed or malformed config read',
      async (failure) => {
        if (failure) {
          setRow(undefined, failure);
        } else {
          setRow({ config: '{not-json' });
        }

        await expect(service.getConfig('features')).resolves.toBeUndefined();
      }
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });
});
