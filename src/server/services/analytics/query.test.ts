import knexFactory from 'knex';
import {
  analyticsBucketDates,
  analyticsBucketExpression,
  parseAnalyticsCalendarQuery,
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
});
