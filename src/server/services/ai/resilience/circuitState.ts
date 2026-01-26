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

import { circuitBreaker, handleWhen, ConsecutiveBreaker, CircuitBreakerPolicy } from 'cockatiel';
import { isRetryable, classifyError } from '../errors';
import { getLogger } from 'server/lib/logger';

const circuitBreakers = new Map<string, CircuitBreakerPolicy>();

export function getProviderCircuitBreaker(providerName: string): CircuitBreakerPolicy {
  const existing = circuitBreakers.get(providerName);
  if (existing) return existing;

  const shouldHandle = handleWhen((err) => isRetryable(classifyError(providerName, err)));

  const breaker = circuitBreaker(shouldHandle, {
    halfOpenAfter: 30_000,
    breaker: new ConsecutiveBreaker(5),
  });

  breaker.onBreak(() => {
    getLogger().error(`AI: circuit breaker OPEN provider=${providerName}`);
  });

  breaker.onReset(() => {
    getLogger().info(`AI: circuit breaker CLOSED provider=${providerName}`);
  });

  circuitBreakers.set(providerName, breaker);
  return breaker;
}

export function resetAllCircuitBreakers(): void {
  circuitBreakers.clear();
}
