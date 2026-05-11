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

jest.mock('shared/config', () => ({
  REDIS_URL: 'redis://localhost:6379',
  APP_REDIS_HOST: undefined,
  APP_REDIS_PORT: undefined,
  APP_REDIS_PASSWORD: undefined,
  APP_REDIS_TLS: undefined,
}));

jest.mock('ioredis', () => {
  function RedisInstance(this: any) {
    this.options = {};
    this.duplicate = jest.fn(() => new (RedisInstance as any)());
    this.setMaxListeners = jest.fn();
    this.quit = jest.fn().mockResolvedValue(undefined);
    this.disconnect = jest.fn();
  }

  return jest.fn().mockImplementation(() => new (RedisInstance as any)());
});

jest.mock('redlock', () => {
  return jest.fn().mockImplementation(() => ({}));
});

const clearRuntimeGlobals = () => {
  delete (globalThis as any).__lifecycleQueueManager;
  delete (globalThis as any).__lifecycleRedisClient;
};

describe('runtime singletons', () => {
  beforeEach(() => {
    clearRuntimeGlobals();
    jest.resetModules();
  });

  afterEach(() => {
    clearRuntimeGlobals();
  });

  it('shares QueueManager across isolated server module loads', () => {
    let first: unknown;
    let second: unknown;

    jest.isolateModules(() => {
      const QueueManager = require('../queueManager').default;
      first = QueueManager.getInstance();
    });

    jest.isolateModules(() => {
      const QueueManager = require('../queueManager').default;
      second = QueueManager.getInstance();
    });

    expect(second).toBe(first);
  });

  it('shares RedisClient across isolated server module loads', () => {
    let first: unknown;
    let second: unknown;

    jest.isolateModules(() => {
      const { RedisClient } = require('../redisClient');
      first = RedisClient.getInstance();
    });

    jest.isolateModules(() => {
      const { RedisClient } = require('../redisClient');
      second = RedisClient.getInstance();
    });

    expect(second).toBe(first);
    expect((globalThis as any).__lifecycleRedisClient).toBe(first);
  });
});
