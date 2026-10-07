import { NextRequest } from 'next/server';

const mockIdentity = jest.fn(),
  mockGetUser = jest.fn();
const mockSummary = jest.fn(),
  mockRecords = jest.fn(),
  mockScatter = jest.fn();
jest.mock('server/lib/dependencies', () => ({ defaultDb: {} }));
jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockIdentity(...args),
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));
jest.mock('server/services/analytics/EnvironmentLifetimeAnalyticsService', () => ({
  ...jest.requireActual('server/services/analytics/EnvironmentLifetimeAnalyticsService'),
  __esModule: true,
  default: jest
    .fn()
    .mockImplementation(() => ({ getSummary: mockSummary, getRecords: mockRecords, getScatter: mockScatter })),
}));

import { GET as summary } from './route';
import { GET as records } from './records/route';
import { GET as scatter } from './scatter/route';
const handlers = [
  ['lifetimes', summary],
  ['lifetime records', records],
  ['lifetime scatter', scatter],
] as const;
function request(query = ''): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'lifetime-test']]),
    nextUrl: new URL(`http://localhost/api/v2/admin/analytics/lifetimes${query}`),
  } as unknown as NextRequest;
}
function expectNoAccess() {
  expect(mockSummary).not.toHaveBeenCalled();
  expect(mockRecords).not.toHaveBeenCalled();
  expect(mockScatter).not.toHaveBeenCalled();
}

describe('lifetime analytics administrator boundaries', () => {
  const originalAuth = process.env.ENABLE_AUTH;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockIdentity.mockReturnValue({ userId: 'admin', roles: ['admin'] });
    mockGetUser.mockReturnValue({ sub: 'admin', realm_access: { roles: ['admin'] } });
    mockSummary.mockResolvedValue({});
    mockRecords.mockResolvedValue({});
    mockScatter.mockResolvedValue({});
  });
  afterEach(() => {
    if (originalAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalAuth;
  });
  it.each(handlers)('rejects unauthenticated %s before queries', async (_name, handler) => {
    mockIdentity.mockReturnValue(null);
    expect((await handler(request())).status).toBe(401);
    expectNoAccess();
  });
  it.each(handlers)('rejects ordinary users for %s before queries', async (_name, handler) => {
    mockIdentity.mockReturnValue({ userId: 'user', roles: ['user'] });
    mockGetUser.mockReturnValue({ sub: 'user', realm_access: { roles: ['user'] } });
    expect((await handler(request())).status).toBe(403);
    expectNoAccess();
  });
  it.each(handlers)('rejects API-key credentials for %s', async (_name, handler) => {
    const req = request();
    req.headers.set('authorization', 'Bearer lfc_pat_fake');
    expect((await handler(req)).status).toBe(403);
    expectNoAccess();
  });
  it.each(handlers)('returns private no-store for administrator %s', async (_name, handler) => {
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('passes retirement range, timezone and environment scope', async () => {
    const response = await summary(
      request('?from=2026-03-08&to=2026-03-10&timezone=America%2FLos_Angeles&repositoryId=4&environmentAuthor=Alice')
    );
    expect(response.status).toBe(200);
    expect(mockSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-03-08',
        to: '2026-03-10',
        timezone: 'America/Los_Angeles',
        repositoryId: 4,
        environmentAuthor: 'Alice',
        compare: true,
      })
    );
  });
  it('current age ignores calendar controls while preserving group, bin and scope', async () => {
    const response = await records(
      request(
        '?cohort=current&group=other&bin=invalid&from=invalid&to=invalid&timezone=invalid&environmentType=static&unattributed=true'
      )
    );
    expect(response.status).toBe(200);
    expect(mockRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        cohort: 'current',
        group: 'other',
        bin: 'invalid',
        environmentType: 'static',
        unattributed: true,
      })
    );
    expect(mockRecords.mock.calls[0][0].from).toBeUndefined();
  });
  it('passes scatter scope and selected retirement window without previous-period points', async () => {
    const response = await scatter(
      request('?group=pr&from=2026-03-08&to=2026-03-10&compare=true&environmentType=ephemeral')
    );
    expect(response.status).toBe(200);
    expect(mockScatter).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'pr',
        from: '2026-03-08',
        to: '2026-03-10',
        compare: false,
        environmentType: 'ephemeral',
      })
    );
  });
  it.each(['?group=other', '?from=2026-02-30&to=2026-03-02', '?repositoryId=1&unattributed=true'])(
    'rejects invalid scatter query %s before queries',
    async (query) => {
      expect((await scatter(request(query))).status).toBe(400);
      expectNoAccess();
    }
  );
  it.each([
    '?group=other',
    '?bin=episode',
    '?page=10001',
    '?limit=101',
    '?cohort=episode',
    '?repositoryId=1&unattributed=true',
    '?from=2026-02-30&to=2026-03-02',
  ])('rejects invalid lifetime record query %s', async (query) => {
    expect((await records(request(query))).status).toBe(400);
    expectNoAccess();
  });
  it('isolates summary failures from record requests', async () => {
    mockSummary.mockRejectedValueOnce(new Error('Unavailable'));
    expect((await summary(request())).status).toBe(500);
    expect((await records(request())).status).toBe(200);
  });
});
