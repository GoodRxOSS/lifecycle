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

/* eslint-disable no-unused-vars */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export type NextMiddleware = (request: NextRequest) => Promise<NextResponse>;

export type Middleware = (request: NextRequest, next: NextMiddleware) => Promise<NextResponse>;

export function chain(middlewares: Middleware[]): NextMiddleware {
  const finalNext: NextMiddleware = async (request) => {
    return NextResponse.next({ request });
  };

  return middlewares
    .slice()
    .reverse()
    .reduce<NextMiddleware>((next, middleware) => {
      return async (request: NextRequest) => {
        return middleware(request, next);
      };
    }, finalNext);
}
