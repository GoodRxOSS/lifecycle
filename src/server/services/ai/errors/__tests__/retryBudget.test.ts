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

import { RetryBudget } from '../retryBudget';

describe('RetryBudget', () => {
  it('defaults to maxRetries=10', () => {
    const budget = new RetryBudget();
    expect(budget.used).toBe(0);
    expect(budget.exhausted).toBe(false);
    for (let i = 0; i < 10; i++) {
      expect(budget.canRetry()).toBe(true);
      budget.consume();
    }
    expect(budget.canRetry()).toBe(false);
  });

  it('canRetry returns true initially', () => {
    const budget = new RetryBudget();
    expect(budget.canRetry()).toBe(true);
  });

  it('consume decrements remaining', () => {
    const budget = new RetryBudget(3);
    expect(budget.used).toBe(0);
    budget.consume();
    expect(budget.used).toBe(1);
    budget.consume();
    expect(budget.used).toBe(2);
  });

  it('exhausted returns true after consuming all retries', () => {
    const budget = new RetryBudget(2);
    budget.consume();
    budget.consume();
    expect(budget.exhausted).toBe(true);
  });

  it('canRetry returns false when exhausted', () => {
    const budget = new RetryBudget(1);
    budget.consume();
    expect(budget.canRetry()).toBe(false);
  });

  it('used returns correct count', () => {
    const budget = new RetryBudget(5);
    expect(budget.used).toBe(0);
    budget.consume();
    budget.consume();
    budget.consume();
    expect(budget.used).toBe(3);
  });

  it('supports custom maxRetries via constructor', () => {
    const budget = new RetryBudget(3);
    budget.consume();
    budget.consume();
    budget.consume();
    expect(budget.exhausted).toBe(true);
    expect(budget.used).toBe(3);
  });

  it('reset restores budget to full', () => {
    const budget = new RetryBudget(5);
    budget.consume();
    budget.consume();
    expect(budget.used).toBe(2);
    budget.reset();
    expect(budget.used).toBe(0);
    expect(budget.canRetry()).toBe(true);
    expect(budget.exhausted).toBe(false);
  });

  it('consume does not go below 0', () => {
    const budget = new RetryBudget(1);
    budget.consume();
    budget.consume();
    budget.consume();
    expect(budget.used).toBe(1);
    expect(budget.exhausted).toBe(true);
  });
});
