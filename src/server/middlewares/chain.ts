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
