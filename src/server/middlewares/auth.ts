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

import { NextResponse } from 'next/server';
import type { Middleware } from './chain';
import { verifyAuth } from 'server/lib/auth';

export const authMiddleware: Middleware = async (request, next) => {
  if (request.url.includes('/api/v2/')) {
    const authResult = await verifyAuth(request);

    if (!authResult.success) {
      return new NextResponse(JSON.stringify({ success: false, message: authResult.error?.message }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return next(request);
};
