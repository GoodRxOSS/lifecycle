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

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { ApiError as GeminiApiError } from '@google/genai';
import { ErrorCategory } from '../classification';
import {
  classifyOpenAIError,
  classifyAnthropicError,
  classifyGeminiError,
  classifyError,
  createClassifiedError,
} from '../providerErrors';

const emptyHeaders = new Headers();

describe('classifyOpenAIError', () => {
  it('maps RateLimitError to RATE_LIMITED', () => {
    const err = new OpenAI.RateLimitError(429, undefined, 'rate limited', emptyHeaders);
    expect(classifyOpenAIError(err)).toBe(ErrorCategory.RATE_LIMITED);
  });

  it('maps InternalServerError to TRANSIENT', () => {
    const err = new OpenAI.InternalServerError(500, undefined, 'internal', emptyHeaders);
    expect(classifyOpenAIError(err)).toBe(ErrorCategory.TRANSIENT);
  });

  it('maps APIConnectionError to TRANSIENT', () => {
    const err = new OpenAI.APIConnectionError({ message: 'connection error' });
    expect(classifyOpenAIError(err)).toBe(ErrorCategory.TRANSIENT);
  });

  it('maps BadRequestError to DETERMINISTIC', () => {
    const err = new OpenAI.BadRequestError(400, undefined, 'bad request', emptyHeaders);
    expect(classifyOpenAIError(err)).toBe(ErrorCategory.DETERMINISTIC);
  });

  it('maps AuthenticationError to DETERMINISTIC', () => {
    const err = new OpenAI.AuthenticationError(401, undefined, 'auth error', emptyHeaders);
    expect(classifyOpenAIError(err)).toBe(ErrorCategory.DETERMINISTIC);
  });

  it('maps unknown Error to AMBIGUOUS', () => {
    const err = new Error('something unexpected');
    expect(classifyOpenAIError(err)).toBe(ErrorCategory.AMBIGUOUS);
  });
});

describe('classifyAnthropicError', () => {
  it('maps RateLimitError to RATE_LIMITED', () => {
    const err = new Anthropic.RateLimitError(429, undefined, 'rate limited', emptyHeaders);
    expect(classifyAnthropicError(err)).toBe(ErrorCategory.RATE_LIMITED);
  });

  it('maps InternalServerError to TRANSIENT', () => {
    const err = new Anthropic.InternalServerError(500, undefined, 'internal', emptyHeaders);
    expect(classifyAnthropicError(err)).toBe(ErrorCategory.TRANSIENT);
  });

  it('maps BadRequestError to DETERMINISTIC', () => {
    const err = new Anthropic.BadRequestError(400, undefined, 'bad request', emptyHeaders);
    expect(classifyAnthropicError(err)).toBe(ErrorCategory.DETERMINISTIC);
  });

  it('maps unknown Error to AMBIGUOUS', () => {
    const err = new Error('something unexpected');
    expect(classifyAnthropicError(err)).toBe(ErrorCategory.AMBIGUOUS);
  });
});

describe('classifyGeminiError', () => {
  it('maps GeminiApiError with status 429 to RATE_LIMITED', () => {
    const err = new GeminiApiError({ message: 'rate limited', status: 429 });
    expect(classifyGeminiError(err)).toBe(ErrorCategory.RATE_LIMITED);
  });

  it('maps GeminiApiError with status >= 500 to TRANSIENT', () => {
    const err = new GeminiApiError({ message: 'server error', status: 500 });
    expect(classifyGeminiError(err)).toBe(ErrorCategory.TRANSIENT);
  });

  it('maps GeminiApiError with status 400 to DETERMINISTIC', () => {
    const err = new GeminiApiError({ message: 'bad request', status: 400 });
    expect(classifyGeminiError(err)).toBe(ErrorCategory.DETERMINISTIC);
  });

  it('maps error with MALFORMED_FUNCTION_CALL to TRANSIENT', () => {
    const err = new Error('Gemini MALFORMED_FUNCTION_CALL detected');
    expect(classifyGeminiError(err)).toBe(ErrorCategory.TRANSIENT);
  });

  it('maps error with empty response and STOP to AMBIGUOUS', () => {
    const err = new Error('Gemini returned an empty response. finishReason: STOP');
    expect(classifyGeminiError(err)).toBe(ErrorCategory.AMBIGUOUS);
  });

  it('maps unknown Error to AMBIGUOUS', () => {
    const err = new Error('something unexpected');
    expect(classifyGeminiError(err)).toBe(ErrorCategory.AMBIGUOUS);
  });
});

describe('classifyError', () => {
  it('dispatches to classifyOpenAIError for openai', () => {
    const err = new OpenAI.RateLimitError(429, undefined, 'rate limited', emptyHeaders);
    expect(classifyError('openai', err)).toBe(ErrorCategory.RATE_LIMITED);
  });

  it('dispatches to classifyAnthropicError for anthropic', () => {
    const err = new Anthropic.InternalServerError(500, undefined, 'internal', emptyHeaders);
    expect(classifyError('anthropic', err)).toBe(ErrorCategory.TRANSIENT);
  });

  it('dispatches to classifyGeminiError for gemini', () => {
    const err = new GeminiApiError({ message: 'rate limited', status: 429 });
    expect(classifyError('gemini', err)).toBe(ErrorCategory.RATE_LIMITED);
  });

  it('returns AMBIGUOUS for unknown provider', () => {
    const err = new Error('some error');
    expect(classifyError('unknown-provider', err)).toBe(ErrorCategory.AMBIGUOUS);
  });
});

describe('createClassifiedError', () => {
  it('returns a ClassifiedError with all fields populated', () => {
    const err = new OpenAI.InternalServerError(500, undefined, 'internal', emptyHeaders);
    const classified = createClassifiedError('openai', err);
    expect(classified.category).toBe(ErrorCategory.TRANSIENT);
    expect(classified.original).toBe(err);
    expect(classified.retryable).toBe(true);
    expect(classified.providerName).toBe('openai');
  });

  it('sets retryable=true for transient errors', () => {
    const err = new OpenAI.InternalServerError(500, undefined, 'internal', emptyHeaders);
    const classified = createClassifiedError('openai', err);
    expect(classified.retryable).toBe(true);
  });

  it('sets retryable=false for deterministic errors', () => {
    const err = new OpenAI.BadRequestError(400, undefined, 'bad', emptyHeaders);
    const classified = createClassifiedError('openai', err);
    expect(classified.retryable).toBe(false);
  });

  it('extracts httpStatus from error.status', () => {
    const err = new OpenAI.RateLimitError(429, undefined, 'rate limited', emptyHeaders);
    const classified = createClassifiedError('openai', err);
    expect(classified.httpStatus).toBe(429);
  });

  it('wraps non-Error values in new Error', () => {
    const classified = createClassifiedError('openai', 'string error');
    expect(classified.original).toBeInstanceOf(Error);
    expect(classified.original.message).toBe('string error');
    expect(classified.category).toBe(ErrorCategory.AMBIGUOUS);
  });
});
