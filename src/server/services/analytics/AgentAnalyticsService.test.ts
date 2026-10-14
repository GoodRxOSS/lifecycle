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
  serializeAgentAnalyticsMetrics,
} from './AgentAnalyticsService';
import knexFactory from 'knex';
import { parseAnalyticsPagination, type ResolvedAnalyticsRange } from './query';

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

const formatter = knexFactory({ client: 'pg' });
function serviceWithRows(results: unknown[][]) {
  const raw = jest.fn((sql: string, bindings?: readonly unknown[]) => {
    if (sql.startsWith('SET ')) return undefined;
    if (sql.startsWith('to_char(')) return formatter.raw(sql, bindings as any);
    return { rows: results.shift() };
  });
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
    expect(sql).toContain("rp.source -> 'repoFullName'");
    expect(sql).toContain("rp.source #> '{workspaceLayout,primaryRepo}'");
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

  it('lists every unfinished status for the in_progress filter', async () => {
    const { service, raw } = serviceWithRows([[{ total: 0, runs: [] }]]);
    await service.listRuns({ runStatus: 'in_progress' }, 1, 25);
    const [sql, bindings] = raw.mock.calls.filter(([sql]) => !sql.startsWith('SET '))[0] as unknown as [
      string,
      unknown[]
    ];
    expect(sql).toContain('WHERE status IN (?, ?, ?, ?, ?, ?)');
    expect(sql).toContain('LEFT JOIN LATERAL jsonb_to_record(');
    expect(sql).not.toContain(`r."runPlanSnapshot" #>`);
    expect(bindings).toEqual([
      range.fromUtc,
      range.toUtc,
      'queued',
      'starting',
      'running',
      'waiting_for_approval',
      'waiting_for_input',
      'transitioned',
      25,
      0,
    ]);
  });

  it('keeps usage totals when the earliest retained run has a nonfinite date', async () => {
    const { service } = serviceWithRows([
      [{ period: 'current', group_type: 'total', runs: 1, sessions: 1, total_tokens: 300, total_reported_runs: 1 }],
      [{ period: 'current', count: 1 }],
      [{ earliest: Number.NEGATIVE_INFINITY }],
    ]);
    const result = await service.getSummary({});
    expect(result.earliestRunAt).toBeNull();
    expect(result.asOf).toBe(range.asOf);
    expect(result.totals).toMatchObject({ runs: 1, sessions: 1, tokens: { total: 300, reportedRuns: 1 } });
    expect(result.sessionsCreated.current).toBe(1);
  });

  it('returns missing queue dates while preserving valid dates and run totals', async () => {
    const validString = '2026-03-08T08:00:00+00:00';
    const queueDates = [
      'infinity',
      Number.NEGATIVE_INFINITY,
      new Date(NaN),
      'not-a-date',
      validString,
      new Date(range.fromUtc),
    ];
    const { service } = serviceWithRows([
      [
        {
          total: queueDates.length,
          runs: queueDates.map((queued_at, index) => ({
            run_uuid: `run-${index}`,
            session_uuid: 'session',
            thread_uuid: 'thread',
            submitted_at: range.fromUtc,
            queued_at,
            status: 'completed',
            provider: 'provider',
            model: 'model',
            owner_id: 'owner',
            total_tokens: 100,
          })),
        },
      ],
    ]);
    const result = await service.listRuns({});
    expect(result.runs.map((run) => run.queuedAt)).toEqual([null, null, null, null, validString, range.fromUtc]);
    expect(result.runs.every((run) => run.submittedAt === range.fromUtc && run.tokens.total === 100)).toBe(true);
    expect(result.pagination).toEqual({ page: 1, limit: 25, total: queueDates.length, hasMore: false });
    expect(result.asOf).toBe(range.asOf);
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

  it('lists runs and sessions for one chart bucket of the comparison window', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const runs = serviceWithRows([[{ total: 0, runs: [] }]]);
    const result = await runs.service.listRuns({ sessionId, runStatus: 'failed' }, 2, 10, {
      date: '2026-03-09',
      period: 'previous',
    });
    expect(result.slice).toEqual({ date: '2026-03-09', period: 'previous' });
    expect(result.range).toBe(range);
    expect(result.pagination).toEqual({ page: 2, limit: 10, total: 0, hasMore: false });
    const [sql, bindings] = runs.raw.mock.calls.find(([sql]) => sql.includes('WITH facts'))!;
    expect(sql).toContain(
      `WHERE r."createdAt" >= ?::timestamptz AND r."createdAt" < ?::timestamptz AND to_char(date_trunc(?, ("r"."createdAt" AT TIME ZONE ?) + (? * interval '1 day')), 'YYYY-MM-DD') = ?`
    );
    expect(sql).toContain('AND s.uuid = ?::uuid');
    expect(bindings).toEqual([
      range.previous!.fromUtc,
      range.previous!.toUtc,
      'day',
      'America/Los_Angeles',
      2,
      '2026-03-09',
      sessionId,
      'failed',
      10,
      10,
    ]);
    const sessions = serviceWithRows([[{ total: 0, sessions: [] }]]);
    const sessionResult = await sessions.service.listSessions({ owner: 'owner' }, 1, 5, {
      date: '2026-03-08',
      period: 'current',
    });
    expect(sessionResult.slice).toEqual({ date: '2026-03-08', period: 'current' });
    const [sessionSql, sessionBindings] = sessions.raw.mock.calls.find(([sql]) => sql.includes('WITH facts'))!;
    expect(sessionSql).toContain(
      `WHERE r."createdAt" >= ?::timestamptz AND r."createdAt" < ?::timestamptz AND to_char(date_trunc(?, ("r"."createdAt" AT TIME ZONE ?) + (? * interval '1 day')), 'YYYY-MM-DD') = ?`
    );
    expect(sessionBindings).toEqual([
      range.fromUtc,
      range.toUtc,
      'day',
      'America/Los_Angeles',
      0,
      '2026-03-08',
      'owner',
      5,
      0,
    ]);
    const previous = serviceWithRows([[{ total: 0, sessions: [] }]]);
    await previous.service.listSessions({}, 1, 25, { date: null, period: 'previous' });
    const [previousSql, previousBindings] = previous.raw.mock.calls.find(([sql]) => sql.includes('WITH facts'))!;
    expect(previousSql).not.toContain('to_char(');
    expect(previousBindings).toEqual([range.previous!.fromUtc, range.previous!.toUtc, 25, 0]);
    const plain = serviceWithRows([[{ total: 0, runs: [] }]]);
    expect((await plain.service.listRuns({})).slice).toEqual({ date: null, period: 'current' });
    expect(plain.raw.mock.calls.find(([sql]) => sql.includes('WITH facts'))![1]).toEqual([
      range.fromUtc,
      range.toUtc,
      25,
      0,
    ]);
  });

  it('rejects a slice outside the resolved window before querying', async () => {
    const { service, raw } = serviceWithRows([[{ total: 0, runs: [] }]]);
    await expect(service.listRuns({}, 1, 25, { date: '2026-03-07', period: 'current' })).rejects.toThrow(
      'date must be the start of a bucket inside the window.'
    );
    mockResolveRange.mockResolvedValue({ ...range, compare: false, previous: null });
    await expect(service.listSessions({}, 1, 25, { date: null, period: 'previous' })).rejects.toThrow(
      'period must be current when compare is false.'
    );
    expect(raw.mock.calls.some(([sql]) => sql.includes('WITH facts'))).toBe(false);
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
    expect(() => parseAnalyticsPagination(new URLSearchParams(input))).toThrow();
  });
  it('validates run outcomes and default bounded pagination', () => {
    expect(parseAnalyticsPagination(new URLSearchParams())).toEqual({ page: 1, limit: 25 });
    expect(() => parseAgentAnalyticsRunsQuery(new URLSearchParams('runStatus=success'))).toThrow();
    expect(parseAgentAnalyticsRunsQuery(new URLSearchParams('runStatus=unknown')).runStatus).toBe('unknown');
    expect(parseAgentAnalyticsRunsQuery(new URLSearchParams('runStatus=in_progress')).runStatus).toBe('in_progress');
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
