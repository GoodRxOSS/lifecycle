import { NextRequest } from 'next/server';
import type { Principal } from 'server/lib/principal';
import { AppError } from 'server/lib/appError';
import { SitesBrowserAuth, randomSiteToken } from 'server/lib/sites/browserAuth';

const mockResolvePrincipal = jest.fn();
const mockStatus = jest.fn();
const mockTokenStatus = jest.fn();
const mockSite = jest.fn();
const mockRedisRows = new Map<string, string>();
const mockRedis = {
  get: async (key: string) => mockRedisRows.get(key) ?? null,
  set: async (key: string, value: string) => {
    mockRedisRows.set(key, value);
    return 'OK';
  },
  eval: async () => 1,
};
jest.mock('server/lib/principal', () => ({ resolvePrincipal: (...args: unknown[]) => mockResolvePrincipal(...args) }));
jest.mock('server/services/apiToken', () => ({
  scopeSatisfies: (scopes: string[], scope: string) => scopes.includes(scope),
}));
jest.mock('server/services/authRateLimit', () => ({ checkApiKeyRateLimit: async () => ({ allowed: true }) }));
jest.mock('server/services/authAudit', () => ({ recordAuthAuditEvent: jest.fn() }));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ error: jest.fn(), info: jest.fn() }) }));
jest.mock('server/models/ApiToken', () => ({ __esModule: true, default: {} }));
jest.mock('server/services/globalConfig', () => ({ __esModule: true, default: {} }));
jest.mock('server/lib/redisClient', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getRedis: () => mockRedis }) },
}));
jest.mock('server/services/sites', () => ({
  __esModule: true,
  default: jest.fn(() => ({ getGatewaySite: (...args: unknown[]) => mockSite(...args) })),
}));
jest.mock('server/services/keycloak/principalStatus', () => ({
  getUserStatus: (...args: unknown[]) => mockStatus(...args),
  getOAuthTokenStatus: (...args: unknown[]) => mockTokenStatus(...args),
}));
import { rememberVerifiedOAuthBearer } from 'server/lib/verifiedOAuthBearer';
import { POST } from './route';
const issuer = 'https://identity.example/realms/lifecycle';
const host = 'site-abc123--g-abcdef012345.sites.example.net';
const site = {
  siteId: 'abc123',
  ownerKind: 'user',
  ownerIssuer: issuer,
  ownerSubject: 'owner',
  visibility: 'private',
  servingGeneration: 'abcdef012345',
  accessRevision: 1,
};
let principal: Principal;
const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.ENABLE_AUTH = 'true';
  process.env.KEYCLOAK_ISSUER = issuer;
  process.env.LIFECYCLE_UI_URL = 'https://ui.example.com';
  mockRedisRows.clear();
  principal = {
    kind: 'user',
    authMethod: 'session',
    issuer,
    userId: 'owner',
    actor: 'owner',
    roles: ['user'],
    scopes: null,
    tokenId: null,
    repositoryAllowlist: null,
    repositoryAllowlistRepoIds: null,
    identity: null,
    oauth: {
      sessionId: 'sid',
      tokenId: 'jti',
      clientId: 'existing-ui',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    },
  };
  rememberVerifiedOAuthBearer(principal, 'verified-request-bearer');
  mockResolvePrincipal.mockReset().mockImplementation(async () => principal);
  mockStatus.mockReset().mockResolvedValue('active');
  mockTokenStatus.mockReset().mockResolvedValue('active');
  mockSite.mockReset().mockResolvedValue({ site });
});
afterEach(() => {
  process.env = { ...originalEnv };
});
async function mint(body?: Record<string, unknown>) {
  const challenge = await new SitesBrowserAuth(mockRedis as any).challenge(site, host, '/');
  return POST(
    new NextRequest('https://api.example/api/v2/sites/browser/mint', {
      method: 'POST',
      headers: { authorization: 'Bearer verified-request-bearer', 'content-type': 'application/json' },
      body: JSON.stringify(body ?? { siteId: site.siteId, state: challenge.state }),
    })
  );
}
it('mints with existing JWT authentication and only siteId/state, without any bridge config', async () => {
  const response = await mint();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json()).data).toEqual({
    ticket: expect.any(String),
    consumeUrl: `https://${host}/_lfc-sites/consume`,
  });
  expect(mockStatus).toHaveBeenCalledWith('owner');
  expect(mockTokenStatus).toHaveBeenCalledWith('verified-request-bearer');
});
it.each(['personal_key', 'service_key'] as const)('rejects %s at the real route wrapper', async (kind) => {
  principal.kind = kind;
  principal.authMethod = 'api_key';
  const response = await mint();
  expect(response.status).toBe(403);
  expect(mockTokenStatus).not.toHaveBeenCalled();
  expect(mockSite).not.toHaveBeenCalled();
});
it('denies anonymous, unrelated owner, expired JWT and disabled account without issuing tickets', async () => {
  mockResolvePrincipal.mockRejectedValueOnce(
    new AppError({ httpStatus: 401, code: 'invalid_credential', message: 'Denied' })
  );
  expect((await mint()).status).toBe(401);
  principal.userId = 'other';
  expect((await mint()).status).toBe(404);
  principal.userId = 'owner';
  principal.oauth!.expiresAt = Math.floor(Date.now() / 1000);
  expect((await mint()).status).toBe(401);
  principal.oauth!.expiresAt += 300;
  mockStatus.mockResolvedValue('disabled');
  expect((await mint()).status).toBe(403);
  expect([...mockRedisRows.keys()].some((key) => key.includes(':ticket:'))).toBe(false);
});
it('denies unknown or revoked incoming credentials and invented owner fields', async () => {
  mockTokenStatus.mockResolvedValueOnce('unknown');
  expect((await mint()).status).toBe(503);
  mockTokenStatus.mockResolvedValueOnce('revoked');
  expect((await mint()).status).toBe(401);
  expect((await mint({ siteId: site.siteId, state: randomSiteToken(), ownerSubject: 'owner' })).status).toBe(400);
});
