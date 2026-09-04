import { request, response } from 'src/test-utils/pagesApi';

const mockRedisPing = jest.fn();
const mockDbRaw = jest.fn();
const mockBootstrapJobs = jest.fn();
const mockCreateServices = jest.fn();
const mockVerifyWebhook = jest.fn();
const mockShouldProcessWebhook = jest.fn();
const mockWebhookQueueAdd = jest.fn();
const mockStringify = jest.fn();
const mockExtractContext = jest.fn();
const mockWithLogContext = jest.fn((_context: unknown, callback: () => unknown) => callback());
const mockSetTag = jest.fn();
const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};
let mockLifecycleMode = 'web';
let mockTracerScope: unknown = jest.fn(() => ({ active: () => ({ setTag: mockSetTag }) }));

const mockServices = {
  GithubService: {
    shouldProcessWebhook: (...args: unknown[]) => mockShouldProcessWebhook(...args),
    webhookQueue: { add: (...args: unknown[]) => mockWebhookQueueAdd(...args) },
  },
};

jest.mock('server/lib/dependencies', () => ({
  defaultDb: { knex: { raw: (...args: unknown[]) => mockDbRaw(...args) } },
}));

jest.mock('server/lib/redisClient', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getRedis: () => ({ ping: (...args: unknown[]) => mockRedisPing(...args) }) }) },
}));

jest.mock('server/jobs/index', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockBootstrapJobs(...args),
}));

jest.mock('server/services', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockCreateServices(...args),
}));

jest.mock('server/lib/github', () => ({
  verifyWebhookSignature: (...args: unknown[]) => mockVerifyWebhook(...args),
}));

jest.mock('server/lib/logger', () => ({
  withLogContext: (...args: unknown[]) => mockWithLogContext(...(args as [unknown, () => unknown])),
  getLogger: () => mockLogger,
  extractContextForQueue: (...args: unknown[]) => mockExtractContext(...args),
  LogStage: {
    WEBHOOK_RECEIVED: 'webhook-received',
    WEBHOOK_SKIPPED: 'webhook-skipped',
    WEBHOOK_QUEUED: 'webhook-queued',
  },
}));

jest.mock('shared/config', () => ({
  get LIFECYCLE_MODE() {
    return mockLifecycleMode;
  },
}));

jest.mock('shared/index', () => ({
  get LIFECYCLE_MODE() {
    return mockLifecycleMode;
  },
}));

jest.mock('flatted', () => ({ stringify: (...args: unknown[]) => mockStringify(...args) }));

jest.mock('dd-trace', () => ({
  __esModule: true,
  default: {
    get scope() {
      return mockTracerScope;
    },
  },
}));

import healthHandler from 'src/pages/api/health';

let githubWebhookHandler: typeof import('src/pages/api/webhooks/github').default;

describe('root legacy API routes', () => {
  beforeAll(() => {
    mockCreateServices.mockReturnValue(mockServices);
    githubWebhookHandler = require('src/pages/api/webhooks/github').default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLifecycleMode = 'web';
    mockTracerScope = jest.fn(() => ({ active: () => ({ setTag: mockSetTag }) }));
    mockCreateServices.mockReturnValue(mockServices);
    mockRedisPing.mockResolvedValue('PONG');
    mockDbRaw.mockResolvedValue({});
    mockVerifyWebhook.mockReturnValue(true);
    mockShouldProcessWebhook.mockResolvedValue(true);
    mockWebhookQueueAdd.mockResolvedValue({ id: 'queue-job' });
    mockStringify.mockReturnValue('serialized-request');
    mockExtractContext.mockReturnValue({ correlationId: 'from-context' });
    mockWithLogContext.mockImplementation((_context: unknown, callback: () => unknown) => callback());
  });

  describe('/health', () => {
    it('rejects non-GET methods without touching dependencies', async () => {
      const res = response();
      await healthHandler(request({ method: 'POST' }), res);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
      expect(res.statusCode).toBe(405);
      expect(mockRedisPing).not.toHaveBeenCalled();
      expect(mockDbRaw).not.toHaveBeenCalled();
    });

    it('reports healthy only after both Redis and the database respond', async () => {
      const res = response();
      await healthHandler(request(), res);
      expect(mockRedisPing).toHaveBeenCalledTimes(1);
      expect(mockDbRaw).toHaveBeenCalledWith('SELECT 1');
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ status: 'Healthy' });
    });

    it.each([
      ['Redis', () => mockRedisPing.mockRejectedValueOnce(new Error('redis unavailable'))],
      ['database', () => mockDbRaw.mockRejectedValueOnce(new Error('database unavailable'))],
    ])('reports unhealthy when %s fails', async (_dependency, fail) => {
      fail();
      const res = response();
      await healthHandler(request(), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        status: 'Unhealthy',
        error: 'An error occurred while performing health check.',
      });
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('/jobs', () => {
    async function loadJobsHandler(mode: string) {
      mockLifecycleMode = mode;
      jest.resetModules();
      let handler!: typeof import('src/pages/api/jobs').default;
      jest.isolateModules(() => {
        handler = require('src/pages/api/jobs').default;
      });
      return handler;
    }

    it.each(['job', 'all'])('bootstraps workers once in %s mode and always completes JSON responses', async (mode) => {
      const handler = await loadJobsHandler(mode);
      const first = response();
      const second = response();
      handler(request(), first);
      handler(request(), second);
      expect(mockBootstrapJobs).toHaveBeenCalledTimes(1);
      expect(mockBootstrapJobs).toHaveBeenCalledWith(mockServices);
      for (const res of [first, second]) {
        expect(res.statusCode).toBe(200);
        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
        expect(res.end).toHaveBeenCalled();
      }
    });

    it('marks bootstrap complete without starting workers in web mode', async () => {
      const handler = await loadJobsHandler('web');
      const res = response();
      handler(request(), res);
      handler(request(), res);
      expect(mockBootstrapJobs).not.toHaveBeenCalled();
      expect(res.end).toHaveBeenCalledTimes(2);
    });
  });

  describe('/webhooks/github', () => {
    function webhookRequest(overrides: Parameters<typeof request>[0] = {}) {
      return request({
        method: 'POST',
        headers: { 'x-github-delivery': 'delivery-1', 'x-github-event': 'push' },
        body: { sender: { login: 'octocat' }, repository: { full_name: 'goodrx/lifecycle' } },
        ...overrides,
      });
    }

    it('rejects an unverifiable webhook before inspecting event or repository state', async () => {
      mockVerifyWebhook.mockReturnValueOnce(false);
      const req = webhookRequest();
      await expect(githubWebhookHandler(req, response())).rejects.toThrow('Webhook not verified');
      expect(mockShouldProcessWebhook).not.toHaveBeenCalled();
      expect(mockWebhookQueueAdd).not.toHaveBeenCalled();
    });

    it.each([
      [jest.fn(() => ({ active: () => ({ setTag: mockSetTag }) })), true],
      [undefined, false],
      [jest.fn(() => undefined), false],
      [jest.fn(() => ({ active: () => undefined })), false],
    ])('drops bot issue comments and tags a trace when available', async (scope, tagsTrace) => {
      mockTracerScope = scope;
      const req = webhookRequest({
        headers: { 'x-github-delivery': 'delivery-1', 'x-github-event': 'issue_comment' },
        body: { sender: { login: 'dependabot[bot]' } },
      });
      const res = response();
      await githubWebhookHandler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.end).toHaveBeenCalled();
      if (tagsTrace) expect(mockSetTag).toHaveBeenCalledWith('manual.drop', true);
      else expect(mockSetTag).not.toHaveBeenCalled();
      expect(mockShouldProcessWebhook).not.toHaveBeenCalled();
    });

    it('skips all processing outside web/all mode', async () => {
      mockLifecycleMode = 'job';
      const res = response();
      await githubWebhookHandler(webhookRequest(), res);
      expect(mockShouldProcessWebhook).not.toHaveBeenCalled();
      expect(mockWebhookQueueAdd).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });

    it('acknowledges but does not queue repositories that are not onboarded', async () => {
      mockShouldProcessWebhook.mockResolvedValueOnce(false);
      const req = webhookRequest({ body: { repository: { full_name: 'other/repo' } } });
      const res = response();
      await githubWebhookHandler(req, res);
      expect(mockShouldProcessWebhook).toHaveBeenCalledWith(req.body);
      expect(mockWebhookQueueAdd).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      expect(res.end).toHaveBeenCalled();
    });

    it.each([
      ['web', false],
      ['all', true],
    ])('serializes and queues an accepted webhook in %s mode', async (mode, bootstraps) => {
      mockLifecycleMode = mode;
      const req = webhookRequest({ body: { repository: { full_name: 'goodrx/lifecycle' } } });
      const res = response();
      await githubWebhookHandler(req, res);
      if (bootstraps) expect(mockBootstrapJobs).toHaveBeenCalledWith(mockServices);
      else expect(mockBootstrapJobs).not.toHaveBeenCalled();
      expect(mockStringify).toHaveBeenCalledWith({ ...req, headers: req.headers });
      expect(mockWebhookQueueAdd).toHaveBeenCalledWith('webhook', {
        message: 'serialized-request',
        correlationId: 'from-context',
      });
      expect(res.statusCode).toBe(200);
      expect(res.end).toHaveBeenCalled();
    });

    it('uses a timestamp correlation ID and absent sender when delivery metadata is missing', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(12345);
      const req = webhookRequest({ headers: { 'x-github-event': 'push' }, body: {} });
      await githubWebhookHandler(req, response());
      expect(mockWithLogContext).toHaveBeenCalledWith(
        { correlationId: 'webhook-12345', sender: undefined },
        expect.any(Function)
      );
      now.mockRestore();
    });

    it('returns 500 if serialization or queueing fails', async () => {
      mockWebhookQueueAdd.mockRejectedValueOnce(new Error('queue unavailable'));
      const res = response();
      await githubWebhookHandler(webhookRequest(), res);
      expect(res.statusCode).toBe(500);
      expect(res.end).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('currently propagates repository eligibility failures before the processing catch', async () => {
      mockShouldProcessWebhook.mockRejectedValueOnce(new Error('lookup unavailable'));
      const res = response();
      await expect(githubWebhookHandler(webhookRequest(), res)).rejects.toThrow('lookup unavailable');
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
