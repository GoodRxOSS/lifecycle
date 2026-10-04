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

import AgentAnalyticsService, {
  parseAgentAnalyticsQuery,
  parseAgentAnalyticsRunsQuery,
  parseAgentAnalyticsPagination,
  serializeAgentAnalyticsMetrics,
} from './AgentAnalyticsService';
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

function serviceWithRows(results: unknown[][]) {
  const raw = jest.fn(async (sql: string) => (sql.startsWith('SET ') ? undefined : { rows: results.shift() }));
  const transaction = jest.fn(async (callback) => callback({ raw }));
  const service = new AgentAnalyticsService({ knex: { transaction } } as any);
  return { service, raw };
}

describe('AgentAnalyticsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRange.mockResolvedValue(range);
  });

  it('distinguishes unknown usage from an empty cohort and recorded zero', () => {
    expect(serializeAgentAnalyticsMetrics()).toMatchObject({
      runs: 0,
      tokens: { total: 0, input: 0, output: 0, missingRuns: 0 },
      reportedCost: { usd: 0 },
    });
    expect(
      serializeAgentAnalyticsMetrics({ runs: '2', running: '1', failed: '1', pending_usage_runs: '1' })
    ).toMatchObject({
      runs: 2,
      tokens: { total: null, input: null, output: null, reportedRuns: 0, missingRuns: 2, pendingRuns: 1 },
      reportedCost: { usd: null, coveredRuns: 0 },
      estimatedCost: { usd: null, coveredRuns: 0 },
    });
    expect(
      serializeAgentAnalyticsMetrics({
        runs: 1,
        total_tokens: '0',
        total_reported_runs: 1,
        reported_cost: 0,
        reported_cost_runs: 1,
      })
    ).toMatchObject({
      tokens: { total: 0, missingRuns: 0 },
      reportedCost: { usd: 0, coveredRuns: 1 },
      estimatedCost: { usd: null, coveredRuns: 0 },
    });
  });

  it('preserves independent token directions and separate overlapping cost coverage', () => {
    expect(
      serializeAgentAnalyticsMetrics({
        runs: 3,
        sessions: 2,
        owners: 1,
        total_tokens: 100,
        total_reported_runs: 1,
        input_tokens: 75,
        input_reported_runs: 2,
        output_tokens: 25,
        output_reported_runs: 1,
        reported_cost: '0.015',
        reported_cost_runs: 1,
        estimated_cost: '0.02',
        estimated_cost_runs: 2,
        unknown: 1,
      })
    ).toMatchObject({
      runs: 3,
      sessions: 2,
      owners: 1,
      outcomes: { unknown: 1 },
      tokens: {
        total: 100,
        input: 75,
        output: 25,
        reportedRuns: 1,
        inputReportedRuns: 2,
        outputReportedRuns: 1,
        missingRuns: 2,
      },
      reportedCost: { usd: 0.015, coveredRuns: 1 },
      estimatedCost: { usd: 0.02, coveredRuns: 2 },
    });
  });

  it('fills absent calendar buckets and aligns previous dates using the shared DST range', async () => {
    const { service, raw } = serviceWithRows([
      [
        {
          period: 'current',
          group_type: 'total',
          runs: 2,
          sessions: 1,
          owners: 1,
          total_tokens: 12,
          total_reported_runs: 1,
        },
        {
          period: 'current',
          group_type: 'date',
          bucket: '2026-03-09',
          runs: 2,
          total_tokens: 12,
          total_reported_runs: 1,
        },
        { period: 'previous', group_type: 'date', bucket: '2026-03-08', runs: 1 },
        { period: 'current', group_type: 'repository', repository: 'org/repo', runs: 2, ranking_total: 23 },
      ],
      [
        { period: 'current', count: 1, unattributed: 0 },
        { period: 'previous', count: 2, unattributed: 1 },
      ],
      [{ earliest: new Date('2025-04-01T00:00:00Z') }],
    ]);
    const result = await service.getSummary({ repository: 'org/repo', compare: true });
    expect(result.series).toEqual([
      expect.objectContaining({
        date: '2026-03-08',
        previousDate: '2026-03-06',
        current: expect.objectContaining({ runs: 0, tokens: expect.objectContaining({ total: 0 }) }),
        previous: expect.objectContaining({ runs: 1, tokens: expect.objectContaining({ total: null }) }),
      }),
      expect.objectContaining({
        date: '2026-03-09',
        previousDate: '2026-03-07',
        current: expect.objectContaining({ runs: 2 }),
        previous: expect.objectContaining({ runs: 0 }),
      }),
    ]);
    expect(result.sessionsCreated).toEqual({
      current: 1,
      previous: 2,
      unattributedCurrent: 0,
      unattributedPrevious: 1,
      attribution: 'first_recorded_run',
    });
    expect(result.rankingTotal.repositories).toBe(23);
    expect(result.rankingTruncated.repositories).toBe(true);
    expect(result.earliestRunAt).toBe('2025-04-01T00:00:00.000Z');
    const [sql, bindings] = raw.mock.calls.filter(([sql]) => !sql.startsWith('SET '))[0] as unknown as [
      string,
      unknown[]
    ];
    expect(sql).toContain('COUNT(DISTINCT session_id)');
    expect(sql).toContain("jsonb_typeof(r.\"usageSummary\"->'totalTokens') = 'number'");
    expect(sql).toContain("'{source,repoFullName}'");
    expect(sql).toContain("'{source,workspaceLayout,primaryRepo}'");
    expect(sql).not.toContain('jsonb_array_elements');
    expect(sql).not.toContain('workspaceRepos');
    expect(sql).toContain('r."createdAt" >= ?::timestamptz AND r."createdAt" < ?::timestamptz');
    expect(sql).not.toContain('r."queuedAt" >=');
    expect(bindings).toEqual([
      range.fromUtc,
      'day',
      range.timezone,
      range.fromUtc,
      2,
      range.previous!.fromUtc,
      range.toUtc,
      'org/repo',
      20,
    ]);
    expect(raw.mock.calls.filter(([sql]) => !sql.startsWith('SET '))[1][0]).toContain(
      'ORDER BY r."createdAt", r.id LIMIT 1'
    );
    expect(raw.mock.calls.filter(([sql]) => !sql.startsWith('SET '))[2][0]).toContain('min("createdAt")');
  });

  it('omits previous results when comparison is disabled and preserves empty runs beyond the last page', async () => {
    mockResolveRange.mockResolvedValue({ ...range, compare: false, previous: null });
    const { service, raw } = serviceWithRows([[{ total: 1, runs: [] }]]);
    const result = await service.listRuns({ repository: 'unattributed', runStatus: 'failed' }, 2, 25);
    expect(result.runs).toEqual([]);
    expect(result.pagination).toEqual({ page: 2, limit: 25, total: 1, hasMore: false });
    const [sql, bindings] = raw.mock.calls.filter(([sql]) => !sql.startsWith('SET '))[0] as unknown as [
      string,
      unknown[]
    ];
    expect(sql).toContain('repository IS NULL AND status = ?');
    expect(sql).toContain('ORDER BY submitted_at DESC, id DESC LIMIT ? OFFSET ?');
    expect(bindings).toEqual([range.fromUtc, range.toUtc, 'failed', 25, 25]);
  });

  it('returns only run metadata while preserving unavailable usage and cost', async () => {
    const { service } = serviceWithRows([
      [
        {
          total: 1,
          runs: [
            {
              run_uuid: 'run',
              session_uuid: 'session',
              thread_uuid: 'thread',
              submitted_at: range.fromUtc,
              queued_at: range.fromUtc,
              status: 'failed',
              provider: 'openai',
              model: 'model',
              owner_id: 'owner',
              agent_label: 'Assistant',
              error_code: 'provider_quota_exhausted',
              total_tokens: null,
              input_tokens: 10,
              output_tokens: null,
              reported_cost: null,
              estimated_cost: '0.01',
              secret: 'excluded',
              prompt: 'excluded',
            },
          ],
        },
      ],
    ]);
    const result = await service.listRuns({});
    expect(result.runs[0]).toMatchObject({
      tokens: { total: null, input: 10, output: null },
      reportedCostUsd: null,
      estimatedCostUsd: 0.01,
      errorCode: 'provider_quota_exhausted',
    });
    expect(result.runs[0]).not.toHaveProperty('secret');
    expect(result.runs[0]).not.toHaveProperty('prompt');
  });

  it('preserves submission time while returning the latest approval requeue time', async () => {
    const requeuedAt = '2026-03-11T08:00:00.000Z';
    const { service, raw } = serviceWithRows([
      [
        {
          total: 1,
          runs: [
            {
              run_uuid: 'resumed-run',
              session_uuid: 'session',
              thread_uuid: 'thread',
              submitted_at: range.fromUtc,
              queued_at: requeuedAt,
              status: 'completed',
              provider: 'openai',
              model: 'model',
              owner_id: 'owner',
              total_tokens: 300,
            },
          ],
        },
      ],
    ]);
    const result = await service.listRuns({}, 1, 25);
    expect(result.runs[0]).toMatchObject({ submittedAt: range.fromUtc, queuedAt: requeuedAt, tokens: { total: 300 } });
    const sql = raw.mock.calls.filter(([sql]) => !sql.startsWith('SET '))[0][0];
    expect(sql).toContain('r."createdAt" AS submitted_at');
    expect(sql).toContain('r."queuedAt" AS queued_at');
    expect(sql).toContain('r."createdAt" >= ?::timestamptz AND r."createdAt" < ?::timestamptz');
    expect(sql).toContain('ORDER BY submitted_at DESC, id DESC');
    expect(sql).not.toContain('r."queuedAt" >=');
    expect(sql).not.toContain('ORDER BY queued_at');
  });

  it('aggregates all matching runs into a session before paging and keeps independent missing cost', async () => {
    const { service, raw } = serviceWithRows([
      [
        {
          total: 3,
          sessions: [
            {
              session_uuid: '00000000-0000-4000-8000-000000000001',
              title: 'Review changes',
              owner_id: 'owner',
              owner_github_username: 'alice',
              session_kind: 'chat',
              session_status: 'active',
              repositories: ['org/one', 'org/two'],
              repository_count: 2,
              first_submitted_at: range.fromUtc,
              last_submitted_at: range.toUtc,
              runs: 3,
              sessions: 1,
              owners: 1,
              completed: 2,
              failed: 1,
              total_tokens: 0,
              total_reported_runs: 1,
              input_tokens: 7,
              input_reported_runs: 2,
              output_tokens: null,
              output_reported_runs: 0,
              estimated_cost: '0.02',
              estimated_cost_runs: 2,
            },
          ],
        },
      ],
    ]);
    const result = await service.listSessions(
      { repository: 'org/one', owner: 'owner', provider: 'openai', model: 'm' },
      2,
      1
    );
    expect(result.pagination).toEqual({ page: 2, limit: 1, total: 3, hasMore: true });
    expect(result.sessions[0]).toMatchObject({
      runs: 3,
      sessions: 1,
      repositories: ['org/one', 'org/two'],
      repositoryCount: 2,
      outcomes: { completed: 2, failed: 1 },
      tokens: { total: 0, input: 7, output: null, missingRuns: 2 },
      reportedCost: { usd: null, coveredRuns: 0 },
      estimatedCost: { usd: 0.02, coveredRuns: 2 },
    });
    const [sql, bindings] = raw.mock.calls.filter(([sql]) => !sql.startsWith('SET '))[0];
    expect(sql.indexOf('GROUP BY session_id')).toBeLessThan(sql.indexOf('LIMIT ? OFFSET ?'));
    expect(sql).toContain('WHERE position <= 5');
    expect(sql).toContain('t.id = s."defaultThreadId" AND t."sessionId" = s.id');
    expect(sql).toContain('ORDER BY last_submitted_at DESC, session_id DESC LIMIT ? OFFSET ?');
    expect(bindings).toEqual([range.fromUtc, range.toUtc, 'org/one', 'owner', 'openai', 'm', 1, 1]);
  });

  it('keeps session totals when a requested page is empty and validates direct pagination', async () => {
    const { service } = serviceWithRows([[{ total: 1, sessions: [] }]]);
    expect((await service.listSessions({}, 2)).pagination).toEqual({ page: 2, limit: 25, total: 1, hasMore: false });
    await expect(service.listSessions({}, 0)).rejects.toThrow('Invalid session pagination.');
    await expect(service.listSessions({}, 1, 101)).rejects.toThrow('Invalid session pagination.');
  });

  it('applies an exact session UUID in the run source before pagination and retains all other scopes', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const { service, raw } = serviceWithRows([[{ total: 0, runs: [] }]]);
    await service.listRuns({ sessionId, repository: 'org/one', runStatus: 'failed' }, 3, 2);
    const [sql, bindings] = raw.mock.calls.filter(([sql]) => !sql.startsWith('SET '))[0];
    expect(sql).toContain('AND s.uuid = ?::uuid');
    expect(sql.indexOf('AND s.uuid = ?::uuid')).toBeLessThan(sql.indexOf('LIMIT ? OFFSET ?'));
    expect(bindings).toEqual([range.fromUtc, range.toUtc, sessionId, 'org/one', 'failed', 2, 4]);
  });

  it('returns bounded independent options and truncation counts', async () => {
    const raw = jest.fn().mockResolvedValue({
      rows: [
        {
          as_of: new Date(range.asOf),
          repositories_total: 201,
          models_total: 2,
          owners_total: 1,
          has_unattributed: true,
          repositories: ['org/repo'],
          models: [{ provider: 'openai', model: 'model' }],
          owners: [{ id: 'owner', githubUsername: null }],
        },
      ],
    });
    const result = await new AgentAnalyticsService({
      knex: { transaction: async (callback: any) => callback({ raw }) },
    } as any).getOptions();
    expect(result.truncated).toEqual({ repositories: true, owners: false, models: false });
    expect(result.owners).toEqual([{ id: 'owner', githubUsername: null }]);
    expect(result.hasUnattributed).toBe(true);
    expect(raw.mock.calls.filter(([sql]) => !sql.startsWith('SET '))[0][1]).toEqual([200, 200, 200]);
  });
});

describe('Agent analytics input boundaries', () => {
  it('uses recorded names and keeps owner identity separate', () => {
    expect(
      parseAgentAnalyticsQuery(
        new URLSearchParams('repository=Org%2FRepo&organization=Org&owner=keycloak-uuid&sessionKind=chat&compare=true')
      )
    ).toMatchObject({
      repository: 'org/repo',
      organization: 'org',
      owner: 'keycloak-uuid',
      sessionKind: 'chat',
      compare: true,
    });
  });
  it.each([
    'repositoryId=123',
    'repository=bad',
    'organization=org%2Frepo',
    'sessionKind=other',
    'compare=1',
    'from=2026-02-30&to=2026-03-04',
    'from=2025-01-01&to=2026-01-02',
  ])('rejects unsupported or invalid scope %s', (input) => {
    expect(() => parseAgentAnalyticsQuery(new URLSearchParams(input))).toThrow();
  });
  it.each(['page=0', 'page=2.5', 'page=10001', 'limit=101', 'limit=-1'])('rejects invalid pagination %s', (input) => {
    expect(() => parseAgentAnalyticsPagination(new URLSearchParams(input))).toThrow();
  });
  it('validates run outcomes and default bounded pagination', () => {
    expect(parseAgentAnalyticsPagination(new URLSearchParams())).toEqual({ page: 1, limit: 25 });
    expect(() => parseAgentAnalyticsRunsQuery(new URLSearchParams('runStatus=success'))).toThrow();
    expect(parseAgentAnalyticsRunsQuery(new URLSearchParams('runStatus=unknown')).runStatus).toBe('unknown');
  });
  it('validates the exact session UUID without changing other Agent scopes', () => {
    const sessionId = 'AAAAAAAA-0000-4000-8000-000000000001';
    expect(parseAgentAnalyticsRunsQuery(new URLSearchParams(`sessionId=${sessionId}&owner=owner`))).toMatchObject({
      sessionId: sessionId.toLowerCase(),
      owner: 'owner',
    });
    expect(() => parseAgentAnalyticsRunsQuery(new URLSearchParams('sessionId=bad'))).toThrow(
      'sessionId must be a UUID.'
    );
  });
});
