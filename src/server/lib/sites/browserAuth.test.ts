import {
  SitesBrowserAuth,
  SitesBrowserError,
  randomSiteToken,
  siteTokenHash,
  challengeCookieName,
  assertPrivateSitesReady,
  sitesUiOrigin,
  assertViewerOwns,
  safeSiteReturnPath,
  parseSitesCookies,
  type BrowserSite,
} from './browserAuth';

jest.mock('server/lib/redisClient', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));

// Atomic test store shared by two protocol instances; actual Redis/ingress acceptance
// remains required. Expiration is modeled so tests do not pretend cached state is live.
class Store {
  rows = new Map<string, { value: string; until: number }>();
  async get(key: string) {
    const row = this.rows.get(key);
    return row && row.until > Date.now() ? row.value : null;
  }
  async set(key: string, value: string, _ex: string, ttl: number, nx?: string) {
    const current = this.rows.get(key);
    if (nx && current && current.until > Date.now()) return null;
    this.rows.set(key, { value, until: Date.now() + ttl * 1000 });
    return 'OK';
  }
  async eval(script: string, _count: number, key: string) {
    // Read and mutate without yielding: emulate the atomic Redis execution boundary.
    const row = this.rows.get(key);
    const current = row && row.until > Date.now() ? row.value : null;
    if (script.includes('sites-consume')) {
      this.rows.delete(key);
      return current;
    }
    const count = Number(current || 0) + 1;
    this.rows.set(key, { value: String(count), until: row?.until || Date.now() + 60_000 });
    return count;
  }
}
const actor = {
  issuer: 'https://identity.example.com/realms/lifecycle',
  subject: 'owner',
  oauth: {
    sessionId: 'sid',
    tokenId: 'initial-token-id',
    clientId: 'lifecycle-ui',
    expiresAt: Math.floor(Date.now() / 1000) + 1200,
  },
};
const site: BrowserSite = {
  siteId: 'abc123',
  ownerKind: 'user',
  ownerIssuer: actor.issuer,
  ownerSubject: actor.subject,
  visibility: 'private',
  accessRevision: 1,
};
const host = 'site-abc123.sites.example.net';
let store: Store;
let auth: SitesBrowserAuth;
const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.ENABLE_AUTH = 'true';
  process.env.KEYCLOAK_ISSUER = actor.issuer;
  actor.oauth.expiresAt = Math.floor(Date.now() / 1000) + 1200;
  process.env.LIFECYCLE_UI_URL = 'https://ui.example.com';
  store = new Store();
  auth = new SitesBrowserAuth(store as any);
});
afterEach(() => {
  process.env = { ...originalEnv };
  jest.useRealTimers();
});
async function setup() {
  const challenge = await auth.challenge(site, host, '/docs/page.html?example=1');
  const login = {
    siteId: site.siteId,
    state: challenge.state,
  };
  const minted = await auth.mint(site, actor, login, Math.floor(Date.now() / 1000) + 1200);
  const cookies = { [challengeCookieName(challenge.state)]: challenge.secret };
  return { challenge, login, minted, cookies };
}
it('consumes only once across two gateway instances and creates an owner-scoped session', async () => {
  const { minted, cookies } = await setup();
  const second = new SitesBrowserAuth(store as any);
  const authorize = jest.fn(async (viewer) => {
    assertViewerOwns(site, viewer);
  });
  const outcomes = await Promise.allSettled([
    auth.consume(minted.ticket, host, cookies, process.env.LIFECYCLE_UI_URL, authorize),
    second.consume(minted.ticket, host, cookies, process.env.LIFECYCLE_UI_URL, authorize),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const value = (outcomes.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
  expect(value.path).toBe('/docs/page.html?example=1');
  expect(await second.viewer(value.sessionId, host)).toMatchObject({ issuer: actor.issuer, subject: actor.subject });
  expect(authorize).toHaveBeenCalledTimes(1);
});
it.each(['wrong-origin', 'wrong-host', 'wrong-cookie'])('rejects %s before authorizing', async (scenario) => {
  const { minted, cookies } = await setup();
  const authorize = jest.fn();
  await expect(
    auth.consume(
      minted.ticket,
      scenario === 'wrong-host' ? 'another.sites.example.net' : host,
      scenario === 'wrong-cookie' ? {} : cookies,
      scenario === 'wrong-origin' ? 'https://evil.example.org' : process.env.LIFECYCLE_UI_URL,
      authorize
    )
  ).rejects.toBeInstanceOf(SitesBrowserError);
  expect(authorize).not.toHaveBeenCalled();
});
it('expires one-use tickets after 60 seconds', async () => {
  jest.useFakeTimers();
  const { minted, cookies } = await setup();
  jest.advanceTimersByTime(61_000);
  await expect(
    auth.consume(minted.ticket, host, cookies, process.env.LIFECYCLE_UI_URL, jest.fn())
  ).rejects.toMatchObject({ statusCode: 401 });
});
it('never lets a different actor or service-key owner mint a viewer', async () => {
  const { login } = await setup();
  await expect(auth.mint(site, { ...actor, subject: 'other' }, login, actor.oauth.expiresAt)).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(
    auth.mint({ ...site, ownerKind: 'service_key' }, actor, login, actor.oauth.expiresAt)
  ).rejects.toMatchObject({ statusCode: 404 });
});
it('runs current authorization on consume and returns no session when ownership changes', async () => {
  const { minted, cookies } = await setup();
  await expect(
    auth.consume(minted.ticket, host, cookies, process.env.LIFECYCLE_UI_URL, async () => {
      throw new SitesBrowserError(404);
    })
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(Array.from(store.rows.keys()).filter((key) => key.includes(':viewer:'))).toHaveLength(0);
});
it('auth-off denies already issued cookies', async () => {
  const { minted, cookies } = await setup();
  const result = await auth.consume(minted.ticket, host, cookies, process.env.LIFECYCLE_UI_URL, async () => {});
  process.env.ENABLE_AUTH = 'false';
  await expect(auth.viewer(result.sessionId, host)).rejects.toMatchObject({ statusCode: 503 });
});
it('fails closed on Redis failure', async () => {
  const { minted, cookies } = await setup();
  store.eval = jest.fn().mockRejectedValue(new Error('redis down'));
  await expect(auth.consume(minted.ticket, host, cookies, process.env.LIFECYCLE_UI_URL, jest.fn())).rejects.toThrow(
    'redis down'
  );
});
it('requires authentication, HTTPS and a separate registrable domain', () => {
  expect(() => assertPrivateSitesReady(`https://${host}`)).not.toThrow();
  expect(() => assertPrivateSitesReady('https://sites.example.com')).toThrow();
  expect(() => assertPrivateSitesReady('http://sites.example.net')).toThrow();
  process.env.ENABLE_AUTH = 'false';
  expect(() => assertPrivateSitesReady()).toThrow();
});
it('the shared-apex opt-in only bypasses the same-domain check, never HTTPS', () => {
  expect(() => assertPrivateSitesReady('https://sites.example.com')).toThrow();
  process.env.SITES_ALLOW_SHARED_APEX = 'true';
  expect(() => assertPrivateSitesReady('https://sites.example.com')).not.toThrow();
  expect(() => assertPrivateSitesReady('http://sites.example.com')).toThrow();
});
it('derives the trusted origin from the existing UI URL', () => {
  process.env.LIFECYCLE_UI_URL = 'https://UI.example.com:443/app/?q=test#section';
  expect(sitesUiOrigin()).toBe('https://ui.example.com');
  expect(() => assertPrivateSitesReady(`https://${host}`)).not.toThrow();
});
it.each(['', 'not-a-url', 'http://ui.example.com', 'https://user:password@ui.example.com'])(
  'rejects unsafe or missing private UI URL %s',
  (url) => {
    process.env.LIFECYCLE_UI_URL = url;
    expect(() => assertPrivateSitesReady()).toThrow();
  }
);
it('rejects unsafe return paths and ambiguous cookies', () => {
  for (const path of [
    '//evil.test',
    '/%2f%2fevil.test',
    '/%5cevil',
    '/../secret',
    '/%2e%2e/secret',
    '/_lfc-sites/consume',
  ])
    expect(() => safeSiteReturnPath(path)).toThrow();
  expect(parseSitesCookies('a=first; a=shadow').a).toBe('');
});

it('bounds chunked mint request bodies before parsing without Content-Length', async () => {
  const { readSitesMintBody } = await import('./browserAuth');
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4097));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(readSitesMintBody({ headers: new Headers(), body: stream })).rejects.toMatchObject({
    statusCode: 413,
  });
  expect(cancelled).toBe(true);
});

it('consumes at most one ticket from the same browser challenge', async () => {
  const { minted, login, cookies } = await setup();
  const second = await auth.mint(site, actor, login, actor.oauth.expiresAt);
  await auth.consume(minted.ticket, host, cookies, process.env.LIFECYCLE_UI_URL, async () => {});
  await expect(
    auth.consume(second.ticket, host, cookies, process.env.LIFECYCLE_UI_URL, async () => {})
  ).rejects.toMatchObject({ statusCode: 401 });
});
it.each([30, 300, 1200])('caps fixed viewer lifetime to token expiry or 300 seconds: %s', async (tokenSeconds) => {
  jest.useFakeTimers();
  const start = Math.floor(Date.now() / 1000);
  actor.oauth.expiresAt = start + tokenSeconds;
  const challenge = await auth.challenge(site, host, '/');
  const minted = await auth.mint(site, actor, { siteId: site.siteId, state: challenge.state }, actor.oauth.expiresAt);
  const result = await auth.consume(
    minted.ticket,
    host,
    { [challengeCookieName(challenge.state)]: challenge.secret },
    process.env.LIFECYCLE_UI_URL,
    async () => {}
  );
  const viewer = await auth.viewer(result.sessionId, host);
  expect(viewer.expiresAt).toBe(start + Math.min(tokenSeconds, 300));
  expect(result.maxAge).toBe(Math.min(tokenSeconds, 300));
  const originalRows = JSON.stringify([...store.rows]);
  jest.advanceTimersByTime(10_000);
  expect(await auth.viewer(result.sessionId, host)).toEqual(viewer);
  expect(JSON.stringify([...store.rows])).toBe(originalRows);
  jest.advanceTimersByTime(Math.min(tokenSeconds, 300) * 1000);
  await expect(auth.viewer(result.sessionId, host)).rejects.toMatchObject({ statusCode: 401 });
});
it('supports authenticated renewal with a fresh token but cannot renew with an expired token', async () => {
  jest.useFakeTimers();
  const deadline = Math.floor(Date.now() / 1000) + 40;
  const challenge = await auth.challenge(site, host, '/');
  const body = { siteId: site.siteId, state: challenge.state };
  await auth.mint(site, actor, body, deadline);
  jest.advanceTimersByTime(41_000);
  await expect(auth.mint(site, actor, body, deadline)).rejects.toMatchObject({ statusCode: 401 });
  const freshDeadline = Math.floor(Date.now() / 1000) + 300;
  const renewed = await auth.mint(site, actor, body, freshDeadline);
  const result = await auth.consume(
    renewed.ticket,
    host,
    { [challengeCookieName(challenge.state)]: challenge.secret },
    process.env.LIFECYCLE_UI_URL,
    async () => {}
  );
  expect((await auth.viewer(result.sessionId, host)).expiresAt).toBe(freshDeadline);
});
it('retains only Site claims, no OAuth login, token metadata or bearer vault', async () => {
  const { minted, cookies } = await setup();
  const result = await auth.consume(minted.ticket, host, cookies, process.env.LIFECYCLE_UI_URL, async () => {});
  expect(Object.keys(await auth.viewer(result.sessionId, host)).sort()).toEqual([
    'accessRevision',
    'expiresAt',
    'host',
    'issuer',
    'siteId',
    'subject',
  ]);
  expect([...store.rows.keys()].every((key) => /^sites:browser:v2:(challenge|ticket|viewer|rate):/.test(key))).toBe(
    true
  );
  expect(JSON.stringify([...store.rows.values()])).not.toContain(actor.oauth.tokenId);
});
it('rejects previous-version viewers and tickets', async () => {
  const token = randomSiteToken();
  for (const kind of ['viewer', 'ticket']) {
    await store.set(`sites:browser:v1:${kind}:${siteTokenHash(token)}`, JSON.stringify({ ...actor, host }), 'EX', 300);
  }
  await expect(auth.viewer(token, host)).rejects.toMatchObject({ statusCode: 401 });
  await expect(auth.consume(token, host, {}, process.env.LIFECYCLE_UI_URL, jest.fn())).rejects.toMatchObject({
    statusCode: 401,
  });
});
it('validates only siteId and state, denying invented owner and legacy login claims', async () => {
  const { readSitesMintBody } = await import('./browserAuth');
  const body = { siteId: site.siteId, state: randomSiteToken() };
  const request = (value: unknown) =>
    new Request('https://api.example/mint', { method: 'POST', body: JSON.stringify(value) });
  await expect(readSitesMintBody(request(body))).resolves.toEqual(body);
  for (const value of [
    null,
    [],
    {},
    { ...body, ownerSubject: 'owner' },
    { ...body, loginId: randomSiteToken() },
    { ...body, state: 'bad' },
  ]) {
    await expect(readSitesMintBody(request(value))).rejects.toMatchObject({ statusCode: 400 });
  }
});
