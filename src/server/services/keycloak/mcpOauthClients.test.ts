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

import { AppError } from 'server/lib/appError';
import McpOauthClientService, { type McpOauthClientServiceDependencies } from './mcpOauthClients';

type Client = Record<string, any>;

function fakeService(initial: Client[] = []) {
  let clients = structuredClone(initial);
  const recordAudit = jest.fn(async () => undefined);
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
    createClientId: () => 'lifecycle-mcp-11111111-1111-4111-8111-111111111111',
    now: () => new Date('2026-08-01T20:00:00.000Z'),
    recordAudit,
  };
  return { service: new McpOauthClientService(dependencies), client, recordAudit, clients: () => clients };
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

it('deletes only a marked Lifecycle MCP client and audits the action', async () => {
  const fake = fakeService([managedClient()]);
  await fake.service.delete('lifecycle-mcp-existing', 'admin-user', 'request-2');
  expect(fake.clients()).toEqual([]);
  expect(fake.recordAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'mcp.oauth_client_deleted',
      principalId: 'lifecycle-mcp-existing',
      actorId: 'admin-user',
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
