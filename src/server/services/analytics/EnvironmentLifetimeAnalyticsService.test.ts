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
const mockResolveRange = jest.fn();
jest.mock('./query', () => ({
  ...jest.requireActual('./query'),
  resolveAnalyticsRange: (...args: unknown[]) => mockResolveRange(...args),
}));

import knexFactory from 'knex';
import EnvironmentLifetimeAnalyticsService, {
  ENVIRONMENT_LIFETIME_BINS,
  parseEnvironmentLifetimeRecordsQuery,
  serializeEnvironmentLifetimeStats,
} from './EnvironmentLifetimeAnalyticsService';
import { parseEnvironmentAnalyticsQuery } from './EnvironmentAnalyticsService';
import type { ResolvedAnalyticsRange } from './query';

const range: ResolvedAnalyticsRange = {
  from: '2026-03-08',
  to: '2026-03-10',
  timezone: 'America/Los_Angeles',
  fromUtc: '2026-03-08T08:00:00.000Z',
  toUtc: '2026-03-10T07:00:00.000Z',
  dates: ['2026-03-08', '2026-03-09'],
  calendarDays: 2,
  interval: 'day',
  compare: true,
  asOf: '2026-03-10T08:00:00.000Z',
  previous: {
    from: '2026-03-06',
    to: '2026-03-08',
    fromUtc: '2026-03-06T08:00:00.000Z',
    toUtc: '2026-03-08T08:00:00.000Z',
    dates: ['2026-03-06', '2026-03-07'],
  },
};
const compiler = knexFactory({ client: 'pg' });
function serviceWithRows(results: unknown[][]) {
  const raw = jest.fn((sql: string, bindings?: unknown[]) => {
    if (sql.startsWith('SET TRANSACTION')) return Promise.resolve();
    if (sql.includes('lifetime_source AS')) return Promise.resolve({ rows: results.shift() });
    if (sql === 'SELECT CURRENT_TIMESTAMP AS "asOf"') return Promise.resolve({ rows: [{ asOf: range.asOf }] });
    return compiler.raw(sql, bindings as any);
  });
  const trx = Object.assign((table: string) => compiler(table), { raw, with: compiler.with.bind(compiler) });
  const transaction = jest.fn(async (callback) => callback(trx));
  return { service: new EnvironmentLifetimeAnalyticsService({ knex: { transaction } } as any), raw };
}
const params = (query = '') => new URLSearchParams(query);

describe('EnvironmentLifetimeAnalyticsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRange.mockResolvedValue(range);
  });
  afterAll(async () => {
    await compiler.destroy();
  });

  it('keeps empty and missing duration statistics unavailable, and a recorded zero measurable', () => {
    expect(serializeEnvironmentLifetimeStats('api', 'completed')).toMatchObject({
      eligible: 0,
      samples: 0,
      meanHours: null,
      medianHours: null,
      p90Hours: null,
      method: 'created_to_deleted',
      quality: 'recorded',
    });
    expect(serializeEnvironmentLifetimeStats('pr', 'completed', { eligible: 2, missing: 2 })).toMatchObject({
      eligible: 2,
      samples: 0,
      meanHours: null,
      method: 'created_to_last_update',
      quality: 'estimated',
    });
    expect(
      serializeEnvironmentLifetimeStats('all', 'current', {
        eligible: '1',
        samples: '1',
        mean_hours: '0',
        median_hours: 0,
        p90_hours: 0,
        under_1h: 1,
      })
    ).toMatchObject({ meanHours: 0, medianHours: 0, p90Hours: 0, quality: 'record_age' });
  });
  it('does not emit nonfinite or unsafe numeric JSON', () => {
    expect(
      serializeEnvironmentLifetimeStats('api', 'completed', {
        samples: 1,
        mean_hours: 'Infinity',
        median_hours: 'NaN',
        p90_hours: -1,
      })
    ).toMatchObject({ meanHours: null, medianHours: null, p90Hours: null });
    expect(() => serializeEnvironmentLifetimeStats('api', 'completed', { eligible: '9007199254740992' })).toThrow();
  });
  it('defines contiguous half-open bins with an uncapped final bucket', () => {
    expect(ENVIRONMENT_LIFETIME_BINS[0].fromHours).toBe(0);
    ENVIRONMENT_LIFETIME_BINS.slice(1).forEach((bin, index) => {
      expect(bin.fromHours).toBe(ENVIRONMENT_LIFETIME_BINS[index].toHours);
    });
    expect(ENVIRONMENT_LIFETIME_BINS.at(-1)?.toHours).toBeNull();
  });
  it('fills sparse dates, separates methods and preserves previous DST alignment', async () => {
    const { service, raw } = serviceWithRows([
      [
        { period: 'current', group_name: 'api', bucket: null, eligible: 2, samples: 1, missing: 1, mean_hours: 1 },
        { period: 'current', group_name: 'pr', bucket: null, eligible: 1, samples: 1, mean_hours: 10 },
        {
          period: 'current',
          group_name: 'api',
          bucket: '2026-03-09',
          eligible: 2,
          samples: 1,
          missing: 1,
          mean_hours: 1,
        },
        { period: 'previous', group_name: 'api', bucket: '2026-03-08', eligible: 1, samples: 1, mean_hours: 6 },
      ],
      [{ group_name: 'all', eligible: 3, samples: 2, invalid: 1, mean_hours: 20 }],
      [
        { group_name: 'api', missing_end: 2, invalid_end: 1 },
        { group_name: 'other', total: 4 },
      ],
    ]);
    const result = await service.getSummary(
      parseEnvironmentAnalyticsQuery(params('repositoryId=4&organization=Org&environmentAuthor=Alice'))
    );
    expect(result.completed.api).toMatchObject({ eligible: 2, samples: 1, missing: 1, meanHours: 1 });
    expect(result.completed.pr).toMatchObject({ meanHours: 10, quality: 'estimated' });
    expect(result.buckets[0]).toMatchObject({
      date: '2026-03-08',
      previousDate: '2026-03-06',
      current: { api: { samples: 0, meanHours: null } },
      previous: { api: { samples: 1, meanHours: 6 } },
    });
    expect(result.currentAge.all).toMatchObject({ eligible: 3, samples: 2, invalid: 1, quality: 'record_age' });
    expect(result.unplacedRetirements).toEqual({
      api: { missingEnd: 2, invalidEnd: 1 },
      pr: { missingEnd: 0, invalidEnd: 0 },
      other: 4,
    });
    const completedCall = raw.mock.calls.find(([sql]) => sql.includes('period_facts AS'))!;
    expect(completedCall[0]).toContain('rc.matches = 1');
    expect(completedCall[0]).toContain('WHEN "hasPullRequest" THEN');
    expect(completedCall[0]).toContain('percentile_cont(0.9)');
    expect(completedCall[0]).toContain('NOT isfinite(start_at)');
    expect(completedCall[0]).toContain('end_at < start_at');
    expect(completedCall[1]).toEqual(expect.arrayContaining([4, 'Org', 'Alice', range.previous!.fromUtc, range.toUtc]));
    const currentCall = raw.mock.calls.find(([sql]) => sql.includes("COALESCE(group_name, 'all')"))!;
    expect(currentCall[0]).toContain('"e"."deletedAt" is null');
    expect(currentCall[1]).not.toContain(range.fromUtc);
    expect(currentCall[1]).not.toContain(range.toUtc);
    expect(raw.mock.calls[0][0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  });
  it('keeps weekly prior display dates within the supported AD domain', async () => {
    mockResolveRange.mockResolvedValue({
      ...range,
      from: '0001-01-02',
      to: '0001-01-03',
      dates: ['0001-01-02'],
      calendarDays: 1,
      interval: 'week',
      previous: { ...range.previous, from: '0001-01-01', to: '0001-01-02', dates: ['0001-01-01'] },
    });
    const { service } = serviceWithRows([[], [], []]);
    const result = await service.getSummary(
      parseEnvironmentAnalyticsQuery(params('from=0001-01-02&to=0001-01-03&interval=week'))
    );
    expect(result.buckets[0].date).toBe('0001-01-01');
    expect(result.buckets[0].previousDate).toBeNull();
    expect(result.buckets[0].previous).not.toBeNull();
  });
  it('omits previous values when comparison is disabled', async () => {
    mockResolveRange.mockResolvedValue({ ...range, previous: null, compare: false });
    const { service } = serviceWithRows([[], [], []]);
    const result = await service.getSummary(parseEnvironmentAnalyticsQuery(params('compare=false')));
    expect(result.previousCompleted).toBeNull();
    expect(result.buckets.every((row) => row.previous === null && row.previousDate === null)).toBe(true);
  });
  it('current records ignore malformed calendar controls and return first-record age', async () => {
    const { service, raw } = serviceWithRows([
      [
        {
          total: '1',
          records: [
            {
              id: 1,
              group: 'other',
              durationHours: 0,
              startedAt: range.asOf,
              measuredUntilAt: range.asOf,
              repositoryId: null,
              githubInstallationId: null,
              sampleState: 'valid',
            },
          ],
        },
      ],
    ]);
    const query = parseEnvironmentLifetimeRecordsQuery(
      params('cohort=current&group=other&from=invalid&timezone=invalid&interval=invalid&compare=invalid')
    );
    const result = await service.getRecords(query);
    expect(mockResolveRange).not.toHaveBeenCalled();
    expect(result.range).toBeNull();
    expect(result.records[0]).toMatchObject({ method: 'first_record_age', quality: 'record_age', durationHours: 0 });
    expect(raw.mock.calls.some(([sql]) => sql.includes('period_facts'))).toBe(false);
  });
  it('records use exactly the retirement window and half-open histogram boundaries', async () => {
    const { service, raw } = serviceWithRows([[{ total: 2, records: [] }]]);
    const result = await service.getRecords(
      parseEnvironmentLifetimeRecordsQuery(params('cohort=completed&group=pr&bin=1_to_6h&page=2&limit=1'))
    );
    const call = raw.mock.calls.find(([sql]) => sql.includes('selected AS MATERIALIZED'))!;
    expect(call[0]).toContain('end_at >= ?::timestamptz AND end_at < ?::timestamptz');
    expect(call[0]).toContain('duration_hours >= ? AND duration_hours < ?');
    expect(call[1]).toEqual(expect.arrayContaining([range.fromUtc, range.toUtc, 'pr', 1, 6]));
    expect(result.pagination).toMatchObject({
      page: 2,
      limit: 1,
      total: 2,
      hasMore: false,
      maxPage: 10000,
      truncated: false,
    });
  });
  it('stops at the supported page bound while reporting uncapped totals', async () => {
    const { service } = serviceWithRows([[{ total: 1000001, records: [] }]]);
    const result = await service.getRecords(parseEnvironmentLifetimeRecordsQuery(params('page=10000&limit=100')));
    expect(result.pagination).toEqual({
      page: 10000,
      limit: 100,
      total: 1000001,
      hasMore: false,
      maxPage: 10000,
      truncated: true,
    });
  });
  it('accepts current coverage bins and completed all without merging summary methods', () => {
    expect(parseEnvironmentLifetimeRecordsQuery(params('cohort=current&bin=invalid&group=all'))).toMatchObject({
      cohort: 'current',
      bin: 'invalid',
      group: 'all',
    });
    expect(parseEnvironmentLifetimeRecordsQuery(params())).toMatchObject({
      cohort: 'completed',
      group: 'all',
      compare: true,
      page: 1,
      limit: 25,
    });
  });
  it.each([
    'cohort=episode',
    'group=other',
    'group=github',
    'bin=unknown',
    'page=0',
    'page=10001',
    'page=1.5',
    'page=1e2',
    'limit=101',
    'limit=0',
    'repositoryId=1&unattributed=true',
    'environmentType=workspace',
    'from=2026-02-30&to=2026-03-02',
    'from=2025-01-01&to=2026-01-02',
  ])('rejects invalid inputs %s', (query) => {
    expect(() => parseEnvironmentLifetimeRecordsQuery(params(query))).toThrow();
  });
});
