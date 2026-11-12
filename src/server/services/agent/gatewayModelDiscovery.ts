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

import { createHash } from 'crypto';
import { getLogger } from 'server/lib/logger';

const CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_RETRY_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 5000;

type CacheEntry = {
  modelIds: string[] | null;
  expiresAt: number;
  pending?: Promise<string[] | null>;
};

const cache = new Map<string, CacheEntry>();

function getCacheKey(baseUrl: string, apiKey: string): string {
  const keyFingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return `${baseUrl.replace(/\/+$/, '')}|${keyFingerprint}`;
}

function parseModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new Error('response has no data array');
  }

  const ids = data
    .map((entry) => (entry as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim());

  if (ids.length === 0) {
    throw new Error('response lists no models');
  }

  // Endpoints don't guarantee list order, and the first model becomes the default when none is pinned.
  return [...new Set(ids)].sort();
}

async function fetchModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }

  return parseModelIds(await response.json());
}

/**
 * Lists the model ids an OpenAI-compatible endpoint exposes to `apiKey`. Returns the last
 * successful result when a refresh fails, and null when no request has ever succeeded.
 */
export async function discoverEndpointModelIds({
  baseUrl,
  apiKey,
}: {
  baseUrl: string;
  apiKey: string;
}): Promise<string[] | null> {
  const cacheKey = getCacheKey(baseUrl, apiKey);
  const now = Date.now();
  const entry = cache.get(cacheKey);

  if (entry && now < entry.expiresAt) {
    return entry.modelIds;
  }

  if (entry?.pending) {
    return entry.pending;
  }

  const lastKnown = entry?.modelIds ?? null;
  const pending = fetchModelIds(baseUrl, apiKey)
    .then((modelIds) => {
      cache.set(cacheKey, { modelIds, expiresAt: Date.now() + CACHE_TTL_MS });
      return modelIds;
    })
    .catch((error) => {
      getLogger().warn(
        { error: error instanceof Error ? error.message : String(error), baseUrl },
        `AgentExec: model discovery failed baseUrl=${baseUrl} usingLastKnown=${lastKnown !== null}`
      );
      cache.set(cacheKey, { modelIds: lastKnown, expiresAt: Date.now() + FAILURE_RETRY_MS });
      return lastKnown;
    });

  cache.set(cacheKey, { modelIds: lastKnown, expiresAt: 0, pending });
  return pending;
}

export function clearEndpointModelDiscoveryCache(): void {
  cache.clear();
}
