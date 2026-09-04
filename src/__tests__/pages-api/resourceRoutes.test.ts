import { request, response } from 'src/test-utils/pagesApi';

type Query = Record<string, jest.Mock> & PromiseLike<unknown>;

function queryResult<T>(value: T): Query {
  const query = {} as Query;
  for (const method of [
    'select',
    'where',
    'whereNotIn',
    'whereNotNull',
    'whereIn',
    'orderBy',
    'distinct',
    'findById',
    'findOne',
    'withGraphFetched',
    'offset',
    'limit',
    'countDistinct',
  ]) {
    query[method] = jest.fn(() => query);
  }
  query.resultSize = jest.fn().mockResolvedValue(Array.isArray(value) ? value.length : 0);
  query.first = jest.fn().mockResolvedValue(value);
  query.then = jest.fn((resolve, reject) => Promise.resolve(value).then(resolve, reject));
  return query;
}

const mockBuildQuery = jest.fn();
const mockDeployQuery = jest.fn();
const mockDeployableQuery = jest.fn();
const mockPullRequestQuery = jest.fn();
const mockRaw = jest.fn();
const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
};

const mockBuildService = {
  db: {
    models: {
      Build: { query: (...args: unknown[]) => mockBuildQuery(...args) },
      Deploy: { query: (...args: unknown[]) => mockDeployQuery(...args) },
      Deployable: { query: (...args: unknown[]) => mockDeployableQuery(...args) },
    },
    knex: { raw: (...args: unknown[]) => mockRaw(...args) },
  },
};

const mockPullRequestService = {
  db: {
    models: {
      PullRequest: { query: (...args: unknown[]) => mockPullRequestQuery(...args) },
    },
  },
};

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn(() => mockBuildService),
}));

jest.mock('server/services/pullRequest', () => ({
  __esModule: true,
  default: jest.fn(() => mockPullRequestService),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => mockLogger,
}));

import buildsHandler from 'src/pages/api/v1/builds';
import deploySummaryHandler from 'src/pages/api/v1/deploy-summary';
import deployablesHandler from 'src/pages/api/v1/deployables';
import deploysHandler from 'src/pages/api/v1/deploys';
import pullRequestBuildsHandler from 'src/pages/api/v1/pull-requests/[id]/builds';
import pullRequestHandler from 'src/pages/api/v1/pull-requests/[id]';
import pullRequestsHandler from 'src/pages/api/v1/pull-requests';
import reposHandler from 'src/pages/api/v1/repos';
import usersHandler from 'src/pages/api/v1/users';

describe('legacy read-only resource routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe.each([
    ['deploy summary', deploySummaryHandler],
    ['deployables', deployablesHandler],
    ['deploys', deploysHandler],
  ])('GET /%s', (_name, handler) => {
    it('rejects unsupported methods before creating a service', async () => {
      const res = response();
      await handler(request({ method: 'POST' }), res);
      expect(res.statusCode).toBe(405);
      expect(mockBuildQuery).not.toHaveBeenCalled();
    });

    it.each([
      [{}, 'Invalid build ID'],
      [{ buildId: ['1'] }, 'Invalid build ID'],
      [{ buildId: 'not-a-number' }, 'Invalid build ID'],
    ])('validates buildId: %j', async (query, error) => {
      const res = response();
      await handler(request({ query }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error });
      expect(mockBuildQuery).not.toHaveBeenCalled();
    });
  });

  describe('GET /deploy-summary', () => {
    it('returns 404 without issuing the summary SQL when the build is absent', async () => {
      mockBuildQuery.mockReturnValue(queryResult(undefined));
      const res = response();
      await deploySummaryHandler(request({ query: { buildId: '42' } }), res);
      expect(res.statusCode).toBe(404);
      expect(mockRaw).not.toHaveBeenCalled();
    });

    it('queries the summary view with the parsed build ID', async () => {
      mockBuildQuery.mockReturnValue(queryResult({ id: 42 }));
      mockRaw.mockResolvedValue({ rows: [{ name: 'api', status: 'ready' }] });
      const res = response();
      await deploySummaryHandler(request({ query: { buildId: '42' } }), res);
      expect(mockRaw).toHaveBeenCalledWith(expect.stringContaining('FROM "deploySummary"'), [42]);
      expect(res.body).toEqual([{ name: 'api', status: 'ready' }]);
    });

    it('returns a stable 500 response on query failure', async () => {
      mockBuildQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await deploySummaryHandler(request({ query: { buildId: '42' } }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'An unexpected error occurred' });
    });
  });

  describe('GET /deployables', () => {
    it('returns 404 before querying deployables when the build is absent', async () => {
      mockBuildQuery.mockReturnValue(queryResult(undefined));
      const res = response();
      await deployablesHandler(request({ query: { buildId: '42' } }), res);
      expect(res.statusCode).toBe(404);
      expect(mockDeployableQuery).not.toHaveBeenCalled();
    });

    it.each([
      [{ buildId: '42', name: 'api' }, true],
      [{ buildId: '42' }, false],
      [{ buildId: '42', name: ['api'] }, false],
    ])('returns deployables and conditionally filters a string name: %j', async (params, filtered) => {
      const buildQuery = queryResult({ id: 42 });
      const deployableQuery = queryResult([{ id: 7, name: 'api' }]);
      mockBuildQuery.mockReturnValue(buildQuery);
      mockDeployableQuery.mockReturnValue(deployableQuery);
      const res = response();
      await deployablesHandler(request({ query: params }), res);
      expect(deployableQuery.where).toHaveBeenCalledWith('buildId', 42);
      if (filtered) expect(deployableQuery.where).toHaveBeenCalledWith('name', 'api');
      else expect(deployableQuery.where).not.toHaveBeenCalledWith('name', expect.anything());
      expect(res.body).toEqual([{ id: 7, name: 'api' }]);
    });

    it('returns a stable 500 response on query failure', async () => {
      mockBuildQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await deployablesHandler(request({ query: { buildId: '42' } }), res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('GET /deploys', () => {
    it.each([
      { buildId: '42', deployableId: ['7'] },
      { buildId: '42', deployableId: 'invalid' },
    ])('rejects an invalid deployableId: %j', async (query) => {
      const res = response();
      await deploysHandler(request({ query }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid deployable ID' });
    });

    it('returns 404 before querying deploys when the build is absent', async () => {
      mockBuildQuery.mockReturnValue(queryResult(undefined));
      const res = response();
      await deploysHandler(request({ query: { buildId: '42' } }), res);
      expect(res.statusCode).toBe(404);
      expect(mockDeployQuery).not.toHaveBeenCalled();
    });

    it.each([
      [{ buildId: '42', deployableId: '7' }, true],
      [{ buildId: '42' }, false],
      [{ buildId: '42', deployableId: '0' }, false],
    ])('returns deploys and follows the current truthy parsed-ID filter: %j', async (params, filtered) => {
      mockBuildQuery.mockReturnValue(queryResult({ id: 42 }));
      const deployQuery = queryResult([{ id: 8, deployableId: 7 }]);
      mockDeployQuery.mockReturnValue(deployQuery);
      const res = response();
      await deploysHandler(request({ query: params }), res);
      expect(deployQuery.where).toHaveBeenCalledWith('buildId', 42);
      if (filtered) expect(deployQuery.where).toHaveBeenCalledWith('deployableId', 7);
      else expect(deployQuery.where).not.toHaveBeenCalledWith('deployableId', expect.anything());
      expect(res.body).toEqual([{ id: 8, deployableId: 7 }]);
    });

    it('returns a stable 500 response on query failure', async () => {
      mockBuildQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await deploysHandler(request({ query: { buildId: '42' } }), res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe.each([
    ['pull request', pullRequestHandler],
    ['pull request builds', pullRequestBuildsHandler],
  ])('GET /%s/:id', (_name, handler) => {
    it('rejects methods and malformed IDs before querying', async () => {
      const methodRes = response();
      await handler(request({ method: 'POST' }), methodRes);
      expect(methodRes.statusCode).toBe(405);

      for (const id of [undefined, ['1'], 'invalid']) {
        const res = response();
        await handler(request({ query: id === undefined ? {} : { id } }), res);
        expect(res.statusCode).toBe(400);
      }
      expect(mockPullRequestQuery).not.toHaveBeenCalled();
    });

    it('returns 404 when the pull request does not exist', async () => {
      mockPullRequestQuery.mockReturnValue(queryResult(undefined));
      const res = response();
      await handler(request({ query: { id: '17' } }), res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Pull request not found' });
    });

    it('maps lookup errors to the stable 500 response', async () => {
      mockPullRequestQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await handler(request({ query: { id: '17' } }), res);
      expect(res.statusCode).toBe(500);
    });
  });

  it('returns a pull request by parsed database ID', async () => {
    const pullRequest = { id: 17, fullName: 'goodrx/lifecycle' };
    const query = queryResult(pullRequest);
    mockPullRequestQuery.mockReturnValue(query);
    const res = response();
    await pullRequestHandler(request({ query: { id: '17' } }), res);
    expect(query.findById).toHaveBeenCalledWith(17);
    expect(res.body).toEqual(pullRequest);
  });

  it('returns builds for an existing pull request', async () => {
    mockPullRequestQuery.mockReturnValue(queryResult({ id: 17 }));
    const builds = [{ id: 1, pullRequestId: 17 }];
    const buildQuery = queryResult(builds);
    mockBuildQuery.mockReturnValue(buildQuery);
    const res = response();
    await pullRequestBuildsHandler(request({ query: { id: '17' } }), res);
    expect(buildQuery.where).toHaveBeenCalledWith('pullRequestId', 17);
    expect(res.body).toEqual(builds);
  });

  describe('GET /builds', () => {
    it('rejects unsupported methods', async () => {
      const res = response();
      await buildsHandler(request({ method: 'POST' }), res);
      expect(res.statusCode).toBe(405);
    });

    it.each([
      [{}, ['torn_down', 'pending']],
      [{ exclude: '["failed",7]' }, ['failed']],
      [{ exclude: 'ready' }, ['ready']],
      [{ exclude: '"ready"' }, ['torn_down', 'pending']],
    ])('normalizes exclusion formats and returns all builds: %j', async (queryParams, exclusions) => {
      const builds = [{ uuid: 'build-1', status: 'ready' }];
      const query = queryResult(builds);
      mockBuildQuery.mockReturnValue(query);
      const res = response();
      await buildsHandler(request({ query: queryParams }), res);
      expect(query.whereNotIn).toHaveBeenCalledWith('status', exclusions);
      expect(res.body).toEqual({
        builds,
        metadata: { currentPage: 1, totalPages: 1, total: 1, limit: 1 },
      });
    });

    it.each([
      [{ page: '2', limit: '5' }, { currentPage: 2, totalPages: 3, total: 12, limit: 5 }, 5],
      [{ page: 'bad', limit: '0' }, { currentPage: 1, totalPages: 1, total: 12, limit: 20 }, 0],
    ])('paginates with bounded numeric parameters: %j', async (queryParams, metadata, expectedOffset) => {
      const builds = [{ uuid: 'build-1', status: 'ready' }];
      const query = queryResult(builds);
      query.resultSize.mockResolvedValue(12);
      mockBuildQuery.mockReturnValue(query);
      const res = response();
      await buildsHandler(request({ query: queryParams }), res);
      expect(query.offset).toHaveBeenCalledWith(expectedOffset);
      expect(query.limit).toHaveBeenCalledWith(metadata.limit);
      expect(res.body).toEqual({ builds, metadata });
    });

    it('maps query failures to the stable 500 response', async () => {
      mockBuildQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await buildsHandler(request(), res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('GET /pull-requests', () => {
    it('rejects unsupported methods before querying', async () => {
      const res = response();
      await pullRequestsHandler(request({ method: 'POST' }), res);
      expect(res.statusCode).toBe(405);
      expect(mockPullRequestQuery).not.toHaveBeenCalled();
    });

    it.each([
      [{}, undefined],
      [{ exclude: '["closed",1]' }, ['closed']],
      [{ exclude: 'closed' }, ['closed']],
      [{ exclude: '"closed"' }, ['"closed"']],
    ])('normalizes filters and paginates: %j', async (params, exclusions) => {
      const rows = [{ id: 1, githubLogin: 'octocat' }];
      const query = queryResult(rows);
      query.resultSize.mockResolvedValue(26);
      mockPullRequestQuery.mockReturnValue(query);
      const res = response();
      await pullRequestsHandler(
        request({ query: { user: 'octocat', repo: 'goodrx/lifecycle', page: '2', limit: '25', ...params } }),
        res
      );
      expect(query.where).toHaveBeenCalledWith('githubLogin', 'octocat');
      expect(query.where).toHaveBeenCalledWith('fullName', 'goodrx/lifecycle');
      if (exclusions?.length) expect(query.whereNotIn).toHaveBeenCalledWith('status', exclusions);
      else expect(query.whereNotIn).not.toHaveBeenCalled();
      expect(res.body).toEqual({
        pull_requests: rows,
        metadata: { currentPage: 2, totalPages: 2, total: 26, limit: 25 },
      });
    });

    it('ignores non-string user/repo and defaults malformed pagination', async () => {
      const rows: unknown[] = [];
      const query = queryResult(rows);
      mockPullRequestQuery.mockReturnValue(query);
      const res = response();
      await pullRequestsHandler(
        request({ query: { user: ['octocat'], repo: ['repo'], page: 'bad', limit: '0' } }),
        res
      );
      expect(query.where).not.toHaveBeenCalled();
      expect(query.offset).toHaveBeenCalledWith(0);
      expect(query.limit).toHaveBeenCalledWith(25);
    });

    it('maps query failures to the stable 500 response', async () => {
      mockPullRequestQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await pullRequestsHandler(request(), res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe.each([
    ['repos', reposHandler, 'fullName', 'repos'],
    ['users', usersHandler, 'githubLogin', 'users'],
  ])('GET /%s', (_route, handler, field, responseKey) => {
    it('rejects unsupported methods', async () => {
      const res = response();
      await handler(request({ method: 'POST' }), res);
      expect(res.statusCode).toBe(405);
    });

    it('returns all distinct values without a pagination query', async () => {
      const base = queryResult([{ [field]: 'one' }, { [field]: 'two' }]);
      mockPullRequestQuery.mockReturnValue(base);
      const res = response();
      await handler(request(), res);
      expect(res.body).toEqual({
        [responseKey]: ['one', 'two'],
        metadata: { currentPage: 1, totalPages: 1, total: 2, limit: 2 },
      });
      expect(mockPullRequestQuery).toHaveBeenCalledTimes(1);
    });

    it.each([
      [{ page: '2', limit: '2' }, { currentPage: 2, totalPages: 3, total: 5, limit: 2 }, 2],
      [{ page: 'bad', limit: '0' }, { currentPage: 1, totalPages: 0, total: 0, limit: 20 }, 0],
    ])('returns a distinct page and count: %j', async (params, metadata, expectedOffset) => {
      const base = queryResult([{ [field]: 'one' }]);
      const count = queryResult(metadata.total ? { count: String(metadata.total) } : undefined);
      mockPullRequestQuery.mockReturnValueOnce(base).mockReturnValueOnce(count);
      const res = response();
      await handler(request({ query: params }), res);
      expect(base.offset).toHaveBeenCalledWith(expectedOffset);
      expect(base.limit).toHaveBeenCalledWith(metadata.limit);
      expect(res.body).toEqual({ [responseKey]: ['one'], metadata });
    });

    it('maps query failures to the stable 500 response', async () => {
      mockPullRequestQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await handler(request(), res);
      expect(res.statusCode).toBe(500);
    });
  });
});
