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

import { ErrorCategory } from '../classification';
import { getUserErrorMessage, getSuggestedAction, isAuthError, ErrorContext } from '../userMessages';

describe('getUserErrorMessage', () => {
  const baseCtx: ErrorContext = {
    modelName: 'GPT-4o',
    providerName: 'OpenAI',
  };

  it('returns rate limit message with retry seconds', () => {
    const msg = getUserErrorMessage(ErrorCategory.RATE_LIMITED, {
      ...baseCtx,
      retryAfter: 30,
    });
    expect(msg).toBe('GPT-4o is rate limited. Retrying in 30s...');
  });

  it('returns rate limit message without retry seconds', () => {
    const msg = getUserErrorMessage(ErrorCategory.RATE_LIMITED, {
      ...baseCtx,
      retryAfter: null,
    });
    expect(msg).toBe('GPT-4o is rate limited. Please wait and try again.');
  });

  it('returns transient message', () => {
    const msg = getUserErrorMessage(ErrorCategory.TRANSIENT, {
      ...baseCtx,
      modelName: 'Claude 3.5',
    });
    expect(msg).toBe('Claude 3.5 is temporarily unavailable. Retrying...');
  });

  it('returns deterministic auth error message', () => {
    const msg = getUserErrorMessage(ErrorCategory.DETERMINISTIC, {
      ...baseCtx,
      providerName: 'Anthropic',
      isAuthError: true,
    });
    expect(msg).toBe('Anthropic API key is invalid. Check AI agent configuration in admin settings.');
  });

  it('returns deterministic non-auth error message', () => {
    const msg = getUserErrorMessage(ErrorCategory.DETERMINISTIC, {
      ...baseCtx,
      isAuthError: false,
    });
    expect(msg).toBe('Request failed. Please try a different approach.');
  });

  it('returns ambiguous fallback message', () => {
    const msg = getUserErrorMessage(ErrorCategory.AMBIGUOUS, baseCtx);
    expect(msg).toBe('Something went wrong. Please try again.');
  });
});

describe('getSuggestedAction', () => {
  it('returns retry for RATE_LIMITED', () => {
    expect(getSuggestedAction(ErrorCategory.RATE_LIMITED)).toBe('retry');
  });

  it('returns switch-model for TRANSIENT', () => {
    expect(getSuggestedAction(ErrorCategory.TRANSIENT)).toBe('switch-model');
  });

  it('returns check-config for DETERMINISTIC auth error', () => {
    expect(getSuggestedAction(ErrorCategory.DETERMINISTIC, true)).toBe('check-config');
  });

  it('returns null for DETERMINISTIC non-auth error', () => {
    expect(getSuggestedAction(ErrorCategory.DETERMINISTIC, false)).toBeNull();
  });

  it('returns retry for AMBIGUOUS', () => {
    expect(getSuggestedAction(ErrorCategory.AMBIGUOUS)).toBe('retry');
  });
});

describe('isAuthError', () => {
  it('detects 401 status', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(isAuthError(err)).toBe(true);
  });

  it('detects 403 status', () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(isAuthError(err)).toBe(true);
  });

  it('detects AuthenticationError by name', () => {
    const err = new Error('auth failed');
    err.name = 'AuthenticationError';
    expect(isAuthError(err)).toBe(true);
  });

  it('detects PermissionDeniedError by name', () => {
    const err = new Error('denied');
    err.name = 'PermissionDeniedError';
    expect(isAuthError(err)).toBe(true);
  });

  it('returns false for non-auth errors', () => {
    expect(isAuthError(new Error('something else'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError('string')).toBe(false);
  });
});
