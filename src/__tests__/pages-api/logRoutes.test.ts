import { EventEmitter } from 'events';
import { request, response } from 'src/test-utils/pagesApi';

type Query = Record<string, jest.Mock> & PromiseLike<unknown>;

function queryResult<T>(value: T): Query {
  const query = {} as Query;
  query.findOne = jest.fn(() => query);
  query.then = jest.fn((resolve, reject) => Promise.resolve(value).then(resolve, reject));
  return query;
}

function childProcess() {
  const process = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = jest.fn();
  return process;
}

const mockGetLogStreamInfo = jest.fn();
const mockGithubBuildQuery = jest.fn();
const mockExec = jest.fn();
const mockSpawn = jest.fn();
const mockWithLogContext = jest.fn((_context: unknown, callback: () => unknown) => callback());
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('server/services/logStreaming', () => ({
  LogStreamingService: jest.fn(() => ({
    getLogStreamInfo: (...args: unknown[]) => mockGetLogStreamInfo(...args),
  })),
}));

jest.mock('server/services/github', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    db: { models: { Build: { query: (...args: unknown[]) => mockGithubBuildQuery(...args) } } },
  })),
}));

jest.mock('child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('@kubernetes/client-node', () => ({
  HttpError: class HttpError extends Error {
    response: { statusCode: number };

    constructor(response: { statusCode: number }, _body: unknown, statusCode = response.statusCode) {
      super(`Kubernetes ${statusCode}`);
      this.response = { statusCode };
    }
  },
}));

jest.mock('server/lib/logger', () => ({
  withLogContext: (...args: unknown[]) => mockWithLogContext(...(args as [unknown, () => unknown])),
  getLogger: () => mockLogger,
}));

import unifiedLogHandler from 'src/pages/api/v1/builds/[uuid]/services/[name]/logs/[jobName]';
import buildLogProxy from 'src/pages/api/v1/builds/[uuid]/services/[name]/buildLogs/[jobName]';
import deployLogProxy from 'src/pages/api/v1/builds/[uuid]/services/[name]/deployLogs/[jobName]';
import webhookLogProxy from 'src/pages/api/v1/builds/[uuid]/jobs/[jobName]/logs';
import serviceLogsHandler, { config as serviceLogsConfig } from 'src/pages/api/v1/builds/[uuid]/services/[name]/logs';
import { HttpError } from '@kubernetes/client-node';

const kubernetesError = (statusCode: number) =>
  new HttpError({ statusCode } as import('http').IncomingMessage, undefined, statusCode);

describe('legacy build log routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithLogContext.mockImplementation((_context: unknown, callback: () => unknown) => callback());
    mockGetLogStreamInfo.mockResolvedValue({ source: 'kubernetes', streamUrl: '/logs' });
    mockGithubBuildQuery.mockReturnValue(queryResult({ namespace: 'env-custom' }));
    mockExec.mockImplementation((_command: string, callback: (error: unknown, result?: unknown) => void) =>
      callback(null, { stdout: 'pod-a\n', stderr: '' })
    );
    mockSpawn.mockImplementation(() => childProcess());
  });

  describe('unified job log metadata handler', () => {
    it('rejects unsupported methods and advertises GET', async () => {
      const res = response();
      await unifiedLogHandler(
        request({ method: 'POST', query: { uuid: 'build-1', name: 'api', jobName: 'job-1' } }),
        res
      );
      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
      expect(res.statusCode).toBe(405);
      expect(mockGetLogStreamInfo).not.toHaveBeenCalled();
    });

    it.each([
      [{ name: 'api', jobName: 'job-1' }],
      [{ uuid: 'build-1', name: 'api' }],
      [{ uuid: ['build-1'], name: 'api', jobName: 'job-1' }],
      [{ uuid: 'build-1', name: ['api'], jobName: 'job-1' }],
      [{ uuid: 'build-1', jobName: 'job-1' }],
    ])('requires valid route params for non-webhook streams: %j', async (query) => {
      const res = response();
      await unifiedLogHandler(request({ query }), res);
      expect(res.statusCode).toBe(400);
      expect(mockGetLogStreamInfo).not.toHaveBeenCalled();
    });

    it.each([
      [{ uuid: 'build-1', name: 'api', jobName: 'job-1', type: ['build'] }],
      [{ uuid: 'build-1', name: 'api', jobName: 'job-1', type: 'unknown' }],
    ])('rejects invalid log types: %j', async (query) => {
      const res = response();
      await unifiedLogHandler(request({ query }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid type parameter. Must be "build", "deploy", or "webhook"' });
    });

    it.each([
      [{ uuid: 'build-1', name: 'api', jobName: 'job-1' }, ['build-1', 'job-1', 'api', undefined]],
      [{ uuid: 'build-1', name: 'api', jobName: 'job-1', type: 'build' }, ['build-1', 'job-1', 'api', 'build']],
      [{ uuid: 'build-1', name: 'api', jobName: 'job-1', type: 'deploy' }, ['build-1', 'job-1', 'api', 'deploy']],
      [{ uuid: 'build-1', jobName: 'job-1', type: 'webhook' }, ['build-1', 'job-1', undefined, 'webhook']],
    ])('returns stream metadata for normalized inputs: %j', async (query, expectedArgs) => {
      const res = response();
      await unifiedLogHandler(request({ query }), res);
      expect(mockGetLogStreamInfo).toHaveBeenCalledWith(...expectedArgs);
      expect(res.body).toEqual({ source: 'kubernetes', streamUrl: '/logs' });
    });

    it.each([
      [new Error('Build not found'), 404, { error: 'Build not found' }],
      [kubernetesError(403), 502, { error: 'Failed to communicate with Kubernetes.' }],
      [new Error('Kubernetes request failed'), 502, { error: 'Failed to communicate with Kubernetes.' }],
      [
        Object.assign(new Error('gateway'), { statusCode: 502 }),
        502,
        { error: 'Failed to communicate with Kubernetes.' },
      ],
      [{ statusCode: 502 }, 502, { error: 'Failed to communicate with Kubernetes.' }],
      [new Error('unexpected'), 500, { error: 'Internal server error occurred.' }],
    ])('maps stream metadata failures: %s', async (error, status, body) => {
      mockGetLogStreamInfo.mockRejectedValueOnce(error);
      const res = response();
      await unifiedLogHandler(
        request({ query: { uuid: 'build-1', name: 'api', jobName: 'job-1', type: 'build' } }),
        res
      );
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual(body);
    });
  });

  describe('typed log proxy routes', () => {
    it.each([
      ['build', buildLogProxy, { uuid: 'build-1', name: 'api', jobName: 'build-job' }, 'build', 'api'],
      ['deploy', deployLogProxy, { uuid: 'build-1', name: 'api', jobName: 'deploy-job' }, 'deploy', 'api'],
      ['webhook', webhookLogProxy, { uuid: 'build-1', name: 'ignored', jobName: 'webhook-job' }, 'webhook', undefined],
    ])('sets %s type before delegating to the unified behavior', async (_label, handler, query, type, name) => {
      const req = request({ query });
      const res = response();
      await handler(req, res);
      expect(req.query.type).toBe(type);
      expect(req.query.name).toBe(name);
      expect(mockGetLogStreamInfo).toHaveBeenCalledWith('build-1', query.jobName, name, type);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('service pod SSE logs', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('disables Next.js body parsing for SSE requests', () => {
      expect(serviceLogsConfig).toEqual({ api: { bodyParser: false } });
    });

    it('answers OPTIONS without querying build or pods', async () => {
      const res = response();
      await serviceLogsHandler(request({ method: 'OPTIONS' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.end).toHaveBeenCalled();
      expect(mockGithubBuildQuery).not.toHaveBeenCalled();
    });

    it('rejects unsupported methods and malformed path params', async () => {
      const method = response();
      await serviceLogsHandler(request({ method: 'POST' }), method);
      expect(method.statusCode).toBe(405);

      for (const query of [
        {},
        { uuid: 'build-1' },
        { name: 'api' },
        { uuid: ['build-1'], name: 'api' },
        { uuid: 'build-1', name: ['api'] },
      ]) {
        const res = response();
        await serviceLogsHandler(request({ query }), res);
        expect(res.statusCode).toBe(400);
      }
      expect(mockGithubBuildQuery).not.toHaveBeenCalled();
    });

    it.each(['sidecar', ['app']])('rejects unsupported container type: %j', async (containerType) => {
      const res = response();
      await serviceLogsHandler(request({ query: { uuid: 'build-1', name: 'api', containerType } }), res);
      expect(res.statusCode).toBe(400);
      expect(mockGithubBuildQuery).not.toHaveBeenCalled();
    });

    it('opens SSE headers, uses the build namespace, and reports no matching pods', async () => {
      mockExec.mockImplementationOnce((_command, callback) => callback(null, { stdout: '\n', stderr: '' }));
      const res = response();
      await serviceLogsHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      expect(mockExec).toHaveBeenCalledWith(
        'kubectl get pods --namespace env-custom -l app.kubernetes.io/instance=api-build-1 -o jsonpath="{range .items[*]}{.metadata.name}{\'\\n\'}{end}"',
        expect.any(Function)
      );
      expect(res.chunks).toContain('data: No pods found for deployment "api-build-1" in namespace "env-custom"\n\n');
      expect(res.end).toHaveBeenCalled();
    });

    it.each([
      [undefined, "Cannot read properties of undefined (reading 'namespace')"],
      [{}, 'Deployment namespace not configured'],
    ])('reports a missing deployment namespace as SSE error: %j', async (build, message) => {
      mockGithubBuildQuery.mockReturnValueOnce(queryResult(build));
      const res = response();
      await serviceLogsHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.chunks).toContain(`data: Error: ${message}\n\n`);
      expect(mockExec).not.toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });

    it('reports kubectl stderr without spawning log followers', async () => {
      mockExec.mockImplementationOnce((_command, callback) => callback(null, { stdout: '', stderr: 'forbidden' }));
      const res = response();
      await serviceLogsHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.chunks).toContain('data: Error: Failed to retrieve pods: forbidden\n\n');
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });

    it('streams at most five app pod processes and forwards process events', async () => {
      mockExec.mockImplementationOnce((_command, callback) =>
        callback(null, { stdout: 'pod-a\npod-b\npod-c\npod-d\npod-e\npod-f\n', stderr: '' })
      );
      const processes = Array.from({ length: 5 }, () => childProcess());
      processes.forEach((process) => mockSpawn.mockReturnValueOnce(process));
      const req = request({ query: { uuid: 'build-1', name: 'api', containerType: 'app' } });
      const res = response();
      await serviceLogsHandler(req, res);

      expect(mockSpawn).toHaveBeenCalledTimes(5);
      expect(mockSpawn).toHaveBeenNthCalledWith(1, 'kubectl', [
        'logs',
        'pod-a',
        '--namespace',
        'env-custom',
        '-f',
        '--tail=100',
        '--all-containers=true',
        '--prefix=true',
      ]);

      processes[0].stdout.emit('data', Buffer.from('line one\npartial'));
      processes[0].stdout.emit('data', Buffer.from(' line\n\n'));
      processes[0].stderr.emit('data', Buffer.from('stderr text'));
      processes[0].emit('error', new Error('spawn failed'));
      processes[0].stdout.emit('data', Buffer.from('tail without newline'));
      processes[0].emit('close', 0);
      expect(res.chunks).toEqual(
        expect.arrayContaining([
          'data: line one\n\n',
          'data: partial line\n\n',
          'data: Error: stderr text\n\n',
          'data: Process error: spawn failed\n\n',
          'data: tail without newline\n\n',
          'data: Log streaming ended with code 0\n\n',
        ])
      );

      const closeCallback = req.on.mock.calls.find(([event]) => event === 'close')?.[1];
      closeCallback();
      processes.forEach((process) => expect(process.kill).toHaveBeenCalled());
    });

    it('targets the init container when requested', async () => {
      const process = childProcess();
      mockSpawn.mockReturnValueOnce(process);
      const req = request({ query: { uuid: 'build-1', name: 'api', containerType: 'init' } });
      await serviceLogsHandler(req, response());
      expect(mockSpawn).toHaveBeenCalledWith('kubectl', [
        'logs',
        'pod-a',
        '--namespace',
        'env-custom',
        '-f',
        '--tail=100',
        '--container=init-container',
      ]);
      const closeCallback = req.on.mock.calls.find(([event]) => event === 'close')?.[1];
      closeCallback();
    });

    it('kills active processes and ends the response after the one-hour timeout', async () => {
      const process = childProcess();
      mockSpawn.mockReturnValueOnce(process);
      const res = response();
      await serviceLogsHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      jest.advanceTimersByTime(3_600_000);
      expect(process.kill).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });

    it('stringifies a non-Error kubectl rejection in the SSE error', async () => {
      mockExec.mockImplementationOnce((_command, callback) => callback('plain failure'));
      const res = response();
      await serviceLogsHandler(request({ query: { uuid: 'build-1', name: 'api' } }), res);
      expect(res.chunks).toContain('data: Error: plain failure\n\n');
      expect(res.end).toHaveBeenCalled();
    });
  });
});
