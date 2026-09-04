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

var mockMcpManagementClientOptions = jest.fn();
var mockRandomUuid = jest.fn();
var mockRecordAuthAuditEvent = jest.fn();

jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomUUID: () => mockRandomUuid(),
}));

jest.mock('../authAudit', () => ({
  __esModule: true,
  recordAuthAuditEvent: (...args: unknown[]) => mockRecordAuthAuditEvent(...args),
}));

jest.mock('./mcpProvisioning', () => ({
  __esModule: true,
  mcpManagementClientOptions: (...args: unknown[]) => mockMcpManagementClientOptions(...args),
}));

import { AppError } from 'server/lib/appError';
import { KeycloakAdminError } from './adminClient';
import McpOauthClientService, { mcpOauthClientLimits, type McpOauthClientServiceDependencies } from './mcpOauthClients';

type Client = Record<string, any>;

beforeEach(() => {
  mockMcpManagementClientOptions.mockReset();
  mockMcpManagementClientOptions.mockReturnValue(null);
  mockRandomUuid.mockReset();
  mockRandomUuid.mockReturnValue('22222222-2222-4222-8222-222222222222');
  mockRecordAuthAuditEvent.mockReset();
  mockRecordAuthAuditEvent.mockResolvedValue(undefined);
});

function fakeService(initial: Client[] = []) {
  let clients = structuredClone(initial);
  const recordAudit = jest.fn(async () => undefined);
  const createClientId = jest.fn(() => 'lifecycle-mcp-11111111-1111-4111-8111-111111111111');
  const now = jest.fn(() => new Date('2026-08-01T20:00:00.000Z'));
  const client = {
    get: jest.fn(async (path: string) => {
      const url = new URL(path, 'https://keycloak.invalid');
      const requestedId = url.searchParams.get('clientId') ?? '';
      const search = url.searchParams.get('search') === 'true';
      return structuredClone(
        clients.filter((candidate) =>
          search ? candidate.clientId?.includes(requestedId) : candidate.clientId === requestedId
        )
      );
    }),
    post: jest.fn(async (_path: string, body: Client) => {
      clients.push({ id: `internal-${clients.length + 1}`, ...structuredClone(body) });
    }),
    delete: jest.fn(async (path: string) => {
      const id = decodeURIComponent(path.split('/').at(-1) ?? '');
      clients = clients.filter((candidate) => candidate.id !== id);
    }),
  };
  const dependencies: McpOauthClientServiceDependencies = {
    client,
    createClientId,
    now,
    recordAudit,
  };
  return {
    service: new McpOauthClientService(dependencies),
    client,
    createClientId,
    now,
    recordAudit,
    clients: () => clients,
  };
}

function managedClient(overrides: Client = {}): Client {
  return {
    id: 'internal-1',
    clientId: 'lifecycle-mcp-existing',
    name: 'Desktop tool',
    description: 'Lifecycle MCP OAuth client. Managed by Lifecycle.',
    enabled: true,
    protocol: 'openid-connect',
    publicClient: true,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    fullScopeAllowed: false,
    consentRequired: true,
    redirectUris: ['http://127.0.0.1:8123/callback'],
    defaultClientScopes: ['basic'],
    optionalClientScopes: ['mcp', 'offline_access'],
    attributes: {
      'lifecycle.managed': 'true',
      'lifecycle.feature': 'mcp',
      'lifecycle.created-at': '2026-07-31T20:00:00.000Z',
      'lifecycle.created-by': 'admin-user',
      'pkce.code.challenge.method': 'S256',
    },
    ...overrides,
  };
}

it('creates a fixed public PKCE client and reads it back exactly', async () => {
  const fake = fakeService();
  const result = await fake.service.create(
    {
      name: '  Desktop tool  ',
      redirectUris: ['http://127.0.0.1:8123/callback', 'com.example.desktop:/oauth/callback'],
    },
    'admin-user',
    'request-1'
  );

  expect(result).toEqual({
    clientId: 'lifecycle-mcp-11111111-1111-4111-8111-111111111111',
    name: 'Desktop tool',
    redirectUris: ['http://127.0.0.1:8123/callback', 'com.example.desktop:/oauth/callback'],
    createdAt: '2026-08-01T20:00:00.000Z',
  });
  expect(fake.client.post).toHaveBeenCalledWith(
    '/clients',
    expect.objectContaining({
      publicClient: true,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: false,
      consentRequired: true,
      defaultClientScopes: ['basic'],
      optionalClientScopes: ['mcp', 'offline_access'],
      attributes: expect.objectContaining({
        'lifecycle.managed': 'true',
        'lifecycle.feature': 'mcp',
        'pkce.code.challenge.method': 'S256',
      }),
    })
  );
  expect(fake.recordAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'mcp.oauth_client_created',
      principalId: result.clientId,
      actorId: 'admin-user',
      requestId: 'request-1',
    })
  );
});

it('lists only Lifecycle-managed MCP clients', async () => {
  const fake = fakeService([
    managedClient(),
    managedClient({
      id: 'unmanaged',
      clientId: 'lifecycle-mcp-unmanaged',
      attributes: { 'lifecycle.managed': 'false', 'lifecycle.feature': 'mcp' },
    }),
    managedClient({ id: 'other', clientId: 'other-client' }),
    managedClient({ id: 'missing-client-id', clientId: undefined }),
    managedClient({ id: 'missing-attributes', clientId: 'lifecycle-mcp-missing-attributes', attributes: undefined }),
    managedClient({
      id: 'missing-feature',
      clientId: 'lifecycle-mcp-missing-feature',
      attributes: { 'lifecycle.managed': 'true' },
    }),
  ]);

  await expect(fake.service.list()).resolves.toEqual([
    {
      clientId: 'lifecycle-mcp-existing',
      name: 'Desktop tool',
      redirectUris: ['http://127.0.0.1:8123/callback'],
      createdAt: '2026-07-31T20:00:00.000Z',
    },
  ]);
});

it('orders exposed clients by newest creation time and then by name', async () => {
  const fake = fakeService([
    managedClient({
      id: 'same-time-zebra',
      clientId: 'lifecycle-mcp-zebra',
      name: 'Zebra',
      attributes: {
        ...managedClient().attributes,
        'lifecycle.created-at': '2026-08-01T20:00:00.000Z',
      },
    }),
    managedClient({
      id: 'newest',
      clientId: 'lifecycle-mcp-newest',
      name: 'Newest',
      attributes: {
        ...managedClient().attributes,
        'lifecycle.created-at': '2026-08-02T20:00:00.000Z',
      },
    }),
    managedClient({
      id: 'same-time-alpha',
      clientId: 'lifecycle-mcp-alpha',
      name: 'Alpha',
      attributes: {
        ...managedClient().attributes,
        'lifecycle.created-at': '2026-08-01T20:00:00.000Z',
      },
    }),
  ]);

  const result = await fake.service.list();

  expect(result.map((client) => client.name)).toEqual(['Newest', 'Alpha', 'Zebra']);
  expect(fake.client.get).toHaveBeenCalledWith(
    '/clients?clientId=lifecycle-mcp-&search=true&briefRepresentation=false&first=0&max=100'
  );
});

it('exposes a null creation time and removes non-string redirect values from provider data', async () => {
  const attributes = { ...managedClient().attributes };
  delete attributes['lifecycle.created-at'];
  const fake = fakeService([
    managedClient({
      attributes,
      redirectUris: ['https://example.com/callback', 42, null],
    }),
  ]);

  await expect(fake.service.list()).resolves.toEqual([
    {
      clientId: 'lifecycle-mcp-existing',
      name: 'Desktop tool',
      redirectUris: ['https://example.com/callback'],
      createdAt: null,
    },
  ]);
});

it('ignores an incomplete Keycloak representation without a client ID', async () => {
  const fake = fakeService();
  fake.client.get.mockResolvedValueOnce([{ id: 'incomplete-provider-row' }, managedClient()]);

  const result = await fake.service.list();

  expect(result).toHaveLength(1);
  expect(result[0].clientId).toBe('lifecycle-mcp-existing');
});

it('rejects a non-array Keycloak list response as invalid provider state', async () => {
  const fake = fakeService();
  fake.client.get.mockResolvedValueOnce({ clients: [] });

  await expect(fake.service.list()).rejects.toMatchObject<AppError>({
    httpStatus: 503,
    code: 'mcp_keycloak_invalid_state',
  });

  expect(fake.client.post).not.toHaveBeenCalled();
  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it.each([
  ['bad_request', 400, 400, 'invalid_mcp_oauth_client', undefined],
  ['conflict', 409, 409, 'mcp_oauth_client_conflict', undefined],
  ['rate_limited', 429, 503, 'mcp_keycloak_unavailable', true],
  ['unavailable', 503, 503, 'mcp_keycloak_unavailable', true],
  ['unauthorized', 401, 503, 'mcp_keycloak_unavailable', false],
] as const)(
  'maps Keycloak %s list failures to the public service error contract',
  async (kind, providerStatus, httpStatus, code, retryable) => {
    const fake = fakeService();
    fake.client.get.mockRejectedValueOnce(new KeycloakAdminError(kind, providerStatus, `provider ${kind}`));

    const error = await fake.service.list().catch((caught) => caught);

    expect(error).toMatchObject({ httpStatus, code });
    if (kind === 'bad_request') {
      expect(error.details).toEqual({ providerStatus });
    }
    if (retryable !== undefined) {
      expect(error.retryable).toBe(retryable);
    }
  }
);

it('preserves an unexpected list dependency failure', async () => {
  const fake = fakeService();
  const unexpected = new Error('unexpected client adapter failure');
  fake.client.get.mockRejectedValueOnce(unexpected);

  await expect(fake.service.list()).rejects.toBe(unexpected);
});

it.each([
  [{ name: 'Client', redirectUris: ['http://example.com/callback'] }, 'invalid_mcp_oauth_client_redirect'],
  [{ name: 'Client', redirectUris: ['https://example.com/callback#fragment'] }, 'invalid_mcp_oauth_client_redirect'],
  [{ name: 'Client', redirectUris: ['https://example.com/*'] }, 'invalid_mcp_oauth_client_redirect'],
  [{ name: 'Client', redirectUris: ['https://example.com/callback'], scopes: ['admin'] }, 'invalid_mcp_oauth_client'],
])('rejects unsafe or expandable input %#', async (input, code) => {
  const fake = fakeService();
  await expect(fake.service.create(input, 'admin-user', null)).rejects.toMatchObject<AppError>({
    httpStatus: 400,
    code,
  });
  expect(fake.client.post).not.toHaveBeenCalled();
});

it.each([
  [null, 'invalid_mcp_oauth_client'],
  [[], 'invalid_mcp_oauth_client'],
  [{ name: 42, redirectUris: ['https://example.com/callback'] }, 'invalid_mcp_oauth_client_name'],
  [{ name: '', redirectUris: ['https://example.com/callback'] }, 'invalid_mcp_oauth_client_name'],
  [{ name: '   ', redirectUris: ['https://example.com/callback'] }, 'invalid_mcp_oauth_client_name'],
  [{ name: 'x'.repeat(81), redirectUris: ['https://example.com/callback'] }, 'invalid_mcp_oauth_client_name'],
  [{ name: 'Client', redirectUris: [] }, 'invalid_mcp_oauth_client_redirects'],
  [{ name: 'Client', redirectUris: 'https://example.com/callback' }, 'invalid_mcp_oauth_client_redirects'],
  [
    { name: 'Client', redirectUris: Array.from({ length: 11 }, (_, index) => `https://example.com/${index}`) },
    'invalid_mcp_oauth_client_redirects',
  ],
  [
    { name: 'Client', redirectUris: ['https://example.com/callback', 'https://example.com/callback'] },
    'invalid_mcp_oauth_client_redirects',
  ],
])('rejects invalid create structure and cardinality %# before contacting Keycloak', async (input, code) => {
  const fake = fakeService();

  await expect(fake.service.create(input, 'admin-user', null)).rejects.toMatchObject<AppError>({
    httpStatus: 400,
    code,
  });

  expect(fake.client.get).not.toHaveBeenCalled();
  expect(fake.client.post).not.toHaveBeenCalled();
  expect(fake.createClientId).not.toHaveBeenCalled();
  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it.each([
  [123],
  [''],
  ['x'.repeat(2049)],
  [' https://example.com/callback'],
  ['not a URI'],
  ['https://username:password@example.com/callback'],
  ['data:text/plain,callback'],
  ['com.example.desktop:/'],
])('rejects invalid redirect URI value %# before contacting Keycloak', async (redirectUri) => {
  const fake = fakeService();

  await expect(
    fake.service.create({ name: 'Client', redirectUris: [redirectUri] }, 'admin-user', null)
  ).rejects.toMatchObject<AppError>({
    httpStatus: 400,
    code: 'invalid_mcp_oauth_client_redirect',
  });

  expect(fake.client.get).not.toHaveBeenCalled();
  expect(fake.client.post).not.toHaveBeenCalled();
  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it('accepts the documented inclusive name, URI count, and URI length boundaries', async () => {
  const fake = fakeService();
  const prefix = 'https://example.com/callback?state=';
  const longestRedirect = `${prefix}${'x'.repeat(mcpOauthClientLimits.maxRedirectUriLength - prefix.length)}`;
  const redirectUris = [
    longestRedirect,
    ...Array.from(
      { length: mcpOauthClientLimits.maxRedirectUris - 1 },
      (_, index) => `https://example.com/callback/${index}`
    ),
  ];

  const result = await fake.service.create(
    { name: 'n'.repeat(mcpOauthClientLimits.maxNameLength), redirectUris },
    'admin-user',
    null
  );

  expect(result.name).toHaveLength(mcpOauthClientLimits.maxNameLength);
  expect(result.redirectUris).toEqual(redirectUris);
  expect(result.redirectUris[0]).toHaveLength(mcpOauthClientLimits.maxRedirectUriLength);
  expect(fake.client.post).toHaveBeenCalledTimes(1);
});

it('deletes only a marked Lifecycle MCP client and audits the action', async () => {
  const fake = fakeService([managedClient()]);
  await fake.service.delete('lifecycle-mcp-existing', 'admin-user', 'request-2');
  expect(fake.clients()).toEqual([]);
  expect(fake.recordAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'mcp.oauth_client_deleted',
      principalId: 'lifecycle-mcp-existing',
      actorId: 'admin-user',
      requestId: 'request-2',
      route: 'DELETE /api/v2/config/mcp/oauth-clients/{clientId}',
      meta: {
        name: 'Desktop tool',
        redirectUris: ['http://127.0.0.1:8123/callback'],
      },
    })
  );
});

it('refuses to delete an unmarked Keycloak client', async () => {
  const fake = fakeService([
    managedClient({ attributes: { 'lifecycle.managed': 'false', 'lifecycle.feature': 'mcp' } }),
  ]);
  await expect(fake.service.delete('lifecycle-mcp-existing', 'admin-user', null)).rejects.toMatchObject<AppError>({
    httpStatus: 404,
    code: 'mcp_oauth_client_not_found',
  });
  expect(fake.client.delete).not.toHaveBeenCalled();
});

it.each([['unmanaged-client-id'], [`lifecycle-mcp-${'x'.repeat(129)}`]])(
  'rejects out-of-namespace client ID %# without querying Keycloak',
  async (clientId) => {
    const fake = fakeService();

    await expect(fake.service.delete(clientId, 'admin-user', null)).rejects.toMatchObject<AppError>({
      httpStatus: 404,
      code: 'mcp_oauth_client_not_found',
    });

    expect(fake.client.get).not.toHaveBeenCalled();
    expect(fake.client.delete).not.toHaveBeenCalled();
    expect(fake.recordAudit).not.toHaveBeenCalled();
  }
);

it.each([
  ['an absent client', []],
  ['a client without an internal Keycloak ID', [managedClient({ id: undefined })]],
])('returns not found for %s and performs no mutation', async (_case, clients) => {
  const fake = fakeService(clients);

  await expect(fake.service.delete('lifecycle-mcp-existing', 'admin-user', null)).rejects.toMatchObject<AppError>({
    httpStatus: 404,
    code: 'mcp_oauth_client_not_found',
  });

  expect(fake.client.delete).not.toHaveBeenCalled();
  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it('maps a Keycloak delete outage and does not report a deletion audit', async () => {
  const fake = fakeService([managedClient()]);
  fake.client.delete.mockRejectedValueOnce(new KeycloakAdminError('unavailable', 503, 'delete unavailable'));

  await expect(fake.service.delete('lifecycle-mcp-existing', 'admin-user', null)).rejects.toMatchObject<AppError>({
    httpStatus: 503,
    code: 'mcp_keycloak_unavailable',
    retryable: true,
  });

  expect(fake.recordAudit).not.toHaveBeenCalled();
  expect(fake.clients()).toHaveLength(1);
});

it('preserves an unexpected delete dependency failure', async () => {
  const fake = fakeService([managedClient()]);
  const unexpected = new Error('unexpected delete failure');
  fake.client.delete.mockRejectedValueOnce(unexpected);

  await expect(fake.service.delete('lifecycle-mcp-existing', 'admin-user', null)).rejects.toBe(unexpected);

  expect(fake.recordAudit).not.toHaveBeenCalled();
  expect(fake.clients()).toHaveLength(1);
});

it('removes a newly created client when Keycloak readback is weaker than requested', async () => {
  const fake = fakeService();
  fake.client.post.mockImplementationOnce(async (_path: string, body: Client) => {
    fake.clients().push({ id: 'weak-client', ...structuredClone(body), consentRequired: false });
  });
  await expect(
    fake.service.create({ name: 'Desktop tool', redirectUris: ['http://localhost:8123/callback'] }, 'admin-user', null)
  ).rejects.toMatchObject<AppError>({
    httpStatus: 503,
    code: 'mcp_keycloak_invalid_state',
  });
  expect(fake.client.delete).toHaveBeenCalledWith('/clients/weak-client');
  expect(fake.clients()).toEqual([]);
});

it('removes a newly created client when the basic subject scope is missing', async () => {
  const fake = fakeService();
  fake.client.post.mockImplementationOnce(async (_path: string, body: Client) => {
    fake.clients().push({ id: 'missing-subject-client', ...structuredClone(body), defaultClientScopes: [] });
  });
  await expect(
    fake.service.create({ name: 'Desktop tool', redirectUris: ['http://localhost:8123/callback'] }, 'admin-user', null)
  ).rejects.toMatchObject<AppError>({
    httpStatus: 503,
    code: 'mcp_keycloak_invalid_state',
  });
  expect(fake.client.delete).toHaveBeenCalledWith('/clients/missing-subject-client');
  expect(fake.clients()).toEqual([]);
});

it.each([
  [
    'PKCE enforcement is absent',
    (body: Client) => {
      const attributes = { ...body.attributes };
      delete attributes['pkce.code.challenge.method'];
      return { ...body, attributes };
    },
  ],
  ['the default subject scopes are absent', (body: Client) => ({ ...body, defaultClientScopes: undefined })],
  ['the MCP optional scopes are absent', (body: Client) => ({ ...body, optionalClientScopes: undefined })],
])('rolls back a created client when %s on readback', async (_case, weaken) => {
  const fake = fakeService();
  fake.client.post.mockImplementationOnce(async (_path: string, body: Client) => {
    fake.clients().push({ id: 'weakened-client', ...weaken(structuredClone(body)) });
  });

  await expect(
    fake.service.create({ name: 'Desktop tool', redirectUris: ['https://example.com/callback'] }, 'admin-user', null)
  ).rejects.toMatchObject<AppError>({
    httpStatus: 503,
    code: 'mcp_keycloak_invalid_state',
  });

  expect(fake.client.delete).toHaveBeenCalledWith('/clients/weakened-client');
  expect(fake.clients()).toEqual([]);
  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it('enforces the managed-client capacity before allocating or posting a new client', async () => {
  const fake = fakeService(
    Array.from({ length: mcpOauthClientLimits.maxClients }, (_, index) =>
      managedClient({ id: `internal-${index}`, clientId: `lifecycle-mcp-${index}` })
    )
  );

  await expect(
    fake.service.create({ name: 'One too many', redirectUris: ['https://example.com/callback'] }, 'admin-user', null)
  ).rejects.toMatchObject<AppError>({
    httpStatus: 409,
    code: 'mcp_oauth_client_limit',
  });

  expect(fake.createClientId).not.toHaveBeenCalled();
  expect(fake.now).not.toHaveBeenCalled();
  expect(fake.client.post).not.toHaveBeenCalled();
  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it('rejects an unobservable create when Keycloak does not return the newly posted client', async () => {
  const fake = fakeService();
  fake.client.post.mockResolvedValueOnce(undefined);

  await expect(
    fake.service.create({ name: 'Desktop tool', redirectUris: ['https://example.com/callback'] }, 'admin-user', null)
  ).rejects.toMatchObject<AppError>({
    httpStatus: 503,
    code: 'mcp_keycloak_invalid_state',
  });

  expect(fake.client.delete).not.toHaveBeenCalled();
  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it('preserves the verification failure when best-effort cleanup also fails', async () => {
  const fake = fakeService();
  const cleanupError = new KeycloakAdminError('unavailable', 503, 'cleanup unavailable');
  fake.client.post.mockImplementationOnce(async (_path: string, body: Client) => {
    fake.clients().push({ id: 'weak-client', ...structuredClone(body), standardFlowEnabled: false });
  });
  fake.client.delete.mockRejectedValueOnce(cleanupError);

  await expect(
    fake.service.create({ name: 'Desktop tool', redirectUris: ['https://example.com/callback'] }, 'admin-user', null)
  ).rejects.toMatchObject<AppError>({
    httpStatus: 503,
    code: 'mcp_keycloak_invalid_state',
  });

  expect(fake.client.delete).toHaveBeenCalledWith('/clients/weak-client');
  expect(fake.clients()).toHaveLength(1);
  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it('rejects duplicate exact Keycloak client IDs without deleting an ambiguous client', async () => {
  const fake = fakeService();
  fake.client.post.mockImplementationOnce(async (_path: string, body: Client) => {
    fake
      .clients()
      .push({ id: 'duplicate-1', ...structuredClone(body) }, { id: 'duplicate-2', ...structuredClone(body) });
  });

  await expect(
    fake.service.create({ name: 'Desktop tool', redirectUris: ['https://example.com/callback'] }, 'admin-user', null)
  ).rejects.toMatchObject<AppError>({
    httpStatus: 409,
    code: 'mcp_oauth_client_conflict',
  });

  expect(fake.client.delete).not.toHaveBeenCalled();
  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it('rejects a non-array exact lookup response after posting', async () => {
  const fake = fakeService();
  fake.client.get.mockResolvedValueOnce([]).mockResolvedValueOnce({ clientId: 'not-an-array' });

  await expect(
    fake.service.create({ name: 'Desktop tool', redirectUris: ['https://example.com/callback'] }, 'admin-user', null)
  ).rejects.toMatchObject<AppError>({
    httpStatus: 503,
    code: 'mcp_keycloak_invalid_state',
  });

  expect(fake.client.post).toHaveBeenCalledTimes(1);
  expect(fake.client.delete).not.toHaveBeenCalled();
  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it('maps a Keycloak create conflict and does not audit a client that was not created', async () => {
  const fake = fakeService();
  fake.client.post.mockRejectedValueOnce(new KeycloakAdminError('conflict', 409, 'duplicate client'));

  await expect(
    fake.service.create({ name: 'Desktop tool', redirectUris: ['https://example.com/callback'] }, 'admin-user', null)
  ).rejects.toMatchObject<AppError>({
    httpStatus: 409,
    code: 'mcp_oauth_client_conflict',
  });

  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it('preserves an unexpected create dependency failure', async () => {
  const fake = fakeService();
  const unexpected = new Error('unexpected post failure');
  fake.client.post.mockRejectedValueOnce(unexpected);

  await expect(
    fake.service.create({ name: 'Desktop tool', redirectUris: ['https://example.com/callback'] }, 'admin-user', null)
  ).rejects.toBe(unexpected);

  expect(fake.recordAudit).not.toHaveBeenCalled();
});

it('surfaces audit failure after Keycloak has durably created the client', async () => {
  const fake = fakeService();
  const auditError = new Error('audit sink unavailable');
  fake.recordAudit.mockRejectedValueOnce(auditError);

  await expect(
    fake.service.create({ name: 'Desktop tool', redirectUris: ['https://example.com/callback'] }, 'admin-user', null)
  ).rejects.toBe(auditError);

  expect(fake.clients()).toHaveLength(1);
  expect(fake.client.delete).not.toHaveBeenCalled();
});

it('publishes the validation and capacity limits used by the service contract', () => {
  expect(mcpOauthClientLimits).toEqual({
    maxClients: 100,
    maxNameLength: 80,
    maxRedirectUris: 10,
    maxRedirectUriLength: 2048,
  });
});

it('fails closed when default Keycloak management configuration is absent', () => {
  expect(() => new McpOauthClientService()).toThrow(
    expect.objectContaining({
      httpStatus: 503,
      code: 'mcp_keycloak_not_configured',
      message: 'Lifecycle MCP sign-in setup is incomplete.',
    })
  );
  expect(mockMcpManagementClientOptions).toHaveBeenCalledWith(process.env);
});

it('builds and reuses the default configured service with deterministic ID, clock, network, and audit boundaries', async () => {
  let createdClient: Client | null = null;
  const fetcher = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/protocol/openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'management-token', expires_in: 300 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (init?.method === 'POST' && url.endsWith('/clients')) {
      createdClient = { id: 'internal-created', ...JSON.parse(String(init.body)) };
      return new Response(null, { status: 201 });
    }
    const search = new URL(url).searchParams.get('search');
    return new Response(JSON.stringify(search === 'false' && createdClient ? [createdClient] : []), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as jest.MockedFunction<typeof fetch>;
  mockMcpManagementClientOptions.mockReturnValue({
    issuer: 'https://auth.example.com/realms/lifecycle',
    adminBaseUrl: 'https://auth.example.com/admin/realms/lifecycle',
    clientId: 'management-client',
    clientSecret: 'management-secret',
    fetch: fetcher,
  });
  jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:34:56.000Z'));

  try {
    const service = McpOauthClientService.getInstance();
    expect(McpOauthClientService.getInstance()).toBe(service);

    await expect(
      service.create(
        { name: 'Default client', redirectUris: ['https://example.com/callback'] },
        'admin-user',
        'request-3'
      )
    ).resolves.toEqual({
      clientId: 'lifecycle-mcp-22222222-2222-4222-8222-222222222222',
      name: 'Default client',
      redirectUris: ['https://example.com/callback'],
      createdAt: '2026-08-03T12:34:56.000Z',
    });
    expect(fetcher).toHaveBeenCalled();
    expect(mockRecordAuthAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mcp.oauth_client_created' })
    );
  } finally {
    jest.useRealTimers();
  }
});
