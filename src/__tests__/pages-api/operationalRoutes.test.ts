import { request, response } from 'src/test-utils/pagesApi';

const mockGetAllConfigs = jest.fn();
const mockTTLQueueAdd = jest.fn();
const mockWithLogContext = jest.fn((_context: unknown, callback: () => unknown) => callback());
const mockNanoid = jest.fn(() => 'fixed-id');
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('server/services/globalConfig', () => {
  const instance = { getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args) };
  const Service = jest.fn(() => instance) as jest.Mock & { getInstance: jest.Mock };
  Service.getInstance = jest.fn(() => instance);
  return { __esModule: true, default: Service };
});

jest.mock('server/services/ttlCleanup', () => ({
  __esModule: true,
  default: jest.fn(() => ({ ttlCleanupQueue: { add: (...args: unknown[]) => mockTTLQueueAdd(...args) } })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => mockLogger,
  withLogContext: (...args: unknown[]) => mockWithLogContext(...(args as [unknown, () => unknown])),
  LogStage: { CLEANUP_STARTING: 'cleanup-starting', CLEANUP_FAILED: 'cleanup-failed' },
}));

jest.mock('nanoid', () => ({ nanoid: () => mockNanoid() }));

import ttlHandler from 'src/pages/api/v1/admin/ttl/cleanup';
import cacheHandler from 'src/pages/api/v1/config/cache';

describe('legacy operational API routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithLogContext.mockImplementation((_context: unknown, callback: () => unknown) => callback());
    mockGetAllConfigs.mockResolvedValue({ ttl_cleanup: { enabled: true, maxAgeDays: 7 } });
    mockTTLQueueAdd.mockResolvedValue({ id: 'job-1' });
  });

  describe('/admin/ttl/cleanup', () => {
    it('advertises allowed methods for unsupported requests', async () => {
      const res = response();
      await ttlHandler(request({ method: 'DELETE' }), res);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'POST']);
      expect(res.statusCode).toBe(405);
    });

    it('returns TTL configuration and distinguishes missing configuration', async () => {
      const success = response();
      await ttlHandler(request(), success);
      expect(success.body).toEqual({ config: { enabled: true, maxAgeDays: 7 } });

      mockGetAllConfigs.mockResolvedValueOnce({});
      const missing = response();
      await ttlHandler(request(), missing);
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toEqual({ error: 'TTL cleanup configuration not found' });
    });

    it('maps config-service failures to the route-specific error', async () => {
      mockGetAllConfigs.mockRejectedValueOnce(new Error('config unavailable'));
      const res = response();
      await ttlHandler(request(), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Unable to retrieve TTL cleanup configuration' });
    });

    it.each([
      [undefined, false],
      [{}, false],
      [{ dryRun: true }, true],
    ])('queues manual cleanup with normalized dryRun: %j', async (body, dryRun) => {
      const res = response();
      await ttlHandler(request({ method: 'POST', body }), res);
      expect(mockTTLQueueAdd).toHaveBeenCalledWith('manual-ttl-cleanup', {
        dryRun,
        correlationId: expect.stringMatching(/^api-ttl-cleanup-\d+-fixed-id$/),
      });
      expect(res.body).toEqual({
        message: 'TTL cleanup job triggered successfully',
        jobId: 'job-1',
        dryRun,
      });
    });

    it('rejects non-boolean dryRun before creating a queue job', async () => {
      const res = response();
      await ttlHandler(request({ method: 'POST', body: { dryRun: 'true' } }), res);
      expect(res.statusCode).toBe(400);
      expect(mockTTLQueueAdd).not.toHaveBeenCalled();
    });

    it('maps queue failures to the trigger-specific error', async () => {
      mockTTLQueueAdd.mockRejectedValueOnce(new Error('queue unavailable'));
      const res = response();
      await ttlHandler(request({ method: 'POST', body: { dryRun: false } }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Unable to trigger TTL cleanup job' });
    });

    it('currently propagates failures entering log context because the inner promise is returned', async () => {
      mockWithLogContext.mockImplementationOnce(() => {
        throw new Error('context unavailable');
      });
      const res = response();
      await expect(ttlHandler(request({ method: 'POST' }), res)).rejects.toThrow('context unavailable');
      expect(res.status).not.toHaveBeenCalled();
    });

    it('maps synchronous routing failures to the outer stable error', async () => {
      const res = response();
      (res.setHeader as jest.Mock).mockImplementationOnce(() => {
        throw new Error('response unavailable');
      });
      await ttlHandler(request({ method: 'DELETE' }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'An unexpected error occurred.' });
    });
  });

  describe('/config/cache', () => {
    it.each([
      ['GET', false],
      ['PUT', true],
    ])('%s returns cached configuration with the expected refresh flag', async (method, refresh) => {
      mockGetAllConfigs.mockResolvedValueOnce({ feature: 'value' });
      const res = response();
      await cacheHandler(request({ method }), res);
      expect(mockGetAllConfigs).toHaveBeenCalledWith(refresh);
      expect(res.body).toEqual({ configs: { feature: 'value' } });
    });

    it('advertises allowed methods', async () => {
      const res = response();
      await cacheHandler(request({ method: 'POST' }), res);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'PUT']);
      expect(res.statusCode).toBe(405);
    });

    it('maps config retrieval failures to the route-specific error', async () => {
      mockGetAllConfigs.mockRejectedValueOnce(new Error('config unavailable'));
      const res = response();
      await cacheHandler(request(), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Unable to retrieve global config values' });
    });

    it('maps response failures to the outer stable error', async () => {
      const res = response();
      (res.setHeader as jest.Mock).mockImplementationOnce(() => {
        throw new Error('response unavailable');
      });
      await cacheHandler(request({ method: 'POST' }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'An unexpected error occurred.' });
    });
  });
});
