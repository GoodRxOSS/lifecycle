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

type RedisEnvironment = {
  REDIS_URL?: string;
  APP_REDIS_HOST?: string;
  APP_REDIS_PORT?: string;
  APP_REDIS_PASSWORD?: string;
  APP_REDIS_TLS?: string;
};

type RedisConnectionMock = {
  options: {
    maxRetriesPerRequest: number | null;
  };
  duplicate: jest.Mock;
  setMaxListeners: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
};

type RedisConnectionSet = {
  primary: RedisConnectionMock;
  subscriber: RedisConnectionMock;
  bull: RedisConnectionMock;
};

type RedisGlobal = typeof globalThis & {
  __lifecycleRedisClient?: unknown;
};

const redisGlobal = globalThis as RedisGlobal;

const createConnection = (): RedisConnectionMock => ({
  options: { maxRetriesPerRequest: 20 },
  duplicate: jest.fn(),
  setMaxListeners: jest.fn(),
  quit: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn(),
});

const loadSubject = (environment: RedisEnvironment = {}) => {
  const connections: RedisConnectionSet[] = [];
  const redlocks: object[] = [];
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
  };
  const getLogger = jest.fn(() => logger);

  const RedisConstructor = jest.fn().mockImplementation(() => {
    const primary = createConnection();
    const subscriber = createConnection();
    const bull = createConnection();
    primary.duplicate.mockReturnValueOnce(subscriber).mockReturnValueOnce(bull);
    connections.push({ primary, subscriber, bull });
    return primary;
  });
  const RedlockConstructor = jest.fn().mockImplementation(() => {
    const redlock = {};
    redlocks.push(redlock);
    return redlock;
  });

  jest.doMock('shared/config', () => ({
    REDIS_URL: undefined,
    APP_REDIS_HOST: undefined,
    APP_REDIS_PORT: undefined,
    APP_REDIS_PASSWORD: undefined,
    APP_REDIS_TLS: undefined,
    ...environment,
  }));
  jest.doMock('ioredis', () => RedisConstructor);
  jest.doMock('redlock', () => RedlockConstructor);
  jest.doMock('server/lib/logger', () => ({ getLogger }));

  const { default: RedisClient } = require('../redisClient') as typeof import('../redisClient');

  return {
    RedisClient,
    RedisConstructor,
    RedlockConstructor,
    connections,
    redlocks,
    logger,
    getLogger,
  };
};

describe('RedisClient', () => {
  beforeEach(() => {
    delete redisGlobal.__lifecycleRedisClient;
    jest.resetModules();
  });

  afterEach(() => {
    delete redisGlobal.__lifecycleRedisClient;
  });

  it('builds and shares a host-configured singleton with its dedicated connections', () => {
    const harness = loadSubject({
      REDIS_URL: 'redis://ignored.example:6379',
      APP_REDIS_HOST: 'redis.internal',
      APP_REDIS_PORT: '6380',
      APP_REDIS_PASSWORD: 'redis-password',
      APP_REDIS_TLS: 'true',
    });

    const client = harness.RedisClient.getInstance();
    const { primary, subscriber, bull } = harness.connections[0];

    expect(harness.RedisConstructor).toHaveBeenCalledTimes(1);
    expect(harness.RedisConstructor).toHaveBeenCalledWith({
      host: 'redis.internal',
      port: 6380,
      lazyConnect: true,
      password: 'redis-password',
      tls: { rejectUnauthorized: false },
    });
    expect(primary.duplicate).toHaveBeenCalledTimes(2);
    expect(primary.duplicate).toHaveBeenNthCalledWith(1);
    expect(primary.duplicate).toHaveBeenNthCalledWith(2);
    expect(primary.setMaxListeners).toHaveBeenCalledWith(50);
    expect(subscriber.setMaxListeners).toHaveBeenCalledWith(50);
    expect(bull.setMaxListeners).toHaveBeenCalledWith(50);
    expect(bull.options.maxRetriesPerRequest).toBeNull();
    expect(harness.RedlockConstructor).toHaveBeenCalledWith([primary], {
      driftFactor: 0.01,
      retryCount: 120,
      retryDelay: 1000,
      retryJitter: 200,
    });
    expect(client.getRedis()).toBe(primary);
    expect(client.getConnection()).toBe(bull);
    expect(client.getRedlock()).toBe(harness.redlocks[0]);

    expect(harness.RedisClient.getInstance()).toBe(client);
    expect(harness.RedisConstructor).toHaveBeenCalledTimes(1);
    expect(harness.RedlockConstructor).toHaveBeenCalledTimes(1);
  });

  it('uses the default host port and omits optional authentication and TLS settings', () => {
    const harness = loadSubject({ APP_REDIS_HOST: 'redis.internal' });

    harness.RedisClient.getInstance();

    expect(harness.RedisConstructor).toHaveBeenCalledWith({
      host: 'redis.internal',
      port: 6379,
      lazyConnect: true,
    });
  });

  it('uses the Redis URL when host configuration is absent', () => {
    const harness = loadSubject({ REDIS_URL: 'redis://redis.internal:6381/2' });

    harness.RedisClient.getInstance();

    expect(harness.RedisConstructor).toHaveBeenCalledWith('redis://redis.internal:6381/2', {
      lazyConnect: true,
    });
  });

  it('rejects missing configuration without constructing dependencies or caching a singleton', () => {
    const harness = loadSubject();

    expect(() => harness.RedisClient.getInstance()).toThrow(
      'Redis configuration not found. Please provide either REDIS_URL or individual APP_REDIS_* environment variables.'
    );
    expect(harness.RedisConstructor).not.toHaveBeenCalled();
    expect(harness.RedlockConstructor).not.toHaveBeenCalled();
    expect(harness.connections).toHaveLength(0);
    expect(redisGlobal.__lifecycleRedisClient).toBeUndefined();
  });

  it('gracefully closes every connection, logs success, and releases the singleton', async () => {
    const harness = loadSubject({ REDIS_URL: 'redis://redis.internal:6379' });
    const client = harness.RedisClient.getInstance();
    const { primary, subscriber, bull } = harness.connections[0];

    await expect(client.close()).resolves.toBeUndefined();

    expect(primary.quit).toHaveBeenCalledTimes(1);
    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    expect(bull.quit).toHaveBeenCalledTimes(1);
    expect(primary.disconnect).not.toHaveBeenCalled();
    expect(subscriber.disconnect).not.toHaveBeenCalled();
    expect(bull.disconnect).not.toHaveBeenCalled();
    expect(harness.getLogger).toHaveBeenCalledTimes(1);
    expect(harness.logger.info).toHaveBeenCalledWith('Redis: closed');
    expect(harness.logger.warn).not.toHaveBeenCalled();
    expect(redisGlobal.__lifecycleRedisClient).toBeUndefined();
  });

  it('force-disconnects every connection when graceful close fails', async () => {
    const harness = loadSubject({ REDIS_URL: 'redis://redis.internal:6379' });
    const client = harness.RedisClient.getInstance();
    const { primary, subscriber, bull } = harness.connections[0];
    const closeError = new Error('Redis quit failed');
    subscriber.quit.mockRejectedValueOnce(closeError);

    await expect(client.close()).resolves.toBeUndefined();

    expect(primary.quit).toHaveBeenCalledTimes(1);
    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    expect(bull.quit).toHaveBeenCalledTimes(1);
    expect(primary.disconnect).toHaveBeenCalledTimes(1);
    expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
    expect(bull.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.logger.warn).toHaveBeenCalledWith({ error: closeError }, 'Redis: close failed forcing=true');
    expect(harness.logger.info).not.toHaveBeenCalled();
    expect(redisGlobal.__lifecycleRedisClient).toBeUndefined();
  });

  it('does not let a stale client close remove a newer singleton', async () => {
    const harness = loadSubject({ REDIS_URL: 'redis://redis.internal:6379' });
    const staleClient = harness.RedisClient.getInstance();
    await staleClient.close();
    const currentClient = harness.RedisClient.getInstance();
    const staleConnections = harness.connections[0];
    const currentConnections = harness.connections[1];
    const alreadyClosedError = new Error('Connection is already closed');
    staleConnections.primary.quit.mockRejectedValueOnce(alreadyClosedError);

    await staleClient.close();

    expect(harness.RedisClient.getInstance()).toBe(currentClient);
    expect(harness.RedisConstructor).toHaveBeenCalledTimes(2);
    expect(currentConnections.primary.quit).not.toHaveBeenCalled();
    expect(currentConnections.subscriber.quit).not.toHaveBeenCalled();
    expect(currentConnections.bull.quit).not.toHaveBeenCalled();
  });
});
