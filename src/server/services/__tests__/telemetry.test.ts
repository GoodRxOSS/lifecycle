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

jest.mock('server/lib/dependencies', () => ({ defaultDb: {} }));
const mockResolveRange = jest.fn();
jest.mock('../analytics/query', () => ({
  ...jest.requireActual('../analytics/query'),
  resolveAnalyticsRange: (...args: unknown[]) => mockResolveRange(...args),
}));

import knexFactory, { type Knex } from 'knex';
import TelemetryService, { parseTelemetryStatsQuery, type TelemetryEventInput } from '../telemetry';
import type { ResolvedAnalyticsRange } from '../analytics/query';

const range: ResolvedAnalyticsRange = {
  from: '2026-08-01',
  to: '2026-08-03',
  timezone: 'America/New_York',
  fromUtc: '2026-08-01T04:00:00.000Z',
  toUtc: '2026-08-03T04:00:00.000Z',
  dates: ['2026-08-01', '2026-08-02'],
  calendarDays: 2,
  interval: 'day',
  compare: false,
  asOf: '2026-08-03T12:00:00.000Z',
  previous: null,
};

type Query = { sql: string; bindings: readonly unknown[]; method: string };
function serviceWithExecutor(execute: (query: Query) => unknown) {
  const knex = knexFactory({ client: 'pg' });
  const queries: Query[] = [];
  jest.spyOn(knex.client, 'runner').mockImplementation(
    (builder: any) =>
      ({
        run: async () => {
          const query = builder.toSQL();
          queries.push(query);
          return execute(query);
        },
      } as any)
  );
  const transaction = async (work: (trx: Knex) => Promise<unknown>) => work(knex);
  return { service: new TelemetryService({ knex: { transaction } } as any), queries };
}

const baseEvent: TelemetryEventInput = {
  source: 'cli',
  clientId: 'client-1',
  event: 'builds list',
  status: 'success',
  clientVersion: '1.2.3',
};

describe('TelemetryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRange.mockResolvedValue(range);
  });

  it('parses the source with the shared calendar window and never compares periods', () => {
    expect(
      parseTelemetryStatsQuery(new URLSearchParams('source=ui&from=2026-08-01&to=2026-08-03&compare=true'))
    ).toEqual({ source: 'ui', from: '2026-08-01', to: '2026-08-03', timezone: 'UTC', interval: 'day', compare: false });
    expect(() => parseTelemetryStatsQuery(new URLSearchParams('source=mobile'))).toThrow('source must be cli or ui.');
    expect(() => parseTelemetryStatsQuery(new URLSearchParams('source=cli&interval=month'))).toThrow();
  });

  it.each([
    ['defaults omitted attributes', baseEvent, {}],
    ['preserves supplied attributes', { ...baseEvent, attributes: { format: 'json' } }, { format: 'json' }],
  ])('%s when inserting an event', async (_name, event, expectedAttributes) => {
    const inserted = { id: 17, ...event, attributes: expectedAttributes };
    const returning = jest.fn().mockResolvedValue(inserted);
    const insert = jest.fn().mockReturnValue({ returning });
    const query = jest.fn().mockReturnValue({ insert });
    const service = new TelemetryService({ models: { TelemetryEvent: { query } } } as any);

    await expect(service.insertEvent(event as TelemetryEventInput)).resolves.toBe(inserted);
    expect(insert).toHaveBeenCalledWith({ ...event, attributes: expectedAttributes });
    expect(returning).toHaveBeenCalledWith('*');
  });

  it('aggregates one calendar window in local-day buckets and zero-fills missing days', async () => {
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('"errorCount"'))
        return [{ event: 'builds list', count: 10, errorCount: '1', p50DurationMs: '120', p95DurationMs: null }];
      if (query.method === 'first') return { count: 2 };
      if (query.sql.includes('distinct "clientId")::int as count') && query.sql.includes('AS bucket'))
        return [{ bucket: '2026-08-02', count: 2 }];
      if (query.sql.includes('"clientVersion"')) return [{ clientVersion: '1.2.3', count: 2 }];
      if (query.sql.includes('"platform"'))
        return [
          { platform: 'darwin', count: 2 },
          { platform: null, count: 1 },
        ];
      return [{ bucket: '2026-08-02', count: '7' }];
    });

    const result = await service.getStats({ source: 'cli', from: '2026-08-01', to: '2026-08-03', interval: 'day' });

    expect(mockResolveRange).toHaveBeenCalledWith(expect.anything(), {
      source: 'cli',
      from: '2026-08-01',
      to: '2026-08-03',
      interval: 'day',
      compare: false,
    });
    expect(result).toEqual({
      source: 'cli',
      range,
      stats: {
        usageOverTime: [
          { bucket: '2026-08-01', count: 0 },
          { bucket: '2026-08-02', count: 7 },
        ],
        topEvents: [
          {
            event: 'builds list',
            count: 10,
            errorCount: 1,
            errorRate: 0.1,
            p50DurationMs: 120,
            p95DurationMs: null,
          },
        ],
        activeClients: {
          total: 2,
          overTime: [
            { bucket: '2026-08-01', count: 0 },
            { bucket: '2026-08-02', count: 2 },
          ],
        },
        versions: [{ clientVersion: '1.2.3', count: 2 }],
        platforms: [
          { platform: 'darwin', count: 2 },
          { platform: null, count: 1 },
        ],
      },
    });
    const scoped = queries.filter((query) => query.sql.includes('"telemetry_events"'));
    expect(scoped).toHaveLength(6);
    for (const query of scoped) {
      expect(query.sql).toContain('"source" = ? and "createdAt" >= ? and "createdAt" < ?');
      expect(query.bindings).toEqual(expect.arrayContaining(['cli', range.fromUtc, range.toUtc]));
      expect(query.sql).not.toContain('between');
    }
    const bucketed = scoped.filter((query) => query.sql.includes('AS bucket'));
    expect(bucketed).toHaveLength(2);
    for (const query of bucketed) {
      expect(query.sql).toContain(
        `to_char(date_trunc(?, ("createdAt" AT TIME ZONE ?) + (? * interval '1 day')), 'YYYY-MM-DD') AS bucket`
      );
      expect(query.bindings.slice(0, 3)).toEqual(['day', 'America/New_York', 0]);
      expect(query.sql).toContain('group by "bucket"');
    }
    expect(scoped.find((query) => query.sql.includes('"errorCount"'))!.sql).toContain('limit ?');
  });

  it('returns zero-filled empty statistics when the window has no rows', async () => {
    const { service } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.method === 'first') return undefined;
      return [];
    });

    const result = await service.getStats({ source: 'ui', interval: 'day' });

    expect(result.stats).toEqual({
      usageOverTime: [
        { bucket: '2026-08-01', count: 0 },
        { bucket: '2026-08-02', count: 0 },
      ],
      topEvents: [],
      activeClients: {
        total: 0,
        overTime: [
          { bucket: '2026-08-01', count: 0 },
          { bucket: '2026-08-02', count: 0 },
        ],
      },
      versions: [],
      platforms: [],
    });
  });
});
