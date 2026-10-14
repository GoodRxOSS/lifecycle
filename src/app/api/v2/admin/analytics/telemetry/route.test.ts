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
const mockGetUser = jest.fn();
const mockIdentity = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => mockIdentity(...args),
}));

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
}));
jest.mock('server/services/telemetry', () => ({
  ...jest.requireActual('server/services/telemetry'),
  __esModule: true,
  default: jest.fn(() => ({
    getStats: (...args: unknown[]) => mockGetStats(...args),
  })),
}));

import { GET } from './route';

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/v2/admin/analytics/telemetry');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: url,
  } as unknown as NextRequest;
}

const resultFixture = {
  source: 'cli',
  range: { from: '2026-06-01', to: '2026-06-30', timezone: 'UTC', interval: 'week', compare: false },
  stats: {
    usageOverTime: [{ bucket: '2026-06-01', count: 10 }],
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
      overTime: [{ bucket: '2026-06-01', count: 4 }],
    },
    versions: [{ clientVersion: '1.2.3', count: 4 }],
    platforms: [{ platform: 'darwin', count: 3 }],
  },
};

describe('GET /api/v2/admin/analytics/telemetry', () => {
  const originalAuth = process.env.ENABLE_AUTH;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'admin', realm_access: { roles: ['admin'] } });
    mockIdentity.mockReturnValue({ userId: 'admin', roles: ['admin'] });
    mockGetStats.mockResolvedValue(resultFixture);
  });
  afterEach(() => {
    if (originalAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalAuth;
  });

  it('prevents caching successful responses', async () => {
    const response = await GET(makeRequest({ source: 'cli' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('rejects unauthenticated requests before data access', async () => {
    mockIdentity.mockReturnValue(null);

    expect((await GET(makeRequest({ source: 'cli' }))).status).toBe(401);
    expect(mockGetStats).not.toHaveBeenCalled();
  });

  it('rejects non-admin requests before data access', async () => {
    mockGetUser.mockReturnValue({ sub: 'user', realm_access: { roles: ['user'] } });
    mockIdentity.mockReturnValue({ userId: 'user', roles: ['user'] });

    expect((await GET(makeRequest({ source: 'cli' }))).status).toBe(403);
    expect(mockGetStats).not.toHaveBeenCalled();
  });

  it('passes the calendar window and source through and returns the service result', async () => {
    const response = await GET(
      makeRequest({
        source: 'cli',
        from: '2026-06-01',
        to: '2026-06-30',
        timezone: 'America/New_York',
        interval: 'week',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toEqual(resultFixture);
    expect(mockGetStats).toHaveBeenCalledWith({
      source: 'cli',
      from: '2026-06-01',
      to: '2026-06-30',
      timezone: 'America/New_York',
      interval: 'week',
      compare: false,
    });
  });

  it('keeps the calendar day of full timestamps that older clients send', async () => {
    const response = await GET(
      makeRequest({ source: 'cli', from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T12:34:56.000Z' })
    );
    expect(response.status).toBe(200);
    expect(mockGetStats).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-06-01', to: '2026-06-30' }));
  });

  it('leaves the window to the service defaults with day buckets in UTC', async () => {
    const response = await GET(makeRequest({ source: 'ui' }));

    expect(response.status).toBe(200);
    expect(mockGetStats).toHaveBeenCalledWith({
      source: 'ui',
      from: undefined,
      to: undefined,
      timezone: 'UTC',
      interval: 'day',
      compare: false,
    });
  });

  it.each([
    ['missing source', {}, 'source must be cli or ui.'],
    ['invalid source', { source: 'mobile' }, 'source must be cli or ui.'],
    ['invalid from', { source: 'cli', from: 'not-a-date' }, 'from must be a calendar date in YYYY-MM-DD format.'],
    ['invalid to', { source: 'cli', to: 'not-a-date' }, 'to must be a calendar date in YYYY-MM-DD format.'],
    [
      'from after to',
      { source: 'cli', from: '2026-06-30', to: '2026-06-01' },
      'The date range must contain between 1 and 365 calendar days.',
    ],
    ['invalid interval', { source: 'cli', interval: 'month' }, 'interval must be day or week.'],
    ['unknown timezone', { source: 'cli', timezone: 'Mars/Olympus' }, 'timezone must be a supported IANA timezone.'],
  ])('rejects %s with 400', async (_name, params, message) => {
    const response = await GET(makeRequest(params as Record<string, string>));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({ code: 'invalid_query', message });
    expect(mockGetStats).not.toHaveBeenCalled();
  });
});
