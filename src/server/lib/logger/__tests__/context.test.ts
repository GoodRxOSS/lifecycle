/**
 * Copyright 2025 GoodRx, Inc.
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

var mockExtract: jest.Mock;
var mockStartSpan: jest.Mock;
var mockSetTag: jest.Mock;
var mockFinish: jest.Mock;
var mockActivate: jest.Mock;
var mockActive: jest.Mock;
var mockInject: jest.Mock;
var mockScope: jest.Mock;

jest.mock('dd-trace', () => {
  mockExtract = jest.fn();
  mockSetTag = jest.fn();
  mockFinish = jest.fn();
  mockStartSpan = jest.fn(() => ({ setTag: mockSetTag, finish: mockFinish }));
  mockActivate = jest.fn((_span, callback) => callback());
  mockActive = jest.fn();
  mockInject = jest.fn();
  mockScope = jest.fn(() => ({ activate: mockActivate, active: mockActive }));
  return {
    __esModule: true,
    default: {
      extract: (...args: unknown[]) => mockExtract(...args),
      startSpan: (...args: unknown[]) => mockStartSpan(...args),
      scope: (...args: unknown[]) => mockScope(...args),
      inject: (...args: unknown[]) => mockInject(...args),
    },
  };
});

import { getLogContext, withLogContext, updateLogContext, extractContextForQueue } from '../context';

describe('Logger Context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExtract.mockReturnValue(null);
    mockStartSpan.mockReturnValue({ setTag: mockSetTag, finish: mockFinish });
    mockActivate.mockImplementation((_span, callback) => callback());
    mockActive.mockReturnValue(null);
    mockScope.mockReturnValue({ activate: mockActivate, active: mockActive });
  });

  describe('getLogContext', () => {
    it('should return empty object when no context is set', () => {
      const context = getLogContext();
      expect(context).toEqual({});
    });
  });

  describe('withLogContext', () => {
    it('should set context and make it available inside the callback', async () => {
      const correlationId = 'test-correlation-id';

      await withLogContext({ correlationId }, async () => {
        const context = getLogContext();
        expect(context.correlationId).toBe(correlationId);
      });
    });

    it('should merge parent context with new context', async () => {
      const parentCorrelationId = 'parent-id';
      const buildUuid = 'build-123';

      await withLogContext({ correlationId: parentCorrelationId }, async () => {
        await withLogContext({ buildUuid }, async () => {
          const context = getLogContext();
          expect(context.correlationId).toBe(parentCorrelationId);
          expect(context.buildUuid).toBe(buildUuid);
        });
      });
    });

    it('should use child correlationId if provided', async () => {
      const parentCorrelationId = 'parent-id';
      const childCorrelationId = 'child-id';

      await withLogContext({ correlationId: parentCorrelationId }, async () => {
        await withLogContext({ correlationId: childCorrelationId }, async () => {
          const context = getLogContext();
          expect(context.correlationId).toBe(childCorrelationId);
        });
      });
    });

    it('should default to "unknown" correlationId if none provided', async () => {
      await withLogContext({}, async () => {
        const context = getLogContext();
        expect(context.correlationId).toBe('unknown');
      });
    });

    it('should work with synchronous functions', () => {
      const correlationId = 'sync-test';

      const result = withLogContext({ correlationId }, () => {
        const context = getLogContext();
        expect(context.correlationId).toBe(correlationId);
        return 'sync-result';
      });

      expect(result).toBe('sync-result');
    });

    it('should return value from async callback', async () => {
      const result = await withLogContext({ correlationId: 'test' }, async () => {
        return 'async-result';
      });

      expect(result).toBe('async-result');
    });

    it('continues without a child span when propagated trace context cannot be extracted', () => {
      mockExtract.mockReturnValueOnce(null);

      const result = withLogContext({ correlationId: 'corr-1', _ddTraceContext: { traceparent: 'invalid' } }, () =>
        getLogContext()
      );

      expect(result).toMatchObject({ correlationId: 'corr-1' });
      expect(mockExtract).toHaveBeenCalledWith('text_map', { traceparent: 'invalid' });
      expect(mockStartSpan).not.toHaveBeenCalled();
    });

    it('activates and finishes a child span around synchronous work', () => {
      const parentSpanContext = { traceId: 'parent' };
      mockExtract.mockReturnValueOnce(parentSpanContext);

      const result = withLogContext(
        {
          correlationId: 'corr-1',
          buildUuid: 'build-1',
          deployUuid: 'deploy-1',
          _ddTraceContext: { traceparent: 'valid' },
        },
        () => 'sync-result'
      );

      expect(result).toBe('sync-result');
      expect(mockStartSpan).toHaveBeenCalledWith('queue.process', { childOf: parentSpanContext });
      expect(mockSetTag).toHaveBeenNthCalledWith(1, 'correlationId', 'corr-1');
      expect(mockSetTag).toHaveBeenNthCalledWith(2, 'buildUuid', 'build-1');
      expect(mockSetTag).toHaveBeenNthCalledWith(3, 'deployUuid', 'deploy-1');
      expect(mockActivate).toHaveBeenCalledWith(expect.any(Object), expect.any(Function));
      expect(mockFinish).toHaveBeenCalledTimes(1);
    });

    it('finishes a propagated child span after asynchronous success and failure', async () => {
      mockExtract.mockReturnValue({ traceId: 'parent' });

      await expect(
        withLogContext({ correlationId: 'corr-success', _ddTraceContext: { traceparent: 'valid' } }, async () => 'ok')
      ).resolves.toBe('ok');
      expect(mockFinish).toHaveBeenCalledTimes(1);

      const failure = new Error('worker failed');
      await expect(
        withLogContext({ correlationId: 'corr-failure', _ddTraceContext: { traceparent: 'valid' } }, async () => {
          throw failure;
        })
      ).rejects.toBe(failure);
      expect(mockFinish).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateLogContext', () => {
    it('should update context within withLogContext', async () => {
      await withLogContext({ correlationId: 'initial' }, async () => {
        updateLogContext({ buildUuid: 'new-build' });

        const context = getLogContext();
        expect(context.correlationId).toBe('initial');
        expect(context.buildUuid).toBe('new-build');
      });
    });

    it('should not throw when called outside withLogContext', () => {
      expect(() => {
        updateLogContext({ buildUuid: 'test' });
      }).not.toThrow();
    });
  });

  describe('extractContextForQueue', () => {
    it('should extract only queue-relevant fields', async () => {
      await withLogContext(
        {
          correlationId: 'corr-123',
          buildUuid: 'build-456',
          deployUuid: 'deploy-789',
          service: 'my-service',
          stage: 'webhook.received',
          repo: 'owner/repo',
          pr: 42,
          branch: 'feature-branch',
          sha: 'abc1234',
        },
        async () => {
          const queueData = extractContextForQueue();

          expect(queueData).toEqual({
            correlationId: 'corr-123',
            buildUuid: 'build-456',
            deployUuid: 'deploy-789',
            repo: 'owner/repo',
            pr: 42,
            branch: 'feature-branch',
            sha: 'abc1234',
          });

          expect(queueData).not.toHaveProperty('service');
          expect(queueData).not.toHaveProperty('stage');
        }
      );
    });

    it('should return undefined values for missing fields', () => {
      const queueData = extractContextForQueue();

      expect(queueData.correlationId).toBeUndefined();
      expect(queueData.buildUuid).toBeUndefined();
    });

    it('injects the active trace span into queue context', async () => {
      const activeSpan = { spanId: 'active' };
      mockActive.mockReturnValueOnce(activeSpan);
      mockInject.mockImplementationOnce((_span, _format, carrier) => {
        carrier.traceparent = '00-trace-parent';
      });

      await withLogContext(
        {
          correlationId: 'corr-123',
          serviceName: 'api',
          sender: 'webhook',
        },
        async () => {
          expect(extractContextForQueue()).toEqual({
            correlationId: 'corr-123',
            buildUuid: undefined,
            deployUuid: undefined,
            serviceName: 'api',
            sender: 'webhook',
            repo: undefined,
            pr: undefined,
            branch: undefined,
            sha: undefined,
            _ddTraceContext: { traceparent: '00-trace-parent' },
          });
        }
      );

      expect(mockInject).toHaveBeenCalledWith(activeSpan, 'text_map', expect.any(Object));
    });
  });
});
