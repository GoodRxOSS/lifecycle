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
