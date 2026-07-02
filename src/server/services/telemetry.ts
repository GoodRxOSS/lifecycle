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

import Service from './_service';
import type TelemetryEvent from 'server/models/TelemetryEvent';
import type { TelemetryAttributes, TelemetrySource, TelemetryStatus } from 'server/models/TelemetryEvent';

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

export type TelemetryStatsInterval = 'day' | 'week';

export type TelemetryStatsQuery = {
  source: TelemetrySource;
  from: Date;
  to: Date;
  interval: TelemetryStatsInterval;
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

function toBucketString(bucket: unknown): string {
  return bucket instanceof Date ? bucket.toISOString() : String(bucket);
}

function toCount(value: unknown): number {
  return Number(value) || 0;
}

function toDurationMs(value: unknown): number | null {
  return value == null ? null : Number(value);
}

export default class TelemetryService extends Service {
  async insertEvent(event: TelemetryEventInput): Promise<TelemetryEvent> {
    return this.db.models.TelemetryEvent.query().insert({
      ...event,
      attributes: event.attributes ?? {},
    });
  }

  async getStats({ source, from, to, interval }: TelemetryStatsQuery): Promise<TelemetryStats> {
    const knex = this.db.knex;
    const range: [string, string] = [from.toISOString(), to.toISOString()];

    const [usageRows, eventRows, clientTotalRow, clientOverTimeRows, versionRows, platformRows] = await Promise.all([
      knex(TELEMETRY_EVENTS_TABLE)
        .select(knex.raw('date_trunc(?, "createdAt") as bucket', [interval]))
        .select(knex.raw('count(*)::int as count'))
        .where('source', source)
        .whereBetween('createdAt', range)
        .groupByRaw('1')
        .orderByRaw('1'),
      knex(TELEMETRY_EVENTS_TABLE)
        .select('event')
        .select(knex.raw('count(*)::int as count'))
        .select(knex.raw(`count(*) filter (where status = 'error')::int as "errorCount"`))
        .select(knex.raw('percentile_cont(0.5) within group (order by "durationMs") as "p50DurationMs"'))
        .select(knex.raw('percentile_cont(0.95) within group (order by "durationMs") as "p95DurationMs"'))
        .where('source', source)
        .whereBetween('createdAt', range)
        .groupBy('event')
        .orderBy('count', 'desc')
        .limit(TOP_EVENTS_LIMIT),
      knex(TELEMETRY_EVENTS_TABLE)
        .select(knex.raw('count(distinct "clientId")::int as count'))
        .where('source', source)
        .whereBetween('createdAt', range)
        .first(),
      knex(TELEMETRY_EVENTS_TABLE)
        .select(knex.raw('date_trunc(?, "createdAt") as bucket', [interval]))
        .select(knex.raw('count(distinct "clientId")::int as count'))
        .where('source', source)
        .whereBetween('createdAt', range)
        .groupByRaw('1')
        .orderByRaw('1'),
      knex(TELEMETRY_EVENTS_TABLE)
        .select('clientVersion')
        .select(knex.raw('count(distinct "clientId")::int as count'))
        .where('source', source)
        .whereBetween('createdAt', range)
        .groupBy('clientVersion')
        .orderBy('count', 'desc'),
      knex(TELEMETRY_EVENTS_TABLE)
        .select('platform')
        .select(knex.raw('count(distinct "clientId")::int as count'))
        .where('source', source)
        .whereBetween('createdAt', range)
        .groupBy('platform')
        .orderBy('count', 'desc'),
    ]);

    return {
      usageOverTime: usageRows.map((row) => ({
        bucket: toBucketString(row.bucket),
        count: toCount(row.count),
      })),
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
        overTime: clientOverTimeRows.map((row) => ({
          bucket: toBucketString(row.bucket),
          count: toCount(row.count),
        })),
      },
      versions: versionRows.map((row) => ({
        clientVersion: row.clientVersion,
        count: toCount(row.count),
      })),
      platforms: platformRows.map((row) => ({
        platform: row.platform ?? null,
        count: toCount(row.count),
      })),
    };
  }
}
