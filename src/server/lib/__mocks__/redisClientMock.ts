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

jest.mock('ioredis', () => {
  class RedisMock {
    options = {};
    duplicate = jest.fn(() => {
      const instance = new RedisMock();
      instance.options = {};
      return instance;
    });
    setMaxListeners = jest.fn();
    quit = jest.fn().mockResolvedValue(undefined);
    connect = jest.fn();
    on = jest.fn();
    info = jest.fn().mockResolvedValue('redis_version:6.0.5');
    hgetall = jest.fn().mockResolvedValue(null);
    hset = jest.fn().mockResolvedValue(1);
    expire = jest.fn().mockResolvedValue(1);
    hmset = jest.fn().mockResolvedValue('OK');
    disconnect = jest.fn();
  }
  return RedisMock;
});

jest.mock('redlock', () => {
  return jest.fn().mockImplementation(() => ({
    lock: jest.fn(),
    unlock: jest.fn(),
  }));
});

const mockRedisClient = () => {
  const { RedisClient } = jest.requireActual('server/lib/redisClient');
  const RedisMock = jest.requireMock('ioredis');

  class MockedRedisClient extends RedisClient {
    private static mockInstance: MockedRedisClient;

    private constructor() {
      super();
      (this as any).redis = new RedisMock();
      (this as any).subscriber = (this as any).redis.duplicate();
      (this as any).redlock = {
        lock: jest.fn(),
        unlock: jest.fn(),
      };
    }

    public static getInstance(): MockedRedisClient {
      if (!this.mockInstance) {
        this.mockInstance = new MockedRedisClient();
      }
      return this.mockInstance;
    }
  }

  return MockedRedisClient;
};

export default mockRedisClient;
