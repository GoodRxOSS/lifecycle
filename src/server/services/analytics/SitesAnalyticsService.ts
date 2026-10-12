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
import { resolveSitesConfig, type ResolvedSitesConfig } from 'server/lib/sites/config';
import GlobalConfigService from 'server/services/globalConfig';
import { analyticsTransaction } from './execution';
import {
  analyticsBucketDates,
  parseAnalyticsCalendarQuery,
  resolveAnalyticsRange,
  type AnalyticsCalendarQuery,
  type ResolvedAnalyticsRange,
} from './query';

export const SITES_OWNER_KINDS = ['user', 'service_key', 'unresolved'] as const;
export type SitesOwnerKind = (typeof SITES_OWNER_KINDS)[number];
export const SITES_LIFETIME_BINS = [
  'under_1h',
  '1_to_24h',
  '1_to_3d',
  '3_to_7d',
  '7_to_14d',
  '14_to_30d',
  '30d_plus',
] as const;
export type SitesLifetimeBin = (typeof SITES_LIFETIME_BINS)[number];

export interface SitesAnalyticsQuery extends AnalyticsCalendarQuery {
  ownerKind?: SitesOwnerKind;
  visibility?: 'private' | 'public';
  owner?: string;
}

export interface SitesActivityMetrics {
  published: number;
  updates: number;
  publishers: number;
  private: number;
  public: number;
}

export interface SitesPublisher {
  key: string;
  label: string;
  ownerKind: SitesOwnerKind;
}

export interface SitesAnalyticsSummary {
  range: ResolvedAnalyticsRange;
  asOf: string;
  caveats: string[];
  config: { ttlEnabled: boolean; defaultTtlDays: number; extensionDays: number; deletedRetentionDays: number };
  auditSince: string | null;
  totals: SitesActivityMetrics;
  previous: SitesActivityMetrics | null;
  series: {
    date: string;
    previousDate: string | null;
    current: SitesActivityMetrics;
    previous: SitesActivityMetrics | null;
  }[];
  ownerKinds: Record<SitesOwnerKind, number>;
  current: {
    live: number;
    expiringSoon: number;
    noExpiry: number;
    storageBytes: number;
    liveBytes: number;
    restorable: number;
    expiredRecently: number;
    purgedRecently: number;
  };
  endings: { expired: number; deleted: number; purged: number; restored: number };
  extensions: { sites: number; none: number; one: number; two: number; three: number; fourOrMore: number };
  lifetime: {
    ended: number;
    medianSeconds: number | null;
    p90Seconds: number | null;
    bins: { bin: SitesLifetimeBin; count: number }[];
  };
  publishers: {
    items: (SitesPublisher & {
      published: number;
      updates: number;
      liveSites: number;
      liveBytes: number;
      lastActivityAt: string | null;
    })[];
    total: number;
    limit: number;
  };
  largest: {
    siteId: string;
    name: string;
    owner: SitesPublisher;
    visibility: 'private' | 'public';
    sizeBytes: number;
    fileCount: number;
    updates: number;
    expiresAt: string | null;
  }[];
  publisherOptions: { items: SitesPublisher[]; total: number; truncated: boolean };
}

const RANKING_LIMIT = 10;
const OPTIONS_LIMIT = 200;
const RECENT_DAYS = 90;
const EXPIRING_SOON_HOURS = 48;
/** Site audit events started with this migration's release; reading its run time avoids scanning the audit table. */
const SITE_AUDIT_MIGRATION = '035_sites_access_control';
const CAVEATS = [
  'Restores and TTL extensions come from the site audit trail; activity before auditSince is not counted.',
  'A deleted site that was later restored counts as restored, not deleted.',
  'Purge time is the time the record was last updated.',
  'Visibility is the current setting of each site, not the setting when it was published.',
  'Content updates are versions uploaded after the first version of a site.',
];
const LIFETIME_BOUNDS: Record<SitesLifetimeBin, [number, number | null]> = {
  under_1h: [0, 3600],
  '1_to_24h': [3600, 86400],
  '1_to_3d': [86400, 3 * 86400],
  '3_to_7d': [3 * 86400, 7 * 86400],
  '7_to_14d': [7 * 86400, 14 * 86400],
  '14_to_30d': [14 * 86400, 30 * 86400],
  '30d_plus': [30 * 86400, null],
};

function filterValue(params: URLSearchParams, name: string, limit: number): string | undefined {
  const value = params.get(name)?.trim();
  if (!value) return undefined;
  if (value.length > limit) throw new BadRequestError(`${name} must be at most ${limit} characters.`, 'invalid_query');
  if (value.includes('\u0000')) throw new BadRequestError(`${name} must not contain NUL characters.`, 'invalid_query');
  return value;
}

export function parseSitesAnalyticsQuery(params: URLSearchParams): SitesAnalyticsQuery {
  const ownerKind = filterValue(params, 'ownerKind', 32);
  if (ownerKind && !SITES_OWNER_KINDS.includes(ownerKind as SitesOwnerKind))
    throw new BadRequestError('ownerKind must be user, service_key, or unresolved.', 'invalid_query');
  const visibility = filterValue(params, 'visibility', 16);
  if (visibility && visibility !== 'private' && visibility !== 'public')
    throw new BadRequestError('visibility must be private or public.', 'invalid_query');
  const owner = filterValue(params, 'owner', 2400);
  if (owner && !/^(user|key|legacy):/.test(owner))
    throw new BadRequestError('owner must be a publisher key from the analytics response.', 'invalid_query');
  return {
    ...parseAnalyticsCalendarQuery(params),
    ...(ownerKind ? { ownerKind: ownerKind as SitesOwnerKind } : {}),
    ...(visibility ? { visibility: visibility as 'private' | 'public' } : {}),
    ...(owner ? { owner } : {}),
  };
}

type SqlRow = Record<string, unknown>;

function number(value: unknown): number {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) throw new Error('Sites analytics numeric result exceeds the supported range.');
  return result;
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : number(value);
}

function timestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function ownerKind(value: unknown): SitesOwnerKind {
  return SITES_OWNER_KINDS.includes(value as SitesOwnerKind) ? (value as SitesOwnerKind) : 'unresolved';
}

function activity(row?: SqlRow): SitesActivityMetrics {
  return {
    published: number(row?.published),
    updates: number(row?.updates),
    publishers: number(row?.publishers),
    private: number(row?.private_published),
    public: number(row?.public_published),
  };
}

function priorDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

class Bindings {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return '?';
  }
}

const OWNER_KEY = `CASE s."ownerKind"
    WHEN 'user' THEN 'user:' || COALESCE(s."ownerIssuer", '') || '|' || COALESCE(s."ownerSubject", '')
    WHEN 'service_key' THEN 'key:' || COALESCE(s."creatorTokenId"::text, '')
    ELSE 'legacy:' || COALESCE(NULLIF(BTRIM(s."createdBy"), ''), '') END`;

function scopedSites(query: SitesAnalyticsQuery, bind: Bindings): string {
  const conditions: string[] = [];
  if (query.ownerKind) conditions.push(`owner_kind = ${bind.add(query.ownerKind)}`);
  if (query.visibility) conditions.push(`visibility = ${bind.add(query.visibility)}`);
  if (query.owner) conditions.push(`owner_key = ${bind.add(query.owner)}`);
  return `all_sites AS NOT MATERIALIZED (
      SELECT s."siteId" AS site_id, s.name, s.status, s.visibility,
        CASE WHEN s."ownerKind" IN ('user', 'service_key') THEN s."ownerKind" ELSE 'unresolved' END AS owner_kind,
        ${OWNER_KEY} AS owner_key, s."ownerSubject" AS owner_subject,
        s."createdBy" AS created_by, s."creatorTokenId" AS token_id,
        s."createdAt" AS created_at, s."expiresAt" AS expires_at, s."deletedAt" AS deleted_at, s."updatedAt" AS updated_at,
        s."sizeBytes"::bigint AS size_bytes, s."fileCount" AS file_count, s."activeVersionId" AS active_version_id
      FROM sites s
    ), scoped AS NOT MATERIALIZED (
      SELECT * FROM all_sites ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    )`;
}

/** One label per publisher: the latest recorded creator email for people and legacy rows, the key name for API keys. */
const LABELS = `labels AS (
      SELECT DISTINCT ON (a.owner_key) a.owner_key, a.owner_kind,
        CASE a.owner_kind
          WHEN 'service_key' THEN COALESCE(NULLIF(BTRIM(t.name), ''), 'API key ' || COALESCE(a.token_id::text, 'unknown'))
          WHEN 'user' THEN COALESCE(NULLIF(BTRIM(a.created_by), ''), a.owner_subject, 'Unknown person')
          ELSE COALESCE(NULLIF(BTRIM(a.created_by), ''), 'Unknown publisher') END AS label
      FROM all_sites a LEFT JOIN api_tokens t ON t.id = a.token_id
      ORDER BY a.owner_key, (NULLIF(BTRIM(a.created_by), '') IS NULL), a.created_at DESC
    )`;

export default class SitesAnalyticsService {
  constructor(
    private readonly db: Pick<Database, 'knex'> = defaultDb,
    private readonly loadConfig: () => Promise<ResolvedSitesConfig> = async () =>
      resolveSitesConfig((await GlobalConfigService.getInstance().getAllConfigs()).sites)
  ) {}

  async getSummary(query: SitesAnalyticsQuery): Promise<SitesAnalyticsSummary> {
    const config = await this.loadConfig();
    return analyticsTransaction(this.db.knex, async (trx) => {
      // These short aggregates never repay JIT compilation, and correlated subplans inflate cost estimates past its threshold.
      await trx.raw('SET LOCAL jit = off');
      const range = await resolveAnalyticsRange(trx, query);
      const { activity: activityRows, publishers } = await this.activityAndPublishers(trx, query, range);
      const state = (await this.state(trx, query, range, config))[0] ?? {};
      const audit = (await this.audit(trx, query, range))[0] ?? {};
      const largest = await this.largest(trx, query, range);
      const options = await this.publisherOptions(trx);

      const totalRow = (period: string) =>
        activityRows.find((row) => row.period === period && number(row.grouped_bucket) === 1);
      const bucketRow = (period: string, date: string) =>
        activityRows.find((row) => row.period === period && number(row.grouped_bucket) === 0 && row.bucket === date);
      const current = totalRow('current');
      return {
        range,
        asOf: range.asOf,
        caveats: [...CAVEATS],
        config: {
          ttlEnabled: config.ttl.enabled,
          defaultTtlDays: config.ttl.defaultDays,
          extensionDays: config.ttl.extensionDays,
          deletedRetentionDays: config.cleanup.deletedRetentionDays,
        },
        auditSince: timestamp(audit.audit_since),
        totals: activity(current),
        previous: range.previous ? activity(totalRow('previous')) : null,
        series: analyticsBucketDates(range).map((date) => ({
          date,
          previousDate: range.previous ? priorDate(date, range.calendarDays) : null,
          current: activity(bucketRow('current', date)),
          previous: range.previous ? activity(bucketRow('previous', date)) : null,
        })),
        ownerKinds: {
          user: number(current?.by_user),
          service_key: number(current?.by_service_key),
          unresolved: number(current?.by_unresolved),
        },
        current: {
          live: number(state.live),
          expiringSoon: number(state.expiring_soon),
          noExpiry: number(state.no_expiry),
          storageBytes: number(state.storage_bytes),
          liveBytes: number(state.live_bytes),
          restorable: number(state.restorable),
          expiredRecently: number(state.expired_recently),
          purgedRecently: number(state.purged_recently),
        },
        endings: {
          expired: number(state.ended_expired),
          deleted: number(state.ended_deleted),
          purged: number(state.ended_purged),
          restored: number(audit.restored),
        },
        extensions: {
          sites: number(audit.cohort_sites),
          none: number(audit.ext_none),
          one: number(audit.ext_one),
          two: number(audit.ext_two),
          three: number(audit.ext_three),
          fourOrMore: number(audit.ext_four_or_more),
        },
        lifetime: {
          ended: number(state.lifetime_ended),
          medianSeconds: nullableNumber(state.lifetime_p50),
          p90Seconds: nullableNumber(state.lifetime_p90),
          bins: SITES_LIFETIME_BINS.map((bin) => ({ bin, count: number(state[`bin_${bin}`]) })),
        },
        publishers: {
          items: publishers.map((row) => ({
            key: String(row.owner_key),
            label: String(row.label),
            ownerKind: ownerKind(row.owner_kind),
            published: number(row.published),
            updates: number(row.updates),
            liveSites: number(row.live_sites),
            liveBytes: number(row.live_bytes),
            lastActivityAt: timestamp(row.last_activity_at),
          })),
          total: number(publishers[0]?.ranking_total),
          limit: RANKING_LIMIT,
        },
        largest: largest.map((row) => ({
          siteId: String(row.site_id),
          name: String(row.name),
          owner: { key: String(row.owner_key), label: String(row.label), ownerKind: ownerKind(row.owner_kind) },
          visibility: row.visibility === 'private' ? 'private' : 'public',
          sizeBytes: number(row.size_bytes),
          fileCount: number(row.file_count),
          updates: number(row.updates),
          expiresAt: timestamp(row.expires_at),
        })),
        publisherOptions: {
          items: options.map((row) => ({
            key: String(row.owner_key),
            label: String(row.label),
            ownerKind: ownerKind(row.owner_kind),
          })),
          total: number(options[0]?.option_total),
          truncated: number(options[0]?.option_total) > OPTIONS_LIMIT,
        },
      };
    });
  }

  /** Window events: site creations and every later version upload, bucketed like the other calendar views. */
  private eventsSql(query: SitesAnalyticsQuery, range: ResolvedAnalyticsRange, bind: Bindings): string {
    const start = range.previous?.fromUtc ?? range.fromUtc;
    return `WITH ${scopedSites(query, bind)},
    window_versions AS MATERIALIZED (
      SELECT v."siteId" AS site_id, v."createdAt" AS created_at, v.id
      FROM site_versions v
      WHERE v."createdAt" >= ${bind.add(start)}::timestamptz AND v."createdAt" < ${bind.add(range.toUtc)}::timestamptz
    ), first_versions AS (
      SELECT DISTINCT ON (f."siteId") f."siteId" AS site_id, f.id
      FROM site_versions f
      WHERE f."siteId" IN (SELECT site_id FROM window_versions)
      ORDER BY f."siteId", f."createdAt", f.id
    ), updates AS (
      SELECT v.site_id, v.created_at
      FROM window_versions v JOIN first_versions fv ON fv.site_id = v.site_id
      WHERE v.id <> fv.id
    ), events AS (
      SELECT 'published' AS kind, s.site_id, s.owner_key, s.owner_kind, s.visibility, s.created_at AS at
      FROM scoped s
      WHERE s.created_at >= ${bind.add(start)}::timestamptz AND s.created_at < ${bind.add(range.toUtc)}::timestamptz
      UNION ALL
      SELECT 'update', s.site_id, s.owner_key, s.owner_kind, s.visibility, u.created_at
      FROM updates u JOIN scoped s ON s.site_id = u.site_id
    ), facts AS (
      SELECT *,
        CASE WHEN at >= ${bind.add(range.fromUtc)}::timestamptz THEN 'current' ELSE 'previous' END AS period,
        date_trunc(${bind.add(range.interval)}, ((at AT TIME ZONE ${bind.add(range.timezone)})::date +
          CASE WHEN at < ${bind.add(range.fromUtc)}::timestamptz THEN ${bind.add(
      range.calendarDays
    )}::int ELSE 0 END)::timestamp)::date::text AS bucket
      FROM events
    )`;
  }

  /** Activity and the publisher ranking share one event scan; rows come back tagged and as JSON objects. */
  private async activityAndPublishers(
    trx: Knex.Transaction,
    query: SitesAnalyticsQuery,
    range: ResolvedAnalyticsRange
  ): Promise<{ activity: SqlRow[]; publishers: SqlRow[] }> {
    const bind = new Bindings();
    const events = this.eventsSql(query, range, bind);
    const asOf = bind.add(range.asOf);
    const sql = `${events}, ${LABELS},
    activity_rows AS (
      SELECT period, bucket, GROUPING(bucket) AS grouped_bucket,
        COUNT(*) FILTER (WHERE kind = 'published')::int AS published,
        COUNT(*) FILTER (WHERE kind = 'update')::int AS updates,
        COUNT(DISTINCT owner_key)::int AS publishers,
        COUNT(*) FILTER (WHERE kind = 'published' AND visibility = 'private')::int AS private_published,
        COUNT(*) FILTER (WHERE kind = 'published' AND visibility <> 'private')::int AS public_published,
        COUNT(*) FILTER (WHERE kind = 'published' AND owner_kind = 'user')::int AS by_user,
        COUNT(*) FILTER (WHERE kind = 'published' AND owner_kind = 'service_key')::int AS by_service_key,
        COUNT(*) FILTER (WHERE kind = 'published' AND owner_kind = 'unresolved')::int AS by_unresolved
      FROM facts GROUP BY GROUPING SETS ((period), (period, bucket))
    ), window_activity AS (
      SELECT owner_key,
        COUNT(*) FILTER (WHERE kind = 'published')::int AS published,
        COUNT(*) FILTER (WHERE kind = 'update')::int AS updates,
        MAX(at) AS last_activity_at
      FROM facts WHERE period = 'current' GROUP BY owner_key
    ), live AS (
      SELECT owner_key, COUNT(*)::int AS live_sites, COALESCE(SUM(size_bytes), 0)::text AS live_bytes
      FROM scoped
      WHERE status = 'active' AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ${asOf}::timestamptz)
      GROUP BY owner_key
    ), ranked AS (
      SELECT w.*, l.label, l.owner_kind, COALESCE(live.live_sites, 0) AS live_sites,
        COALESCE(live.live_bytes, '0') AS live_bytes, COUNT(*) OVER ()::int AS ranking_total,
        row_number() OVER (ORDER BY w.published DESC, w.updates DESC, l.label, w.owner_key) AS rank
      FROM window_activity w
      JOIN labels l ON l.owner_key = w.owner_key
      LEFT JOIN live ON live.owner_key = w.owner_key
    )
    SELECT 'activity' AS row_type, to_jsonb(a) AS data FROM activity_rows a
    UNION ALL
    SELECT 'publisher', to_jsonb(r) FROM ranked r WHERE r.rank <= ${RANKING_LIMIT}`;
    const rows = (await trx.raw(sql, bind.values)).rows as { row_type: string; data: SqlRow }[];
    return {
      activity: rows.filter((row) => row.row_type === 'activity').map((row) => row.data),
      publishers: rows
        .filter((row) => row.row_type === 'publisher')
        .map((row) => row.data)
        .sort((a, b) => number(a.rank) - number(b.rank)),
    };
  }

  /**
   * Current state as of the request plus window endings and lifetimes. An active site past its expiry counts as expired,
   * and restorable mirrors the owner's deleted view: retained, inside the retention window, active version still stored.
   */
  private async state(
    trx: Knex.Transaction,
    query: SitesAnalyticsQuery,
    range: ResolvedAnalyticsRange,
    config: ResolvedSitesConfig
  ): Promise<SqlRow[]> {
    const bind = new Bindings();
    const asOf = () => `${bind.add(range.asOf)}::timestamptz`;
    const inWindow = (column: string) =>
      `${column} >= ${bind.add(range.fromUtc)}::timestamptz AND ${column} < ${bind.add(range.toUtc)}::timestamptz`;
    const sitesSql = scopedSites(query, bind);
    const effective = `effective AS (
      SELECT *,
        CASE WHEN status = 'active' AND expires_at IS NOT NULL AND expires_at <= ${asOf()} THEN 'expired' ELSE status END AS state,
        CASE WHEN status = 'active' AND expires_at IS NOT NULL AND expires_at <= ${asOf()} THEN expires_at
          WHEN status = 'expired' THEN COALESCE(expires_at, deleted_at)
          WHEN status IN ('deleted', 'purged') THEN COALESCE(deleted_at, expires_at) END AS ended_at
      FROM scoped
    ), measured AS (
      SELECT *, state = 'active' AND deleted_at IS NULL AS live,
        state = 'deleted'
          AND deleted_at > ${asOf()} - make_interval(days => ${bind.add(config.cleanup.deletedRetentionDays)}::int)
          AND EXISTS (
            SELECT 1 FROM site_versions v
            WHERE v."siteId" = site_id AND v."versionId" = active_version_id AND v."deletedAt" IS NULL
          ) AS restorable,
        CASE WHEN ended_at IS NOT NULL AND ${inWindow(
          'ended_at'
        )} THEN GREATEST(EXTRACT(EPOCH FROM ended_at - created_at), 0) END AS lifetime
      FROM effective
    )`;
    const bins = SITES_LIFETIME_BINS.map((bin) => {
      const [low, high] = LIFETIME_BOUNDS[bin];
      return `COUNT(*) FILTER (WHERE lifetime >= ${low}${
        high == null ? '' : ` AND lifetime < ${high}`
      })::int AS "bin_${bin}"`;
    }).join(',\n        ');
    const sql = `WITH ${sitesSql}, ${effective}
      SELECT
        COUNT(*) FILTER (WHERE live)::int AS live,
        COUNT(*) FILTER (WHERE live AND expires_at IS NOT NULL AND expires_at < ${asOf()} + interval '${EXPIRING_SOON_HOURS} hours')::int AS expiring_soon,
        COUNT(*) FILTER (WHERE live AND expires_at IS NULL)::int AS no_expiry,
        COALESCE(SUM(size_bytes) FILTER (WHERE live OR restorable), 0)::text AS storage_bytes,
        COALESCE(SUM(size_bytes) FILTER (WHERE live), 0)::text AS live_bytes,
        COUNT(*) FILTER (WHERE restorable)::int AS restorable,
        COUNT(*) FILTER (WHERE state = 'expired' AND ended_at >= ${asOf()} - interval '${RECENT_DAYS} days')::int AS expired_recently,
        COUNT(*) FILTER (WHERE state = 'purged' AND updated_at >= ${asOf()} - interval '${RECENT_DAYS} days')::int AS purged_recently,
        COUNT(*) FILTER (WHERE state = 'expired' AND ${inWindow('ended_at')})::int AS ended_expired,
        COUNT(*) FILTER (WHERE state IN ('deleted', 'purged') AND ${inWindow('deleted_at')})::int AS ended_deleted,
        COUNT(*) FILTER (WHERE state = 'purged' AND ${inWindow('updated_at')})::int AS ended_purged,
        COUNT(lifetime)::int AS lifetime_ended,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY lifetime) AS lifetime_p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY lifetime) AS lifetime_p90,
        ${bins}
      FROM measured`;
    return (await trx.raw(sql, bind.values)).rows;
  }

  private async audit(
    trx: Knex.Transaction,
    query: SitesAnalyticsQuery,
    range: ResolvedAnalyticsRange
  ): Promise<SqlRow[]> {
    const bind = new Bindings();
    const sitesSql = scopedSites(query, bind);
    const sql = `WITH ${sitesSql},
    cohort AS (
      SELECT site_id FROM scoped
      WHERE created_at >= ${bind.add(range.fromUtc)}::timestamptz AND created_at < ${bind.add(range.toUtc)}::timestamptz
    ), extensions AS (
      SELECT a.meta->>'siteId' AS site_id, COUNT(*)::int AS n
      FROM auth_audit_events a
      WHERE a.event = 'sites.extended' AND a.outcome = 'success' AND a."createdAt" >= ${bind.add(
        range.fromUtc
      )}::timestamptz
      GROUP BY 1
    ), per_site AS (
      SELECT c.site_id, COALESCE(e.n, 0) AS n FROM cohort c LEFT JOIN extensions e ON e.site_id = c.site_id
    )
    SELECT
      (SELECT COUNT(*)::int FROM auth_audit_events a JOIN scoped s ON s.site_id = a.meta->>'siteId'
        WHERE a.event = 'sites.restored' AND a.outcome = 'success'
          AND a."createdAt" >= ${bind.add(range.fromUtc)}::timestamptz AND a."createdAt" < ${bind.add(
      range.toUtc
    )}::timestamptz) AS restored,
      (SELECT m.migration_time FROM _knex_migrations m WHERE m.name LIKE ${bind.add(
        `${SITE_AUDIT_MIGRATION}%`
      )} ORDER BY m.migration_time LIMIT 1) AS audit_since,
      COUNT(*)::int AS cohort_sites,
      COUNT(*) FILTER (WHERE n = 0)::int AS ext_none,
      COUNT(*) FILTER (WHERE n = 1)::int AS ext_one,
      COUNT(*) FILTER (WHERE n = 2)::int AS ext_two,
      COUNT(*) FILTER (WHERE n = 3)::int AS ext_three,
      COUNT(*) FILTER (WHERE n >= 4)::int AS ext_four_or_more
    FROM per_site`;
    return (await trx.raw(sql, bind.values)).rows;
  }

  private async largest(
    trx: Knex.Transaction,
    query: SitesAnalyticsQuery,
    range: ResolvedAnalyticsRange
  ): Promise<SqlRow[]> {
    const bind = new Bindings();
    const sitesSql = scopedSites(query, bind);
    const sql = `WITH ${sitesSql}, ${LABELS},
    live AS (
      SELECT * FROM scoped
      WHERE status = 'active' AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ${bind.add(
        range.asOf
      )}::timestamptz)
      ORDER BY size_bytes DESC, created_at DESC, site_id
      LIMIT ${RANKING_LIMIT}
    )
    SELECT live.site_id, live.name, live.visibility, live.size_bytes::text AS size_bytes, live.file_count,
      live.expires_at, live.owner_key, l.label, l.owner_kind,
      GREATEST((SELECT COUNT(*) FROM site_versions v WHERE v."siteId" = live.site_id) - 1, 0)::int AS updates
    FROM live JOIN labels l ON l.owner_key = live.owner_key
    ORDER BY live.size_bytes DESC, live.created_at DESC, live.site_id`;
    return (await trx.raw(sql, bind.values)).rows;
  }

  private async publisherOptions(trx: Knex.Transaction): Promise<SqlRow[]> {
    const bind = new Bindings();
    const sql = `WITH ${scopedSites({}, bind)}, ${LABELS},
    latest AS (SELECT owner_key, MAX(created_at) AS latest FROM all_sites GROUP BY owner_key)
    SELECT l.owner_key, l.label, l.owner_kind, COUNT(*) OVER ()::int AS option_total
    FROM labels l JOIN latest ON latest.owner_key = l.owner_key
    ORDER BY latest.latest DESC, l.owner_key
    LIMIT ${OPTIONS_LIMIT}`;
    return (await trx.raw(sql, bind.values)).rows;
  }
}
