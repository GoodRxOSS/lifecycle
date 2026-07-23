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

import { NextRequest, NextResponse } from 'next/server';
import { PaginationMetadata } from './paginate';
import { getLogger } from 'server/lib/logger';
import { isAppError, toErrorResponseError, type AppErrorAction } from './appError';

interface Metadata {
  pagination?: PaginationMetadata;
  limit?: number;
  maxLimit?: number;
}

type SuccessStatusCode = 200 | 201 | 202;

type ErrorStatusCode = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 502 | 503;

interface SuccessResponse<T> {
  request_id: string;
  data: T | null;
  error: null;
  metadata?: Metadata;
}

interface SuccessResponseOptions {
  status: SuccessStatusCode;
  metadata?: Metadata;
}

export interface ErrorResponse {
  request_id: string;
  data: unknown | null;
  error: {
    message: string;
    /** Stable, machine-readable discriminant. The UI switches on this, not on the message. */
    code?: string;
    details?: Record<string, unknown>;
    nextAction?: AppErrorAction;
  };
}

interface ErrorResponseOptions {
  status: ErrorStatusCode;
  data?: unknown | null;
}

export function successResponse<T>(data: T, options: SuccessResponseOptions, req: NextRequest): NextResponse {
  const { status, metadata } = options;

  const body: SuccessResponse<T> = {
    request_id: req.headers.get('x-request-id') || '',
    data,
    error: null,
  };

  if (metadata) {
    body.metadata = metadata;
  }

  return NextResponse.json(body, { status });
}

/** SECURITY: issue-once credential responses must never be cached by browsers or intermediaries. */
export function withNoStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

export function errorResponse(error: unknown, options: ErrorResponseOptions, req: NextRequest): NextResponse {
  let errorMessage = 'An unexpected error occurred.';
  let errorStack = '';

  if (error instanceof Error) {
    errorMessage = error.message;
    errorStack = error.stack || '';
  }

  // Honor AppError.httpStatus so a 409/422/etc. isn't shipped as the caller's default 500.
  const status = isAppError(error) ? (error.httpStatus as ErrorStatusCode) : options.status;

  const appErrorCode = isAppError(error) ? error.code : undefined;
  getLogger().error(
    { error, stack: errorStack, code: appErrorCode, status },
    `API: error message=${errorMessage}${appErrorCode ? ` code=${appErrorCode}` : ''}`
  );

  const body: ErrorResponse = {
    request_id: req.headers.get('x-request-id') || '',
    data: options.data ?? null,
    error: toErrorResponseError(error),
  };
  return NextResponse.json(body, { status });
}
