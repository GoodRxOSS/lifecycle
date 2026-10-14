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
import type Database from 'server/database';
import { BadRequestError } from 'server/lib/appError';
import { defaultDb } from 'server/lib/dependencies';
import { analyticsTransaction } from './execution';
import {
  analyticsBucketDates,
  analyticsBucketExpression,
  analyticsSliceScan,
  parseAnalyticsCalendarQuery,
  parseAnalyticsPagination,
  parseAnalyticsSlice,
  parseAnalyticsSort,
  resolveAnalyticsRange,
  type AnalyticsCalendarQuery,
  type AnalyticsSlice,
  type AnalyticsSlicePeriod,
  type AnalyticsSort,
  type ResolvedAnalyticsRange,
} from './query';

export type McpAnalyticsQuery = AnalyticsCalendarQuery;
export const MCP_CALL_SORTS = ['createdAt', 'durationMs'] as const;
export type McpCallSort = (typeof MCP_CALL_SORTS)[number];
export type McpCallsQuery = McpAnalyticsQuery & {
  tool: string | null;
  userId: string | null;
  client: string | null;
  outcome: string | null;
  slice: AnalyticsSlice;
  sort: AnalyticsSort<McpCallSort>;
  page: number;
  limit: number;
};

export interface McpUsageTotals {
  calls: number;
  errors: number;
  errorRate: number | null;
  users: number;
  clients: number;
  installations: number;
  readOnlyCalls: number;
  changeCalls: number;
}
export interface McpAnalyticsBucket {
  date: string;
  calls: number;
  errors: number;
  users: number;
  previousCalls: number | null;
  previousErrors: number | null;
  previousUsers: number | null;
}
export interface McpToolUsage {
  tool: string;
  readOnly: boolean | null;
  calls: number;
  errors: number;
  errorRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}
export interface McpUserUsage {
  userId: string | null;
  username: string | null;
  calls: number;
  errors: number;
  lastCallAt: string | null;
}
export interface McpClientUsage {
  client: string;
  installations: number;
  calls: number;
  users: number;
  errors: number;
  lastCallAt: string | null;
}
export interface McpAnalytics {
  range: ResolvedAnalyticsRange;
  asOf: string;
  caveats: string[];
  auditSince: string | null;
  allCallsSince: string | null;
  totals: McpUsageTotals;
  previousTotals: McpUsageTotals | null;
  buckets: McpAnalyticsBucket[];
  tools: McpToolUsage[];
  users: { items: McpUserUsage[]; total: number; limit: number };
  clients: McpClientUsage[];
  errors: { code: string; calls: number }[];
}
export interface McpCallTarget {
  environmentUuid: string | null;
  environmentId: number | null;
  siteId: string | null;
  deployId: string | null;
}
export interface McpCallRecord {
  id: number;
  createdAt: string;
  period: AnalyticsSlicePeriod;
  tool: string;
  readOnly: boolean | null;
  outcome: string;
  error: boolean;
  durationMs: number | null;
  userId: string | null;
  username: string | null;
  client: string;
  clientId: string | null;
  requestId: string | null;
  target: McpCallTarget | null;
}
export interface McpCallsSlice {
  tool: string | null;
  userId: string | null;
  client: string | null;
  outcome: string | null;
  date: string | null;
  period: AnalyticsSlicePeriod;
  sort: string;
}
export interface McpCalls {
  range: ResolvedAnalyticsRange;
  asOf: string;
  caveats: string[];
  slice: McpCallsSlice;
  records: McpCallRecord[];
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
}

export const MCP_USER_LIMIT = 20;
export const MCP_ERROR_LIMIT = 10;
const CAVEATS = [
  'Calls are counted when the Lifecycle MCP server runs a tool. Calls rejected for rate limiting or a bad token, or refused because MCP or the tool was turned off, are not counted.',
  'A client application is the registered name of the MCP client. Each client registration counts as one installation.',
  'Before the all-calls date only calls that could change something were recorded, so read-only tools are missing from earlier periods.',
  'Recorded calls older than the retention period are deleted when a retention period is set.',
];
const RECORD_CAVEATS = ['Tool arguments are not recorded. Only the identifiers of the target are kept.'];
const CALL_SORT_SQL: Record<McpCallSort, string> = { createdAt: 'm."createdAt"', durationMs: 'm.duration_ms' };
const OUTCOME_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

function callsSql(detail: boolean): string {
  const detailColumns = detail
    ? `a.id, a."requestId" AS request_id, a.meta->>'uuid' AS environment_uuid,
            a.meta->>'environmentId' AS environment_id, a.meta->>'siteId' AS site_id, a.meta->>'deployId' AS deploy_id,
            `
    : '';
  return `calls AS MATERIALIZED (
          SELECT ${detailColumns}a."createdAt", a."principalId", a.outcome,
            COALESCE(a.meta->>'tool', a.route) AS tool,
            a.meta->>'clientId' AS client_id, a.meta->>'username' AS username,
            a.meta->>'clientName' AS client_name,
            COALESCE(a.meta->>'clientName',
              CASE WHEN a.meta->>'clientId' IS NULL THEN 'Unknown client' ELSE 'Unregistered client' END) AS client,
            CASE WHEN a.meta->>'durationMs' ~ '^[0-9]+(\\.[0-9]+){0,1}$'
              THEN (a.meta->>'durationMs')::double precision END AS duration_ms,
            CASE a.meta->>'readOnly' WHEN 'true' THEN true WHEN 'false' THEN false END AS read_only,
            (a.outcome <> 'succeeded') AS is_error,
            CASE WHEN a."createdAt" >= ?::timestamptz THEN 'current' ELSE 'previous' END AS period
          FROM auth_audit_events a
          WHERE a.event = 'mcp.tool_call' AND a."createdAt" >= ?::timestamptz AND a."createdAt" < ?::timestamptz
        )`;
}

type SummaryRow = {
  periods: Array<Record<string, unknown> & { period: string }>;
  buckets: Array<Record<string, unknown> & { period: string; bucket: string }>;
  tools: Array<Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  user_total: number | string;
  clients: Array<Record<string, unknown>>;
  errors: Array<{ code: string; calls: number | string }>;
  audit_since: Date | string | null;
  all_calls_since: Date | string | null;
  as_of: Date | string;
};

const count = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};
const nullableNumber = (value: unknown): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value: unknown): string | null => (value == null ? null : String(value));
const timestamp = (value: Date | string | null | undefined): string | null => {
  if (value == null) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
const rate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

export function parseMcpAnalyticsQuery(params: URLSearchParams): McpAnalyticsQuery {
  return parseAnalyticsCalendarQuery(params);
}

export function parseMcpCallsQuery(params: URLSearchParams): McpCallsQuery {
  const bounded = (name: string, maximum: number) => {
    const value = params.get(name)?.trim();
    if (value == null) return null;
    if (!value || Array.from(value).length > maximum) {
      throw new BadRequestError(`${name} must be a nonempty value of at most ${maximum} characters.`, 'invalid_query');
    }
    return value;
  };
  const outcome = bounded('outcome', 64);
  if (outcome != null && !OUTCOME_CODE.test(outcome)) {
    throw new BadRequestError('outcome must be succeeded, error, or a recorded error code.', 'invalid_query');
  }
  return {
    ...parseMcpAnalyticsQuery(params),
    tool: bounded('tool', 128),
    userId: bounded('userId', 255),
    client: bounded('client', 255),
    outcome,
    slice: parseAnalyticsSlice(params),
    sort: parseAnalyticsSort(params, MCP_CALL_SORTS, 'createdAt'),
    ...parseAnalyticsPagination(params),
  };
}

export function serializeMcpUsageTotals(row?: Record<string, unknown>): McpUsageTotals {
  const calls = count(row?.calls);
  const errors = count(row?.errors);
  return {
    calls,
    errors,
    errorRate: rate(errors, calls),
    users: count(row?.users),
    clients: count(row?.clients),
    installations: count(row?.installations),
    readOnlyCalls: count(row?.read_only_calls),
    changeCalls: count(row?.change_calls),
  };
}

const CALL_COUNTS = `count(*)::int AS calls,
  count(*) FILTER (WHERE is_error)::int AS errors`;

export default class McpAnalyticsService {
  constructor(private readonly db: Pick<Database, 'knex'> = defaultDb) {}

  async getSummary(query: McpAnalyticsQuery): Promise<McpAnalytics> {
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = await resolveAnalyticsRange(trx, query);
      const result = await trx.raw(
        `WITH ${callsSql(false)},
        period_counts AS (
          SELECT period, ${CALL_COUNTS},
            count(*) FILTER (WHERE read_only)::int AS read_only_calls,
            count(*) FILTER (WHERE read_only = false)::int AS change_calls
          FROM calls GROUP BY period
        ), period_users AS (
          SELECT period, count(*)::int AS users
          FROM (SELECT DISTINCT period, "principalId" FROM calls WHERE "principalId" IS NOT NULL) d GROUP BY period
        ), period_clients AS (
          SELECT period, count(*)::int AS clients
          FROM (SELECT DISTINCT period, client FROM calls WHERE client_name IS NOT NULL) d GROUP BY period
        ), period_installations AS (
          SELECT period, count(*)::int AS installations
          FROM (SELECT DISTINCT period, client_id FROM calls WHERE client_id IS NOT NULL) d GROUP BY period
        ), bucketed AS (
          SELECT period, to_char(date_trunc(?, ("createdAt" AT TIME ZONE ?) +
            (CASE WHEN period = 'previous' THEN ?::int ELSE 0 END * interval '1 day')), 'YYYY-MM-DD') AS bucket,
            "principalId", is_error
          FROM calls
        ), bucket_counts AS (
          SELECT period, bucket, ${CALL_COUNTS} FROM bucketed GROUP BY period, bucket
        ), bucket_users AS (
          SELECT period, bucket, count(*)::int AS users
          FROM (SELECT DISTINCT period, bucket, "principalId" FROM bucketed WHERE "principalId" IS NOT NULL) d
          GROUP BY period, bucket
        )
        SELECT
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT c.*, COALESCE(u.users, 0) AS users, COALESCE(cl.clients, 0) AS clients,
              COALESCE(i.installations, 0) AS installations
            FROM period_counts c
            LEFT JOIN period_users u USING (period)
            LEFT JOIN period_clients cl USING (period)
            LEFT JOIN period_installations i USING (period)) x) AS periods,
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT c.*, COALESCE(u.users, 0) AS users
            FROM bucket_counts c LEFT JOIN bucket_users u USING (period, bucket)) x) AS buckets,
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT tool, bool_and(read_only) AS read_only, ${CALL_COUNTS},
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_duration_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_duration_ms
            FROM calls WHERE period = 'current' GROUP BY tool ORDER BY calls DESC, tool) x) AS tools,
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT "principalId" AS user_id,
              (array_agg(username ORDER BY "createdAt" DESC) FILTER (WHERE username IS NOT NULL))[1] AS username,
              ${CALL_COUNTS}, max("createdAt") AS last_call_at
            FROM calls WHERE period = 'current' GROUP BY "principalId"
            ORDER BY calls DESC, last_call_at DESC LIMIT ${MCP_USER_LIMIT}) x) AS users,
          (SELECT count(*)::int FROM (SELECT 1 FROM calls WHERE period = 'current' GROUP BY "principalId") y) AS user_total,
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT client, count(DISTINCT client_id)::int AS installations, ${CALL_COUNTS},
              count(DISTINCT "principalId")::int AS users, max("createdAt") AS last_call_at
            FROM calls WHERE period = 'current' GROUP BY client ORDER BY calls DESC, client) x) AS clients,
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT outcome AS code, count(*)::int AS calls FROM calls WHERE period = 'current' AND is_error
            GROUP BY outcome ORDER BY calls DESC, code LIMIT ${MCP_ERROR_LIMIT}) x) AS errors,
          (SELECT min("createdAt") FROM auth_audit_events WHERE event = 'mcp.tool_call') AS audit_since,
          (SELECT min("createdAt") FROM auth_audit_events
            WHERE event = 'mcp.tool_call' AND (meta->>'readOnly') IS NOT NULL) AS all_calls_since,
          CURRENT_TIMESTAMP AS as_of`,
        [
          range.fromUtc,
          range.previous?.fromUtc ?? range.fromUtc,
          range.toUtc,
          range.interval,
          range.timezone,
          range.calendarDays,
        ]
      );
      const row = result.rows[0] as SummaryRow;
      const period = (name: string) => row.periods.find((entry) => entry.period === name);
      const bucketRows = (name: string) =>
        new Map(row.buckets.filter((entry) => entry.period === name).map((entry) => [entry.bucket, entry]));
      const current = bucketRows('current');
      const previous = bucketRows('previous');
      return {
        range,
        asOf: timestamp(row.as_of) ?? range.asOf,
        caveats: CAVEATS,
        auditSince: timestamp(row.audit_since),
        allCallsSince: timestamp(row.all_calls_since),
        totals: serializeMcpUsageTotals(period('current')),
        previousTotals: range.previous ? serializeMcpUsageTotals(period('previous')) : null,
        buckets: analyticsBucketDates(range).map((date) => {
          const now = current.get(date);
          const prior = previous.get(date);
          return {
            date,
            calls: count(now?.calls),
            errors: count(now?.errors),
            users: count(now?.users),
            previousCalls: range.previous ? count(prior?.calls) : null,
            previousErrors: range.previous ? count(prior?.errors) : null,
            previousUsers: range.previous ? count(prior?.users) : null,
          };
        }),
        tools: row.tools.map((entry) => {
          const calls = count(entry.calls);
          const errors = count(entry.errors);
          return {
            tool: String(entry.tool ?? 'unknown'),
            readOnly: typeof entry.read_only === 'boolean' ? entry.read_only : null,
            calls,
            errors,
            errorRate: rate(errors, calls),
            p50DurationMs: nullableNumber(entry.p50_duration_ms),
            p95DurationMs: nullableNumber(entry.p95_duration_ms),
          };
        }),
        users: {
          items: row.users.map((entry) => ({
            userId: text(entry.user_id),
            username: text(entry.username),
            calls: count(entry.calls),
            errors: count(entry.errors),
            lastCallAt: timestamp(entry.last_call_at as string | null),
          })),
          total: count(row.user_total),
          limit: MCP_USER_LIMIT,
        },
        clients: row.clients.map((entry) => ({
          client: String(entry.client ?? 'Unknown client'),
          installations: count(entry.installations),
          calls: count(entry.calls),
          users: count(entry.users),
          errors: count(entry.errors),
          lastCallAt: timestamp(entry.last_call_at as string | null),
        })),
        errors: row.errors.map((entry) => ({ code: String(entry.code), calls: count(entry.calls) })),
      };
    });
  }

  /** Lists the calls behind a summary number: the same facts, cut by the slice the number was read from. */
  async getCalls(query: McpCallsQuery): Promise<McpCalls> {
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = await resolveAnalyticsRange(trx, query);
      const scan = analyticsSliceScan(range, query.slice);
      const conditions = ['m.period = ?'];
      const bindings: Knex.RawBinding[] = [query.slice.period];
      if (query.tool != null) {
        conditions.push('m.tool = ?');
        bindings.push(query.tool);
      }
      if (query.userId === 'unknown') conditions.push('m."principalId" IS NULL');
      else if (query.userId != null) {
        conditions.push('m."principalId" = ?');
        bindings.push(query.userId);
      }
      if (query.client != null) {
        conditions.push('m.client = ?');
        bindings.push(query.client);
      }
      if (query.outcome === 'succeeded') conditions.push('NOT m.is_error');
      else if (query.outcome === 'error') conditions.push('m.is_error');
      else if (query.outcome != null) {
        conditions.push('m.outcome = ?');
        bindings.push(query.outcome);
      }
      if (query.slice.date) {
        const bucket = analyticsBucketExpression(trx, range, 'm.createdAt', query.slice.period).toSQL();
        conditions.push(`${bucket.sql} = ?`);
        bindings.push(...(bucket.bindings as Knex.RawBinding[]), query.slice.date);
      }
      const direction = query.sort.descending ? 'DESC' : 'ASC';
      const order = `${
        CALL_SORT_SQL[query.sort.key]
      } ${direction} NULLS LAST, m."createdAt" ${direction}, m.id ${direction}`;
      const result = await trx.raw(
        `WITH ${callsSql(true)}, matched AS MATERIALIZED (SELECT m.* FROM calls m WHERE ${conditions.join(' AND ')})
        SELECT (SELECT count(*)::int FROM matched) AS total,
          (SELECT COALESCE(json_agg(x ORDER BY x.position), '[]'::json) FROM (
            SELECT m.*, row_number() OVER (ORDER BY ${order}) AS position
            FROM matched m ORDER BY ${order} LIMIT ? OFFSET ?) x) AS records,
          CURRENT_TIMESTAMP AS as_of`,
        [range.fromUtc, scan.fromUtc, scan.toUtc, ...bindings, query.limit, (query.page - 1) * query.limit]
      );
      const row = result.rows[0] as {
        total: number | string;
        records: Array<Record<string, unknown>>;
        as_of: Date | string;
      };
      const total = count(row.total);
      return {
        range,
        asOf: timestamp(row.as_of) ?? range.asOf,
        caveats: [...CAVEATS, ...RECORD_CAVEATS],
        slice: {
          tool: query.tool,
          userId: query.userId,
          client: query.client,
          outcome: query.outcome,
          date: query.slice.date,
          period: query.slice.period,
          sort: `${query.sort.key}:${query.sort.descending ? 'desc' : 'asc'}`,
        },
        records: row.records.map(mcpCallRecord),
        pagination: { page: query.page, limit: query.limit, total, hasMore: query.page * query.limit < total },
      };
    });
  }
}

function mcpCallRecord(entry: Record<string, unknown>): McpCallRecord {
  const target: McpCallTarget = {
    environmentUuid: text(entry.environment_uuid),
    environmentId: nullableNumber(entry.environment_id),
    siteId: text(entry.site_id),
    deployId: text(entry.deploy_id),
  };
  return {
    id: count(entry.id),
    createdAt: timestamp(entry.createdAt as string) ?? '',
    period: entry.period === 'previous' ? 'previous' : 'current',
    tool: String(entry.tool ?? 'unknown'),
    readOnly: typeof entry.read_only === 'boolean' ? entry.read_only : null,
    outcome: String(entry.outcome ?? 'unknown'),
    error: entry.is_error === true,
    durationMs: nullableNumber(entry.duration_ms),
    userId: text(entry.principalId),
    username: text(entry.username),
    client: String(entry.client ?? 'Unknown client'),
    clientId: text(entry.client_id),
    requestId: text(entry.request_id),
    target: Object.values(target).some((value) => value != null) ? target : null,
  };
}
