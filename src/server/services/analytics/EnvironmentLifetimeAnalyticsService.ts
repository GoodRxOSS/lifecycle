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
import { defaultDb } from 'server/lib/dependencies';
import { BadRequestError } from 'server/lib/appError';
import { analyticsTransaction } from './execution';
import { BuildStatus } from 'shared/constants';
import {
  environmentBase,
  currentEnvironmentQuery,
  parseEnvironmentAnalyticsQuery,
  parseEnvironmentAnalyticsScope,
  type AnalyticsRepositoryIdentity,
  type EnvironmentAnalyticsQuery,
  type EnvironmentAnalyticsScope,
} from './EnvironmentAnalyticsService';
import { analyticsBucketDates, resolveAnalyticsRange, type ResolvedAnalyticsRange } from './query';

export const ENVIRONMENT_LIFETIME_BINS = [
  { id: 'under_1h', label: 'Under 1 hour', fromHours: 0, toHours: 1 },
  { id: '1_to_6h', label: '1–6 hours', fromHours: 1, toHours: 6 },
  { id: '6_to_24h', label: '6–24 hours', fromHours: 6, toHours: 24 },
  { id: '1_to_3d', label: '1–3 days', fromHours: 24, toHours: 72 },
  { id: '3_to_7d', label: '3–7 days', fromHours: 72, toHours: 168 },
  { id: '7_to_30d', label: '7–30 days', fromHours: 168, toHours: 720 },
  { id: '30d_plus', label: '30 days or more', fromHours: 720, toHours: null },
] as const;

export const ENVIRONMENT_CURRENT_AGE_BINS = [
  ...ENVIRONMENT_LIFETIME_BINS.slice(0, -1),
  { id: '30_to_90d', label: '30–90 days', fromHours: 720, toHours: 2160 },
  { id: '90_to_180d', label: '90–180 days', fromHours: 2160, toHours: 4320 },
  { id: '180d_plus', label: '180 days or more', fromHours: 4320, toHours: null },
] as const;

export const ENVIRONMENT_LIFETIME_SCATTER_POINT_LIMIT = 5000;

export type EnvironmentLifetimeGroup = 'api' | 'pr' | 'other';
export type EnvironmentLifetimeMethod = 'created_to_deleted' | 'created_to_last_update' | 'first_record_age';
export type EnvironmentLifetimeQuality = 'recorded' | 'estimated' | 'record_age';
export type EnvironmentLifetimeSampleState = 'valid' | 'missing' | 'invalid';
export type EnvironmentLifetimeBin =
  | (typeof ENVIRONMENT_LIFETIME_BINS)[number]['id']
  | (typeof ENVIRONMENT_CURRENT_AGE_BINS)[number]['id']
  | 'missing'
  | 'invalid';
export type EnvironmentLifetimeStats = {
  method: EnvironmentLifetimeMethod;
  quality: EnvironmentLifetimeQuality;
  eligible: number;
  samples: number;
  missing: number;
  invalid: number;
  meanHours: number | null;
  medianHours: number | null;
  p90Hours: number | null;
  distribution: Array<{ id: string; label: string; fromHours: number; toHours: number | null; count: number }>;
};
export type EnvironmentLifetimeCompleted = { api: EnvironmentLifetimeStats; pr: EnvironmentLifetimeStats };
export type EnvironmentLifetimeAnalytics = {
  range: ResolvedAnalyticsRange;
  asOf: string;
  scope: EnvironmentAnalyticsScope;
  completed: EnvironmentLifetimeCompleted;
  previousCompleted: EnvironmentLifetimeCompleted | null;
  buckets: Array<{
    date: string;
    previousDate: string | null;
    current: EnvironmentLifetimeCompleted;
    previous: EnvironmentLifetimeCompleted | null;
  }>;
  currentAge: Record<'all' | EnvironmentLifetimeGroup, EnvironmentLifetimeStats>;
  unplacedRetirements: {
    api: { missingEnd: number; invalidEnd: number };
    pr: { missingEnd: number; invalidEnd: number };
    other: number;
  };
  caveats: string[];
};
export type EnvironmentLifetimeRecordsQuery = EnvironmentAnalyticsScope & {
  from?: string;
  to?: string;
  timezone?: string;
  compare?: boolean;
  interval?: 'day' | 'week';
  rankBy: EnvironmentAnalyticsQuery['rankBy'];
  cohort: 'completed' | 'current';
  group: 'all' | EnvironmentLifetimeGroup;
  bin: EnvironmentLifetimeBin | null;
  page: number;
  limit: number;
};
export type EnvironmentLifetimeRecord = AnalyticsRepositoryIdentity & {
  id: number;
  uuid: string | null;
  namespace: string | null;
  status: string | null;
  isStatic: boolean;
  author: string | null;
  repositoryAmbiguous: boolean;
  resourceAvailable: boolean;
  pullRequest: { number: number | null; title: string | null; author: string | null } | null;
  group: EnvironmentLifetimeGroup;
  method: EnvironmentLifetimeMethod;
  quality: EnvironmentLifetimeQuality;
  sampleState: EnvironmentLifetimeSampleState;
  startedAt: string | null;
  measuredUntilAt: string | null;
  durationHours: number | null;
};
export type EnvironmentLifetimeRecords = {
  asOf: string;
  scope: EnvironmentAnalyticsScope;
  range: ResolvedAnalyticsRange | null;
  cohort: 'completed' | 'current';
  group: 'all' | EnvironmentLifetimeGroup;
  bin: EnvironmentLifetimeBin | null;
  records: EnvironmentLifetimeRecord[];
  pagination: { page: number; limit: number; total: number; hasMore: boolean; maxPage: number; truncated: boolean };
  caveats: string[];
};
export type EnvironmentLifetimeScatterQuery = EnvironmentAnalyticsQuery & { group: 'all' | 'api' | 'pr' };
export type EnvironmentLifetimeScatterPoint = EnvironmentLifetimeRecord & {
  group: 'api' | 'pr';
  sampleState: 'valid';
  durationHours: number;
  measuredUntilAt: string;
};
export type EnvironmentLifetimeScatterCoverage = Pick<
  EnvironmentLifetimeStats,
  'method' | 'quality' | 'eligible' | 'samples' | 'missing' | 'invalid'
>;
export type EnvironmentLifetimeScatter = {
  asOf: string;
  scope: EnvironmentAnalyticsScope;
  range: ResolvedAnalyticsRange;
  group: 'all' | 'api' | 'pr';
  total: number;
  returned: number;
  pointLimit: typeof ENVIRONMENT_LIFETIME_SCATTER_POINT_LIMIT;
  truncated: boolean;
  state: 'ready' | 'empty' | 'over_limit';
  nextAction: string | null;
  coverage: { api: EnvironmentLifetimeScatterCoverage; pr: EnvironmentLifetimeScatterCoverage };
  points: EnvironmentLifetimeScatterPoint[];
  caveats: string[];
};

const MAX_PAGE = 10_000;
const CAVEATS = [
  'API record duration measures creation to recorded deletion. It includes records that never deployed and does not measure runtime lifetime.',
  'PR record duration estimates creation to the latest update of a torn-down record. It includes records that never deployed. Waiting time, later edits and reuse gaps can increase it.',
  'Current age is time since the first retained record. It includes queued, paused and failed time and can include earlier PR episodes.',
  'Retirement dates select completed samples. Missing or nonfinite end dates cannot be placed in a window; unplaced counts cover the entire selected scope.',
  'Counts cover retained environment records, not deployment attempts. Collection start and history completeness are unknown.',
];
type LifetimeAggregate = Record<string, unknown> & {
  group_name?: string;
  period?: string;
  bucket?: string | null;
};

const count = (value: unknown): number => {
  const result = value == null ? 0 : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid lifetime analytics count.');
  return result;
};
const nullableNumber = (value: unknown): number | null => {
  if (value == null) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
};
const timestamp = (value: unknown): string | null => {
  if (value == null) return null;
  const result = new Date(value as string | Date);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
};
const previousBucketDate = (date: string, range: ResolvedAnalyticsRange): string | null => {
  if (!range.previous) return null;
  const aligned = new Date(Date.parse(`${date}T00:00:00Z`) - range.calendarDays * 86_400_000).toISOString();
  return /^\d{4}-/.test(aligned) && !aligned.startsWith('0000-') ? aligned.slice(0, 10) : null;
};
function method(group: EnvironmentLifetimeGroup | 'all', cohort: 'completed' | 'current') {
  if (cohort === 'current') return { method: 'first_record_age' as const, quality: 'record_age' as const };
  return group === 'api'
    ? { method: 'created_to_deleted' as const, quality: 'recorded' as const }
    : { method: 'created_to_last_update' as const, quality: 'estimated' as const };
}

export function serializeEnvironmentLifetimeStats(
  group: EnvironmentLifetimeGroup | 'all',
  cohort: 'completed' | 'current',
  row?: LifetimeAggregate
): EnvironmentLifetimeStats {
  const samples = count(row?.samples);
  return {
    ...method(group, cohort),
    eligible: count(row?.eligible),
    samples,
    missing: count(row?.missing),
    invalid: count(row?.invalid),
    meanHours: samples ? nullableNumber(row?.mean_hours) : null,
    medianHours: samples ? nullableNumber(row?.median_hours) : null,
    p90Hours: samples ? nullableNumber(row?.p90_hours) : null,
    distribution: (cohort === 'current' ? ENVIRONMENT_CURRENT_AGE_BINS : ENVIRONMENT_LIFETIME_BINS).map((bin) => ({
      ...bin,
      count: count(row?.[bin.id]),
    })),
  };
}

export function parseEnvironmentLifetimeRecordsQuery(params: URLSearchParams): EnvironmentLifetimeRecordsQuery {
  const cohort = params.get('cohort') ?? 'completed';
  if (cohort !== 'completed' && cohort !== 'current')
    throw new BadRequestError('cohort must be completed or current.', 'invalid_query');
  const group = params.get('group') ?? 'all';
  if (!['all', 'api', 'pr', 'other'].includes(group) || (cohort === 'completed' && group === 'other'))
    throw new BadRequestError(
      'group must be all, api or pr; other is available for current age only.',
      'invalid_query'
    );
  const bin = params.get('bin');
  const bins =
    cohort === 'current' ? [...ENVIRONMENT_LIFETIME_BINS, ...ENVIRONMENT_CURRENT_AGE_BINS] : ENVIRONMENT_LIFETIME_BINS;
  if (bin !== null && !['missing', 'invalid', ...bins.map(({ id }) => id)].includes(bin))
    throw new BadRequestError('bin must be a lifetime histogram or coverage bucket.', 'invalid_query');
  const pageText = params.get('page') ?? '1',
    limitText = params.get('limit') ?? '25';
  const page = Number(pageText),
    limit = Number(limitText);
  if (
    !/^[1-9]\d*$/.test(pageText) ||
    !/^[1-9]\d*$/.test(limitText) ||
    !Number.isSafeInteger(page) ||
    page > MAX_PAGE ||
    !Number.isSafeInteger(limit) ||
    limit > 100
  )
    throw new BadRequestError('page must be between 1 and 10000 and limit between 1 and 100.', 'invalid_query');
  const query =
    cohort === 'current'
      ? { ...parseEnvironmentAnalyticsScope(params), rankBy: 'first_seen' as const }
      : parseEnvironmentAnalyticsQuery(params);
  return {
    ...query,
    cohort,
    group: group as EnvironmentLifetimeRecordsQuery['group'],
    bin: bin as EnvironmentLifetimeBin | null,
    page,
    limit,
  };
}

export function parseEnvironmentLifetimeScatterQuery(params: URLSearchParams): EnvironmentLifetimeScatterQuery {
  const group = params.get('group') ?? 'all';
  if (group !== 'all' && group !== 'api' && group !== 'pr')
    throw new BadRequestError('group must be all, api or pr.', 'invalid_query');
  return { ...parseEnvironmentAnalyticsQuery(params), compare: false, group };
}

function factsSql(
  knex: Knex,
  scope: EnvironmentAnalyticsScope,
  cohort: 'completed' | 'current'
): { sql: string; bindings: Knex.RawBinding[] } {
  let source = environmentBase(knex, scope).select('e.*', 'r.fullName', 'r.githubInstallationId');
  if (cohort === 'current') source = currentEnvironmentQuery(source);
  const compiled = source.toSQL();
  return {
    sql: `
      lifetime_source AS (${compiled.sql}),
      classified AS (
        SELECT *, CASE WHEN "triggerType" = 'api' THEN 'api'
          WHEN "hasPullRequest" THEN 'pr' ELSE 'other' END AS group_name
        FROM lifetime_source
      ), measured AS (
        SELECT *, "createdAt" AS start_at,
          ${
            cohort === 'current'
              ? 'CURRENT_TIMESTAMP'
              : `CASE WHEN group_name = 'api' THEN "deletedAt" WHEN group_name = 'pr' THEN "updatedAt" END`
          } AS end_at
        FROM classified
        ${
          cohort === 'completed'
            ? `WHERE (group_name = 'api' AND ("deletedAt" IS NOT NULL OR status = ?)) OR (group_name = 'pr' AND status = ?) OR (group_name = 'other' AND ("deletedAt" IS NOT NULL OR status = ?))`
            : ''
        }
      ), evaluated AS (
        SELECT *, CASE WHEN start_at IS NULL OR end_at IS NULL THEN 'missing'
          WHEN NOT isfinite(start_at) OR NOT isfinite(end_at) OR end_at < start_at OR end_at > CURRENT_TIMESTAMP THEN 'invalid'
          ELSE 'valid' END AS sample_state
        FROM measured
      ), facts AS (
        SELECT *, CASE WHEN sample_state = 'valid' THEN EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0 END::double precision AS duration_hours
        FROM evaluated
      )`,
    bindings: [
      ...compiled.bindings,
      ...(cohort === 'current' ? [] : [BuildStatus.TORN_DOWN, BuildStatus.TORN_DOWN, BuildStatus.TORN_DOWN]),
    ],
  };
}

function aggregateSql(cohort: 'completed' | 'current'): string {
  const bins = cohort === 'current' ? ENVIRONMENT_CURRENT_AGE_BINS : ENVIRONMENT_LIFETIME_BINS;
  return `COUNT(*) AS eligible,
  COUNT(*) FILTER (WHERE sample_state = 'valid') AS samples,
  COUNT(*) FILTER (WHERE sample_state = 'missing') AS missing,
  COUNT(*) FILTER (WHERE sample_state = 'invalid') AS invalid,
  AVG(duration_hours) AS mean_hours,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_hours) AS median_hours,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_hours) AS p90_hours,
  ${bins
    .map(
      (bin) =>
        `COUNT(*) FILTER (WHERE duration_hours >= ${bin.fromHours}${
          bin.toHours === null ? '' : ` AND duration_hours < ${bin.toHours}`
        }) AS "${bin.id}"`
    )
    .join(',\n  ')}`;
}

const RECORD_JSON_SQL = `jsonb_build_object(
  'id', id, 'uuid', uuid, 'namespace', namespace, 'status', status, 'isStatic', COALESCE("isStatic", false),
  'author', author, 'repositoryId', "repositoryId", 'fullName', "fullName",
  'githubInstallationId', "githubInstallationId", 'repositoryAmbiguous', "repositoryAmbiguous",
  'resourceAvailable', ("deletedAt" IS NULL AND (status IS NULL OR status <> ?) AND NULLIF(uuid, '') IS NOT NULL),
  'pullRequest', CASE WHEN group_name = 'pr' THEN jsonb_build_object(
    'number', "pullRequestNumber", 'title', "prTitle", 'author', "prAuthor") END,
  'group', group_name, 'sampleState', sample_state,
  'startedAt', CASE WHEN isfinite(start_at) THEN start_at END,
  'measuredUntilAt', CASE WHEN isfinite(end_at) THEN end_at END, 'durationHours', duration_hours
)`;

function serializeRecord(
  record: EnvironmentLifetimeRecord,
  cohort: 'completed' | 'current'
): EnvironmentLifetimeRecord {
  return {
    ...record,
    ...method(record.group, cohort),
    id: count(record.id),
    namespace: record.namespace ?? null,
    repositoryId: record.repositoryId == null ? null : count(record.repositoryId),
    githubInstallationId: record.githubInstallationId == null ? null : count(record.githubInstallationId),
    durationHours: nullableNumber(record.durationHours),
    startedAt: timestamp(record.startedAt),
    measuredUntilAt: timestamp(record.measuredUntilAt),
  };
}

function scopeOf(query: EnvironmentAnalyticsScope): EnvironmentAnalyticsScope {
  return {
    repositoryId: query.repositoryId,
    organization: query.organization,
    environmentType: query.environmentType,
    environmentAuthor: query.environmentAuthor,
    unattributed: query.unattributed,
  };
}

export default class EnvironmentLifetimeAnalyticsService {
  constructor(private readonly db: Pick<Database, 'knex'> = defaultDb) {}

  async getSummary(query: EnvironmentAnalyticsQuery): Promise<EnvironmentLifetimeAnalytics> {
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = await resolveAnalyticsRange(trx, query);
      const scope = scopeOf(query);
      const completed = factsSql(trx, scope, 'completed');
      const result = await trx.raw(
        `WITH ${completed.sql}, period_facts AS (
          SELECT *, CASE WHEN end_at >= ?::timestamptz THEN 'current' ELSE 'previous' END AS period,
            to_char(date_trunc(?, (end_at AT TIME ZONE ?) +
              (CASE WHEN end_at < ?::timestamptz THEN ?::int ELSE 0 END * interval '1 day')), 'YYYY-MM-DD') AS bucket
          FROM facts WHERE group_name IN ('api','pr') AND isfinite(end_at)
            AND end_at >= ?::timestamptz AND end_at < ?::timestamptz
        ) SELECT period, group_name, bucket, ${aggregateSql('completed')}
          FROM period_facts GROUP BY GROUPING SETS ((period,group_name), (period,group_name,bucket))`,
        [
          ...completed.bindings,
          range.fromUtc,
          range.interval,
          range.timezone,
          range.fromUtc,
          range.calendarDays,
          range.previous?.fromUtc ?? range.fromUtc,
          range.toUtc,
        ]
      );
      const current = factsSql(trx, scope, 'current');
      const currentResult = await trx.raw(
        `WITH ${current.sql} SELECT COALESCE(group_name, 'all') AS group_name, ${aggregateSql('current')}
          FROM facts GROUP BY GROUPING SETS ((group_name), ())`,
        current.bindings
      );
      const unplacedResult = await trx.raw(
        `WITH ${completed.sql} SELECT group_name,
          COUNT(*) FILTER (WHERE end_at IS NULL) AS missing_end,
          COUNT(*) FILTER (WHERE end_at IS NOT NULL AND NOT isfinite(end_at)) AS invalid_end,
          COUNT(*) AS total FROM facts GROUP BY group_name`,
        completed.bindings
      );
      const rows = result.rows as LifetimeAggregate[];
      const groupStats = (period: string, bucket: string | null): EnvironmentLifetimeCompleted => ({
        api: serializeEnvironmentLifetimeStats(
          'api',
          'completed',
          rows.find((row) => row.period === period && row.bucket === bucket && row.group_name === 'api')
        ),
        pr: serializeEnvironmentLifetimeStats(
          'pr',
          'completed',
          rows.find((row) => row.period === period && row.bucket === bucket && row.group_name === 'pr')
        ),
      });
      const dates = analyticsBucketDates(range);
      const unplaced = (group: string) => unplacedResult.rows.find((row) => row.group_name === group);
      return {
        range,
        asOf: range.asOf,
        scope,
        completed: groupStats('current', null),
        previousCompleted: range.previous ? groupStats('previous', null) : null,
        buckets: dates.map((date) => ({
          date,
          previousDate: previousBucketDate(date, range),
          current: groupStats('current', date),
          previous: range.previous ? groupStats('previous', date) : null,
        })),
        currentAge: Object.fromEntries(
          ['all', 'api', 'pr', 'other'].map((group: 'all' | EnvironmentLifetimeGroup) => [
            group,
            serializeEnvironmentLifetimeStats(
              group,
              'current',
              currentResult.rows.find((row) => row.group_name === group)
            ),
          ])
        ) as EnvironmentLifetimeAnalytics['currentAge'],
        unplacedRetirements: {
          api: { missingEnd: count(unplaced('api')?.missing_end), invalidEnd: count(unplaced('api')?.invalid_end) },
          pr: { missingEnd: count(unplaced('pr')?.missing_end), invalidEnd: count(unplaced('pr')?.invalid_end) },
          other: count(unplaced('other')?.total),
        },
        caveats: CAVEATS,
      };
    });
  }

  async getScatter(query: EnvironmentLifetimeScatterQuery): Promise<EnvironmentLifetimeScatter> {
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = await resolveAnalyticsRange(trx, { ...query, compare: false });
      const scope = scopeOf(query);
      const facts = factsSql(trx, scope, 'completed');
      const groupPredicate = query.group === 'all' ? '' : 'AND group_name = ?';
      const result = await trx.raw(
        `WITH ${facts.sql}, windowed AS MATERIALIZED (
          SELECT id, uuid, namespace, status, "isStatic", author, "repositoryId", "fullName", "githubInstallationId",
            "repositoryAmbiguous", "deletedAt", "pullRequestNumber", "prTitle", "prAuthor",
            group_name, start_at, end_at, sample_state, duration_hours
          FROM facts WHERE group_name IN ('api','pr') AND isfinite(end_at)
            AND end_at >= ?::timestamptz AND end_at < ?::timestamptz ${groupPredicate}
        ), coverage AS (
          SELECT group_name, COUNT(*) AS eligible,
            COUNT(*) FILTER (WHERE sample_state = 'valid') AS samples,
            COUNT(*) FILTER (WHERE sample_state = 'missing') AS missing,
            COUNT(*) FILTER (WHERE sample_state = 'invalid') AS invalid
          FROM windowed GROUP BY group_name
        ), limits AS (
          SELECT COALESCE(SUM(samples), 0) AS total FROM coverage
        ) SELECT total, COALESCE((SELECT jsonb_agg(to_jsonb(coverage)) FROM coverage), '[]'::jsonb) AS coverage,
          CASE WHEN total <= ? THEN (
            SELECT COALESCE(jsonb_agg(${RECORD_JSON_SQL} ORDER BY end_at, id), '[]'::jsonb)
            FROM (SELECT * FROM windowed WHERE sample_state = 'valid' ORDER BY end_at, id LIMIT ?) points
          ) ELSE '[]'::jsonb END AS points
          FROM limits`,
        [
          ...facts.bindings,
          range.fromUtc,
          range.toUtc,
          ...(query.group === 'all' ? [] : [query.group]),
          ENVIRONMENT_LIFETIME_SCATTER_POINT_LIMIT,
          BuildStatus.TORN_DOWN,
          ENVIRONMENT_LIFETIME_SCATTER_POINT_LIMIT,
        ]
      );
      const row = result.rows[0];
      const total = count(row.total);
      const truncated = total > ENVIRONMENT_LIFETIME_SCATTER_POINT_LIMIT;
      const points: EnvironmentLifetimeScatterPoint[] = row.points.map((raw) => {
        const point = serializeRecord(raw, 'completed');
        if (
          (point.group !== 'api' && point.group !== 'pr') ||
          point.sampleState !== 'valid' ||
          point.durationHours === null ||
          point.measuredUntilAt === null
        )
          throw new Error('Invalid lifetime scatter point.');
        return {
          ...point,
          group: point.group,
          sampleState: 'valid',
          durationHours: point.durationHours,
          measuredUntilAt: point.measuredUntilAt,
        };
      });
      if (points.length !== (truncated ? 0 : total)) throw new Error('Incomplete lifetime scatter result.');
      const coverage = (group: 'api' | 'pr'): EnvironmentLifetimeScatterCoverage => {
        const values = row.coverage.find((entry) => entry.group_name === group);
        return {
          ...method(group, 'completed'),
          eligible: count(values?.eligible),
          samples: count(values?.samples),
          missing: count(values?.missing),
          invalid: count(values?.invalid),
        };
      };
      return {
        asOf: range.asOf,
        scope,
        range,
        group: query.group,
        total,
        returned: points.length,
        pointLimit: ENVIRONMENT_LIFETIME_SCATTER_POINT_LIMIT,
        truncated,
        state: truncated ? 'over_limit' : total ? 'ready' : 'empty',
        nextAction: truncated ? 'Select a shorter time window or more filters.' : null,
        coverage: { api: coverage('api'), pr: coverage('pr') },
        points,
        caveats: CAVEATS,
      };
    });
  }

  async getRecords(query: EnvironmentLifetimeRecordsQuery): Promise<EnvironmentLifetimeRecords> {
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = query.cohort === 'completed' ? await resolveAnalyticsRange(trx, query) : null;
      const asOf = range?.asOf ?? timestamp((await trx.raw('SELECT CURRENT_TIMESTAMP AS "asOf"')).rows[0].asOf)!;
      const scope = scopeOf(query);
      const facts = factsSql(trx, scope, query.cohort);
      const predicates: string[] = [];
      const bindings: Knex.RawBinding[] = [...facts.bindings];
      if (range) {
        predicates.push(
          `group_name IN ('api','pr') AND isfinite(end_at) AND end_at >= ?::timestamptz AND end_at < ?::timestamptz`
        );
        bindings.push(range.fromUtc, range.toUtc);
      }
      if (query.group !== 'all') {
        predicates.push('group_name = ?');
        bindings.push(query.group);
      }
      if (query.bin === 'missing' || query.bin === 'invalid') {
        predicates.push('sample_state = ?');
        bindings.push(query.bin);
      } else if (query.bin) {
        const bin = [...ENVIRONMENT_LIFETIME_BINS, ...ENVIRONMENT_CURRENT_AGE_BINS].find(({ id }) => id === query.bin)!;
        predicates.push('duration_hours >= ?');
        bindings.push(bin.fromHours);
        if (bin.toHours !== null) {
          predicates.push('duration_hours < ?');
          bindings.push(bin.toHours);
        }
      }
      const result = await trx.raw(
        `WITH ${facts.sql}, selected AS MATERIALIZED (
          SELECT * FROM facts ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
        ), page AS (
          SELECT * FROM selected ORDER BY duration_hours DESC NULLS LAST, end_at DESC NULLS LAST, id DESC LIMIT ? OFFSET ?
        ) SELECT (SELECT COUNT(*) FROM selected) AS total,
          COALESCE((SELECT jsonb_agg(${RECORD_JSON_SQL}
            ORDER BY duration_hours DESC NULLS LAST, end_at DESC NULLS LAST, id DESC) FROM page), '[]'::jsonb) AS records`,
        [...bindings, query.limit, (query.page - 1) * query.limit, BuildStatus.TORN_DOWN]
      );
      const row = result.rows[0];
      const total = count(row.total);
      return {
        asOf,
        scope,
        range,
        cohort: query.cohort,
        group: query.group,
        bin: query.bin,
        records: row.records.map((record) => serializeRecord(record, query.cohort)),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          hasMore: query.page < MAX_PAGE && query.page * query.limit < total,
          maxPage: MAX_PAGE,
          truncated: total > MAX_PAGE * query.limit,
        },
        caveats: CAVEATS,
      };
    });
  }
}
