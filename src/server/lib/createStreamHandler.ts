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

import { NextRequest } from 'next/server';
import { getLogger } from 'server/lib/logger';

// eslint-disable-next-line no-unused-vars
type StreamRouteHandler = (req: NextRequest, ...args: any[]) => Promise<Response>;

export function createStreamHandler(handler: StreamRouteHandler): StreamRouteHandler {
  return async (req: NextRequest, ...args: any[]) => {
    try {
      return await handler(req, ...args);
    } catch (error) {
      let errorMessage = 'An unexpected error occurred.';
      let errorStack = '';

      if (error instanceof Error) {
        errorMessage = error.message;
        errorStack = error.stack || '';
      }

      getLogger().error({ error, stack: errorStack }, `API: stream handler error message=${errorMessage}`);

      const encoder = new TextEncoder();
      const body = encoder.encode(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);

      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }
  };
}
