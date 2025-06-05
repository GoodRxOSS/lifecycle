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

import { cloneDeep, merge } from 'lodash';
import rootLogger from 'server/lib/logger';
import { GITHUB_API_CACHE_EXPIRATION_SECONDS } from 'shared/constants';
import { createOctokitClient } from 'server/lib/github/client';
import { CacheRequestData } from 'server/lib/github/types';

import { redisClient } from 'server/lib/dependencies';

const initialLogger = rootLogger.child({
  filename: 'lib/github/cacheRequest.ts',
});

export async function cacheRequest(
  endpoint: string,
  requestData = {} as CacheRequestData,
  { logger = initialLogger, cache = redisClient.getRedis(), ignoreCache = false } = {}
) {
  const cacheKey = `github:req_cache:${endpoint}`;
  const text = `[GITHUB ${cacheKey}][cacheRequest]`;
  let cached;
  try {
    const octokit = await createOctokitClient({ caller: 'cacheRequest' });
    const headers = {};
    if (!ignoreCache) {
      cached = await cache.hgetall(cacheKey);
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
    }
    const hasHeaders = Object.keys(headers).length > 0;
    const data = hasHeaders ? merge(cloneDeep(requestData), { headers }) : requestData;
    const hasData = Object.keys(data).length > 0;
    const resp = hasData ? await octokit.request(endpoint, data) : await octokit.request(endpoint);
    const respHeaders = resp?.headers;
    const respData = resp?.data;
    const stringifiedData = JSON.stringify(respData);

    await cache.hset(
      cacheKey,
      'etag',
      respHeaders?.etag || '',
      'lastModified',
      respHeaders?.['last-modified'] || '',
      'data',
      stringifiedData
    );
    await cache.expire(cacheKey, GITHUB_API_CACHE_EXPIRATION_SECONDS);

    return resp;
  } catch (error) {
    if (error?.status === 304) {
      const cachedData = cached?.data;
      try {
        if (!cachedData) throw new Error('No cached data');
        const data = JSON.parse(cached?.data);
        return { data };
      } catch (error) {
        return cacheRequest(endpoint, requestData, { logger, cache, ignoreCache: true });
      }
    } else if (error?.status === 404) {
      const msg = '[retryCacheRequest] The requested resource was not found. Maybe the branch was deleted?';
      logger.child({ error }).info(`${text} ${msg}`);
      throw new Error(error?.message || msg);
    } else {
      const msg = 'cache request request error';
      const message = error?.message || msg;
      logger.child({ error }).error(`${text} ${msg}`);
      throw new Error(message);
    }
  }
}
