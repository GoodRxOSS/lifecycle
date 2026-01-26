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

import { ErrorCategory, isRetryable } from '../classification';

describe('ErrorCategory', () => {
  it('has exactly 4 values', () => {
    const values = Object.values(ErrorCategory);
    expect(values).toHaveLength(4);
    expect(values).toContain('transient');
    expect(values).toContain('rate-limited');
    expect(values).toContain('deterministic');
    expect(values).toContain('ambiguous');
  });
});

describe('isRetryable', () => {
  it('returns true for TRANSIENT', () => {
    expect(isRetryable(ErrorCategory.TRANSIENT)).toBe(true);
  });

  it('returns true for RATE_LIMITED', () => {
    expect(isRetryable(ErrorCategory.RATE_LIMITED)).toBe(true);
  });

  it('returns true for AMBIGUOUS', () => {
    expect(isRetryable(ErrorCategory.AMBIGUOUS)).toBe(true);
  });

  it('returns false for DETERMINISTIC', () => {
    expect(isRetryable(ErrorCategory.DETERMINISTIC)).toBe(false);
  });
});
