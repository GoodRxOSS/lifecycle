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

export enum ErrorCategory {
  TRANSIENT = 'transient',
  RATE_LIMITED = 'rate-limited',
  DETERMINISTIC = 'deterministic',
  AMBIGUOUS = 'ambiguous',
}

export interface ClassifiedError {
  category: ErrorCategory;
  original: Error;
  retryable: boolean;
  providerName: string;
  httpStatus?: number;
  finishReason?: string;
  retryAfter?: number | null;
}

export function isRetryable(category: ErrorCategory): boolean {
  return (
    category === ErrorCategory.TRANSIENT ||
    category === ErrorCategory.RATE_LIMITED ||
    category === ErrorCategory.AMBIGUOUS
  );
}

export function isRateLimitError(error: any): boolean {
  return (
    error?.status === 429 ||
    error?.error?.error?.type === 'rate_limit_error' ||
    error?.message?.includes('RATE_LIMIT_EXCEEDED') ||
    error?.message?.includes('quota exceeded')
  );
}
