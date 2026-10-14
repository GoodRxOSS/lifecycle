jest.mock('server/lib/dependencies', () => ({ defaultDb: {} }));
jest.mock('./query', () => ({ ...jest.requireActual('./query'), resolveAnalyticsRange: jest.fn() }));

import knexFactory, { type Knex } from 'knex';
import EnvironmentAnalyticsService, {
  analyticsEnvironmentRecord,
  parseEnvironmentAnalyticsQuery,
  parseEnvironmentAnalyticsScope,
  parseEnvironmentAnalyticsRecordsQuery,
  parseEnvironmentAnalyticsPullRequestsQuery,
  parseManagedServiceRecordsQuery,
} from './EnvironmentAnalyticsService';
import { resolveAnalyticsRange, type ResolvedAnalyticsRange } from './query';

const scope = parseEnvironmentAnalyticsScope(new URLSearchParams());
const range: ResolvedAnalyticsRange = {
  from: '2026-09-30',
  to: '2026-10-02',
  fromUtc: '2026-09-30T00:00:00.000Z',
  toUtc: '2026-10-02T00:00:00.000Z',
  dates: ['2026-09-30', '2026-10-01'],
  timezone: 'UTC',
  interval: 'day',
  compare: false,
  calendarDays: 2,
  previous: null,
  asOf: '2026-10-02T12:00:00.000Z',
};
const comparison: ResolvedAnalyticsRange = {
  ...range,
  compare: true,
  previous: {
    from: '2026-09-28',
    to: range.from,
    fromUtc: '2026-09-28T00:00:00.000Z',
    toUtc: range.fromUtc,
    dates: ['2026-09-28', '2026-09-29'],
  },
};
function row(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    uuid: `env-${id}`,
    namespace: `env-${id}`,
    status: 'deployed',
    isStatic: false,
    triggerType: 'github_pr',
    createdAt: '2026-09-30T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
    deletedAt: null,
    expiresAt: null,
    deployEnabled: true,
    pullRequestId: 1,
    prDeployOnUpdate: true,
    prAuthor: 'Alice',
    pullRequestNumber: 12,
    prTitle: 'Change',
    repositoryId: 4,
    fullName: 'org/repo',
    githubInstallationId: 8,
    author: 'Alice',
    repositoryAmbiguous: false,
    deployRequested: true,
    rolledOut: true,
    firstReadyAt: '2026-09-30T11:00:00Z',
    lastTornDownAt: null,
    deploys: [{ active: true, status: 'ready', publicUrl: '', deployable: { type: 'docker' } }],
    ...overrides,
  };
}
function serviceWithExecutor(
  execute: (query: { sql: string; bindings: readonly unknown[]; method: string }) => unknown
) {
  const knex = knexFactory({ client: 'pg' });
  const queries: Array<{ sql: string; bindings: readonly unknown[]; method: string }> = [];
  jest.spyOn(knex.client, 'runner').mockImplementation(
    (builder: any) =>
      ({
        run: async () => {
          const query = builder.toSQL();
          queries.push(query);
          return execute(query);
        },
      } as any)
  );
  const transaction = async (work: (transaction: Knex) => Promise<unknown>) => work(knex);
  return { service: new EnvironmentAnalyticsService({ knex: { transaction } } as any), queries };
}

type ActivityFixtureBucket = {
  date: string;
  repositoryId: number | null;
  fullName: string | null;
  githubInstallationId: number | null;
  count: number;
};
function activityFixture(current: ActivityFixtureBucket[], previous: ActivityFixtureBucket[] = [], calendar = range) {
  return serviceWithExecutor((query) => {
    if (query.sql.startsWith('SET ')) return { rows: [] };
    if (query.sql.includes(' AS deploys') || query.sql.includes('"pull_requests" as "p"')) return [];
    if (query.method === 'first') return { earliest: null };
    const rows = calendar.previous && query.bindings.includes(calendar.previous.fromUtc) ? previous : current;
    if (query.sql.includes('AS ambiguous')) {
      const totals = new Map<number | null, ActivityFixtureBucket>();
      for (const row of rows) {
        const prior = totals.get(row.repositoryId);
        totals.set(row.repositoryId, { ...row, count: (prior?.count ?? 0) + row.count });
      }
      return [...totals.values()].map((row) => ({ ...row, ambiguous: 0 }));
    }
    const ids = query.bindings.find((value) => Array.isArray(value)) as number[] | undefined;
    const counts = new Map<string, { date: string; key?: string; count: number }>();
    for (const row of rows) {
      const key = ids
        ? row.repositoryId == null
          ? 'unattributed'
          : ids.includes(row.repositoryId)
          ? `repository:${row.repositoryId}`
          : 'other'
        : undefined;
      const identity = `${row.date}:${key ?? ''}`;
      const prior = counts.get(identity);
      counts.set(identity, { date: row.date, ...(key ? { key } : {}), count: (prior?.count ?? 0) + row.count });
    }
    return [...counts.values()];
  });
}

describe('EnvironmentAnalyticsService contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (resolveAnalyticsRange as jest.Mock).mockResolvedValue(range);
  });

  it.each([
    'repositoryId=0',
    'repositoryId=1.5',
    'repositoryId=4&unattributed=true',
    'environmentType=sandbox',
    'environmentAuthor=',
    'rankBy=attempts',
  ])('rejects invalid scope %s', (query) => {
    expect(() => parseEnvironmentAnalyticsQuery(new URLSearchParams(query))).toThrow();
  });

  it.each(['cohort=history', 'phase=failed', 'cohort=current&phase=unknown', 'cohort=current&limit=101', 'page=0'])(
    'rejects invalid drilldown %s',
    (query) => {
      expect(() => parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams(query))).toThrow();
    }
  );

  it.each(['type=configuration', 'type=codefresh', 'type=externalHTTP', 'limit=101', 'page=0', 'page=1.5'])(
    'rejects invalid managed Service query %s',
    (query) => expect(() => parseManagedServiceRecordsQuery(new URLSearchParams(query))).toThrow()
  );

  it('keeps Services current-only with the existing bounded owning-environment scope', () => {
    expect(parseManagedServiceRecordsQuery(new URLSearchParams('from=invalid&type=helm&repositoryId=4'))).toEqual({
      ...scope,
      repositoryId: 4,
      type: 'helm',
      page: 1,
      limit: 25,
    });
  });

  it('current drilldown keeps independent scope and ignores historical dates', () => {
    const query = parseEnvironmentAnalyticsRecordsQuery(
      new URLSearchParams('cohort=current&phase=failed&from=invalid&environmentType=static')
    );
    expect(query).toMatchObject({ cohort: 'current', phase: 'failed', page: 1, limit: 25, environmentType: 'static' });
    expect(query.from).toBeUndefined();
  });

  it('uses service-aware readiness and the correct PR/API pause gate', () => {
    expect(analyticsEnvironmentRecord(row(1) as any).phase).toBe('ready');
    expect(
      analyticsEnvironmentRecord(
        row(2, { deploys: [{ active: true, status: 'built', publicUrl: '', deployable: { type: 'docker' } }] }) as any
      ).phase
    ).toBe('deployed_not_ready');
    expect(
      analyticsEnvironmentRecord(
        row(3, {
          deploys: [{ active: true, status: 'built', publicUrl: '', deployable: { type: 'configuration' } }],
        }) as any
      ).phase
    ).toBe('ready');
    expect(
      analyticsEnvironmentRecord(
        row(4, {
          deploys: [
            { active: true, status: 'pending', publicUrl: 'https://external', deployable: { type: 'externalHTTP' } },
          ],
        }) as any
      ).phase
    ).toBe('ready');
    expect(
      analyticsEnvironmentRecord(row(5, { status: 'pending', prDeployOnUpdate: false, deployEnabled: true }) as any)
        .phase
    ).toBe('paused');
    expect(
      analyticsEnvironmentRecord(
        row(6, { status: 'pending', pullRequestId: null, prDeployOnUpdate: true, deployEnabled: false }) as any
      ).phase
    ).toBe('paused');
    expect(analyticsEnvironmentRecord(row(7, { status: 'config_error' }) as any).phase).toBe('failed');
    expect(analyticsEnvironmentRecord(row(8, { status: 'tearing_down' }) as any).phase).toBe('tearing_down');
  });

  it('retains history metadata without claiming a live UUID resource', () => {
    const record = analyticsEnvironmentRecord(
      row(9, {
        deletedAt: '2026-10-01T12:00:00Z',
        status: 'torn_down',
        repositoryId: null,
        repositoryAmbiguous: true,
      }) as any
    );
    expect(record).toMatchObject({
      id: 9,
      phase: 'torn_down',
      repositoryId: null,
      repositoryAmbiguous: true,
      deletedAt: '2026-10-01T12:00:00.000Z',
      resourceAvailable: false,
    });
    expect(analyticsEnvironmentRecord(row(10, { uuid: null }) as any).resourceAvailable).toBe(false);
  });

  it('keeps inventory usable when a retained record has a nonfinite timestamp', async () => {
    const { service } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      if (query.sql.includes(' AS deploys'))
        return [
          row(1),
          row(2, {
            status: 'error',
            createdAt: Number.POSITIVE_INFINITY,
            updatedAt: Number.NEGATIVE_INFINITY,
            expiresAt: 'not-a-date',
          }),
        ];
      return [];
    });
    const result = await service.getInventory(scope);
    expect(result.totals).toMatchObject({ current: 2, ready: 1, failed: 1, requested: 2, rolledOut: 2, live: 2 });
    expect(result).not.toHaveProperty('exceptions');
    expect(
      analyticsEnvironmentRecord(
        row(2, { createdAt: Number.POSITIVE_INFINITY, updatedAt: Number.NEGATIVE_INFINITY, expiresAt: 'x' }) as any
      )
    ).toMatchObject({ id: 2, createdAt: null, updatedAt: null, expiresAt: null });
    expect(analyticsEnvironmentRecord(row(1) as any).createdAt).toBe('2026-09-30T10:00:00.000Z');
  });

  it('classifies evidence levels per record and counts them in the inventory', () => {
    const shell = analyticsEnvironmentRecord(
      row(3, { status: 'pending', deployRequested: false, rolledOut: false, firstReadyAt: null, deploys: [] }) as any
    );
    expect(shell).toMatchObject({ deployRequested: false, rolledOut: false, live: false, firstReadyAt: null });
    const paused = analyticsEnvironmentRecord(row(4, { prDeployOnUpdate: false }) as any);
    expect(paused).toMatchObject({ deployRequested: true, rolledOut: true, live: false });
    const api = analyticsEnvironmentRecord(
      row(5, { pullRequestId: null, triggerType: 'api', deployEnabled: true }) as any
    );
    expect(api.live).toBe(true);
    expect(analyticsEnvironmentRecord(row(7, { namespaceLive: false }) as any).live).toBe(false);
    expect(analyticsEnvironmentRecord(row(8, { namespaceLive: null }) as any).live).toBe(true);
    const retired = analyticsEnvironmentRecord(
      row(6, { status: 'torn_down', lastTornDownAt: '2026-10-01T12:00:00Z', deploys: [] }) as any
    );
    expect(retired).toMatchObject({
      live: false,
      resourceAvailable: true,
      lastTornDownAt: '2026-10-01T12:00:00.000Z',
    });
  });

  it('counts open PRs without a deploy request only for PR records', async () => {
    const { service } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      if (query.sql.includes(' AS deploys'))
        return [
          row(1, { deployRequested: false, rolledOut: false, status: 'pending', deploys: [] }),
          row(2, { deployRequested: false, rolledOut: false, pullRequestId: null, triggerType: 'api', deploys: [] }),
          row(3),
        ];
      return [];
    });
    const result = await service.getInventory(scope);
    expect(result.totals).toMatchObject({ current: 3, requested: 1, pullRequestsNeverRequested: 1, rolledOut: 1 });
  });

  it('processes all inventory batches inside one read-only transaction', async () => {
    const rows = Array.from({ length: 1005 }, (_, index) =>
      row(index + 1, {
        status: index % 2 ? 'error' : 'deployed',
        repositoryId: index === 1004 ? null : 4,
        repositoryAmbiguous: index === 1004,
      })
    );
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      const lastId = Number(query.bindings.at(-2));
      return rows.filter((record) => record.id > lastId).slice(0, 1000);
    });
    const result = await service.getInventory(scope);
    expect(result.totals).toMatchObject({ current: 1005, failed: 502, ready: 503, unattributed: 1, ambiguous: 1 });
    expect(result).not.toHaveProperty('truncated');
    expect(queries.filter((query) => query.sql.includes(' AS deploys'))).toHaveLength(2);
    expect(queries[0].sql).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(queries[1].sql).toBe("SET LOCAL statement_timeout = '10s'");
  });

  it('pages current records without a full readiness scan when no phase filter is requested', async () => {
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      if (query.sql.includes('count("e"."id")')) return { total: '1005' };
      return [row(26), row(27)];
    });
    const result = await service.getRecords(
      parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('cohort=current&page=2&limit=25'))
    );
    expect(result.pagination).toEqual({ page: 2, limit: 25, total: 1005, hasMore: true });
    expect(result.records.map((record) => record.id)).toEqual([26, 27]);
    expect(result.range).toBeNull();
    const projections = queries.filter((query) => query.sql.includes(' AS deploys'));
    expect(projections).toHaveLength(1);
    expect(projections[0].sql).toContain('order by "e"."id" asc limit ? offset ?');
    expect(projections[0].bindings.slice(-2)).toEqual([25, 25]);
    expect(projections[0].sql).not.toContain('"e"."id" >');
  });

  it('measures PR deploy requests and rollouts once per PR and preserves independent source-repository aggregates', async () => {
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes(' AS deploys'))
        return [row(1), row(2, { rolledOut: false }), row(3, { repositoryId: null, repositoryAmbiguous: true })];
      if (query.method === 'first') return { earliest: '2026-09-01T00:00:00Z' };
      if (query.sql.includes('group by "date"'))
        return [{ date: '2026-09-30', count: query.sql.includes('"pull_requests" as "p"') ? '1' : '3' }];
      if (query.sql.includes('FILTER (WHERE coverage.requested)'))
        return [
          { repositoryId: 4, fullName: 'org/repo', githubInstallationId: 8, count: '1', requested: '1', deployed: '1' },
        ];
      return [
        {
          repositoryId: 4,
          fullName: 'org/repo',
          githubInstallationId: 8,
          count: '2',
          ambiguous: '0',
          requested: '2',
          deployed: '1',
        },
        {
          repositoryId: null,
          fullName: null,
          githubInstallationId: null,
          count: '1',
          ambiguous: '1',
          requested: '0',
          deployed: '0',
        },
      ];
    });
    const result = await service.getEnvironments({
      ...scope,
      from: range.from,
      to: range.to,
      compare: false,
      rankBy: 'first_seen',
    });
    expect(result.totals).toEqual({
      firstSeenEnvironments: 3,
      deployRequestedEnvironments: 2,
      rolledOutEnvironments: 1,
      observedPullRequests: 1,
      pullRequestsWithDeployRequest: 1,
      pullRequestsDeployed: 1,
      activeRepositories: 1,
      unattributedEnvironments: 1,
      ambiguousRepositoryEnvironments: 1,
    });
    expect(result.repositories[0]).toMatchObject({
      repositoryId: 4,
      firstSeenEnvironments: 2,
      deployRequestedEnvironments: 2,
      rolledOutEnvironments: 1,
      observedPullRequests: 1,
      pullRequestsWithDeployRequest: 1,
      pullRequestsDeployed: 1,
      deployRate: null,
      currentEnvironments: 2,
      liveEnvironments: 1,
    });
    expect(result.inventoryTotals).toMatchObject({
      current: 3,
      requested: 3,
      pullRequestsNeverRequested: 0,
      rolledOut: 2,
      live: 2,
    });
    expect(result.buckets.map((bucket) => bucket.firstSeenEnvironments)).toEqual([3, 0]);
    const coverage = queries.find((query) => query.sql.includes('FILTER (WHERE coverage.requested)'))!;
    expect(coverage.sql).toContain('LEFT JOIN LATERAL (');
    expect(coverage.sql).toContain(
      'bool_or(c."desiredGeneration" > 0 OR c."firstRolledOutAt" IS NOT NULL OR c."firstReadyAt" IS NOT NULL) AS requested'
    );
    expect(coverage.sql).toContain('bool_or(c."firstRolledOutAt" IS NOT NULL) AS deployed');
    expect(coverage.sql).toContain('WHERE c."pullRequestId" = p.id AND c.kind = ?');
    expect(coverage.sql).not.toMatch(/\b(deploys|deployables)\b/);
    const envs = queries.find((query) => query.sql.includes('AS ambiguous'))!;
    expect(envs.sql).toContain('WHEN rc.matches = 1');
    expect(envs.sql).toContain(`(b."pullRequestId" IS NOT NULL OR b."triggerType" = 'api')`);
    expect(envs.sql).toContain('(b."firstRolledOutAt" IS NOT NULL) AS "rolledOut"');
    expect(envs.sql).toContain('AS "namespaceLive"');
    expect(envs.sql).not.toMatch(/\b(deploys|deployables)\b/);
  });

  it('withholds the deploy rate below ten recorded PRs and ranks by rate or deployed count above it', async () => {
    const fixture = (rankBy: 'deploy_rate' | 'prs_deployed') =>
      serviceWithExecutor((query) => {
        if (query.sql.startsWith('SET ')) return { rows: [] };
        if (query.sql.includes(' AS deploys')) return [];
        if (query.method === 'first') return { earliest: null };
        if (query.sql.includes('group by "date"')) return [];
        if (query.sql.includes('FILTER (WHERE coverage.requested)'))
          return [
            {
              repositoryId: 4,
              fullName: 'org/big',
              githubInstallationId: 8,
              count: '10',
              requested: '6',
              deployed: '5',
            },
            {
              repositoryId: 5,
              fullName: 'org/small',
              githubInstallationId: 8,
              count: '9',
              requested: '9',
              deployed: '9',
            },
          ];
        return [
          {
            repositoryId: 4,
            fullName: 'org/big',
            githubInstallationId: 8,
            count: '1',
            ambiguous: '0',
            requested: '1',
            deployed: '1',
          },
          {
            repositoryId: 5,
            fullName: 'org/small',
            githubInstallationId: 8,
            count: '12',
            ambiguous: '0',
            requested: '12',
            deployed: '12',
          },
        ];
      }).service.getEnvironments({ ...scope, compare: false, rankBy });
    const byRate = await fixture('deploy_rate');
    expect(byRate.repositories.map((repo) => [repo.fullName, repo.deployRate])).toEqual([
      ['org/big', 0.5],
      ['org/small', null],
    ]);
    const byDeployed = await fixture('prs_deployed');
    expect(byDeployed.repositories.map((repo) => repo.fullName)).toEqual(['org/small', 'org/big']);
    expect(byDeployed.rankBy).toBe('prs_deployed');
  });

  it('returns null PR measures for static-only scope instead of a false zero', async () => {
    const { service } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes(' AS deploys')) return [];
      if (query.method === 'first') return { earliest: null };
      return [];
    });
    const result = await service.getEnvironments({ ...scope, environmentType: 'static', rankBy: 'first_seen' });
    expect(result.totals.observedPullRequests).toBeNull();
    expect(result.buckets.every((bucket) => bucket.observedPullRequests === null)).toBe(true);
    expect(result.previousTotals).toBeNull();
  });

  it('adds repository activity only when requested and keeps parser defaults unchanged', async () => {
    const plain = parseEnvironmentAnalyticsQuery(new URLSearchParams());
    expect(parseEnvironmentAnalyticsQuery(new URLSearchParams('activityBreakdown=none'))).toEqual(plain);
    expect(plain).not.toHaveProperty('activityBreakdown');
    expect(parseEnvironmentAnalyticsQuery(new URLSearchParams('activityBreakdown=repositories'))).toEqual({
      ...plain,
      activityBreakdown: 'repositories',
    });
    expect(() => parseEnvironmentAnalyticsQuery(new URLSearchParams('activityBreakdown=components'))).toThrow(
      'activityBreakdown must be none or repositories.'
    );
    const plainResult = await activityFixture([]).service.getEnvironments(plain);
    expect(plainResult).not.toHaveProperty('activity');
    const result = await activityFixture([]).service.getEnvironments({ ...plain, activityBreakdown: 'repositories' });
    expect(result.activity).toEqual({ repositoryLimit: 5, repositoryTotal: 0, groupedRepositories: 0, series: [] });
    const { activity, ...existing } = result;
    expect(existing).toEqual(plainResult);
    expect(activity?.series).toEqual([]);
  });

  it('replaces the total bucket scans without changing query counts or any existing result', async () => {
    const current: ActivityFixtureBucket[] = Array.from({ length: 7 }, (_, index) => ({
      date: range.dates[index % 2],
      repositoryId: index + 1,
      fullName: `org/repo-${index + 1}`,
      githubInstallationId: 8,
      count: 7 - index,
    }));
    current.push({
      date: range.dates[0],
      repositoryId: null,
      fullName: null,
      githubInstallationId: null,
      count: 3,
    });
    const plain = activityFixture(current);
    const opted = activityFixture(current);
    const query = { ...scope, rankBy: 'first_seen' as const };
    const expected = await plain.service.getEnvironments(query);
    const result = await opted.service.getEnvironments({ ...query, activityBreakdown: 'repositories' });
    const { activity, ...existing } = result;
    expect(existing).toEqual(expected);
    expect(opted.queries).toHaveLength(plain.queries.length);
    expect(opted.queries.filter((query) => query.sql.includes('AS key'))).toHaveLength(1);
    expect(opted.queries.filter((query) => query.sql.includes('group by "date"'))).toHaveLength(1);
    expect(activity?.series.map((series) => series.key)).toEqual([
      'repository:1',
      'repository:2',
      'repository:3',
      'repository:4',
      'repository:5',
      'other',
      'unattributed',
    ]);
    expect(activity?.repositoryTotal).toBe(7);
    expect(activity?.groupedRepositories).toBe(2);
    expect(activity?.series.find((series) => series.kind === 'other')?.firstSeenEnvironments).toBe(3);
    expect(activity?.series.find((series) => series.kind === 'unattributed')?.firstSeenEnvironments).toBe(3);
    for (const [index, bucket] of result.buckets.entries())
      expect(activity?.series.reduce((sum, series) => sum + series.buckets[index].firstSeenEnvironments, 0)).toBe(
        bucket.firstSeenEnvironments
      );
    expect(activity?.series.reduce((sum, series) => sum + series.firstSeenEnvironments, 0)).toBe(
      result.totals.firstSeenEnvironments
    );
    expect(activity?.series.every((series) => series.previousFirstSeenEnvironments === null)).toBe(true);
  });

  it('ranks current activity before previous ties and keeps installation identities and complete comparison', async () => {
    const calendar = {
      ...range,
      compare: true,
      previous: {
        from: '2026-09-28',
        to: range.from,
        fromUtc: '2026-09-28T00:00:00.000Z',
        toUtc: range.fromUtc,
        dates: ['2026-09-28', '2026-09-29'],
      },
    };
    (resolveAnalyticsRange as jest.Mock).mockResolvedValue(calendar);
    const current: ActivityFixtureBucket[] = [
      { date: range.dates[0], repositoryId: 4, fullName: 'org/repo', githubInstallationId: 8, count: 10 },
      { date: range.dates[1], repositoryId: 12, fullName: 'org/repo', githubInstallationId: 18, count: 10 },
      ...[2, 3, 5, 6, 7].map((repositoryId) => ({
        date: range.dates[0],
        repositoryId,
        fullName: `org/repo-${repositoryId}`,
        githubInstallationId: 8,
        count: 1,
      })),
    ];
    const previous: ActivityFixtureBucket[] = [
      { date: range.dates[0], repositoryId: 4, fullName: 'org/repo', githubInstallationId: 8, count: 1 },
      { date: range.dates[1], repositoryId: 12, fullName: 'org/repo', githubInstallationId: 18, count: 2 },
      { date: range.dates[0], repositoryId: 19, fullName: 'prior/repo', githubInstallationId: 9, count: 100 },
    ];
    const plain = activityFixture(current, previous, calendar);
    const opted = activityFixture(current, previous, calendar);
    const query = { ...scope, compare: true, rankBy: 'first_seen' as const };
    const expected = await plain.service.getEnvironments(query);
    const result = await opted.service.getEnvironments({ ...query, activityBreakdown: 'repositories' });
    const { activity, ...existing } = result;
    expect(existing).toEqual(expected);
    expect(opted.queries).toHaveLength(plain.queries.length);
    expect(opted.queries.filter((query) => query.sql.includes('AS key'))).toHaveLength(2);
    expect(activity?.series.slice(0, 2).map((series) => [series.key, series.githubInstallationId])).toEqual([
      ['repository:12', 18],
      ['repository:4', 8],
    ]);
    expect(activity?.series.find((series) => series.kind === 'other')?.previousFirstSeenEnvironments).toBe(100);
    for (const [index, bucket] of result.buckets.entries())
      expect(
        activity?.series.reduce((sum, series) => sum + series.buckets[index].previousFirstSeenEnvironments!, 0)
      ).toBe(bucket.previousFirstSeenEnvironments);
    expect(activity?.series.reduce((sum, series) => sum + series.previousFirstSeenEnvironments!, 0)).toBe(
      result.previousTotals?.firstSeenEnvironments
    );
    expect(activity?.repositoryTotal).toBe(8);
  });

  it('keeps previous-only repositories and zero-filled current buckets when the selected period is empty', async () => {
    const calendar = {
      ...range,
      compare: true,
      previous: {
        from: '2026-09-28',
        to: range.from,
        fromUtc: '2026-09-28T00:00:00.000Z',
        toUtc: range.fromUtc,
        dates: ['2026-09-28', '2026-09-29'],
      },
    };
    (resolveAnalyticsRange as jest.Mock).mockResolvedValue(calendar);
    const previous: ActivityFixtureBucket[] = [
      { date: range.dates[1], repositoryId: 4, fullName: 'org/repo', githubInstallationId: 8, count: 7 },
    ];
    const result = await activityFixture([], previous, calendar).service.getEnvironments({
      ...scope,
      compare: true,
      rankBy: 'first_seen',
      activityBreakdown: 'repositories',
    });
    expect(result.activity?.series).toMatchObject([
      { key: 'repository:4', firstSeenEnvironments: 0, previousFirstSeenEnvironments: 7 },
    ]);
    expect(result.activity?.series[0].buckets).toEqual(
      range.dates.map((date, index) => ({
        date,
        firstSeenEnvironments: 0,
        previousFirstSeenEnvironments: index === 1 ? 7 : 0,
      }))
    );
    expect(result.activity?.groupedRepositories).toBe(0);
  });

  it('keeps scoped historical attribution and the existing DST and weekly bucket expressions', async () => {
    const calendar = {
      ...range,
      from: '2026-03-08',
      to: '2026-03-10',
      fromUtc: '2026-03-08T08:00:00.000Z',
      toUtc: '2026-03-10T07:00:00.000Z',
      dates: ['2026-03-08', '2026-03-09'],
      interval: 'week' as const,
      timezone: 'America/Los_Angeles',
      compare: true,
      previous: {
        from: '2026-03-06',
        to: '2026-03-08',
        fromUtc: '2026-03-06T08:00:00.000Z',
        toUtc: '2026-03-08T08:00:00.000Z',
        dates: ['2026-03-06', '2026-03-07'],
      },
    };
    (resolveAnalyticsRange as jest.Mock).mockResolvedValue(calendar);
    const rows = [
      { date: '2026-03-02', repositoryId: 4, fullName: 'org/repo', githubInstallationId: 8, count: 2 },
      { date: '2026-03-09', repositoryId: 4, fullName: 'org/repo', githubInstallationId: 8, count: 3 },
    ];
    const { service, queries } = activityFixture(rows, rows, calendar);
    const result = await service.getEnvironments({
      ...scope,
      repositoryId: 4,
      organization: 'org',
      environmentType: 'static',
      environmentAuthor: 'Alice',
      rankBy: 'first_seen',
      activityBreakdown: 'repositories',
    });
    expect(result.activity?.series[0].buckets).toEqual([
      { date: '2026-03-02', firstSeenEnvironments: 2, previousFirstSeenEnvironments: 2 },
      { date: '2026-03-09', firstSeenEnvironments: 3, previousFirstSeenEnvironments: 3 },
    ]);
    const grouped = queries.filter((query) => query.sql.includes('AS key'));
    expect(grouped).toHaveLength(2);
    for (const query of grouped) {
      expect(query.sql).toContain('WHEN rc.matches = 1');
      expect(query.sql).toContain('group by "key", "date"');
      expect(query.sql).not.toMatch(/\b(deploys|deployables)\b/);
      expect(query.bindings).toEqual(expect.arrayContaining([[4], 'org', true, 'Alice']));
      expect(query.sql).not.toContain('"e"."deletedAt" is null');
    }
    expect(grouped[0].bindings).toEqual(
      expect.arrayContaining(['week', 'America/Los_Angeles', 0, calendar.fromUtc, calendar.toUtc])
    );
    expect(grouped[1].bindings).toEqual(
      expect.arrayContaining(['week', 'America/Los_Angeles', 2, calendar.previous.fromUtc, calendar.previous.toUtc])
    );
  });

  it('adds independent managed Service coverage and per-environment instances without changing readiness', async () => {
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      if (query.sql.includes(' AS deploys')) return [row(1), row(2, { repositoryId: null })];
      if (query.sql.includes('AS "environmentsWithServices"'))
        return [
          {
            isTotal: 1,
            distinctServices: '1',
            instances: '3',
            readyInstances: '2',
            environmentsWithServices: '2',
            unresolvedIdentityInstances: '1',
            externalInstances: '1',
            buildOnlyInstances: '2',
            unknownTypeInstances: '0',
          },
          { isTotal: 0, type: 'docker', distinctServices: '1', instances: '3', readyInstances: '2' },
        ];
      if (query.sql.includes('group by "s"."environmentId"'))
        return [
          { environmentId: 1, type: 'docker', instances: '2' },
          { environmentId: 2, type: 'docker', instances: '1' },
        ];
      return [{ type: 'docker', distinctServices: '1', instances: '3', readyInstances: '2' }];
    });
    const result = await service.getInventory(scope);
    expect(result.totals).toMatchObject({ current: 2, ready: 2 });
    expect(result.services).toEqual({
      distinctServices: 1,
      instances: 3,
      readyInstances: 2,
      environmentsWithServices: 2,
      unresolvedIdentityInstances: 1,
      byType: [
        { type: 'docker', distinctServices: 1, instances: 3, readyInstances: 2 },
        { type: 'github', distinctServices: 0, instances: 0, readyInstances: 0 },
        { type: 'helm', distinctServices: 0, instances: 0, readyInstances: 0 },
        { type: 'aurora-restore', distinctServices: 0, instances: 0, readyInstances: 0 },
      ],
      excluded: { externalInstances: 1, buildOnlyInstances: 2, unknownTypeInstances: 0 },
    });
    expect(queries.some((query) => query.sql.includes('group by "s"."environmentId"'))).toBe(false);
    const aggregates = queries.filter((query) => query.sql.includes('AS "environmentsWithServices"'));
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].sql).toContain('GROUPING(s.type) AS "isTotal"');
    expect(aggregates[0].sql).toContain('group by GROUPING SETS ((s.type), ())');
  });

  it('keeps a real null component type separate from the aggregate total', async () => {
    const { service } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      if (query.sql.includes(' AS deploys')) return [];
      return [
        { isTotal: 0, type: null, unknownTypeInstances: '2' },
        { isTotal: 0, type: 'helm', instances: '1', readyInstances: '0', distinctServices: '1' },
        {
          isTotal: 1,
          type: null,
          instances: '1',
          readyInstances: '0',
          distinctServices: '1',
          environmentsWithServices: '1',
          unresolvedIdentityInstances: '0',
          unknownTypeInstances: '2',
        },
      ];
    });
    const { services } = await service.getInventory(scope);
    expect(services).toMatchObject({ instances: 1, distinctServices: 1, excluded: { unknownTypeInstances: 2 } });
    expect(services.byType.find((row) => row.type === 'helm')).toEqual({
      type: 'helm',
      instances: 1,
      readyInstances: 0,
      distinctServices: 1,
    });
  });

  it('SQL-pages stable configured Service groups and converts independent nullable identities', async () => {
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      if (query.method === 'first') return { total: '30' };
      return [
        {
          repositoryId: null,
          fullName: null,
          githubInstallationId: null,
          key: '["environment",12,"github:unrecorded","db","helm"]',
          name: 'db',
          type: 'helm',
          sourceGithubRepositoryId: null,
          serviceId: null,
          identityResolved: false,
          instances: '1',
          readyInstances: '0',
          environments: '1',
        },
      ];
    });
    const result = await service.getServices(parseManagedServiceRecordsQuery(new URLSearchParams('type=helm&page=2')));
    expect(result.pagination).toEqual({
      page: 2,
      limit: 25,
      total: 30,
      hasMore: true,
      maxPage: 1_000_000,
      truncated: false,
    });
    expect(result.records[0]).toMatchObject({
      repositoryId: null,
      identityResolved: false,
      instances: 1,
      readyInstances: 0,
      sourceGithubRepositoryId: null,
    });
    const pageQuery = queries.find((query) => query.sql.includes('order by "instances"'))!;
    expect(pageQuery.sql).toContain('order by "instances" desc, "key" asc limit ? offset ?');
    expect(pageQuery.bindings.slice(-2)).toEqual([25, 25]);
    expect(pageQuery.bindings).toContain('helm');
    expect(pageQuery.sql).toContain('COALESCE(s."repositoryId", s."environmentId")');
    expect(pageQuery.sql).not.toContain('"e"."createdAt" >=');
  });

  it('carries selected deployment state into aggregation without rejoining the selected component relation', async () => {
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      if (query.method === 'first') return { total: '0' };
      return [];
    });
    await service.getServices(parseManagedServiceRecordsQuery(new URLSearchParams()));
    const selectedQueries = queries.filter((query) => query.sql.includes('service_instances'));
    expect(selectedQueries).toHaveLength(2);
    for (const { sql } of selectedQueries) {
      expect(sql.match(/JOIN service_deployables a/g)).toHaveLength(1);
      expect(sql).toContain('SELECT DISTINCT ON (a.id) a.*, d.status AS "deployStatus"');
      expect(sql).toContain('WHERE d.active = true AND d."deletedAt" IS NULL');
      expect(sql).not.toContain('a.active = true');
      expect(sql).not.toContain('"s"."active"');
      expect(sql).toContain('ORDER BY a.id, d.id DESC');
      expect(sql).toContain('from "service_instances" as "s"');
      expect(sql).not.toContain('d.status <>');
      expect(sql).not.toContain('join "service_deploys"');
      expect(sql.indexOf('s."deployStatus" IS NULL')).toBeGreaterThan(sql.indexOf('ORDER BY a.id, d.id DESC'));
    }
  });

  it('counts an enabled optional component using deployment state rather than its deployable default', async () => {
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      if (query.method === 'first') return { total: '1' };
      return [
        {
          key: 'optional-redis',
          name: 'redis',
          type: 'helm',
          repositoryId: 4,
          fullName: 'org/repo',
          githubInstallationId: 8,
          serviceId: null,
          sourceGithubRepositoryId: null,
          identityResolved: true,
          instances: '1',
          readyInstances: '1',
          environments: '1',
        },
      ];
    });
    const result = await service.getServices(parseManagedServiceRecordsQuery(new URLSearchParams('type=helm')));
    expect(result.records[0]).toMatchObject({ name: 'redis', instances: 1, readyInstances: 1, environments: 1 });
    const selected = queries.find((query) => query.sql.includes('service_instances'))!;
    expect(selected.sql).not.toContain('a.active = true');
    expect(selected.sql).not.toContain('"s"."active"');
    expect(selected.sql).toContain('a."buildUUID" = e.uuid');
    expect(selected.sql).toContain('SELECT max(a.id)');
    expect(selected.sql).toContain('d.active = true');
    expect(selected.bindings).toContain('torn_down');
  });

  it.each([
    [1_000_000, 1_000_001, false, true],
    [1_000_000, 1_000_000, false, false],
    [999_999, 1_000_001, true, true],
  ])('reports Services paging bounds at page %i with total %i', async (page, total, hasMore, truncated) => {
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      if (query.method === 'first') return { total: String(total) };
      return [
        {
          repositoryId: 4,
          fullName: 'org/repo',
          githubInstallationId: 8,
          key: '["repository",4,"github:5","api","docker"]',
          name: 'api',
          type: 'docker',
          sourceGithubRepositoryId: 5,
          serviceId: null,
          identityResolved: true,
          instances: '1',
          readyInstances: '1',
          environments: '1',
        },
      ];
    });
    const result = await service.getServices(
      parseManagedServiceRecordsQuery(new URLSearchParams(`page=${page}&limit=1`))
    );
    expect(result.pagination).toEqual({ page, limit: 1, total, hasMore, maxPage: 1_000_000, truncated });
    const pageQuery = queries.find((query) => query.sql.includes('order by "instances"'))!;
    expect(pageQuery.bindings.slice(-2)).toEqual([1, page - 1]);
  });

  it('loads service counts only for the current environment page and leaves historical counts unknown', async () => {
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
      if (query.method === 'first') return { total: '1' };
      if (query.sql.includes('service_deployables')) return [{ environmentId: 26, type: 'helm', instances: '2' }];
      return [row(26)];
    });
    const current = await service.getRecords(
      parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('cohort=current'))
    );
    expect(current.records[0]).toMatchObject({ serviceInstances: 2, serviceTypes: [{ type: 'helm', instances: 2 }] });
    const serviceQuery = queries.find((query) => query.sql.includes('service_deployables'))!;
    expect(serviceQuery.bindings).toContain(26);
    expect(serviceQuery.sql).toContain('a."buildUUID" = e.uuid');
    expect(serviceQuery.sql).toContain('a."deletedAt" IS NULL');
    expect(serviceQuery.sql).toContain('d."deletedAt" IS NULL');
    expect(serviceQuery.sql).toContain('SELECT max(a.id) AS id');
    expect(serviceQuery.sql).toContain('GROUP BY a."buildId", a.name');
    expect(serviceQuery.sql).toContain('selected.id = a.id');
    expect(serviceQuery.sql).toContain('SELECT DISTINCT ON (a.id) a.*, d.status AS "deployStatus"');
    expect(serviceQuery.sql).toContain('ORDER BY a.id, d.id DESC');
    expect(serviceQuery.sql).toContain('from "service_instances" as "s"');
    expect(serviceQuery.sql).not.toContain('join "service_deploys"');
    expect(serviceQuery.sql).not.toContain('service_latest_deploy_ids');
    expect(serviceQuery.sql).not.toContain('row_number()');
    expect(serviceQuery.bindings).toEqual(
      expect.arrayContaining(['torn_down', 'docker', 'github', 'helm', 'aurora-restore'])
    );
    expect(serviceQuery.bindings).not.toEqual(expect.arrayContaining(['configuration', 'codefresh', 'externalHTTP']));
    queries.length = 0;
    const historical = await service.getRecords(
      parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('from=2026-09-30&to=2026-10-02'))
    );
    expect(historical.records[0]).toMatchObject({ serviceInstances: null, serviceTypes: null });
    expect(queries.some((query) => query.sql.includes('service_deployables'))).toBe(false);
  });

  it.each([
    'evidence=live',
    'evidence=ready',
    'evidence=never_requested',
    'evidence=deployed',
    'cohort=current&evidence=deployed',
    'cohort=current&date=2026-09-30',
    'cohort=current&period=previous',
    'cohort=current&period=current',
    'period=previous&compare=false',
    'date=2026-9-30',
    'period=last',
  ])('rejects invalid drilldown slice %s', (query) => {
    expect(() => parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams(query))).toThrow();
  });

  it('parses the evidence slice per cohort', () => {
    expect(parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams()).slice).toEqual({
      evidence: null,
      date: null,
      period: 'current',
    });
    expect(
      parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('evidence=rolled_out&date=2026-09-30&period=previous'))
        .slice
    ).toEqual({ evidence: 'rolled_out', date: '2026-09-30', period: 'previous' });
    expect(
      parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('cohort=current&evidence=never_requested&phase=ready'))
    ).toMatchObject({
      cohort: 'current',
      phase: 'ready',
      slice: { evidence: 'never_requested', date: null, period: 'current' },
    });
    expect(() => parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('evidence=live'))).toThrow(
      'evidence must be requested or rolled_out for the first_seen cohort.'
    );
    expect(() =>
      parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('cohort=current&evidence=deployed'))
    ).toThrow('evidence must be requested, rolled_out, live, ready or never_requested.');
    expect(() => parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('cohort=current&date=2026-09-30'))).toThrow(
      'date and period apply to the first_seen cohort only.'
    );
    expect(() => parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('period=previous&compare=false'))).toThrow(
      'period must be current when compare is false.'
    );
  });

  it.each([
    'environmentType=static',
    'evidence=live',
    'evidence=ready',
    'evidence=never_requested',
    'period=previous&compare=false',
    'date=2026-09-30T00:00:00Z',
    'page=1000001',
    'limit=101',
    'repositoryId=4&unattributed=true',
  ])('rejects invalid pull request query %s', (query) => {
    expect(() => parseEnvironmentAnalyticsPullRequestsQuery(new URLSearchParams(query))).toThrow();
  });

  it('parses the pull request list with the environment scope, calendar and slice', () => {
    expect(
      parseEnvironmentAnalyticsPullRequestsQuery(
        new URLSearchParams(
          'environmentType=ephemeral&evidence=requested&date=2026-09-30&page=3&limit=50&from=2026-09-30&to=2026-10-02'
        )
      )
    ).toEqual({
      ...scope,
      environmentType: 'ephemeral',
      from: '2026-09-30',
      to: '2026-10-02',
      timezone: 'UTC',
      interval: 'day',
      compare: true,
      slice: { evidence: 'requested', date: '2026-09-30', period: 'current' },
      page: 3,
      limit: 50,
    });
    expect(parseEnvironmentAnalyticsPullRequestsQuery(new URLSearchParams()).slice).toEqual({
      evidence: null,
      date: null,
      period: 'current',
    });
    expect(() => parseEnvironmentAnalyticsPullRequestsQuery(new URLSearchParams('environmentType=static'))).toThrow(
      'Pull requests are not available for static environments. Use environmentType all or ephemeral.'
    );
  });

  it('lists window records behind the requested and rolled-out counts for one chart bucket', async () => {
    (resolveAnalyticsRange as jest.Mock).mockResolvedValue(comparison);
    const fixture = () =>
      serviceWithExecutor((query) => {
        if (query.sql.startsWith('SET ')) return { rows: [] };
        if (query.method === 'first') return { total: '2' };
        return [row(2), row(1)];
      });
    const { service, queries } = fixture();
    const result = await service.getRecords(
      parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('evidence=requested&date=2026-09-30&period=previous'))
    );
    expect(result.slice).toEqual({ evidence: 'requested', date: '2026-09-30', period: 'previous' });
    expect(result.range).toBe(comparison);
    expect(result.pagination).toEqual({ page: 1, limit: 25, total: 2, hasMore: false });
    expect(result.records.map((record) => record.id)).toEqual([2, 1]);
    const [total, page] = queries.filter((query) => !query.sql.startsWith('SET '));
    expect(total.method).toBe('first');
    expect(page.sql).toContain(' AS deploys');
    expect(page.sql).toContain('order by "e"."createdAt" desc, "e"."id" desc limit ?');
    expect(page.bindings.slice(-1)).toEqual([25]);
    for (const query of [total, page]) {
      expect(query.sql).toContain('and e."deployRequested"');
      expect(query.sql).toContain(
        `and to_char(date_trunc(?, ("e"."createdAt" AT TIME ZONE ?) + (? * interval '1 day')), 'YYYY-MM-DD') = ?`
      );
      expect(query.bindings).toEqual(
        expect.arrayContaining([
          comparison.previous!.fromUtc,
          comparison.previous!.toUtc,
          'day',
          'UTC',
          2,
          '2026-09-30',
        ])
      );
      expect(query.bindings).not.toContain(comparison.toUtc);
      expect(query.sql).not.toContain('"e"."deletedAt" is null');
    }
    const rolledOut = fixture();
    await rolledOut.service.getRecords(
      parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('evidence=rolled_out'))
    );
    for (const query of rolledOut.queries.filter((query) => !query.sql.startsWith('SET '))) {
      expect(query.sql).toContain('and e."rolledOut"');
      expect(query.sql).not.toContain('e."deployRequested"');
      expect(query.sql).not.toContain('to_char(');
      expect(query.bindings).toEqual(expect.arrayContaining([comparison.fromUtc, comparison.toUtc]));
    }
  });

  it('selects current records by evidence exactly as the inventory counts them', async () => {
    const built = { active: true, status: 'built', publicUrl: '', deployable: { type: 'docker' } };
    const rows = [
      row(1),
      row(2, { status: 'pending', prDeployOnUpdate: false, deploys: [] }),
      row(3, { status: 'pending', deployRequested: false, rolledOut: false, firstReadyAt: null, deploys: [] }),
      row(4, {
        status: 'pending',
        pullRequestId: null,
        triggerType: 'api',
        deployRequested: false,
        rolledOut: false,
        deploys: [],
      }),
      row(5, { deploys: [built] }),
    ];
    const fixture = () =>
      serviceWithExecutor((query) => {
        if (query.sql.startsWith('SET ')) return { rows: [] };
        if (query.sql.includes('CURRENT_TIMESTAMP')) return [{ asOf: range.asOf }];
        if (query.sql.includes(' AS deploys')) return rows;
        return [];
      });
    const inventory = (await fixture().service.getInventory(scope)).totals;
    expect(inventory).toMatchObject({
      current: 5,
      requested: 3,
      pullRequestsNeverRequested: 1,
      rolledOut: 3,
      live: 2,
      ready: 1,
      deployedNotReady: 1,
      inProgress: 2,
      paused: 1,
    });
    const list = async (params: string) => {
      const { service, queries } = fixture();
      const result = await service.getRecords(
        parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams(`cohort=current&${params}`))
      );
      expect(queries.find((query) => query.sql.includes(' AS deploys'))!.sql).toContain('"e"."id" > ?');
      expect(result.range).toBeNull();
      return { ids: result.records.map((record) => record.id), total: result.pagination.total, slice: result.slice };
    };
    expect(await list('evidence=requested')).toEqual({
      ids: [1, 2, 5],
      total: inventory.requested,
      slice: { evidence: 'requested', date: null, period: 'current' },
    });
    expect(await list('evidence=rolled_out')).toMatchObject({ ids: [1, 2, 5], total: inventory.rolledOut });
    expect(await list('evidence=live')).toMatchObject({ ids: [1, 5], total: inventory.live });
    expect(await list('evidence=ready')).toMatchObject({ ids: [1], total: inventory.ready });
    expect(await list('evidence=never_requested')).toMatchObject({
      ids: [3],
      total: inventory.pullRequestsNeverRequested,
    });
    expect(await list('evidence=live&phase=deployed_not_ready')).toMatchObject({ ids: [5], total: 1 });
    expect(await list('evidence=requested&phase=paused')).toMatchObject({ ids: [2], total: 1 });
    expect(await list('evidence=requested&phase=paused&page=2&limit=1')).toMatchObject({ ids: [], total: 1 });
    expect(await list('evidence=requested&page=2&limit=2')).toMatchObject({ ids: [5], total: 3 });
  });

  it('lists the pull requests behind the recorded and deployed counts with their newest environment', async () => {
    const pullRequest = (id: number, overrides: Record<string, unknown> = {}) => ({
      id,
      pullRequestNumber: id * 10,
      title: `Change ${id}`,
      githubLogin: 'Alice',
      createdAt: '2026-09-30T10:00:00Z',
      repositoryId: 4,
      fullName: 'org/repo',
      githubInstallationId: 8,
      deployRequested: true,
      rolledOut: true,
      environmentId: id * 100,
      environmentUuid: `env-${id}`,
      environmentNamespace: `env-${id}`,
      environmentStatus: 'deployed',
      environmentDeletedAt: null,
      ...overrides,
    });
    const fixture = () =>
      serviceWithExecutor((query) => {
        if (query.sql.startsWith('SET ')) return { rows: [] };
        if (query.method === 'first') return { total: '7' };
        return [
          pullRequest(3),
          pullRequest(2, {
            deployRequested: null,
            rolledOut: null,
            environmentId: null,
            environmentUuid: null,
            environmentNamespace: null,
            environmentStatus: null,
          }),
          pullRequest(1, {
            rolledOut: false,
            environmentStatus: 'torn_down',
            environmentDeletedAt: '2026-10-01T12:00:00Z',
          }),
        ];
      });
    const { service, queries } = fixture();
    const result = await service.getPullRequests(
      parseEnvironmentAnalyticsPullRequestsQuery(
        new URLSearchParams(
          'environmentType=ephemeral&evidence=rolled_out&repositoryId=4&date=2026-09-30&page=2&limit=3'
        )
      )
    );
    expect(result).toMatchObject({
      asOf: range.asOf,
      range,
      scope: { ...scope, repositoryId: 4, environmentType: 'ephemeral' },
      slice: { evidence: 'rolled_out', date: '2026-09-30', period: 'current' },
      pagination: { page: 2, limit: 3, total: 7, hasMore: true },
    });
    const identity = { repositoryId: 4, fullName: 'org/repo', githubInstallationId: 8 };
    expect(result.records).toEqual([
      {
        ...identity,
        id: 3,
        number: 30,
        title: 'Change 3',
        author: 'Alice',
        createdAt: '2026-09-30T10:00:00.000Z',
        deployRequested: true,
        rolledOut: true,
        environment: { id: 300, uuid: 'env-3', namespace: 'env-3', resourceAvailable: true },
      },
      {
        ...identity,
        id: 2,
        number: 20,
        title: 'Change 2',
        author: 'Alice',
        createdAt: '2026-09-30T10:00:00.000Z',
        deployRequested: false,
        rolledOut: false,
        environment: null,
      },
      {
        ...identity,
        id: 1,
        number: 10,
        title: 'Change 1',
        author: 'Alice',
        createdAt: '2026-09-30T10:00:00.000Z',
        deployRequested: true,
        rolledOut: false,
        environment: { id: 100, uuid: 'env-1', namespace: 'env-1', resourceAvailable: false },
      },
    ]);
    const [total, page] = queries.filter((query) => !query.sql.startsWith('SET '));
    expect(total.method).toBe('first');
    for (const query of [total, page]) {
      expect(query.sql).toContain('from "pull_requests" as "p"');
      expect(query.sql).toContain('"p"."githubPullRequestId" > ?');
      expect(query.sql).toContain('LEFT JOIN LATERAL (');
      expect(query.sql).toContain(
        'bool_or(c."desiredGeneration" > 0 OR c."firstRolledOutAt" IS NOT NULL OR c."firstReadyAt" IS NOT NULL) AS requested'
      );
      expect(query.sql).toContain('bool_or(c."firstRolledOutAt" IS NOT NULL) AS deployed');
      expect(query.sql).toContain(
        'FROM builds c WHERE c."pullRequestId" = p.id AND c.kind = ? AND COALESCE(c."isStatic", false) = false'
      );
      expect(query.sql).toContain('and coverage.deployed');
      expect(query.sql).toContain(
        `and to_char(date_trunc(?, ("p"."createdAt" AT TIME ZONE ?) + (? * interval '1 day')), 'YYYY-MM-DD') = ?`
      );
      expect(query.sql).not.toMatch(/\b(deploys|deployables)\b/);
      expect(query.bindings).toEqual(
        expect.arrayContaining([4, 'environment', range.fromUtc, range.toUtc, 'day', 'UTC', 0, '2026-09-30'])
      );
    }
    expect(total.sql).not.toContain('ORDER BY c.id DESC LIMIT 1');
    expect(page.sql).toContain('SELECT c.id, c.uuid, c.namespace, c.status, c."deletedAt"');
    expect(page.sql).toContain('ORDER BY c.id DESC LIMIT 1');
    expect(page.sql).toContain(') environment ON true');
    expect(page.sql).toContain('order by "p"."createdAt" desc, "p"."id" desc limit ? offset ?');
    expect(page.bindings.slice(-2)).toEqual([3, 3]);
    const requested = fixture();
    await requested.service.getPullRequests(
      parseEnvironmentAnalyticsPullRequestsQuery(new URLSearchParams('evidence=requested&unattributed=true'))
    );
    for (const query of requested.queries.filter((query) => !query.sql.startsWith('SET '))) {
      expect(query.sql).toContain('"r"."id" is null');
      expect(query.sql).toContain('and coverage.requested');
      expect(query.sql).not.toContain('and coverage.deployed');
      expect(query.sql).not.toContain('"isStatic"');
      expect(query.sql).not.toContain('to_char(');
    }
  });

  it('lists pull requests of the comparison window and rejects a slice outside the window', async () => {
    (resolveAnalyticsRange as jest.Mock).mockResolvedValue(comparison);
    const { service, queries } = serviceWithExecutor((query) => {
      if (query.sql.startsWith('SET ')) return { rows: [] };
      if (query.method === 'first') return { total: '0' };
      return [];
    });
    const result = await service.getPullRequests(
      parseEnvironmentAnalyticsPullRequestsQuery(new URLSearchParams('period=previous&date=2026-10-01'))
    );
    expect(result.pagination).toEqual({ page: 1, limit: 25, total: 0, hasMore: false });
    expect(result.slice).toEqual({ evidence: null, date: '2026-10-01', period: 'previous' });
    for (const query of queries.filter((query) => !query.sql.startsWith('SET '))) {
      expect(query.bindings).toEqual(
        expect.arrayContaining([
          comparison.previous!.fromUtc,
          comparison.previous!.toUtc,
          'day',
          'UTC',
          2,
          '2026-10-01',
        ])
      );
      expect(query.bindings).not.toContain(comparison.toUtc);
    }
    await expect(
      service.getPullRequests(parseEnvironmentAnalyticsPullRequestsQuery(new URLSearchParams('date=2026-09-29')))
    ).rejects.toThrow('date must be the start of a bucket inside the window.');
    (resolveAnalyticsRange as jest.Mock).mockResolvedValue(range);
    await expect(
      service.getRecords(parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams('period=previous')))
    ).rejects.toThrow('period must be current when compare is false.');
  });
});
