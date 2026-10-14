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

jest.mock('server/lib/dependencies', () => ({ defaultDb: {} }));
const mockResolveRange = jest.fn();
jest.mock('./query', () => ({
  ...jest.requireActual('./query'),
  resolveAnalyticsRange: (...args: unknown[]) => mockResolveRange(...args),
}));

import knexFactory from 'knex';
import { BuildStatus } from 'shared/constants';
import DeploymentAnalyticsService, {
  DEPLOYMENT_REASON_LIMIT,
  DEPLOYMENT_REPOSITORY_LIMIT,
  parseDeploymentAnalyticsQuery,
  parseDeploymentRequestsQuery,
  serializeDeploymentTotals,
} from './DeploymentAnalyticsService';
import type { ResolvedAnalyticsRange } from './query';

const range: ResolvedAnalyticsRange = {
  from: '2026-03-08',
  to: '2026-03-10',
  timezone: 'America/Los_Angeles',
  fromUtc: '2026-03-08T08:00:00.000Z',
  toUtc: '2026-03-10T07:00:00.000Z',
  dates: ['2026-03-08', '2026-03-09'],
  calendarDays: 2,
  interval: 'day',
  compare: true,
  asOf: '2026-03-10T08:00:00.000Z',
  previous: {
    from: '2026-03-06',
    to: '2026-03-08',
    fromUtc: '2026-03-06T08:00:00.000Z',
    toUtc: '2026-03-08T08:00:00.000Z',
    dates: ['2026-03-06', '2026-03-07'],
  },
};
const compiler = knexFactory({ client: 'pg' });
function serviceWithRow(row: Record<string, unknown>) {
  const raw = jest.fn((sql: string, bindings?: unknown[]) => {
    if (sql.startsWith('SET ')) return Promise.resolve();
    if (sql.includes('scoped AS (')) return Promise.resolve({ rows: [row] });
    return compiler.raw(sql, bindings as any);
  });
  const trx = Object.assign((table: string) => compiler(table), { raw, with: compiler.with.bind(compiler) });
  const transaction = jest.fn(async (callback) => callback(trx));
  return { service: new DeploymentAnalyticsService({ knex: { transaction } } as any), raw };
}
const summaryRow = {
  periods: [
    {
      period: 'current',
      requested: 10,
      claimed: 8,
      succeeded: 6,
      failed: 2,
      superseded: 1,
      blocked: 1,
      torn_down: 0,
      unresolved: 0,
      ready_samples: 6,
      ready_p50: '4.5',
      ready_p90: 12,
      wait_samples: 8,
      wait_p50: 0.25,
      wait_p90: 1,
    },
    { period: 'previous', requested: 3, succeeded: 3, failed: 0, ready_samples: 3, ready_p50: 5, ready_p90: 6 },
  ],
  buckets: [
    { period: 'current', bucket: '2026-03-09', requested: 10, succeeded: 6, failed: 2 },
    { period: 'previous', bucket: '2026-03-08', requested: 3, succeeded: 3, failed: 0 },
  ],
  repositories: [
    {
      repositoryId: 4,
      fullName: 'org/repo',
      githubInstallationId: 8,
      requested: 9,
      succeeded: 6,
      failed: 2,
      ready_p50: 4.5,
    },
    {
      repositoryId: null,
      fullName: null,
      githubInstallationId: null,
      requested: 1,
      succeeded: 0,
      failed: 0,
      ready_p50: null,
    },
  ],
  repository_total: '2',
  origins: [
    { origin: 'push', requested: 7, succeeded: 5, failed: 1 },
    { origin: 'unknown', requested: 2, succeeded: 1, failed: 1 },
    { origin: 'agent', requested: 1, succeeded: 0, failed: 0 },
  ],
  reasons: [{ reason: 'image build failed for service #', count: 2 }],
  reason_total: 1,
  collection_started_at: new Date('2026-01-01T00:00:00Z'),
  as_of: new Date('2026-03-10T08:00:01Z'),
};
const params = (query = '') => new URLSearchParams(query);

describe('DeploymentAnalyticsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRange.mockResolvedValue(range);
  });
  afterAll(async () => {
    await compiler.destroy();
  });

  it('combines the shared calendar window with the environment scope', () => {
    expect(
      parseDeploymentAnalyticsQuery(params('from=2026-03-01&to=2026-03-08&repositoryId=4&environmentType=static'))
    ).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-08',
      repositoryId: 4,
      environmentType: 'static',
      compare: true,
    });
    expect(() => parseDeploymentAnalyticsQuery(params('repositoryId=4&unattributed=true'))).toThrow();
    expect(() => parseDeploymentAnalyticsQuery(params('interval=month'))).toThrow();
  });

  it('serializes totals with a resolved-only success rate and finite percentiles', () => {
    expect(serializeDeploymentTotals()).toEqual({
      requested: 0,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      superseded: 0,
      blocked: 0,
      tornDown: 0,
      unresolved: 0,
      successRate: null,
      timeToReady: { samples: 0, p50Minutes: null, p90Minutes: null },
      queueWait: { samples: 0, p50Minutes: null, p90Minutes: null },
    });
    expect(
      serializeDeploymentTotals({
        requested: '-1',
        succeeded: 3,
        failed: 1,
        blocked: 2,
        ready_samples: 3,
        ready_p50: 'NaN',
      })
    ).toMatchObject({ requested: 0, blocked: 2, successRate: 0.75, timeToReady: { samples: 3, p50Minutes: null } });
  });

  it('resolves each request through its own run and reports outcomes, timing and rankings', async () => {
    const { service, raw } = serviceWithRow(summaryRow);
    const result = await service.getSummary(
      parseDeploymentAnalyticsQuery(params('repositoryId=4&organization=Org&environmentAuthor=Alice'))
    );

    expect(result.totals).toEqual({
      requested: 10,
      claimed: 8,
      succeeded: 6,
      failed: 2,
      superseded: 1,
      blocked: 1,
      tornDown: 0,
      unresolved: 0,
      successRate: 0.75,
      timeToReady: { samples: 6, p50Minutes: 4.5, p90Minutes: 12 },
      queueWait: { samples: 8, p50Minutes: 0.25, p90Minutes: 1 },
    });
    expect(result.previousTotals).toMatchObject({ requested: 3, succeeded: 3, successRate: 1 });
    expect(result.buckets).toEqual([
      {
        date: '2026-03-08',
        requested: 0,
        succeeded: 0,
        failed: 0,
        previousRequested: 3,
        previousSucceeded: 3,
        previousFailed: 0,
      },
      {
        date: '2026-03-09',
        requested: 10,
        succeeded: 6,
        failed: 2,
        previousRequested: 0,
        previousSucceeded: 0,
        previousFailed: 0,
      },
    ]);
    expect(result.repositories).toEqual({
      items: [
        {
          repositoryId: 4,
          fullName: 'org/repo',
          githubInstallationId: 8,
          requested: 9,
          succeeded: 6,
          failed: 2,
          successRate: 0.75,
          timeToReadyP50Minutes: 4.5,
        },
        {
          repositoryId: null,
          fullName: null,
          githubInstallationId: null,
          requested: 1,
          succeeded: 0,
          failed: 0,
          successRate: null,
          timeToReadyP50Minutes: null,
        },
      ],
      total: 2,
      limit: DEPLOYMENT_REPOSITORY_LIMIT,
    });
    expect(result.origins.map((row) => [row.origin, row.successRate])).toEqual([
      ['push', 5 / 6],
      ['unknown', 0.5],
      ['agent', null],
    ]);
    expect(result.failureReasons).toEqual({
      items: [{ reason: 'image build failed for service #', count: 2 }],
      total: 1,
      limit: DEPLOYMENT_REASON_LIMIT,
    });
    expect(result.collectionStartedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.asOf).toBe('2026-03-10T08:00:01.000Z');
    expect(result.scope).toEqual({
      repositoryId: 4,
      organization: 'Org',
      environmentType: 'all',
      environmentAuthor: 'Alice',
      unattributed: false,
    });
    expect(result.caveats.length).toBeGreaterThan(0);

    expect(raw.mock.calls[0][0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const [sql, bindings = []] = raw.mock.calls.find(([statement]) => statement.includes('scoped AS ('))!;
    expect(sql).toContain('scoped AS (with "repository_candidates" as');
    expect(sql).toContain(`(b."pullRequestId" IS NOT NULL OR b."triggerType" = 'api')`);
    expect(sql).toContain(`JOIN scoped s ON s.id = ev."buildId"`);
    expect(sql).toContain(`AND ev."createdAt" >= ?::timestamptz AND ev."createdAt" < ?::timestamptz`);
    expect(sql).toContain(
      `CASE WHEN ev.origin IN ('push', 'label', 'pr_open', 'config_push', 'api', 'redeploy', 'mcp', 'comment', 'agent') THEN ev.origin ELSE 'unknown' END AS origin`
    );
    expect(sql).toContain(`"e"."lastTornDownAt"`);
    expect(sql).toContain(`ev.kind = 'deploy_requested' AND ev."runUUID" IS NOT NULL`);
    expect(sql).toContain(
      `e."buildId" = r."buildId" AND e."runUUID" = r.request_id AND e.kind IN ('run_claimed', 'run_blocked', 'run_superseded', 'run_finished')`
    );
    expect(sql).not.toContain('finished_at');
    expect(sql).toContain(
      `min(e."createdAt") FILTER (WHERE e.kind = 'run_finished' AND e.status = 'succeeded') AS first_succeeded_at`
    );
    expect(sql).toContain(
      `(array_agg(e.status ORDER BY (COALESCE(e.meta->>'rollout', 'false') = 'true') DESC, CASE WHEN (COALESCE(e.meta->>'rollout', 'false') = 'true') THEN e."createdAt" END DESC, e."createdAt", e.id) FILTER (WHERE e.kind = 'run_finished'))[1] AS finished_status`
    );
    expect(sql).toContain(`EXTRACT(EPOCH FROM (first_succeeded_at - requested_at)) / 60.0) END AS ready_minutes`);
    expect(sql).toContain(`WHEN finished_status IN ('succeeded', 'failed') THEN finished_status`);
    expect(sql).toContain(
      `WHEN blocked_at IS NOT NULL AND blocked_reason IN ('tearing_down', 'torn_down', 'pull_request_closed', 'build_deleted', 'build_missing') THEN 'torn_down'`
    );
    expect(sql).toContain(`WHEN blocked_at IS NOT NULL THEN 'blocked'`);
    expect(sql).toContain(
      `superseded_block IN ('tearing_down', 'torn_down', 'pull_request_closed', 'build_deleted', 'build_missing') THEN 'torn_down'`
    );
    expect(sql).toContain(`WHEN superseded_at IS NOT NULL THEN 'superseded'`);
    expect(sql).toContain(`WHEN torn_down_at > requested_at THEN 'torn_down'`);
    expect(sql).toContain(`COALESCE(services, 1) > 0`);
    expect(sql).toContain(`GREATEST(0, EXTRACT(EPOCH FROM (claimed_at - requested_at)) / 60.0)`);
    expect(sql).not.toContain('deploy_status');
    expect(sql).not.toContain('build_status');
    expect(sql).toContain('runs AS MATERIALIZED');
    expect(sql).toContain('measured AS MATERIALIZED');
    expect(sql).not.toContain('LEAD(');
    expect(sql).not.toContain('next_requested_at');
    expect(sql).toContain(
      `btrim(left(regexp_replace(btrim(finished_reason), '\\m[0-9a-f]{6,}\\M|\\d+', '#', 'g'), 120))`
    );
    expect(sql).toContain(`min("createdAt") FROM build_events WHERE kind = 'deploy_requested'`);
    expect(sql.split('?').length - 1).toBe(bindings.length);
    expect(bindings).toEqual(
      expect.arrayContaining([
        4,
        'Org',
        'Alice',
        range.fromUtc,
        range.previous!.fromUtc,
        range.toUtc,
        'day',
        'America/Los_Angeles',
        2,
      ])
    );
    expect(bindings.slice(-6)).toEqual([
      range.fromUtc,
      range.previous!.fromUtc,
      range.toUtc,
      'day',
      'America/Los_Angeles',
      2,
    ]);
  });

  it('omits the previous period and starts the window at the range start without comparison', async () => {
    mockResolveRange.mockResolvedValue({ ...range, compare: false, previous: null });
    const { service, raw } = serviceWithRow({
      ...summaryRow,
      periods: [],
      buckets: [],
      repositories: [],
      origins: [],
      reasons: [],
      repository_total: 0,
      reason_total: 0,
      collection_started_at: null,
    });
    const result = await service.getSummary(parseDeploymentAnalyticsQuery(params('compare=false')));
    expect(result.previousTotals).toBeNull();
    expect(result.totals.requested).toBe(0);
    expect(result.buckets.every((row) => row.previousRequested === null && row.requested === 0)).toBe(true);
    expect(result.collectionStartedAt).toBeNull();
    const [, bindings = []] = raw.mock.calls.find(([statement]) => statement.includes('scoped AS ('))!;
    expect(bindings.slice(-6, -3)).toEqual([range.fromUtc, range.fromUtc, range.toUtc]);
  });
});

describe('deploy request records', () => {
  const recordsRow = {
    total: '2',
    records: [
      {
        request_id: 'r3',
        buildId: 7,
        uuid: 'b7',
        namespace: 'env-7',
        isStatic: false,
        build_status: BuildStatus.DEPLOYED,
        deleted_at: null,
        pull_request_id: 11,
        pull_request_number: 412,
        pull_request_title: 'Add thing',
        pull_request_author: 'alice',
        repositoryId: 4,
        fullName: 'org/repo',
        githubInstallationId: 8,
        origin: 'push',
        period: 'previous',
        requested_at: '2026-03-07T10:00:00Z',
        outcome: 'failed',
        claimed_at: '2026-03-07T10:00:30Z',
        blocked_at: null,
        superseded_at: null,
        decided_at: '2026-03-07T10:06:00Z',
        first_succeeded_at: null,
        wait_minutes: '0.5',
        ready_minutes: null,
        services: 2,
        failed: 1,
        blocked_reason: null,
        superseded_reason: null,
        finished_reason: 'Build failed for service api-123 (attempt 2)',
        reason: 'Build failed for service api-# (attempt #)',
        service_outcomes: [
          { name: 'api', type: 'docker', status: 'build_failed', outcome: 'failed', message: 'Build failed' },
          { name: 7, outcome: 'ready' },
          { name: 'web', outcome: 'done' },
          'junk',
        ],
      },
      {
        request_id: 'r7',
        buildId: 9,
        uuid: 'b9',
        namespace: null,
        isStatic: true,
        build_status: BuildStatus.TORN_DOWN,
        deleted_at: null,
        pull_request_id: null,
        repositoryId: null,
        fullName: null,
        githubInstallationId: null,
        origin: 'cron',
        period: 'current',
        requested_at: '2026-03-09T10:00:00Z',
        outcome: 'torn_down',
        claimed_at: '2026-03-09T10:01:00Z',
        blocked_at: null,
        superseded_at: '2026-03-09T10:02:00Z',
        decided_at: null,
        first_succeeded_at: null,
        wait_minutes: 1,
        ready_minutes: null,
        services: null,
        failed: null,
        blocked_reason: null,
        superseded_reason: 'failure_ignored',
        finished_reason: null,
        reason: 'No reason recorded',
        service_outcomes: null,
      },
    ],
    as_of: new Date('2026-03-10T08:00:01Z'),
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRange.mockResolvedValue(range);
  });

  it('parses the request slice, sort and pagination', () => {
    expect(
      parseDeploymentRequestsQuery(
        params(
          'outcome=failed,superseded,failed&origin=push&reason=Build%20failed%20%23&date=2026-03-09&period=previous&sort=timeToReady:asc&page=2&limit=10'
        )
      )
    ).toMatchObject({
      outcomes: ['failed', 'superseded'],
      origin: 'push',
      reason: 'Build failed #',
      slice: { date: '2026-03-09', period: 'previous' },
      sort: { key: 'timeToReady', descending: false },
      page: 2,
      limit: 10,
    });
    expect(parseDeploymentRequestsQuery(params())).toMatchObject({
      outcomes: [],
      origin: null,
      reason: null,
      slice: { date: null, period: 'current' },
      sort: { key: 'requestedAt', descending: true },
      page: 1,
      limit: 25,
    });
    expect(() => parseDeploymentRequestsQuery(params('outcome=built'))).toThrow('outcome must be');
    expect(() => parseDeploymentRequestsQuery(params('origin=cron'))).toThrow('origin must be');
    expect(() => parseDeploymentRequestsQuery(params('reason=%20'))).toThrow('reason must be');
    expect(() => parseDeploymentRequestsQuery(params(`reason=${'x'.repeat(301)}`))).toThrow('reason must be');
    expect(() => parseDeploymentRequestsQuery(params(`reason=${'\u{1F680}'.repeat(301)}`))).toThrow('reason must be');
    expect(parseDeploymentRequestsQuery(params(`reason=${'\u{1F680}'.repeat(300)}`)).reason).toBe(
      '\u{1F680}'.repeat(300)
    );
    expect(() => parseDeploymentRequestsQuery(params('sort=reason'))).toThrow('sort must be');
    expect(() => parseDeploymentRequestsQuery(params('limit=101'))).toThrow('limit must be');
    expect(() => parseDeploymentRequestsQuery(params('period=last'))).toThrow('period must be');
  });

  it('cuts the summary facts by the slice and maps each row', async () => {
    const { service, raw } = serviceWithRow(recordsRow);
    const result = await service.getRequests(
      parseDeploymentRequestsQuery(
        params(
          'repositoryId=4&outcome=failed,superseded&origin=push&reason=image%20build%20failed%20for%20service%20%23&date=2026-03-09&period=previous&sort=timeToReady&page=2&limit=10'
        )
      )
    );
    const [sql, bindings = []] = raw.mock.calls.find(([statement]) => statement.includes('matched AS MATERIALIZED'))!;
    expect(sql).toContain('d.superseded_reason, d.decided_at, d.failed, d.service_outcomes');
    expect(sql).toContain(`e.kind IN ('run_superseded', 'run_finished')`);
    expect(sql.indexOf('service_outcomes')).toBeGreaterThan(sql.indexOf('matched AS MATERIALIZED'));
    expect(sql).toContain(
      `(array_agg(e."createdAt" ORDER BY (COALESCE(e.meta->>'rollout', 'false') = 'true') DESC, CASE WHEN (COALESCE(e.meta->>'rollout', 'false') = 'true') THEN e."createdAt" END DESC, e."createdAt", e.id) FILTER (WHERE e.kind = 'run_finished'))[1] AS decided_at`
    );
    expect(sql).toContain(`e.meta->'serviceOutcomes'`);
    expect(sql).toContain(
      `matched AS MATERIALIZED (SELECT m.* FROM measured m WHERE m.period = ? AND m.outcome IN (?, ?) AND m.origin = ? AND m.outcome = 'failed' AND m.reason = ? AND to_char(date_trunc(?, ("m"."requested_at" AT TIME ZONE ?) + (? * interval '1 day')), 'YYYY-MM-DD') = ?)`
    );
    expect(sql).toContain(
      'FROM (SELECT * FROM matched m ORDER BY m.ready_minutes DESC NULLS LAST, m.requested_at DESC, m.id DESC LIMIT ? OFFSET ?) m'
    );
    expect(sql).toContain('JOIN builds b ON b.id = m."buildId"');
    expect(sql).toContain('LEFT JOIN pull_requests p ON p.id = b."pullRequestId"');
    expect(sql.split('?').length - 1).toBe(bindings.length);
    expect(bindings.slice(-11)).toEqual([
      'previous',
      'failed',
      'superseded',
      'push',
      'image build failed for service #',
      'day',
      'America/Los_Angeles',
      2,
      '2026-03-09',
      10,
      10,
    ]);
    expect(result.pagination).toEqual({ page: 2, limit: 10, total: 2, hasMore: false });
    expect(result.slice).toEqual({
      outcomes: ['failed', 'superseded'],
      origin: 'push',
      reason: 'image build failed for service #',
      date: '2026-03-09',
      period: 'previous',
      sort: 'timeToReady:desc',
    });
    expect(result.asOf).toBe('2026-03-10T08:00:01.000Z');
    expect(result.caveats).toContain(
      'Each row shows what its run recorded. Open the environment for its current state.'
    );
    expect(result.records).toEqual([
      {
        requestId: 'r3',
        id: 7,
        uuid: 'b7',
        namespace: 'env-7',
        isStatic: false,
        resourceAvailable: true,
        pullRequest: { number: 412, title: 'Add thing', author: 'alice' },
        repositoryId: 4,
        fullName: 'org/repo',
        githubInstallationId: 8,
        origin: 'push',
        period: 'previous',
        requestedAt: '2026-03-07T10:00:00.000Z',
        outcome: 'failed',
        claimedAt: '2026-03-07T10:00:30.000Z',
        blockedAt: null,
        supersededAt: null,
        decidedAt: '2026-03-07T10:06:00.000Z',
        readyAt: null,
        queueWaitMinutes: 0.5,
        timeToReadyMinutes: null,
        services: 2,
        failed: 1,
        exitReason: null,
        reason: 'Build failed for service api-123 (attempt 2)',
        serviceOutcomes: [
          { name: 'api', type: 'docker', status: 'build_failed', outcome: 'failed', message: 'Build failed' },
        ],
      },
      {
        requestId: 'r7',
        id: 9,
        uuid: 'b9',
        namespace: null,
        isStatic: true,
        resourceAvailable: true,
        pullRequest: null,
        repositoryId: null,
        fullName: null,
        githubInstallationId: null,
        origin: 'unknown',
        period: 'current',
        requestedAt: '2026-03-09T10:00:00.000Z',
        outcome: 'torn_down',
        claimedAt: '2026-03-09T10:01:00.000Z',
        blockedAt: null,
        supersededAt: '2026-03-09T10:02:00.000Z',
        decidedAt: null,
        readyAt: null,
        queueWaitMinutes: 1,
        timeToReadyMinutes: null,
        services: null,
        failed: null,
        exitReason: 'failure_ignored',
        reason: null,
        serviceOutcomes: null,
      },
    ]);
  });

  it('lists every outcome ascending by request time when no slice is given', async () => {
    const { service, raw } = serviceWithRow({ ...recordsRow, total: 0, records: [] });
    const result = await service.getRequests(parseDeploymentRequestsQuery(params('sort=requestedAt:asc')));
    const [sql, bindings = []] = raw.mock.calls.find(([statement]) => statement.includes('matched AS MATERIALIZED'))!;
    expect(sql).toContain('matched AS MATERIALIZED (SELECT m.* FROM measured m WHERE m.period = ?)');
    expect(sql).toContain(
      'FROM (SELECT * FROM matched m ORDER BY m.requested_at ASC NULLS LAST, m.requested_at ASC, m.id ASC LIMIT ? OFFSET ?) m'
    );
    expect(bindings.slice(-3)).toEqual(['current', 25, 0]);
    expect(result.records).toEqual([]);
    expect(result.pagination).toEqual({ page: 1, limit: 25, total: 0, hasMore: false });
  });

  it('keeps the summary facts free of record-only columns', async () => {
    const { service, raw } = serviceWithRow(summaryRow);
    await service.getSummary(parseDeploymentAnalyticsQuery(params()));
    const [sql] = raw.mock.calls.find(([statement]) => statement.includes('scoped AS ('))!;
    expect(sql).not.toContain('decided_at');
    expect(sql).not.toContain('service_outcomes');
    expect(sql).not.toContain('superseded_reason');
  });

  it('rejects the previous period without a comparison and dates outside the window', async () => {
    const { service } = serviceWithRow(recordsRow);
    mockResolveRange.mockResolvedValue({ ...range, compare: false, previous: null });
    await expect(service.getRequests(parseDeploymentRequestsQuery(params('period=previous')))).rejects.toThrow(
      'period must be current when compare is false.'
    );
    mockResolveRange.mockResolvedValue(range);
    await expect(service.getRequests(parseDeploymentRequestsQuery(params('date=2026-03-07')))).rejects.toThrow(
      'date must be the start of a bucket inside the window.'
    );
  });
});
