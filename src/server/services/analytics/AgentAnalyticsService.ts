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
import {
  parseAnalyticsCalendarQuery,
  resolveAnalyticsRange,
  type AnalyticsCalendarQuery,
  type ResolvedAnalyticsRange,
} from './query';

export const AGENT_ANALYTICS_STATUSES = [
  'queued',
  'starting',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'transitioned',
  'completed',
  'failed',
  'cancelled',
  'unknown',
] as const;

export type AgentAnalyticsStatus = (typeof AGENT_ANALYTICS_STATUSES)[number];

export interface AgentAnalyticsQuery extends AnalyticsCalendarQuery {
  repository?: string;
  organization?: string;
  owner?: string;
  sessionKind?: 'environment' | 'sandbox' | 'chat';
  agentId?: string;
  provider?: string;
  model?: string;
}

export interface AgentAnalyticsRunsQuery extends AgentAnalyticsQuery {
  runStatus?: AgentAnalyticsStatus;
  sessionId?: string;
}

export interface AgentAnalyticsMetrics {
  runs: number;
  sessions: number;
  owners: number;
  outcomes: Record<AgentAnalyticsStatus, number>;
  tokens: {
    total: number | null;
    input: number | null;
    output: number | null;
    reportedRuns: number;
    inputReportedRuns: number;
    outputReportedRuns: number;
    missingRuns: number;
    pendingRuns: number;
  };
  reportedCost: { usd: number | null; coveredRuns: number };
  estimatedCost: { usd: number | null; coveredRuns: number };
  unattributedRuns: number;
}

export interface AgentAnalyticsSummary {
  range: ResolvedAnalyticsRange;
  asOf: string;
  attribution: { repository: 'run_plan_primary'; model: 'current_resolved'; repositoryScope: 'recorded_name' };
  caveats: string[];
  totals: AgentAnalyticsMetrics;
  previous: AgentAnalyticsMetrics | null;
  series: Array<{
    date: string;
    previousDate: string | null;
    current: AgentAnalyticsMetrics;
    previous: AgentAnalyticsMetrics | null;
  }>;
  repositories: Array<AgentAnalyticsMetrics & { repository: string | null }>;
  models: Array<AgentAnalyticsMetrics & { provider: string; model: string }>;
  definitions: Array<AgentAnalyticsMetrics & { agentId: string | null; label: string | null }>;
  sessionsCreated: {
    current: number;
    previous: number | null;
    unattributedCurrent: number;
    unattributedPrevious: number | null;
    attribution: 'first_recorded_run';
  };
  earliestRunAt: string | null;
  rankingLimit: number;
  rankingTotal: { repositories: number; models: number; definitions: number };
  rankingTruncated: { repositories: boolean; models: boolean; definitions: boolean };
}

export interface AgentAnalyticsRun {
  runId: string;
  sessionId: string;
  threadId: string;
  submittedAt: string;
  queuedAt: string;
  status: AgentAnalyticsStatus;
  repository: string | null;
  provider: string;
  model: string;
  agentId: string | null;
  agentLabel: string | null;
  ownerId: string;
  ownerGithubUsername: string | null;
  tokens: { total: number | null; input: number | null; output: number | null };
  reportedCostUsd: number | null;
  estimatedCostUsd: number | null;
  errorCode: string | null;
}

export interface AgentAnalyticsRuns {
  range: ResolvedAnalyticsRange;
  asOf: string;
  caveats: string[];
  runs: AgentAnalyticsRun[];
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
}

export interface AgentAnalyticsSession extends AgentAnalyticsMetrics {
  sessionId: string;
  title: string | null;
  ownerId: string;
  ownerGithubUsername: string | null;
  sessionKind: string;
  sessionStatus: string;
  repositories: string[];
  repositoryCount: number;
  firstSubmittedAt: string;
  lastSubmittedAt: string;
}

export interface AgentAnalyticsSessions {
  range: ResolvedAnalyticsRange;
  asOf: string;
  caveats: string[];
  sessions: AgentAnalyticsSession[];
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
}

export interface AgentAnalyticsOptions {
  asOf: string;
  repositoryScope: 'recorded_name';
  repositories: string[];
  hasUnattributed: boolean;
  owners: Array<{ id: string; githubUsername: string | null }>;
  models: Array<{ provider: string; model: string }>;
  limit: number;
  totals: { repositories: number; owners: number; models: number };
  truncated: { repositories: boolean; owners: boolean; models: boolean };
}

const RANKING_LIMIT = 20;
const CAVEATS = [
  'Submission cohorts use immutable run creation time; latest queue time can change when an approval resumes a run.',
  'Usage is cumulative recorded usage for runs submitted in the window; resumed execution may occur outside it.',
  'Outcomes and resolved provider/model reflect the retained run as of this snapshot; completion is an execution outcome.',
  'Repository scope uses one recorded primary repository name, without GitHub installation identity; legacy or missing snapshots remain unattributed.',
  'Reported and estimated model costs have independent coverage and can overlap; they are not additive or total infrastructure cost.',
  'Created sessions use their creation window and the first retained run for scope attribution; sessions without a recorded run remain unattributed.',
  'Definition rankings group by recorded Agent ID; displayed labels are representative retained labels.',
  'History is limited to retained records; the earliest retained run is not proof of collection completeness.',
];

function filterValue(params: URLSearchParams, name: string, limit = 255): string | undefined {
  const value = params.get(name)?.trim();
  if (!value) return undefined;
  if (value.length > limit) throw new BadRequestError(`${name} must be at most ${limit} characters.`);
  return value;
}

export function parseAgentAnalyticsQuery(params: URLSearchParams): AgentAnalyticsQuery {
  if (params.get('repositoryId'))
    throw new BadRequestError('Agent analytics uses recorded repository names; repositoryId is not supported.');
  const repository = filterValue(params, 'repository')?.toLowerCase();
  if (repository && repository !== 'unattributed' && !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new BadRequestError('repository must be an owner/repository name or unattributed.');
  }
  const organization = filterValue(params, 'organization', 100)?.toLowerCase();
  if (organization && !/^[a-z0-9_.-]+$/.test(organization))
    throw new BadRequestError('organization must be a repository owner name.');
  const sessionKind = filterValue(params, 'sessionKind');
  if (sessionKind && !['environment', 'sandbox', 'chat'].includes(sessionKind))
    throw new BadRequestError('sessionKind must be environment, sandbox, or chat.');
  return {
    ...parseAnalyticsCalendarQuery(params),
    ...(repository ? { repository } : {}),
    ...(organization ? { organization } : {}),
    ...(sessionKind ? { sessionKind: sessionKind as AgentAnalyticsQuery['sessionKind'] } : {}),
    ...Object.fromEntries(
      ['owner', 'agentId', 'provider', 'model'].flatMap((key) => {
        const value = filterValue(params, key);
        return value ? [[key, value]] : [];
      })
    ),
  };
}

export function parseAgentAnalyticsRunsQuery(params: URLSearchParams): AgentAnalyticsRunsQuery {
  const query = parseAgentAnalyticsQuery(params);
  const runStatus = filterValue(params, 'runStatus');
  if (runStatus && !AGENT_ANALYTICS_STATUSES.includes(runStatus as AgentAnalyticsStatus))
    throw new BadRequestError('runStatus must be a supported run outcome.');
  const sessionId = filterValue(params, 'sessionId');
  if (sessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
    throw new BadRequestError('sessionId must be a UUID.');
  return {
    ...query,
    ...(runStatus ? { runStatus: runStatus as AgentAnalyticsStatus } : {}),
    ...(sessionId ? { sessionId: sessionId.toLowerCase() } : {}),
  };
}

export function parseAgentAnalyticsPagination(params: URLSearchParams): { page: number; limit: number } {
  const parse = (key: string, fallback: number, maximum: number) => {
    const value = params.get(key);
    if (value == null) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum)
      throw new BadRequestError(`${key} must be an integer between 1 and ${maximum}.`);
    return Number(value);
  };
  return { page: parse('page', 1, 10000), limit: parse('limit', 25, 100) };
}

type SqlRow = Record<string, unknown>;

function number(value: unknown): number {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) throw new Error('Agent analytics numeric result exceeds the supported range.');
  return result;
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : number(value);
}

function timestamp(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function serializeAgentAnalyticsMetrics(row?: SqlRow): AgentAnalyticsMetrics {
  const runs = number(row?.runs);
  const reportedRuns = number(row?.total_reported_runs);
  return {
    runs,
    sessions: number(row?.sessions),
    owners: number(row?.owners),
    outcomes: Object.fromEntries(AGENT_ANALYTICS_STATUSES.map((status) => [status, number(row?.[status])])) as Record<
      AgentAnalyticsStatus,
      number
    >,
    tokens: {
      total: runs === 0 ? 0 : nullableNumber(row?.total_tokens),
      input: runs === 0 ? 0 : nullableNumber(row?.input_tokens),
      output: runs === 0 ? 0 : nullableNumber(row?.output_tokens),
      reportedRuns,
      inputReportedRuns: number(row?.input_reported_runs),
      outputReportedRuns: number(row?.output_reported_runs),
      missingRuns: runs - reportedRuns,
      pendingRuns: number(row?.pending_usage_runs),
    },
    reportedCost: {
      usd: runs === 0 ? 0 : nullableNumber(row?.reported_cost),
      coveredRuns: number(row?.reported_cost_runs),
    },
    estimatedCost: {
      usd: runs === 0 ? 0 : nullableNumber(row?.estimated_cost),
      coveredRuns: number(row?.estimated_cost_runs),
    },
    unattributedRuns: number(row?.unattributed_runs),
  };
}

function jsonString(path: string): string {
  return `CASE WHEN jsonb_typeof(${path}) = 'string' THEN NULLIF(BTRIM(${path} #>> '{}'), '') END`;
}

function jsonNumber(field: string): string {
  return `CASE WHEN jsonb_typeof(r."usageSummary"->'${field}') = 'number' THEN (r."usageSummary"->>'${field}')::numeric END`;
}

const RUN_DIMENSIONS = `
  r.id, r.uuid AS run_uuid, r."sessionId" AS session_id, r."threadId" AS thread_id,
  r."createdAt" AS submitted_at,
  r."queuedAt" AS queued_at,
  CASE WHEN r.status IN (${AGENT_ANALYTICS_STATUSES.filter((status) => status !== 'unknown')
    .map((status) => `'${status}'`)
    .join(',')}) THEN r.status ELSE 'unknown' END AS status,
  LOWER(COALESCE(${jsonString(`r."runPlanSnapshot" #> '{source,repoFullName}'`)}, ${jsonString(
  `r."runPlanSnapshot" #> '{source,workspaceLayout,primaryRepo}'`
)})) AS repository,
  COALESCE(NULLIF(BTRIM(r."resolvedProvider"), ''), NULLIF(BTRIM(r.provider), ''), 'unknown_provider') AS provider,
  COALESCE(NULLIF(BTRIM(r."resolvedModel"), ''), NULLIF(BTRIM(r.model), ''), 'unknown_model') AS model,
  ${jsonString(`r."runPlanSnapshot" #> '{agent,id}'`)} AS agent_id,
  ${jsonString(`r."runPlanSnapshot" #> '{agent,label}'`)} AS agent_label`;

const USAGE_COLUMNS = `
  ${jsonNumber('inputTokens')} AS input_tokens,
  ${jsonNumber('outputTokens')} AS output_tokens,
  COALESCE(${jsonNumber('totalTokens')}, ${jsonNumber('inputTokens')} + ${jsonNumber('outputTokens')}) AS total_tokens,
  ${jsonNumber('totalCostUsd')} AS reported_cost,
  ${jsonNumber('estimatedCostUsd')} AS estimated_cost`;

const AGGREGATES = `
  COUNT(*)::int AS runs, COUNT(DISTINCT session_id)::int AS sessions, COUNT(DISTINCT owner_id)::int AS owners,
  ${AGENT_ANALYTICS_STATUSES.map((status) => `COUNT(*) FILTER (WHERE status = '${status}')::int AS "${status}"`).join(
    ',\n'
  )},
  SUM(total_tokens) AS total_tokens, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  COUNT(total_tokens)::int AS total_reported_runs, COUNT(input_tokens)::int AS input_reported_runs, COUNT(output_tokens)::int AS output_reported_runs,
  COUNT(*) FILTER (WHERE total_tokens IS NULL AND status IN ('queued', 'starting', 'running'))::int AS pending_usage_runs,
  SUM(reported_cost) AS reported_cost, COUNT(reported_cost)::int AS reported_cost_runs,
  SUM(estimated_cost) AS estimated_cost, COUNT(estimated_cost)::int AS estimated_cost_runs,
  COUNT(*) FILTER (WHERE repository IS NULL)::int AS unattributed_runs`;

function scopeSql(query: AgentAnalyticsQuery): { sql: string; bindings: string[] } {
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (query.repository === 'unattributed') conditions.push('repository IS NULL');
  else if (query.repository) {
    conditions.push('repository = ?');
    bindings.push(query.repository);
  }
  if (query.organization) {
    conditions.push("split_part(repository, '/', 1) = ?");
    bindings.push(query.organization);
  }
  for (const [key, column] of [
    ['owner', 'owner_id'],
    ['sessionKind', 'session_kind'],
    ['agentId', 'agent_id'],
    ['provider', 'provider'],
    ['model', 'model'],
  ] as const) {
    if (query[key]) {
      conditions.push(`${column} = ?`);
      bindings.push(query[key]!);
    }
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', bindings };
}

function bucketDate(date: string, interval: 'day' | 'week'): string {
  if (interval === 'day') return date;
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
}

function priorDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export default class AgentAnalyticsService {
  constructor(private readonly db: Pick<Database, 'knex'> = defaultDb) {}

  async getSummary(query: AgentAnalyticsQuery): Promise<AgentAnalyticsSummary> {
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = await resolveAnalyticsRange(trx, query);
      const scope = scopeSql(query);
      const from = range.previous?.fromUtc ?? range.fromUtc;
      const result = await trx.raw(
        `
        WITH facts AS MATERIALIZED (
          SELECT ${RUN_DIMENSIONS}, ${USAGE_COLUMNS}, s."userId" AS owner_id,
            s."sessionKind" AS session_kind,
            CASE WHEN r."createdAt" >= ?::timestamptz THEN 'current' ELSE 'previous' END AS period,
            date_trunc(?, ((r."createdAt" AT TIME ZONE ?)::date +
              CASE WHEN r."createdAt" < ?::timestamptz THEN ?::int ELSE 0 END)::timestamp)::date::text AS bucket
          FROM agent_runs r JOIN agent_sessions s ON s.id = r."sessionId"
          WHERE r."createdAt" >= ?::timestamptz AND r."createdAt" < ?::timestamptz
        ), scoped AS MATERIALIZED (SELECT * FROM facts ${scope.sql}),
        aggregates AS (
          SELECT period, bucket, repository, provider, model, agent_id, MAX(agent_label) AS agent_label,
            CASE WHEN GROUPING(bucket) = 0 THEN 'date'
              WHEN GROUPING(repository) = 0 THEN 'repository'
              WHEN GROUPING(provider) = 0 THEN 'model'
              WHEN GROUPING(agent_id) = 0 THEN 'definition' ELSE 'total' END AS group_type,
            ${AGGREGATES}
          FROM scoped GROUP BY GROUPING SETS ((period), (period,bucket), (period,repository), (period,provider,model), (period,agent_id))
        ), ranked AS (
          SELECT *, COUNT(*) OVER (PARTITION BY period, group_type)::int AS ranking_total,
            row_number() OVER (PARTITION BY period, group_type ORDER BY runs DESC, repository NULLS LAST, provider, model, agent_id NULLS LAST, agent_label NULLS LAST) AS rank
          FROM aggregates
        ) SELECT * FROM ranked WHERE group_type IN ('total','date') OR (period = 'current' AND rank <= ?)
        ORDER BY group_type, period, rank
      `,
        [
          range.fromUtc,
          range.interval,
          range.timezone,
          range.fromUtc,
          range.calendarDays,
          from,
          range.toUtc,
          ...scope.bindings,
          RANKING_LIMIT,
        ]
      );
      const rows = result.rows as SqlRow[];
      const sessionRows = await this.createdSessions(trx, query, range);
      const historyResult = await trx.raw('SELECT min("createdAt") AS earliest FROM agent_runs');
      const current = rows.filter((row) => row.period === 'current');
      const dates = [...new Set(range.dates.map((date) => bucketDate(date, range.interval)))];
      const created = sessionRows.find((row) => row.period === 'current');
      const previousCreated = sessionRows.find((row) => row.period === 'previous');
      const rankingTotal = {
        repositories: number(current.find((row) => row.group_type === 'repository')?.ranking_total),
        models: number(current.find((row) => row.group_type === 'model')?.ranking_total),
        definitions: number(current.find((row) => row.group_type === 'definition')?.ranking_total),
      };
      return {
        range,
        asOf: range.asOf,
        attribution: { repository: 'run_plan_primary', model: 'current_resolved', repositoryScope: 'recorded_name' },
        caveats: [...CAVEATS],
        totals: serializeAgentAnalyticsMetrics(current.find((row) => row.group_type === 'total')),
        previous: range.previous
          ? serializeAgentAnalyticsMetrics(rows.find((row) => row.period === 'previous' && row.group_type === 'total'))
          : null,
        series: dates.map((date) => ({
          date,
          previousDate: range.previous ? priorDate(date, range.calendarDays) : null,
          current: serializeAgentAnalyticsMetrics(
            current.find((row) => row.group_type === 'date' && row.bucket === date)
          ),
          previous: range.previous
            ? serializeAgentAnalyticsMetrics(
                rows.find((row) => row.period === 'previous' && row.group_type === 'date' && row.bucket === date)
              )
            : null,
        })),
        repositories: current
          .filter((row) => row.group_type === 'repository')
          .map((row) => ({
            repository: row.repository == null ? null : String(row.repository),
            ...serializeAgentAnalyticsMetrics(row),
          })),
        models: current
          .filter((row) => row.group_type === 'model')
          .map((row) => ({
            provider: String(row.provider),
            model: String(row.model),
            ...serializeAgentAnalyticsMetrics(row),
          })),
        definitions: current
          .filter((row) => row.group_type === 'definition')
          .map((row) => ({
            agentId: row.agent_id == null ? null : String(row.agent_id),
            label: row.agent_label == null ? null : String(row.agent_label),
            ...serializeAgentAnalyticsMetrics(row),
          })),
        sessionsCreated: {
          current: number(created?.count),
          previous: range.previous ? number(previousCreated?.count) : null,
          unattributedCurrent: number(created?.unattributed),
          unattributedPrevious: range.previous ? number(previousCreated?.unattributed) : null,
          attribution: 'first_recorded_run',
        },
        earliestRunAt: timestamp(historyResult.rows[0]?.earliest),
        rankingLimit: RANKING_LIMIT,
        rankingTotal,
        rankingTruncated: {
          repositories: rankingTotal.repositories > RANKING_LIMIT,
          models: rankingTotal.models > RANKING_LIMIT,
          definitions: rankingTotal.definitions > RANKING_LIMIT,
        },
      };
    });
  }

  private async createdSessions(
    trx: Knex.Transaction,
    query: AgentAnalyticsQuery,
    range: ResolvedAnalyticsRange
  ): Promise<SqlRow[]> {
    const scope = scopeSql(query);
    const result = await trx.raw(
      `
      WITH sessions AS (
        SELECT s."userId" AS owner_id, s."sessionKind" AS session_kind, first_run.*,
          CASE WHEN s."createdAt" >= ?::timestamptz THEN 'current' ELSE 'previous' END AS period
        FROM agent_sessions s LEFT JOIN LATERAL (
          SELECT ${RUN_DIMENSIONS} FROM agent_runs r WHERE r."sessionId" = s.id ORDER BY r."createdAt", r.id LIMIT 1
        ) first_run ON true
        WHERE s."createdAt" >= ?::timestamptz AND s."createdAt" < ?::timestamptz
      ) SELECT period, COUNT(*)::int AS count, COUNT(*) FILTER (WHERE repository IS NULL)::int AS unattributed
      FROM sessions ${scope.sql} GROUP BY period
    `,
      [range.fromUtc, range.previous?.fromUtc ?? range.fromUtc, range.toUtc, ...scope.bindings]
    );
    return result.rows;
  }

  async listRuns(query: AgentAnalyticsRunsQuery, page = 1, limit = 25): Promise<AgentAnalyticsRuns> {
    if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestError('Invalid run pagination.');
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = await resolveAnalyticsRange(trx, query);
      const scope = scopeSql(query);
      const statusCondition = query.runStatus ? `${scope.sql ? ' AND' : ' WHERE'} status = ?` : '';
      const statusBindings = query.runStatus ? [query.runStatus] : [];
      const sessionCondition = query.sessionId ? ' AND s.uuid = ?::uuid' : '';
      const facts = `WITH facts AS MATERIALIZED (
        SELECT ${RUN_DIMENSIONS}, ${USAGE_COLUMNS}, s."userId" AS owner_id, s."ownerGithubUsername" AS owner_github_username,
          s."sessionKind" AS session_kind, s.uuid AS session_uuid, t.uuid AS thread_uuid,
          ${jsonString(`r.error->'code'`)} AS error_code
        FROM agent_runs r JOIN agent_sessions s ON s.id = r."sessionId" JOIN agent_threads t ON t.id = r."threadId"
        WHERE r."createdAt" >= ?::timestamptz AND r."createdAt" < ?::timestamptz
        ${sessionCondition}
      ), scoped AS MATERIALIZED (SELECT * FROM facts ${scope.sql}${statusCondition})`;
      const bindings = [
        range.fromUtc,
        range.toUtc,
        ...(query.sessionId ? [query.sessionId] : []),
        ...scope.bindings,
        ...statusBindings,
      ];
      const result = await trx.raw(
        `${facts}
        SELECT (SELECT COUNT(*)::int FROM scoped) AS total, COALESCE((
          SELECT jsonb_agg(page_rows ORDER BY submitted_at DESC, id DESC) FROM (
            SELECT * FROM scoped ORDER BY submitted_at DESC, id DESC LIMIT ? OFFSET ?
          ) page_rows
        ), '[]'::jsonb) AS runs`,
        [...bindings, limit, (page - 1) * limit]
      );
      const row = result.rows[0];
      const total = number(row.total);
      return {
        range,
        asOf: range.asOf,
        caveats: [...CAVEATS],
        runs: (row.runs as SqlRow[]).map((run) => ({
          runId: String(run.run_uuid),
          sessionId: String(run.session_uuid),
          threadId: String(run.thread_uuid),
          submittedAt: timestamp(run.submitted_at)!,
          queuedAt: timestamp(run.queued_at)!,
          status: run.status as AgentAnalyticsStatus,
          repository: run.repository == null ? null : String(run.repository),
          provider: String(run.provider),
          model: String(run.model),
          agentId: run.agent_id == null ? null : String(run.agent_id),
          agentLabel: run.agent_label == null ? null : String(run.agent_label),
          ownerId: String(run.owner_id),
          ownerGithubUsername: run.owner_github_username == null ? null : String(run.owner_github_username),
          tokens: {
            total: nullableNumber(run.total_tokens),
            input: nullableNumber(run.input_tokens),
            output: nullableNumber(run.output_tokens),
          },
          reportedCostUsd: nullableNumber(run.reported_cost),
          estimatedCostUsd: nullableNumber(run.estimated_cost),
          errorCode: run.error_code == null ? null : String(run.error_code),
        })),
        pagination: { page, limit, total, hasMore: page * limit < total },
      };
    });
  }

  async listSessions(query: AgentAnalyticsQuery, page = 1, limit = 25): Promise<AgentAnalyticsSessions> {
    if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestError('Invalid session pagination.');
    return analyticsTransaction(this.db.knex, async (trx) => {
      const range = await resolveAnalyticsRange(trx, query);
      const scope = scopeSql(query);
      const result = await trx.raw(
        `WITH facts AS MATERIALIZED (
          SELECT ${RUN_DIMENSIONS}, ${USAGE_COLUMNS}, s."userId" AS owner_id, s."sessionKind" AS session_kind
          FROM agent_runs r JOIN agent_sessions s ON s.id = r."sessionId"
          WHERE r."createdAt" >= ?::timestamptz AND r."createdAt" < ?::timestamptz
        ), scoped AS MATERIALIZED (SELECT * FROM facts ${scope.sql}),
        grouped AS MATERIALIZED (
          SELECT session_id, MIN(submitted_at) AS first_submitted_at, MAX(submitted_at) AS last_submitted_at,
            ${AGGREGATES}
          FROM scoped GROUP BY session_id
        ), page_rows AS MATERIALIZED (
          SELECT * FROM grouped ORDER BY last_submitted_at DESC, session_id DESC LIMIT ? OFFSET ?
        ), repository_names AS (
          SELECT session_id, repository, row_number() OVER (PARTITION BY session_id ORDER BY repository) AS position
          FROM (SELECT DISTINCT scoped.session_id, repository FROM scoped
            JOIN page_rows ON page_rows.session_id = scoped.session_id WHERE repository IS NOT NULL) names
        ), repositories AS (
          SELECT session_id, COUNT(*)::int AS repository_count,
            array_agg(repository ORDER BY repository) FILTER (WHERE position <= 5) AS repositories
          FROM repository_names GROUP BY session_id
        ) SELECT (SELECT COUNT(*)::int FROM grouped) AS total, COALESCE((
          SELECT jsonb_agg(records ORDER BY last_submitted_at DESC, session_id DESC) FROM (
            SELECT g.*, s.uuid AS session_uuid, NULLIF(BTRIM(t.title), '') AS title,
              s."userId" AS owner_id, s."ownerGithubUsername" AS owner_github_username,
              s."sessionKind" AS session_kind, s.status AS session_status,
              COALESCE(repos.repository_count, 0) AS repository_count,
              COALESCE(repos.repositories, ARRAY[]::text[]) AS repositories
            FROM page_rows g JOIN agent_sessions s ON s.id = g.session_id
            LEFT JOIN agent_threads t ON t.id = s."defaultThreadId" AND t."sessionId" = s.id
            LEFT JOIN repositories repos ON repos.session_id = g.session_id
          ) records
        ), '[]'::jsonb) AS sessions`,
        [range.fromUtc, range.toUtc, ...scope.bindings, limit, (page - 1) * limit]
      );
      const row = result.rows[0];
      const total = number(row.total);
      return {
        range,
        asOf: range.asOf,
        caveats: [
          ...CAVEATS,
          'Session rows aggregate all matching runs before pagination; a session can appear in more than one repository, model, or date scope.',
          'Session titles and status reflect the retained current session; titles use its default conversation and repositories show at most five recorded names.',
        ],
        sessions: (row.sessions as SqlRow[]).map((session) => ({
          ...serializeAgentAnalyticsMetrics(session),
          sessionId: String(session.session_uuid),
          title: session.title == null ? null : String(session.title),
          ownerId: String(session.owner_id),
          ownerGithubUsername: session.owner_github_username == null ? null : String(session.owner_github_username),
          sessionKind: String(session.session_kind),
          sessionStatus: String(session.session_status),
          repositories: session.repositories as string[],
          repositoryCount: number(session.repository_count),
          firstSubmittedAt: timestamp(session.first_submitted_at)!,
          lastSubmittedAt: timestamp(session.last_submitted_at)!,
        })),
        pagination: { page, limit, total, hasMore: page * limit < total },
      };
    });
  }

  async getOptions(): Promise<AgentAnalyticsOptions> {
    const limit = 200;
    return analyticsTransaction(this.db.knex, async (trx) => {
      const result = await trx.raw(
        `
      WITH facts AS MATERIALIZED (SELECT ${RUN_DIMENSIONS} FROM agent_runs r),
      repositories AS (SELECT DISTINCT repository FROM facts WHERE repository IS NOT NULL),
      models AS (SELECT DISTINCT provider, model FROM facts),
      owners AS (
        SELECT DISTINCT ON ("userId") "userId" AS id, NULLIF(BTRIM("ownerGithubUsername"), '') AS "githubUsername"
        FROM agent_sessions ORDER BY "userId", "updatedAt" DESC, id DESC
      ) SELECT CURRENT_TIMESTAMP AS as_of,
        (SELECT COUNT(*)::int FROM repositories) AS repositories_total,
        (SELECT COUNT(*)::int FROM models) AS models_total,
        (SELECT COUNT(*)::int FROM owners) AS owners_total,
        (EXISTS (SELECT 1 FROM facts WHERE repository IS NULL) OR EXISTS (
          SELECT 1 FROM agent_sessions s WHERE NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r."sessionId" = s.id)
        )) AS has_unattributed,
        COALESCE((SELECT jsonb_agg(repository ORDER BY repository) FROM (SELECT repository FROM repositories ORDER BY repository LIMIT ?) r), '[]'::jsonb) AS repositories,
        COALESCE((SELECT jsonb_agg(m ORDER BY provider, model) FROM (SELECT * FROM models ORDER BY provider, model LIMIT ?) m), '[]'::jsonb) AS models,
        COALESCE((SELECT jsonb_agg(o ORDER BY "githubUsername" NULLS LAST, id) FROM (SELECT * FROM owners ORDER BY "githubUsername" NULLS LAST, id LIMIT ?) o), '[]'::jsonb) AS owners
    `,
        [limit, limit, limit]
      );
      const row = result.rows[0];
      const totals = {
        repositories: number(row.repositories_total),
        models: number(row.models_total),
        owners: number(row.owners_total),
      };
      return {
        asOf: timestamp(row.as_of)!,
        repositoryScope: 'recorded_name',
        repositories: row.repositories,
        owners: row.owners,
        models: row.models,
        hasUnattributed: Boolean(row.has_unattributed),
        limit,
        totals,
        truncated: {
          repositories: totals.repositories > limit,
          owners: totals.owners > limit,
          models: totals.models > limit,
        },
      };
    });
  }
}
