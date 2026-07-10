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

import { getLogsResult } from 'server/lib/codefresh';
import { sanitizeLogText } from '../shared/logView';

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 6;
const MAX_TOTAL_CHARS = 96_000_000;

export type CachedLogFetch =
  | { ok: true; text: string; truncatedAtSource: boolean; ageMs: number }
  | { ok: false; reason: string };

type Entry = { text: string; truncatedAtSource: boolean; fetchedAt: number };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<CachedLogFetch>>();

function evict(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt >= TTL_MS) cache.delete(key);
  }
  let totalChars = 0;
  for (const entry of cache.values()) totalChars += entry.text.length;
  for (const key of cache.keys()) {
    if (cache.size <= MAX_ENTRIES && totalChars <= MAX_TOTAL_CHARS) break;
    totalChars -= cache.get(key)!.text.length;
    cache.delete(key);
  }
}

// One bounded, sanitized copy of each pipeline's log per process; repeated agent
// calls (tail view, then search, then paging) reuse it instead of re-downloading.
export async function fetchCodefreshLogCached(pipelineId: string): Promise<CachedLogFetch> {
  const hit = cache.get(pipelineId);
  if (hit) {
    const ageMs = Date.now() - hit.fetchedAt;
    if (ageMs < TTL_MS) return { ok: true, text: hit.text, truncatedAtSource: hit.truncatedAtSource, ageMs };
    cache.delete(pipelineId);
  }

  const pending = inFlight.get(pipelineId);
  if (pending) return pending;

  const fetchPromise = (async (): Promise<CachedLogFetch> => {
    try {
      const fetched = await getLogsResult(pipelineId);
      if (fetched.ok === false) return { ok: false, reason: fetched.reason };
      const text = sanitizeLogText(fetched.output);
      cache.set(pipelineId, { text, truncatedAtSource: fetched.truncatedAtSource, fetchedAt: Date.now() });
      evict();
      return { ok: true, text, truncatedAtSource: fetched.truncatedAtSource, ageMs: 0 };
    } finally {
      inFlight.delete(pipelineId);
    }
  })();

  inFlight.set(pipelineId, fetchPromise);
  return fetchPromise;
}

export function resetCodefreshLogCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
