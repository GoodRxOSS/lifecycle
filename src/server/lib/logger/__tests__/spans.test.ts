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

import { withSpan } from '../spans';
import { withLogContext } from '../context';

const mockSetTag = jest.fn();
const mockSpan = {
  setTag: mockSetTag,
};

jest.mock('dd-trace', () => ({
  trace: jest.fn((_name, _options, fn) => fn(mockSpan)),
}));

describe('spans', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('withSpan', () => {
    it('should execute the function and return its result', async () => {
      const result = await withSpan('test.operation', async () => {
        return 'test-result';
      });

      expect(result).toBe('test-result');
    });

    it('should set success tag on successful completion', async () => {
      await withSpan('test.operation', async () => {
        return 'success';
      });

      expect(mockSetTag).toHaveBeenCalledWith('lifecycle.success', true);
    });

    it('should set error tags on failure and rethrow', async () => {
      const testError = new Error('Test error');

      await expect(
        withSpan('test.operation', async () => {
          throw testError;
        })
      ).rejects.toThrow('Test error');

      expect(mockSetTag).toHaveBeenCalledWith('error', true);
      expect(mockSetTag).toHaveBeenCalledWith('lifecycle.success', false);
      expect(mockSetTag).toHaveBeenCalledWith('error.message', 'Test error');
    });

    it('should include context from AsyncLocalStorage', async () => {
      const tracer = require('dd-trace');

      await withLogContext(
        {
          correlationId: 'corr-123',
          buildUuid: 'build-456',
          repo: 'owner/repo',
        },
        async () => {
          await withSpan('test.operation', async () => 'result');
        }
      );

      expect(tracer.trace).toHaveBeenCalledWith(
        'test.operation',
        expect.objectContaining({
          tags: expect.objectContaining({
            'lifecycle.correlation_id': 'corr-123',
            'lifecycle.build_uuid': 'build-456',
            'lifecycle.repo': 'owner/repo',
          }),
        }),
        expect.any(Function)
      );
    });

    it('should accept custom resource and tags', async () => {
      const tracer = require('dd-trace');

      await withSpan('test.operation', async () => 'result', {
        resource: 'custom-resource',
        tags: { customTag: 'customValue' },
      });

      expect(tracer.trace).toHaveBeenCalledWith(
        'test.operation',
        expect.objectContaining({
          resource: 'custom-resource',
          tags: expect.objectContaining({
            customTag: 'customValue',
          }),
        }),
        expect.any(Function)
      );
    });
  });
});
