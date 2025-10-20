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
import { errorResponse } from './response';

/**
 * Defines the shape of a Next.js route handler function.
 */
// eslint-disable-next-line no-unused-vars
type RouteHandler = (req: NextRequest, ...args: any[]) => Promise<NextResponse>;

/**
 * A higher-order function that wraps a Next.js route handler with
 * a try-catch block to handle errors gracefully.
 *
 * @param handler The route handler function to wrap.
 * @returns A new route handler function with error handling.
 */
export function createApiHandler(handler: RouteHandler): RouteHandler {
  return async (req: NextRequest, ...args: any[]) => {
    try {
      return await handler(req, ...args);
    } catch (error) {
      return errorResponse(error, { status: 500 }, req);
    }
  };
}
