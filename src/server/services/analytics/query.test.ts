import knexFactory from 'knex';
import {
  analyticsBucketDates,
  analyticsBucketExpression,
  analyticsSlicePeriod,
  analyticsSliceScan,
  parseAnalyticsCalendarQuery,
  parseAnalyticsPagination,
  parseAnalyticsSlice,
  parseAnalyticsSort,
  resolveAnalyticsRange,
  type ResolvedAnalyticsRange,
} from './query';

describe('analytics calendar contract', () => {
  it.each([
    'from=2026-02-30&to=2026-03-02',
    'from=2026-1-01&to=2026-01-03',
    'from=2026-01-01T00:00:00Z&to=2026-01-03',
    'from=&to=2026-01-03',
    'from=2026-01-03&to=2026-01-03',
    'from=2026-01-04&to=2026-01-03',
    'from=2025-01-01&to=2026-01-02',
    'timezone=Not%2FAZone',
    'timezone=%2B01%3A00',
    'compare=1',
    'interval=month',
    'from=0000-12-31&to=0001-01-01',
    'from=9999-12-31&to=10000-01-01',
  ])('rejects invalid calendar input %s', (query) => {
    expect(() => parseAnalyticsCalendarQuery(new URLSearchParams(query))).toThrow();
  });

  it('defaults to UTC/day with comparison and accepts exactly 365 calendar days', () => {
    expect(parseAnalyticsCalendarQuery(new URLSearchParams())).toEqual({
      from: undefined,
      to: undefined,
      timezone: 'UTC',
      interval: 'day',
      compare: true,
    });
    expect(
      parseAnalyticsCalendarQuery(new URLSearchParams('from=2025-01-01&to=2026-01-01&compare=false')).compare
    ).toBe(false);
  });

  it('preserves SQL-resolved DST boundaries and equal calendar-day prior alignment', async () => {
    const raw = jest.fn().mockResolvedValue({
      rows: [
        {
          from: '2026-03-08',
          to: '2026-03-10',
          fromUtc: '2026-03-08T08:00:00Z',
          toUtc: '2026-03-10T07:00:00Z',
          previousFrom: '2026-03-06',
          previousFromUtc: '2026-03-06T08:00:00Z',
          asOf: '2026-03-10T08:30:00Z',
        },
      ],
    });
    const result = await resolveAnalyticsRange({ raw } as any, {
      from: '2026-03-08',
      to: '2026-03-10',
      timezone: 'America/Los_Angeles',
    });
    expect(result.calendarDays).toBe(2);
    expect(result.dates).toEqual(['2026-03-08', '2026-03-09']);
    expect(result.previous?.dates).toEqual(['2026-03-06', '2026-03-07']);
    expect((Date.parse(result.toUtc) - Date.parse(result.fromUtc)) / 3_600_000).toBe(47);
    expect((Date.parse(result.previous!.toUtc) - Date.parse(result.previous!.fromUtc)) / 3_600_000).toBe(48);
    expect(raw).toHaveBeenCalledWith(expect.stringContaining('AT TIME ZONE timezone'), [
      'America/Los_Angeles',
      '2026-03-10',
      'America/Los_Angeles',
      '2026-03-08',
    ]);
  });

  it('uses complete calendar days returned by SQL for default dates and omits explicit disabled comparison', async () => {
    const raw = jest.fn().mockResolvedValue({
      rows: [
        {
          from: '2026-09-02',
          to: '2026-10-02',
          fromUtc: '2026-09-02T00:00:00Z',
          toUtc: '2026-10-02T00:00:00Z',
          previousFrom: '2026-08-03',
          previousFromUtc: '2026-08-03T00:00:00Z',
          asOf: '2026-10-02T18:00:00Z',
        },
      ],
    });
    const result = await resolveAnalyticsRange({ raw } as any, { compare: false });
    expect(result.dates).toHaveLength(30);
    expect(result.dates.at(-1)).toBe('2026-10-01');
    expect(result.previous).toBeNull();
    expect(raw.mock.calls[0][1]).toEqual(['UTC', null, 'UTC', null]);
  });

  it('shifts prior local dates before ISO-week truncation so partial weeks compare matching blocks', () => {
    const knex = knexFactory({ client: 'pg' });
    const range = {
      interval: 'week',
      timezone: 'America/Los_Angeles',
      calendarDays: 5,
      dates: ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11'],
    } as ResolvedAnalyticsRange;
    expect(analyticsBucketDates(range)).toEqual(['2026-03-02', '2026-03-09']);
    expect(analyticsBucketExpression(knex, range, 'runs.queuedAt', 'previous').toSQL().bindings).toEqual([
      'week',
      'America/Los_Angeles',
      5,
    ]);
    expect(analyticsBucketExpression(knex, range, 'runs.queuedAt').toSQL().sql).toContain(
      '"runs"."queuedAt" AT TIME ZONE'
    );
  });

  it('rejects comparison dates outside the supported AD calendar domain', async () => {
    const raw = jest.fn().mockResolvedValue({
      rows: [
        {
          from: '0001-01-01 AD',
          to: '0001-01-02 AD',
          fromUtc: '0001-01-01T00:00:00Z',
          toUtc: '0001-01-02T00:00:00Z',
          previousFrom: '0001-12-31 BC',
          previousFromUtc: '0000-12-31T00:00:00Z',
          asOf: '2026-10-03T00:00:00Z',
        },
      ],
    });
    await expect(resolveAnalyticsRange({ raw } as any, { from: '0001-01-01', to: '0001-01-02' })).rejects.toMatchObject(
      {
        httpStatus: 400,
        code: 'invalid_query',
      }
    );
    const range = await resolveAnalyticsRange({ raw } as any, {
      from: '0001-01-01',
      to: '0001-01-02',
      compare: false,
    });
    expect(range).toMatchObject({
      from: '0001-01-01',
      to: '0001-01-02',
      dates: ['0001-01-01'],
      previous: null,
    });
  });

  it('preserves the maximum four-digit AD dates and their comparison', async () => {
    const raw = jest.fn().mockResolvedValue({
      rows: [
        {
          from: '9999-12-30 AD',
          to: '9999-12-31 AD',
          fromUtc: '9999-12-30T00:00:00Z',
          toUtc: '9999-12-31T00:00:00Z',
          previousFrom: '9999-12-29 AD',
          previousFromUtc: '9999-12-29T00:00:00Z',
          asOf: '2026-10-03T00:00:00Z',
        },
      ],
    });
    const range = await resolveAnalyticsRange({ raw } as any, { from: '9999-12-30', to: '9999-12-31' });
    expect(range.dates).toEqual(['9999-12-30']);
    expect(range.previous).toMatchObject({ from: '9999-12-29', to: '9999-12-30', dates: ['9999-12-29'] });
  });

  it('parses the shared slice, pagination and sort parameters', () => {
    expect(parseAnalyticsSlice(new URLSearchParams())).toEqual({ date: null, period: 'current' });
    expect(parseAnalyticsSlice(new URLSearchParams('date=2026-03-09&period=previous'))).toEqual({
      date: '2026-03-09',
      period: 'previous',
    });
    expect(() => parseAnalyticsSlice(new URLSearchParams('date=2026-3-9'))).toThrow();
    expect(() => parseAnalyticsSlice(new URLSearchParams('period=last'))).toThrow();
    expect(parseAnalyticsPagination(new URLSearchParams())).toEqual({ page: 1, limit: 25 });
    expect(parseAnalyticsPagination(new URLSearchParams('page=3&limit=100'))).toEqual({ page: 3, limit: 100 });
    expect(() => parseAnalyticsPagination(new URLSearchParams('page=0'))).toThrow();
    expect(() => parseAnalyticsPagination(new URLSearchParams('limit=101'))).toThrow();
    expect(() => parseAnalyticsPagination(new URLSearchParams('page=10001'))).toThrow();
    expect(parseAnalyticsPagination(new URLSearchParams('page=10001'), 1_000_000)).toEqual({ page: 10001, limit: 25 });
    const keys = ['requestedAt', 'timeToReady'] as const;
    expect(parseAnalyticsSort(new URLSearchParams(), keys, 'requestedAt')).toEqual({
      key: 'requestedAt',
      descending: true,
    });
    expect(parseAnalyticsSort(new URLSearchParams('sort=timeToReady:asc'), keys, 'requestedAt')).toEqual({
      key: 'timeToReady',
      descending: false,
    });
    expect(parseAnalyticsSort(new URLSearchParams('sort=timeToReady'), keys, 'requestedAt').descending).toBe(true);
    expect(() => parseAnalyticsSort(new URLSearchParams('sort=queueWait'), keys, 'requestedAt')).toThrow();
    expect(() => parseAnalyticsSort(new URLSearchParams('sort=timeToReady:up'), keys, 'requestedAt')).toThrow();
  });

  it('resolves a slice to its period and keeps dates inside the bucket list', () => {
    const range: ResolvedAnalyticsRange = {
      from: '2026-03-08',
      to: '2026-03-10',
      fromUtc: '2026-03-08T00:00:00.000Z',
      toUtc: '2026-03-10T00:00:00.000Z',
      dates: ['2026-03-08', '2026-03-09'],
      timezone: 'UTC',
      interval: 'day',
      compare: true,
      calendarDays: 2,
      asOf: '2026-03-10T00:00:00.000Z',
      previous: {
        from: '2026-03-06',
        to: '2026-03-08',
        fromUtc: '2026-03-06T00:00:00.000Z',
        toUtc: '2026-03-08T00:00:00.000Z',
        dates: ['2026-03-06', '2026-03-07'],
      },
    };
    expect(analyticsSlicePeriod(range, { date: null, period: 'current' })).toBe(range);
    expect(analyticsSlicePeriod(range, { date: '2026-03-09', period: 'previous' })).toBe(range.previous);
    expect(() => analyticsSlicePeriod(range, { date: '2026-03-07', period: 'previous' })).toThrow(
      'date must be the start of a bucket inside the window.'
    );
    expect(() =>
      analyticsSlicePeriod({ ...range, compare: false, previous: null }, { date: null, period: 'previous' })
    ).toThrow('period must be current when compare is false.');
    const weekly = { ...range, interval: 'week' as const };
    expect(analyticsSlicePeriod(weekly, { date: '2026-03-02', period: 'current' })).toBe(weekly);
    expect(analyticsSlicePeriod(weekly, { date: '2026-03-09', period: 'current' })).toBe(weekly);
    expect(() => analyticsSlicePeriod(weekly, { date: '2026-03-08', period: 'current' })).toThrow();
  });

  it('scans one period for a slice, and one bucket with a day of margin on each side for a date', () => {
    const range: ResolvedAnalyticsRange = {
      from: '2026-03-01',
      to: '2026-03-29',
      fromUtc: '2026-03-01T08:00:00.000Z',
      toUtc: '2026-03-29T07:00:00.000Z',
      dates: Array.from({ length: 28 }, (_, day) => `2026-03-${String(day + 1).padStart(2, '0')}`),
      timezone: 'America/Los_Angeles',
      interval: 'day',
      compare: true,
      calendarDays: 28,
      asOf: '2026-03-29T07:00:00.000Z',
      previous: {
        from: '2026-02-01',
        to: '2026-03-01',
        fromUtc: '2026-02-01T08:00:00.000Z',
        toUtc: '2026-03-01T08:00:00.000Z',
        dates: Array.from({ length: 28 }, (_, day) => `2026-02-${String(day + 1).padStart(2, '0')}`),
      },
    };
    expect(analyticsSliceScan(range, { date: null, period: 'current' })).toEqual({
      fromUtc: range.fromUtc,
      toUtc: range.toUtc,
    });
    expect(analyticsSliceScan(range, { date: null, period: 'previous' })).toEqual({
      fromUtc: range.previous!.fromUtc,
      toUtc: range.previous!.toUtc,
    });
    expect(analyticsSliceScan(range, { date: '2026-03-10', period: 'current' })).toEqual({
      fromUtc: '2026-03-09T00:00:00.000Z',
      toUtc: '2026-03-12T00:00:00.000Z',
    });
    expect(analyticsSliceScan(range, { date: '2026-03-10', period: 'previous' })).toEqual({
      fromUtc: '2026-02-09T00:00:00.000Z',
      toUtc: '2026-02-12T00:00:00.000Z',
    });
    expect(analyticsSliceScan(range, { date: '2026-03-01', period: 'current' })).toEqual({
      fromUtc: range.fromUtc,
      toUtc: '2026-03-03T00:00:00.000Z',
    });
    expect(analyticsSliceScan(range, { date: '2026-03-28', period: 'current' })).toEqual({
      fromUtc: '2026-03-27T00:00:00.000Z',
      toUtc: range.toUtc,
    });
    const weekly = { ...range, interval: 'week' as const };
    expect(analyticsSliceScan(weekly, { date: '2026-03-09', period: 'current' })).toEqual({
      fromUtc: '2026-03-08T00:00:00.000Z',
      toUtc: '2026-03-17T00:00:00.000Z',
    });
  });
});
