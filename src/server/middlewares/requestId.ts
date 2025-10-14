import { NextRequest } from 'next/server';
import type { Middleware } from './chain';

export const requestIdMiddleware: Middleware = async (request, next) => {
  const requestId = crypto.randomUUID();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);

  const newRequest = new NextRequest(request.url, {
    ...request,
    headers: requestHeaders,
  });

  const response = await next(newRequest);

  response.headers.set('x-request-id', requestId);
  return response;
};
