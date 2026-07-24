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
import { NextRequest } from 'next/server';
import { createStreamHandler } from './createStreamHandler';

describe('createStreamHandler', () => {
  it('returns an SSE error frame for application errors', async () => {
    const handler = createStreamHandler(async () => {
      throw new Error('sample stream failure');
    });

    const response = await handler(new NextRequest('http://localhost/api/v2/sample/stream'));

    await expect(response.text()).resolves.toContain('"error":"sample stream failure"');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  });

  it('rethrows Next dynamic usage errors so Next can mark the stream route dynamic', async () => {
    const dynamicError = new DynamicServerError('Route /api/v2/sample/stream used request headers.');
    const handler = createStreamHandler(async () => {
      throw dynamicError;
    });

    await expect(handler(new NextRequest('http://localhost/api/v2/sample/stream'))).rejects.toBe(dynamicError);
  });
});
