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

const mockGetUser = jest.fn();
const mockIdentity = jest.fn();
const mockSummary = jest.fn();

jest.mock('server/lib/dependencies', () => ({ defaultDb: {} }));
jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => mockIdentity(...args),
}));
jest.mock('server/services/analytics/SitesAnalyticsService', () => ({
  ...jest.requireActual('server/services/analytics/SitesAnalyticsService'),
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ getSummary: mockSummary })),
}));

import { GET } from './route';

function request(query = ''): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'sites-analytics-test']]),
    nextUrl: new URL(`http://localhost/api/v2/admin/analytics/sites${query}`),
  } as unknown as NextRequest;
}

describe('GET /api/v2/admin/analytics/sites', () => {
  const originalAuth = process.env.ENABLE_AUTH;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'admin', realm_access: { roles: ['admin'] } });
    mockIdentity.mockReturnValue({ userId: 'admin', roles: ['admin'] });
    mockSummary.mockResolvedValue({ totals: { published: 1 } });
  });
  afterEach(() => {
    if (originalAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalAuth;
  });

  it('returns the summary without caching and passes parsed filters', async () => {
    const response = await GET(request('?visibility=private&ownerKind=user'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockSummary).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private', ownerKind: 'user' }));
  });

  it('rejects invalid filters with 400 before data access', async () => {
    expect((await GET(request('?visibility=internal'))).status).toBe(400);
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests before data access', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it('rejects non-admin requests before data access', async () => {
    mockGetUser.mockReturnValue({ sub: 'user', realm_access: { roles: ['user'] } });
    mockIdentity.mockReturnValue({ userId: 'user', roles: ['user'] });
    expect((await GET(request())).status).toBe(403);
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it('rejects API-key bearer credentials', async () => {
    const req = request();
    req.headers.set('authorization', 'Bearer lfc_test');
    expect((await GET(req)).status).toBe(403);
    expect(mockSummary).not.toHaveBeenCalled();
  });
});
