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

import { GITHUB_API_CACHE_EXPIRATION_SECONDS } from 'shared/constants';
import { redisClient } from 'server/lib/dependencies';
import { createOctokitClient } from 'server/lib/github/client';
import { cacheRequest } from 'server/lib/github/cacheRequest';
import { getLogger } from 'server/lib/logger';

jest.mock('server/lib/dependencies', () => ({
  redisClient: { getRedis: jest.fn() },
}));
jest.mock('server/lib/github/client', () => ({
  createOctokitClient: jest.fn(),
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(),
}));

const cacheKeyFor = (endpoint: string) => `github:req_cache:${endpoint}`;

const createCache = () => ({
  hgetall: jest.fn().mockResolvedValue(null),
  hset: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
});

describe('cacheRequest', () => {
  let cache: ReturnType<typeof createCache>;
  let request: jest.Mock;
  let logger: {
    debug: jest.Mock;
    info: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    cache = createCache();
    request = jest.fn();
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
    };
    (redisClient.getRedis as jest.Mock).mockReturnValue(cache);
    (createOctokitClient as jest.Mock).mockResolvedValue({ request });
    (getLogger as jest.Mock).mockReturnValue(logger);
  });

  it('uses the default cache and omits an empty request payload', async () => {
    const endpoint = 'GET /repos/acme/widget';
    const response = { status: 200, headers: {}, data: { id: 17 } };
    request.mockResolvedValue(response);

    const result = await cacheRequest(endpoint);

    expect(createOctokitClient).toHaveBeenCalledWith({ caller: 'cacheRequest' });
    expect(redisClient.getRedis).toHaveBeenCalledTimes(1);
    expect(cache.hgetall).toHaveBeenCalledWith(cacheKeyFor(endpoint));
    expect(request).toHaveBeenCalledWith(endpoint);
    expect(cache.hset).toHaveBeenCalledWith(
      cacheKeyFor(endpoint),
      'etag',
      '',
      'lastModified',
      '',
      'data',
      JSON.stringify(response.data)
    );
    expect(cache.expire).toHaveBeenCalledWith(cacheKeyFor(endpoint), GITHUB_API_CACHE_EXPIRATION_SECONDS);
    expect(result).toBe(response);
  });

  it('passes request data through and caches response validators, body, and expiration', async () => {
    const endpoint = 'POST /repos/acme/widget/deployments';
    const requestData = { data: { ref: 'main' } };
    const response = {
      status: 201,
      headers: {
        etag: '"new-etag"',
        'last-modified': 'Wed, 27 Aug 2026 08:00:00 GMT',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': '1787821200',
      },
      data: { id: 91 },
    };
    request.mockResolvedValue(response);

    const result = await cacheRequest(endpoint, requestData, { cache });

    expect(redisClient.getRedis).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(endpoint, requestData);
    expect(cache.hset).toHaveBeenCalledWith(
      cacheKeyFor(endpoint),
      'etag',
      '"new-etag"',
      'lastModified',
      'Wed, 27 Aug 2026 08:00:00 GMT',
      'data',
      '{"id":91}'
    );
    expect(cache.expire).toHaveBeenCalledWith(cacheKeyFor(endpoint), GITHUB_API_CACHE_EXPIRATION_SECONDS);
    expect(getLogger).toHaveBeenCalledWith({
      endpoint,
      cacheHit: false,
      rateLimitRemaining: '4999',
      rateLimitReset: '1787821200',
    });
    expect(logger.debug).toHaveBeenCalledWith('GitHub: cache request fetched');
    expect(result).toBe(response);
  });

  it('adds both cache validators without mutating caller-provided request headers', async () => {
    const endpoint = 'GET /repos/acme/widget/contents/config';
    const requestData = {
      ref: 'main',
      headers: { 'x-github-api-version': '2022-11-28' },
    } as any;
    cache.hgetall.mockResolvedValue({
      etag: '"cached-etag"',
      lastModified: 'Tue, 26 Aug 2026 08:00:00 GMT',
      data: '{"old":true}',
    });
    request.mockResolvedValue({ headers: {}, data: { fresh: true } });

    await cacheRequest(endpoint, requestData, { cache });

    expect(request).toHaveBeenCalledWith(endpoint, {
      ref: 'main',
      headers: {
        'x-github-api-version': '2022-11-28',
        'If-None-Match': '"cached-etag"',
        'If-Modified-Since': 'Tue, 26 Aug 2026 08:00:00 GMT',
      },
    });
    expect(requestData).toEqual({
      ref: 'main',
      headers: { 'x-github-api-version': '2022-11-28' },
    });
  });

  it('returns parsed cached data without refreshing Redis when GitHub responds 304', async () => {
    const endpoint = 'GET /repos/acme/widget';
    const cachedData = { id: 17, name: 'widget' };
    cache.hgetall.mockResolvedValue({
      etag: '"cached-etag"',
      lastModified: '',
      data: JSON.stringify(cachedData),
    });
    request.mockRejectedValue(Object.assign(new Error('Not Modified'), { status: 304 }));

    const result = await cacheRequest(endpoint, {}, { cache });

    expect(request).toHaveBeenCalledWith(endpoint, {
      headers: { 'If-None-Match': '"cached-etag"' },
    });
    expect(result).toEqual({ data: cachedData, cacheHit: true });
    expect(cache.hset).not.toHaveBeenCalled();
    expect(cache.expire).not.toHaveBeenCalled();
    expect(getLogger).toHaveBeenCalledWith({ endpoint, cacheHit: true });
    expect(logger.debug).toHaveBeenCalledWith('GitHub: cache request hit');
  });

  it.each([
    { cacheState: 'missing data', cachedData: '' },
    { cacheState: 'invalid JSON', cachedData: '{not-json' },
  ])('refetches without cache validators after a 304 with $cacheState', async ({ cachedData }) => {
    const endpoint = 'POST /repos/acme/widget/deployments';
    const requestData = { data: { ref: 'main' } };
    const freshResponse = {
      status: 201,
      headers: { etag: '"fresh-etag"' },
      data: { id: 92 },
    };
    cache.hgetall.mockResolvedValue({
      etag: '"stale-etag"',
      lastModified: '',
      data: cachedData,
    });
    request
      .mockRejectedValueOnce(Object.assign(new Error('Not Modified'), { status: 304 }))
      .mockResolvedValueOnce(freshResponse);

    const result = await cacheRequest(endpoint, requestData, { cache });

    expect(createOctokitClient).toHaveBeenCalledTimes(2);
    expect(cache.hgetall).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenNthCalledWith(1, endpoint, {
      data: { ref: 'main' },
      headers: { 'If-None-Match': '"stale-etag"' },
    });
    expect(request).toHaveBeenNthCalledWith(2, endpoint, requestData);
    expect(cache.hset).toHaveBeenCalledTimes(1);
    expect(cache.expire).toHaveBeenCalledTimes(1);
    expect(result).toBe(freshResponse);
  });

  it('caches a successful no-content response as a null body', async () => {
    const endpoint = 'DELETE /repos/acme/widget/deployments/91';
    const response = { status: 204, headers: {}, data: null };
    request.mockResolvedValue(response);

    const result = await cacheRequest(endpoint, {}, { cache });

    expect(cache.hset).toHaveBeenCalledWith(cacheKeyFor(endpoint), 'etag', '', 'lastModified', '', 'data', 'null');
    expect(cache.expire).toHaveBeenCalledTimes(1);
    expect(result).toBe(response);
  });

  it('normalizes a GitHub 404 and does not cache the failed response', async () => {
    const endpoint = 'GET /repos/acme/missing';
    request.mockRejectedValue(Object.assign(new Error('provider details'), { status: 404 }));

    await expect(cacheRequest(endpoint, {}, { cache })).rejects.toThrow('Resource not found');

    expect(cache.hset).not.toHaveBeenCalled();
    expect(cache.expire).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(`GitHub: cache request not found endpoint=${endpoint}`);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    {
      source: 'response headers',
      providerError: {
        status: 403,
        response: {
          headers: {
            'x-ratelimit-remaining': '11',
            'x-ratelimit-reset': '1787821200',
          },
        },
        headers: { 'x-ratelimit-remaining': 'ignored-direct-value' },
      },
      expectedHeaders: {
        'x-ratelimit-remaining': '11',
        'x-ratelimit-reset': '1787821200',
      },
    },
    {
      source: 'direct headers',
      providerError: {
        status: 429,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1787824800',
        },
      },
      expectedHeaders: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1787824800',
      },
    },
  ])('normalizes provider failures while preserving $source', async ({ providerError, expectedHeaders }) => {
    const endpoint = 'GET /repos/acme/widget';
    request.mockRejectedValue(providerError);

    await expect(cacheRequest(endpoint, {}, { cache })).rejects.toMatchObject({
      message: 'GitHub API request failed',
      headers: expectedHeaders,
    });

    expect(getLogger).toHaveBeenCalledWith({
      error: providerError,
      endpoint,
      rateLimitRemaining: expectedHeaders['x-ratelimit-remaining'],
      rateLimitReset: expectedHeaders['x-ratelimit-reset'],
    });
    expect(logger.error).toHaveBeenCalledWith('GitHub: cache request failed');
    expect(cache.hset).not.toHaveBeenCalled();
    expect(cache.expire).not.toHaveBeenCalled();
  });

  it('normalizes client creation failures before reading or writing the cache', async () => {
    const clientError = new Error('GitHub App authentication failed');
    (createOctokitClient as jest.Mock).mockRejectedValue(clientError);

    await expect(cacheRequest('GET /user', {}, { cache })).rejects.toMatchObject({
      message: 'GitHub API request failed',
      headers: undefined,
    });

    expect(cache.hgetall).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(cache.hset).not.toHaveBeenCalled();
    expect(cache.expire).not.toHaveBeenCalled();
  });

  it('does not call GitHub or mutate Redis after a cache read failure', async () => {
    const cacheError = new Error('Redis unavailable');
    cache.hgetall.mockRejectedValue(cacheError);

    await expect(cacheRequest('GET /repos/acme/widget', {}, { cache })).rejects.toMatchObject({
      message: 'GitHub API request failed',
      headers: undefined,
    });

    expect(request).not.toHaveBeenCalled();
    expect(cache.hset).not.toHaveBeenCalled();
    expect(cache.expire).not.toHaveBeenCalled();
  });

  it('propagates a normalized error and skips expiration when caching the response fails', async () => {
    const response = { status: 200, headers: {}, data: { id: 17 } };
    request.mockResolvedValue(response);
    cache.hset.mockRejectedValue(new Error('Redis write failed'));

    await expect(cacheRequest('GET /repos/acme/widget', {}, { cache })).rejects.toMatchObject({
      message: 'GitHub API request failed',
      headers: undefined,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(cache.hset).toHaveBeenCalledTimes(1);
    expect(cache.expire).not.toHaveBeenCalled();
  });
});
