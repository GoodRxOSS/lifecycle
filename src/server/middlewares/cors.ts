import { NextResponse } from 'next/server';
import type { Middleware } from './chain';

const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.LIFECYCLE_UI_URL,
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const corsMiddleware: Middleware = async (request, next) => {
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: corsHeaders });
  }

  const response = await next(request);

  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  return response;
};
