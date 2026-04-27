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

import { NextRequest, NextResponse } from 'next/server';

describe('corsMiddleware', () => {
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
  let corsMiddleware: typeof import('./cors').corsMiddleware;

  beforeEach(async () => {
    jest.resetModules();
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
    ({ corsMiddleware } = await import('./cors'));
  });

  afterAll(() => {
    process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
  });

  it('allows the SSE resume header during preflight', async () => {
    const next = jest.fn().mockResolvedValue(NextResponse.next());
    const request = new NextRequest('http://localhost/api/v2/ai/agent/runs/run-1/events/stream', {
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-headers': 'last-event-id',
      },
      method: 'OPTIONS',
    });

    const response = await corsMiddleware(request, next);

    expect(response.status).toBe(204);
    expect(next).not.toHaveBeenCalled();
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(response.headers.get('access-control-allow-headers')).toContain('Last-Event-ID');
  });
});
