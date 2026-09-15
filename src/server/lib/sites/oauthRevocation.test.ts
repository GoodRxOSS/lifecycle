/** Signed JWT integration with in-memory authorization dependencies; no servers or real accounts. */
import type { IncomingMessage } from 'http';
import { NextRequest } from 'next/server';
import { createRemoteJWKSet, generateKeyPair, SignJWT } from 'jose';
import { verifyBearerToken } from 'server/lib/auth';
import { resolvePrincipal } from 'server/lib/principal';
import { getVerifiedOAuthBearer } from 'server/lib/verifiedOAuthBearer';
import { authenticateMcpRequest } from 'server/mcp/auth';
import { SitesBrowserAuth, randomSiteToken, challengeCookieName } from './browserAuth';
import { assertSitesPrincipal } from './policy';

jest.mock('jose', () => ({ ...jest.requireActual('jose'), createRemoteJWKSet: jest.fn() }));
jest.mock('server/services/apiToken', () => ({ __esModule: true, default: {} }));
jest.mock('server/models/ApiToken', () => ({ __esModule: true, default: {} }));
jest.mock('server/services/globalConfig', () => ({ __esModule: true, default: {} }));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ warn: jest.fn(), error: jest.fn() }) }));
const mockDirectorySession = jest.fn();
jest.mock('server/services/keycloak/principalStatus', () => ({
  getUserStatus: async () => 'active',
  getUserSessionStatus: (...args: unknown[]) => mockDirectorySession(...args),
  getOAuthTokenStatus: (...args: unknown[]) => mockDirectorySession(...args),
}));
const mockRows = new Map<string, string>();
const mockRedis = {
  get: async (key: string) => mockRows.get(key) ?? null,
  set: async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
    if (nx && mockRows.has(key)) return null;
    mockRows.set(key, value);
    return 'OK';
  },
  eval: async (_script: string, _count: number, key: string, value: string, _ttl: number, mode?: string) => {
    const current = mockRows.get(key);
    if (_script.includes('sites-consume')) {
      mockRows.delete(key);
      return current ?? null;
    }
    if (mode === 'existing' && !current) return 0;
    if (current && current !== value) return 0;
    mockRows.set(key, value);
    return 1;
  },
};
jest.mock('server/lib/redisClient', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getRedis: () => mockRedis }) },
}));
const issuer = 'https://identity.example/realms/lifecycle';
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
const originalEnv = { ...process.env };
beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  (createRemoteJWKSet as jest.Mock).mockReturnValue(keys.publicKey);
  process.env.ENABLE_AUTH = 'true';
  process.env.KEYCLOAK_ISSUER = issuer;
  process.env.KEYCLOAK_CLIENT_ID = 'lifecycle-api';
  process.env.KEYCLOAK_JWKS_URL = 'https://identity.example/test-jwks';
  process.env.SITES_UI_OAUTH_CLIENT_ID = 'lifecycle-ui';
  process.env.SITES_PRIVATE_ENABLED = 'true';
  process.env.SITES_UI_ORIGIN = 'https://ui.example.com';
  process.env.SITES_BROWSER_BRIDGE_SECRET = 'x'.repeat(40);
  process.env.APP_HOST = 'https://api.example';
});
beforeEach(() => {
  mockRows.clear();
  mockDirectorySession.mockResolvedValue('active');
});
afterAll(() => {
  process.env = originalEnv;
});

async function sign(tokenId: string, clientId = 'lifecycle-ui', offlineAccess = false) {
  return new SignJWT({
    sid: 'shared-sso-session',
    azp: clientId,
    scope: offlineAccess ? 'openid mcp offline_access' : 'openid mcp',
    realm_access: { roles: ['user'] },
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject('owner')
    .setIssuer(issuer)
    .setAudience(['lifecycle-api', 'https://api.example/mcp'])
    .setJti(tokenId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}
async function principals(token: string) {
  const verified = await verifyBearerToken(token);
  expect(verified.success).toBe(true);
  const request = new NextRequest('https://api.example/api/v2/sites', {
    headers: {
      authorization: `Bearer ${token}`,
      'x-user': Buffer.from(JSON.stringify(verified.payload)).toString('base64url'),
    },
  });
  const rest = await resolvePrincipal(request);
  const mcp = await authenticateMcpRequest({ headers: { authorization: `Bearer ${token}` } } as IncomingMessage);
  if (!mcp.ok) throw new Error(`MCP authentication failed: ${mcp.message}`);
  expect(mcp.principal.oauth).toEqual(rest.oauth);
  expect(getVerifiedOAuthBearer(rest)).toBe(token);
  expect(getVerifiedOAuthBearer(mcp.principal)).toBe(token);
  expect(JSON.stringify(rest)).not.toContain(token);
  expect(getVerifiedOAuthBearer({ ...rest })).toBeUndefined();
  return [rest, mcp.principal];
}

test('unexpired bearer replay after app logout fails Sites policy through REST and MCP', async () => {
  const auth = new SitesBrowserAuth(mockRedis as any);
  const login = { loginId: randomSiteToken(), loginExpiresAt: Math.floor(Date.now() / 1000) + 3600, createLogin: true };
  const bearer = await sign('initial-token');
  const refreshed = await sign('refreshed-token');
  for (const token of [bearer, refreshed]) {
    const [rest, mcp] = await principals(token);
    await auth.bind({ issuer, subject: 'owner', oauth: rest.oauth }, login);
    await assertSitesPrincipal(rest, 'write');
    await assertSitesPrincipal(mcp, 'read');
  }
  await auth.revoke(login);
  // JWT verification still succeeds; Sites authorization must independently deny it.
  for (const token of [bearer, refreshed]) {
    for (const principal of await principals(token))
      await expect(assertSitesPrincipal(principal, 'write')).rejects.toMatchObject({ httpStatus: 401 });
  }
  const freshLogin = { ...login, loginId: randomSiteToken() };
  for (const principal of await principals(await sign('new-login-token'))) {
    await auth.bind({ issuer, subject: 'owner', oauth: principal.oauth }, freshLogin);
    await assertSitesPrincipal(principal, 'write');
  }
});

test('unbound old UI tokens fail closed while separate CLI OAuth remains supported', async () => {
  for (const principal of await principals(await sign('legacy-unbound')))
    await expect(assertSitesPrincipal(principal)).rejects.toMatchObject({ httpStatus: 401 });
  for (const principal of await principals(await sign('cli-token', 'lifecycle-cli')))
    await assertSitesPrincipal(principal);
});

test('IdP session revocation denies signed CLI OAuth tokens with an otherwise enabled account', async () => {
  const token = await sign('cli-token', 'lifecycle-cli');
  mockDirectorySession.mockResolvedValue('revoked');
  for (const principal of await principals(token))
    await expect(assertSitesPrincipal(principal)).rejects.toMatchObject({
      httpStatus: 401,
      code: 'oauth_session_unavailable',
    });
  expect(mockDirectorySession).toHaveBeenCalledWith(token);
});

test('offline OAuth selects live offline validation without bypassing application logout', async () => {
  const auth = new SitesBrowserAuth(mockRedis as any);
  const login = { loginId: randomSiteToken(), loginExpiresAt: Math.floor(Date.now() / 1000) + 3600, createLogin: true };
  const token = await sign('offline-ui', 'lifecycle-ui', true);
  for (const principal of await principals(token)) {
    await auth.bind({ issuer, subject: 'owner', oauth: principal.oauth }, login);
    await assertSitesPrincipal(principal);
  }
  expect(mockDirectorySession).toHaveBeenCalledWith(token);
  await auth.revoke(login);
  for (const principal of await principals(token))
    await expect(assertSitesPrincipal(principal)).rejects.toMatchObject({ httpStatus: 401 });
});

test('a token-level revoke with live login blocks the next protected viewer authorization', async () => {
  const bearer = await sign('viewer-token');
  const [rest] = await principals(bearer);
  const auth = new SitesBrowserAuth(mockRedis as any);
  const site = {
    siteId: 'test-site',
    ownerKind: 'user',
    ownerIssuer: issuer,
    ownerSubject: 'owner',
    visibility: 'private',
    servingGeneration: 'abcdef012345',
    accessRevision: 1,
  };
  const host = 'site-test--g-abcdef012345.sites.example.net';
  const challenge = await auth.challenge(site, host, '/');
  const login = { loginId: randomSiteToken(), loginExpiresAt: Math.floor(Date.now() / 1000) + 3600, createLogin: true };
  const actor = { issuer, subject: 'owner', oauth: rest.oauth };
  await auth.bind(actor, login);
  const minted = await auth.mint(
    site,
    actor,
    { ...login, state: challenge.state, siteId: site.siteId },
    rest.oauth!.expiresAt,
    bearer
  );
  const viewerPrincipal = { ...rest, authMethod: 'sites_viewer' as const };
  const consumed = await auth.consume(
    minted.ticket,
    host,
    { [challengeCookieName(challenge.state)]: challenge.secret },
    process.env.SITES_UI_ORIGIN,
    async () => {
      await assertSitesPrincipal(viewerPrincipal);
    }
  );
  const viewer = await auth.viewer(consumed.sessionId, host);
  expect(JSON.stringify(viewer)).not.toContain(bearer);
  expect(JSON.stringify(viewer)).not.toContain('ciphertext');
  expect(Array.from(mockRows.values()).some((row) => row.includes(bearer))).toBe(false);
  await assertSitesPrincipal(viewerPrincipal);
  // Only this token's status changes: the user, browser login and sid remain live.
  mockDirectorySession.mockImplementation(async (token) => (token === bearer ? 'revoked' : 'active'));
  await auth.assertLogin(viewer);
  await expect(assertSitesPrincipal(rest)).rejects.toMatchObject({ httpStatus: 401 });
  await expect(assertSitesPrincipal(viewerPrincipal)).rejects.toMatchObject({ httpStatus: 401 });
});
