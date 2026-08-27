/**
 * Copyright 2026 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { DatabaseClient } from '../databaseClient';

type RecordedCall = { method: string; args: any[] };

/** Query-builder spy recording calls; exposes ONLY read methods, so any write call throws (proves read-only). */
function createQueryBuilder(rows: any[], calls: RecordedCall[]) {
  const builder: any = {};
  const chain = (method: string) =>
    jest.fn((...args: any[]) => {
      calls.push({ method, args });
      return builder;
    });

  builder.where = chain('where');
  builder.whereIn = chain('whereIn');
  builder.select = chain('select');
  builder.orderBy = chain('orderBy');
  builder.withGraphFetched = chain('withGraphFetched');
  builder.limit = chain('limit');
  builder.offset = chain('offset');
  builder.resultSize = jest.fn(async () => rows.length);
  builder.then = (resolve: (value: any[]) => unknown) => Promise.resolve(rows).then(resolve);
  return builder;
}

function buildDb(rows: any[], calls: RecordedCall[]) {
  const query = jest.fn(() => createQueryBuilder(rows, calls));
  return {
    models: {
      Build: { query },
      Deploy: { query },
      Deployable: { query },
      PullRequest: { query },
      Repository: { query },
      Environment: { query },
    },
  };
}

const SCOPE = {
  buildId: 42,
  buildUuid: 'my-build-uuid',
  pullRequestId: 7,
  environmentId: 3,
  repositoryIds: [11, 12],
};

describe('DatabaseClient build scoping', () => {
  let calls: RecordedCall[];

  function makeClient(rows: any[] = [], scope: any = SCOPE) {
    calls = [];
    const client = new DatabaseClient(buildDb(rows, calls));
    client.setBuildScope(scope);
    return client;
  }

  it('rejects queries entirely when no build scope is configured', async () => {
    const client = new DatabaseClient(buildDb([], (calls = [])));
    await expect(client.queryTable({ table: 'builds' })).rejects.toThrow(/not scoped to a build/);
  });

  it('revokes database access when an existing build scope is cleared', async () => {
    const client = makeClient([]);
    client.setBuildScope(undefined);

    await expect(client.queryTable({ table: 'builds' })).rejects.toThrow(/not scoped to a build/);

    expect(calls).toEqual([]);
  });

  it('scopes builds queries to this build uuid (ANDed under model filters)', async () => {
    const client = makeClient([{ uuid: 'my-build-uuid', status: 'deployed' }]);
    await client.queryTable({ table: 'builds', filters: { status: 'deployed' } });

    // mandatory scope clause is applied
    expect(calls).toContainEqual({ method: 'where', args: ['uuid', 'my-build-uuid'] });
    // model filter is ANDed on top, never replaces the scope
    expect(calls).toContainEqual({ method: 'where', args: [{ status: 'deployed' }] });
  });

  it('scopes deploys to this build id', async () => {
    const client = makeClient([]);
    await client.queryTable({ table: 'deploys' });
    expect(calls).toContainEqual({ method: 'where', args: ['buildId', 42] });
  });

  it('scopes deployables and environments to the build resources', async () => {
    const client = makeClient([]);

    await client.queryTable({ table: 'deployables' });
    await client.queryTable({ table: 'environments' });

    expect(calls.filter((call) => call.method === 'where' && call.args[0] === 'buildId')).toHaveLength(2);
    expect(calls).toContainEqual({ method: 'where', args: ['buildId', 42] });
    expect(calls.filter((call) => call.method === 'where' && call.args[0] === 'id')).toHaveLength(2);
    expect(calls).toContainEqual({ method: 'where', args: ['id', 3] });
  });

  it('scopes repositories to the build repository ids via whereIn', async () => {
    const client = makeClient([]);
    await client.queryTable({ table: 'repositories' });
    expect(calls).toContainEqual({ method: 'whereIn', args: ['id', [11, 12]] });
  });

  it('scopes pull_requests to this build pull request id', async () => {
    const client = makeClient([]);
    await client.queryTable({ table: 'pull_requests' });
    expect(calls).toContainEqual({ method: 'where', args: ['id', 7] });
  });

  it('a model filter cannot widen the scope to another build', async () => {
    const client = makeClient([]);
    await client.queryTable({ table: 'builds', filters: { uuid: 'someone-elses-build' } });
    // Build scope is still ANDed, so a foreign uuid can only ever return zero rows.
    expect(calls).toContainEqual({ method: 'where', args: ['uuid', 'my-build-uuid'] });
    expect(calls).toContainEqual({ method: 'where', args: [{ uuid: 'someone-elses-build' }] });
  });

  it('rejects pull_requests when the build has no pull request', async () => {
    calls = [];
    const client = new DatabaseClient(buildDb([], calls));
    client.setBuildScope({ ...SCOPE, pullRequestId: null });
    await expect(client.queryTable({ table: 'pull_requests' })).rejects.toThrow(/no associated pull request/);
  });

  it.each([
    { repositoryIds: undefined, label: 'unresolved' },
    { repositoryIds: [], label: 'empty' },
  ])('rejects repositories when the build repository scope is $label', async ({ repositoryIds }) => {
    const client = makeClient([], { ...SCOPE, repositoryIds });

    await expect(client.queryTable({ table: 'repositories' })).rejects.toThrow(/no associated repositories/);

    expect(calls).toEqual([]);
  });

  it('rejects environments when the build has no associated environment', async () => {
    const client = makeClient([], { ...SCOPE, environmentId: null });

    await expect(client.queryTable({ table: 'environments' })).rejects.toThrow(/no associated environment/);

    expect(calls).toEqual([]);
  });

  it('rejects wildcard-only LIKE patterns that would dump all rows', async () => {
    const client = makeClient([]);
    await expect(client.queryTable({ table: 'deploys', filters: { uuid: '%' } })).rejects.toThrow(
      /wildcard-only pattern/
    );
    await expect(client.queryTable({ table: 'deploys', filters: { uuid: '%%' } })).rejects.toThrow(
      /wildcard-only pattern/
    );
    await expect(client.queryTable({ table: 'deploys', filters: { uuid: '__' } })).rejects.toThrow(
      /wildcard-only pattern/
    );
  });

  it('still allows a specific LIKE pattern within the build scope', async () => {
    const client = makeClient([]);
    await client.queryTable({ table: 'deploys', filters: { uuid: 'sample-service-%' } });
    expect(calls).toContainEqual({ method: 'where', args: ['buildId', 42] });
    expect(calls).toContainEqual({ method: 'where', args: ['uuid', 'like', 'sample-service-%'] });
  });

  it('surfaces unknown selected columns as a warning instead of silently dropping them', async () => {
    const client = makeClient([{ uuid: 'my-build-uuid' }]);
    const result = await client.queryTable({ table: 'builds', select: ['uuid', 'not_a_real_column'] });
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.[0]).toContain('not_a_real_column');
    // valid columns are still selected
    expect(calls.some((c) => c.method === 'select')).toBe(true);
  });

  it('normalizes and deduplicates selected aliases while applying bounded pagination and default ordering', async () => {
    const client = makeClient([{ uuid: 'my-build-uuid' }]);

    const result = await client.queryTable({
      table: 'builds',
      select: ['createdAt', 'created_at', 'uuid'],
      orderBy: 'created_at',
      limit: 500,
      offset: 10,
    });

    expect(result.warnings).toBeUndefined();
    expect(calls).toContainEqual({ method: 'select', args: [['createdAt', 'uuid']] });
    expect(calls).toContainEqual({ method: 'orderBy', args: ['createdAt', 'asc'] });
    expect(calls).toContainEqual({ method: 'limit', args: [100] });
    expect(calls).toContainEqual({ method: 'offset', args: [10] });
  });

  it('supports the positional query form without weakening scope or relation validation', async () => {
    const client = makeClient([]);

    await client.queryTable('builds', { status: 'deployed' }, ['pullRequest'], 5);

    expect(calls).toContainEqual({ method: 'where', args: ['uuid', 'my-build-uuid'] });
    expect(calls).toContainEqual({ method: 'where', args: [{ status: 'deployed' }] });
    expect(calls).toContainEqual({ method: 'withGraphFetched', args: ['[pullRequest]'] });
    expect(calls).toContainEqual({ method: 'limit', args: [5] });
  });

  it('compacts allowed array and object relations without mutating null relations', async () => {
    const client = makeClient([
      {
        uuid: 'my-build-uuid',
        status: 'deployed',
        deploys: [
          { uuid: 'deploy-1', status: 'ready', secret: 'not returned' },
          { id: 2, name: 'API', secret: 'not returned' },
        ],
        pullRequest: { id: 7, status: 'open', title: 'Sample PR' },
        environment: null,
      },
    ]);

    const result = await client.queryTable({
      table: 'builds',
      relations: ['deploys.repository', 'deploys', 'pullRequest', 'environment'],
    });

    expect(calls).toContainEqual({
      method: 'withGraphFetched',
      args: ['[deploys, pullRequest, environment]'],
    });
    expect(result.records).toEqual([
      {
        uuid: 'my-build-uuid',
        status: 'deployed',
        deploys: [
          { id: 'deploy-1', name: 'ready' },
          { id: 2, name: 'API' },
        ],
        pullRequest: { id: 7, name: 'open' },
        environment: null,
      },
    ]);
  });

  it('rejects a valid table when its backing model is unavailable before constructing a query', async () => {
    const client = new DatabaseClient({ models: {} });
    client.setBuildScope(SCOPE);

    await expect(client.queryTable({ table: 'builds' })).rejects.toThrow("Model 'Build' not found");
  });

  it('rejects tables not allowed', async () => {
    const client = makeClient([]);
    await expect(client.queryTable({ table: 'users' as any })).rejects.toThrow(/not allowed/);
  });

  it('returns an empty schema for unknown diagnostic table names', () => {
    const client = makeClient([]);

    expect(client.getTableSchema('unknown_table')).toEqual({ columns: [], relations: {} });
    expect(calls).toEqual([]);
  });

  it('exposes no write methods on the query builder (read-only)', () => {
    const builder = createQueryBuilder([], []);
    expect((builder as any).insert).toBeUndefined();
    expect((builder as any).update).toBeUndefined();
    expect((builder as any).delete).toBeUndefined();
    expect((builder as any).patch).toBeUndefined();
  });
});
