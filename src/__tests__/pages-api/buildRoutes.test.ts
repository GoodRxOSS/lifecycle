import { request, response } from 'src/test-utils/pagesApi';

type Query = Record<string, jest.Mock> & PromiseLike<unknown>;

function queryResult<T>(value: T): Query {
  const query = {} as Query;
  for (const method of [
    'select',
    'where',
    'whereNotIn',
    'whereIn',
    'findById',
    'findOne',
    'withGraphFetched',
    'offset',
    'limit',
    'orderBy',
    'patch',
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
const mockGithubBuildQuery = jest.fn();
const mockWebhookBuildQuery = jest.fn();
const mockInvocationQuery = jest.fn();
const mockEnqueueBuild = jest.fn();
const mockValidateUuid = jest.fn();
const mockUpdateBuildUuid = jest.fn();
const mockValidateUuidFormat = jest.fn();
const mockGenerateGraph = jest.fn();
const mockWebhookQueueAdd = jest.fn();
const mockNanoid = jest.fn(() => 'fixed-id');
const mockWithLogContext = jest.fn((_context: unknown, callback: () => unknown) => callback());
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
};

const mockBuildService = {
  db: {
    models: {
      Build: { query: (...args: unknown[]) => mockBuildQuery(...args) },
      Deploy: { query: (...args: unknown[]) => mockDeployQuery(...args) },
    },
  },
  enqueueResolveAndDeployBuild: (...args: unknown[]) => mockEnqueueBuild(...args),
};

const mockOverrideService = {
  db: { models: { Build: { query: (...args: unknown[]) => mockBuildQuery(...args) } } },
  validateUuid: (...args: unknown[]) => mockValidateUuid(...args),
  updateBuildUuid: (...args: unknown[]) => mockUpdateBuildUuid(...args),
};

const mockGithubService = {
  db: { models: { Build: { query: (...args: unknown[]) => mockGithubBuildQuery(...args) } } },
};

const mockWebhookService = {
  db: {
    models: {
      Build: { query: (...args: unknown[]) => mockWebhookBuildQuery(...args) },
      WebhookInvocations: { query: (...args: unknown[]) => mockInvocationQuery(...args) },
    },
  },
  webhookQueue: { add: (...args: unknown[]) => mockWebhookQueueAdd(...args) },
};

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn(() => mockBuildService),
}));

jest.mock('server/services/override', () => ({
  __esModule: true,
  default: jest.fn(() => mockOverrideService),
  BuildUuidValidationError: class BuildUuidValidationError extends Error {},
}));

jest.mock('server/services/github', () => ({
  __esModule: true,
  default: jest.fn(() => mockGithubService),
}));

jest.mock('server/services/webhook', () => ({
  __esModule: true,
  default: jest.fn(() => mockWebhookService),
}));

jest.mock('server/lib/validation/buildUuidValidator', () => ({
  validateBuildUuidFormat: (...args: unknown[]) => mockValidateUuidFormat(...args),
}));

jest.mock('server/lib/dependencyGraph', () => ({
  generateGraph: (...args: unknown[]) => mockGenerateGraph(...args),
}));

jest.mock('server/lib/logger', () => ({
  withLogContext: (...args: unknown[]) => mockWithLogContext(...(args as [unknown, () => unknown])),
  getLogger: () => mockLogger,
  LogStage: {
    BUILD_QUEUED: 'build-queued',
    BUILD_FAILED: 'build-failed',
    WEBHOOK_PROCESSING: 'webhook-processing',
  },
}));

jest.mock('nanoid', () => ({ nanoid: () => mockNanoid() }));

import buildsHandler from 'src/pages/api/v1/builds';
import deployHandler from 'src/pages/api/v1/builds/[uuid]/deploy';
import graphHandler from 'src/pages/api/v1/builds/[uuid]/graph';
import buildHandler from 'src/pages/api/v1/builds/[uuid]';
import serviceBuildHandler from 'src/pages/api/v1/builds/[uuid]/services/[name]/build';
import torndownHandler from 'src/pages/api/v1/builds/[uuid]/torndown';
import webhooksHandler from 'src/pages/api/v1/builds/[uuid]/webhooks';
import { BuildUuidValidationError } from 'server/services/override';

describe('legacy build action routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithLogContext.mockImplementation((_context: unknown, callback: () => unknown) => callback());
    mockValidateUuidFormat.mockReturnValue(undefined);
    mockValidateUuid.mockResolvedValue({ valid: true });
    mockUpdateBuildUuid.mockResolvedValue({ build: { id: 1, uuid: 'new-uuid' } });
    mockEnqueueBuild.mockResolvedValue(undefined);
    mockGenerateGraph.mockResolvedValue({ nodes: ['api'] });
    mockWebhookQueueAdd.mockResolvedValue({ id: 'job-1' });
  });

  describe('GET /builds', () => {
    it('rejects unsupported methods before querying', async () => {
      const res = response();
      await buildsHandler(request({ method: 'POST' }), res);
      expect(res.statusCode).toBe(405);
      expect(mockBuildQuery).not.toHaveBeenCalled();
    });

    it.each([
      [{}, ['torn_down', 'pending']],
      [{ exclude: '["failed",7]' }, ['failed']],
      [{ exclude: 'ready' }, ['ready']],
      [{ exclude: '"ready"' }, ['torn_down', 'pending']],
    ])('normalizes exclusions and returns unpaginated results: %j', async (params, excluded) => {
      const builds = [{ uuid: 'build-1', status: 'ready' }];
      const query = queryResult(builds);
      mockBuildQuery.mockReturnValue(query);
      const res = response();
      await buildsHandler(request({ query: params }), res);
      expect(query.whereNotIn).toHaveBeenCalledWith('status', excluded);
      expect(res.body).toEqual({
        builds,
        metadata: { currentPage: 1, totalPages: 1, total: 1, limit: 1 },
      });
    });

    it.each([
      [{ page: '2', limit: '5' }, { currentPage: 2, totalPages: 3, total: 12, limit: 5 }, 5],
      [{ page: 'bad', limit: '0' }, { currentPage: 1, totalPages: 1, total: 12, limit: 20 }, 0],
    ])('paginates using current defaults and lower bounds: %j', async (params, metadata, offset) => {
      const builds = [{ uuid: 'build-1', status: 'ready' }];
      const query = queryResult(builds);
      query.resultSize.mockResolvedValue(12);
      mockBuildQuery.mockReturnValue(query);
      const res = response();
      await buildsHandler(request({ query: params }), res);
      expect(query.offset).toHaveBeenCalledWith(offset);
      expect(query.limit).toHaveBeenCalledWith(metadata.limit);
      expect(res.body).toEqual({ builds, metadata });
    });

    it('returns the stable 500 response on query failure', async () => {
      mockBuildQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await buildsHandler(request(), res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('/builds/:uuid', () => {
    it.each([{}, { uuid: ['build-1'] }])('rejects an invalid path UUID: %j', async (query) => {
      const res = response();
      await buildHandler(request({ query }), res);
      expect(res.statusCode).toBe(400);
      expect(mockBuildQuery).not.toHaveBeenCalled();
    });

    it('rejects unsupported methods for a valid UUID', async () => {
      const res = response();
      await buildHandler(request({ method: 'DELETE', query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(405);
    });

    it('returns a selected build or 404 when absent', async () => {
      const build = { id: 1, uuid: 'build-1', status: 'ready' };
      const foundQuery = queryResult(build);
      mockBuildQuery.mockReturnValueOnce(foundQuery).mockReturnValueOnce(queryResult(undefined));

      const found = response();
      await buildHandler(request({ query: { uuid: 'build-1' } }), found);
      expect(foundQuery.findOne).toHaveBeenCalledWith({ uuid: 'build-1' });
      expect(found.body).toEqual(build);

      const missing = response();
      await buildHandler(request({ query: { uuid: 'missing' } }), missing);
      expect(missing.statusCode).toBe(404);
    });

    it('maps GET query failures to the stable 500 response', async () => {
      mockBuildQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await buildHandler(request({ query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(500);
    });

    it.each([
      [{}, { error: 'uuid is required' }],
      [{ uuid: null }, { error: 'uuid is required' }],
      [{ uuid: 7 }, { error: 'uuid must be a string' }],
    ])('validates PATCH body before creating OverrideService: %j', async (body, expectedBody) => {
      const res = response();
      await buildHandler(request({ method: 'PATCH', query: { uuid: 'build-1' }, body }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(expectedBody);
      expect(mockBuildQuery).not.toHaveBeenCalled();
    });

    it('returns the UUID format validator message', async () => {
      mockValidateUuidFormat.mockReturnValueOnce('UUID format is invalid');
      const res = response();
      await buildHandler(request({ method: 'PATCH', query: { uuid: 'build-1' }, body: { uuid: 'INVALID' } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'UUID format is invalid' });
      expect(mockBuildQuery).not.toHaveBeenCalled();
    });

    it('returns 404 when the build to update is absent', async () => {
      mockBuildQuery.mockReturnValue(queryResult(undefined));
      const res = response();
      await buildHandler(request({ method: 'PATCH', query: { uuid: 'build-1' }, body: { uuid: 'new-uuid' } }), res);
      expect(res.statusCode).toBe(404);
      expect(mockValidateUuid).not.toHaveBeenCalled();
    });

    it('rejects the existing UUID and service-level validation failures', async () => {
      mockBuildQuery
        .mockReturnValueOnce(queryResult({ id: 1, uuid: 'same-uuid' }))
        .mockReturnValueOnce(queryResult({ id: 1, uuid: 'old-uuid' }));
      const same = response();
      await buildHandler(request({ method: 'PATCH', query: { uuid: 'same-uuid' }, body: { uuid: 'same-uuid' } }), same);
      expect(same.body).toEqual({ error: 'UUID must be different' });

      mockValidateUuid.mockResolvedValueOnce({ valid: false, error: 'UUID is unavailable' });
      const invalid = response();
      await buildHandler(
        request({ method: 'PATCH', query: { uuid: 'old-uuid' }, body: { uuid: 'new-uuid' } }),
        invalid
      );
      expect(invalid.body).toEqual({ error: 'UUID is unavailable' });
      expect(mockUpdateBuildUuid).not.toHaveBeenCalled();
    });

    it.each([
      [{ id: 1, uuid: 'old-uuid', pullRequest: undefined }, false],
      [{ id: 1, uuid: 'old-uuid', pullRequest: { deployOnUpdate: false } }, false],
      [{ id: 1, uuid: 'old-uuid', pullRequest: { deployOnUpdate: true } }, true],
    ])('updates UUID and conditionally redeploys: %j', async (build, redeploys) => {
      mockBuildQuery.mockReturnValue(queryResult(build));
      mockUpdateBuildUuid.mockResolvedValueOnce({ build: { id: 1, uuid: 'new-uuid', status: 'ready' } });
      const res = response();
      await buildHandler(request({ method: 'PATCH', query: { uuid: 'old-uuid' }, body: { uuid: 'new-uuid' } }), res);
      expect(mockValidateUuid).toHaveBeenCalledWith('new-uuid', 1);
      expect(mockUpdateBuildUuid).toHaveBeenCalledWith(build, 'new-uuid');
      if (redeploys) expect(mockEnqueueBuild).toHaveBeenCalledWith({ buildId: 1, runUUID: 'fixed-id' });
      else expect(mockEnqueueBuild).not.toHaveBeenCalled();
      expect(res.body).toEqual({ data: { id: 1, uuid: 'new-uuid', status: 'ready' } });
    });

    it.each([
      [new BuildUuidValidationError('conflicting UUID'), 400, { error: 'conflicting UUID' }],
      [new Error('db unavailable'), 500, { error: 'An unexpected error occurred' }],
    ])('maps update errors by domain: %s', async (error, status, body) => {
      mockBuildQuery.mockReturnValue(queryResult({ id: 1, uuid: 'old-uuid' }));
      mockValidateUuid.mockRejectedValueOnce(error);
      const res = response();
      await buildHandler(request({ method: 'PATCH', query: { uuid: 'old-uuid' }, body: { uuid: 'new-uuid' } }), res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual(body);
    });
  });

  describe('POST /builds/:uuid/deploy', () => {
    it('rejects unsupported methods', async () => {
      const res = response();
      await deployHandler(request({ query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(405);
    });

    it('returns 404 for a missing build without enqueuing', async () => {
      mockBuildQuery.mockReturnValue(queryResult(undefined));
      const res = response();
      await deployHandler(request({ method: 'POST', query: { uuid: 'missing' } }), res);
      expect(res.statusCode).toBe(404);
      expect(mockEnqueueBuild).not.toHaveBeenCalled();
    });

    it('queues a full build redeploy', async () => {
      mockBuildQuery.mockReturnValue(queryResult({ id: 42, uuid: 'build-1' }));
      const res = response();
      await deployHandler(request({ method: 'POST', query: { uuid: 'build-1' } }), res);
      expect(mockEnqueueBuild).toHaveBeenCalledWith({ buildId: 42, runUUID: 'fixed-id' });
      expect(res.body).toEqual({
        status: 'success',
        message: 'Redeploy for build build-1 has been queued',
      });
    });

    it('maps lookup/enqueue failures to the redeploy-specific 500 response', async () => {
      mockBuildQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await deployHandler(request({ method: 'POST', query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Unable to proceed with redeploy for build build-1.' });
    });
  });

  describe('GET /builds/:uuid/graph', () => {
    it('rejects unsupported methods', async () => {
      const res = response();
      await graphHandler(request({ method: 'POST', query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(405);
    });

    it.each([
      [{ nodes: ['existing'] }, false],
      [{}, true],
    ])('returns the stored graph and only generates an empty graph: %j', async (dependencyGraph, generates) => {
      const patchAndFetch = jest.fn().mockImplementation(async (patch) => {
        build.dependencyGraph = patch.dependencyGraph;
        return build;
      });
      const build = {
        id: 1,
        dependencyGraph,
        $query: () => ({ patchAndFetch }),
      };
      mockBuildQuery.mockReturnValue(queryResult(build));
      const res = response();
      await graphHandler(request({ query: { uuid: 'build-1' } }), res);
      if (generates) {
        expect(mockGenerateGraph).toHaveBeenCalledWith(build, 'TB');
        expect(patchAndFetch).toHaveBeenCalledWith({ dependencyGraph: { nodes: ['api'] } });
        expect(res.body).toEqual(expect.objectContaining({ dependencyGraph: { nodes: ['api'] } }));
      } else {
        expect(mockGenerateGraph).not.toHaveBeenCalled();
        expect(patchAndFetch).not.toHaveBeenCalled();
        expect(res.body).toEqual(expect.objectContaining({ dependencyGraph }));
      }
    });

    it('maps lookup failures to the stable 500 response', async () => {
      mockBuildQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await graphHandler(request({ query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /builds/:uuid/services/:name/build', () => {
    it('rejects unsupported methods', async () => {
      const res = response();
      await serviceBuildHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.statusCode).toBe(405);
    });

    it('returns 404 for a missing build or service and does not enqueue', async () => {
      mockBuildQuery
        .mockReturnValueOnce(queryResult(undefined))
        .mockReturnValueOnce(queryResult({ id: 1, deploys: undefined }))
        .mockReturnValueOnce(queryResult({ id: 1, deploys: [{ deployable: undefined }] }));
      for (const uuid of ['missing', 'no-deploys', 'no-deployable']) {
        const res = response();
        await serviceBuildHandler(request({ method: 'POST', query: { uuid, name: 'api' } }), res);
        expect(res.statusCode).toBe(404);
      }
      expect(mockEnqueueBuild).not.toHaveBeenCalled();
    });

    it.each([
      [{ resolvedFromRepositoryId: 11, repositoryId: 12 }, 11],
      [{ resolvedFromRepositoryId: null, repositoryId: 12 }, 12],
      [{ resolvedFromRepositoryId: null, repositoryId: null }, 13],
    ])('queues a service redeploy using repository precedence: %j', async (deployable, repositoryId) => {
      const build = {
        id: 42,
        deploys: [{ deployable: { name: 'api', ...deployable }, githubRepositoryId: 13 }],
      };
      mockBuildQuery.mockReturnValue(queryResult(build));
      const res = response();
      await serviceBuildHandler(request({ method: 'POST', query: { uuid: 'build-1', name: 'api' } }), res);
      expect(mockEnqueueBuild).toHaveBeenCalledWith({
        buildId: 42,
        githubRepositoryId: repositoryId,
        runUUID: 'fixed-id',
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 500 when repository identity is absent or enqueueing fails', async () => {
      const deployable = { name: 'api', resolvedFromRepositoryId: null, repositoryId: null };
      mockBuildQuery
        .mockReturnValueOnce(queryResult({ id: 1, deploys: [{ deployable, githubRepositoryId: null }] }))
        .mockReturnValueOnce(queryResult({ id: 1, deploys: [{ deployable: { name: 'api', repositoryId: 1 } }] }));
      const missingRepo = response();
      await serviceBuildHandler(request({ method: 'POST', query: { uuid: 'build-1', name: 'api' } }), missingRepo);
      expect(missingRepo.statusCode).toBe(500);

      mockEnqueueBuild.mockRejectedValueOnce(new Error('queue unavailable'));
      const queueFailure = response();
      await serviceBuildHandler(request({ method: 'POST', query: { uuid: 'build-1', name: 'api' } }), queueFailure);
      expect(queueFailure.statusCode).toBe(500);
    });
  });

  describe('PATCH /builds/:uuid/torndown', () => {
    it('validates method and UUID before entering log context', async () => {
      const method = response();
      await torndownHandler(request({ query: { uuid: 'build-1' } }), method);
      expect(method.statusCode).toBe(405);

      const missing = response();
      await torndownHandler(request({ method: 'PATCH', query: {} }), missing);
      expect(missing.statusCode).toBe(500);
      expect(mockWithLogContext).not.toHaveBeenCalled();
    });

    it('rejects static builds without mutating deploy status', async () => {
      mockBuildQuery.mockReturnValue(queryResult({ id: 1, isStatic: true, deploys: [] }));
      const res = response();
      await torndownHandler(request({ method: 'PATCH', query: { uuid: 'static' } }), res);
      expect(res.statusCode).toBe(404);
      expect(mockDeployQuery).not.toHaveBeenCalled();
    });

    it('locks the current missing-build behavior: dereference is caught as a 500', async () => {
      mockBuildQuery.mockReturnValue(queryResult(undefined));
      const res = response();
      await torndownHandler(request({ method: 'PATCH', query: { uuid: 'missing' } }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'An unexpected error occurred.' });
    });

    it('marks the build and its deploys torn down, then returns updated deploys', async () => {
      const build = { id: 1, isStatic: false, deploys: [{ id: 7 }, { id: 8 }] };
      const initialBuildQuery = queryResult(build);
      const patchBuildQuery = queryResult(undefined);
      const deployPatchQuery = queryResult(undefined);
      const updatedDeploys = [{ id: 7, uuid: 'api-build-1', status: 'torn_down' }];
      const deploySelectQuery = queryResult(updatedDeploys);
      mockBuildQuery.mockReturnValueOnce(initialBuildQuery).mockReturnValueOnce(patchBuildQuery);
      mockDeployQuery.mockReturnValueOnce(deployPatchQuery).mockReturnValueOnce(deploySelectQuery);
      const res = response();
      await torndownHandler(request({ method: 'PATCH', query: { uuid: 'build-1' } }), res);
      expect(patchBuildQuery.findById).toHaveBeenCalledWith(1);
      expect(patchBuildQuery.patch).toHaveBeenCalledWith({
        status: 'torn_down',
        statusMessage: 'Namespace was deleted successfully',
      });
      expect(deployPatchQuery.whereIn).toHaveBeenCalledWith('id', [7, 8]);
      expect(res.body).toEqual({
        status: 'The namespace env-build-1 it was delete sucessfuly',
        namespacesUpdated: updatedDeploys,
      });
    });

    it('maps database failures to a stable 500 response', async () => {
      mockBuildQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await torndownHandler(request({ method: 'PATCH', query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('/builds/:uuid/webhooks', () => {
    it.each([{}, { uuid: ['build-1'] }])('rejects invalid UUIDs: %j', async (query) => {
      const res = response();
      await webhooksHandler(request({ query }), res);
      expect(res.statusCode).toBe(400);
    });

    it('advertises allowed methods', async () => {
      const res = response();
      await webhooksHandler(request({ method: 'DELETE', query: { uuid: 'build-1' } }), res);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'POST']);
      expect(res.statusCode).toBe(405);
    });

    it('maps synchronous routing failures to the outer stable error', async () => {
      const res = response();
      (res.setHeader as jest.Mock).mockImplementationOnce(() => {
        throw new Error('response unavailable');
      });
      await webhooksHandler(request({ method: 'DELETE', query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'An unexpected error occurred.' });
    });

    it.each([
      [{}, { currentPage: 1, totalPages: 1, total: 12, limit: 100 }, 0],
      [{ page: '2', limit: '5' }, { currentPage: 2, totalPages: 3, total: 12, limit: 5 }, 5],
      [{ page: 'bad', limit: '0' }, { currentPage: 1, totalPages: 2, total: 12, limit: 10 }, 0],
    ])('retrieves a page using the current query-builder build identifier: %j', async (params, metadata, offset) => {
      const buildIdQuery = queryResult({ id: 42 });
      const countQuery = queryResult(undefined);
      countQuery.resultSize.mockResolvedValue(12);
      const webhooks = [{ id: 1, buildId: 42 }];
      const listQuery = queryResult(webhooks);
      mockWebhookBuildQuery.mockReturnValue(buildIdQuery);
      mockInvocationQuery.mockReturnValueOnce(countQuery).mockReturnValueOnce(listQuery);
      const res = response();
      await webhooksHandler(request({ query: { uuid: 'build-1', ...params } }), res);
      const buildIdPromise = buildIdQuery.first.mock.results[0].value;
      expect(countQuery.where).toHaveBeenCalledWith('buildId', buildIdPromise);
      expect(listQuery.offset).toHaveBeenCalledWith(offset);
      expect(res.body).toEqual({ webhooks, metadata });
    });

    it('maps webhook history query failures to the route-specific 500 response', async () => {
      mockWebhookBuildQuery.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const res = response();
      await webhooksHandler(request({ query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Unable to retrieve webhooks for build build-1.' });
    });

    it('locks the current missing-build POST behavior: id dereference produces a 500', async () => {
      mockGithubBuildQuery.mockReturnValue(queryResult(undefined));
      const res = response();
      await webhooksHandler(request({ method: 'POST', query: { uuid: 'missing' } }), res);
      expect(res.statusCode).toBe(500);
      expect(mockWebhookQueueAdd).not.toHaveBeenCalled();
    });

    it('returns 204 when the build has no webhook configuration', async () => {
      mockGithubBuildQuery.mockReturnValue(queryResult({ id: 42, webhooksYaml: null }));
      const res = response();
      await webhooksHandler(request({ method: 'POST', query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(204);
      expect(mockWebhookQueueAdd).not.toHaveBeenCalled();
    });

    it('queues configured webhooks with the generated correlation ID', async () => {
      mockGithubBuildQuery.mockReturnValue(queryResult({ id: 42, webhooksYaml: { webhooks: [] } }));
      const res = response();
      await webhooksHandler(request({ method: 'POST', query: { uuid: 'build-1' } }), res);
      expect(mockWebhookQueueAdd).toHaveBeenCalledWith('webhook', {
        buildId: 42,
        correlationId: expect.stringMatching(/^api-webhook-invoke-\d+-fixed-id$/),
      });
      expect(res.body).toEqual({
        status: 'success',
        message: 'Webhook for build build-1 has been queued',
      });
    });

    it('maps queue failures to the invoke-specific 500 response', async () => {
      mockGithubBuildQuery.mockReturnValue(queryResult({ id: 42, webhooksYaml: {} }));
      mockWebhookQueueAdd.mockRejectedValueOnce(new Error('queue unavailable'));
      const res = response();
      await webhooksHandler(request({ method: 'POST', query: { uuid: 'build-1' } }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        error: 'Unable to proceed with triggering webhook for build build-1.',
      });
    });
  });
});
