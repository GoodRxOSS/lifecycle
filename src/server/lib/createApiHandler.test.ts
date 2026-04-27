/**
 * Copyright 2026 GoodRx, Inc.
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

import { DynamicServerError } from 'next/dist/client/components/hooks-server-context';
import { NextRequest, NextResponse } from 'next/server';
import { createApiHandler } from './createApiHandler';

describe('createApiHandler', () => {
  it('returns a standard error response for application errors', async () => {
    const handler = createApiHandler(async () => {
      throw new Error('sample failure');
    });

    const response = await handler(new NextRequest('http://localhost/api/v2/sample'));

    await expect(response.json()).resolves.toMatchObject({
      data: null,
      error: {
        message: 'sample failure',
      },
    });
    expect(response.status).toBe(500);
  });

  it('rethrows Next dynamic usage errors so Next can mark the route dynamic', async () => {
    const dynamicError = new DynamicServerError('Route /api/v2/sample used request headers.');
    const handler = createApiHandler(async () => {
      throw dynamicError;
    });

    await expect(handler(new NextRequest('http://localhost/api/v2/sample'))).rejects.toBe(dynamicError);
  });

  it('returns successful responses unchanged', async () => {
    const handler = createApiHandler(async () => NextResponse.json({ ok: true }, { status: 201 }));

    const response = await handler(new NextRequest('http://localhost/api/v2/sample'));

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.status).toBe(201);
  });
});
