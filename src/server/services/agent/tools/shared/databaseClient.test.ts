import { DatabaseClient } from './databaseClient';

function createQuery(records: any[] = []) {
  return {
    where: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    withGraphFetched: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    resultSize: jest.fn().mockResolvedValue(records.length),
    then: (resolve: (records: any[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(records).then(resolve, reject),
  };
}

function createClientWithQueries(...queries: ReturnType<typeof createQuery>[]) {
  const query = jest.fn(() => {
    const next = queries.shift();
    if (!next) {
      throw new Error('Unexpected query call');
    }
    return next;
  });

  return {
    client: new DatabaseClient({
      models: {
        Build: { query },
        PullRequest: { query },
      },
    }),
    query,
  };
}

describe('DatabaseClient diagnostic schema', () => {
  it('uses actual pull request and build columns exposed by the models', () => {
    const client = new DatabaseClient({ models: {} });

    expect(client.getTableSchema('pull_requests').columns).toEqual(
      expect.arrayContaining(['pullRequestNumber', 'branchName', 'fullName'])
    );
    expect(client.getTableSchema('pull_requests').columns).not.toContain('number');
    expect(client.getTableSchema('pull_requests').relations).toHaveProperty('build');
    expect(client.getTableSchema('pull_requests').relations).not.toHaveProperty('builds');

    expect(client.getTableSchema('builds').columns).toEqual(
      expect.arrayContaining(['id', 'uuid', 'pullRequestId', 'statusMessage'])
    );
  });

  it('normalizes common diagnostic aliases before querying', async () => {
    const records = [{ id: 1, uuid: 'sample-build' }];
    const countQuery = createQuery(records);
    const dataQuery = createQuery(records);
    const { client } = createClientWithQueries(dataQuery, countQuery);

    await client.queryTable({
      table: 'builds',
      filters: { pull_request_id: 11 },
      orderBy: 'created_at:desc',
      relations: ['pullRequest'],
    });

    expect(dataQuery.where).toHaveBeenCalledWith({ pullRequestId: 11 });
    expect(countQuery.where).toHaveBeenCalledWith({ pullRequestId: 11 });
    expect(dataQuery.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(dataQuery.withGraphFetched).toHaveBeenCalledWith('[pullRequest]');
  });

  it('rejects invalid relations before Objection throws opaque relation errors', async () => {
    const countQuery = createQuery([]);
    const dataQuery = createQuery([]);
    const { client } = createClientWithQueries(dataQuery, countQuery);

    await expect(
      client.queryTable({
        table: 'pull_requests',
        filters: { pullRequestNumber: 730 },
        relations: ['builds'],
      })
    ).rejects.toThrow('Invalid relations: builds. Valid relations for pull_requests: repository, build');
  });

  it('rejects invalid filters even when other filter columns are valid', async () => {
    const countQuery = createQuery([]);
    const dataQuery = createQuery([]);
    const { client } = createClientWithQueries(dataQuery, countQuery);

    await expect(
      client.queryTable({
        table: 'builds',
        filters: {
          uuid: 'sample-build',
          unknownColumn: 'ignored would broaden the query',
        },
      })
    ).rejects.toThrow('Invalid filter columns: unknownColumn.');

    expect(dataQuery.where).toHaveBeenCalledWith({ uuid: 'sample-build' });
    expect(countQuery.resultSize).not.toHaveBeenCalled();
  });
});
