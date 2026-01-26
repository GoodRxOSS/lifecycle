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
import { ErrorCategory, ClassifiedError, isRetryable } from './classification';

export function classifyOpenAIError(error: unknown): ErrorCategory {
  if (error instanceof OpenAI.RateLimitError) return ErrorCategory.RATE_LIMITED;
  if (error instanceof OpenAI.InternalServerError) return ErrorCategory.TRANSIENT;
  if (error instanceof OpenAI.APIConnectionError) return ErrorCategory.TRANSIENT;
  if (error instanceof OpenAI.ConflictError) return ErrorCategory.TRANSIENT;
  if (error instanceof OpenAI.BadRequestError) return ErrorCategory.DETERMINISTIC;
  if (error instanceof OpenAI.AuthenticationError) return ErrorCategory.DETERMINISTIC;
  if (error instanceof OpenAI.PermissionDeniedError) return ErrorCategory.DETERMINISTIC;
  if (error instanceof OpenAI.NotFoundError) return ErrorCategory.DETERMINISTIC;
  if (error instanceof OpenAI.UnprocessableEntityError) return ErrorCategory.DETERMINISTIC;
  return ErrorCategory.AMBIGUOUS;
}

export function classifyAnthropicError(error: unknown): ErrorCategory {
  if (error instanceof Anthropic.RateLimitError) return ErrorCategory.RATE_LIMITED;
  if (error instanceof Anthropic.InternalServerError) return ErrorCategory.TRANSIENT;
  if (error instanceof Anthropic.APIConnectionError) return ErrorCategory.TRANSIENT;
  if (error instanceof Anthropic.ConflictError) return ErrorCategory.TRANSIENT;
  if (error instanceof Anthropic.BadRequestError) return ErrorCategory.DETERMINISTIC;
  if (error instanceof Anthropic.AuthenticationError) return ErrorCategory.DETERMINISTIC;
  if (error instanceof Anthropic.PermissionDeniedError) return ErrorCategory.DETERMINISTIC;
  if (error instanceof Anthropic.NotFoundError) return ErrorCategory.DETERMINISTIC;
  if (error instanceof Anthropic.UnprocessableEntityError) return ErrorCategory.DETERMINISTIC;
  return ErrorCategory.AMBIGUOUS;
}

export function classifyGeminiError(error: unknown): ErrorCategory {
  if (error instanceof GeminiApiError) {
    if (error.status === 429) return ErrorCategory.RATE_LIMITED;
    if (error.status !== undefined && error.status >= 500) return ErrorCategory.TRANSIENT;
    if (error.status === 400 || error.status === 401 || error.status === 403) return ErrorCategory.DETERMINISTIC;
  }
  if (error instanceof Error) {
    if (error.message.includes('MALFORMED_FUNCTION_CALL')) return ErrorCategory.TRANSIENT;
    if (error.message.includes('empty response') && error.message.includes('STOP')) return ErrorCategory.AMBIGUOUS;
  }
  return ErrorCategory.AMBIGUOUS;
}

export function classifyError(providerName: string, error: unknown): ErrorCategory {
  switch (providerName) {
    case 'openai':
      return classifyOpenAIError(error);
    case 'anthropic':
      return classifyAnthropicError(error);
    case 'gemini':
      return classifyGeminiError(error);
    default:
      return ErrorCategory.AMBIGUOUS;
  }
}

export function createClassifiedError(providerName: string, error: unknown): ClassifiedError {
  const category = classifyError(providerName, error);
  const original = error instanceof Error ? error : new Error(String(error));
  return {
    category,
    original,
    retryable: isRetryable(category),
    providerName,
    httpStatus: (error as any)?.status ?? (error as any)?.statusCode,
    finishReason: (error as any)?.finishReason,
  };
}
