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
import type Build from 'server/models/Build';
import { defaultDb } from 'server/lib/dependencies';
import { BadRequestError } from 'server/lib/appError';
import { getEnvironmentPhase, type EnvironmentPhase, type ReadinessDeploy } from 'server/lib/environments/readiness';
import { BuildKind, BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';
import {
  analyticsBucketDates,
  analyticsBucketExpression,
  parseAnalyticsCalendarQuery,
  resolveAnalyticsRange,
  type AnalyticsCalendarQuery,
  type ResolvedAnalyticsRange,
} from './query';

export type EnvironmentAnalyticsScope = {
  repositoryId: number | null;
  organization: string | null;
  environmentType: 'all' | 'ephemeral' | 'static';
  environmentAuthor: string | null;
  unattributed: boolean;
};
export type EnvironmentAnalyticsQuery = AnalyticsCalendarQuery &
  EnvironmentAnalyticsScope & {
    rankBy: 'first_seen' | 'observed_prs' | 'pr_coverage';
  };
export type EnvironmentAnalyticsRecordsQuery = EnvironmentAnalyticsQuery & {
  cohort: 'first_seen' | 'current';
  phase: EnvironmentPhase | null;
  page: number;
  limit: number;
};
export type AnalyticsRepositoryIdentity = {
  repositoryId: number | null;
  fullName: string | null;
  githubInstallationId: number | null;
};
export type EnvironmentAnalyticsTotals = {
  firstSeenEnvironments: number;
  observedPullRequests: number | null;
  pullRequestsWithEnvironments: number | null;
  activeRepositories: number;
  unattributedEnvironments: number;
  ambiguousRepositoryEnvironments: number;
};
export type EnvironmentAnalyticsRepository = AnalyticsRepositoryIdentity & {
  firstSeenEnvironments: number;
  observedPullRequests: number | null;
  pullRequestsWithEnvironments: number | null;
  pullRequestCoverage: number | null;
  currentEnvironments: number;
  readyEnvironments: number;
};
export type EnvironmentAnalytics = {
  range: ResolvedAnalyticsRange;
  scope: EnvironmentAnalyticsScope;
  retention: {
    earliestRetainedEnvironmentAt: string | null;
    earliestRetainedPullRequestAt: string | null;
    collectionStartedAt: null;
    retentionStartAt: null;
  };
  totals: EnvironmentAnalyticsTotals;
  previousTotals: EnvironmentAnalyticsTotals | null;
  buckets: Array<{
    date: string;
    firstSeenEnvironments: number;
    observedPullRequests: number | null;
    previousFirstSeenEnvironments: number | null;
    previousObservedPullRequests: number | null;
  }>;
  repositories: EnvironmentAnalyticsRepository[];
  rankingTotal: number;
  rankingTruncated: boolean;
  rankBy: EnvironmentAnalyticsQuery['rankBy'];
  caveats: string[];
};
export type InventoryTotals = {
  current: number;
  static: number;
  ephemeral: number;
  ready: number;
  deployedNotReady: number;
  inProgress: number;
  paused: number;
  failed: number;
  tearingDown: number;
  unattributed: number;
  ambiguous: number;
};
export type InventoryRepository = AnalyticsRepositoryIdentity & InventoryTotals;
export type ManagedServiceType =
  | DeployTypes.DOCKER
  | DeployTypes.GITHUB
  | DeployTypes.HELM
  | DeployTypes.AURORA_RESTORE;
export type ManagedServiceTypeCounts = {
  type: ManagedServiceType;
  distinctServices: number;
  instances: number;
  readyInstances: number;
};
export type ManagedServiceInventory = {
  distinctServices: number;
  instances: number;
  readyInstances: number;
  environmentsWithServices: number;
  unresolvedIdentityInstances: number;
  byType: ManagedServiceTypeCounts[];
  excluded: { externalInstances: number; buildOnlyInstances: number; unknownTypeInstances: number };
};
export type ManagedServiceRecord = AnalyticsRepositoryIdentity & {
  key: string;
  name: string;
  type: ManagedServiceType;
  sourceGithubRepositoryId: number | null;
  serviceId: number | null;
  identityResolved: boolean;
  instances: number;
  readyInstances: number;
  environments: number;
};
export type ManagedServiceRecordsQuery = EnvironmentAnalyticsScope & {
  type: ManagedServiceType | null;
  page: number;
  limit: number;
};
export type ManagedServiceRecords = {
  asOf: string;
  scope: EnvironmentAnalyticsScope;
  type: ManagedServiceType | null;
  records: ManagedServiceRecord[];
  pagination: { page: number; limit: number; total: number; hasMore: boolean; maxPage: number; truncated: boolean };
  caveats: string[];
};
type EnvironmentServiceCounts = {
  instances: number;
  byType: Array<{ type: ManagedServiceType; instances: number }>;
};
export type EnvironmentAnalyticsRecord = AnalyticsRepositoryIdentity & {
  id: number;
  uuid: string | null;
  namespace: string | null;
  status: string | null;
  phase: EnvironmentPhase;
  isStatic: boolean;
  trigger: string;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  deletedAt: string | null;
  resourceAvailable: boolean;
  repositoryAmbiguous: boolean;
  serviceInstances: number | null;
  serviceTypes: EnvironmentServiceCounts['byType'] | null;
  pullRequest: { number: number | null; title: string | null; author: string | null } | null;
};
export type InventoryAnalytics = {
  asOf: string;
  scope: EnvironmentAnalyticsScope;
  totals: InventoryTotals;
  services: ManagedServiceInventory;
  repositories: InventoryRepository[];
  exceptions: EnvironmentAnalyticsRecord[];
  truncated: boolean;
  repositoriesTruncated: boolean;
  repositoryTotal: number;
  caveats: string[];
};
export type AnalyticsOptions = {
  repositories: Array<AnalyticsRepositoryIdentity & { githubRepositoryId: number; deletedAt: string | null }>;
  organizations: string[];
  environmentAuthors: string[];
  truncated: { repositories: boolean; organizations: boolean; environmentAuthors: boolean };
  caveats: string[];
};
export type EnvironmentAnalyticsRecords = {
  asOf: string;
  scope: EnvironmentAnalyticsScope;
  range: ResolvedAnalyticsRange | null;
  cohort: 'first_seen' | 'current';
  records: EnvironmentAnalyticsRecord[];
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
};

type Projection = {
  id: number;
  uuid: string | null;
  namespace: string | null;
  status: string | null;
  isStatic: boolean | null;
  triggerType: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  deletedAt: Date | string | null;
  expiresAt: Date | string | null;
  deployEnabled: boolean | null;
  pullRequestId: number | null;
  prDeployOnUpdate: boolean | null;
  prAuthor: string | null;
  pullRequestNumber: number | null;
  prTitle: string | null;
  repositoryId: number | null;
  fullName: string | null;
  githubInstallationId: number | null;
  author: string | null;
  repositoryAmbiguous: boolean;
  deploys: ReadinessDeploy[];
};
type CountRow = AnalyticsRepositoryIdentity & {
  count: number | string;
  covered?: number | string;
  ambiguous?: number | string;
};
const BATCH_SIZE = 1000;
const RANKING_LIMIT = 100;
const EXCEPTION_LIMIT = 20;
const MANAGED_SERVICE_MAX_PAGE = 1_000_000;
const MANAGED_SERVICE_TYPES: ManagedServiceType[] = [
  DeployTypes.DOCKER,
  DeployTypes.GITHUB,
  DeployTypes.HELM,
  DeployTypes.AURORA_RESTORE,
];
const SERVICE_CAVEATS = [
  'Service counts are current selected runtime units, including queued and failed instances, not deployment events or live resources.',
  'Unique configured Services are grouped by owning repository, source or database template, name, and type; shared apps in different owning repositories remain separate.',
  'Instances with unresolved owning repository identity are excluded from unique Service counts and remain separate in drilldown.',
  'External connections, configuration units, and Codefresh build-only units are excluded from managed Service counts.',
];
const CURRENT_PHASES: EnvironmentPhase[] = [
  'ready',
  'deployed_not_ready',
  'in_progress',
  'paused',
  'failed',
  'tearing_down',
];
const CAVEATS = [
  'Historical counts cover retained first-seen records, not deployment attempts. Collection and retention start are unknown.',
  'API-created environments have no installation binding; duplicate active repository matches are unattributed and counted as ambiguous.',
];
const timestamp = (value: Date | string | null) => (value == null ? null : new Date(value).toISOString());
const count = (value: unknown) => Number(value) || 0;
const identityKey = (value: number | null) => (value == null ? 'unattributed' : String(value));
const identity = (row: AnalyticsRepositoryIdentity): AnalyticsRepositoryIdentity => ({
  repositoryId: row.repositoryId == null ? null : Number(row.repositoryId),
  fullName: row.fullName ?? null,
  githubInstallationId: row.githubInstallationId == null ? null : Number(row.githubInstallationId),
});
const emptyInventory = (): InventoryTotals => ({
  current: 0,
  static: 0,
  ephemeral: 0,
  ready: 0,
  deployedNotReady: 0,
  inProgress: 0,
  paused: 0,
  failed: 0,
  tearingDown: 0,
  unattributed: 0,
  ambiguous: 0,
});
const emptyServiceInventory = (): ManagedServiceInventory => ({
  distinctServices: 0,
  instances: 0,
  readyInstances: 0,
  environmentsWithServices: 0,
  unresolvedIdentityInstances: 0,
  byType: MANAGED_SERVICE_TYPES.map((type) => ({ type, distinctServices: 0, instances: 0, readyInstances: 0 })),
  excluded: { externalInstances: 0, buildOnlyInstances: 0, unknownTypeInstances: 0 },
});

function optionalText(params: URLSearchParams, name: string, maximum = 128): string | null {
  const value = params.get(name);
  if (value == null) return null;
  if (!value.trim() || value.length > maximum)
    throw new BadRequestError(`${name} must be a nonempty bounded value.`, 'invalid_query');
  return value.trim();
}

export function parseEnvironmentAnalyticsScope(params: URLSearchParams): EnvironmentAnalyticsScope {
  const repository = params.get('repositoryId');
  const repositoryId = repository == null ? null : Number(repository);
  if (repository != null && (!/^[1-9]\d*$/.test(repository) || !Number.isSafeInteger(repositoryId))) {
    throw new BadRequestError('repositoryId must be a positive repository row ID.', 'invalid_query');
  }
  const unattributed = params.get('unattributed');
  if (unattributed !== null && unattributed !== 'true' && unattributed !== 'false')
    throw new BadRequestError('unattributed must be true or false.', 'invalid_query');
  if (unattributed === 'true' && repositoryId != null)
    throw new BadRequestError('unattributed and repositoryId are mutually exclusive.', 'invalid_query');
  const environmentType = params.get('environmentType') ?? 'all';
  if (!['all', 'ephemeral', 'static'].includes(environmentType))
    throw new BadRequestError('environmentType must be all, ephemeral or static.', 'invalid_query');
  return {
    repositoryId,
    organization: optionalText(params, 'organization'),
    environmentAuthor: optionalText(params, 'environmentAuthor'),
    environmentType: environmentType as EnvironmentAnalyticsScope['environmentType'],
    unattributed: unattributed === 'true',
  };
}

export function parseEnvironmentAnalyticsQuery(params: URLSearchParams): EnvironmentAnalyticsQuery {
  const rankBy = params.get('rankBy') ?? 'first_seen';
  if (!['first_seen', 'observed_prs', 'pr_coverage'].includes(rankBy))
    throw new BadRequestError('rankBy must be first_seen, observed_prs or pr_coverage.', 'invalid_query');
  return {
    ...parseAnalyticsCalendarQuery(params),
    ...parseEnvironmentAnalyticsScope(params),
    rankBy: rankBy as EnvironmentAnalyticsQuery['rankBy'],
  };
}

export function parseEnvironmentAnalyticsRecordsQuery(params: URLSearchParams): EnvironmentAnalyticsRecordsQuery {
  const cohort = params.get('cohort') ?? 'first_seen';
  if (cohort !== 'first_seen' && cohort !== 'current')
    throw new BadRequestError('cohort must be first_seen or current.', 'invalid_query');
  const phase = params.get('phase') as EnvironmentPhase | null;
  if (phase !== null && (cohort !== 'current' || !CURRENT_PHASES.includes(phase)))
    throw new BadRequestError(
      'phase is a current-inventory filter and must be a supported current phase.',
      'invalid_query'
    );
  const page = Number(params.get('page') ?? 1),
    limit = Number(params.get('limit') ?? 25);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1_000_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new BadRequestError('page must be positive and limit must be between 1 and 100.', 'invalid_query');
  const query =
    cohort === 'current'
      ? { ...parseEnvironmentAnalyticsScope(params), rankBy: 'first_seen' as const }
      : parseEnvironmentAnalyticsQuery(params);
  return { ...query, cohort, phase, page, limit };
}

export function parseManagedServiceRecordsQuery(params: URLSearchParams): ManagedServiceRecordsQuery {
  const type = params.get('type') as ManagedServiceType | null;
  if (type !== null && !MANAGED_SERVICE_TYPES.includes(type))
    throw new BadRequestError('type must be a managed runtime Service type.', 'invalid_query');
  const page = Number(params.get('page') ?? 1),
    limit = Number(params.get('limit') ?? 25);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > MANAGED_SERVICE_MAX_PAGE ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new BadRequestError('page must be positive and limit must be between 1 and 100.', 'invalid_query');
  return { ...parseEnvironmentAnalyticsScope(params), type, page, limit };
}

export function environmentBase(knex: Knex, scope: EnvironmentAnalyticsScope): Knex.QueryBuilder {
  const repositories = knex('repositories')
    .select('githubRepositoryId')
    .count('* as matches')
    .min('id as repositoryId')
    .whereNull('deletedAt')
    .groupBy('githubRepositoryId');
  const base = knex.raw(
    `
    SELECT b.id, b.uuid, b.namespace, b.status, b."isStatic", b."triggerType", b."createdAt", b."updatedAt",
      b."deletedAt", b."expiresAt", b."deployEnabled", b."pullRequestId", (p.id IS NOT NULL) AS "hasPullRequest", p."deployOnUpdate" AS "prDeployOnUpdate",
      p."githubLogin" AS "prAuthor", p."pullRequestNumber", p.title AS "prTitle",
      COALESCE(b."createdByGithubLogin", p."githubLogin") AS author,
      CASE WHEN p.id IS NOT NULL THEN p."repositoryId" WHEN rc.matches = 1 THEN rc."repositoryId" END AS "repositoryId",
      (p.id IS NULL AND COALESCE(rc.matches, 0) > 1) AS "repositoryAmbiguous"
    FROM builds b LEFT JOIN pull_requests p ON p.id = b."pullRequestId"
    LEFT JOIN repository_candidates rc ON p.id IS NULL AND rc."githubRepositoryId" = b."githubRepositoryId"
    WHERE b.kind = ?
  `,
    [BuildKind.ENVIRONMENT]
  );
  const query = knex
    .with('repository_candidates', repositories)
    .with('environment_base', base)
    .from('environment_base as e')
    .leftJoin('repositories as r', 'r.id', 'e.repositoryId');
  if (scope.repositoryId != null) query.where('e.repositoryId', scope.repositoryId);
  if (scope.unattributed) query.whereNull('e.repositoryId');
  if (scope.organization) query.whereRaw(`LOWER(split_part(r."fullName", '/', 1)) = LOWER(?)`, [scope.organization]);
  if (scope.environmentType !== 'all')
    query.whereRaw('COALESCE(e."isStatic", false) = ?', [scope.environmentType === 'static']);
  if (scope.environmentAuthor) query.whereRaw('LOWER(e.author) = LOWER(?)', [scope.environmentAuthor]);
  return query;
}

function pullRequestBase(knex: Knex, scope: EnvironmentAnalyticsScope): Knex.QueryBuilder {
  const query = knex('pull_requests as p')
    .leftJoin('repositories as r', 'r.id', 'p.repositoryId')
    .where('p.githubPullRequestId', '>', 0)
    .where('p.pullRequestNumber', '>', 0);
  if (scope.repositoryId != null) query.where('p.repositoryId', scope.repositoryId);
  if (scope.unattributed) query.whereNull('r.id');
  if (scope.organization) query.whereRaw(`LOWER(split_part(r."fullName", '/', 1)) = LOWER(?)`, [scope.organization]);
  if (scope.environmentAuthor) query.whereRaw('LOWER(p."githubLogin") = LOWER(?)', [scope.environmentAuthor]);
  return query;
}

function projection(knex: Knex, scope: EnvironmentAnalyticsScope): Knex.QueryBuilder {
  return environmentBase(knex, scope)
    .select('e.*', 'r.fullName', 'r.githubInstallationId')
    .select(
      knex.raw(`
    COALESCE((SELECT jsonb_agg(jsonb_build_object('active', d.active, 'status', d.status,
      'publicUrl', d."publicUrl", 'deployable', jsonb_build_object('type', a.type)))
      FROM deploys d JOIN deployables a ON a.id = d."deployableId"
      WHERE d."buildId" = e.id AND d.active = true AND NULLIF(btrim(a.name), '') IS NOT NULL), '[]'::jsonb) AS deploys
  `)
    );
}

export function currentEnvironmentQuery(query: Knex.QueryBuilder): Knex.QueryBuilder {
  return query.whereNull('e.deletedAt').whereRaw('(e.status IS NULL OR e.status <> ?)', [BuildStatus.TORN_DOWN]);
}

function serviceInstances(knex: Knex, scope: EnvironmentAnalyticsScope, environmentIds?: number[]): Knex.QueryBuilder {
  const environments = currentEnvironmentQuery(environmentBase(knex, scope)).select(
    'e.id as environmentId',
    'e.uuid',
    'e.repositoryId',
    'r.fullName',
    'r.githubInstallationId'
  );
  if (environmentIds) environments.whereIn('e.id', environmentIds);
  const deployables = knex.raw(`
    SELECT a.id, a.name, a.type, a.active, a."serviceId", e.*,
      COALESCE(NULLIF(a."resolvedFromRepositoryId", 0)::bigint,
        CASE WHEN btrim(a."repositoryId") ~ '^[0-9]{1,10}$' THEN NULLIF(btrim(a."repositoryId")::bigint, 0) END)
        AS "sourceGithubRepositoryId",
      row_number() OVER (PARTITION BY a."buildId", a.name ORDER BY a.id DESC) AS ordinal
    FROM deployables a JOIN service_environments e ON a."buildId" = e."environmentId" AND a."buildUUID" = e.uuid
    WHERE a."deletedAt" IS NULL AND NULLIF(btrim(a.name), '') IS NOT NULL
  `);
  const deploys = knex.raw(`
    SELECT d."deployableId", d.status,
      row_number() OVER (PARTITION BY d."buildId", d."deployableId" ORDER BY d.id DESC) AS ordinal
    FROM deploys d JOIN service_deployables a ON a.id = d."deployableId" AND a."environmentId" = d."buildId"
    WHERE a.ordinal = 1 AND a.active = true AND d.active = true AND d."deletedAt" IS NULL
  `);
  return knex
    .with('service_environments', environments)
    .with('service_deployables', deployables)
    .with('service_deploys', deploys)
    .from('service_deployables as s')
    .join('service_deploys as d', 'd.deployableId', 's.id')
    .where('s.ordinal', 1)
    .where('d.ordinal', 1)
    .where('s.active', true)
    .whereRaw('(d.status IS NULL OR d.status <> ?)', [DeployStatus.TORN_DOWN]);
}

function managedInstances(knex: Knex, scope: EnvironmentAnalyticsScope, environmentIds?: number[]): Knex.QueryBuilder {
  return serviceInstances(knex, scope, environmentIds).whereIn('s.type', MANAGED_SERVICE_TYPES);
}

const serviceKeySql = `jsonb_build_array(
  CASE WHEN s."repositoryId" IS NULL THEN 'environment' ELSE 'repository' END,
  COALESCE(s."repositoryId", s."environmentId"),
  CASE WHEN s."serviceId" IS NOT NULL THEN 'db:' || s."serviceId"::text
    ELSE 'github:' || COALESCE(s."sourceGithubRepositoryId"::text, 'unrecorded') END,
  s.name, s.type)::text`;

export function analyticsEnvironmentRecord(row: Projection): EnvironmentAnalyticsRecord {
  const build = {
    status: row.status,
    deployEnabled: row.pullRequestId == null ? row.deployEnabled === true : row.prDeployOnUpdate === true,
    deploys: row.deploys ?? [],
  } as unknown as Build;
  return {
    ...identity(row),
    id: Number(row.id),
    uuid: row.uuid,
    namespace: row.namespace,
    status: row.status,
    phase: getEnvironmentPhase(build),
    isStatic: row.isStatic === true,
    trigger: row.triggerType ?? 'github_pr',
    author: row.author,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    expiresAt: timestamp(row.expiresAt),
    deletedAt: timestamp(row.deletedAt),
    resourceAvailable: Boolean(row.uuid) && row.deletedAt == null && row.status !== BuildStatus.TORN_DOWN,
    repositoryAmbiguous: row.repositoryAmbiguous === true,
    serviceInstances: null,
    serviceTypes: null,
    pullRequest:
      row.pullRequestId == null ? null : { number: row.pullRequestNumber, title: row.prTitle, author: row.prAuthor },
  };
}

function addInventory(totals: InventoryTotals, record: EnvironmentAnalyticsRecord): void {
  totals.current++;
  totals[record.isStatic ? 'static' : 'ephemeral']++;
  if (record.repositoryId == null) totals.unattributed++;
  if (record.repositoryAmbiguous) totals.ambiguous++;
  const field = (
    {
      ready: 'ready',
      deployed_not_ready: 'deployedNotReady',
      in_progress: 'inProgress',
      paused: 'paused',
      failed: 'failed',
      tearing_down: 'tearingDown',
    } as const
  )[record.phase];
  if (field) totals[field]++;
}

export default class EnvironmentAnalyticsService {
  constructor(private readonly db: Pick<Database, 'knex'> = defaultDb) {}

  private async transaction<T>(work: (knex: Knex) => Promise<T>): Promise<T> {
    return this.db.knex.transaction(
      async (trx) => {
        await trx.raw('SET TRANSACTION READ ONLY');
        return work(trx);
      },
      { isolationLevel: 'repeatable read' }
    );
  }

  private async visitCurrent(
    knex: Knex,
    scope: EnvironmentAnalyticsScope,
    visit: (record: EnvironmentAnalyticsRecord) => void
  ): Promise<void> {
    let lastId = 0;
    for (;;) {
      const rows = (await currentEnvironmentQuery(projection(knex, scope))
        .where('e.id', '>', lastId)
        .orderBy('e.id')
        .limit(BATCH_SIZE)) as Projection[];
      for (const row of rows) visit(analyticsEnvironmentRecord(row));
      if (rows.length < BATCH_SIZE) return;
      lastId = Number(rows[rows.length - 1].id);
    }
  }

  private async inventory(
    knex: Knex,
    scope: EnvironmentAnalyticsScope
  ): Promise<{
    totals: InventoryTotals;
    repositories: Map<string, InventoryRepository>;
    exceptions: EnvironmentAnalyticsRecord[];
    exceptionTotal: number;
  }> {
    const totals = emptyInventory(),
      repositories = new Map<string, InventoryRepository>();
    const exceptions: EnvironmentAnalyticsRecord[] = [];
    let exceptionTotal = 0;
    await this.visitCurrent(knex, scope, (record) => {
      addInventory(totals, record);
      const key = identityKey(record.repositoryId);
      const repository = repositories.get(key) ?? { ...identity(record), ...emptyInventory() };
      addInventory(repository, record);
      repositories.set(key, repository);
      if (record.phase !== 'ready') {
        exceptionTotal++;
        exceptions.push(record);
        exceptions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.id - a.id);
        if (exceptions.length > EXCEPTION_LIMIT) exceptions.pop();
      }
    });
    return { totals, repositories, exceptions, exceptionTotal };
  }

  private async addServiceCounts(
    knex: Knex,
    scope: EnvironmentAnalyticsScope,
    rows: EnvironmentAnalyticsRecord[]
  ): Promise<void> {
    if (!rows.length) return;
    const counts = (await managedInstances(
      knex,
      scope,
      rows.map((row) => Number(row.id))
    )
      .select('s.environmentId', 's.type')
      .count('* as instances')
      .groupBy('s.environmentId', 's.type')) as Array<{
      environmentId: number;
      type: ManagedServiceType;
      instances: string;
    }>;
    const byEnvironment = new Map<number, EnvironmentServiceCounts>();
    for (const row of counts) {
      const current = byEnvironment.get(Number(row.environmentId)) ?? { instances: 0, byType: [] };
      current.instances += count(row.instances);
      current.byType.push({ type: row.type, instances: count(row.instances) });
      byEnvironment.set(Number(row.environmentId), current);
    }
    for (const row of rows) {
      const counts = byEnvironment.get(Number(row.id)) ?? { instances: 0, byType: [] };
      counts.byType.sort((a, b) => MANAGED_SERVICE_TYPES.indexOf(a.type) - MANAGED_SERVICE_TYPES.indexOf(b.type));
      row.serviceInstances = counts.instances;
      row.serviceTypes = counts.byType;
    }
  }

  private async serviceInventory(knex: Knex, scope: EnvironmentAnalyticsScope): Promise<ManagedServiceInventory> {
    const result = emptyServiceInventory();
    const [totals] = await serviceInstances(knex, scope).select(
      knex.raw(
        `
      count(*) FILTER (WHERE s.type = ANY(?::text[])) AS instances,
      count(DISTINCT ${serviceKeySql}) FILTER (WHERE s.type = ANY(?::text[]) AND s."repositoryId" IS NOT NULL) AS "distinctServices",
      count(*) FILTER (WHERE s.type = ANY(?::text[]) AND d.status = ?) AS "readyInstances",
      count(DISTINCT s."environmentId") FILTER (WHERE s.type = ANY(?::text[])) AS "environmentsWithServices",
      count(*) FILTER (WHERE s.type = ANY(?::text[]) AND s."repositoryId" IS NULL) AS "unresolvedIdentityInstances",
      count(*) FILTER (WHERE s.type = ?) AS "externalInstances",
      count(*) FILTER (WHERE s.type = ANY(?::text[])) AS "buildOnlyInstances",
      count(*) FILTER (WHERE s.type IS NULL OR s.type <> ALL(?::text[])) AS "unknownTypeInstances"
    `,
        [
          MANAGED_SERVICE_TYPES,
          MANAGED_SERVICE_TYPES,
          MANAGED_SERVICE_TYPES,
          DeployStatus.READY,
          MANAGED_SERVICE_TYPES,
          MANAGED_SERVICE_TYPES,
          DeployTypes.EXTERNAL_HTTP,
          [DeployTypes.CONFIGURATION, DeployTypes.CODEFRESH],
          [...MANAGED_SERVICE_TYPES, DeployTypes.EXTERNAL_HTTP, DeployTypes.CONFIGURATION, DeployTypes.CODEFRESH],
        ]
      )
    );
    const types = (await managedInstances(knex, scope)
      .select('s.type')
      .count('* as instances')
      .select(
        knex.raw(
          `count(DISTINCT ${serviceKeySql}) FILTER (WHERE s."repositoryId" IS NOT NULL) AS "distinctServices",
        count(*) FILTER (WHERE d.status = ?) AS "readyInstances"`,
          [DeployStatus.READY]
        )
      )
      .groupBy('s.type')) as Array<ManagedServiceTypeCounts>;
    for (const field of [
      'distinctServices',
      'instances',
      'readyInstances',
      'environmentsWithServices',
      'unresolvedIdentityInstances',
    ] as const)
      result[field] = count(totals?.[field]);
    for (const field of ['externalInstances', 'buildOnlyInstances', 'unknownTypeInstances'] as const)
      result.excluded[field] = count(totals?.[field]);
    result.byType = result.byType.map((empty) => {
      const row = types.find((type) => type.type === empty.type);
      return row
        ? {
            type: empty.type,
            distinctServices: count(row.distinctServices),
            instances: count(row.instances),
            readyInstances: count(row.readyInstances),
          }
        : empty;
    });
    return result;
  }

  private async period(knex: Knex, query: EnvironmentAnalyticsQuery, range: ResolvedAnalyticsRange, prior: boolean) {
    const period = prior ? range.previous! : range;
    const environments = environmentBase(knex, query)
      .where('e.createdAt', '>=', period.fromUtc)
      .where('e.createdAt', '<', period.toUtc);
    const envRows = (await environments
      .clone()
      .select('e.repositoryId', 'r.fullName', 'r.githubInstallationId')
      .count('e.id as count')
      .select(knex.raw('count(*) FILTER (WHERE e."repositoryAmbiguous") AS ambiguous'))
      .groupBy('e.repositoryId', 'r.fullName', 'r.githubInstallationId')) as CountRow[];
    const envBuckets = (await environments
      .clone()
      .select(
        analyticsBucketExpression(knex, range, 'e.createdAt', prior ? 'previous' : 'current').wrap('', ' AS date')
      )
      .count('e.id as count')
      .groupBy('date')) as { date: string; count: number | string }[];
    let prRows: CountRow[] = [],
      prBuckets: { date: string; count: number | string }[] = [];
    if (query.environmentType !== 'static') {
      const prs = pullRequestBase(knex, query)
        .where('p.createdAt', '>=', period.fromUtc)
        .where('p.createdAt', '<', period.toUtc);
      const coverage = knex('builds as coverage')
        .select(knex.raw('1'))
        .whereRaw('coverage."pullRequestId" = p.id')
        .where('coverage.kind', BuildKind.ENVIRONMENT);
      if (query.environmentType === 'ephemeral') coverage.whereRaw('COALESCE(coverage."isStatic", false) = false');
      prRows = (await prs
        .clone()
        .select('p.repositoryId', 'r.fullName', 'r.githubInstallationId')
        .count('p.id as count')
        .select(knex.raw('count(*) FILTER (WHERE EXISTS (?)) AS covered', [coverage]))
        .groupBy('p.repositoryId', 'r.fullName', 'r.githubInstallationId')) as CountRow[];
      prBuckets = (await prs
        .clone()
        .select(
          analyticsBucketExpression(knex, range, 'p.createdAt', prior ? 'previous' : 'current').wrap('', ' AS date')
        )
        .count('p.id as count')
        .groupBy('date')) as { date: string; count: number | string }[];
    }
    const applicable = query.environmentType !== 'static';
    const totals: EnvironmentAnalyticsTotals = {
      firstSeenEnvironments: envRows.reduce((sum, row) => sum + count(row.count), 0),
      observedPullRequests: applicable ? prRows.reduce((sum, row) => sum + count(row.count), 0) : null,
      pullRequestsWithEnvironments: applicable ? prRows.reduce((sum, row) => sum + count(row.covered), 0) : null,
      activeRepositories: envRows.filter((row) => row.repositoryId != null && count(row.count) > 0).length,
      unattributedEnvironments: envRows
        .filter((row) => row.repositoryId == null)
        .reduce((sum, row) => sum + count(row.count), 0),
      ambiguousRepositoryEnvironments: envRows.reduce((sum, row) => sum + count(row.ambiguous), 0),
    };
    return { totals, envRows, prRows, envBuckets, prBuckets };
  }

  async getEnvironments(query: EnvironmentAnalyticsQuery): Promise<EnvironmentAnalytics> {
    return this.transaction(async (knex) => {
      const range = await resolveAnalyticsRange(knex, query);
      const current = await this.period(knex, query, range, false);
      const previous = range.previous ? await this.period(knex, query, range, true) : null;
      const inventory = await this.inventory(knex, query);
      const applicable = query.environmentType !== 'static';
      const repositories = new Map<string, EnvironmentAnalyticsRepository>();
      const getRepository = (row: AnalyticsRepositoryIdentity) => {
        const key = identityKey(row.repositoryId);
        const existing = repositories.get(key) ?? {
          ...identity(row),
          firstSeenEnvironments: 0,
          observedPullRequests: applicable ? 0 : null,
          pullRequestsWithEnvironments: applicable ? 0 : null,
          pullRequestCoverage: null,
          currentEnvironments: 0,
          readyEnvironments: 0,
        };
        repositories.set(key, existing);
        return existing;
      };
      for (const row of current.envRows) getRepository(row).firstSeenEnvironments += count(row.count);
      for (const row of current.prRows) {
        const repo = getRepository(row);
        repo.observedPullRequests = count(row.count);
        repo.pullRequestsWithEnvironments = count(row.covered);
      }
      for (const row of inventory.repositories.values()) {
        const repo = getRepository(row);
        repo.currentEnvironments = row.current;
        repo.readyEnvironments = row.ready;
      }
      const ranking = [...repositories.values()].map((row) => ({
        ...row,
        pullRequestCoverage: row.observedPullRequests
          ? row.pullRequestsWithEnvironments! / row.observedPullRequests
          : null,
      }));
      const rankValue = (row: EnvironmentAnalyticsRepository) =>
        query.rankBy === 'observed_prs'
          ? row.observedPullRequests ?? -1
          : query.rankBy === 'pr_coverage'
          ? row.pullRequestCoverage ?? -1
          : row.firstSeenEnvironments;
      ranking.sort(
        (a, b) =>
          rankValue(b) - rankValue(a) ||
          b.firstSeenEnvironments - a.firstSeenEnvironments ||
          (a.fullName ?? '\uffff').localeCompare(b.fullName ?? '\uffff') ||
          (a.repositoryId ?? Number.MAX_SAFE_INTEGER) - (b.repositoryId ?? Number.MAX_SAFE_INTEGER)
      );
      const envBuckets = new Map(current.envBuckets.map((row) => [row.date, count(row.count)]));
      const prBuckets = new Map(current.prBuckets.map((row) => [row.date, count(row.count)]));
      const previousEnvs = new Map(previous?.envBuckets.map((row) => [row.date, count(row.count)]) ?? []);
      const previousPrs = new Map(previous?.prBuckets.map((row) => [row.date, count(row.count)]) ?? []);
      const envFirst = await environmentBase(knex, query).min('e.createdAt as earliest').first();
      const prFirst = applicable ? await pullRequestBase(knex, query).min('p.createdAt as earliest').first() : null;
      return {
        range,
        scope: this.scope(query),
        totals: current.totals,
        previousTotals: previous?.totals ?? null,
        retention: {
          earliestRetainedEnvironmentAt: timestamp(envFirst?.earliest ?? null),
          earliestRetainedPullRequestAt: timestamp(prFirst?.earliest ?? null),
          collectionStartedAt: null,
          retentionStartAt: null,
        },
        buckets: analyticsBucketDates(range).map((date) => ({
          date,
          firstSeenEnvironments: envBuckets.get(date) ?? 0,
          observedPullRequests: applicable ? prBuckets.get(date) ?? 0 : null,
          previousFirstSeenEnvironments: previous ? previousEnvs.get(date) ?? 0 : null,
          previousObservedPullRequests: previous && applicable ? previousPrs.get(date) ?? 0 : null,
        })),
        repositories: ranking.slice(0, RANKING_LIMIT),
        rankingTotal: ranking.length,
        rankingTruncated: ranking.length > RANKING_LIMIT,
        rankBy: query.rankBy,
        caveats: [
          ...CAVEATS,
          'PR coverage uses the same first-observed PR cohort; linked retained environments may have been created outside that window. Static-only PR metrics are inapplicable.',
        ],
      };
    });
  }

  private scope(query: EnvironmentAnalyticsScope): EnvironmentAnalyticsScope {
    return {
      repositoryId: query.repositoryId,
      organization: query.organization,
      environmentType: query.environmentType,
      environmentAuthor: query.environmentAuthor,
      unattributed: query.unattributed,
    };
  }

  async getInventory(scope: EnvironmentAnalyticsScope): Promise<InventoryAnalytics> {
    return this.transaction(async (knex) => {
      const [asOf] = await knex.select(knex.raw('CURRENT_TIMESTAMP AS "asOf"'));
      const result = await this.inventory(knex, scope);
      await this.addServiceCounts(knex, scope, result.exceptions);
      const services = await this.serviceInventory(knex, scope);
      const repositories = [...result.repositories.values()].sort(
        (a, b) => b.current - a.current || (a.fullName ?? '\uffff').localeCompare(b.fullName ?? '\uffff')
      );
      return {
        asOf: timestamp(asOf.asOf)!,
        scope: this.scope(scope),
        totals: result.totals,
        services,
        repositories: repositories.slice(0, RANKING_LIMIT),
        exceptions: result.exceptions,
        truncated: result.exceptionTotal > EXCEPTION_LIMIT,
        repositoriesTruncated: repositories.length > RANKING_LIMIT,
        repositoryTotal: repositories.length,
        caveats: [
          ...CAVEATS,
          'Current inventory ignores historical date controls. Readiness reflects recorded state, not a live Kubernetes probe.',
          ...SERVICE_CAVEATS,
        ],
      };
    });
  }

  async getServices(query: ManagedServiceRecordsQuery): Promise<ManagedServiceRecords> {
    return this.transaction(async (knex) => {
      const [asOf] = await knex.select(knex.raw('CURRENT_TIMESTAMP AS "asOf"'));
      const grouped = managedInstances(knex, query)
        .select('s.repositoryId', 's.fullName', 's.githubInstallationId', 's.name', 's.type')
        .select(
          knex.raw(
            `${serviceKeySql} AS key,
          CASE WHEN count(DISTINCT s."sourceGithubRepositoryId") = 1 THEN min(s."sourceGithubRepositoryId") END AS "sourceGithubRepositoryId",
          min(s."serviceId") AS "serviceId", (s."repositoryId" IS NOT NULL) AS "identityResolved",
          count(*) AS instances, count(*) FILTER (WHERE d.status = ?) AS "readyInstances",
          count(DISTINCT s."environmentId") AS environments`,
            [DeployStatus.READY]
          )
        )
        .groupBy('s.repositoryId', 's.fullName', 's.githubInstallationId', 's.name', 's.type')
        .groupByRaw(serviceKeySql);
      if (query.type) grouped.where('s.type', query.type);
      const totalRow = await knex.from(grouped.clone().as('services')).count('* as total').first();
      const offset = (query.page - 1) * query.limit;
      const rows = (await grouped
        .orderBy('instances', 'desc')
        .orderBy('key')
        .offset(offset)
        .limit(query.limit)) as ManagedServiceRecord[];
      const records = rows.map((row) => ({
        ...identity(row),
        key: row.key,
        name: row.name,
        type: row.type,
        sourceGithubRepositoryId: row.sourceGithubRepositoryId == null ? null : Number(row.sourceGithubRepositoryId),
        serviceId: row.serviceId == null ? null : Number(row.serviceId),
        identityResolved: row.identityResolved === true,
        instances: count(row.instances),
        readyInstances: count(row.readyInstances),
        environments: count(row.environments),
      }));
      const total = count(totalRow?.total);
      return {
        asOf: timestamp(asOf.asOf)!,
        scope: this.scope(query),
        type: query.type,
        records,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          hasMore: query.page < MANAGED_SERVICE_MAX_PAGE && offset + records.length < total,
          maxPage: MANAGED_SERVICE_MAX_PAGE,
          truncated: total > MANAGED_SERVICE_MAX_PAGE * query.limit,
        },
        caveats: [
          'Current Services ignore historical date controls. Ready counts reflect recorded READY state.',
          ...SERVICE_CAVEATS,
        ],
      };
    });
  }

  async getOptions(scope: EnvironmentAnalyticsScope): Promise<AnalyticsOptions> {
    return this.transaction(async (knex) => {
      const repoQuery = knex('repositories')
        .select('id as repositoryId', 'fullName', 'githubRepositoryId', 'githubInstallationId', 'deletedAt')
        .orderBy('fullName')
        .orderBy('id');
      if (scope.organization)
        repoQuery.whereRaw(`LOWER(split_part("fullName", '/', 1)) = LOWER(?)`, [scope.organization]);
      const rows = await repoQuery.limit(501);
      const orgQuery = knex('repositories')
        .select<{ organization: string }[]>(knex.raw(`split_part("fullName", '/', 1) AS organization`))
        .whereNotNull('fullName')
        .groupBy('organization')
        .orderBy('organization')
        .limit(501);
      const orgs = await orgQuery;
      const authorScope = { ...scope, environmentAuthor: null };
      const authors = (await environmentBase(knex, authorScope)
        .select(knex.raw('min(e.author) AS author'))
        .whereNotNull('e.author')
        .whereRaw(`btrim(e.author) <> ''`)
        .groupByRaw('lower(e.author)')
        .orderBy('author')
        .limit(1001)) as { author: string }[];
      return {
        repositories: rows.slice(0, 500).map((row) => ({
          ...identity(row),
          githubRepositoryId: Number(row.githubRepositoryId),
          deletedAt: timestamp(row.deletedAt),
        })),
        organizations: orgs.slice(0, 500).map((row) => row.organization),
        environmentAuthors: authors.slice(0, 1000).map((row) => row.author),
        truncated: {
          repositories: rows.length > 500,
          organizations: orgs.length > 500,
          environmentAuthors: authors.length > 1000,
        },
        caveats: [...CAVEATS],
      };
    });
  }

  async getRecords(query: EnvironmentAnalyticsRecordsQuery): Promise<EnvironmentAnalyticsRecords> {
    return this.transaction(async (knex) => {
      let range: ResolvedAnalyticsRange | null = null;
      let asOf: string;
      let total = 0;
      const records: EnvironmentAnalyticsRecord[] = [];
      const offset = (query.page - 1) * query.limit;
      if (query.cohort === 'current') {
        const [row] = await knex.select(knex.raw('CURRENT_TIMESTAMP AS "asOf"'));
        asOf = timestamp(row.asOf)!;
        if (query.phase) {
          await this.visitCurrent(knex, query, (record) => {
            if (record.phase !== query.phase) return;
            if (total >= offset && records.length < query.limit) records.push(record);
            total++;
          });
        } else {
          const totalRow = await currentEnvironmentQuery(environmentBase(knex, query)).count('e.id as total').first();
          total = count(totalRow?.total);
          const rows = (await currentEnvironmentQuery(projection(knex, query))
            .orderBy('e.id')
            .offset(offset)
            .limit(query.limit)) as Projection[];
          records.push(...rows.map(analyticsEnvironmentRecord));
        }
      } else {
        range = await resolveAnalyticsRange(knex, query);
        asOf = range.asOf;
        const base = environmentBase(knex, query)
          .where('e.createdAt', '>=', range.fromUtc)
          .where('e.createdAt', '<', range.toUtc);
        const totalRow = await base.clone().count('e.id as total').first();
        total = count(totalRow?.total);
        const rows = (await projection(knex, query)
          .where('e.createdAt', '>=', range.fromUtc)
          .where('e.createdAt', '<', range.toUtc)
          .orderBy('e.createdAt', 'desc')
          .orderBy('e.id', 'desc')
          .offset(offset)
          .limit(query.limit)) as Projection[];
        records.push(...rows.map(analyticsEnvironmentRecord));
      }
      if (query.cohort === 'current') await this.addServiceCounts(knex, query, records);
      return {
        asOf,
        scope: this.scope(query),
        range,
        cohort: query.cohort,
        records,
        pagination: { page: query.page, limit: query.limit, total, hasMore: offset + records.length < total },
      };
    });
  }
}
