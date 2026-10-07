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
const mockRuns = jest.fn();
const mockSessions = jest.fn();
const mockOptions = jest.fn();

jest.mock('server/lib/dependencies', () => ({ defaultDb: {} }));
jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => mockIdentity(...args),
}));
jest.mock('server/services/analytics/AgentAnalyticsService', () => ({
  ...jest.requireActual('server/services/analytics/AgentAnalyticsService'),
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getSummary: mockSummary,
    listRuns: mockRuns,
    listSessions: mockSessions,
    getOptions: mockOptions,
  })),
}));

import { GET as summary } from './route';
import { GET as runs } from './runs/route';
import { GET as sessions } from './sessions/route';
import { GET as options } from './options/route';

function request(query = ''): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'analytics-test']]),
    nextUrl: new URL(`http://localhost/api/v2/admin/analytics/agents${query}`),
  } as unknown as NextRequest;
}

describe('Agent analytics admin API boundaries', () => {
  const originalAuth = process.env.ENABLE_AUTH;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'admin', realm_access: { roles: ['admin'] } });
    mockIdentity.mockReturnValue({ userId: 'admin', roles: ['admin'] });
    mockSummary.mockResolvedValue({ totals: { runs: 2 } });
    mockRuns.mockResolvedValue({ runs: [], pagination: { page: 1, limit: 25, total: 0, hasMore: false } });
    mockSessions.mockResolvedValue({ sessions: [], pagination: { page: 1, limit: 25, total: 0, hasMore: false } });
    mockOptions.mockResolvedValue({ repositories: [], owners: [], models: [] });
  });
  afterEach(() => {
    if (originalAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalAuth;
  });

  it.each([
    ['summary', summary],
    ['runs', runs],
    ['sessions', sessions],
    ['options', options],
  ] as const)('prevents caching successful admin %s responses', async (_name, handler) => {
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
  });

  it.each([
    ['summary', summary],
    ['runs', runs],
    ['sessions', sessions],
    ['options', options],
  ] as const)('rejects unauthenticated %s requests before data access', async (_name, handler) => {
    mockIdentity.mockReturnValue(null);
    expect((await handler(request())).status).toBe(401);
    expect(mockSummary).not.toHaveBeenCalled();
    expect(mockRuns).not.toHaveBeenCalled();
    expect(mockSessions).not.toHaveBeenCalled();
    expect(mockOptions).not.toHaveBeenCalled();
  });

  it.each([
    ['summary', summary],
    ['runs', runs],
    ['sessions', sessions],
    ['options', options],
  ] as const)('rejects non-admin %s requests before data access', async (_name, handler) => {
    mockGetUser.mockReturnValue({ sub: 'user', realm_access: { roles: ['user'] } });
    mockIdentity.mockReturnValue({ userId: 'user', roles: ['user'] });
    expect((await handler(request())).status).toBe(403);
    expect(mockSummary).not.toHaveBeenCalled();
    expect(mockRuns).not.toHaveBeenCalled();
    expect(mockSessions).not.toHaveBeenCalled();
    expect(mockOptions).not.toHaveBeenCalled();
  });

  it.each([
    ['summary', summary],
    ['runs', runs],
    ['sessions', sessions],
    ['options', options],
  ] as const)('rejects API-key bearer credentials for %s', async (_name, handler) => {
    const req = request();
    req.headers.set('authorization', 'Bearer lfc_test');
    expect((await handler(req)).status).toBe(403);
    expect(mockSummary).not.toHaveBeenCalled();
    expect(mockRuns).not.toHaveBeenCalled();
    expect(mockSessions).not.toHaveBeenCalled();
    expect(mockOptions).not.toHaveBeenCalled();
  });

  it('passes the calendar and independent Agent scope to summary', async () => {
    const response = await summary(
      request(
        '?from=2026-03-08&to=2026-03-10&timezone=America%2FLos_Angeles&compare=true&repository=Org%2FRepo&owner=owner&model=model'
      )
    );
    expect(response.status).toBe(200);
    expect(mockSummary).toHaveBeenCalledWith({
      from: '2026-03-08',
      to: '2026-03-10',
      timezone: 'America/Los_Angeles',
      interval: 'day',
      compare: true,
      repository: 'org/repo',
      owner: 'owner',
      model: 'model',
    });
    expect(await response.json()).toMatchObject({ data: { totals: { runs: 2 } }, error: null });
  });

  it.each(['?from=2026-02-30&to=2026-03-02', '?repositoryId=5', '?from=2025-01-01&to=2026-01-02'])(
    'rejects invalid summary range or unsupported installation scope %s',
    async (query) => {
      expect((await summary(request(query))).status).toBe(400);
      expect(mockSummary).not.toHaveBeenCalled();
    }
  );

  it('enforces run pagination and outcome filters', async () => {
    expect((await runs(request('?runStatus=failed&page=2&limit=100'))).status).toBe(200);
    expect(mockRuns).toHaveBeenCalledWith(expect.objectContaining({ runStatus: 'failed' }), 2, 100);
    mockRuns.mockClear();
    expect((await runs(request('?limit=101'))).status).toBe(400);
    expect(mockRuns).not.toHaveBeenCalled();
    expect(mockSessions).not.toHaveBeenCalled();
  });

  it('returns filter options independently and propagates its own failure', async () => {
    expect((await options(request())).status).toBe(200);
    expect(mockOptions).toHaveBeenCalledTimes(1);
    mockOptions.mockRejectedValueOnce(new Error('Options unavailable'));
    expect((await options(request())).status).toBe(500);
    expect((await summary(request())).status).toBe(200);
  });
  it('paginates sessions using the Agent source scopes independently of a secondary run outcome', async () => {
    expect(
      (await sessions(request('?repository=org%2Frepo&owner=owner&page=2&limit=25&runStatus=failed'))).status
    ).toBe(200);
    expect(mockSessions).toHaveBeenCalledWith(
      expect.objectContaining({ repository: 'org/repo', owner: 'owner' }),
      2,
      25
    );
    expect(mockSessions.mock.calls[0][0]).not.toHaveProperty('runStatus');
  });

  it('rejects invalid session IDs and forwards valid run drawer scope', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000001';
    expect((await runs(request(`?sessionId=${sessionId}&page=2`))).status).toBe(200);
    expect(mockRuns).toHaveBeenCalledWith(expect.objectContaining({ sessionId }), 2, 25);
    mockRuns.mockClear();
    expect((await runs(request('?sessionId=invalid'))).status).toBe(400);
    expect(mockRuns).not.toHaveBeenCalled();
  });
});
