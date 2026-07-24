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

jest.mock('ioredis');

import Redis from 'ioredis';
import * as client from 'server/lib/github/client';
import { cacheRequest } from 'server/lib/github/cacheRequest';

jest.mock('server/lib/github/client');

describe('cacheRequest', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should retrieve data from cache on cache hit', async () => {
    const mockRedis = new Redis();
    const endpoint = '/test-endpoint';
    const cachedData = JSON.stringify({ some: 'data' });
    // assign the cache hit
    jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
      request: jest.fn().mockResolvedValue(Object.assign(new Error('Not Modified'), { status: 304 })),
    });
    // return data
    mockRedis.hgetall.mockResolvedValue(cachedData);
    await cacheRequest(endpoint, {}, { cache: mockRedis });
    expect(mockRedis.hgetall).toHaveBeenCalledTimes(1);
  });

  it('should return request data if no cache hit', async () => {
    const mockRedis = new Redis();
    const endpoint = '/test-endpoint';
    // assign the cache hit
    jest.spyOn(client, 'createOctokitClient').mockResolvedValue({
      request: jest.fn().mockResolvedValue({ headers: { etag: '123' }, data: { some: 'data' } }),
    });
    // return data
    const result = await cacheRequest(endpoint, {}, { cache: mockRedis });
    expect(mockRedis.hgetall).toHaveBeenCalledTimes(1);
    expect(mockRedis.hset).toHaveBeenCalledTimes(1);
    expect(mockRedis.expire).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ headers: { etag: '123' }, data: { some: 'data' } });
  });
});
