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

import type { Knex } from 'knex';
import { BadRequestError } from 'server/lib/appError';
import Service from './_service';
import type TelemetryEvent from 'server/models/TelemetryEvent';
import type { TelemetryAttributes, TelemetrySource, TelemetryStatus } from 'server/models/TelemetryEvent';
import { analyticsTransaction } from './analytics/execution';
import {
  analyticsBucketDates,
  analyticsBucketExpression,
  parseAnalyticsCalendarQuery,
  resolveAnalyticsRange,
  type AnalyticsCalendarQuery,
  type ResolvedAnalyticsRange,
} from './analytics/query';

const TELEMETRY_EVENTS_TABLE = 'telemetry_events';
const TOP_EVENTS_LIMIT = 20;

export type TelemetryEventInput = {
  source: TelemetrySource;
  clientId: string;
  event: string;
  attributes?: TelemetryAttributes;
  durationMs?: number | null;
  status: TelemetryStatus;
  exitCode?: number | null;
  errorClass?: string | null;
  errorHttpStatus?: number | null;
  errorCode?: string | null;
  clientVersion: string;
  runtimeVersion?: string | null;
  platform?: string | null;
  arch?: string | null;
};

export type TelemetryStatsQuery = AnalyticsCalendarQuery & { source: TelemetrySource };

const SOURCES: TelemetrySource[] = ['cli', 'ui'];

export function parseTelemetryStatsQuery(params: URLSearchParams): TelemetryStatsQuery {
  const source = params.get('source') as TelemetrySource | null;
  if (!source || !SOURCES.includes(source)) {
    throw new BadRequestError('source must be cli or ui.', 'invalid_query');
  }
  // Older clients sent full timestamps; their calendar day is kept.
  const calendar = new URLSearchParams(params);
  for (const key of ['from', 'to']) {
    const value = calendar.get(key);
    if (value && /^\d{4}-\d{2}-\d{2}T/.test(value)) calendar.set(key, value.slice(0, 10));
  }
  return { ...parseAnalyticsCalendarQuery(calendar), compare: false, source };
}

export type TelemetryStatsResult = {
  source: TelemetrySource;
  range: ResolvedAnalyticsRange;
  stats: TelemetryStats;
};

export type TelemetryBucketCount = {
  bucket: string;
  count: number;
};

export type TelemetryEventStats = {
  event: string;
  count: number;
  errorCount: number;
  errorRate: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
};

export type TelemetryStats = {
  usageOverTime: TelemetryBucketCount[];
  topEvents: TelemetryEventStats[];
  activeClients: {
    total: number;
    overTime: TelemetryBucketCount[];
  };
  versions: Array<{ clientVersion: string; count: number }>;
  platforms: Array<{ platform: string | null; count: number }>;
};

function toCount(value: unknown): number {
  return Number(value) || 0;
}

function toDurationMs(value: unknown): number | null {
  return value == null ? null : Number(value);
}

export default class TelemetryService extends Service {
  async insertEvent(event: TelemetryEventInput): Promise<TelemetryEvent> {
    return this.db.models.TelemetryEvent.query()
      .insert({
        ...event,
        attributes: event.attributes ?? {},
      })
      .returning('*');
  }

  async getStats(query: TelemetryStatsQuery): Promise<TelemetryStatsResult> {
    const { source } = query;
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = await resolveAnalyticsRange(trx, { ...query, compare: false });
      const scoped = (): Knex.QueryBuilder =>
        trx(TELEMETRY_EVENTS_TABLE)
          .where('source', source)
          .where('createdAt', '>=', range.fromUtc)
          .where('createdAt', '<', range.toUtc);
      const bucket = () => analyticsBucketExpression(trx, range, 'createdAt').wrap('', ' AS bucket');

      type BucketCountRow = { bucket: string; count: number };
      type TopEventRow = {
        event: string;
        count: number;
        errorCount: number;
        p50DurationMs: number | string | null;
        p95DurationMs: number | string | null;
      };
      type VersionRow = { clientVersion: string; count: number };
      type PlatformRow = { platform: string | null; count: number };

      const usageRows = (await scoped()
        .select(bucket())
        .select(trx.raw('count(*)::int as count'))
        .groupBy('bucket')) as BucketCountRow[];
      const eventRows = (await scoped()
        .select('event')
        .select(trx.raw('count(*)::int as count'))
        .select(trx.raw(`count(*) filter (where status = 'error')::int as "errorCount"`))
        .select(trx.raw('percentile_cont(0.5) within group (order by "durationMs") as "p50DurationMs"'))
        .select(trx.raw('percentile_cont(0.95) within group (order by "durationMs") as "p95DurationMs"'))
        .groupBy('event')
        .orderBy('count', 'desc')
        .limit(TOP_EVENTS_LIMIT)) as TopEventRow[];
      const clientTotalRow = (await scoped().select(trx.raw('count(distinct "clientId")::int as count')).first()) as
        | { count: number }
        | undefined;
      const clientOverTimeRows = (await scoped()
        .select(bucket())
        .select(trx.raw('count(distinct "clientId")::int as count'))
        .groupBy('bucket')) as BucketCountRow[];
      const versionRows = (await scoped()
        .select('clientVersion')
        .select(trx.raw('count(distinct "clientId")::int as count'))
        .groupBy('clientVersion')
        .orderBy('count', 'desc')) as VersionRow[];
      const platformRows = (await scoped()
        .select('platform')
        .select(trx.raw('count(distinct "clientId")::int as count'))
        .groupBy('platform')
        .orderBy('count', 'desc')) as PlatformRow[];

      const dates = analyticsBucketDates(range);
      const filled = (rows: BucketCountRow[]): TelemetryBucketCount[] => {
        const counts = new Map(rows.map((row) => [String(row.bucket), toCount(row.count)]));
        return dates.map((date) => ({ bucket: date, count: counts.get(date) ?? 0 }));
      };

      return {
        source,
        range,
        stats: {
          usageOverTime: filled(usageRows),
          topEvents: eventRows.map((row) => {
            const count = toCount(row.count);
            const errorCount = toCount(row.errorCount);
            return {
              event: row.event,
              count,
              errorCount,
              errorRate: count > 0 ? errorCount / count : 0,
              p50DurationMs: toDurationMs(row.p50DurationMs),
              p95DurationMs: toDurationMs(row.p95DurationMs),
            };
          }),
          activeClients: {
            total: toCount(clientTotalRow?.count),
            overTime: filled(clientOverTimeRows),
          },
          versions: versionRows.map((row) => ({
            clientVersion: row.clientVersion,
            count: toCount(row.count),
          })),
          platforms: platformRows.map((row) => ({
            platform: row.platform ?? null,
            count: toCount(row.count),
          })),
        },
      };
    });
  }
}
