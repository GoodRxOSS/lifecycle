import type { Principal } from 'server/lib/principal';
import type Site from 'server/models/Site';
import { assertSitesPrincipal, assertSiteOwner, isSiteOwner } from './policy';
import { rememberVerifiedOAuthBearer } from 'server/lib/verifiedOAuthBearer';
const mockStatus = jest.fn();
const mockToken = jest.fn();
const mockSession = jest.fn();
const mockOAuthLogin = jest.fn();
jest.mock('./browserAuth', () => ({
  getSitesBrowserAuth: () => ({
    assertOAuthLogin: (...args: unknown[]) => mockOAuthLogin(...args),
    getViewerOAuthTokenStatus: (...args: unknown[]) => mockSession(...args),
  }),
}));
jest.mock('server/models/ApiToken', () => ({
  __esModule: true,
  default: { query: () => ({ findById: (...args: unknown[]) => mockToken(...args) }) },
}));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ getConfig: async () => ({ personalAuthEnabled: true, serviceAuthEnabled: true }) }),
  },
}));
jest.mock('server/services/keycloak/principalStatus', () => ({
  getUserStatus: (...args: unknown[]) => mockStatus(...args),
  getOAuthTokenStatus: (...args: unknown[]) => mockSession(...args),
}));
const issuer = 'https://identity.example/realms/lifecycle';
const human = (overrides: Partial<Principal> = {}): Principal => ({
  kind: 'user',
  authMethod: 'sites_viewer',
  issuer,
  oauth: { sessionId: 'sid', tokenId: 'jti', clientId: 'ui', expiresAt: Math.floor(Date.now() / 1000) + 300 },
  userId: 'alice',
  actor: 'alice',
  roles: ['admin'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: null,
  ...overrides,
});
const site = { ownerKind: 'user', ownerIssuer: issuer, ownerSubject: 'alice', creatorTokenId: null } as Site;
const previousEnv = { ...process.env };
beforeEach(() => {
  process.env.ENABLE_AUTH = 'true';
  process.env.KEYCLOAK_ISSUER = issuer;
  mockStatus.mockReset().mockResolvedValue('active');
  mockSession.mockReset().mockResolvedValue('active');
  mockOAuthLogin.mockReset().mockResolvedValue(undefined);
  mockToken
    .mockReset()
    .mockResolvedValue({ kind: 'personal', ownerUserId: 'alice', ownerIssuer: issuer, scopes: ['sites:write'] });
});
afterEach(() => {
  process.env = { ...previousEnv };
});

test('admin status, matching display email, or a different issuer never grant ownership', () => {
  expect(isSiteOwner(site, human())).toBe(true);
  expect(isSiteOwner(site, human({ userId: 'bob' }))).toBe(false);
  expect(isSiteOwner(site, human({ issuer: 'https://other.example/realm' }))).toBe(false);
  expect(() => assertSiteOwner(site, human({ userId: 'bob' }))).toThrow('Site not found');
  expect(isSiteOwner({ ...site, ownerKind: 'unresolved' } as Site, human())).toBe(false);
});
test('machine ownership is the immutable token id and cannot impersonate a human', async () => {
  const machine = human({ kind: 'service_key', userId: null, issuer: null, tokenId: 7, scopes: ['sites:write'] });
  mockToken.mockResolvedValue({ kind: 'service', scopes: ['sites:write'] });
  await assertSitesPrincipal(machine, 'write');
  expect(mockStatus).not.toHaveBeenCalled();
  const machineSite = {
    ...site,
    ownerKind: 'service_key',
    ownerSubject: null,
    ownerIssuer: null,
    creatorTokenId: 7,
  } as Site;
  expect(isSiteOwner(machineSite, machine)).toBe(true);
  expect(isSiteOwner(machineSite, { ...machine, tokenId: 8 })).toBe(false);
  expect(isSiteOwner(site, machine)).toBe(false);
});
test.each(['disabled', 'deleted', 'no_base_role', 'unknown'])(
  'a %s account fails closed, including personal keys',
  async (status) => {
    mockStatus.mockResolvedValue(status);
    await expect(
      assertSitesPrincipal(human({ kind: 'personal_key', tokenId: 7, scopes: ['sites:write'] }), 'write')
    ).rejects.toMatchObject({ code: 'principal_unavailable', httpStatus: status === 'unknown' ? 503 : 403 });
  }
);
test('auth-off cannot authenticate a synthetic development admin or an existing viewer session', async () => {
  process.env.ENABLE_AUTH = 'false';
  await expect(assertSitesPrincipal(human())).rejects.toMatchObject({ httpStatus: 401 });
  expect(mockStatus).not.toHaveBeenCalled();
});
test('legacy personal keys without issuer binding fail closed for Sites', async () => {
  await expect(assertSitesPrincipal(human({ kind: 'personal_key', issuer: null }))).rejects.toMatchObject({
    httpStatus: 401,
  });
});
test('scopes cap ownership rights and write implies read', async () => {
  await expect(assertSitesPrincipal(human({ scopes: ['sites:read'] }), 'write')).rejects.toMatchObject({
    code: 'insufficient_scope',
  });
  await expect(assertSitesPrincipal(human({ scopes: ['env:write'] }))).rejects.toMatchObject({
    code: 'insufficient_scope',
  });
  await expect(assertSitesPrincipal(human({ scopes: ['sites:write'] }))).resolves.toBeUndefined();
});

test('a key revoked during a staged upload cannot authorize its commit', async () => {
  const key = human({ kind: 'personal_key', tokenId: 7, scopes: ['sites:write'] });
  await assertSitesPrincipal(key, 'write');
  mockToken.mockResolvedValue({
    kind: 'personal',
    ownerUserId: 'alice',
    ownerIssuer: issuer,
    scopes: ['sites:write'],
    revokedAt: new Date().toISOString(),
  });
  await expect(assertSitesPrincipal(key, 'write')).rejects.toMatchObject({ code: 'invalid_credential' });
});

test.each(['revoked', 'unknown'])('a %s OAuth session fails closed despite an enabled account', async (status) => {
  mockSession.mockResolvedValue(status);
  await expect(assertSitesPrincipal(human())).rejects.toMatchObject({
    code: 'oauth_session_unavailable',
    httpStatus: status === 'unknown' ? 503 : 401,
  });
});
test('a legacy OAuth token missing revocation claims cannot access Sites', async () => {
  await expect(assertSitesPrincipal(human({ oauth: undefined }))).rejects.toMatchObject({ httpStatus: 401 });
});
test('application logout prevents REST and MCP write authorization even with a live IdP session', async () => {
  mockOAuthLogin.mockRejectedValue(new Error('revoked application login'));
  for (const authMethod of ['session', 'oauth'] as const) {
    const principal = human({ authMethod });
    rememberVerifiedOAuthBearer(principal, 'test-bearer');
    await expect(assertSitesPrincipal(principal, 'write')).rejects.toThrow('revoked application login');
  }
});
test('personal API keys keep their independent lifetime after application or IdP logout', async () => {
  mockSession.mockResolvedValue('revoked');
  mockOAuthLogin.mockRejectedValue(new Error('revoked application login'));
  await expect(assertSitesPrincipal(human({ kind: 'personal_key', tokenId: 7 }))).resolves.toBeUndefined();
  expect(mockSession).not.toHaveBeenCalled();
  expect(mockOAuthLogin).not.toHaveBeenCalled();
});

test('REST/MCP principals missing their request-only bearer association fail closed', async () => {
  await expect(assertSitesPrincipal(human({ authMethod: 'oauth' }))).rejects.toMatchObject({ httpStatus: 401 });
  await expect(assertSitesPrincipal(human({ authMethod: 'session' }))).rejects.toMatchObject({ httpStatus: 401 });
});
