/**
 * Copyright 2026 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const mockWarn = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: mockWarn }),
}));

import { KeycloakAdminClient, KeycloakAdminError } from './adminClient';
import { getUserStatus, isConfigured, KeycloakPrincipalStatus } from './principalStatus';

const CONFIG_KEYS = [
  'KEYCLOAK_ISSUER_INTERNAL',
  'KEYCLOAK_ISSUER',
  'KEYCLOAK_ADMIN_BASE_URL',
  'KEYCLOAK_PRINCIPAL_SYNC_CLIENT_ID',
  'KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET',
] as const;

const originalConfig = Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key]]));

function clearPrincipalStatusConfig(): void {
  for (const key of CONFIG_KEYS) delete process.env[key];
}

function restorePrincipalStatusConfig(): void {
  for (const key of CONFIG_KEYS) {
    const value = originalConfig[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function service(get: jest.Mock): KeycloakPrincipalStatus {
  return new KeycloakPrincipalStatus({ get } as unknown as KeycloakAdminClient);
}

describe('KeycloakPrincipalStatus', () => {
  it('reports a disabled user without querying role assignments', async () => {
    const get = jest.fn(async () => ({ enabled: false }));

    await expect(service(get).getUserStatus('user/one')).resolves.toBe('disabled');

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/users/user%2Fone');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('reports a missing user as deleted without querying role assignments', async () => {
    const get = jest.fn(async () => {
      throw new KeycloakAdminError('not_found', 404, 'not found');
    });

    await expect(service(get).getUserStatus('user-2')).resolves.toBe('deleted');

    expect(get).toHaveBeenCalledTimes(1);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('accepts a base role assigned directly to a user whose enabled flag is absent', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{}, { name: 'viewer' }, { name: 'user' }]);

    await expect(service(get).getUserStatus('user 1')).resolves.toBe('active');

    expect(get.mock.calls).toEqual([['/users/user%201'], ['/users/user%201/role-mappings/realm/composite']]);
  });

  it('fails closed without querying groups when direct role mappings are malformed', async () => {
    const get = jest.fn().mockResolvedValueOnce({ enabled: true }).mockResolvedValueOnce({ name: 'user' });

    await expect(service(get).getUserStatus('user-1')).resolves.toBe('unknown');

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('reports no base role when the user has no direct roles or groups', async () => {
    const get = jest.fn().mockResolvedValueOnce({ enabled: true }).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(service(get).getUserStatus('user-1')).resolves.toBe('no_base_role');

    expect(get.mock.calls).toEqual([
      ['/users/user-1'],
      ['/users/user-1/role-mappings/realm/composite'],
      ['/users/user-1/groups?briefRepresentation=true&max=100'],
    ]);
  });

  it('fails closed when the group membership response is malformed', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'group-1' });

    await expect(service(get).getUserStatus('user-1')).resolves.toBe('unknown');

    expect(get).toHaveBeenCalledTimes(3);
  });

  it('fails closed at the group page limit without traversing a potentially truncated page', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: `group-${index}`, path: `/group-${index}` }));
    const get = jest
      .fn()
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(fullPage);

    await expect(service(get).getUserStatus('user-1')).resolves.toBe('unknown');

    expect(get).toHaveBeenCalledTimes(3);
  });

  it('fails closed without a group-role request when a group has no identifier', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ path: '/developers' }]);

    await expect(service(get).getUserStatus('user-1')).resolves.toBe('unknown');

    expect(get).toHaveBeenCalledTimes(3);
  });

  it('fails closed when a group role-mapping response is malformed', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'group/1', path: '/developers' }])
      .mockResolvedValueOnce({ name: 'admin' });

    await expect(service(get).getUserStatus('user-1')).resolves.toBe('unknown');

    expect(get).toHaveBeenLastCalledWith('/groups/group%2F1/role-mappings/realm/composite');
  });

  it('accepts a base role assigned through a top-level group', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'group-1', path: '/developers' }])
      .mockResolvedValueOnce([{ name: 'admin' }]);

    await expect(service(get).getUserStatus('user-1')).resolves.toBe('active');

    expect(get).toHaveBeenCalledTimes(4);
  });

  it('reports no base role after checking every top-level group', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'group-1', path: '/developers' },
        { id: 'group-2', path: '/operators' },
      ])
      .mockResolvedValueOnce([{ name: 'viewer' }])
      .mockResolvedValueOnce([]);

    await expect(service(get).getUserStatus('user-1')).resolves.toBe('no_base_role');

    expect(get.mock.calls.slice(3)).toEqual([
      ['/groups/group-1/role-mappings/realm/composite'],
      ['/groups/group-2/role-mappings/realm/composite'],
    ]);
  });

  it.each([
    ['nested', '/parent/child'],
    ['path-less', undefined],
  ])('treats an otherwise role-less %s group hierarchy as inconclusive', async (_description, path) => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'group-1', path }])
      .mockResolvedValueOnce([]);

    await expect(service(get).getUserStatus('user-1')).resolves.toBe('unknown');

    expect(get).toHaveBeenCalledTimes(4);
  });

  it('propagates a missing role-mapping resource instead of misclassifying the user as deleted', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ enabled: true })
      .mockRejectedValueOnce(new KeycloakAdminError('not_found', 404, 'role mapping not found'));

    await expect(service(get).getUserStatus('user-1')).rejects.toMatchObject({
      name: 'KeycloakAdminError',
      kind: 'not_found',
      status: 404,
    });

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it.each<[string, unknown, unknown]>([
    [
      'structured Keycloak errors',
      new KeycloakAdminError('unavailable', 503, 'unavailable'),
      { name: 'KeycloakAdminError', kind: 'unavailable', status: 503 },
    ],
    ['the name of ordinary errors', new TypeError('bad response'), { name: 'TypeError' }],
    ['an unknown marker for non-Error rejections', 'connection lost', 'unknown'],
  ])('logs %s and returns unknown', async (_description, error, loggedError) => {
    const get = jest.fn().mockRejectedValue(error);

    await expect(service(get).getUserStatus('user-1')).resolves.toBe('unknown');

    expect(mockWarn).toHaveBeenCalledWith({ error: loggedError }, 'Keycloak principal-status lookup failed');
  });
});

describe('principal status configuration', () => {
  beforeEach(() => {
    clearPrincipalStatusConfig();
  });

  afterEach(() => {
    restorePrincipalStatusConfig();
    jest.restoreAllMocks();
  });

  it('requires an issuer, secret, and derivable or explicit admin URL', () => {
    expect(isConfigured()).toBe(false);

    process.env.KEYCLOAK_ISSUER = 'https://identity.example.test/not-a-realm';
    process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET = 'secret';
    expect(isConfigured()).toBe(false);

    process.env.KEYCLOAK_ADMIN_BASE_URL = ' https://identity.example.test/admin/realms/lifecycle ';
    expect(isConfigured()).toBe(true);
  });

  it('accepts a trimmed secret and an admin URL derived from a trimmed external issuer', () => {
    process.env.KEYCLOAK_ISSUER = ' https://identity.example.test/auth/realms/lifecycle ';
    process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET = ' sync-secret ';

    expect(isConfigured()).toBe(true);
  });

  it('returns unknown without creating an admin request when configuration is incomplete', async () => {
    const get = jest.spyOn(KeycloakAdminClient.prototype, 'get');

    await expect(getUserStatus('user-1')).resolves.toBe('unknown');

    expect(get).not.toHaveBeenCalled();
  });

  it('uses the internal issuer and reuses the client until its configuration signature changes', async () => {
    process.env.KEYCLOAK_ISSUER_INTERNAL = ' http://keycloak.internal/realms/lifecycle ';
    process.env.KEYCLOAK_ISSUER = 'https://identity.example.test/realms/ignored';
    process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_ID = '   ';
    process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET = 'first-secret';
    const clients = new Set<KeycloakAdminClient>();
    const get = jest
      .spyOn(KeycloakAdminClient.prototype, 'get')
      .mockImplementation(async function (this: KeycloakAdminClient) {
        clients.add(this);
        return { enabled: false };
      } as KeycloakAdminClient['get']);

    await expect(getUserStatus('user/one')).resolves.toBe('disabled');
    await expect(getUserStatus('user/two')).resolves.toBe('disabled');
    expect(clients.size).toBe(1);

    process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET = 'second-secret';
    await expect(getUserStatus('user/three')).resolves.toBe('disabled');

    expect(clients.size).toBe(2);
    expect(get.mock.calls).toEqual([['/users/user%2Fone'], ['/users/user%2Ftwo'], ['/users/user%2Fthree']]);
  });

  it('propagates invalid explicit client configuration before making an admin request', async () => {
    process.env.KEYCLOAK_ISSUER = 'https://identity.example.test/realms/lifecycle';
    process.env.KEYCLOAK_ADMIN_BASE_URL = 'not a URL';
    process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_ID = 'custom-sync-client';
    process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET = 'secret';
    const get = jest.spyOn(KeycloakAdminClient.prototype, 'get');

    await expect(getUserStatus('user-1')).rejects.toMatchObject({
      name: 'KeycloakAdminError',
      kind: 'bad_request',
      status: null,
    });
    expect(get).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  restorePrincipalStatusConfig();
});
