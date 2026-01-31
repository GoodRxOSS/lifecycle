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

import { ErrorCategory } from './classification';

export interface ErrorContext {
  modelName: string;
  providerName: string;
  retryAfter?: number | null;
  isAuthError?: boolean;
}

const messageBuilders: Record<ErrorCategory, (ctx: ErrorContext) => string> = {
  [ErrorCategory.RATE_LIMITED]: (ctx) =>
    ctx.retryAfter
      ? `${ctx.modelName} is rate limited. Retrying in ${ctx.retryAfter}s...`
      : `${ctx.modelName} is rate limited. Please wait and try again.`,
  [ErrorCategory.TRANSIENT]: (ctx) => `${ctx.modelName} is temporarily unavailable. Retrying...`,
  [ErrorCategory.DETERMINISTIC]: (ctx) =>
    ctx.isAuthError
      ? `${ctx.providerName} API key is invalid. Check AI agent configuration in admin settings.`
      : 'Request failed. Please try a different approach.',
  [ErrorCategory.AMBIGUOUS]: () => 'Something went wrong. Please try again.',
};

export function getUserErrorMessage(category: ErrorCategory, ctx: ErrorContext): string {
  return messageBuilders[category](ctx);
}

export function getSuggestedAction(
  category: ErrorCategory,
  authError?: boolean
): 'retry' | 'switch-model' | 'check-config' | null {
  switch (category) {
    case ErrorCategory.RATE_LIMITED:
      return 'retry';
    case ErrorCategory.TRANSIENT:
      return 'switch-model';
    case ErrorCategory.DETERMINISTIC:
      return authError ? 'check-config' : null;
    case ErrorCategory.AMBIGUOUS:
      return 'retry';
  }
}

const AUTH_ERROR_NAMES = new Set(['AuthenticationError', 'PermissionDeniedError']);
const AUTH_STATUS_CODES = new Set([401, 403]);

export function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, any>;
  if (AUTH_ERROR_NAMES.has(err.name)) return true;
  if (AUTH_STATUS_CODES.has(err.status)) return true;
  return false;
}
