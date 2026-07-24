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

import { getLogContext, withLogContext, updateLogContext, extractContextForQueue } from '../context';

describe('Logger Context', () => {
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
  });
});
