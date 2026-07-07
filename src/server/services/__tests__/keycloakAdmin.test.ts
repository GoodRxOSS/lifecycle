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

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

export {};

const ENV_KEYS = [
  'KEYCLOAK_ISSUER',
  'KEYCLOAK_ISSUER_INTERNAL',
  'KEYCLOAK_ADMIN_BASE_URL',
  'KEYCLOAK_PRINCIPAL_SYNC_CLIENT_ID',
  'KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET',
] as const;

const originalEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
let mockFetch: jest.Mock;

function tokenResponse(expiresIn = 300) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'admin-token', expires_in: expiresIn }),
  };
}

function userResponse(body: Record<string, unknown>, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function rolesResponse(names: string[], status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => names.map((name) => ({ id: `role-${name}`, name })),
  };
}

function groupsResponse(groups: { id: string; path: string }[], status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => groups.map((group) => ({ ...group, name: group.path.split('/').pop() })),
  };
}

async function importKeycloakAdmin() {
  jest.resetModules();
  return import('server/services/keycloakAdmin');
}

beforeAll(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.KEYCLOAK_ISSUER = 'https://kc.example.com/realms/lifecycle';
  process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET = 'sweep-secret';
  mockFetch = jest.fn();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  globalThis.fetch = originalFetch;
});

describe('isConfigured', () => {
  it('is false when the client secret is missing', async () => {
    delete process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_SECRET;
    const { isConfigured } = await importKeycloakAdmin();
    expect(isConfigured()).toBe(false);
  });

  it('is false when the issuer is missing or unparseable', async () => {
    delete process.env.KEYCLOAK_ISSUER;
    const { isConfigured } = await importKeycloakAdmin();
    expect(isConfigured()).toBe(false);

    process.env.KEYCLOAK_ISSUER = 'https://kc.example.com/nothing-here';
    expect(isConfigured()).toBe(false);
  });

  it('is true with a secret and a parseable issuer', async () => {
    const { isConfigured } = await importKeycloakAdmin();
    expect(isConfigured()).toBe(true);
  });
});

describe('keycloakAdminBaseUrl', () => {
  it('derives the admin URL from the issuer', async () => {
    const { keycloakAdminBaseUrl } = await importKeycloakAdmin();
    expect(keycloakAdminBaseUrl()).toBe('https://kc.example.com/admin/realms/lifecycle');
  });

  it('preserves a path prefix before /realms/', async () => {
    process.env.KEYCLOAK_ISSUER = 'https://kc.example.com/auth/realms/lifecycle/';
    const { keycloakAdminBaseUrl } = await importKeycloakAdmin();
    expect(keycloakAdminBaseUrl()).toBe('https://kc.example.com/auth/admin/realms/lifecycle');
  });

  it('prefers KEYCLOAK_ADMIN_BASE_URL when set', async () => {
    process.env.KEYCLOAK_ADMIN_BASE_URL = 'http://keycloak.internal:8080/admin/realms/lifecycle/';
    const { keycloakAdminBaseUrl } = await importKeycloakAdmin();
    expect(keycloakAdminBaseUrl()).toBe('http://keycloak.internal:8080/admin/realms/lifecycle');
  });
});

describe('getUserStatus', () => {
  it('fetches a client-credentials token and reports an enabled user with the user role as active', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(userResponse({ id: 'sub-1', enabled: true }))
      .mockResolvedValueOnce(rolesResponse(['user']));
    const { getUserStatus } = await importKeycloakAdmin();

    await expect(getUserStatus('sub-1')).resolves.toBe('active');

    const [tokenUrl, tokenInit] = mockFetch.mock.calls[0];
    expect(tokenUrl).toBe('https://kc.example.com/realms/lifecycle/protocol/openid-connect/token');
    expect(String(tokenInit.body)).toContain('grant_type=client_credentials');
    expect(String(tokenInit.body)).toContain('client_id=lifecycle-api-principal-sync');
    expect(String(tokenInit.body)).toContain('client_secret=sweep-secret');

    const [userUrl, userInit] = mockFetch.mock.calls[1];
    expect(userUrl).toBe('https://kc.example.com/admin/realms/lifecycle/users/sub-1');
    expect(userInit.headers.Authorization).toBe('Bearer admin-token');

    const [rolesUrl, rolesInit] = mockFetch.mock.calls[2];
    expect(rolesUrl).toBe('https://kc.example.com/admin/realms/lifecycle/users/sub-1/role-mappings/realm/composite');
    expect(rolesInit.headers.Authorization).toBe('Bearer admin-token');
  });

  it('caches the token across lookups until expiry', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse(300))
      .mockResolvedValueOnce(userResponse({ enabled: true }))
      .mockResolvedValueOnce(rolesResponse(['user']))
      .mockResolvedValueOnce(userResponse({ enabled: true }))
      .mockResolvedValueOnce(rolesResponse(['user']));
    const { getUserStatus } = await importKeycloakAdmin();

    await getUserStatus('sub-1');
    await getUserStatus('sub-2');

    const tokenCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('openid-connect/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('maps 404 to deleted', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(userResponse({}, 404));
    const { getUserStatus } = await importKeycloakAdmin();
    await expect(getUserStatus('gone')).resolves.toBe('deleted');
  });

  it('maps enabled:false to disabled', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(userResponse({ enabled: false }));
    const { getUserStatus } = await importKeycloakAdmin();
    await expect(getUserStatus('sub-1')).resolves.toBe('disabled');
  });

  it('maps a network error to unknown without throwing', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const { getUserStatus } = await importKeycloakAdmin();
    await expect(getUserStatus('sub-1')).resolves.toBe('unknown');
  });

  it('maps a 5xx lookup to unknown', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(userResponse({}, 500));
    const { getUserStatus } = await importKeycloakAdmin();
    await expect(getUserStatus('sub-1')).resolves.toBe('unknown');
  });

  it('returns unknown when the token endpoint rejects the client', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const { getUserStatus } = await importKeycloakAdmin();
    await expect(getUserStatus('sub-1')).resolves.toBe('unknown');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('honors KEYCLOAK_PRINCIPAL_SYNC_CLIENT_ID overrides', async () => {
    process.env.KEYCLOAK_PRINCIPAL_SYNC_CLIENT_ID = 'custom-sync-client';
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(userResponse({ enabled: true }))
      .mockResolvedValueOnce(rolesResponse(['user']));
    const { getUserStatus } = await importKeycloakAdmin();

    await getUserStatus('sub-1');

    expect(String(mockFetch.mock.calls[0][1].body)).toContain('client_id=custom-sync-client');
  });
});

describe('getUserStatus base-role check', () => {
  beforeEach(() => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(userResponse({ enabled: true }));
  });

  it('treats a user holding only the admin role as active', async () => {
    mockFetch.mockResolvedValueOnce(rolesResponse(['admin']));
    const { getUserStatus } = await importKeycloakAdmin();
    await expect(getUserStatus('sub-1')).resolves.toBe('active');
  });

  it('flags an enabled owner with no base role and no groups as no_base_role', async () => {
    mockFetch
      .mockResolvedValueOnce(rolesResponse(['offline_access', 'uma_authorization']))
      .mockResolvedValueOnce(groupsResponse([]));
    const { getUserStatus } = await importKeycloakAdmin();

    await expect(getUserStatus('sub-1')).resolves.toBe('no_base_role');

    const [groupsUrl] = mockFetch.mock.calls[3];
    expect(groupsUrl).toBe(
      'https://kc.example.com/admin/realms/lifecycle/users/sub-1/groups?briefRepresentation=true&max=100'
    );
  });

  it('finds a base role granted through a group', async () => {
    mockFetch
      .mockResolvedValueOnce(rolesResponse([]))
      .mockResolvedValueOnce(groupsResponse([{ id: 'g-1', path: '/engineers' }]))
      .mockResolvedValueOnce(rolesResponse(['user']));
    const { getUserStatus } = await importKeycloakAdmin();

    await expect(getUserStatus('sub-1')).resolves.toBe('active');

    const [groupRolesUrl] = mockFetch.mock.calls[4];
    expect(groupRolesUrl).toBe(
      'https://kc.example.com/admin/realms/lifecycle/groups/g-1/role-mappings/realm/composite'
    );
  });

  it('flags no_base_role when top-level groups grant no base role', async () => {
    mockFetch
      .mockResolvedValueOnce(rolesResponse([]))
      .mockResolvedValueOnce(groupsResponse([{ id: 'g-1', path: '/guests' }]))
      .mockResolvedValueOnce(rolesResponse(['viewer']));
    const { getUserStatus } = await importKeycloakAdmin();
    await expect(getUserStatus('sub-1')).resolves.toBe('no_base_role');
  });

  it('returns unknown instead of no_base_role when a nested group could inherit the role', async () => {
    mockFetch
      .mockResolvedValueOnce(rolesResponse([]))
      .mockResolvedValueOnce(groupsResponse([{ id: 'g-1', path: '/eng/platform' }]))
      .mockResolvedValueOnce(rolesResponse([]));
    const { getUserStatus } = await importKeycloakAdmin();
    await expect(getUserStatus('sub-1')).resolves.toBe('unknown');
  });

  it('returns unknown when the role lookup fails', async () => {
    mockFetch.mockResolvedValueOnce(rolesResponse([], 500));
    const { getUserStatus } = await importKeycloakAdmin();
    await expect(getUserStatus('sub-1')).resolves.toBe('unknown');
  });

  it('returns unknown when the group lookup fails', async () => {
    mockFetch.mockResolvedValueOnce(rolesResponse([])).mockResolvedValueOnce(groupsResponse([], 500));
    const { getUserStatus } = await importKeycloakAdmin();
    await expect(getUserStatus('sub-1')).resolves.toBe('unknown');
  });
});
