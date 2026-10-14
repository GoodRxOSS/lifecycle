/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NextRequest } from 'next/server';
import { AppError } from 'server/lib/appError';

const mockIdentity = jest.fn(),
  mockGetUser = jest.fn(),
  mockSummary = jest.fn();
jest.mock('server/lib/dependencies', () => ({ defaultDb: {} }));
jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockIdentity(...args),
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));
jest.mock('server/services/analytics/McpAnalyticsService', () => ({
  ...jest.requireActual('server/services/analytics/McpAnalyticsService'),
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ getSummary: mockSummary })),
}));

import { GET } from './route';

function request(query = ''): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'analytics-test']]),
    nextUrl: new URL(`http://localhost/api/v2/admin/analytics/mcp${query}`),
  } as unknown as NextRequest;
}

describe('mcp analytics administrator boundaries', () => {
  const originalAuth = process.env.ENABLE_AUTH;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockIdentity.mockReturnValue({ userId: 'admin', roles: ['admin'] });
    mockGetUser.mockReturnValue({ sub: 'admin', realm_access: { roles: ['admin'] } });
    mockSummary.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    if (originalAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalAuth;
  });

  it('rejects unauthenticated callers before aggregation', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(mockSummary).not.toHaveBeenCalled();
  });
  it('rejects ordinary users before aggregation', async () => {
    mockIdentity.mockReturnValue({ userId: 'user', roles: ['user'] });
    mockGetUser.mockReturnValue({ sub: 'user', realm_access: { roles: ['user'] } });
    expect((await GET(request())).status).toBe(403);
    expect(mockSummary).not.toHaveBeenCalled();
  });
  it('rejects API-key bearer credentials', async () => {
    const req = request();
    req.headers.set('authorization', 'Bearer lfc_pat_fake');
    expect((await GET(req)).status).toBe(403);
    expect(mockSummary).not.toHaveBeenCalled();
  });
  it('passes the calendar window through and disables response caching', async () => {
    const response = await GET(request('?from=2026-03-08&to=2026-03-10&timezone=America%2FLos_Angeles&interval=week'));
    expect(response.status).toBe(200);
    expect(mockSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-03-08',
        to: '2026-03-10',
        timezone: 'America/Los_Angeles',
        interval: 'week',
      })
    );
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await response.json()).data).toEqual({ ok: true });
  });
  it.each(['?from=2026-02-30&to=2026-03-02', '?from=2025-01-01&to=2026-01-02', '?interval=month'])(
    'rejects invalid period query %s',
    async (query) => {
      expect((await GET(request(query))).status).toBe(400);
      expect(mockSummary).not.toHaveBeenCalled();
    }
  );
  it('returns the time-limit response without database details', async () => {
    mockSummary.mockRejectedValueOnce(
      new AppError({
        httpStatus: 503,
        code: 'analytics_timeout',
        message: 'Analytics request did not complete before the time limit.',
        nextAction: { kind: 'retry', label: 'Try again' },
        retryable: true,
        cause: new Error('SELECT private_data'),
      })
    );
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toEqual({
      code: 'analytics_timeout',
      message: 'Analytics request did not complete before the time limit.',
      nextAction: { kind: 'retry', label: 'Try again' },
    });
  });
});
