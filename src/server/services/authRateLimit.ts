/**
 * Copyright 2026 GoodRx, Inc.
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

import { redisClient } from 'server/lib/dependencies';
import GlobalConfigService from 'server/services/globalConfig';
import { getLogger } from 'server/lib/logger';
import type { Principal } from 'server/lib/principal';

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;
const WINDOW_SECONDS = 60;
const REDIS_TIMEOUT_MS = 250;

// Fixed-window counter: INCR, then EXPIRE only on the create (current === 1) so the window is
// a fixed 60s from the first hit and never slides. Atomic — one server round trip.
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

type EvalCapable = {
  // eslint-disable-next-line no-unused-vars
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
};

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

async function resolveLimitPerMinute(): Promise<number> {
  const configs = await GlobalConfigService.getInstance().getAllConfigs();
  const configured = (configs as Record<string, any>)?.api_keys?.rateLimitPerMinute;
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_RATE_LIMIT_PER_MINUTE;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('redis_timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function incrementWindow(bucketKey: string): Promise<number> {
  const redis = redisClient.getRedis() as unknown as EvalCapable;
  const result = await withTimeout(
    redis.eval(FIXED_WINDOW_SCRIPT, 1, bucketKey, String(WINDOW_SECONDS)),
    REDIS_TIMEOUT_MS
  );
  return Number(result);
}

/**
 * Owner-keyed fixed-window limit for API-key requests. Sessions are unlimited (never consult Redis).
 * Redis/config errors fail OPEN: the limiter is governance, not the auth gate — availability wins.
 */
export async function checkApiKeyRateLimit(principal: Principal): Promise<RateLimitResult> {
  if (principal.authMethod !== 'api_key') {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  // Owner-keyed so a user minting N keys does not get N× quota; service keys key on their token id.
  const owner = principal.userId ?? `token:${principal.tokenId}`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowEpoch = Math.floor(nowSeconds / WINDOW_SECONDS);
  const bucketKey = `authrl:${owner}:${windowEpoch}`;

  try {
    const limit = await resolveLimitPerMinute();
    const count = await incrementWindow(bucketKey);
    if (count > limit) {
      const retryAfterSeconds = Math.max(1, (windowEpoch + 1) * WINDOW_SECONDS - nowSeconds);
      return { allowed: false, retryAfterSeconds };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    getLogger().warn(
      { error, event: 'auth.ratelimit.fail_open', principalKind: principal.kind, tokenId: principal.tokenId },
      'AuthRateLimit: limiter unavailable; failing open'
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
