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

import {
  retry,
  handleWhen,
  wrap,
  ExponentialBackoff,
  type IBackoffFactory,
  type IBackoff,
  type IRetryBackoffContext,
} from 'cockatiel';
import { isRetryable, classifyError, RetryBudget, extractRetryAfter } from '../errors';
import { getProviderCircuitBreaker } from './circuitState';
import { getLogger } from 'server/lib/logger';

class RetryAfterBackoffInstance implements IBackoff<IRetryBackoffContext<unknown>> {
  readonly duration: number;
  private readonly fallback: IBackoff<unknown>;

  constructor(duration: number, fallback: IBackoff<unknown>) {
    this.duration = duration;
    this.fallback = fallback;
  }

  next(context: IRetryBackoffContext<unknown>): IBackoff<IRetryBackoffContext<unknown>> {
    const error = 'error' in context.result ? context.result.error : undefined;
    const retryAfterSeconds = error != null ? extractRetryAfter(error) : null;
    const nextFallback = this.fallback.next(context as any);
    if (retryAfterSeconds != null && retryAfterSeconds > 0) {
      return new RetryAfterBackoffInstance(retryAfterSeconds * 1000, nextFallback);
    }
    return new RetryAfterBackoffInstance(nextFallback.duration, nextFallback);
  }
}

export class RetryAfterBackoff implements IBackoffFactory<IRetryBackoffContext<unknown>> {
  private readonly fallbackFactory: ExponentialBackoff<unknown>;

  constructor(fallbackOptions?: { initialDelay?: number; maxDelay?: number; exponent?: number }) {
    this.fallbackFactory = new ExponentialBackoff({
      initialDelay: fallbackOptions?.initialDelay ?? 500,
      maxDelay: fallbackOptions?.maxDelay ?? 10_000,
      exponent: fallbackOptions?.exponent ?? 2,
    });
  }

  next(context: IRetryBackoffContext<unknown>): IBackoff<IRetryBackoffContext<unknown>> {
    const error = 'error' in context.result ? context.result.error : undefined;
    const retryAfterSeconds = error != null ? extractRetryAfter(error) : null;
    const fallbackBackoff = this.fallbackFactory.next(context as any);
    if (retryAfterSeconds != null && retryAfterSeconds > 0) {
      return new RetryAfterBackoffInstance(retryAfterSeconds * 1000, fallbackBackoff);
    }
    return new RetryAfterBackoffInstance(fallbackBackoff.duration, fallbackBackoff);
  }
}

export function createProviderPolicy(providerName: string, retryBudget: RetryBudget) {
  const shouldHandle = handleWhen((err) => {
    if (!retryBudget.canRetry()) return false;
    return isRetryable(classifyError(providerName, err));
  });

  const retryPolicy = retry(shouldHandle, {
    maxAttempts: 3,
    backoff: new RetryAfterBackoff({ initialDelay: 500, maxDelay: 10_000, exponent: 2 }),
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
