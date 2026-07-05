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

import { NextRequest } from 'next/server';

const mockGetStats = jest.fn();

jest.mock('server/services/telemetry', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getStats: (...args: unknown[]) => mockGetStats(...args),
  })),
}));

import { GET } from './route';

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/v2/telemetry/stats');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: url,
  } as unknown as NextRequest;
}

const statsFixture = {
  usageOverTime: [{ bucket: '2026-06-01T00:00:00.000Z', count: 10 }],
  topEvents: [
    {
      event: 'builds list',
      count: 10,
      errorCount: 1,
      errorRate: 0.1,
      p50DurationMs: 120,
      p95DurationMs: 900,
    },
  ],
  activeClients: {
    total: 4,
    overTime: [{ bucket: '2026-06-01T00:00:00.000Z', count: 4 }],
  },
  versions: [{ clientVersion: '1.2.3', count: 4 }],
  platforms: [{ platform: 'darwin', count: 3 }],
};

describe('GET /api/v2/telemetry/stats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStats.mockResolvedValue(statsFixture);
  });

  it('returns stats for a valid query', async () => {
    const response = await GET(
      makeRequest({
        source: 'cli',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-30T00:00:00.000Z',
        interval: 'week',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data.range).toEqual({
      source: 'cli',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T00:00:00.000Z',
      interval: 'week',
    });
    expect(body.data.stats).toEqual(statsFixture);
    expect(mockGetStats).toHaveBeenCalledWith({
      source: 'cli',
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-06-30T00:00:00.000Z'),
      interval: 'week',
    });
  });

  it('defaults to the last 30 days with day interval', async () => {
    const response = await GET(makeRequest({ source: 'ui' }));

    expect(response.status).toBe(200);
    const query = mockGetStats.mock.calls[0][0];
    expect(query.source).toBe('ui');
    expect(query.interval).toBe('day');
    const rangeMs = query.to.getTime() - query.from.getTime();
    expect(rangeMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it.each([
    ['missing source', {}],
    ['invalid source', { source: 'mobile' }],
    ['invalid from', { source: 'cli', from: 'not-a-date' }],
    ['invalid to', { source: 'cli', to: 'not-a-date' }],
    ['from after to', { source: 'cli', from: '2026-06-30T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' }],
    ['invalid interval', { source: 'cli', interval: 'month' }],
  ])('rejects %s with 400', async (_name, params) => {
    const response = await GET(makeRequest(params as Record<string, string>));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Validation failed');
    expect(mockGetStats).not.toHaveBeenCalled();
  });
});
