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

import { withLogContext } from '../context';

const mockChild = jest.fn().mockReturnValue({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

jest.mock('../../rootLogger', () => ({
  __esModule: true,
  default: {
    child: (...args: unknown[]) => mockChild(...args),
  },
}));

jest.mock('dd-trace', () => ({
  scope: jest.fn(() => ({
    active: jest.fn(() => null),
  })),
}));

import { getLogger } from '../contextLogger';

describe('contextLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getLogger', () => {
    it('should pass AsyncLocalStorage context to logger.child()', async () => {
      await withLogContext(
        {
          correlationId: 'test-corr-id',
          buildUuid: 'build-123',
          deployUuid: 'deploy-456',
          repo: 'owner/repo',
          pr: 42,
          branch: 'feature-branch',
        },
        async () => {
          getLogger();

          expect(mockChild).toHaveBeenCalledWith(
            expect.objectContaining({
              correlationId: 'test-corr-id',
              buildUuid: 'build-123',
              deployUuid: 'deploy-456',
              repo: 'owner/repo',
              pr: 42,
              branch: 'feature-branch',
            })
          );
        }
      );
    });

    it('should merge extra params with async context', async () => {
      await withLogContext(
        {
          correlationId: 'test-corr-id',
          buildUuid: 'build-123',
        },
        async () => {
          getLogger({ stage: 'webhook.received', customField: 'custom-value' });

          expect(mockChild).toHaveBeenCalledWith(
            expect.objectContaining({
              correlationId: 'test-corr-id',
              buildUuid: 'build-123',
              stage: 'webhook.received',
              customField: 'custom-value',
            })
          );
        }
      );
    });

    it('should allow extra params to override async context stage', async () => {
      await withLogContext(
        {
          correlationId: 'test-corr-id',
          stage: 'original-stage',
        },
        async () => {
          getLogger({ stage: 'overridden-stage' });

          expect(mockChild).toHaveBeenCalledWith(
            expect.objectContaining({
              stage: 'overridden-stage',
            })
          );
        }
      );
    });

    it('should filter out undefined values from context', async () => {
      await withLogContext(
        {
          correlationId: 'test-corr-id',
        },
        async () => {
          getLogger();

          const passedContext = mockChild.mock.calls[0][0];

          expect(passedContext).toHaveProperty('correlationId', 'test-corr-id');
          expect(passedContext).not.toHaveProperty('buildUuid');
          expect(passedContext).not.toHaveProperty('deployUuid');
          expect(passedContext).not.toHaveProperty('service');
        }
      );
    });

    it('should work outside of withLogContext with minimal context', () => {
      getLogger({ stage: 'test-stage' });

      const passedContext = mockChild.mock.calls[0][0];

      expect(passedContext).toHaveProperty('stage', 'test-stage');
      expect(passedContext).not.toHaveProperty('correlationId');
    });

    it('should include dd-trace context when span is active', async () => {
      const tracer = require('dd-trace');
      tracer.scope.mockReturnValueOnce({
        active: jest.fn(() => ({
          context: () => ({
            toTraceId: () => 'trace-123',
            toSpanId: () => 'span-456',
          }),
        })),
      });

      getLogger();

      expect(mockChild).toHaveBeenCalledWith(
        expect.objectContaining({
          'dd.trace_id': 'trace-123',
          'dd.span_id': 'span-456',
        })
      );
    });

    it('should not include dd-trace context when no span is active', () => {
      getLogger();

      const passedContext = mockChild.mock.calls[0][0];

      expect(passedContext).not.toHaveProperty('dd.trace_id');
      expect(passedContext).not.toHaveProperty('dd.span_id');
    });
  });
});
