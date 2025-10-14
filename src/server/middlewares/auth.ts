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
