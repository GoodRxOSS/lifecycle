/** Signed JWT integration with in-memory authorization dependencies; no servers or real accounts. */
import type { IncomingMessage } from 'http';
import { NextRequest } from 'next/server';
import { createRemoteJWKSet, generateKeyPair, SignJWT } from 'jose';
import { verifyBearerToken } from 'server/lib/auth';
import { resolvePrincipal } from 'server/lib/principal';
import { getVerifiedOAuthBearer } from 'server/lib/verifiedOAuthBearer';
import { authenticateMcpRequest } from 'server/mcp/auth';
import { SitesBrowserAuth, challengeCookieName } from './browserAuth';
import { assertSitesPrincipal } from './policy';
import { authorizeSitesViewer } from './gateway';

jest.mock('jose', () => ({ ...jest.requireActual('jose'), createRemoteJWKSet: jest.fn() }));
jest.mock('server/services/apiToken', () => ({ __esModule: true, default: {} }));
jest.mock('server/models/ApiToken', () => ({ __esModule: true, default: {} }));
jest.mock('server/services/globalConfig', () => ({ __esModule: true, default: {} }));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ warn: jest.fn(), error: jest.fn() }) }));
const mockDirectorySession = jest.fn();
jest.mock('server/services/keycloak/principalStatus', () => ({
  getUserStatus: async () => 'active',
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
  eval: async (script: string, _count: number, key: string) => {
    if (script.includes('sites-consume')) {
      const current = mockRows.get(key);
      mockRows.delete(key);
      return current ?? null;
    }
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
  process.env.LIFECYCLE_UI_URL = 'https://ui.example.com';
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
    .setExpirationTime('5m')
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

test('existing UI and CLI JWTs authorize REST/MCP without a separate application login', async () => {
  for (const client of ['lifecycle-ui', 'lifecycle-cli']) {
    for (const principal of await principals(await sign(`token-${client}`, client))) {
      await assertSitesPrincipal(principal, 'write');
      expect(principal.oauth!.expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
    }
  }
  expect(mockRows.size).toBe(0);
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

test('offline OAuth retains incoming token status validation without login registration', async () => {
  const token = await sign('offline-ui', 'lifecycle-ui', true);
  for (const principal of await principals(token)) await assertSitesPrincipal(principal);
  expect(mockDirectorySession).toHaveBeenCalledWith(token);
});

test('issued viewers use only their fixed grant deadline; new authorization still checks token status', async () => {
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
  const actor = { issuer, subject: 'owner' };
  await assertSitesPrincipal(rest);
  const minted = await auth.mint(site, actor, { state: challenge.state, siteId: site.siteId }, rest.oauth!.expiresAt);
  const consumed = await auth.consume(
    minted.ticket,
    host,
    { [challengeCookieName(challenge.state)]: challenge.secret },
    process.env.LIFECYCLE_UI_URL,
    async (viewer) => authorizeSitesViewer(site as any, viewer)
  );
  const viewer = await auth.viewer(consumed.sessionId, host);
  expect(JSON.stringify(viewer)).not.toContain(bearer);
  expect(JSON.stringify(viewer)).not.toContain('ciphertext');
  expect(Array.from(mockRows.values()).some((row) => row.includes(bearer))).toBe(false);
  await authorizeSitesViewer(site as any, viewer);
  // V1 accepts revocation freshness bounded by the already-issued grant deadline.
  mockDirectorySession.mockImplementation(async (token) => (token === bearer ? 'revoked' : 'active'));
  mockDirectorySession.mockClear();
  await authorizeSitesViewer(site as any, viewer);
  expect(mockDirectorySession).not.toHaveBeenCalled();
  await expect(assertSitesPrincipal(rest)).rejects.toMatchObject({ httpStatus: 401 });
  await expect(
    authorizeSitesViewer(site as any, { ...viewer, expiresAt: Math.floor(Date.now() / 1000) })
  ).rejects.toMatchObject({ httpStatus: 401 });
  for (const changed of [
    { ownerSubject: 'other' },
    { servingGeneration: 'new' },
    { accessRevision: 2 },
    { siteId: 'other' },
  ]) {
    await expect(authorizeSitesViewer({ ...site, ...changed } as any, viewer)).rejects.toMatchObject({
      httpStatus: expect.any(Number),
    });
  }
});
