import { NextRequest } from 'next/server';

const mockIdentity = jest.fn(),
  mockGetUser = jest.fn(),
  mockServices = jest.fn();
jest.mock('server/lib/dependencies', () => ({ defaultDb: {} }));
jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockIdentity(...args),
  getUser: (...args: unknown[]) => mockGetUser(...args),
}));
jest.mock('server/services/analytics/EnvironmentAnalyticsService', () => ({
  ...jest.requireActual('server/services/analytics/EnvironmentAnalyticsService'),
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ getServices: mockServices })),
}));
import { GET } from './route';

const request = (query = '') =>
  ({
    headers: new Headers([['x-request-id', 'services-test']]),
    nextUrl: new URL(`http://localhost/api/v2/admin/analytics/services${query}`),
  } as unknown as NextRequest);

describe('managed Service analytics administrator boundary', () => {
  const originalAuth = process.env.ENABLE_AUTH;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockIdentity.mockReturnValue({ userId: 'admin', roles: ['admin'] });
    mockGetUser.mockReturnValue({ sub: 'admin', realm_access: { roles: ['admin'] } });
    mockServices.mockResolvedValue({});
  });
  afterEach(() => {
    if (originalAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalAuth;
  });
  it('rejects anonymous access before querying Services', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(mockServices).not.toHaveBeenCalled();
  });
  it('rejects ordinary users before querying Services', async () => {
    mockIdentity.mockReturnValue({ userId: 'user', roles: ['user'] });
    mockGetUser.mockReturnValue({ sub: 'user', realm_access: { roles: ['user'] } });
    expect((await GET(request())).status).toBe(403);
    expect(mockServices).not.toHaveBeenCalled();
  });
  it('rejects API key credentials', async () => {
    const req = request();
    req.headers.set('authorization', 'Bearer lfc_pat_fake');
    expect((await GET(req)).status).toBe(403);
    expect(mockServices).not.toHaveBeenCalled();
  });
  it('keeps current-only scope, typed pagination, and uncached responses', async () => {
    const result = await GET(request('?from=invalid&repositoryId=4&type=helm&environmentType=static&page=2&limit=100'));
    expect(result.status).toBe(200);
    expect(mockServices).toHaveBeenCalledWith({
      repositoryId: 4,
      organization: null,
      environmentType: 'static',
      environmentAuthor: null,
      unattributed: false,
      type: 'helm',
      page: 2,
      limit: 100,
    });
    expect(result.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it.each(['?type=codefresh', '?type=externalHTTP', '?limit=101', '?repositoryId=4&unattributed=true'])(
    'rejects invalid scope %s before querying',
    async (query) => {
      expect((await GET(request(query))).status).toBe(400);
      expect(mockServices).not.toHaveBeenCalled();
    }
  );
  it('returns a provider error without a successful empty result', async () => {
    mockServices.mockRejectedValueOnce(new Error('Query unavailable'));
    expect((await GET(request())).status).toBe(500);
  });
});
