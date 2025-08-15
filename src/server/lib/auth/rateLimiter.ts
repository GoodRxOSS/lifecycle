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

import { RedisClient } from '../redisClient';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

/**
 * Check and update rate limit using fixed window algorithm
 * @param keyId API key ID
 * @param limit Maximum requests per window
 * @param windowSeconds Window duration in seconds
 */
export async function checkRateLimit(keyId: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000));
  const resetAt = (windowStart + 1) * windowSeconds * 1000;

  // Redis key for this time window
  const redisKey = `ratelimit:${keyId}:${windowStart}`;

  const redis = RedisClient.getInstance();
  const client = redis.getRedis();

  // Increment counter and get new value
  const count = await client.incr(redisKey);

  // Set TTL on first request in this window
  if (count === 1) {
    await client.expire(redisKey, windowSeconds);
  }

  const remaining = Math.max(0, limit - count);
  const allowed = count <= limit;

  return {
    allowed,
    limit,
    remaining,
    resetAt,
  };
}
