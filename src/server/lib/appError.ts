/**
 * Copyright 2026 GoodRx, Inc.
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

/** Machine-readable API error contract: httpStatus + stable code + optional recovery action. */

export type AppErrorActionKind = 'continue' | 'retry' | 'reconnect' | 'update_key' | 'navigate';

export interface AppErrorAction {
  kind: AppErrorActionKind;
  label: string;
  href?: string;
}

export interface AppErrorParams {
  httpStatus: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  nextAction?: AppErrorAction;
  /** Whether the same request is worth retrying as-is (rate limits, transient 5xx). */
  retryable?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly nextAction?: AppErrorAction;
  readonly retryable: boolean;

  constructor(params: AppErrorParams) {
    super(params.message);
    this.name = 'AppError';
    this.httpStatus = params.httpStatus;
    this.code = params.code;
    this.details = params.details;
    this.nextAction = params.nextAction;
    this.retryable = params.retryable ?? false;
    if (params.cause !== undefined) {
      (this as { cause?: unknown }).cause = params.cause;
    }
  }
}

/** True for AppError or any error duck-typing its fields (httpStatus + code), so classes can opt in mid-migration. */
export function isAppError(error: unknown): error is AppError {
  if (error instanceof AppError) {
    return true;
  }
  return (
    error instanceof Error &&
    typeof (error as { httpStatus?: unknown }).httpStatus === 'number' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** Common HTTP error shapes so routes/services throw a typed error instead of hand-building a response. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication is required.', details?: Record<string, unknown>) {
    super({ httpStatus: 401, code: 'unauthorized', message, details });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource.', details?: Record<string, unknown>) {
    super({ httpStatus: 403, code: 'forbidden', message, details });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(
    message = 'The requested resource was not found.',
    code = 'not_found',
    details?: Record<string, unknown>
  ) {
    super({ httpStatus: 404, code, message, details });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'conflict', details?: Record<string, unknown>) {
    super({ httpStatus: 409, code, message, details });
    this.name = 'ConflictError';
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code = 'bad_request', details?: Record<string, unknown>) {
    super({ httpStatus: 400, code, message, details });
    this.name = 'BadRequestError';
  }
}

/** RFC 6750 §3: bare challenge when no credential was presented; error="invalid_token" when one was rejected. */
export function bearerChallenge(code: string | undefined): string {
  return code === 'invalid_credential' ? 'Bearer realm="lifecycle", error="invalid_token"' : 'Bearer realm="lifecycle"';
}

export interface SerializedAppError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
  nextAction?: AppErrorAction;
}

export function toErrorResponseError(error: unknown): SerializedAppError {
  if (isAppError(error)) {
    return {
      message: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
      ...(error.nextAction ? { nextAction: error.nextAction } : {}),
    };
  }
  return {
    message: error instanceof Error ? error.message : 'An unknown error occurred.',
  };
}
