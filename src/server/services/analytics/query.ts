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

import type { Knex } from 'knex';
import { BadRequestError } from 'server/lib/appError';

export type AnalyticsInterval = 'day' | 'week';
export type AnalyticsCalendarQuery = {
  from?: string;
  to?: string;
  timezone?: string;
  compare?: boolean;
  interval?: AnalyticsInterval;
};
export type AnalyticsPeriod = {
  from: string;
  to: string;
  fromUtc: string;
  toUtc: string;
  dates: string[];
};
export type ResolvedAnalyticsRange = AnalyticsPeriod & {
  timezone: string;
  interval: AnalyticsInterval;
  compare: boolean;
  calendarDays: number;
  previous: AnalyticsPeriod | null;
  asOf: string;
};

const DAY = 86_400_000;
const MAX_DAYS = 365;
const dateTimestamp = (date: string) => Date.parse(`${date}T00:00:00Z`);
const isoDate = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
const isoInstant = (value: Date | string) => new Date(value).toISOString();

function validateDate(value: string | undefined, name: string): void {
  if (value === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') || !Number.isFinite(dateTimestamp(value))) {
    throw new BadRequestError(`${name} must be a calendar date in YYYY-MM-DD format.`, 'invalid_query');
  }
  if (isoDate(dateTimestamp(value)) !== value) {
    throw new BadRequestError(`${name} must be a real calendar date.`, 'invalid_query');
  }
}

function validateLength(from: string, to: string): number {
  const count = (dateTimestamp(to) - dateTimestamp(from)) / DAY;
  if (count < 1 || count > MAX_DAYS) {
    throw new BadRequestError(`The date range must contain between 1 and ${MAX_DAYS} calendar days.`, 'invalid_query');
  }
  return count;
}

function resolvedDate(value: string, name: string): string {
  const date = value.replace(/ AD$/, '');
  validateDate(date, name);
  return date;
}

export function analyticsTimezone(value = 'UTC'): string {
  if (!value || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) {
    throw new BadRequestError('timezone must be a supported IANA timezone.', 'invalid_query');
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new BadRequestError('timezone must be a supported IANA timezone.', 'invalid_query');
  }
}

export function parseAnalyticsCalendarQuery(params: URLSearchParams): AnalyticsCalendarQuery {
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  validateDate(from, 'from');
  validateDate(to, 'to');
  if (from !== undefined && to !== undefined) validateLength(from, to);
  const interval = params.get('interval') ?? 'day';
  if (interval !== 'day' && interval !== 'week') {
    throw new BadRequestError('interval must be day or week.', 'invalid_query');
  }
  const compare = params.get('compare');
  if (compare !== null && compare !== 'true' && compare !== 'false') {
    throw new BadRequestError('compare must be true or false.', 'invalid_query');
  }
  return {
    from,
    to,
    timezone: analyticsTimezone(params.get('timezone') ?? 'UTC'),
    interval,
    compare: compare !== 'false',
  };
}

export async function resolveAnalyticsRange(
  knex: Pick<Knex, 'raw'>,
  query: AnalyticsCalendarQuery
): Promise<ResolvedAnalyticsRange> {
  validateDate(query.from, 'from');
  validateDate(query.to, 'to');
  if (query.from !== undefined && query.to !== undefined) validateLength(query.from, query.to);
  const timezone = analyticsTimezone(query.timezone);
  const interval = query.interval ?? 'day';
  if (
    (interval !== 'day' && interval !== 'week') ||
    (query.compare !== undefined && typeof query.compare !== 'boolean')
  ) {
    throw new BadRequestError('Invalid interval or comparison option.', 'invalid_query');
  }
  const result = await knex.raw(
    `
    WITH requested AS (
      SELECT CURRENT_TIMESTAMP AS "asOf", ?::text AS timezone,
        COALESCE(?::date, (CURRENT_TIMESTAMP AT TIME ZONE ?)::date) AS "toDate",
        ?::date AS "fromDate"
    ), period AS (
      SELECT "asOf", timezone, COALESCE("fromDate", "toDate" - 30) AS "fromDate", "toDate"
      FROM requested
    )
    SELECT "asOf", to_char("fromDate", 'YYYY-MM-DD AD') AS "from",
      to_char("toDate", 'YYYY-MM-DD AD') AS "to",
      "fromDate"::timestamp AT TIME ZONE timezone AS "fromUtc",
      "toDate"::timestamp AT TIME ZONE timezone AS "toUtc",
      to_char("fromDate" - ("toDate" - "fromDate"), 'YYYY-MM-DD AD') AS "previousFrom",
      ("fromDate" - ("toDate" - "fromDate"))::timestamp AT TIME ZONE timezone AS "previousFromUtc"
    FROM period
  `,
    [timezone, query.to ?? null, timezone, query.from ?? null]
  );
  const row = result.rows[0] as {
    from: string;
    to: string;
    fromUtc: Date | string;
    toUtc: Date | string;
    previousFrom: string;
    previousFromUtc: Date | string;
    asOf: Date | string;
  };
  const from = resolvedDate(row.from, 'from');
  const to = resolvedDate(row.to, 'to');
  const calendarDays = validateLength(from, to);
  const dates = Array.from({ length: calendarDays }, (_, index) => isoDate(dateTimestamp(from) + index * DAY));
  const compare = query.compare !== false;
  const previousFrom = compare ? resolvedDate(row.previousFrom, 'comparison start date') : null;
  return {
    from,
    to,
    fromUtc: isoInstant(row.fromUtc),
    toUtc: isoInstant(row.toUtc),
    timezone,
    interval,
    compare,
    calendarDays,
    dates,
    asOf: isoInstant(row.asOf),
    previous: compare
      ? {
          from: previousFrom!,
          to: from,
          fromUtc: isoInstant(row.previousFromUtc),
          toUtc: isoInstant(row.fromUtc),
          dates: Array.from({ length: calendarDays }, (_, index) =>
            isoDate(dateTimestamp(previousFrom!) + index * DAY)
          ),
        }
      : null,
  };
}

export function analyticsBucketDates(range: ResolvedAnalyticsRange): string[] {
  if (range.interval === 'day') return range.dates;
  return [
    ...new Set(
      range.dates.map((date) => {
        const timestamp = dateTimestamp(date);
        const daysFromMonday = (new Date(timestamp).getUTCDay() + 6) % 7;
        return isoDate(timestamp - daysFromMonday * DAY);
      })
    ),
  ];
}

export function analyticsBucketExpression(
  knex: Pick<Knex, 'raw'>,
  range: ResolvedAnalyticsRange,
  column: string,
  period: 'current' | 'previous' = 'current'
): Knex.Raw {
  // Shift prior local dates before truncation so partial ISO weeks compare the same calendar-day blocks.
  return knex.raw(`to_char(date_trunc(?, (?? AT TIME ZONE ?) + (? * interval '1 day')), 'YYYY-MM-DD')`, [
    range.interval,
    column,
    range.timezone,
    period === 'previous' ? range.calendarDays : 0,
  ]);
}
