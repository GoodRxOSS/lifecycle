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
import type { NextRequest } from 'next/server';

/**
 * List of public API routes that do NOT require authentication
 */
const PUBLIC_API_ROUTES = [
  '/api/health',
  '/api/jobs',
  '/api/webhooks/github',
  '/api/v1/setup/index',
  '/api/v1/setup/callback',
  '/api/v1/setup/installed',
  '/api/v1/setup/status',
];

/**
 * Check if a path is a public API route
 */
function isPublicApiRoute(pathname: string): boolean {
  return PUBLIC_API_ROUTES.some((route) => pathname.startsWith(route));
}

/**
 * Extract API key from request headers
 */
function extractApiKey(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization');

  if (!authHeader) {
    return null;
  }

  // Check for Bearer token format
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return bearerMatch[1];
  }

  return null;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only process API routes
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Allow public API routes without authentication
  if (isPublicApiRoute(pathname)) {
    return NextResponse.next();
  }

  // do some basic API key validation
  const apiKey = extractApiKey(request);

  if (!apiKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const regex = /^lfc_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{32})$/;
  const match = apiKey.match(regex);

  if (!match) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Pass the request through - API routes will handle full validation
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
