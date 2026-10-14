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
import type { ServiceRunOutcome } from '../buildEvents';
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
import {
  environmentBase,
  parseEnvironmentAnalyticsScope,
  type AnalyticsRepositoryIdentity,
  type EnvironmentAnalyticsScope,
} from './EnvironmentAnalyticsService';

export const DEPLOYMENT_ORIGINS = [
  'push',
  'label',
  'pr_open',
  'config_push',
  'api',
  'redeploy',
  'mcp',
  'comment',
  'agent',
  'unknown',
] as const;
export type DeploymentOrigin = (typeof DEPLOYMENT_ORIGINS)[number];
export const DEPLOYMENT_OUTCOMES = ['succeeded', 'failed', 'superseded', 'blocked', 'torn_down', 'unresolved'] as const;
export type DeploymentOutcome = (typeof DEPLOYMENT_OUTCOMES)[number];

export type DeploymentAnalyticsQuery = AnalyticsCalendarQuery & EnvironmentAnalyticsScope;
export const DEPLOYMENT_REQUEST_SORTS = ['requestedAt', 'timeToReady', 'queueWait'] as const;
export type DeploymentRequestSort = (typeof DEPLOYMENT_REQUEST_SORTS)[number];
export type DeploymentRequestsQuery = DeploymentAnalyticsQuery & {
  outcomes: DeploymentOutcome[];
  origin: DeploymentOrigin | null;
  reason: string | null;
  slice: AnalyticsSlice;
  sort: AnalyticsSort<DeploymentRequestSort>;
  page: number;
  limit: number;
};

export interface DeploymentPercentiles {
  samples: number;
  p50Minutes: number | null;
  p90Minutes: number | null;
}
export interface DeploymentTotals {
  requested: number;
  claimed: number;
  succeeded: number;
  failed: number;
  superseded: number;
  blocked: number;
  tornDown: number;
  unresolved: number;
  successRate: number | null;
  timeToReady: DeploymentPercentiles;
  queueWait: DeploymentPercentiles;
}
export interface DeploymentAnalyticsBucket {
  date: string;
  requested: number;
  succeeded: number;
  failed: number;
  previousRequested: number | null;
  previousSucceeded: number | null;
  previousFailed: number | null;
}
export interface DeploymentRepositoryRow extends AnalyticsRepositoryIdentity {
  requested: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  timeToReadyP50Minutes: number | null;
}
export interface DeploymentOriginRow {
  origin: DeploymentOrigin;
  requested: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
}
export interface DeploymentAnalytics {
  range: ResolvedAnalyticsRange;
  scope: EnvironmentAnalyticsScope;
  asOf: string;
  caveats: string[];
  collectionStartedAt: string | null;
  totals: DeploymentTotals;
  previousTotals: DeploymentTotals | null;
  buckets: DeploymentAnalyticsBucket[];
  repositories: { items: DeploymentRepositoryRow[]; total: number; limit: number };
  origins: DeploymentOriginRow[];
  failureReasons: { items: { reason: string; count: number }[]; total: number; limit: number };
}
export interface DeploymentRequestRecord extends AnalyticsRepositoryIdentity {
  requestId: string;
  id: number;
  uuid: string | null;
  namespace: string | null;
  isStatic: boolean;
  resourceAvailable: boolean;
  pullRequest: { number: number | null; title: string | null; author: string | null } | null;
  origin: DeploymentOrigin;
  period: AnalyticsSlicePeriod;
  requestedAt: string;
  outcome: DeploymentOutcome;
  claimedAt: string | null;
  blockedAt: string | null;
  supersededAt: string | null;
  decidedAt: string | null;
  readyAt: string | null;
  queueWaitMinutes: number | null;
  timeToReadyMinutes: number | null;
  services: number | null;
  failed: number | null;
  exitReason: string | null;
  reason: string | null;
  serviceOutcomes: ServiceRunOutcome[] | null;
}
export interface DeploymentRequestsSlice {
  outcomes: DeploymentOutcome[];
  origin: DeploymentOrigin | null;
  reason: string | null;
  date: string | null;
  period: AnalyticsSlicePeriod;
  sort: string;
}
export interface DeploymentRequests {
  range: ResolvedAnalyticsRange;
  scope: EnvironmentAnalyticsScope;
  asOf: string;
  caveats: string[];
  slice: DeploymentRequestsSlice;
  records: DeploymentRequestRecord[];
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
}

export const DEPLOYMENT_REPOSITORY_LIMIT = 20;
export const DEPLOYMENT_REASON_LIMIT = 10;
const CAVEATS = [
  'Deploy requests are counted from the first recorded request. Deploys before that date are not included.',
  'A request succeeds when its run finishes with every service it deployed ready. A newer request for the same services can supersede it before it finishes.',
  'Time to ready runs from the request to its run finishing with every service ready. Queue wait runs from the request to the start of its run.',
  'A PR opened with the deploy label can record two requests. The first is superseded.',
];
const RECORD_CAVEATS = [
  'Each row shows what its run recorded. Open the environment for its current state.',
  'Older runs show service counts only.',
];
const REQUEST_SORT_SQL: Record<DeploymentRequestSort, string> = {
  requestedAt: 'm.requested_at',
  timeToReady: 'm.ready_minutes',
  queueWait: 'm.wait_minutes',
};
const TEARDOWN_BLOCKS = `('tearing_down', 'torn_down', 'pull_request_closed', 'build_deleted', 'build_missing')`;
const RUN_EVENTS = `('run_claimed', 'run_blocked', 'run_superseded', 'run_finished')`;
const ROLLOUT_FINISH = `(COALESCE(e.meta->>'rollout', 'false') = 'true')`;
const FINISH_ORDER = `ORDER BY ${ROLLOUT_FINISH} DESC, CASE WHEN ${ROLLOUT_FINISH} THEN e."createdAt" END DESC, e."createdAt", e.id`;
const KNOWN_ORIGINS = `('push', 'label', 'pr_open', 'config_push', 'api', 'redeploy', 'mcp', 'comment', 'agent')`;

type PeriodRow = Record<string, unknown> & { period: string };
type SummaryRow = {
  periods: PeriodRow[];
  buckets: Array<Record<string, unknown> & { period: string; bucket: string }>;
  repositories: Array<Record<string, unknown>>;
  repository_total: number | string;
  origins: Array<Record<string, unknown>>;
  reasons: Array<{ reason: string; count: number | string }>;
  reason_total: number | string;
  collection_started_at: Date | string | null;
  as_of: Date | string;
};

const count = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return parsed;
};
const nullableNumber = (value: unknown): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const timestamp = (value: Date | string | null | undefined): string | null => {
  if (value == null) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
const rate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;
const origin = (value: unknown): DeploymentOrigin =>
  DEPLOYMENT_ORIGINS.includes(value as DeploymentOrigin) ? (value as DeploymentOrigin) : 'unknown';

export function parseDeploymentAnalyticsQuery(params: URLSearchParams): DeploymentAnalyticsQuery {
  return { ...parseAnalyticsCalendarQuery(params), ...parseEnvironmentAnalyticsScope(params) };
}

export function parseDeploymentRequestsQuery(params: URLSearchParams): DeploymentRequestsQuery {
  const outcomeValue = params.get('outcome');
  const outcomes = [...new Set(outcomeValue ? outcomeValue.split(',') : [])] as DeploymentOutcome[];
  if (outcomes.some((value) => !DEPLOYMENT_OUTCOMES.includes(value))) {
    throw new BadRequestError(
      `outcome must be a comma-separated list of ${DEPLOYMENT_OUTCOMES.join(', ')}.`,
      'invalid_query'
    );
  }
  const originValue = params.get('origin');
  if (originValue != null && !DEPLOYMENT_ORIGINS.includes(originValue as DeploymentOrigin)) {
    throw new BadRequestError(`origin must be one of ${DEPLOYMENT_ORIGINS.join(', ')}.`, 'invalid_query');
  }
  const reason = params.get('reason')?.trim();
  if (reason != null && (!reason || Array.from(reason).length > 300)) {
    throw new BadRequestError('reason must be a recorded failure reason of at most 300 characters.', 'invalid_query');
  }
  return {
    ...parseDeploymentAnalyticsQuery(params),
    outcomes,
    origin: originValue as DeploymentOrigin | null,
    reason: reason ?? null,
    slice: parseAnalyticsSlice(params),
    sort: parseAnalyticsSort(params, DEPLOYMENT_REQUEST_SORTS, 'requestedAt'),
    ...parseAnalyticsPagination(params),
  };
}

export function serializeDeploymentTotals(row?: Record<string, unknown>): DeploymentTotals {
  const succeeded = count(row?.succeeded);
  const failed = count(row?.failed);
  return {
    requested: count(row?.requested),
    claimed: count(row?.claimed),
    succeeded,
    failed,
    superseded: count(row?.superseded),
    blocked: count(row?.blocked),
    tornDown: count(row?.torn_down),
    unresolved: count(row?.unresolved),
    successRate: rate(succeeded, succeeded + failed),
    timeToReady: {
      samples: count(row?.ready_samples),
      p50Minutes: nullableNumber(row?.ready_p50),
      p90Minutes: nullableNumber(row?.ready_p90),
    },
    queueWait: {
      samples: count(row?.wait_samples),
      p50Minutes: nullableNumber(row?.wait_p50),
      p90Minutes: nullableNumber(row?.wait_p90),
    },
  };
}

/**
 * One row per deploy request, resolved through the run that carries its request id: the run's
 * claim, block, supersession and finish are matched by id, never by time. A retried run may
 * finish more than once: the last finish that followed a rollout decides, else the first, and
 * time to ready runs to the first finish that reported success. A teardown that stops a run
 * mid-way is recorded on its supersession; one that follows an unclaimed request shows on the record.
 */
function requestFactsSql(
  knex: Knex,
  scope: EnvironmentAnalyticsScope,
  range: ResolvedAnalyticsRange,
  scan: { fromUtc: string; toUtc: string } = { fromUtc: range.previous?.fromUtc ?? range.fromUtc, toUtc: range.toUtc }
): { sql: string; bindings: Knex.RawBinding[] } {
  const scoped = environmentBase(knex, scope)
    .select('e.id', 'e.repositoryId', 'r.fullName', 'r.githubInstallationId', 'e.lastTornDownAt')
    .toSQL();
  return {
    sql: `scoped AS (${scoped.sql}),
      requests AS (
        SELECT ev.id, ev."buildId", ev."runUUID" AS request_id,
          CASE WHEN ev.origin IN ${KNOWN_ORIGINS} THEN ev.origin ELSE 'unknown' END AS origin,
          ev."createdAt" AS requested_at, s."repositoryId", s."fullName", s."githubInstallationId",
          s."lastTornDownAt" AS torn_down_at,
          CASE WHEN ev."createdAt" >= ?::timestamptz THEN 'current' ELSE 'previous' END AS period
        FROM build_events ev
        JOIN scoped s ON s.id = ev."buildId"
        WHERE ev.kind = 'deploy_requested' AND ev."runUUID" IS NOT NULL
          AND ev."createdAt" >= ?::timestamptz AND ev."createdAt" < ?::timestamptz
      ), runs AS MATERIALIZED (
        SELECT r.*, x.claimed_at, x.blocked_at, x.blocked_reason, x.superseded_at, x.superseded_block,
          x.first_succeeded_at, x.finished_status, x.finished_reason, x.services
        FROM requests r
        LEFT JOIN LATERAL (
          SELECT min(e."createdAt") FILTER (WHERE e.kind = 'run_claimed') AS claimed_at,
            min(e."createdAt") FILTER (WHERE e.kind = 'run_blocked') AS blocked_at,
            (array_agg(e.reason ORDER BY e."createdAt", e.id) FILTER (WHERE e.kind = 'run_blocked'))[1] AS blocked_reason,
            min(e."createdAt") FILTER (WHERE e.kind = 'run_superseded') AS superseded_at,
            (array_agg(e.meta->>'blocked' ORDER BY e."createdAt", e.id) FILTER (WHERE e.kind = 'run_superseded'))[1] AS superseded_block,
            min(e."createdAt") FILTER (WHERE e.kind = 'run_finished' AND e.status = 'succeeded') AS first_succeeded_at,
            (array_agg(e.status ${FINISH_ORDER}) FILTER (WHERE e.kind = 'run_finished'))[1] AS finished_status,
            (array_agg(e.reason ${FINISH_ORDER}) FILTER (WHERE e.kind = 'run_finished'))[1] AS finished_reason,
            (array_agg((e.meta->>'services')::int ${FINISH_ORDER}) FILTER (WHERE e.kind = 'run_finished'))[1] AS services
          FROM build_events e
          WHERE e."buildId" = r."buildId" AND e."runUUID" = r.request_id AND e.kind IN ${RUN_EVENTS}
        ) x ON true
      ), facts AS MATERIALIZED (
        SELECT *,
          CASE WHEN finished_status IN ('succeeded', 'failed') THEN finished_status
            WHEN blocked_at IS NOT NULL AND blocked_reason IN ${TEARDOWN_BLOCKS} THEN 'torn_down'
            WHEN blocked_at IS NOT NULL THEN 'blocked'
            WHEN superseded_at IS NOT NULL AND superseded_block IN ${TEARDOWN_BLOCKS} THEN 'torn_down'
            WHEN superseded_at IS NOT NULL THEN 'superseded'
            WHEN torn_down_at > requested_at THEN 'torn_down'
            ELSE 'unresolved' END AS outcome
        FROM runs
      ), measured AS MATERIALIZED (
        SELECT *,
          CASE WHEN outcome = 'succeeded' AND first_succeeded_at IS NOT NULL AND COALESCE(services, 1) > 0
            THEN GREATEST(0, EXTRACT(EPOCH FROM (first_succeeded_at - requested_at)) / 60.0) END AS ready_minutes,
          CASE WHEN claimed_at IS NOT NULL
            THEN GREATEST(0, EXTRACT(EPOCH FROM (claimed_at - requested_at)) / 60.0) END AS wait_minutes,
          COALESCE(NULLIF(btrim(left(regexp_replace(btrim(finished_reason), '\\m[0-9a-f]{6,}\\M|\\d+', '#', 'g'), 120)), ''),
            'No reason recorded') AS reason
        FROM facts
      )`,
    bindings: [...scoped.bindings, range.fromUtc, scan.fromUtc, scan.toUtc],
  };
}

const OUTCOME_COUNTS = `count(*)::int AS requested,
  count(*) FILTER (WHERE outcome = 'succeeded')::int AS succeeded,
  count(*) FILTER (WHERE outcome = 'failed')::int AS failed`;

export default class DeploymentAnalyticsService {
  constructor(private readonly db: Pick<Database, 'knex'> = defaultDb) {}

  async getSummary(query: DeploymentAnalyticsQuery): Promise<DeploymentAnalytics> {
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = await resolveAnalyticsRange(trx, query);
      const facts = requestFactsSql(trx, query, range);
      const result = await trx.raw(
        `WITH ${facts.sql}
        SELECT
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT period, ${OUTCOME_COUNTS},
              count(claimed_at)::int AS claimed,
              count(*) FILTER (WHERE outcome = 'superseded')::int AS superseded,
              count(*) FILTER (WHERE outcome = 'blocked')::int AS blocked,
              count(*) FILTER (WHERE outcome = 'torn_down')::int AS torn_down,
              count(*) FILTER (WHERE outcome = 'unresolved')::int AS unresolved,
              count(ready_minutes)::int AS ready_samples,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ready_minutes) AS ready_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY ready_minutes) AS ready_p90,
              count(wait_minutes)::int AS wait_samples,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_minutes) AS wait_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_minutes) AS wait_p90
            FROM measured GROUP BY period) x) AS periods,
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT period, to_char(date_trunc(?, (requested_at AT TIME ZONE ?) +
              (CASE WHEN period = 'previous' THEN ?::int ELSE 0 END * interval '1 day')), 'YYYY-MM-DD') AS bucket,
              ${OUTCOME_COUNTS}
            FROM measured GROUP BY period, bucket) x) AS buckets,
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT "repositoryId", "fullName", "githubInstallationId", ${OUTCOME_COUNTS},
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ready_minutes) AS ready_p50
            FROM measured WHERE period = 'current'
            GROUP BY "repositoryId", "fullName", "githubInstallationId"
            ORDER BY requested DESC, "fullName" NULLS LAST, "repositoryId" NULLS LAST LIMIT ${DEPLOYMENT_REPOSITORY_LIMIT}) x) AS repositories,
          (SELECT count(*)::int FROM (
            SELECT 1 FROM measured WHERE period = 'current' GROUP BY "repositoryId", "fullName", "githubInstallationId") y) AS repository_total,
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT origin, ${OUTCOME_COUNTS}
            FROM measured WHERE period = 'current' GROUP BY origin ORDER BY requested DESC, origin) x) AS origins,
          (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
            SELECT reason, count(*)::int AS count FROM measured WHERE period = 'current' AND outcome = 'failed'
            GROUP BY reason ORDER BY count DESC, reason LIMIT ${DEPLOYMENT_REASON_LIMIT}) x) AS reasons,
          (SELECT count(DISTINCT reason)::int FROM measured WHERE period = 'current' AND outcome = 'failed') AS reason_total,
          (SELECT min("createdAt") FROM build_events WHERE kind = 'deploy_requested') AS collection_started_at,
          CURRENT_TIMESTAMP AS as_of`,
        [...facts.bindings, range.interval, range.timezone, range.calendarDays]
      );
      const row = result.rows[0] as SummaryRow;
      const period = (name: string) => row.periods.find((entry) => entry.period === name);
      const bucketRows = (name: string) => row.buckets.filter((entry) => entry.period === name);
      const current = new Map(bucketRows('current').map((entry) => [entry.bucket, entry]));
      const previous = new Map(bucketRows('previous').map((entry) => [entry.bucket, entry]));
      return {
        range,
        scope: {
          repositoryId: query.repositoryId,
          organization: query.organization,
          environmentType: query.environmentType,
          environmentAuthor: query.environmentAuthor,
          unattributed: query.unattributed,
        },
        asOf: timestamp(row.as_of) ?? range.asOf,
        caveats: CAVEATS,
        collectionStartedAt: timestamp(row.collection_started_at),
        totals: serializeDeploymentTotals(period('current')),
        previousTotals: range.previous ? serializeDeploymentTotals(period('previous')) : null,
        buckets: analyticsBucketDates(range).map((date) => {
          const now = current.get(date);
          const prior = previous.get(date);
          return {
            date,
            requested: count(now?.requested),
            succeeded: count(now?.succeeded),
            failed: count(now?.failed),
            previousRequested: range.previous ? count(prior?.requested) : null,
            previousSucceeded: range.previous ? count(prior?.succeeded) : null,
            previousFailed: range.previous ? count(prior?.failed) : null,
          };
        }),
        repositories: {
          items: row.repositories.map((entry) => {
            const succeeded = count(entry.succeeded);
            const failed = count(entry.failed);
            return {
              repositoryId: entry.repositoryId == null ? null : count(entry.repositoryId),
              fullName: entry.fullName == null ? null : String(entry.fullName),
              githubInstallationId: entry.githubInstallationId == null ? null : count(entry.githubInstallationId),
              requested: count(entry.requested),
              succeeded,
              failed,
              successRate: rate(succeeded, succeeded + failed),
              timeToReadyP50Minutes: nullableNumber(entry.ready_p50),
            };
          }),
          total: count(row.repository_total),
          limit: DEPLOYMENT_REPOSITORY_LIMIT,
        },
        origins: row.origins.map((entry) => {
          const succeeded = count(entry.succeeded);
          const failed = count(entry.failed);
          return {
            origin: origin(entry.origin),
            requested: count(entry.requested),
            succeeded,
            failed,
            successRate: rate(succeeded, succeeded + failed),
          };
        }),
        failureReasons: {
          items: row.reasons.map((entry) => ({ reason: String(entry.reason), count: count(entry.count) })),
          total: count(row.reason_total),
          limit: DEPLOYMENT_REASON_LIMIT,
        },
      };
    });
  }

  /** Lists the rows behind a summary number: the same facts, cut by the slice the number was read from. */
  async getRequests(query: DeploymentRequestsQuery): Promise<DeploymentRequests> {
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = await resolveAnalyticsRange(trx, query);
      const facts = requestFactsSql(trx, query, range, analyticsSliceScan(range, query.slice));
      const conditions = ['m.period = ?'];
      const bindings: Knex.RawBinding[] = [query.slice.period];
      if (query.outcomes.length) {
        conditions.push(`m.outcome IN (${query.outcomes.map(() => '?').join(', ')})`);
        bindings.push(...query.outcomes);
      }
      if (query.origin) {
        conditions.push('m.origin = ?');
        bindings.push(query.origin);
      }
      if (query.reason != null) {
        conditions.push(`m.outcome = 'failed' AND m.reason = ?`);
        bindings.push(query.reason);
      }
      if (query.slice.date) {
        const bucket = analyticsBucketExpression(trx, range, 'm.requested_at', query.slice.period).toSQL();
        conditions.push(`${bucket.sql} = ?`);
        bindings.push(...(bucket.bindings as Knex.RawBinding[]), query.slice.date);
      }
      const direction = query.sort.descending ? 'DESC' : 'ASC';
      const order = `${
        REQUEST_SORT_SQL[query.sort.key]
      } ${direction} NULLS LAST, m.requested_at ${direction}, m.id ${direction}`;
      const result = await trx.raw(
        `WITH ${facts.sql}, matched AS MATERIALIZED (SELECT m.* FROM measured m WHERE ${conditions.join(' AND ')})
        SELECT (SELECT count(*)::int FROM matched) AS total,
          (SELECT COALESCE(json_agg(x ORDER BY x.position), '[]'::json) FROM (
            SELECT m.*, row_number() OVER (ORDER BY ${order}) AS position,
              b.uuid, b.namespace, b."isStatic", b."deletedAt" AS deleted_at,
              b."pullRequestId" AS pull_request_id,
              p."pullRequestNumber" AS pull_request_number, p.title AS pull_request_title, p."githubLogin" AS pull_request_author,
              d.superseded_reason, d.decided_at, d.failed, d.service_outcomes
            FROM (SELECT * FROM matched m ORDER BY ${order} LIMIT ? OFFSET ?) m
            JOIN builds b ON b.id = m."buildId"
            LEFT JOIN pull_requests p ON p.id = b."pullRequestId"
            LEFT JOIN LATERAL (
              SELECT (array_agg(e.reason ORDER BY e."createdAt", e.id) FILTER (WHERE e.kind = 'run_superseded'))[1] AS superseded_reason,
                (array_agg(e."createdAt" ${FINISH_ORDER}) FILTER (WHERE e.kind = 'run_finished'))[1] AS decided_at,
                (array_agg((e.meta->>'failed')::int ${FINISH_ORDER}) FILTER (WHERE e.kind = 'run_finished'))[1] AS failed,
                (array_agg(e.meta->'serviceOutcomes' ${FINISH_ORDER}) FILTER (WHERE e.kind = 'run_finished'))[1] AS service_outcomes
              FROM build_events e
              WHERE e."buildId" = m."buildId" AND e."runUUID" = m.request_id AND e.kind IN ('run_superseded', 'run_finished')
            ) d ON true) x) AS records,
          CURRENT_TIMESTAMP AS as_of`,
        [...facts.bindings, ...bindings, query.limit, (query.page - 1) * query.limit]
      );
      const row = result.rows[0] as {
        total: number | string;
        records: Array<Record<string, unknown>>;
        as_of: Date | string;
      };
      const total = count(row.total);
      return {
        range,
        scope: {
          repositoryId: query.repositoryId,
          organization: query.organization,
          environmentType: query.environmentType,
          environmentAuthor: query.environmentAuthor,
          unattributed: query.unattributed,
        },
        asOf: timestamp(row.as_of) ?? range.asOf,
        caveats: [...CAVEATS, ...RECORD_CAVEATS],
        slice: {
          outcomes: query.outcomes,
          origin: query.origin,
          reason: query.reason,
          date: query.slice.date,
          period: query.slice.period,
          sort: `${query.sort.key}:${query.sort.descending ? 'desc' : 'asc'}`,
        },
        records: row.records.map(deploymentRequestRecord),
        pagination: { page: query.page, limit: query.limit, total, hasMore: query.page * query.limit < total },
      };
    });
  }
}

function deploymentRequestRecord(entry: Record<string, unknown>): DeploymentRequestRecord {
  const text = (value: unknown) => (value == null ? null : String(value));
  const outcome = DEPLOYMENT_OUTCOMES.includes(entry.outcome as DeploymentOutcome)
    ? (entry.outcome as DeploymentOutcome)
    : 'unresolved';
  const resourceAvailable = Boolean(entry.uuid) && entry.deleted_at == null;
  return {
    requestId: String(entry.request_id),
    id: count(entry.buildId),
    uuid: text(entry.uuid),
    namespace: text(entry.namespace),
    isStatic: entry.isStatic === true,
    resourceAvailable,
    pullRequest:
      entry.pull_request_id == null
        ? null
        : {
            number: nullableNumber(entry.pull_request_number),
            title: text(entry.pull_request_title),
            author: text(entry.pull_request_author),
          },
    repositoryId: entry.repositoryId == null ? null : count(entry.repositoryId),
    fullName: text(entry.fullName),
    githubInstallationId: entry.githubInstallationId == null ? null : count(entry.githubInstallationId),
    origin: origin(entry.origin),
    period: entry.period === 'previous' ? 'previous' : 'current',
    requestedAt: timestamp(entry.requested_at as string) ?? '',
    outcome,
    claimedAt: timestamp(entry.claimed_at as string | null),
    blockedAt: timestamp(entry.blocked_at as string | null),
    supersededAt: timestamp(entry.superseded_at as string | null),
    decidedAt: timestamp(entry.decided_at as string | null),
    readyAt: timestamp(entry.first_succeeded_at as string | null),
    queueWaitMinutes: nullableNumber(entry.wait_minutes),
    timeToReadyMinutes: nullableNumber(entry.ready_minutes),
    services: nullableNumber(entry.services),
    failed: nullableNumber(entry.failed),
    exitReason: text(entry.blocked_reason) ?? text(entry.superseded_reason),
    reason: text(entry.finished_reason),
    serviceOutcomes: serviceOutcomes(entry.service_outcomes),
  };
}

const SERVICE_OUTCOMES = new Set(['ready', 'failed', 'unfinished']);
function serviceOutcomes(value: unknown): ServiceRunOutcome[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.flatMap((item): ServiceRunOutcome[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.name !== 'string' || !SERVICE_OUTCOMES.has(String(row.outcome))) return [];
    return [
      {
        name: row.name,
        type: row.type == null ? null : String(row.type),
        status: row.status == null ? null : String(row.status),
        outcome: row.outcome as ServiceRunOutcome['outcome'],
        message: row.message == null ? null : String(row.message),
      },
    ];
  });
  return rows;
}
