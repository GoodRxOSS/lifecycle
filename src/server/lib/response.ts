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
import { getLogger } from 'server/lib/logger/index';

interface Metadata {
  pagination?: PaginationMetadata;
}

type SuccessStatusCode = 200 | 201;

type ErrorStatusCode = 400 | 401 | 404 | 500 | 502;

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
  data: null;
  error: {
    message: string;
  };
}

interface ErrorResponseOptions {
  status: ErrorStatusCode;
}

export function successResponse<T>(data: T, options: SuccessResponseOptions, req: NextRequest): NextResponse {
  const { status, metadata } = options;

  const body: SuccessResponse<T> = {
    request_id: req.headers.get('x-request-id'),
    data,
    error: null,
  };

  if (metadata) {
    body.metadata = metadata;
  }

  return NextResponse.json(body, { status });
}

export function errorResponse(error: unknown, options: ErrorResponseOptions, req: NextRequest): NextResponse {
  let errorMessage = 'An unexpected error occurred.';
  let errorStack = '';

  if (error instanceof Error) {
    errorMessage = error.message;
    errorStack = error.stack || '';
  }

  getLogger().error({ error, stack: errorStack }, `API: error message=${errorMessage}`);

  const { status } = options;

  const body: ErrorResponse = {
    request_id: req.headers.get('x-request-id'),
    data: null,
    error: {
      message: error instanceof Error ? error.message : 'An unknown error occurred.',
    },
  };
  return NextResponse.json(body, { status });
}
