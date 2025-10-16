import { NextRequest, NextResponse } from 'next/server';
import { PaginationMetadata } from './paginate';
import rootLogger from './logger';

const logger = rootLogger.child({
  filename: 'server/lib/standardizedResponse.ts',
});

interface Metadata {
  pagination?: PaginationMetadata;
}

type SuccessStatusCode = 200 | 201;

type ErrorStatusCode = 400 | 401 | 404 | 500;

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

interface ErrorResponse {
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

  logger.error(`API Error: ${errorMessage}`, { stack: errorStack });

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
