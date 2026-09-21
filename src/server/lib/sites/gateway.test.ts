import { PassThrough } from 'stream';
import { handleSitesRequest, authorizeSitesViewer } from './gateway';
import { SitesBrowserError } from './browserAuth';
import { assertSitesPrincipal } from './policy';

const browser = {
  viewer: jest.fn(),
  challenge: jest.fn(),
  rateLimit: jest.fn(),
  consume: jest.fn(),
};
jest.mock('./policy', () => ({ assertSitesPrincipal: jest.fn() }));
jest.mock('./browserAuth', () => ({ ...jest.requireActual('./browserAuth'), getSitesBrowserAuth: () => browser }));
jest.mock('server/lib/redisClient', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));
const site = {
  siteId: 'abc123',
  ownerKind: 'user',
  ownerIssuer: 'https://id.example.com',
  ownerSubject: 'owner',
  servingGeneration: 'abcdef012345',
  accessRevision: 2,
  visibility: 'private',
};
const viewer = {
  issuer: site.ownerIssuer,
  subject: site.ownerSubject,
  siteId: site.siteId,
  generation: site.servingGeneration,
  accessRevision: 2,
  host: 'site-abc123--g-abcdef012345.sites.example.net',
  expiresAt: 1e12,
};
function request(method = 'GET', headers = {}, url = '/') {
  return {
    method,
    headers: { host: viewer.host, ...headers },
    url,
    socket: { remoteAddress: 'test' },
    async *[Symbol.asyncIterator]() {},
  } as any;
}
function response() {
  return {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    headersSent: false,
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
    },
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      return this;
    },
    end: jest.fn(),
  } as any;
}
function service(current = site) {
  return {
    getGatewayLocator: jest.fn(async () => ({ siteId: current.siteId, servingGeneration: current.servingGeneration })),
    getGatewaySite: jest.fn(async () => ({ site: current, config: {} })),
    getGatewayObject: jest.fn(async (_host, _path, authorize) => {
      if (current.visibility === 'private') await authorize(current);
      return { statusCode: 200, contentType: 'text/plain', contentLength: 4, body: new PassThrough() };
    }),
  } as any;
}
const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.ENABLE_AUTH = 'true';
  process.env.LIFECYCLE_UI_URL = 'https://ui.example.com';
  jest.clearAllMocks();
  browser.viewer.mockResolvedValue(viewer);
  (assertSitesPrincipal as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => {
  process.env = { ...originalEnv };
});
it.each(['/', '/style.css', '/app.js', '/private.json'])(
  'denies unauthenticated %s without fetching storage',
  async (path) => {
    browser.viewer.mockRejectedValue(new SitesBrowserError(401));
    const api = service();
    const res = response();
    await handleSitesRequest(request('GET', {}, path), res, api);
    expect(res.statusCode).toBe(404);
    expect(api.getGatewayObject).not.toHaveBeenCalled();
    expect(res.headers['Cache-Control']).toBe('no-store');
  }
);
it('denies another authenticated user and changed generation', async () => {
  await expect(authorizeSitesViewer(site as any, { ...viewer, subject: 'other' })).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(authorizeSitesViewer(site as any, { ...viewer, generation: 'old' })).rejects.toMatchObject({
    statusCode: 401,
  });
});
it('authorizes HEAD with current Site checks and no incoming-principal or IdP policy calls', async () => {
  const api = service();
  const res = response();
  await handleSitesRequest(request('HEAD'), res, api);
  expect(res.statusCode).toBe(200);
  expect(res.headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
  expect(res.headers['Origin-Agent-Cluster']).toBe('?1');
  expect(res.headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
  expect(api.getGatewayObject).toHaveBeenCalledTimes(1);
  expect(assertSitesPrincipal).not.toHaveBeenCalled();
});
it('never returns a login page or redirect for an unauthenticated asset/HEAD', async () => {
  browser.viewer.mockRejectedValue(new SitesBrowserError(401));
  const api = service();
  const res = response();
  await handleSitesRequest(request('HEAD', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }), res, api);
  expect(res.statusCode).toBe(404);
  expect(res.headers.Location).toBeUndefined();
  expect(browser.challenge).not.toHaveBeenCalled();
});
it('only navigations get a browser-bound challenge redirect', async () => {
  browser.viewer.mockRejectedValue(new SitesBrowserError(401));
  browser.challenge.mockResolvedValue({ state: 's'.repeat(43), secret: 'c'.repeat(43) });
  const res = response();
  await handleSitesRequest(
    request('GET', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }),
    res,
    service()
  );
  expect(res.statusCode).toBe(303);
  expect(res.headers.Location).toContain('https://ui.example.com/sites/open/abc123?state=');
  expect(res.headers['Set-Cookie']).toContain('SameSite=None');
});
it('blocks service workers and unsupported methods without storage', async () => {
  for (const req of [request('GET', { 'service-worker': 'script' }), request('POST')]) {
    const api = service();
    await handleSitesRequest(req, response(), api);
    expect(api.getGatewayObject).not.toHaveBeenCalled();
  }
});
it('never falls back to public bytes when Redis fails', async () => {
  browser.viewer.mockRejectedValue(new Error('Redis down'));
  const api = service();
  const res = response();
  await handleSitesRequest(request(), res, api);
  expect(res.statusCode).toBe(404);
  expect(api.getGatewayObject).not.toHaveBeenCalled();
});
it('public HEAD does not inspect viewer credentials', async () => {
  const api = service({ ...site, visibility: 'public' });
  const res = response();
  await handleSitesRequest(request('HEAD'), res, api);
  expect(res.statusCode).toBe(200);
  expect(browser.viewer).not.toHaveBeenCalled();
  expect(assertSitesPrincipal).not.toHaveBeenCalled();
});

it('ignores forwarded addresses when rate limiting bootstrap requests', async () => {
  browser.viewer.mockRejectedValue(new SitesBrowserError(401));
  browser.challenge.mockResolvedValue({ state: 's'.repeat(43), secret: 'c'.repeat(43) });
  for (const forwarded of ['1.1.1.1', '2.2.2.2']) {
    const req = request('GET', {
      'x-forwarded-for': forwarded,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    });
    req.socket.remoteAddress = '203.0.113.5';
    await handleSitesRequest(req, response(), service());
  }
  expect(browser.rateLimit.mock.calls).toEqual([['challenge:203.0.113.5'], ['challenge:203.0.113.5']]);
});

it.each([
  ['GET', {}, '/'],
  ['HEAD', {}, '/'],
  ['GET', { 'service-worker': 'script' }, '/sw.js'],
  ['GET', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, '/'],
  ['POST', {}, '/_lfc-sites/consume'],
  ['POST', { 'content-type': 'application/x-www-form-urlencoded' }, '/_lfc-sites/consume'],
  ['POST', { origin: 'https://unrelated.example' }, '/_lfc-sites/logout'],
])('matches missing and private denial responses for %s %j %s', async (method, headers, path) => {
  browser.viewer.mockRejectedValue(new SitesBrowserError(401));
  browser.challenge.mockResolvedValue({ state: 's'.repeat(43), secret: 'c'.repeat(43) });
  const existing = service();
  const missing = service();
  missing.getGatewaySite.mockRejectedValue(new SitesBrowserError(404));
  const first = response();
  const second = response();
  await handleSitesRequest(request(method, headers, path), first, existing);
  await handleSitesRequest(request(method, headers, path), second, missing);
  expect(first.statusCode).toBe(second.statusCode);
  expect(first.headers).toEqual(second.headers);
  expect(first.end.mock.calls).toEqual(second.end.mock.calls);
  expect(existing.getGatewayObject).not.toHaveBeenCalled();
  expect(missing.getGatewayObject).not.toHaveBeenCalled();
});
it('rejects a concurrent Site change or grant expiry immediately before storage', async () => {
  for (const changed of [{ accessRevision: 3 }, { ownerSubject: 'other' }, { servingGeneration: 'retired' }]) {
    const api = service();
    api.getGatewayObject.mockImplementation(async (_host: string, _path: string, authorize: any) => {
      await authorize({ ...site, ...changed });
      throw new Error('must not reach storage');
    });
    const res = response();
    await handleSitesRequest(request('HEAD'), res, api);
    expect(res.statusCode).toBe(404);
  }
  await expect(
    authorizeSitesViewer(site as any, { ...viewer, expiresAt: Math.floor(Date.now() / 1000) })
  ).rejects.toMatchObject({ statusCode: 401 });
  expect(assertSitesPrincipal).not.toHaveBeenCalled();
});

it.each([new SitesBrowserError(401), new Error('Redis unavailable'), new SitesBrowserError(503)])(
  'keeps missing/private responses identical when viewer authorization fails: %s',
  async (failure) => {
    browser.viewer.mockRejectedValue(failure);
    browser.challenge.mockRejectedValue(new SitesBrowserError(503));
    for (const headers of [
      { cookie: 'lfc-viewer=' + 'x'.repeat(43) },
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    ]) {
      const existing = service();
      const missing = service();
      missing.getGatewaySite.mockRejectedValue(new SitesBrowserError(404));
      const a = response();
      const b = response();
      await handleSitesRequest(request('GET', headers, '/asset.js'), a, existing);
      await handleSitesRequest(request('GET', headers, '/asset.js'), b, missing);
      expect(a.statusCode).toBe(b.statusCode);
      expect(a.headers).toEqual(b.headers);
      expect(a.end.mock.calls).toEqual(b.end.mock.calls);
      expect(existing.getGatewayObject).not.toHaveBeenCalled();
      expect(missing.getGatewayObject).not.toHaveBeenCalled();
    }
  }
);
