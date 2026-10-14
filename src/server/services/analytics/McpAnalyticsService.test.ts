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
import McpAnalyticsService, {
  MCP_ERROR_LIMIT,
  MCP_USER_LIMIT,
  parseMcpAnalyticsQuery,
  parseMcpCallsQuery,
  serializeMcpUsageTotals,
} from './McpAnalyticsService';
import type { ResolvedAnalyticsRange } from './query';

const range: ResolvedAnalyticsRange = {
  from: '2026-03-08',
  to: '2026-03-10',
  timezone: 'UTC',
  fromUtc: '2026-03-08T00:00:00.000Z',
  toUtc: '2026-03-10T00:00:00.000Z',
  dates: ['2026-03-08', '2026-03-09'],
  calendarDays: 2,
  interval: 'day',
  compare: true,
  asOf: '2026-03-10T08:00:00.000Z',
  previous: {
    from: '2026-03-06',
    to: '2026-03-08',
    fromUtc: '2026-03-06T00:00:00.000Z',
    toUtc: '2026-03-08T00:00:00.000Z',
    dates: ['2026-03-06', '2026-03-07'],
  },
};
function serviceWithRow(row: Record<string, unknown>) {
  const raw = jest.fn(async (sql: string, _bindings?: unknown[]) =>
    sql.startsWith('SET ') ? undefined : { rows: [row] }
  );
  const transaction = jest.fn(async (callback) => callback({ raw }));
  return { service: new McpAnalyticsService({ knex: { transaction } } as any), raw };
}
const summaryRow = {
  periods: [
    {
      period: 'current',
      calls: 40,
      errors: 4,
      users: 3,
      clients: 2,
      installations: 5,
      read_only_calls: 30,
      change_calls: 8,
    },
    { period: 'previous', calls: 10, errors: 0, users: 1, clients: 1, read_only_calls: 0, change_calls: 10 },
  ],
  buckets: [
    { period: 'current', bucket: '2026-03-09', calls: 40, errors: 4, users: 3 },
    { period: 'previous', bucket: '2026-03-08', calls: 10, errors: 0, users: 1 },
  ],
  tools: [
    { tool: 'get_environment', read_only: true, calls: 30, errors: 1, p50_duration_ms: '12.5', p95_duration_ms: 80 },
    { tool: 'deploy_environment', read_only: null, calls: 10, errors: 3, p50_duration_ms: null, p95_duration_ms: null },
  ],
  users: [
    { user_id: 'sub-1', username: 'alice', calls: 25, errors: 1, last_call_at: '2026-03-09T10:00:00Z' },
    { user_id: null, username: null, calls: 15, errors: 3, last_call_at: null },
  ],
  user_total: '3',
  clients: [
    {
      client: 'Claude Desktop',
      installations: 2,
      calls: 40,
      users: 3,
      errors: 4,
      last_call_at: '2026-03-09T10:00:00Z',
    },
  ],
  errors: [{ code: 'env_not_found', calls: '3' }],
  audit_since: '2026-01-01T00:00:00Z',
  all_calls_since: '2026-03-01T00:00:00Z',
  as_of: new Date('2026-03-10T08:00:01Z'),
};

describe('McpAnalyticsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRange.mockResolvedValue(range);
  });

  it('accepts the shared calendar parameters only', () => {
    expect(parseMcpAnalyticsQuery(new URLSearchParams('from=2026-03-01&to=2026-03-08&compare=false'))).toEqual({
      from: '2026-03-01',
      to: '2026-03-08',
      timezone: 'UTC',
      interval: 'day',
      compare: false,
    });
    expect(() => parseMcpAnalyticsQuery(new URLSearchParams('from=2026-02-30'))).toThrow();
  });

  it('serializes totals with an error rate only when calls exist', () => {
    expect(serializeMcpUsageTotals()).toEqual({
      calls: 0,
      errors: 0,
      errorRate: null,
      users: 0,
      clients: 0,
      installations: 0,
      readOnlyCalls: 0,
      changeCalls: 0,
    });
    expect(serializeMcpUsageTotals({ calls: '8', errors: 2, users: 'x' })).toMatchObject({
      calls: 8,
      errors: 2,
      errorRate: 0.25,
      users: 0,
    });
  });

  it('aggregates recorded tool calls by period, bucket, tool, user and client', async () => {
    const { service, raw } = serviceWithRow(summaryRow);
    const result = await service.getSummary(parseMcpAnalyticsQuery(new URLSearchParams()));

    expect(result.totals).toEqual({
      calls: 40,
      errors: 4,
      errorRate: 0.1,
      users: 3,
      clients: 2,
      installations: 5,
      readOnlyCalls: 30,
      changeCalls: 8,
    });
    expect(result.previousTotals).toMatchObject({ calls: 10, errorRate: 0 });
    expect(result.buckets).toEqual([
      { date: '2026-03-08', calls: 0, errors: 0, users: 0, previousCalls: 10, previousErrors: 0, previousUsers: 1 },
      { date: '2026-03-09', calls: 40, errors: 4, users: 3, previousCalls: 0, previousErrors: 0, previousUsers: 0 },
    ]);
    expect(result.tools).toEqual([
      {
        tool: 'get_environment',
        readOnly: true,
        calls: 30,
        errors: 1,
        errorRate: 1 / 30,
        p50DurationMs: 12.5,
        p95DurationMs: 80,
      },
      {
        tool: 'deploy_environment',
        readOnly: null,
        calls: 10,
        errors: 3,
        errorRate: 0.3,
        p50DurationMs: null,
        p95DurationMs: null,
      },
    ]);
    expect(result.users).toEqual({
      items: [
        { userId: 'sub-1', username: 'alice', calls: 25, errors: 1, lastCallAt: '2026-03-09T10:00:00.000Z' },
        { userId: null, username: null, calls: 15, errors: 3, lastCallAt: null },
      ],
      total: 3,
      limit: MCP_USER_LIMIT,
    });
    expect(result.clients).toEqual([
      {
        client: 'Claude Desktop',
        installations: 2,
        calls: 40,
        users: 3,
        errors: 4,
        lastCallAt: '2026-03-09T10:00:00.000Z',
      },
    ]);
    expect(result.errors).toEqual([{ code: 'env_not_found', calls: 3 }]);
    expect(result.auditSince).toBe('2026-01-01T00:00:00.000Z');
    expect(result.allCallsSince).toBe('2026-03-01T00:00:00.000Z');
    expect(result.asOf).toBe('2026-03-10T08:00:01.000Z');
    expect(MCP_ERROR_LIMIT).toBe(10);

    expect(raw.mock.calls[0][0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const [sql, bindings = []] = raw.mock.calls.find(([statement]) =>
      statement.includes('WITH calls AS MATERIALIZED')
    )!;
    expect(sql).toContain(
      `a.event = 'mcp.tool_call' AND a."createdAt" >= ?::timestamptz AND a."createdAt" < ?::timestamptz`
    );
    expect(sql).toContain(`(a.outcome <> 'succeeded') AS is_error`);
    expect(sql).toContain(`CASE a.meta->>'readOnly' WHEN 'true' THEN true WHEN 'false' THEN false END AS read_only`);
    expect(sql).toContain(`(meta->>'readOnly') IS NOT NULL`);
    expect(sql).toContain(`COALESCE(a.meta->>'clientName',`);
    expect(sql).toContain(`SELECT DISTINCT period, client FROM calls WHERE client_name IS NOT NULL`);
    expect(sql).toContain(
      `SELECT DISTINCT period, bucket, "principalId" FROM bucketed WHERE "principalId" IS NOT NULL`
    );
    expect(sql).toContain(`count(DISTINCT client_id)::int AS installations`);
    expect(sql).toContain('percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)');
    expect(sql).toContain(`LIMIT ${MCP_USER_LIMIT}) x) AS users`);
    expect(sql.split('?').length - 1).toBe(bindings.length);
    expect(bindings).toEqual([range.fromUtc, range.previous!.fromUtc, range.toUtc, 'day', 'UTC', 2]);
  });

  it('returns empty, zero-filled analytics without comparison', async () => {
    mockResolveRange.mockResolvedValue({ ...range, compare: false, previous: null });
    const { service, raw } = serviceWithRow({
      periods: [],
      buckets: [],
      tools: [],
      users: [],
      user_total: 0,
      clients: [],
      errors: [],
      audit_since: null,
      all_calls_since: null,
      as_of: 'not a date',
    });
    const result = await service.getSummary(parseMcpAnalyticsQuery(new URLSearchParams('compare=false')));
    expect(result.previousTotals).toBeNull();
    expect(result.totals.calls).toBe(0);
    expect(result.buckets).toEqual([
      {
        date: '2026-03-08',
        calls: 0,
        errors: 0,
        users: 0,
        previousCalls: null,
        previousErrors: null,
        previousUsers: null,
      },
      {
        date: '2026-03-09',
        calls: 0,
        errors: 0,
        users: 0,
        previousCalls: null,
        previousErrors: null,
        previousUsers: null,
      },
    ]);
    expect(result.auditSince).toBeNull();
    expect(result.asOf).toBe(range.asOf);
    const [, bindings = []] = raw.mock.calls.find(([statement]) => statement.includes('WITH calls AS MATERIALIZED'))!;
    expect(bindings.slice(0, 3)).toEqual([range.fromUtc, range.fromUtc, range.toUtc]);
  });
});

describe('MCP call records', () => {
  const compiler = knexFactory({ client: 'pg' });
  function serviceWithCalls(row: Record<string, unknown>) {
    const raw = jest.fn((sql: string, bindings?: unknown[]) => {
      if (sql.startsWith('SET ')) return Promise.resolve();
      if (sql.includes('matched AS MATERIALIZED')) return Promise.resolve({ rows: [row] });
      return compiler.raw(sql, bindings as any);
    });
    const transaction = jest.fn(async (callback) => callback({ raw }));
    return { service: new McpAnalyticsService({ knex: { transaction } } as any), raw };
  }
  const callsRow = {
    total: 2,
    records: [
      {
        id: 31,
        createdAt: '2026-03-09T10:00:00Z',
        period: 'current',
        tool: 'get_environment',
        read_only: true,
        outcome: 'env_not_found',
        is_error: true,
        duration_ms: '12.5',
        principalId: 'sub-1',
        username: 'alice',
        client: 'Claude Desktop',
        client_id: 'client-1',
        request_id: 'req-1',
        environment_uuid: 'env-1',
        environment_id: '42',
        site_id: null,
        deploy_id: null,
      },
      {
        id: 32,
        createdAt: '2026-03-09T11:00:00Z',
        period: 'current',
        tool: 'deploy_environment',
        read_only: null,
        outcome: 'succeeded',
        is_error: false,
        duration_ms: null,
        principalId: null,
        username: null,
        client: 'Unknown client',
        client_id: null,
        request_id: null,
        environment_uuid: null,
        environment_id: null,
        site_id: null,
        deploy_id: null,
      },
    ],
    as_of: new Date('2026-03-10T08:00:01Z'),
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRange.mockResolvedValue(range);
  });
  afterAll(async () => {
    await compiler.destroy();
  });

  it('parses the call slice, sort and pagination', () => {
    expect(
      parseMcpCallsQuery(
        new URLSearchParams(
          'tool=get_environment&userId=unknown&client=Unknown%20client&outcome=env_not_found&date=2026-03-09&sort=durationMs:asc&page=3&limit=5'
        )
      )
    ).toMatchObject({
      tool: 'get_environment',
      userId: 'unknown',
      client: 'Unknown client',
      outcome: 'env_not_found',
      slice: { date: '2026-03-09', period: 'current' },
      sort: { key: 'durationMs', descending: false },
      page: 3,
      limit: 5,
    });
    expect(parseMcpCallsQuery(new URLSearchParams())).toMatchObject({
      tool: null,
      userId: null,
      client: null,
      outcome: null,
      slice: { date: null, period: 'current' },
      sort: { key: 'createdAt', descending: true },
      page: 1,
      limit: 25,
    });
    expect(() => parseMcpCallsQuery(new URLSearchParams('tool=%20'))).toThrow('tool must be');
    expect(() => parseMcpCallsQuery(new URLSearchParams(`client=${'c'.repeat(256)}`))).toThrow('client must be');
    expect(() => parseMcpCallsQuery(new URLSearchParams(`client=${'\u{1F680}'.repeat(256)}`))).toThrow(
      'client must be'
    );
    expect(parseMcpCallsQuery(new URLSearchParams(`client=${'\u{1F680}'.repeat(255)}`)).client).toBe(
      '\u{1F680}'.repeat(255)
    );
    expect(parseMcpCallsQuery(new URLSearchParams(`tool=${'\u{1F680}'.repeat(128)}`)).tool).toBe(
      '\u{1F680}'.repeat(128)
    );
    expect(() => parseMcpCallsQuery(new URLSearchParams('outcome=bad%20code'))).toThrow('outcome must be');
    expect(() => parseMcpCallsQuery(new URLSearchParams('sort=tool'))).toThrow('sort must be');
    expect(() => parseMcpCallsQuery(new URLSearchParams('page=0'))).toThrow('page must be');
  });

  it('cuts the summary facts by the slice and maps each call', async () => {
    const { service, raw } = serviceWithCalls(callsRow);
    const result = await service.getCalls(
      parseMcpCallsQuery(
        new URLSearchParams(
          'tool=get_environment&userId=unknown&client=Unknown%20client&outcome=env_not_found&date=2026-03-09&sort=durationMs:asc&limit=5'
        )
      )
    );
    const [sql, bindings = []] = raw.mock.calls.find(([statement]) => statement.includes('matched AS MATERIALIZED'))!;
    expect(sql).toContain(`a.id, a."requestId" AS request_id, a.meta->>'uuid' AS environment_uuid`);
    expect(sql).toContain(
      `a.meta->>'environmentId' AS environment_id, a.meta->>'siteId' AS site_id, a.meta->>'deployId' AS deploy_id`
    );
    expect(sql).toContain(`(a.outcome <> 'succeeded') AS is_error`);
    expect(sql).toContain(
      `matched AS MATERIALIZED (SELECT m.* FROM calls m WHERE m.period = ? AND m.tool = ? AND m."principalId" IS NULL AND m.client = ? AND m.outcome = ? AND to_char(date_trunc(?, ("m"."createdAt" AT TIME ZONE ?) + (? * interval '1 day')), 'YYYY-MM-DD') = ?)`
    );
    expect(sql).toContain('ORDER BY m.duration_ms ASC NULLS LAST, m."createdAt" ASC, m.id ASC LIMIT ? OFFSET ?');
    expect(sql.split('?').length - 1).toBe(bindings.length);
    expect(bindings).toEqual([
      range.fromUtc,
      range.fromUtc,
      range.toUtc,
      'current',
      'get_environment',
      'Unknown client',
      'env_not_found',
      'day',
      'UTC',
      0,
      '2026-03-09',
      5,
      0,
    ]);
    expect(result.slice).toEqual({
      tool: 'get_environment',
      userId: 'unknown',
      client: 'Unknown client',
      outcome: 'env_not_found',
      date: '2026-03-09',
      period: 'current',
      sort: 'durationMs:asc',
    });
    expect(result.pagination).toEqual({ page: 1, limit: 5, total: 2, hasMore: false });
    expect(result.caveats).toContain('Tool arguments are not recorded. Only the identifiers of the target are kept.');
    expect(result.records).toEqual([
      {
        id: 31,
        createdAt: '2026-03-09T10:00:00.000Z',
        period: 'current',
        tool: 'get_environment',
        readOnly: true,
        outcome: 'env_not_found',
        error: true,
        durationMs: 12.5,
        userId: 'sub-1',
        username: 'alice',
        client: 'Claude Desktop',
        clientId: 'client-1',
        requestId: 'req-1',
        target: { environmentUuid: 'env-1', environmentId: 42, siteId: null, deployId: null },
      },
      {
        id: 32,
        createdAt: '2026-03-09T11:00:00.000Z',
        period: 'current',
        tool: 'deploy_environment',
        readOnly: null,
        outcome: 'succeeded',
        error: false,
        durationMs: null,
        userId: null,
        username: null,
        client: 'Unknown client',
        clientId: null,
        requestId: null,
        target: null,
      },
    ]);
  });

  it('maps the succeeded and error outcome filters and an exact user', async () => {
    const { service, raw } = serviceWithCalls({ ...callsRow, total: 0, records: [] });
    await service.getCalls(parseMcpCallsQuery(new URLSearchParams('outcome=succeeded&userId=sub-1&period=previous')));
    await service.getCalls(parseMcpCallsQuery(new URLSearchParams('outcome=error')));
    const statements = raw.mock.calls.filter(([statement]) => statement.includes('matched AS MATERIALIZED'));
    expect(statements[0][0]).toContain('WHERE m.period = ? AND m."principalId" = ? AND NOT m.is_error)');
    expect((statements[0][1] ?? []).slice(3, 5)).toEqual(['previous', 'sub-1']);
    expect(statements[1][0]).toContain('WHERE m.period = ? AND m.is_error)');
    expect(statements[1][0]).toContain('ORDER BY m."createdAt" DESC NULLS LAST, m."createdAt" DESC, m.id DESC');
    mockResolveRange.mockResolvedValue({ ...range, compare: false, previous: null });
    await expect(service.getCalls(parseMcpCallsQuery(new URLSearchParams('period=previous')))).rejects.toThrow(
      'period must be current when compare is false.'
    );
  });
});
