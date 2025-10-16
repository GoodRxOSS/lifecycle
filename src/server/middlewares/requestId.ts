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
import type { Middleware } from './chain';

function getResourceShortName(url: string) {
  url = url.replace(/\/+$/, '');

  const parts = url.split('/');

  const v2Index = parts.findIndex((p: string) => p === 'v2');

  if (v2Index !== -1 && v2Index + 1 < parts.length) {
    const resourceName = parts[v2Index + 1];
    return resourceName.length <= 4 ? resourceName.padEnd(4, '*') : resourceName.slice(0, 4);
  }

  return '****';
}

export const requestIdMiddleware: Middleware = async (request, next) => {
  const requestId = crypto.randomUUID();
  const resourceShortName = getResourceShortName(request.url);
  const xRequestId = `${resourceShortName}_${requestId}`;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', xRequestId);

  const newRequest = new NextRequest(request.url, {
    ...request,
    headers: requestHeaders,
  });

  const response = await next(newRequest);

  response.headers.set('x-request-id', xRequestId);
  return response;
};
