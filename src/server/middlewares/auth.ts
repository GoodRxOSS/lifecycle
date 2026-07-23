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
import type { Middleware, NextMiddleware } from './chain';
import { verifyAuth } from 'server/lib/auth';
import { bearerChallenge } from 'server/lib/appError';
import { bearerApiKey } from 'server/lib/apiTokenShape';
import { ErrorResponse } from 'server/lib/response';

const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj ?? {}), 'utf8').toString('base64url');
const MCP_OAUTH_CALLBACK_PATH = /^\/api\/v2\/ai\/agent\/mcp-connections\/[^/]+\/oauth\/callback$/;
const MAX_AUTHORIZATION_HEADER_LENGTH = 16384;

function authFailure(request: NextRequest, status: 401 | 500, message: string, code?: string): NextResponse {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (status === 401) {
    headers['WWW-Authenticate'] = bearerChallenge(code);
  }
  return new NextResponse(
    JSON.stringify({
      request_id: request.headers.get('x-request-id'),
      error: { message, ...(code ? { code } : {}) },
      data: null,
    } satisfies ErrorResponse),
    { status, headers }
  );
}

/* eslint-disable-next-line no-unused-vars */
function forwardWithoutUser(request: NextRequest, next: NextMiddleware, mutate?: (headers: Headers) => void) {
  const headers = new Headers(request.headers);
  headers.delete('x-user'); // prevent spoofing
  mutate?.(headers);
  return next(new NextRequest(request.url, { ...request, headers }));
}

export const authMiddleware: Middleware = async (request, next) => {
  if (!request.url.includes('/api/v2/')) {
    return next(request);
  }

  const authorization = request.headers.get('authorization');
  if (authorization && (authorization.includes(',') || authorization.length > MAX_AUTHORIZATION_HEADER_LENGTH)) {
    return authFailure(request, 401, 'Invalid Authorization header.', 'invalid_credential');
  }

  if (process.env.ENABLE_AUTH !== 'true') {
    return forwardWithoutUser(request, next);
  }

  if (MCP_OAUTH_CALLBACK_PATH.test(request.nextUrl.pathname)) {
    return forwardWithoutUser(request, next);
  }

  // Edge runtime cannot reach Postgres, so key-shaped bearers are forwarded and verified in the route wrapper.
  if (bearerApiKey(authorization)) {
    return forwardWithoutUser(request, next);
  }

  const authResult = await verifyAuth(request);

  if (!authResult.success) {
    if (authResult.error?.status === 500) {
      return authFailure(request, 500, authResult.error.message);
    }
    const code = authorization ? 'invalid_credential' : 'authentication_required';
    return authFailure(request, 401, authResult.error?.message || 'Authentication is required.', code);
  }

  return forwardWithoutUser(request, next, (headers) => headers.set('x-user', encode(authResult.payload)));
};
