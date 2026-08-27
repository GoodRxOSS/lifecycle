import { NextRequest } from 'next/server';

const mockGetUser = jest.fn();
const mockAssertManagementAllowed = jest.fn();
const mockRevokeByOwnerIdentifier = jest.fn();
const mockRevokeAllUserTokens = jest.fn();
const mockLogger = { error: jest.fn(), info: jest.fn() };

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    return user ? { userId: user.sub, roles: user.realm_access?.roles ?? [] } : null;
  },
  requireRequestUserIdentity: (...args: unknown[]) => {
    const user = mockGetUser(...args);
    if (!user) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
    return { userId: user.sub, roles: user.realm_access?.roles ?? [] };
  },
}));

jest.mock('server/services/apiToken', () => ({
  __esModule: true,
  default: {
    assertManagementAllowed: (...args: unknown[]) => mockAssertManagementAllowed(...args),
    revokeByOwnerIdentifier: (...args: unknown[]) => mockRevokeByOwnerIdentifier(...args),
    revokeAllUserTokens: (...args: unknown[]) => mockRevokeAllUserTokens(...args),
  },
}));

jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));

import { ConflictError, ForbiddenError } from 'server/lib/appError';
import { POST as revokeByOwner } from '../revoke-by-owner/route';
import { POST as revokeAllUserTokens } from '../revoke-all-user-tokens/route';

function request(path: string, body?: unknown, rawBody?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-revoke' },
    ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('admin bulk token revocation routes', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'admin-1', realm_access: { roles: ['admin'] } });
    mockAssertManagementAllowed.mockImplementation(() => undefined);
    mockRevokeByOwnerIdentifier.mockResolvedValue({ count: 2 });
    mockRevokeAllUserTokens.mockResolvedValue({ count: 7 });
  });

  afterAll(() => {
    if (originalEnableAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalEnableAuth;
  });

  it.each([
    ['owner-selective revoke', revokeByOwner, '/api/v2/tokens/revoke-by-owner'],
    ['all-user-token revoke', revokeAllUserTokens, '/api/v2/tokens/revoke-all-user-tokens'],
  ])('rejects a non-admin before %s checks management state', async (_label, handler, path) => {
    mockGetUser.mockReturnValue({ sub: 'user-1', realm_access: { roles: ['user'] } });

    const response = await handler(request(path, { ownerEmail: 'user@example.com' }));

    expect(response.status).toBe(403);
    expect(mockAssertManagementAllowed).not.toHaveBeenCalled();
    expect(mockRevokeByOwnerIdentifier).not.toHaveBeenCalled();
    expect(mockRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('revokes every user-owned token and records the authenticated admin', async () => {
    const response = await revokeAllUserTokens(request('/api/v2/tokens/revoke-all-user-tokens'));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ count: 7 });
    expect(mockAssertManagementAllowed).toHaveBeenCalledTimes(1);
    expect(mockRevokeAllUserTokens).toHaveBeenCalledWith('admin-1');
  });

  it('returns the management-policy error without revoking all user tokens', async () => {
    mockAssertManagementAllowed.mockImplementation(() => {
      throw new ForbiddenError('Token management is disabled.', { policy: 'disabled' });
    });

    const response = await revokeAllUserTokens(request('/api/v2/tokens/revoke-all-user-tokens'));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toEqual({
      message: 'Token management is disabled.',
      code: 'forbidden',
      details: { policy: 'disabled' },
    });
    expect(mockRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it.each([
    ['user id', { ownerUserId: '  keycloak-user-1  ' }, 'ownerUserId', 'keycloak-user-1'],
    ['email', { ownerEmail: '  User@Example.com ' }, 'ownerEmail', 'User@Example.com'],
    ['preferred username', { ownerPreferredUsername: '  octocat  ' }, 'ownerPreferredUsername', 'octocat'],
  ])('revokes by %s after trimming the selected identifier', async (_label, body, field, value) => {
    const response = await revokeByOwner(request('/api/v2/tokens/revoke-by-owner', body));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ count: 2 });
    expect(mockAssertManagementAllowed).toHaveBeenCalledTimes(1);
    expect(mockRevokeByOwnerIdentifier).toHaveBeenCalledWith(field, value, 'admin-1');
  });

  it.each([
    ['invalid JSON', undefined, '{broken'],
    ['missing selector', {}, undefined],
    ['blank selector', { ownerEmail: '   ' }, undefined],
    ['non-string selector', { ownerUserId: 42 }, undefined],
    ['multiple selectors', { ownerEmail: 'user@example.com', ownerPreferredUsername: 'octocat' }, undefined],
  ])('rejects %s without revoking tokens', async (_label, body, rawBody) => {
    const response = await revokeByOwner(request('/api/v2/tokens/revoke-by-owner', body, rawBody));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual({
      message: 'Provide exactly one of ownerUserId, ownerEmail, ownerPreferredUsername.',
      code: 'invalid_selector',
    });
    expect(mockRevokeByOwnerIdentifier).not.toHaveBeenCalled();
  });

  it('preserves an ambiguous-owner conflict from the token service', async () => {
    mockRevokeByOwnerIdentifier.mockRejectedValue(
      new ConflictError('ownerEmail resolves to multiple owners.', 'ambiguous_owner', {
        ownerEmail: 'shared@example.com',
      })
    );

    const response = await revokeByOwner(
      request('/api/v2/tokens/revoke-by-owner', { ownerEmail: 'shared@example.com' })
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toEqual({
      message: 'ownerEmail resolves to multiple owners.',
      code: 'ambiguous_owner',
      details: { ownerEmail: 'shared@example.com' },
    });
  });

  it('maps an unexpected bulk-revocation failure to 500', async () => {
    mockRevokeAllUserTokens.mockRejectedValue(new Error('database unavailable'));

    const response = await revokeAllUserTokens(request('/api/v2/tokens/revoke-all-user-tokens'));

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('database unavailable');
  });
});
