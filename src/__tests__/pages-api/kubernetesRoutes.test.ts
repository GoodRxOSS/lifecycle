import { gzipSync } from 'zlib';
import { request, response } from 'src/test-utils/pagesApi';

type Query = Record<string, jest.Mock> & PromiseLike<unknown>;

function queryResult<T>(value: T): Query {
  const query = {} as Query;
  for (const method of ['where', 'withGraphFetched']) query[method] = jest.fn(() => query);
  query.first = jest.fn().mockResolvedValue(value);
  query.then = jest.fn((resolve, reject) => Promise.resolve(value).then(resolve, reject));
  return query;
}

const mockLoadKubeConfig = jest.fn();
const mockMakeApiClient = jest.fn();
const mockListEvents = jest.fn();
const mockReadSecret = jest.fn();
const mockListConfigMaps = jest.fn();
const mockGetNativeBuildJobs = jest.fn();
const mockGetDeploymentJobs = jest.fn();
const mockDeployQuery = jest.fn();
const mockWithLogContext = jest.fn((_context: unknown, callback: () => unknown) => callback());
const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockCoreApi = {
  listNamespacedEvent: (...args: unknown[]) => mockListEvents(...args),
  readNamespacedSecret: (...args: unknown[]) => mockReadSecret(...args),
  listNamespacedConfigMap: (...args: unknown[]) => mockListConfigMaps(...args),
};

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn(() => ({
    loadFromDefault: (...args: unknown[]) => mockLoadKubeConfig(...args),
    makeApiClient: (...args: unknown[]) => mockMakeApiClient(...args),
  })),
  CoreV1Api: class CoreV1Api {},
  HttpError: class HttpError extends Error {
    response: { statusCode: number };

    constructor(response: { statusCode: number }, _body: unknown, statusCode = response.statusCode) {
      super(`Kubernetes ${statusCode}`);
      this.response = { statusCode };
    }
  },
}));

jest.mock('server/lib/kubernetes/getNativeBuildJobs', () => ({
  getNativeBuildJobs: (...args: unknown[]) => mockGetNativeBuildJobs(...args),
}));

jest.mock('server/lib/kubernetes/getDeploymentJobs', () => ({
  getDeploymentJobs: (...args: unknown[]) => mockGetDeploymentJobs(...args),
}));

jest.mock('server/models', () => ({
  Deploy: { query: (...args: unknown[]) => mockDeployQuery(...args) },
}));

jest.mock('server/lib/logger', () => ({
  withLogContext: (...args: unknown[]) => mockWithLogContext(...(args as [unknown, () => unknown])),
  getLogger: () => mockLogger,
}));

let eventsHandler: typeof import('src/pages/api/v1/builds/[uuid]/jobs/[jobName]/events').default;
let buildLogsHandler: typeof import('src/pages/api/v1/builds/[uuid]/services/[name]/buildLogs').default;
let deployLogsHandler: typeof import('src/pages/api/v1/builds/[uuid]/services/[name]/deployLogs').default;
let deploymentHandler: typeof import('src/pages/api/v1/builds/[uuid]/services/[name]/deployment').default;
let HttpError: typeof import('@kubernetes/client-node').HttpError;

const kubernetesError = (statusCode: number) =>
  new HttpError({ statusCode } as import('http').IncomingMessage, undefined, statusCode);

beforeAll(() => {
  mockMakeApiClient.mockReturnValue(mockCoreApi);
  HttpError = require('@kubernetes/client-node').HttpError;
  eventsHandler = require('src/pages/api/v1/builds/[uuid]/jobs/[jobName]/events').default;
  buildLogsHandler = require('src/pages/api/v1/builds/[uuid]/services/[name]/buildLogs').default;
  deployLogsHandler = require('src/pages/api/v1/builds/[uuid]/services/[name]/deployLogs').default;
  deploymentHandler = require('src/pages/api/v1/builds/[uuid]/services/[name]/deployment').default;
});

describe('legacy Kubernetes-backed build routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMakeApiClient.mockReturnValue(mockCoreApi);
    mockWithLogContext.mockImplementation((_context: unknown, callback: () => unknown) => callback());
    mockListEvents.mockResolvedValue({ body: { items: [] } });
    mockGetNativeBuildJobs.mockResolvedValue([]);
    mockGetDeploymentJobs.mockResolvedValue([]);
    mockReadSecret.mockResolvedValue({ body: { data: {} } });
    mockListConfigMaps.mockResolvedValue({ body: { items: [] } });
    mockDeployQuery.mockReturnValue(queryResult(undefined));
  });

  describe('GET /builds/:uuid/jobs/:jobName/events', () => {
    it('rejects unsupported methods and advertises GET', async () => {
      const res = response();
      await eventsHandler(request({ method: 'POST', query: { uuid: 'build-1', jobName: 'job-1' } }), res);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
      expect(res.statusCode).toBe(405);
      expect(mockListEvents).not.toHaveBeenCalled();
    });

    it.each([
      [{ jobName: 'job-1' }],
      [{ uuid: 'build-1' }],
      [{ uuid: ['build-1'], jobName: 'job-1' }],
      [{ uuid: 'build-1', jobName: ['job-1'] }],
    ])('requires string UUID and job name: %j', async (query) => {
      const res = response();
      await eventsHandler(request({ query }), res);
      expect(res.statusCode).toBe(400);
      expect(mockListEvents).not.toHaveBeenCalled();
    });

    it('filters job/pod events, normalizes missing fields, and sorts newest first', async () => {
      mockListEvents.mockResolvedValueOnce({
        body: {
          items: [
            { involvedObject: undefined },
            { involvedObject: { kind: 'Service', name: 'job-1' } },
            { involvedObject: { kind: 'Job', name: 'other-job' } },
            { involvedObject: { kind: 'Pod', name: undefined } },
            {
              involvedObject: { kind: 'Job', name: 'job-1' },
              metadata: { name: 'created', namespace: 'env-build-1' },
              reason: 'Created',
              message: 'Job created',
              type: 'Normal',
              count: 2,
              lastTimestamp: '2026-01-01T00:00:00.000Z',
              source: { component: 'job-controller', host: 'node-1' },
            },
            {
              involvedObject: { kind: 'Pod', name: 'job-1-abc' },
              metadata: {},
              eventTime: '2026-01-02T00:00:00.000Z',
            },
            {
              involvedObject: { kind: 'Pod', name: 'job-1-old' },
            },
          ],
        },
      });
      const res = response();
      await eventsHandler(request({ query: { uuid: 'build-1', jobName: 'job-1' } }), res);
      expect(mockListEvents).toHaveBeenCalledWith('env-build-1');
      expect(res.body).toEqual({
        events: [
          expect.objectContaining({ name: '', type: 'Normal', count: 1, eventTime: '2026-01-02T00:00:00.000Z' }),
          expect.objectContaining({ name: 'created', reason: 'Created', count: 2 }),
          expect.objectContaining({ name: '', namespace: '', reason: '', message: '', type: 'Normal', count: 1 }),
        ],
      });
      expect((res.body as { events: Array<{ source?: unknown }> }).events[0].source).toBeUndefined();
      expect((res.body as { events: Array<{ source?: unknown }> }).events[1].source).toEqual({
        component: 'job-controller',
        host: 'node-1',
      });
    });

    it('treats an absent Kubernetes item list as empty', async () => {
      mockListEvents.mockResolvedValueOnce({ body: { items: undefined } });
      const res = response();
      await eventsHandler(request({ query: { uuid: 'build-1', jobName: 'job-1' } }), res);
      expect(res.body).toEqual({ events: [] });
    });

    it.each([
      [
        [
          { involvedObject: { kind: 'Pod', name: 'job-1-event' }, eventTime: '2026-01-02T00:00:00.000Z' },
          { involvedObject: { kind: 'Pod', name: 'job-1-last' }, lastTimestamp: '2026-01-01T00:00:00.000Z' },
        ],
      ],
      [
        [
          { involvedObject: { kind: 'Pod', name: 'job-1-undated' } },
          { involvedObject: { kind: 'Pod', name: 'job-1-last' }, lastTimestamp: '2026-01-01T00:00:00.000Z' },
        ],
      ],
    ])('sorts correctly when the comparator right side uses fallback timestamps', async (items) => {
      mockListEvents.mockResolvedValueOnce({ body: { items } });
      const res = response();
      await eventsHandler(request({ query: { uuid: 'build-1', jobName: 'job-1' } }), res);
      expect((res.body as { events: unknown[] }).events).toHaveLength(2);
    });

    it.each([
      [() => kubernetesError(404), 404, { error: 'Environment or job not found.' }],
      [() => kubernetesError(403), 502, { error: 'Failed to communicate with Kubernetes.' }],
      [
        () => {
          const error = kubernetesError(403);
          delete (error as unknown as { response?: unknown }).response;
          return error;
        },
        502,
        { error: 'Failed to communicate with Kubernetes.' },
      ],
      [() => new Error('unexpected'), 500, { error: 'Internal server error occurred.' }],
    ])('maps Kubernetes and internal failures', async (makeError, status, body) => {
      mockListEvents.mockRejectedValueOnce(makeError());
      const res = response();
      await eventsHandler(request({ query: { uuid: 'build-1', jobName: 'job-1' } }), res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual(body);
    });
  });

  describe.each([
    ['build logs', () => buildLogsHandler, mockGetNativeBuildJobs, 'builds'],
    ['deploy logs', () => deployLogsHandler, mockGetDeploymentJobs, 'deployments'],
  ])('GET service %s list', (_name, getHandler, fetchJobs, responseKey) => {
    it('rejects unsupported methods and advertises GET', async () => {
      const res = response();
      await getHandler()(request({ method: 'POST', query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
      expect(res.statusCode).toBe(405);
      expect(fetchJobs).not.toHaveBeenCalled();
    });

    it.each([
      [{ name: 'api' }],
      [{ uuid: 'build-1' }],
      [{ uuid: ['build-1'], name: 'api' }],
      [{ uuid: 'build-1', name: ['api'] }],
    ])('requires string UUID and service name: %j', async (query) => {
      const res = response();
      await getHandler()(request({ query }), res);
      expect(res.statusCode).toBe(400);
      expect(fetchJobs).not.toHaveBeenCalled();
    });

    it('returns jobs for the service namespace', async () => {
      const jobs = [{ name: 'job-1', status: 'Complete' }];
      fetchJobs.mockResolvedValueOnce(jobs);
      const res = response();
      await getHandler()(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(fetchJobs).toHaveBeenCalledWith('api', 'env-build-1');
      expect(res.body).toEqual({ [responseKey]: jobs });
    });

    it.each([
      [() => kubernetesError(404), 404, { error: 'Environment or service not found.' }],
      [() => kubernetesError(403), 502, { error: 'Failed to communicate with Kubernetes.' }],
      [
        () => {
          const error = kubernetesError(403);
          delete (error as unknown as { response?: unknown }).response;
          return error;
        },
        502,
        { error: 'Failed to communicate with Kubernetes.' },
      ],
      [() => new Error('unexpected'), 500, { error: 'Internal server error occurred.' }],
    ])('maps Kubernetes and internal failures', async (makeError, status, body) => {
      fetchJobs.mockRejectedValueOnce(makeError());
      const res = response();
      await getHandler()(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual(body);
    });
  });

  describe('GET /builds/:uuid/services/:name/deployment', () => {
    const jsonRelease = {
      name: 'api-build-1',
      chart: { metadata: { name: 'api-chart', version: '1.2.3' } },
      config: { replicas: 2 },
      manifest: 'kind: Deployment',
    };

    it('rejects methods and malformed params before querying Kubernetes', async () => {
      const method = response();
      await deploymentHandler(request({ method: 'POST', query: { uuid: 'build-1', name: 'api' } }), method);
      expect(method.statusCode).toBe(405);

      for (const query of [{ name: 'api' }, { uuid: 'build-1' }, { uuid: ['build-1'], name: 'api' }]) {
        const res = response();
        await deploymentHandler(request({ query }), res);
        expect(res.statusCode).toBe(400);
      }
      expect(mockReadSecret).not.toHaveBeenCalled();
    });

    it('returns a double-base64 gzip Helm release', async () => {
      const encoded = Buffer.from(gzipSync(Buffer.from(JSON.stringify(jsonRelease))).toString('base64')).toString(
        'base64'
      );
      mockReadSecret.mockResolvedValueOnce({ body: { data: { release: encoded } } });
      const res = response();
      await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(mockReadSecret).toHaveBeenCalledWith('sh.helm.release.v1.api-build-1.v1', 'env-build-1');
      expect(res.body).toEqual({
        type: 'helm',
        releaseName: 'api-build-1',
        chart: 'api-chart',
        version: '1.2.3',
        values: { replicas: 2 },
        manifest: 'kind: Deployment',
      });
      expect(mockListConfigMaps).not.toHaveBeenCalled();
    });

    it('falls back to plain JSON Helm data and applies output defaults', async () => {
      const release = { name: 'api-build-1', chart: {}, config: null };
      mockReadSecret.mockResolvedValueOnce({
        body: { data: { release: Buffer.from(JSON.stringify(release)).toString('base64') } },
      });
      const res = response();
      await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.body).toEqual({
        type: 'helm',
        releaseName: 'api-build-1',
        chart: 'unknown',
        version: undefined,
        values: {},
        manifest: undefined,
      });
    });

    it('returns a manifest ConfigMap when Helm data is absent', async () => {
      mockListConfigMaps.mockResolvedValueOnce({
        body: {
          items: [
            { metadata: undefined },
            { metadata: { name: 'other' }, data: { 'manifest.yaml': 'ignored' } },
            { metadata: { name: 'api-manifest' }, data: { 'manifest.yaml': 'kind: Service' } },
          ],
        },
      });
      const res = response();
      await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(mockListConfigMaps).toHaveBeenCalledWith(
        'env-build-1',
        undefined,
        undefined,
        undefined,
        undefined,
        'deploy_uuid=api-build-1,app=lifecycle-deploy'
      );
      expect(res.body).toEqual({
        type: 'github',
        manifestConfigMap: 'api-manifest',
        manifest: 'kind: Service',
      });
      expect(mockDeployQuery).not.toHaveBeenCalled();
    });

    it('treats a Helm secret body without data as absent', async () => {
      mockReadSecret.mockResolvedValueOnce({ body: {} });
      mockListConfigMaps.mockResolvedValueOnce({
        body: { items: [{ metadata: { name: 'api-manifest' }, data: { 'manifest.yaml': 'kind: Service' } }] },
      });
      const res = response();
      await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.body).toEqual(expect.objectContaining({ type: 'github' }));
    });

    it.each([
      [[{ metadata: { name: 'api-manifest' }, data: undefined }], { manifest: 'kind: Deployment' }],
      [[], { manifest: 'kind: Deployment' }],
    ])('falls back to the database manifest when ConfigMap data is unavailable', async (items, deploy) => {
      mockListConfigMaps.mockResolvedValueOnce({ body: { items } });
      const deployQuery = queryResult(deploy);
      mockDeployQuery.mockReturnValueOnce(deployQuery);
      const res = response();
      await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(deployQuery.where).toHaveBeenCalledWith('uuid', 'api-build-1');
      expect(res.body).toEqual({
        type: 'github',
        manifestConfigMap: 'stored-in-database',
        manifest: 'kind: Deployment',
      });
    });

    it.each([undefined, {}, { manifest: '' }])('returns 404 when no manifest exists: %j', async (deploy) => {
      mockDeployQuery.mockReturnValueOnce(queryResult(deploy));
      const res = response();
      await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Deployment not found' });
    });

    it('treats Helm and ConfigMap 404 responses as not found', async () => {
      mockReadSecret.mockRejectedValueOnce(kubernetesError(404));
      mockListConfigMaps.mockRejectedValueOnce(kubernetesError(404));
      const res = response();
      await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.statusCode).toBe(404);
    });

    it.each([
      [() => kubernetesError(403), 502, { error: 'Failed to communicate with Kubernetes' }],
      [() => new Error('unexpected'), 500, { error: 'Internal server error' }],
    ])('maps upstream and internal failures', async (makeError, status, body) => {
      mockReadSecret.mockRejectedValueOnce(makeError());
      const res = response();
      await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual(body);
    });

    it('maps a non-404 ConfigMap failure after Helm lookup to 502', async () => {
      mockListConfigMaps.mockRejectedValueOnce(kubernetesError(403));
      const res = response();
      await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.statusCode).toBe(502);
      expect(res.body).toEqual({ error: 'Failed to communicate with Kubernetes' });
    });

    it.each(['secret', 'config-map'])(
      'maps a Kubernetes error without response metadata from %s lookup',
      async (source) => {
        const error = kubernetesError(403);
        delete (error as unknown as { response?: unknown }).response;
        if (source === 'secret') mockReadSecret.mockRejectedValueOnce(error);
        else mockListConfigMaps.mockRejectedValueOnce(error);
        const res = response();
        await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
        expect(res.statusCode).toBe(502);
      }
    );

    it('continues to GitHub lookup after malformed Helm release data', async () => {
      mockReadSecret.mockResolvedValueOnce({
        body: { data: { release: Buffer.from('not-json').toString('base64') } },
      });
      mockListConfigMaps.mockResolvedValueOnce({
        body: { items: [{ metadata: { name: 'api-manifest' }, data: { 'manifest.yaml': 'kind: Pod' } }] },
      });
      const res = response();
      await deploymentHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.body).toEqual(expect.objectContaining({ type: 'github', manifest: 'kind: Pod' }));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to parse Helm release data'));
    });
  });
});
