import { NextRequest } from 'next/server';
import { AppError } from 'server/lib/appError';

const mockIdentity = jest.fn(),
  mockGetUser = jest.fn();
const mockEnvironments = jest.fn(),
  mockInventory = jest.fn(),
  mockOptions = jest.fn(),
  mockRecords = jest.fn();
jest.mock('server/lib/dependencies', () => ({ defaultDb: {} }));
jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockIdentity(...args),
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));
jest.mock('server/services/analytics/EnvironmentAnalyticsService', () => ({
  ...jest.requireActual('server/services/analytics/EnvironmentAnalyticsService'),
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getEnvironments: mockEnvironments,
    getInventory: mockInventory,
    getOptions: mockOptions,
    getRecords: mockRecords,
  })),
}));

import { GET as environments } from './route';
import { GET as inventory } from '../inventory/route';
import { GET as options } from '../options/route';
import { GET as records } from './records/route';

const handlers = [
  ['environments', environments],
  ['inventory', inventory],
  ['options', options],
  ['records', records],
] as const;
function request(query = ''): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'analytics-test']]),
    nextUrl: new URL(`http://localhost/api/v2/admin/analytics/environments${query}`),
  } as unknown as NextRequest;
}
function expectNoAccess() {
  for (const mock of [mockEnvironments, mockInventory, mockOptions, mockRecords]) expect(mock).not.toHaveBeenCalled();
}

describe('environment analytics administrator boundaries', () => {
  const originalAuth = process.env.ENABLE_AUTH;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockIdentity.mockReturnValue({ userId: 'admin', roles: ['admin'] });
    mockGetUser.mockReturnValue({ sub: 'admin', realm_access: { roles: ['admin'] } });
    for (const mock of [mockEnvironments, mockInventory, mockOptions, mockRecords]) mock.mockResolvedValue({});
  });
  afterEach(() => {
    if (originalAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalAuth;
  });

  it.each(handlers)('rejects unauthenticated %s before aggregation', async (_name, handler) => {
    mockIdentity.mockReturnValue(null);
    expect((await handler(request())).status).toBe(401);
    expectNoAccess();
  });
  it.each(handlers)('rejects ordinary users for %s before aggregation', async (_name, handler) => {
    mockIdentity.mockReturnValue({ userId: 'user', roles: ['user'] });
    mockGetUser.mockReturnValue({ sub: 'user', realm_access: { roles: ['user'] } });
    expect((await handler(request())).status).toBe(403);
    expectNoAccess();
  });
  it.each(handlers)('rejects API-key bearer credentials for %s', async (_name, handler) => {
    const req = request();
    req.headers.set('authorization', 'Bearer lfc_pat_fake');
    expect((await handler(req)).status).toBe(403);
    expectNoAccess();
  });
  it('passes calendar and installation scope and disables response caching', async () => {
    const response = await environments(
      request(
        '?from=2026-03-08&to=2026-03-10&timezone=America%2FLos_Angeles&repositoryId=4&environmentAuthor=Alice&rankBy=pr_coverage'
      )
    );
    expect(response.status).toBe(200);
    expect(mockEnvironments).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-03-08',
        to: '2026-03-10',
        timezone: 'America/Los_Angeles',
        repositoryId: 4,
        environmentAuthor: 'Alice',
        rankBy: 'pr_coverage',
        compare: true,
      })
    );
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('current inventory ignores dates while retaining scope and records filter by actual phases', async () => {
    expect((await inventory(request('?from=invalid&environmentType=static'))).status).toBe(200);
    expect(mockInventory).toHaveBeenCalledWith({
      repositoryId: null,
      organization: null,
      environmentType: 'static',
      environmentAuthor: null,
      unattributed: false,
    });
    expect(
      (await records(request('?cohort=current&phase=deployed_not_ready&unattributed=true&page=2&limit=100'))).status
    ).toBe(200);
    expect(mockRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        cohort: 'current',
        phase: 'deployed_not_ready',
        unattributed: true,
        page: 2,
        limit: 100,
      })
    );
  });
  it.each([
    '?from=2026-02-30&to=2026-03-02',
    '?from=2025-01-01&to=2026-01-02',
    '?repositoryId=4&unattributed=true',
    '?environmentType=workspace',
  ])('rejects invalid period query %s', async (query) => {
    expect((await environments(request(query))).status).toBe(400);
    expectNoAccess();
  });
  it('keeps endpoint failures isolated', async () => {
    mockInventory.mockRejectedValueOnce(new Error('Inventory unavailable'));
    expect((await inventory(request())).status).toBe(500);
    expect((await environments(request())).status).toBe(200);
    expect((await options(request())).status).toBe(200);
  });

  it('returns the specific inventory time-limit response without database details', async () => {
    mockInventory.mockRejectedValueOnce(
      new AppError({
        httpStatus: 503,
        code: 'analytics_timeout',
        message: 'Analytics request did not complete before the time limit.',
        nextAction: { kind: 'retry', label: 'Try again' },
        retryable: true,
        cause: new Error('SELECT private_data'),
      })
    );
    const response = await inventory(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toEqual({
      code: 'analytics_timeout',
      message: 'Analytics request did not complete before the time limit.',
      nextAction: { kind: 'retry', label: 'Try again' },
    });
    expect((await environments(request())).status).toBe(200);
  });
});
