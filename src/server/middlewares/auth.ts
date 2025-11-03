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
import type { Middleware } from './chain';
import { verifyAuth } from 'server/lib/auth';
import { ErrorResponse } from 'server/lib/response';

const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj ?? {}), 'utf8').toString('base64url');

export const authMiddleware: Middleware = async (request, next) => {
  if (!request.url.includes('/api/v2/')) {
    return next(request);
  }

  const authResult = await verifyAuth(request);

  if (!authResult.success) {
    return new NextResponse(
      JSON.stringify({
        request_id: request.headers.get('x-request-id'),
        error: { message: authResult.error?.message || 'Unauthorized' },
        data: null,
      } satisfies ErrorResponse),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const headers = new Headers(request.headers);
  headers.delete('x-user'); // prevent spoofing
  headers.set('x-user', encode(authResult.payload));

  const newRequest = new NextRequest(request.url, { ...request, headers });
  return next(newRequest);
};
