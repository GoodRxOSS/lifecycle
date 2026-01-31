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

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { ErrorCategory } from '../../errors/classification';
import { RetryBudget } from '../../errors/retryBudget';

const mockClassifyError = jest.fn();
jest.mock('../../errors', () => ({
  ...jest.requireActual('../../errors/classification'),
  ...jest.requireActual('../../errors/retryBudget'),
  classifyError: (...args: unknown[]) => mockClassifyError(...args),
  isRetryable: jest.requireActual('../../errors/classification').isRetryable,
  RetryBudget: jest.requireActual('../../errors/retryBudget').RetryBudget,
  ErrorCategory: jest.requireActual('../../errors/classification').ErrorCategory,
  extractRetryAfter: jest.requireActual('../../errors/providerErrors').extractRetryAfter,
}));

import { createProviderPolicy } from '../policies';
import { getProviderCircuitBreaker, resetAllCircuitBreakers } from '../circuitState';

beforeEach(() => {
  mockClassifyError.mockReset();
  resetAllCircuitBreakers();
});

describe('createProviderPolicy', () => {
  it('returns the result of a succeeding function without retry', async () => {
    const budget = new RetryBudget(3);
    const policy = createProviderPolicy('openai', budget);
    const result = await policy.execute(() => 'success');
    expect(result).toBe('success');
    expect(budget.used).toBe(0);
  });

  it('retries on transient error and succeeds on second attempt', async () => {
    mockClassifyError.mockReturnValue(ErrorCategory.TRANSIENT);
    const budget = new RetryBudget(3);
    const policy = createProviderPolicy('openai', budget);

    let callCount = 0;
    const result = await policy.execute(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error('transient failure');
      }
      return 'recovered';
    });

    expect(result).toBe('recovered');
    expect(callCount).toBe(2);
    expect(budget.used).toBe(1);
  });

  it('does not retry deterministic errors', async () => {
    mockClassifyError.mockReturnValue(ErrorCategory.DETERMINISTIC);
    const budget = new RetryBudget(3);
    const policy = createProviderPolicy('openai', budget);

    let callCount = 0;
    await expect(
      policy.execute(() => {
        callCount++;
        throw new Error('bad request');
      })
    ).rejects.toThrow('bad request');

    expect(callCount).toBe(1);
    expect(budget.used).toBe(0);
  });

  it('consumes retry budget on each retry', async () => {
    mockClassifyError.mockReturnValue(ErrorCategory.TRANSIENT);
    const budget = new RetryBudget(2);
    const policy = createProviderPolicy('openai', budget);

    let callCount = 0;
    const result = await policy.execute(() => {
      callCount++;
      if (callCount <= 2) {
        throw new Error('transient');
      }
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(budget.used).toBe(2);
    expect(budget.exhausted).toBe(true);
  });

  it('stops retrying when budget is exhausted', async () => {
    mockClassifyError.mockReturnValue(ErrorCategory.TRANSIENT);
    const budget = new RetryBudget(1);
    budget.consume();
    expect(budget.exhausted).toBe(true);

    const policy = createProviderPolicy('openai', budget);

    let callCount = 0;
    await expect(
      policy.execute(() => {
        callCount++;
        throw new Error('transient');
      })
    ).rejects.toThrow('transient');

    expect(callCount).toBe(1);
  });
});

describe('getProviderCircuitBreaker', () => {
  it('returns the same instance for the same provider', () => {
    const a = getProviderCircuitBreaker('openai');
    const b = getProviderCircuitBreaker('openai');
    expect(a).toBe(b);
  });

  it('returns different instances for different providers', () => {
    const a = getProviderCircuitBreaker('openai');
    const b = getProviderCircuitBreaker('gemini');
    expect(a).not.toBe(b);
  });

  it('clears all instances on resetAllCircuitBreakers', () => {
    const before = getProviderCircuitBreaker('openai');
    resetAllCircuitBreakers();
    const after = getProviderCircuitBreaker('openai');
    expect(before).not.toBe(after);
  });
});
