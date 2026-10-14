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

// Live-database test: runs the deploy-request attribution and MCP usage SQL against a real
// PostgreSQL with migration 038 applied. The synthetic rows copy the event shapes the pipeline
// writes, sit in a window before the table existed, and are removed afterwards. Run with:
//   ANALYTICS_LIVE_DB_URL=postgresql://lifecycle:lifecycle@localhost:5434/lifecycle NODE_ENV=test npx jest analyticsLive

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
}));

import knexFactory, { type Knex } from 'knex';
import DeploymentAnalyticsService, {
  DEPLOYMENT_OUTCOMES,
  parseDeploymentAnalyticsQuery,
  parseDeploymentRequestsQuery,
} from '../DeploymentAnalyticsService';
import EnvironmentAnalyticsService, {
  parseEnvironmentAnalyticsPullRequestsQuery,
  parseEnvironmentAnalyticsQuery,
  parseEnvironmentAnalyticsRecordsQuery,
  parseEnvironmentAnalyticsScope,
} from '../EnvironmentAnalyticsService';
import McpAnalyticsService, { parseMcpAnalyticsQuery, parseMcpCallsQuery } from '../McpAnalyticsService';

const liveDescribe = process.env.ANALYTICS_LIVE_DB_URL ? describe : describe.skip;
const MARK = 'analytics-live-test';
const WINDOW = 'from=2025-10-01&to=2025-10-13&timezone=UTC';
const at = (day: number, hour: number, minute: number, second = 0) =>
  new Date(Date.UTC(2025, 9, day, hour, minute, second)).toISOString();

type Scoped = { id: number; repositoryId: number | null; fullName: string | null };

liveDescribe('analytics against a live database', () => {
  let knex: Knex;
  let builds: Scoped[];
  let tornDownBefore: Date | string | null = null;
  const event = (buildId: number, kind: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    buildId,
    kind,
    createdAt,
    ...extra,
    meta: JSON.stringify({ mark: MARK, ...((extra.meta as Record<string, unknown>) ?? {}) }),
  });
  const cleanup = async () => {
    await knex('build_events').whereRaw(`meta->>'mark' = ?`, [MARK]).delete();
    await knex('auth_audit_events').where('requestId', 'like', `${MARK}%`).delete();
  };

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: process.env.ANALYTICS_LIVE_DB_URL, pool: { min: 0, max: 2 } });
    await cleanup();
    builds = await knex('builds as b')
      .join('pull_requests as p', 'p.id', 'b.pullRequestId')
      .join('repositories as r', 'r.id', 'p.repositoryId')
      .where('b.kind', 'environment')
      .select('b.id', 'p.repositoryId', 'r.fullName')
      .orderBy('b.id')
      .limit(3);
    if (builds.length < 3) throw new Error('The live database needs at least three PR environment records.');
    const [one, two, three] = builds.map((build) => build.id);
    tornDownBefore = (await knex('builds').where({ id: two }).first('lastTornDownAt'))?.lastTornDownAt ?? null;
    await knex('builds')
      .where({ id: two })
      .update({ lastTornDownAt: at(9, 19, 0) });
    await knex('build_events').insert([
      // r1: push, claimed, finished with its service ready -> succeeded (5 min to ready, 1 min wait)
      event(one, 'deploy_requested', at(5, 10, 0), { origin: 'push', runUUID: 'r1', meta: { generation: 1 } }),
      event(one, 'run_claimed', at(5, 10, 1), { runUUID: 'r1', meta: { generation: 1 } }),
      event(one, 'deploy_status', at(5, 10, 2), { runUUID: 'r1', deployId: 10, status: 'building' }),
      event(one, 'deploy_status', at(5, 10, 4, 59), { runUUID: 'r1', deployId: 10, status: 'ready' }),
      event(one, 'run_finished', at(5, 10, 5), {
        runUUID: 'r1',
        status: 'succeeded',
        meta: { generation: 1, services: 1, failed: 0, rollout: true },
      }),
      // r6: nothing pending for the request -> superseded
      event(one, 'deploy_requested', at(5, 13, 0), { origin: 'api', runUUID: 'r6', meta: { generation: 2 } }),
      event(one, 'run_superseded', at(5, 13, 0, 30), {
        runUUID: 'r6',
        reason: 'rows_taken',
        meta: { generation: 2, blocked: null },
      }),
      // r17: the environment was already torn down when the run looked -> torn down
      event(one, 'deploy_requested', at(5, 15, 0), { origin: 'api', runUUID: 'r17', meta: { generation: 5 } }),
      event(one, 'run_blocked', at(5, 15, 0, 5), { runUUID: 'r17', reason: 'torn_down', meta: { generation: 5 } }),
      // r10: deploys disabled when the run looked -> not run
      event(one, 'deploy_requested', at(8, 16, 0), { origin: 'label', runUUID: 'r10', meta: { generation: 3 } }),
      event(one, 'run_blocked', at(8, 16, 0, 10), {
        runUUID: 'r10',
        reason: 'deploy_disabled',
        meta: { generation: 3 },
      }),
      // r12: an environment with no services finishes at once -> succeeded, but no time-to-ready sample
      event(one, 'deploy_requested', at(8, 18, 0), { origin: 'redeploy', runUUID: 'r12', meta: { generation: 4 } }),
      event(one, 'run_claimed', at(8, 18, 0, 10), { runUUID: 'r12', meta: { generation: 4 } }),
      event(one, 'run_finished', at(8, 18, 0, 20), {
        runUUID: 'r12',
        status: 'succeeded',
        meta: { generation: 4, services: 0, failed: 0 },
      }),
      // r2 label replaced at acceptance by r3, an environment-wide redeploy whose run fails one service
      event(two, 'deploy_requested', at(6, 11, 0), { origin: 'label', runUUID: 'r2', meta: { generation: 1 } }),
      event(two, 'deploy_requested', at(6, 11, 1), { origin: 'redeploy', runUUID: 'r3', meta: { generation: 2 } }),
      event(two, 'run_superseded', at(6, 11, 1), { runUUID: 'r2', reason: 'intent_replaced', meta: { generation: 1 } }),
      event(two, 'run_claimed', at(6, 11, 2), { runUUID: 'r3', meta: { generation: 2 } }),
      event(two, 'deploy_status', at(6, 11, 6), {
        runUUID: 'r3',
        deployId: 30,
        status: 'error',
        reason: 'Build failed for service api-123 (attempt 2)',
      }),
      event(two, 'run_finished', at(6, 11, 6), {
        runUUID: 'r3',
        status: 'failed',
        reason: 'Build failed for service api-123 (attempt 2)',
        meta: {
          generation: 2,
          services: 2,
          failed: 1,
          rollout: true,
          serviceOutcomes: [
            {
              name: 'api',
              type: 'docker',
              status: 'build_failed',
              outcome: 'failed',
              message: 'Build failed for service api-123 (attempt 2)',
            },
            { name: 'web', type: 'docker', status: 'ready', outcome: 'ready', message: null },
          ],
        },
      }),
      // r7: the environment started tearing down during the run -> torn down
      event(two, 'deploy_requested', at(6, 14, 0), { origin: 'redeploy', runUUID: 'r7', meta: { generation: 3 } }),
      event(two, 'run_claimed', at(6, 14, 1), { runUUID: 'r7', meta: { generation: 3 } }),
      event(two, 'run_superseded', at(6, 14, 2), {
        runUUID: 'r7',
        reason: 'failure_ignored',
        meta: { generation: 3, blocked: 'tearing_down' },
      }),
      // r14: a repository-scoped push whose root lifecycle.yaml is broken -> failed with the config reason
      event(two, 'deploy_requested', at(7, 9, 0), { origin: 'push', runUUID: 'r14', meta: { generation: 6 } }),
      event(two, 'run_claimed', at(7, 9, 0, 30), { runUUID: 'r14', meta: { generation: 6, scope: 'repository' } }),
      event(two, 'build_status', at(7, 9, 0, 40), { runUUID: 'stale-env-token', status: 'config_error' }),
      event(two, 'run_finished', at(7, 9, 1), {
        runUUID: 'r14',
        status: 'failed',
        reason: 'Lifecycle configuration failed validation: services must be a list',
        meta: { generation: 6, services: null, failed: null },
      }),
      // r14's retry repeats the finish from its taken rows; the first reason stays, since neither finish followed a rollout
      event(two, 'run_finished', at(7, 9, 2), {
        runUUID: 'r14',
        status: 'failed',
        reason: 'api did not report ready (queued)',
        meta: { generation: 6, services: 1, failed: 1 },
      }),
      // r13: never claimed before the environment was torn down (builds.lastTornDownAt) -> torn down
      event(two, 'deploy_requested', at(9, 18, 0), { origin: 'label', runUUID: 'r13', meta: { generation: 7 } }),
      // r4 and r5: two repository-scoped pushes in one environment both run and finish
      event(three, 'deploy_requested', at(7, 10, 0), { origin: 'push', runUUID: 'r4', meta: { generation: 1 } }),
      event(three, 'deploy_requested', at(7, 10, 1), { origin: 'push', runUUID: 'r5', meta: { generation: 2 } }),
      event(three, 'run_claimed', at(7, 10, 0, 30), { runUUID: 'r4', meta: { generation: 1, scope: 'repository' } }),
      event(three, 'run_claimed', at(7, 10, 1, 30), { runUUID: 'r5', meta: { generation: 2, scope: 'repository' } }),
      event(three, 'run_finished', at(7, 10, 5), {
        runUUID: 'r4',
        status: 'succeeded',
        meta: { generation: 1, services: 1, failed: 0, rollout: true },
      }),
      // r4's retry repeats the finish six minutes later; time to ready stays at the first success
      event(three, 'run_finished', at(7, 10, 11), {
        runUUID: 'r4',
        status: 'succeeded',
        meta: { generation: 1, services: 1, failed: 0 },
      }),
      event(three, 'run_finished', at(7, 10, 6), {
        runUUID: 'r5',
        status: 'succeeded',
        meta: { generation: 2, services: 1, failed: 0, rollout: true },
      }),
      // r5's final queue attempt failed on bookkeeping long after the rollout; the rollout's finish still decides
      event(three, 'run_finished', at(7, 10, 30), {
        runUUID: 'r5',
        status: 'failed',
        reason: 'API rate limit exceeded for installation ID 4242.',
        meta: { generation: 2, services: 1, failed: 1 },
      }),
      // r8: a retried claim of the same run keeps one request and its first claim time
      event(three, 'deploy_requested', at(7, 12, 0), { origin: 'label', runUUID: 'r8', meta: { generation: 3 } }),
      event(three, 'run_claimed', at(7, 12, 0, 1), { runUUID: 'r8', meta: { generation: 3 } }),
      event(three, 'run_claimed', at(7, 12, 0, 30), { runUUID: 'r8', meta: { generation: 3 } }),
      event(three, 'run_finished', at(7, 12, 6), {
        runUUID: 'r8',
        status: 'succeeded',
        meta: { generation: 3, services: 3, failed: 0, rollout: true },
      }),
      // r9: an environment status error under another token does not touch this request; its rollouts failed at
      // +2, succeeded at +3 and succeeded again at +9, so the last rollout decides and time to ready is 3 minutes
      event(three, 'deploy_requested', at(10, 10, 0), { origin: 'push', runUUID: 'r9', meta: { generation: 4 } }),
      event(three, 'run_claimed', at(10, 10, 1), { runUUID: 'r9', meta: { generation: 4, scope: 'repository' } }),
      event(three, 'build_status', at(10, 10, 1, 30), {
        runUUID: 'stale-token',
        status: 'error',
        reason: 'other failed',
      }),
      event(three, 'run_finished', at(10, 10, 2), {
        runUUID: 'r9',
        status: 'failed',
        reason: 'Rollout timed out',
        meta: { generation: 4, services: 1, failed: 1, rollout: true },
      }),
      event(three, 'run_finished', at(10, 10, 3), {
        runUUID: 'r9',
        status: 'succeeded',
        meta: { generation: 4, services: 1, failed: 0, rollout: true },
      }),
      event(three, 'run_finished', at(10, 10, 9), {
        runUUID: 'r9',
        status: 'succeeded',
        meta: { generation: 4, services: 1, failed: 0, rollout: true },
      }),
      // r15: an environment-wide run whose rows a newer push took before it claimed them -> superseded
      event(three, 'deploy_requested', at(8, 9, 0), { origin: 'label', runUUID: 'r15', meta: { generation: 6 } }),
      event(three, 'run_claimed', at(8, 9, 0, 5), { runUUID: 'r15', meta: { generation: 6 } }),
      event(three, 'run_superseded', at(8, 9, 0, 10), {
        runUUID: 'r15',
        reason: 'rows_taken',
        meta: { generation: 6, blocked: null },
      }),
      // r16: the claim landed before the request row did; queue wait clamps to zero
      event(three, 'deploy_requested', at(8, 11, 0, 5), { origin: 'push', runUUID: 'r16', meta: { generation: 7 } }),
      event(three, 'run_claimed', at(8, 11, 0, 0), { runUUID: 'r16', meta: { generation: 7, scope: 'repository' } }),
      event(three, 'run_finished', at(8, 11, 4, 5), {
        runUUID: 'r16',
        status: 'succeeded',
        meta: { generation: 7, services: 1, failed: 0, rollout: true },
      }),
      // r11: nothing has happened yet -> unresolved
      event(three, 'deploy_requested', at(9, 17, 0), { origin: 'push', runUUID: 'r11', meta: { generation: 5 } }),
      // r18, outside the main window: a failure reason whose 120-character cut lands on a space
      event(one, 'deploy_requested', at(14, 9, 0), { origin: 'api', runUUID: 'r18', meta: { generation: 9 } }),
      event(one, 'run_claimed', at(14, 9, 1), { runUUID: 'r18', meta: { generation: 9 } }),
      event(one, 'run_finished', at(14, 9, 2), {
        runUUID: 'r18',
        status: 'failed',
        reason: 'abcd '.repeat(26),
        meta: { generation: 9, services: 1, failed: 1, rollout: true },
      }),
    ]);
    const call = (
      n: number,
      tool: string,
      outcome: string,
      readOnly: boolean,
      durationMs: number,
      principalId: string,
      client: { clientId: string; clientName?: string } | null
    ) => ({
      event: 'mcp.tool_call',
      principalKind: 'user',
      principalId,
      actorId: principalId,
      requestId: `${MARK}-${n}`,
      route: `MCP ${tool}`,
      outcome,
      createdAt: at(6, 9, n),
      meta: JSON.stringify({
        tool,
        stage: outcome === 'succeeded' ? 'success' : 'domain',
        readOnly,
        durationMs,
        ...(client ?? {}),
        username: principalId === 'sub-a' ? 'alice' : 'bob',
      }),
    });
    await knex('auth_audit_events').insert([
      call(1, 'get_environment', 'succeeded', true, 10, 'sub-a', {
        clientId: 'claude-desktop',
        clientName: 'Claude Desktop',
      }),
      call(2, 'get_environment', 'succeeded', true, 30, 'sub-a', {
        clientId: 'claude-desktop',
        clientName: 'Claude Desktop',
      }),
      call(3, 'get_environment', 'env_not_found', true, 20, 'sub-b', { clientId: 'cursor-1' }),
      call(4, 'deploy_environment', 'succeeded', false, 400, 'sub-b', { clientId: 'cursor-1' }),
      call(5, 'deploy_environment', 'forbidden_role', false, 5, 'sub-b', null),
      // a call without a user, outside the summary window, that recorded its target
      {
        event: 'mcp.tool_call',
        principalKind: 'token',
        principalId: null,
        actorId: null,
        requestId: `${MARK}-6`,
        route: 'MCP get_environment',
        outcome: 'succeeded',
        createdAt: at(14, 9, 6),
        meta: JSON.stringify({
          tool: 'get_environment',
          readOnly: true,
          durationMs: 15,
          uuid: 'env-uuid-1',
          environmentId: 42,
        }),
      },
    ]);
  });
  afterAll(async () => {
    await cleanup();
    if (builds?.[1]) await knex('builds').where({ id: builds[1].id }).update({ lastTornDownAt: tornDownBefore });
    await knex.destroy();
  });
  jest.setTimeout(60_000);

  it('resolves deploy requests through their runs', async () => {
    const service = new DeploymentAnalyticsService({ knex } as any);
    const result = await service.getSummary(
      parseDeploymentAnalyticsQuery(new URLSearchParams(`${WINDOW}&compare=false`))
    );
    const { timeToReady, queueWait, ...counts } = result.totals;
    expect(counts).toEqual({
      requested: 17,
      claimed: 11,
      succeeded: 7,
      failed: 2,
      superseded: 3,
      blocked: 1,
      tornDown: 3,
      unresolved: 1,
      successRate: 7 / 9,
    });
    expect(timeToReady.samples).toBe(6);
    expect(timeToReady.p50Minutes).toBeCloseTo(5, 9);
    expect(timeToReady.p90Minutes).toBeCloseTo(5.5, 9);
    const retriedRollout = await service.getSummary(
      parseDeploymentAnalyticsQuery(new URLSearchParams('from=2025-10-10&to=2025-10-11&timezone=UTC&compare=false'))
    );
    expect(retriedRollout.totals).toMatchObject({ requested: 1, succeeded: 1, failed: 0 });
    expect(retriedRollout.totals.timeToReady).toMatchObject({ samples: 1, p50Minutes: 3, p90Minutes: 3 });
    expect(retriedRollout.failureReasons.items).toEqual([]);
    expect(queueWait.samples).toBe(11);
    expect(queueWait.p50Minutes).toBeCloseTo(0.5, 9);
    expect(queueWait.p90Minutes).toBeCloseTo(1, 9);
    expect(new Date(result.collectionStartedAt!).getTime()).toBeLessThanOrEqual(new Date(at(5, 10, 0)).getTime());
    expect(
      result.buckets.filter((b) => b.requested > 0).map((b) => [b.date, b.requested, b.succeeded, b.failed])
    ).toEqual([
      ['2025-10-05', 3, 1, 0],
      ['2025-10-06', 3, 0, 1],
      ['2025-10-07', 4, 3, 1],
      ['2025-10-08', 4, 2, 0],
      ['2025-10-09', 2, 0, 0],
      ['2025-10-10', 1, 1, 0],
    ]);
    expect(result.origins).toEqual([
      { origin: 'push', requested: 7, succeeded: 5, failed: 1, successRate: 5 / 6 },
      { origin: 'label', requested: 5, succeeded: 1, failed: 0, successRate: 1 },
      { origin: 'redeploy', requested: 3, succeeded: 1, failed: 1, successRate: 0.5 },
      { origin: 'api', requested: 2, succeeded: 0, failed: 0, successRate: null },
    ]);
    expect(result.failureReasons).toEqual({
      items: [
        { reason: 'Build failed for service api-# (attempt #)', count: 1 },
        { reason: 'Lifecycle configuration failed validation: services must be a list', count: 1 },
      ],
      total: 2,
      limit: 10,
    });
    const byRepository = new Map(result.repositories.items.map((row) => [row.repositoryId, row]));
    const [one, two, three] = builds;
    const repoOfTwoAndThree = two.repositoryId === three.repositoryId ? two.repositoryId : null;
    if (repoOfTwoAndThree != null && one.repositoryId !== repoOfTwoAndThree) {
      expect(byRepository.get(repoOfTwoAndThree)).toMatchObject({ requested: 12, succeeded: 5, failed: 2 });
      expect(byRepository.get(repoOfTwoAndThree)?.timeToReadyP50Minutes).toBeCloseTo(5, 9);
      expect(byRepository.get(one.repositoryId)).toMatchObject({ requested: 5, succeeded: 2, failed: 0 });
    }
    const weekly = await service.getSummary(
      parseDeploymentAnalyticsQuery(new URLSearchParams('from=2025-07-01&to=2025-10-13&timezone=UTC&interval=week'))
    );
    expect(weekly.buckets.find((b) => b.date === '2025-10-06')).toMatchObject({
      requested: 14,
      succeeded: 6,
      failed: 2,
      previousRequested: 0,
    });
    expect(weekly.previousTotals?.requested).toBe(0);
    const requestsPerBuild = new Map([
      [one.id, 5],
      [two.id, 5],
      [three.id, 7],
    ]);
    const scoped = await service.getSummary(
      parseDeploymentAnalyticsQuery(new URLSearchParams(`${WINDOW}&repositoryId=${one.repositoryId}`))
    );
    expect(scoped.totals.requested).toBe(
      builds
        .filter((build) => build.repositoryId === one.repositoryId)
        .reduce((sum, build) => sum + (requestsPerBuild.get(build.id) ?? 0), 0)
    );
  });

  it('lists the requests behind every summary slice with the same facts', async () => {
    const service = new DeploymentAnalyticsService({ knex } as any);
    const base = `${WINDOW}&compare=false`;
    const summary = await service.getSummary(parseDeploymentAnalyticsQuery(new URLSearchParams(base)));
    const list = (query: string) =>
      service.getRequests(parseDeploymentRequestsQuery(new URLSearchParams(`${base}&${query}`)));
    const totalKeys = {
      succeeded: 'succeeded',
      failed: 'failed',
      superseded: 'superseded',
      blocked: 'blocked',
      torn_down: 'tornDown',
      unresolved: 'unresolved',
    } as const;
    expect((await list('')).pagination.total).toBe(summary.totals.requested);
    for (const outcome of DEPLOYMENT_OUTCOMES) {
      expect((await list(`outcome=${outcome}`)).pagination.total).toBe(summary.totals[totalKeys[outcome]]);
    }
    for (const row of summary.origins) {
      expect((await list(`origin=${row.origin}`)).pagination.total).toBe(row.requested);
      expect((await list(`origin=${row.origin}&outcome=succeeded`)).pagination.total).toBe(row.succeeded);
    }
    for (const bucket of summary.buckets.filter((b) => b.requested > 0)) {
      expect((await list(`date=${bucket.date}`)).pagination.total).toBe(bucket.requested);
      expect((await list(`date=${bucket.date}&outcome=failed`)).pagination.total).toBe(bucket.failed);
    }
    for (const item of summary.failureReasons.items) {
      expect((await list(`reason=${encodeURIComponent(item.reason)}`)).pagination.total).toBe(item.count);
    }
    const succeeded = await list('outcome=succeeded&sort=timeToReady&limit=100');
    expect(succeeded.records.filter((r) => r.timeToReadyMinutes != null)).toHaveLength(
      summary.totals.timeToReady.samples
    );
    expect(succeeded.records[0]).toMatchObject({ requestId: 'r8', timeToReadyMinutes: 6, readyAt: at(7, 12, 6) });
    expect(succeeded.records.at(-1)).toMatchObject({ requestId: 'r12', services: 0, timeToReadyMinutes: null });
    const failed = await list('outcome=failed');
    expect(failed.records.find((r) => r.requestId === 'r3')).toMatchObject({
      id: builds[1].id,
      origin: 'redeploy',
      period: 'current',
      outcome: 'failed',
      services: 2,
      failed: 1,
      reason: 'Build failed for service api-123 (attempt 2)',
      claimedAt: at(6, 11, 2),
      decidedAt: at(6, 11, 6),
      readyAt: null,
      queueWaitMinutes: 1,
      timeToReadyMinutes: null,
      exitReason: null,
      serviceOutcomes: [
        {
          name: 'api',
          type: 'docker',
          status: 'build_failed',
          outcome: 'failed',
          message: 'Build failed for service api-123 (attempt 2)',
        },
        { name: 'web', type: 'docker', status: 'ready', outcome: 'ready', message: null },
      ],
    });
    expect(failed.records.find((r) => r.requestId === 'r14')).toMatchObject({
      reason: 'Lifecycle configuration failed validation: services must be a list',
      decidedAt: at(7, 9, 1),
      services: null,
      serviceOutcomes: null,
    });
    const stopped = await list('outcome=torn_down,blocked,superseded&sort=requestedAt:asc');
    expect(stopped.records.map((r) => [r.requestId, r.outcome, r.exitReason])).toEqual([
      ['r6', 'superseded', 'rows_taken'],
      ['r17', 'torn_down', 'torn_down'],
      ['r2', 'superseded', 'intent_replaced'],
      ['r7', 'torn_down', 'failure_ignored'],
      ['r15', 'superseded', 'rows_taken'],
      ['r10', 'blocked', 'deploy_disabled'],
      ['r13', 'torn_down', null],
    ]);
    expect((await list('date=2025-10-10')).records[0]).toMatchObject({
      requestId: 'r9',
      outcome: 'succeeded',
      readyAt: at(10, 10, 3),
      decidedAt: at(10, 10, 9),
      timeToReadyMinutes: 3,
      queueWaitMinutes: 1,
    });
    const page = await list('limit=5&page=4');
    expect(page.pagination).toEqual({ page: 4, limit: 5, total: 17, hasMore: false });
    expect(page.records).toHaveLength(2);
    const compared = await service.getSummary(
      parseDeploymentAnalyticsQuery(new URLSearchParams('from=2025-10-13&to=2025-10-25&timezone=UTC'))
    );
    const previous = await service.getRequests(
      parseDeploymentRequestsQuery(new URLSearchParams('from=2025-10-13&to=2025-10-25&timezone=UTC&period=previous'))
    );
    expect(previous.pagination.total).toBe(compared.previousTotals!.requested);
    expect(previous.records.every((r) => r.period === 'previous')).toBe(true);
    const previousDay = await service.getRequests(
      parseDeploymentRequestsQuery(
        new URLSearchParams('from=2025-10-13&to=2025-10-25&timezone=UTC&period=previous&date=2025-10-19')
      )
    );
    expect(previousDay.pagination.total).toBe(compared.buckets.find((b) => b.date === '2025-10-19')!.previousRequested);
    expect(previousDay.pagination.total).toBe(4);
    const week = await service.getRequests(
      parseDeploymentRequestsQuery(
        new URLSearchParams('from=2025-07-01&to=2025-10-13&timezone=UTC&interval=week&date=2025-10-06')
      )
    );
    expect(week.pagination.total).toBe(14);
    await expect(
      service.getRequests(
        parseDeploymentRequestsQuery(
          new URLSearchParams('from=2025-07-01&to=2025-10-13&timezone=UTC&interval=week&date=2025-10-07')
        )
      )
    ).rejects.toThrow('date must be the start of a bucket inside the window.');
  });

  it('matches a grouped failure reason whose cut ends in a space', async () => {
    const service = new DeploymentAnalyticsService({ knex } as any);
    const window = 'from=2025-10-14&to=2025-10-15&timezone=UTC&compare=false';
    const summary = await service.getSummary(parseDeploymentAnalyticsQuery(new URLSearchParams(window)));
    expect(summary.failureReasons.items).toEqual([{ reason: 'abcd '.repeat(26).trimEnd().slice(0, 119), count: 1 }]);
    const [item] = summary.failureReasons.items;
    expect(item.reason.endsWith(' ')).toBe(false);
    const list = await service.getRequests(
      parseDeploymentRequestsQuery(new URLSearchParams(`${window}&reason=${encodeURIComponent(item.reason)}`))
    );
    expect(list.pagination.total).toBe(1);
    expect(list.records[0]).toMatchObject({ requestId: 'r18', reason: 'abcd '.repeat(26) });
  });

  it('lists the environment and PR records behind every evidence slice', async () => {
    const service = new EnvironmentAnalyticsService({ knex } as any);
    const today = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - 364 * 86_400_000).toISOString().slice(0, 10);
    const window = `from=${from}&to=${to}&timezone=UTC&compare=true&interval=week`;
    const summary = await service.getEnvironments(parseEnvironmentAnalyticsQuery(new URLSearchParams(window)));
    const records = (query: string) =>
      service.getRecords(parseEnvironmentAnalyticsRecordsQuery(new URLSearchParams(`${window}&${query}`)));
    const pullRequests = (query: string) =>
      service.getPullRequests(parseEnvironmentAnalyticsPullRequestsQuery(new URLSearchParams(`${window}&${query}`)));
    expect((await records('cohort=first_seen')).pagination.total).toBe(summary.totals.firstSeenEnvironments);
    expect((await records('cohort=first_seen&evidence=requested')).pagination.total).toBe(
      summary.totals.deployRequestedEnvironments
    );
    expect((await records('cohort=first_seen&evidence=rolled_out')).pagination.total).toBe(
      summary.totals.rolledOutEnvironments
    );
    expect((await records('cohort=first_seen&period=previous')).pagination.total).toBe(
      summary.previousTotals!.firstSeenEnvironments
    );
    for (const bucket of summary.buckets.filter((b) => b.firstSeenEnvironments > 0)) {
      expect((await records(`cohort=first_seen&date=${bucket.date}`)).pagination.total).toBe(
        bucket.firstSeenEnvironments
      );
    }
    expect((await pullRequests('')).pagination.total).toBe(summary.totals.observedPullRequests);
    expect((await pullRequests('evidence=requested')).pagination.total).toBe(
      summary.totals.pullRequestsWithDeployRequest
    );
    expect((await pullRequests('evidence=rolled_out')).pagination.total).toBe(summary.totals.pullRequestsDeployed);
    expect((await pullRequests('period=previous')).pagination.total).toBe(summary.previousTotals!.observedPullRequests);
    for (const bucket of summary.buckets.filter((b) => (b.observedPullRequests ?? 0) > 0)) {
      expect((await pullRequests(`date=${bucket.date}`)).pagination.total).toBe(bucket.observedPullRequests);
    }
    for (const bucket of summary.buckets.filter((b) => (b.previousObservedPullRequests ?? 0) > 0)) {
      expect((await pullRequests(`period=previous&date=${bucket.date}`)).pagination.total).toBe(
        bucket.previousObservedPullRequests
      );
    }
    for (const bucket of summary.buckets.filter((b) => (b.previousFirstSeenEnvironments ?? 0) > 0)) {
      expect((await records(`cohort=first_seen&period=previous&date=${bucket.date}`)).pagination.total).toBe(
        bucket.previousFirstSeenEnvironments
      );
    }
    const inventory = await service.getInventory(parseEnvironmentAnalyticsScope(new URLSearchParams()));
    const current = (query: string) => records(`cohort=current${query ? `&${query}` : ''}`);
    expect((await current('')).pagination.total).toBe(inventory.totals.current);
    expect((await current('evidence=requested')).pagination.total).toBe(inventory.totals.requested);
    expect((await current('evidence=rolled_out')).pagination.total).toBe(inventory.totals.rolledOut);
    expect((await current('evidence=live')).pagination.total).toBe(inventory.totals.live);
    expect((await current('evidence=ready')).pagination.total).toBe(inventory.totals.ready);
    expect((await current('evidence=never_requested')).pagination.total).toBe(
      inventory.totals.pullRequestsNeverRequested
    );
    expect((await current('phase=failed')).pagination.total).toBe(inventory.totals.failed);
  });

  it('lists the calls behind every MCP slice with the same facts', async () => {
    const service = new McpAnalyticsService({ knex } as any);
    const base = `${WINDOW}&compare=false`;
    const summary = await service.getSummary(parseMcpAnalyticsQuery(new URLSearchParams(base)));
    const list = (query: string) => service.getCalls(parseMcpCallsQuery(new URLSearchParams(`${base}&${query}`)));
    expect((await list('')).pagination.total).toBe(summary.totals.calls);
    expect((await list('outcome=succeeded')).pagination.total).toBe(summary.totals.calls - summary.totals.errors);
    expect((await list('outcome=error')).pagination.total).toBe(summary.totals.errors);
    for (const tool of summary.tools) {
      expect((await list(`tool=${tool.tool}`)).pagination.total).toBe(tool.calls);
      expect((await list(`tool=${tool.tool}&outcome=error`)).pagination.total).toBe(tool.errors);
    }
    for (const user of summary.users.items) {
      expect((await list(`userId=${user.userId}`)).pagination.total).toBe(user.calls);
    }
    for (const client of summary.clients) {
      expect((await list(`client=${encodeURIComponent(client.client)}`)).pagination.total).toBe(client.calls);
    }
    for (const error of summary.errors) {
      expect((await list(`outcome=${error.code}`)).pagination.total).toBe(error.calls);
    }
    expect((await list('date=2025-10-06')).pagination.total).toBe(5);
    expect((await list('date=2025-10-07')).pagination.total).toBe(0);
    const slow = await list('sort=durationMs');
    expect(slow.records.map((r) => [r.requestId, r.durationMs])).toEqual([
      [`${MARK}-4`, 400],
      [`${MARK}-2`, 30],
      [`${MARK}-3`, 20],
      [`${MARK}-1`, 10],
      [`${MARK}-5`, 5],
    ]);
    expect(slow.records[0]).toMatchObject({
      tool: 'deploy_environment',
      readOnly: false,
      outcome: 'succeeded',
      error: false,
      userId: 'sub-b',
      username: 'bob',
      client: 'Unregistered client',
      clientId: 'cursor-1',
      target: null,
      period: 'current',
      createdAt: at(6, 9, 4),
    });
    expect(slow.records[4]).toMatchObject({ client: 'Unknown client', clientId: null, error: true });
    const unknown = await service.getCalls(
      parseMcpCallsQuery(new URLSearchParams('from=2025-10-14&to=2025-10-15&timezone=UTC&compare=false&userId=unknown'))
    );
    expect(unknown.records).toEqual([
      expect.objectContaining({
        requestId: `${MARK}-6`,
        userId: null,
        username: null,
        client: 'Unknown client',
        target: { environmentUuid: 'env-uuid-1', environmentId: 42, siteId: null, deployId: null },
      }),
    ]);
  });

  it('aggregates MCP tool calls by tool, user and client application', async () => {
    const result = await new McpAnalyticsService({ knex } as any).getSummary(
      parseMcpAnalyticsQuery(new URLSearchParams(`${WINDOW}&compare=false`))
    );
    expect(result.totals).toEqual({
      calls: 5,
      errors: 2,
      errorRate: 0.4,
      users: 2,
      clients: 1,
      installations: 2,
      readOnlyCalls: 3,
      changeCalls: 2,
    });
    expect(result.tools).toEqual([
      {
        tool: 'get_environment',
        readOnly: true,
        calls: 3,
        errors: 1,
        errorRate: 1 / 3,
        p50DurationMs: 20,
        p95DurationMs: 29,
      },
      {
        tool: 'deploy_environment',
        readOnly: false,
        calls: 2,
        errors: 1,
        errorRate: 0.5,
        p50DurationMs: 202.5,
        p95DurationMs: 380.25,
      },
    ]);
    expect(result.users.items).toEqual([
      { userId: 'sub-b', username: 'bob', calls: 3, errors: 2, lastCallAt: at(6, 9, 5) },
      { userId: 'sub-a', username: 'alice', calls: 2, errors: 0, lastCallAt: at(6, 9, 2) },
    ]);
    expect(result.clients).toEqual([
      { client: 'Claude Desktop', installations: 1, calls: 2, users: 1, errors: 0, lastCallAt: at(6, 9, 2) },
      { client: 'Unregistered client', installations: 1, calls: 2, users: 1, errors: 1, lastCallAt: at(6, 9, 4) },
      { client: 'Unknown client', installations: 0, calls: 1, users: 1, errors: 1, lastCallAt: at(6, 9, 5) },
    ]);
    expect(result.errors).toEqual([
      { code: 'env_not_found', calls: 1 },
      { code: 'forbidden_role', calls: 1 },
    ]);
    expect(result.buckets.find((b) => b.date === '2025-10-06')).toMatchObject({ calls: 5, errors: 2, users: 2 });
    expect(result.auditSince).toBe(at(6, 9, 1));
    expect(result.allCallsSince).toBe(at(6, 9, 1));
  });
});
