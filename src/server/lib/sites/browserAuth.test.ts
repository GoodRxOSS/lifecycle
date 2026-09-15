import { createHmac } from 'crypto';
import {
  SitesBrowserAuth,
  SitesBrowserError,
  randomSiteToken,
  siteTokenHash,
  challengeCookieName,
  assertPrivateSitesReady,
  assertViewerOwns,
  safeSiteReturnPath,
  parseSitesCookies,
  type BrowserSite,
} from './browserAuth';

const mockTokenStatus = jest.fn();
jest.mock('server/services/keycloak/principalStatus', () => ({
  getOAuthTokenStatus: (...args: unknown[]) => mockTokenStatus(...args),
}));

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
  async eval(script: string, _count: number, key: string, value?: string, ttl?: number, mode?: string) {
    // Read and mutate without yielding: emulate the atomic Redis execution boundary.
    const row = this.rows.get(key);
    const current = row && row.until > Date.now() ? row.value : null;
    if (script.includes('sites-consume')) {
      this.rows.delete(key);
      return current;
    }
    if (script.includes('sites-login')) {
      if (mode === 'existing' && !current) return 0;
      if (current && current !== value) return 0;
      this.rows.set(key, { value: value!, until: Date.now() + ttl! * 1000 });
      return 1;
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
  servingGeneration: 'abcdef012345',
  accessRevision: 1,
};
const host = 'site-abc123--g-abcdef012345.sites.example.net';
let store: Store;
let auth: SitesBrowserAuth;
const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.ENABLE_AUTH = 'true';
  process.env.KEYCLOAK_ISSUER = actor.issuer;
  process.env.SITES_UI_OAUTH_CLIENT_ID = actor.oauth.clientId;
  actor.oauth.expiresAt = Math.floor(Date.now() / 1000) + 1200;
  mockTokenStatus.mockReset().mockResolvedValue('active');
  process.env.SITES_PRIVATE_ENABLED = 'true';
  process.env.SITES_UI_ORIGIN = 'https://ui.example.com';
  process.env.SITES_BROWSER_BRIDGE_SECRET = 'x'.repeat(40);
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
    loginId: randomSiteToken(),
    loginExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    siteId: site.siteId,
    state: challenge.state,
  };
  await auth.bind(actor, { ...login, createLogin: true });
  const minted = await auth.mint(site, actor, login, Math.floor(Date.now() / 1000) + 1200, 'authorizing-bearer-secret');
  const cookies = { [challengeCookieName(challenge.state)]: challenge.secret };
  return { challenge, login, minted, cookies };
}
function signature(action: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const nonce = randomSiteToken();
  const hash = createHmac('sha256', process.env.SITES_BROWSER_BRIDGE_SECRET!)
    .update(`sites-v1\n${action}\n${timestamp}\n${nonce}\n${siteTokenHash(body)}`)
    .digest('hex');
  return `${timestamp}.${nonce}.${hash}`;
}
it('consumes only once across two gateway instances and creates an owner-scoped session', async () => {
  const { minted, cookies } = await setup();
  const second = new SitesBrowserAuth(store as any);
  const authorize = jest.fn(async (viewer) => {
    assertViewerOwns(site, viewer);
  });
  const outcomes = await Promise.allSettled([
    auth.consume(minted.ticket, host, cookies, process.env.SITES_UI_ORIGIN, authorize),
    second.consume(minted.ticket, host, cookies, process.env.SITES_UI_ORIGIN, authorize),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const value = (outcomes.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
  expect(value.path).toBe('/docs/page.html?example=1');
  expect(await second.viewer(value.sessionId, host)).toMatchObject(actor);
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
      scenario === 'wrong-origin' ? 'https://evil.example.org' : process.env.SITES_UI_ORIGIN,
      authorize
    )
  ).rejects.toBeInstanceOf(SitesBrowserError);
  expect(authorize).not.toHaveBeenCalled();
});
it('revokes existing viewers and pending tickets on logout', async () => {
  const { minted, cookies, login } = await setup();
  const result = await auth.consume(minted.ticket, host, cookies, process.env.SITES_UI_ORIGIN, async () => {});
  await auth.revoke(login);
  await expect(auth.viewer(result.sessionId, host)).rejects.toMatchObject({ statusCode: 401 });
  await expect(auth.mint(site, actor, login, login.loginExpiresAt, 'authorizing-bearer-secret')).rejects.toMatchObject({
    statusCode: 401,
  });
});
it('a revocation tombstone wins over a concurrent first-time login registration', async () => {
  const challenge = await auth.challenge(site, host, '/');
  const login = {
    loginId: randomSiteToken(),
    loginExpiresAt: Math.floor(Date.now() / 1000) + 300,
    siteId: site.siteId,
    state: challenge.state,
  };
  await auth.revoke(login);
  await expect(auth.mint(site, actor, login, login.loginExpiresAt, 'authorizing-bearer-secret')).rejects.toMatchObject({
    statusCode: 401,
  });
});
it('expires one-use tickets after 60 seconds', async () => {
  jest.useFakeTimers();
  const { minted, cookies } = await setup();
  jest.advanceTimersByTime(61_000);
  await expect(
    auth.consume(minted.ticket, host, cookies, process.env.SITES_UI_ORIGIN, jest.fn())
  ).rejects.toMatchObject({ statusCode: 401 });
});
it('never lets a different actor or service-key owner mint a viewer', async () => {
  const { login } = await setup();
  await expect(
    auth.mint(site, { ...actor, subject: 'other' }, login, login.loginExpiresAt, 'authorizing-bearer-secret')
  ).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(
    auth.mint({ ...site, ownerKind: 'service_key' }, actor, login, login.loginExpiresAt, 'authorizing-bearer-secret')
  ).rejects.toMatchObject({ statusCode: 404 });
});
it('runs current authorization on consume and returns no session when ownership/generation changes', async () => {
  const { minted, cookies } = await setup();
  await expect(
    auth.consume(minted.ticket, host, cookies, process.env.SITES_UI_ORIGIN, async () => {
      throw new SitesBrowserError(404);
    })
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(Array.from(store.rows.keys()).filter((key) => key.includes(':viewer:'))).toHaveLength(0);
});
it('auth-off denies already issued cookies; restored authentication does not undo logout', async () => {
  const { minted, cookies, login } = await setup();
  const result = await auth.consume(minted.ticket, host, cookies, process.env.SITES_UI_ORIGIN, async () => {});
  process.env.ENABLE_AUTH = 'false';
  await expect(auth.viewer(result.sessionId, host)).rejects.toMatchObject({ statusCode: 503 });
  await auth.revoke(login);
  process.env.ENABLE_AUTH = 'true';
  await expect(auth.viewer(result.sessionId, host)).rejects.toMatchObject({ statusCode: 401 });
});
it('fails closed on Redis failure', async () => {
  const { minted, cookies } = await setup();
  store.eval = jest.fn().mockRejectedValue(new Error('redis down'));
  await expect(auth.consume(minted.ticket, host, cookies, process.env.SITES_UI_ORIGIN, jest.fn())).rejects.toThrow(
    'redis down'
  );
});
it('verifies action-bound bridge signatures, rejects replay/tampering and accepts revoke without a bearer', async () => {
  const body = JSON.stringify({ loginId: randomSiteToken(), loginExpiresAt: Math.floor(Date.now() / 1000) + 300 });
  const signed = signature('revoke', body);
  expect(await auth.verifyBridge('revoke', body, signed)).toEqual(JSON.parse(body));
  await expect(auth.verifyBridge('revoke', body, signed)).rejects.toMatchObject({ statusCode: 401 });
  await expect(auth.verifyBridge('mint', body, signature('revoke', body))).rejects.toMatchObject({ statusCode: 401 });
  await expect(auth.verifyBridge('mint', `${body} `, signature('mint', body))).rejects.toMatchObject({
    statusCode: 401,
  });
  await expect(auth.verifyBridge('mint', body, signature('mint', body, 1))).rejects.toMatchObject({ statusCode: 401 });
});
it('requires explicitly enabled HTTPS, separate registrable domain and a dedicated secret', () => {
  expect(() => assertPrivateSitesReady(`https://${host}`)).not.toThrow();
  expect(() => assertPrivateSitesReady('https://sites.example.com')).toThrow();
  expect(() => assertPrivateSitesReady('http://sites.example.net')).toThrow();
  process.env.SITES_BROWSER_BRIDGE_SECRET = 'short';
  expect(() => assertPrivateSitesReady()).toThrow();
});
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

it('bounds chunked bridge request bodies before parsing without Content-Length', async () => {
  const { readSitesBridgeBody } = await import('./browserAuth');
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4097));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(readSitesBridgeBody({ headers: new Headers(), body: stream })).rejects.toMatchObject({
    statusCode: 413,
  });
  expect(cancelled).toBe(true);
});

describe('OAuth application-login binding', () => {
  const oauthActor = (tokenId = 'initial') => ({
    ...actor,
    oauth: {
      tokenId,
      sessionId: 'same-sso-session',
      clientId: 'lifecycle-ui',
      expiresAt: Math.floor(Date.now() / 1000) + 1200,
    },
  });
  const login = () => ({
    loginId: randomSiteToken(),
    loginExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    createLogin: true,
  });
  beforeEach(() => {
    process.env.KEYCLOAK_ISSUER = actor.issuer;
    process.env.SITES_UI_OAUTH_CLIENT_ID = 'lifecycle-ui';
  });
  it('denies replay of all still-unexpired same-login tokens after logout, across instances', async () => {
    const first = oauthActor();
    const refreshed = oauthActor('refreshed');
    const body = login();
    await auth.bind(first, body);
    await auth.bind(refreshed, { ...body, createLogin: false });
    const otherInstance = new SitesBrowserAuth(store as any);
    await otherInstance.assertOAuthLogin(first);
    await otherInstance.assertOAuthLogin(refreshed);
    await auth.revoke(body);
    await expect(otherInstance.assertOAuthLogin(first)).rejects.toMatchObject({ statusCode: 401 });
    await expect(otherInstance.assertOAuthLogin(refreshed)).rejects.toMatchObject({ statusCode: 401 });
    await expect(otherInstance.bind(oauthActor('late-refresh'), body)).rejects.toMatchObject({ statusCode: 401 });
  });
  it('allows a fresh independent login using the same SSO session, without reviving old tokens', async () => {
    const old = login();
    await auth.bind(oauthActor(), old);
    await auth.revoke(old);
    const fresh = login();
    await auth.bind(oauthActor('fresh-login-token'), fresh);
    await auth.assertOAuthLogin(oauthActor('fresh-login-token'));
    await expect(auth.bind(oauthActor(), fresh)).rejects.toMatchObject({ statusCode: 401 });
    await expect(auth.assertOAuthLogin(oauthActor())).rejects.toMatchObject({ statusCode: 401 });
  });
  it('denies legacy unbound UI tokens but allows separate CLI OAuth clients', async () => {
    await expect(auth.assertOAuthLogin(oauthActor())).rejects.toMatchObject({ statusCode: 401 });
    const cli = oauthActor();
    cli.oauth.clientId = 'lifecycle-cli';
    await auth.assertOAuthLogin(cli);
    await expect(auth.bind(cli, login())).rejects.toMatchObject({ statusCode: 401 });
  });
  it('fails closed if binding configuration or Redis authorization state is unavailable', async () => {
    delete process.env.SITES_UI_OAUTH_CLIENT_ID;
    await expect(auth.assertOAuthLogin(oauthActor())).rejects.toMatchObject({ statusCode: 503 });
    process.env.SITES_UI_OAUTH_CLIENT_ID = 'lifecycle-ui';
    jest.spyOn(store, 'get').mockRejectedValue(new Error('redis unavailable'));
    await expect(auth.assertOAuthLogin(oauthActor())).rejects.toMatchObject({ statusCode: 503 });
  });
  it('keeps an existing token binding authoritative after the configured UI client changes', async () => {
    const body = login();
    await auth.bind(oauthActor(), body);
    await auth.revoke(body);
    process.env.SITES_UI_OAUTH_CLIENT_ID = 'new-ui-client';
    await expect(auth.assertOAuthLogin(oauthActor())).rejects.toMatchObject({ statusCode: 401 });
  });
  it('missing login state or expired token never establishes access', async () => {
    const body = login();
    await auth.bind(oauthActor(), body);
    store.rows.delete(`sites:browser:v1:login:${siteTokenHash(body.loginId)}`);
    await expect(auth.assertOAuthLogin(oauthActor())).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      auth.bind(oauthActor('refresh-after-state-loss'), { ...body, createLogin: false })
    ).rejects.toMatchObject({ statusCode: 401 });
    const expired = oauthActor();
    expired.oauth.expiresAt = Math.floor(Date.now() / 1000) - 1;
    await expect(auth.bind(expired, body)).rejects.toMatchObject({ statusCode: 401 });
  });
  it('bind envelopes cannot be replayed or substituted for mint/revoke', async () => {
    const body = JSON.stringify(login());
    const signed = signature('bind', body);
    await expect(auth.verifyBridge('mint', body, signed)).rejects.toMatchObject({ statusCode: 401 });
    await expect(auth.verifyBridge('bind', body, signed)).resolves.toEqual(JSON.parse(body));
    await expect(auth.verifyBridge('bind', body, signed)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('encrypted viewer authorizing-token retention', () => {
  function vaultRows() {
    return [...store.rows.entries()].filter(([key]) => key.startsWith('sites:browser:v1:viewer-bearer:'));
  }
  it('introspects the exact minting bearer without putting bearer or ciphertext in viewer metadata', async () => {
    const { minted, cookies } = await setup();
    const consumed = await auth.consume(minted.ticket, host, cookies, process.env.SITES_UI_ORIGIN, async () => {});
    const viewer = await auth.viewer(consumed.sessionId, host);
    await expect(auth.getViewerOAuthTokenStatus(viewer)).resolves.toBe('active');
    expect(mockTokenStatus).toHaveBeenLastCalledWith('authorizing-bearer-secret');
    expect(vaultRows()).toHaveLength(1);
    expect(JSON.stringify([...store.rows.values()])).not.toContain('authorizing-bearer-secret');
    expect(JSON.stringify(viewer)).not.toContain('ciphertext');
    expect(JSON.stringify(minted)).not.toContain('ciphertext');
    mockTokenStatus.mockResolvedValue('revoked');
    await auth.assertLogin(viewer); // Same live app login; only the exact access token was revoked.
    await expect(auth.getViewerOAuthTokenStatus(viewer)).resolves.toBe('revoked');
  });
  it('keeps same-token retry ciphertext/deadline stable, including concurrent mint calls', async () => {
    jest.useFakeTimers();
    const { login } = await setup();
    const [key, original] = vaultRows()[0];
    jest.advanceTimersByTime(300_000);
    const challenge = await auth.challenge(site, host, '/');
    const updated = { ...login, state: challenge.state };
    const results = await Promise.all([
      auth.mint(site, actor, updated, actor.oauth.expiresAt, 'authorizing-bearer-secret'),
      auth.mint(site, actor, updated, actor.oauth.expiresAt, 'authorizing-bearer-secret'),
    ]);
    expect(vaultRows()).toHaveLength(1);
    expect(store.rows.get(key)).toEqual(original);
    for (const result of results) {
      const ticket = JSON.parse((await store.get(`sites:browser:v1:ticket:${siteTokenHash(result.ticket)}`))!);
      expect(ticket.expiresAt).toBe(JSON.parse(original.value).expiresAt);
    }
  });
  it('preserves previous token records on refresh and isolates exact-token revocation', async () => {
    const { login } = await setup();
    const refreshed = { ...actor, oauth: { ...actor.oauth, tokenId: 'refreshed-token-id' } };
    await auth.bind(refreshed, { ...login, createLogin: false });
    await auth.mint(site, refreshed, login, refreshed.oauth.expiresAt, 'refreshed-bearer-secret');
    expect(vaultRows()).toHaveLength(2);
    mockTokenStatus.mockImplementation(async (bearer) =>
      bearer === 'authorizing-bearer-secret' ? 'revoked' : 'active'
    );
    await expect(auth.getViewerOAuthTokenStatus(actor)).resolves.toBe('revoked');
    await expect(auth.getViewerOAuthTokenStatus(refreshed)).resolves.toBe('active');
    await auth.revoke(login);
    await expect(auth.getViewerOAuthTokenStatus(refreshed)).rejects.toMatchObject({ httpStatus: 401 });
  });
  it('keeps a separate login on the same SSO session independent', async () => {
    const first = await setup();
    const secondActor = { ...actor, oauth: { ...actor.oauth, tokenId: 'separate-login-token' } };
    const challenge = await auth.challenge(site, host, '/');
    const secondLogin = {
      loginId: randomSiteToken(),
      loginExpiresAt: first.login.loginExpiresAt,
      state: challenge.state,
      siteId: site.siteId,
    };
    await auth.bind(secondActor, { ...secondLogin, createLogin: true });
    await auth.mint(site, secondActor, secondLogin, secondActor.oauth.expiresAt, 'separate-login-bearer');
    await auth.revoke(first.login);
    await expect(auth.getViewerOAuthTokenStatus(actor)).rejects.toMatchObject({ httpStatus: 401 });
    await expect(auth.getViewerOAuthTokenStatus(secondActor)).resolves.toBe('active');
  });
  it.each(['missing-vault', 'missing-binding', 'missing-key', 'rotated-key', 'corrupt-vault', 'changed-metadata'])(
    'fails closed for %s without a session-list fallback',
    async (failure) => {
      await setup();
      const [key, record] = vaultRows()[0];
      let presented = actor;
      if (failure === 'missing-vault') store.rows.delete(key);
      if (failure === 'missing-binding')
        store.rows.delete(`sites:browser:v1:oauth:${siteTokenHash(`${actor.issuer}\0${actor.oauth.tokenId}`)}`);
      if (failure === 'missing-key') delete process.env.SITES_BROWSER_BRIDGE_SECRET;
      if (failure === 'rotated-key') process.env.SITES_BROWSER_BRIDGE_SECRET = 'y'.repeat(40);
      if (failure === 'corrupt-vault') {
        const value = JSON.parse(record.value);
        value.tag = Buffer.alloc(16).toString('base64url');
        store.rows.set(key, { ...record, value: JSON.stringify(value) });
      }
      if (failure === 'changed-metadata')
        presented = { ...actor, oauth: { ...actor.oauth, sessionId: 'other-session' } };
      await expect(auth.getViewerOAuthTokenStatus(presented)).rejects.toBeInstanceOf(SitesBrowserError);
      expect(mockTokenStatus).not.toHaveBeenCalled();
    }
  );
  it('caps retention at 15 minutes, token expiry and login expiry, and rejects expired records', async () => {
    jest.useFakeTimers();
    await setup();
    expect(vaultRows()[0][1].until - Date.now()).toBeLessThanOrEqual(900_000);
    jest.advanceTimersByTime(901_000);
    await expect(auth.getViewerOAuthTokenStatus(actor)).rejects.toMatchObject({ httpStatus: 401 });
    const short = {
      ...actor,
      oauth: { ...actor.oauth, tokenId: 'short', expiresAt: Math.floor(Date.now() / 1000) + 40 },
    };
    const challenge = await auth.challenge(site, host, '/');
    const login = {
      loginId: randomSiteToken(),
      loginExpiresAt: Math.floor(Date.now() / 1000) + 20,
      state: challenge.state,
      siteId: site.siteId,
    };
    await auth.bind(short, { ...login, createLogin: true });
    await auth.mint(site, short, login, short.oauth.expiresAt, 'short-bearer');
    const shortRow = vaultRows().find(([_, row]) => row.until > Date.now())![1];
    expect(shortRow.until - Date.now()).toBeLessThanOrEqual(20_000);
    jest.advanceTimersByTime(21_000);
    await expect(auth.getViewerOAuthTokenStatus(short)).rejects.toMatchObject({ httpStatus: 401 });
  });
  it('fails closed for unavailable Redis or unknown introspection', async () => {
    await setup();
    mockTokenStatus.mockResolvedValue('unknown');
    await expect(auth.getViewerOAuthTokenStatus(actor)).resolves.toBe('unknown');
    jest.spyOn(store, 'get').mockRejectedValue(new Error('unavailable'));
    await expect(auth.getViewerOAuthTokenStatus(actor)).rejects.toMatchObject({ httpStatus: 503 });
  });
});
