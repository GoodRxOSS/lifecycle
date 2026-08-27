/**
 * Copyright 2026 Lifecycle contributors
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
import { chain, type Middleware } from './chain';

describe('chain', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs middleware in declaration order and unwinds in reverse order', async () => {
    const events: string[] = [];
    const outer: Middleware = async (request, next) => {
      events.push('outer:before');
      const response = await next(request);
      events.push('outer:after');
      response.headers.set('x-outer', 'complete');
      return response;
    };
    const inner: Middleware = async (request, next) => {
      events.push('inner:before');
      const response = await next(request);
      events.push('inner:after');
      response.headers.set('x-inner', 'complete');
      return response;
    };

    const response = await chain([outer, inner])(new NextRequest('http://localhost/api/v2/builds'));

    expect(events).toEqual(['outer:before', 'inner:before', 'inner:after', 'outer:after']);
    expect(response.headers.get('x-outer')).toBe('complete');
    expect(response.headers.get('x-inner')).toBe('complete');
  });

  it('forwards the request through NextResponse when the chain is empty', async () => {
    const request = new NextRequest('http://localhost/api/v2/builds', {
      headers: { 'x-request-id': 'req-1' },
    });
    const nextSpy = jest.spyOn(NextResponse, 'next');

    const response = await chain([])(request);

    expect(response.status).toBe(200);
    expect(nextSpy).toHaveBeenCalledWith({ request });
  });
});
