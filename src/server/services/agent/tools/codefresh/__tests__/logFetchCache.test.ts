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

const mockGetLogsResult = jest.fn();
jest.mock('server/lib/codefresh', () => ({
  getLogsResult: (...args: any[]) => mockGetLogsResult(...args),
}));

import { fetchCodefreshLogCached, resetCodefreshLogCacheForTests } from '../logFetchCache';

describe('fetchCodefreshLogCached', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCodefreshLogCacheForTests();
  });

  it('fetches once and serves subsequent calls from the cache', async () => {
    mockGetLogsResult.mockResolvedValue({ ok: true, output: 'a\nb', truncatedAtSource: false });

    const first = await fetchCodefreshLogCached('pipe-1');
    const second = await fetchCodefreshLogCached('pipe-1');

    expect(mockGetLogsResult).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ ok: true, text: 'a\nb', ageMs: 0 });
    expect(second.ok).toBe(true);
  });

  it('sanitizes the cached text once at fetch time', async () => {
    mockGetLogsResult.mockResolvedValue({ ok: true, output: '\x1b[32mok\x1b[0m\r\nnext', truncatedAtSource: false });
    const result = await fetchCodefreshLogCached('pipe-2');
    expect(result).toMatchObject({ ok: true, text: 'ok\nnext' });
  });

  it('deduplicates concurrent fetches for the same pipeline', async () => {
    let release: (value: unknown) => void;
    mockGetLogsResult.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, output: 'x', truncatedAtSource: false });
        })
    );

    const p1 = fetchCodefreshLogCached('pipe-3');
    const p2 = fetchCodefreshLogCached('pipe-3');
    release!(undefined);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockGetLogsResult).toHaveBeenCalledTimes(1);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('does not cache failures', async () => {
    mockGetLogsResult.mockResolvedValueOnce({ ok: false, reason: 'boom' });
    mockGetLogsResult.mockResolvedValueOnce({ ok: true, output: 'later', truncatedAtSource: false });

    const first = await fetchCodefreshLogCached('pipe-4');
    const second = await fetchCodefreshLogCached('pipe-4');

    expect(first).toEqual({ ok: false, reason: 'boom' });
    expect(second).toMatchObject({ ok: true, text: 'later' });
    expect(mockGetLogsResult).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entries beyond the entry cap', async () => {
    mockGetLogsResult.mockImplementation((id: string) =>
      Promise.resolve({ ok: true, output: `logs-${id}`, truncatedAtSource: false })
    );

    for (let i = 0; i < 7; i++) {
      await fetchCodefreshLogCached(`pipe-${i}`);
    }
    expect(mockGetLogsResult).toHaveBeenCalledTimes(7);

    await fetchCodefreshLogCached('pipe-0');
    expect(mockGetLogsResult).toHaveBeenCalledTimes(8);

    await fetchCodefreshLogCached('pipe-6');
    expect(mockGetLogsResult).toHaveBeenCalledTimes(8);
  });

  it('refetches after the TTL expires', async () => {
    jest.useFakeTimers();
    try {
      mockGetLogsResult.mockResolvedValue({ ok: true, output: 'v1', truncatedAtSource: false });
      await fetchCodefreshLogCached('pipe-ttl');

      jest.advanceTimersByTime(6 * 60_000);
      mockGetLogsResult.mockResolvedValue({ ok: true, output: 'v2', truncatedAtSource: false });
      const result = await fetchCodefreshLogCached('pipe-ttl');

      expect(mockGetLogsResult).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ ok: true, text: 'v2' });
    } finally {
      jest.useRealTimers();
    }
  });
});
