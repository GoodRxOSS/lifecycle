/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

jest.mock('server/lib/dependencies', () => ({ defaultDb: {} }));
jest.mock('server/services/globalConfig', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));

const mockResolveRange = jest.fn();
jest.mock('./query', () => ({
  ...jest.requireActual('./query'),
  resolveAnalyticsRange: (...args: unknown[]) => mockResolveRange(...args),
}));

import SitesAnalyticsService, { parseSitesAnalyticsQuery } from './SitesAnalyticsService';
import type { ResolvedAnalyticsRange } from './query';

const range: ResolvedAnalyticsRange = {
  from: '2026-03-08',
  to: '2026-03-10',
  timezone: 'UTC',
  fromUtc: '2026-03-08T00:00:00.000Z',
  toUtc: '2026-03-10T00:00:00.000Z',
  dates: ['2026-03-08', '2026-03-09'],
  calendarDays: 2,
  interval: 'day',
  compare: true,
  asOf: '2026-03-10T08:00:00.000Z',
  previous: {
    from: '2026-03-06',
    to: '2026-03-08',
    fromUtc: '2026-03-06T00:00:00.000Z',
    toUtc: '2026-03-08T00:00:00.000Z',
    dates: ['2026-03-06', '2026-03-07'],
  },
};

const config = {
  ttl: { enabled: false, defaultDays: 7, extensionDays: 7 },
  cleanup: { enabled: true, intervalMinutes: 15, deletedRetentionDays: 30 },
} as any;

function serviceWithRows(results: unknown[][]) {
  const raw = jest.fn(async (sql: string, _bindings: unknown[] = []) =>
    sql.startsWith('SET ') ? undefined : { rows: results.shift() }
  );
  const transaction = jest.fn(async (callback) => callback({ raw }));
  const service = new SitesAnalyticsService({ knex: { transaction } } as any, async () => config);
  return { service, raw };
}

describe('parseSitesAnalyticsQuery', () => {
  it('accepts the shared calendar parameters and Sites filters', () => {
    expect(
      parseSitesAnalyticsQuery(
        new URLSearchParams('from=2026-03-01&to=2026-03-08&ownerKind=service_key&visibility=private&owner=key:4')
      )
    ).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-08',
      ownerKind: 'service_key',
      visibility: 'private',
      owner: 'key:4',
    });
  });

  it.each([
    ['ownerKind=robot', 'ownerKind'],
    ['visibility=internal', 'visibility'],
    ['owner=someone', 'owner'],
    [`owner=user:${'x'.repeat(2400)}`, 'owner'],
    ['interval=month', 'interval'],
    ['owner=user:%00x', 'owner'],
  ])('rejects %s', (query, name) => {
    expect(() => parseSitesAnalyticsQuery(new URLSearchParams(query))).toThrow(name);
  });
});

describe('SitesAnalyticsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRange.mockResolvedValue(range);
  });

  it('maps aggregates, fills empty buckets, ranks publishers, and reports the TTL setting', async () => {
    const { service, raw } = serviceWithRows([
      [
        {
          row_type: 'activity',
          data: {
            period: 'current',
            bucket: null,
            grouped_bucket: 1,
            published: 3,
            updates: 2,
            publishers: 2,
            private_published: 1,
            public_published: 2,
            by_user: 2,
            by_service_key: 1,
            by_unresolved: 0,
          },
        },
        {
          row_type: 'activity',
          data: {
            period: 'current',
            bucket: '2026-03-09',
            grouped_bucket: 0,
            published: 3,
            updates: 2,
            publishers: 2,
            private_published: 1,
            public_published: 2,
          },
        },
        {
          row_type: 'activity',
          data: {
            period: 'previous',
            bucket: null,
            grouped_bucket: 1,
            published: 1,
            updates: 0,
            publishers: 1,
            private_published: 0,
            public_published: 1,
          },
        },
        {
          row_type: 'activity',
          data: {
            period: 'previous',
            bucket: '2026-03-08',
            grouped_bucket: 0,
            published: 1,
            updates: 0,
            publishers: 1,
            private_published: 0,
            public_published: 1,
          },
        },
        {
          row_type: 'publisher',
          data: {
            rank: 2,
            owner_key: 'key:4',
            label: 'docs-bot',
            owner_kind: 'service_key',
            published: 1,
            updates: 0,
            live_sites: 0,
            live_bytes: '0',
            last_activity_at: '2026-03-09T01:00:00+00:00',
            ranking_total: 2,
          },
        },
        {
          row_type: 'publisher',
          data: {
            rank: 1,
            owner_key: 'user:i|s',
            label: 'a@example.com',
            owner_kind: 'user',
            published: 2,
            updates: 2,
            live_sites: 1,
            live_bytes: '1048576',
            last_activity_at: '2026-03-09T02:00:00+00:00',
            ranking_total: 2,
          },
        },
      ],
      [
        {
          live: 4,
          expiring_soon: 1,
          no_expiry: 2,
          storage_bytes: '5000',
          live_bytes: '4000',
          restorable: 1,
          expired_recently: 3,
          purged_recently: 0,
          ended_expired: 1,
          ended_deleted: 2,
          ended_purged: 0,
          lifetime_ended: 3,
          lifetime_p50: '86400',
          lifetime_p90: null,
          bin_1_to_3d: 3,
        },
      ],
      [
        {
          restored: 1,
          audit_since: new Date('2026-01-01T00:00:00Z'),
          cohort_sites: 3,
          ext_none: 2,
          ext_one: 1,
          ext_two: 0,
          ext_three: 0,
          ext_four_or_more: 0,
        },
      ],
      [
        {
          site_id: 'abc',
          name: 'Deck',
          visibility: 'private',
          size_bytes: '2048',
          file_count: 3,
          expires_at: null,
          owner_key: 'user:i|s',
          label: 'a@example.com',
          owner_kind: 'user',
          updates: 2,
        },
      ],
      [{ owner_key: 'user:i|s', label: 'a@example.com', owner_kind: 'user', option_total: 1 }],
    ]);
    const result = await service.getSummary(parseSitesAnalyticsQuery(new URLSearchParams()));

    expect(raw).toHaveBeenCalledWith('SET LOCAL jit = off');
    expect(result.config).toEqual({ ttlEnabled: false, defaultTtlDays: 7, extensionDays: 7, deletedRetentionDays: 30 });
    expect(result.totals).toEqual({ published: 3, updates: 2, publishers: 2, private: 1, public: 2 });
    expect(result.previous).toEqual({ published: 1, updates: 0, publishers: 1, private: 0, public: 1 });
    expect(result.series).toEqual([
      {
        date: '2026-03-08',
        previousDate: '2026-03-06',
        current: { published: 0, updates: 0, publishers: 0, private: 0, public: 0 },
        previous: { published: 1, updates: 0, publishers: 1, private: 0, public: 1 },
      },
      {
        date: '2026-03-09',
        previousDate: '2026-03-07',
        current: { published: 3, updates: 2, publishers: 2, private: 1, public: 2 },
        previous: { published: 0, updates: 0, publishers: 0, private: 0, public: 0 },
      },
    ]);
    expect(result.ownerKinds).toEqual({ user: 2, service_key: 1, unresolved: 0 });
    expect(result.current).toMatchObject({ live: 4, storageBytes: 5000, liveBytes: 4000, restorable: 1 });
    expect(result.endings).toEqual({ expired: 1, deleted: 2, purged: 0, restored: 1 });
    expect(result.extensions).toEqual({ sites: 3, none: 2, one: 1, two: 0, three: 0, fourOrMore: 0 });
    expect(result.lifetime).toMatchObject({ ended: 3, medianSeconds: 86400, p90Seconds: null });
    expect(result.lifetime.bins).toHaveLength(7);
    expect(result.lifetime.bins.find((bin) => bin.bin === '1_to_3d')?.count).toBe(3);
    expect(result.publishers.items.map((item) => item.key)).toEqual(['user:i|s', 'key:4']);
    expect(result.publishers.items[0]).toMatchObject({
      liveBytes: 1048576,
      lastActivityAt: '2026-03-09T02:00:00.000Z',
    });
    expect(result.publishers).toMatchObject({ total: 2, limit: 10 });
    expect(result.largest).toEqual([
      {
        siteId: 'abc',
        name: 'Deck',
        owner: { key: 'user:i|s', label: 'a@example.com', ownerKind: 'user' },
        visibility: 'private',
        sizeBytes: 2048,
        fileCount: 3,
        updates: 2,
        expiresAt: null,
      },
    ]);
    expect(result.publisherOptions).toEqual({
      items: [{ key: 'user:i|s', label: 'a@example.com', ownerKind: 'user' }],
      total: 1,
      truncated: false,
    });
    expect(result.auditSince).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns zeros and no comparison for an empty window without comparison', async () => {
    mockResolveRange.mockResolvedValue({ ...range, compare: false, previous: null });
    const { service } = serviceWithRows([[], [], [], [], []]);
    const result = await service.getSummary({});
    expect(result.previous).toBeNull();
    expect(result.series.every((point) => point.previous === null && point.current.published === 0)).toBe(true);
    expect(result.publishers).toEqual({ items: [], total: 0, limit: 10 });
    expect(result.lifetime.medianSeconds).toBeNull();
    expect(result.auditSince).toBeNull();
  });

  it('binds every scope filter instead of interpolating it', async () => {
    const { service, raw } = serviceWithRows([[], [], [], [], []]);
    await service.getSummary({ ownerKind: 'user', visibility: 'private', owner: "user:x|'; DROP TABLE sites; --" });
    const statements = raw.mock.calls.filter(([sql]) => !String(sql).startsWith('SET '));
    for (const [sql, bindings] of statements.slice(0, 4)) {
      expect(sql).not.toContain('DROP TABLE');
      expect(bindings).toEqual(expect.arrayContaining(['user', 'private', "user:x|'; DROP TABLE sites; --"]));
      expect((sql.match(/\?/g) ?? []).length).toBe(bindings?.length);
    }
  });
});
