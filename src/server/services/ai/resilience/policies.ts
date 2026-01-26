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

import { retry, handleWhen, wrap, ExponentialBackoff } from 'cockatiel';
import { isRetryable, classifyError, RetryBudget } from '../errors';
import { getProviderCircuitBreaker } from './circuitState';
import { getLogger } from 'server/lib/logger';

export function createProviderPolicy(providerName: string, retryBudget: RetryBudget) {
  const shouldHandle = handleWhen((err) => {
    if (!retryBudget.canRetry()) return false;
    return isRetryable(classifyError(providerName, err));
  });

  const retryPolicy = retry(shouldHandle, {
    maxAttempts: 3,
    backoff: new ExponentialBackoff({ initialDelay: 500, maxDelay: 10_000, exponent: 2 }),
  });

  retryPolicy.onRetry((reason) => {
    retryBudget.consume();
    const errorMessage = 'error' in reason ? reason.error.message : 'unknown';
    getLogger().warn(
      `AI: retrying provider=${providerName} error=${errorMessage} budgetRemaining=${
        retryBudget.canRetry() ? 'yes' : 'exhausted'
      }`
    );
  });

  const breakerPolicy = getProviderCircuitBreaker(providerName);

  return wrap(retryPolicy, breakerPolicy);
}
