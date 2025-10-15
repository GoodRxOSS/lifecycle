import { NextRequest, NextResponse } from 'next/server';
import { PaginationMetadata } from './paginate';
import rootLogger from './logger';

const logger = rootLogger.child({
  filename: 'server/lib/standardizedResponse.ts',
});

interface Metadata {
  pagination?: PaginationMetadata;
}

interface SuccessResponse<T> {
  request_id: string | null;
  data: T | null;
  error: null;
  metadata?: Metadata;
}

interface SuccessResponseOptions {
  status?: number;
  metadata?: Metadata;
}

interface ErrorResponse {
  request_id: string | null;
  data: null;
  error: {
    message: string;
  };
}

export function successResponse<T>(data: T, options: SuccessResponseOptions = {}, req: NextRequest): NextResponse {
  const { status = 200, metadata } = options;

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

export function errorResponse(error: unknown, status: number = 500, req: NextRequest): NextResponse {
  logger.error('Error response', { error });

  const body: ErrorResponse = {
    request_id: req.headers.get('x-request-id'),
    data: null,
    error: {
      message: error instanceof Error ? error.message : 'An unknown error occurred.',
    },
  };
  return NextResponse.json(body, { status });
}
