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

var mockKeycloakAdminConstructor = jest.fn();

jest.mock('./adminClient', () => {
  const actual = jest.requireActual('./adminClient');
  return {
    ...actual,
    KeycloakAdminClient: class {
      constructor(...args: unknown[]) {
        return mockKeycloakAdminConstructor(...args);
      }
    },
  };
});

import { KeycloakAdminClient, KeycloakAdminError } from './adminClient';
import {
  LifecycleMcpProvisioner,
  mcpManagementClientOptions,
  McpProvisioningError,
  provisionLifecycleMcp,
} from './mcpProvisioning';

type JsonObject = Record<string, any>;

beforeEach(() => {
  mockKeycloakAdminConstructor.mockReset();
});

class FakeKeycloakAdmin {
  readonly calls: Array<{ method: string; path: string }> = [];
  readonly realm = { id: 'realm-1' };
  readonly roles = {
    user: { id: 'role-user', name: 'user' },
    admin: { id: 'role-admin', name: 'admin' },
  };
  scopes: JsonObject[] = [];
  mappers: JsonObject[] = [];
  defaultScopes: JsonObject[] = [];
  optionalScopes: JsonObject[] = [];
  scopeMappings: JsonObject[] = [];
  profiles: JsonObject[] = [{ name: 'unrelated-profile', description: 'preserve me', executors: [] }];
  policies: JsonObject[] = [{ name: 'unrelated-policy', description: 'preserve me', enabled: true }];
  components: JsonObject[] = [
    {
      id: 'stock-consent',
      name: 'Consent Required',
      parentId: 'realm-1',
      providerId: 'consent-required',
      providerType: 'org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy',
      subType: 'anonymous',
      config: {},
    },
    {
      id: 'stock-scope',
      name: 'Full Scope Disabled',
      parentId: 'realm-1',
      providerId: 'scope',
      providerType: 'org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy',
      subType: 'anonymous',
      config: {},
    },
    {
      id: 'stock-allowed',
      name: 'Allowed Client Scopes',
      parentId: 'realm-1',
      providerId: 'allowed-client-templates',
      providerType: 'org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy',
      subType: 'anonymous',
      config: { 'allow-default-scopes': ['true'] },
    },
    {
      id: 'stock-trusted',
      name: 'Trusted Hosts',
      parentId: 'realm-1',
      providerId: 'trusted-hosts',
      providerType: 'org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy',
      subType: 'anonymous',
      config: {
        'host-sending-registration-request-must-match': ['true'],
        'client-uris-must-match': ['true'],
      },
    },
  ];

  clearCalls(): void {
    this.calls.length = 0;
  }

  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: 'GET', path });
    if (path === '/client-scopes') return structuredClone(this.scopes) as T;
    if (path.endsWith('/protocol-mappers/models')) return structuredClone(this.mappers) as T;
    if (path === '/default-default-client-scopes') return structuredClone(this.defaultScopes) as T;
    if (path === '/default-optional-client-scopes') return structuredClone(this.optionalScopes) as T;
    if (path === '/roles/user') return structuredClone(this.roles.user) as T;
    if (path === '/roles/admin') return structuredClone(this.roles.admin) as T;
    if (path.endsWith('/scope-mappings/realm')) return structuredClone(this.scopeMappings) as T;
    if (path === '/client-policies/profiles') return { profiles: structuredClone(this.profiles) } as T;
    if (path === '/client-policies/policies') return { policies: structuredClone(this.policies) } as T;
    if (path === '/') return structuredClone(this.realm) as T;
    if (path.startsWith('/components?')) return structuredClone(this.components) as T;
    throw new Error(`Unexpected GET ${path}`);
  }

  async post(path: string, body: JsonObject): Promise<void> {
    this.calls.push({ method: 'POST', path });
    if (path === '/client-scopes') {
      this.scopes.push({ id: 'scope-1', ...structuredClone(body) });
      return;
    }
    if (path.endsWith('/protocol-mappers/models')) {
      this.mappers.push({ id: `mapper-${this.mappers.length + 1}`, ...structuredClone(body) });
      return;
    }
    if (path.endsWith('/scope-mappings/realm')) {
      this.scopeMappings.push(...structuredClone(body as JsonObject[]));
      return;
    }
    if (path === '/components') {
      this.components.push({ id: `component-${this.components.length + 1}`, ...structuredClone(body) });
      return;
    }
    throw new Error(`Unexpected POST ${path}`);
  }

  async put(path: string, body: JsonObject): Promise<void> {
    this.calls.push({ method: 'PUT', path });
    if (path.startsWith('/client-scopes/') && !path.includes('/protocol-mappers/')) {
      this.scopes = this.scopes.map((scope) => (scope.id === body.id ? structuredClone(body) : scope));
      return;
    }
    if (path.includes('/protocol-mappers/models/')) {
      this.mappers = this.mappers.map((mapper) => (path.endsWith(`/${mapper.id}`) ? structuredClone(body) : mapper));
      return;
    }
    if (path.startsWith('/default-optional-client-scopes/')) {
      const id = decodeURIComponent(path.split('/').pop()!);
      const scope = this.scopes.find((candidate) => candidate.id === id);
      if (scope) this.optionalScopes.push(scope);
      return;
    }
    if (path === '/client-policies/profiles') {
      this.profiles = structuredClone(body.profiles);
      return;
    }
    if (path === '/client-policies/policies') {
      this.policies = structuredClone(body.policies);
      return;
    }
    if (path.startsWith('/components/')) {
      const id = decodeURIComponent(path.split('/').pop()!);
      this.components = this.components.map((component) => (component.id === id ? structuredClone(body) : component));
      return;
    }
    throw new Error(`Unexpected PUT ${path}`);
  }

  async delete(path: string, body?: JsonObject[]): Promise<void> {
    this.calls.push({ method: 'DELETE', path });
    if (path.includes('/protocol-mappers/models/')) {
      const id = decodeURIComponent(path.split('/').pop()!);
      this.mappers = this.mappers.filter((mapper) => mapper.id !== id);
      return;
    }
    if (path.endsWith('/scope-mappings/realm')) {
      const removed = new Set((body ?? []).map((role) => role.id));
      this.scopeMappings = this.scopeMappings.filter((role) => !removed.has(role.id));
      return;
    }
    if (path.startsWith('/default-default-client-scopes/')) {
      const id = decodeURIComponent(path.split('/').pop()!);
      this.defaultScopes = this.defaultScopes.filter((scope) => scope.id !== id);
      return;
    }
    if (path.startsWith('/components/')) {
      const id = decodeURIComponent(path.split('/').pop()!);
      this.components = this.components.filter((component) => component.id !== id);
      return;
    }
    throw new Error(`Unexpected DELETE ${path}`);
  }
}

function provisioner(fake: FakeKeycloakAdmin): LifecycleMcpProvisioner {
  return new LifecycleMcpProvisioner(fake as unknown as KeycloakAdminClient);
}

const endpoint = 'https://lifecycle.example.test/mcp';

describe('mcpManagementClientOptions', () => {
  it('derives the admin URL and default management client from the public issuer', () => {
    expect(
      mcpManagementClientOptions({
        KEYCLOAK_ISSUER: '  https://auth.example.com/realms/lifecycle  ',
        KEYCLOAK_MANAGEMENT_CLIENT_SECRET: '  management-secret  ',
      })
    ).toEqual({
      issuer: 'https://auth.example.com/realms/lifecycle',
      adminBaseUrl: 'https://auth.example.com/admin/realms/lifecycle',
      clientId: 'lifecycle-api-keycloak-management',
      clientSecret: 'management-secret',
      allowInternalHttp: false,
    });
  });

  it('prefers explicit internal management settings and permits their HTTP transport', () => {
    expect(
      mcpManagementClientOptions({
        KEYCLOAK_ISSUER_INTERNAL: '  http://keycloak.lifecycle.svc/realms/lifecycle  ',
        KEYCLOAK_ISSUER: 'https://public.example.com/realms/lifecycle',
        KEYCLOAK_ADMIN_BASE_URL: '  http://keycloak.lifecycle.svc/admin/realms/lifecycle  ',
        KEYCLOAK_MANAGEMENT_CLIENT_ID: '  custom-management  ',
        KEYCLOAK_MANAGEMENT_CLIENT_SECRET: '  management-secret  ',
      })
    ).toEqual({
      issuer: 'http://keycloak.lifecycle.svc/realms/lifecycle',
      adminBaseUrl: 'http://keycloak.lifecycle.svc/admin/realms/lifecycle',
      clientId: 'custom-management',
      clientSecret: 'management-secret',
      allowInternalHttp: true,
    });
  });

  it.each([
    ['issuer', { KEYCLOAK_MANAGEMENT_CLIENT_SECRET: 'secret' }],
    ['secret', { KEYCLOAK_ISSUER: 'https://auth.example.com/realms/lifecycle' }],
    [
      'derivable realm admin URL',
      {
        KEYCLOAK_ISSUER: 'https://auth.example.com/not-a-realm-issuer',
        KEYCLOAK_MANAGEMENT_CLIENT_SECRET: 'secret',
      },
    ],
  ])('returns null when the %s is unavailable', (_case, env) => {
    expect(mcpManagementClientOptions(env)).toBeNull();
  });
});

it('exposes a stable provisioning error code and optional cause', () => {
  const cause = new Error('provider detail');
  const withCause = new McpProvisioningError('mcp_keycloak_conflict', 'conflicting setup', { cause });
  const withoutCause = new McpProvisioningError('mcp_keycloak_not_configured', 'missing setup');

  expect(withCause).toMatchObject({
    name: 'McpProvisioningError',
    code: 'mcp_keycloak_conflict',
    message: 'conflicting setup',
    cause,
  });
  expect(withoutCause).not.toHaveProperty('cause');
});

describe('provisionLifecycleMcp', () => {
  it('fails without constructing an admin client when management configuration is incomplete', async () => {
    await expect(provisionLifecycleMcp(endpoint, {})).rejects.toMatchObject({
      name: 'McpProvisioningError',
      code: 'mcp_keycloak_not_configured',
    });
    expect(mockKeycloakAdminConstructor).not.toHaveBeenCalled();
  });

  it('constructs the configured admin client and reconciles the complete public contract', async () => {
    const fake = new FakeKeycloakAdmin();
    mockKeycloakAdminConstructor.mockReturnValue(fake);
    const env = {
      KEYCLOAK_ISSUER: 'https://auth.example.com/realms/lifecycle',
      KEYCLOAK_ADMIN_BASE_URL: 'https://auth.example.com/admin/realms/lifecycle',
      KEYCLOAK_MANAGEMENT_CLIENT_ID: 'management-client',
      KEYCLOAK_MANAGEMENT_CLIENT_SECRET: 'management-secret',
    };

    await provisionLifecycleMcp(endpoint, env);

    expect(mockKeycloakAdminConstructor).toHaveBeenCalledWith({
      issuer: env.KEYCLOAK_ISSUER,
      adminBaseUrl: env.KEYCLOAK_ADMIN_BASE_URL,
      clientId: env.KEYCLOAK_MANAGEMENT_CLIENT_ID,
      clientSecret: env.KEYCLOAK_MANAGEMENT_CLIENT_SECRET,
      allowInternalHttp: false,
    });
    expect(fake.scopes).toContainEqual(expect.objectContaining({ name: 'mcp' }));
    expect(fake.calls.some(({ method }) => method !== 'GET')).toBe(true);
  });
});

it('converges once and performs no writes on an exact second reconciliation', async () => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  expect(fake.calls.some(({ method }) => method !== 'GET')).toBe(true);

  fake.clearCalls();
  await provisioner(fake).reconcile(endpoint);

  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
  expect(fake.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'unrelated-profile' })]));
  expect(fake.policies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'unrelated-policy' })]));
  expect(fake.policies.find(({ name }) => name === 'lifecycle-mcp-anonymous-dcr')).toMatchObject({
    conditions: expect.arrayContaining([
      {
        condition: 'client-updater-context',
        configuration: {
          'update-client-source': ['ByAnonymous', 'ByRegistrationAccessToken'],
        },
      },
      {
        condition: 'client-access-type',
        configuration: { type: ['public'] },
      },
    ]),
  });
  expect(fake.policies.find(({ name }) => name === 'lifecycle-mcp-anonymous-confidential-dcr')).toMatchObject({
    conditions: expect.arrayContaining([
      {
        condition: 'client-access-type',
        configuration: { type: ['confidential'] },
      },
    ]),
  });
});

it.each([
  ['unauthorized', 401, 'mcp_keycloak_unauthorized'],
  ['forbidden', 403, 'mcp_keycloak_forbidden'],
  ['conflict', 409, 'mcp_keycloak_conflict'],
  ['bad_request', 400, 'mcp_keycloak_conflict'],
  ['rate_limited', 429, 'mcp_keycloak_unavailable'],
  ['unavailable', 503, 'mcp_keycloak_unavailable'],
] as const)('maps Keycloak %s (%s) failures without attempting writes', async (kind, status, code) => {
  const fake = new FakeKeycloakAdmin();
  const providerError = new KeycloakAdminError(kind, status, `Keycloak ${kind}`);
  jest.spyOn(fake, 'get').mockRejectedValueOnce(providerError);

  const error = await provisioner(fake)
    .reconcile(endpoint)
    .catch((caught) => caught);

  expect(error).toMatchObject({ name: 'McpProvisioningError', code, cause: providerError });
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it('maps an unexpected admin dependency failure to invalid state and preserves its cause', async () => {
  const fake = new FakeKeycloakAdmin();
  const unexpected = new Error('unexpected adapter failure');
  jest.spyOn(fake, 'get').mockRejectedValueOnce(unexpected);

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toMatchObject({
    name: 'McpProvisioningError',
    code: 'mcp_keycloak_invalid_state',
    cause: unexpected,
  });
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it('separates ported public loopback redirects from HTTPS-only confidential redirects', async () => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);

  const publicRedirects = fake.profiles
    .find(({ name }) => name === 'lifecycle-mcp-dcr')!
    .executors.find(({ executor }: { executor?: string }) => executor === 'secure-redirect-uris-enforcer');
  expect(publicRedirects.configuration).toEqual({
    'allow-ipv4-loopback-address': true,
    'allow-ipv6-loopback-address': true,
    'allow-private-use-uri-scheme': false,
    'allow-http-scheme': true,
    'allow-wildcard-context-path': false,
    'allow-permitted-domains': ['(?!)'],
    'oauth-2-1-compliant': false,
    'allow-open-redirect': false,
  });

  const confidentialRedirects = fake.profiles
    .find(({ name }) => name === 'lifecycle-mcp-confidential-dcr')!
    .executors.find(({ executor }: { executor?: string }) => executor === 'secure-redirect-uris-enforcer');
  expect(confidentialRedirects.configuration).toEqual({
    'allow-ipv4-loopback-address': false,
    'allow-ipv6-loopback-address': false,
    'allow-private-use-uri-scheme': false,
    'allow-http-scheme': false,
    'allow-wildcard-context-path': false,
    'allow-permitted-domains': [],
    'oauth-2-1-compliant': true,
    'allow-open-redirect': false,
  });
});

it('repairs the hosted-client profile to support confidential client-secret registration', async () => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  const profile = fake.profiles.find(({ name }) => name === 'lifecycle-mcp-confidential-dcr')!;
  const authenticator = profile.executors.find(
    ({ executor }: { executor?: string }) => executor === 'secure-client-authenticator'
  );
  authenticator.configuration['allowed-client-authenticators'] = [];
  fake.clearCalls();

  await provisioner(fake).reconcile(endpoint);

  expect(
    fake.profiles
      .find(({ name }) => name === 'lifecycle-mcp-confidential-dcr')!
      .executors.find(({ executor }: { executor?: string }) => executor === 'secure-client-authenticator')
  ).toMatchObject({
    configuration: {
      'allowed-client-authenticators': ['client-secret'],
    },
  });
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([
    { method: 'PUT', path: '/client-policies/profiles' },
  ]);
});

it('repairs the managed scope from default to optional without rewriting exact owned objects', async () => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  const scope = fake.scopes.find(({ name }) => name === 'mcp')!;
  fake.defaultScopes = [scope];
  fake.optionalScopes = [];
  fake.clearCalls();

  await provisioner(fake).reconcile(endpoint);

  expect(fake.defaultScopes).toEqual([]);
  expect(fake.optionalScopes.map(({ id }) => id)).toEqual([scope.id]);
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([
    { method: 'DELETE', path: `/default-default-client-scopes/${scope.id}` },
    { method: 'PUT', path: `/default-optional-client-scopes/${scope.id}` },
  ]);
});

it('refuses to adopt a reserved scope owned by another configuration', async () => {
  const fake = new FakeKeycloakAdmin();
  fake.scopes = [
    {
      id: 'foreign-scope',
      name: 'mcp',
      description: 'Managed outside Lifecycle',
      protocol: 'openid-connect',
      attributes: {},
    },
  ];

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toMatchObject({
    code: 'mcp_keycloak_conflict',
  });

  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
  expect(fake.scopes[0].description).toBe('Managed outside Lifecycle');
});

it('fails verification when a posted scope is not observable on immediate readback', async () => {
  const fake = new FakeKeycloakAdmin();
  jest.spyOn(fake, 'post').mockImplementationOnce(async (path) => {
    fake.calls.push({ method: 'POST', path });
  });

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toMatchObject({
    code: 'mcp_keycloak_invalid_state',
  });

  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([{ method: 'POST', path: '/client-scopes' }]);
});

it('fails closed when duplicate reserved scopes appear between create and readback', async () => {
  const fake = new FakeKeycloakAdmin();
  jest.spyOn(fake, 'post').mockImplementationOnce(async (path, body) => {
    fake.calls.push({ method: 'POST', path });
    fake.scopes.push(
      { id: 'scope-created-1', ...structuredClone(body) },
      { id: 'scope-created-2', ...structuredClone(body) }
    );
  });

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toMatchObject({
    code: 'mcp_keycloak_conflict',
  });

  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([{ method: 'POST', path: '/client-scopes' }]);
});

it('repairs owned scope metadata without rewriting other exact resources', async () => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  const scope = fake.scopes.find(({ name }) => name === 'mcp')!;
  scope.attributes['consent.screen.text'] = 'stale consent copy';
  fake.clearCalls();

  await provisioner(fake).reconcile(endpoint);

  expect(fake.scopes.find(({ id }) => id === scope.id)?.attributes['consent.screen.text']).toBe(
    'Use Lifecycle MCP on your behalf'
  );
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([
    { method: 'PUT', path: `/client-scopes/${scope.id}` },
  ]);
});

it('updates a stale desired mapper and removes an unrelated scope mapper', async () => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  const audience = fake.mappers.find(({ name }) => name === 'Lifecycle MCP audience')!;
  audience.config['included.custom.audience'] = 'https://stale.example.test/mcp';
  fake.mappers.push({
    id: 'mapper-unrelated',
    name: 'Unrelated mapper',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-hardcoded-claim-mapper',
    config: {},
  });
  fake.clearCalls();

  await provisioner(fake).reconcile(endpoint);

  expect(fake.mappers.some(({ id }) => id === 'mapper-unrelated')).toBe(false);
  expect(fake.mappers.find(({ name }) => name === 'Lifecycle MCP audience')?.config).toMatchObject({
    'included.custom.audience': endpoint,
  });
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([
    {
      method: 'DELETE',
      path: `/client-scopes/scope-1/protocol-mappers/models/mapper-unrelated`,
    },
    {
      method: 'PUT',
      path: `/client-scopes/scope-1/protocol-mappers/models/${audience.id}`,
    },
  ]);
});

it('fails closed when Keycloak omits the persisted ID from an existing mapper', async () => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  fake.mappers[0].id = undefined;
  fake.clearCalls();

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toMatchObject({
    code: 'mcp_keycloak_invalid_state',
  });

  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it('removes extra realm roles and restores a missing required role mapping', async () => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  fake.scopeMappings = [fake.roles.user, { id: 'role-observer', name: 'observer' }];
  fake.clearCalls();

  await provisioner(fake).reconcile(endpoint);

  expect(fake.scopeMappings.map(({ name }) => name).sort()).toEqual(['admin', 'user']);
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([
    { method: 'DELETE', path: '/client-scopes/scope-1/scope-mappings/realm' },
    { method: 'POST', path: '/client-scopes/scope-1/scope-mappings/realm' },
  ]);
});

it('repairs a stale owned client policy without replacing unrelated policies', async () => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  fake.policies.find(({ name }) => name === 'lifecycle-mcp-anonymous-dcr')!.enabled = false;
  fake.clearCalls();

  await provisioner(fake).reconcile(endpoint);

  expect(fake.policies.find(({ name }) => name === 'lifecycle-mcp-anonymous-dcr')?.enabled).toBe(true);
  expect(fake.policies).toContainEqual(expect.objectContaining({ name: 'unrelated-policy' }));
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([
    { method: 'PUT', path: '/client-policies/policies' },
  ]);
});

it.each([
  ['profile', 'profiles', 'lifecycle-mcp-dcr'],
  ['policy', 'policies', 'lifecycle-mcp-anonymous-dcr'],
] as const)('does not overwrite a reserved %s whose ownership description changed', async (_case, collection, name) => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  fake[collection].find((candidate: JsonObject) => candidate.name === name)!.description = 'Managed elsewhere';
  fake.clearCalls();

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toMatchObject({
    code: 'mcp_keycloak_conflict',
  });

  expect(fake[collection].find((candidate: JsonObject) => candidate.name === name)?.description).toBe(
    'Managed elsewhere'
  );
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it('creates a missing registration policy when no provider policy is available to adopt', async () => {
  const fake = new FakeKeycloakAdmin();
  fake.components = fake.components.filter(({ providerId }) => providerId !== 'consent-required');

  await provisioner(fake).reconcile(endpoint);

  expect(fake.components).toContainEqual(
    expect.objectContaining({
      name: 'Lifecycle MCP Consent Required',
      providerId: 'consent-required',
    })
  );
  expect(fake.calls).toContainEqual({ method: 'POST', path: '/components' });
});

it.each([
  ['stock-consent', 'Lifecycle MCP Consent Required'],
  ['stock-scope', 'Lifecycle MCP Full Scope Disabled'],
])('adopts %s when Keycloak omits its empty config object', async (componentId, expectedName) => {
  const fake = new FakeKeycloakAdmin();
  fake.components.find(({ id }) => id === componentId)!.config = undefined;

  await provisioner(fake).reconcile(endpoint);

  expect(fake.components).toContainEqual(
    expect.objectContaining({
      id: componentId,
      name: expectedName,
      config: {},
    })
  );
});

it.each([
  ['a custom allowlist', { 'allow-default-scopes': ['false'], 'allowed-client-scopes': ['custom'] }],
  ['no config', undefined],
])('refuses to adopt a stock allowed-scope policy with %s', async (_case, config) => {
  const fake = new FakeKeycloakAdmin();
  const allowedScopes = fake.components.find(({ providerId }) => providerId === 'allowed-client-templates')!;
  allowedScopes.config = config;

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toMatchObject({
    code: 'mcp_keycloak_conflict',
  });

  expect(fake.components).toContainEqual(
    expect.objectContaining({ id: 'stock-allowed', config: allowedScopes.config })
  );
  expect(fake.calls).not.toContainEqual({ method: 'DELETE', path: '/components/stock-allowed' });
});

it.each([
  [
    'custom matching rules',
    {
      'host-sending-registration-request-must-match': ['false'],
      'client-uris-must-match': ['true'],
    },
  ],
  ['no config', undefined],
])('refuses to delete a trusted-host policy with %s', async (_case, config) => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  fake.components.push({
    id: 'custom-trusted',
    name: 'Trusted Hosts',
    parentId: 'realm-1',
    providerId: 'trusted-hosts',
    providerType: 'org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy',
    subType: 'anonymous',
    config,
  });
  fake.clearCalls();

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toMatchObject({
    code: 'mcp_keycloak_conflict',
  });

  expect(fake.components).toContainEqual(expect.objectContaining({ id: 'custom-trusted' }));
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it('rejects a reserved registration-policy name bound to the wrong provider', async () => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  fake.components.find(({ name }) => name === 'Lifecycle MCP Consent Required')!.providerId = 'scope';
  fake.clearCalls();

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toMatchObject({
    code: 'mcp_keycloak_conflict',
  });

  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it.each([
  ['scope collection', '/client-scopes', { invalid: 'not-an-array' }],
  ['mapper collection', '/client-scopes/scope-1/protocol-mappers/models', { invalid: 'not-an-array' }],
  ['required realm role', '/roles/user', { name: 'user' }],
  ['client profile collection', '/client-policies/profiles', {}],
  ['client policy collection', '/client-policies/policies', {}],
  ['realm identity', '/', {}],
  [
    'registration component collection',
    '/components?parent=realm-1&type=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy',
    { invalid: 'not-an-array' },
  ],
] as const)('fails closed on an invalid %s response without mutating exact state', async (_case, path, invalid) => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  fake.clearCalls();
  const originalGet = fake.get.bind(fake);
  jest.spyOn(fake, 'get').mockImplementation((async <T>(requestedPath: string): Promise<T> => {
    if (requestedPath === path) {
      return invalid as T;
    }
    return originalGet<T>(requestedPath);
  }) as typeof fake.get);

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toMatchObject({
    code: 'mcp_keycloak_invalid_state',
  });

  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it.each([
  ['client scope', '/client-scopes', () => []],
  [
    'client scope',
    '/client-scopes',
    (scopes: JsonObject[]) => [...scopes, { ...structuredClone(scopes[0]), id: 'duplicate-readback-scope' }],
  ],
  ['scope mappings', '/client-scopes/scope-1/scope-mappings/realm', () => []],
  ['scope mappings', '/default-default-client-scopes', (scopes: JsonObject[]) => [...scopes, { id: 'scope-1' }]],
  ['client policy', '/client-policies/profiles', () => ({})],
  ['client policy', '/client-policies/policies', () => ({})],
  [
    'registration policy consent-required',
    '/components?parent=realm-1&type=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy',
    () => [],
  ],
  [
    'trusted-host policy',
    '/components?parent=realm-1&type=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy',
    (components: JsonObject[]) => [
      ...components,
      {
        id: 'reappeared-trusted',
        name: 'Trusted Hosts',
        parentId: 'realm-1',
        providerId: 'trusted-hosts',
        providerType: 'org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy',
        subType: 'anonymous',
        config: {
          'host-sending-registration-request-must-match': ['true'],
          'client-uris-must-match': ['true'],
        },
      },
    ],
  ],
] as const)('rejects %s drift observed during final readback', async (phase, path, corrupt) => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  fake.clearCalls();
  const originalGet = fake.get.bind(fake);
  let matchingReads = 0;
  jest.spyOn(fake, 'get').mockImplementation((async <T>(requestedPath: string): Promise<T> => {
    const value = await originalGet<T>(requestedPath);
    if (requestedPath !== path || ++matchingReads !== 2) return value;
    return corrupt(value as never) as T;
  }) as typeof fake.get);

  const error = await provisioner(fake)
    .reconcile(endpoint)
    .catch((caught) => caught);

  expect(error).toMatchObject({ code: 'mcp_keycloak_invalid_state' });
  expect(error.cause?.message).toContain(`readback mismatch: ${phase}`);
  expect(fake.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it.each([
  [
    'scope',
    (fake: FakeKeycloakAdmin) => fake.scopes.push({ ...structuredClone(fake.scopes[0]), id: 'duplicate-scope' }),
  ],
  [
    'mapper',
    (fake: FakeKeycloakAdmin) => fake.mappers.push({ ...structuredClone(fake.mappers[0]), id: 'duplicate-mapper' }),
  ],
  [
    'profile',
    (fake: FakeKeycloakAdmin) =>
      fake.profiles.push(structuredClone(fake.profiles.find(({ name }) => name === 'lifecycle-mcp-dcr')!)),
  ],
  [
    'policy',
    (fake: FakeKeycloakAdmin) =>
      fake.policies.push(structuredClone(fake.policies.find(({ name }) => name === 'lifecycle-mcp-anonymous-dcr')!)),
  ],
  [
    'component',
    (fake: FakeKeycloakAdmin) => {
      const component = fake.components.find(({ name }) => name === 'Lifecycle MCP Consent Required')!;
      fake.components.push({
        ...structuredClone(component),
        id: 'duplicate-component',
        name: 'Another Consent Policy',
      });
    },
  ],
  [
    'component name',
    (fake: FakeKeycloakAdmin) => {
      const component = fake.components.find(({ name }) => name === 'Lifecycle MCP Consent Required')!;
      fake.components.push({ ...structuredClone(component), id: 'duplicate-component-name' });
    },
  ],
] as const)('fails closed on a duplicate reserved %s', async (_label, duplicate) => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  duplicate(fake);

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toEqual(
    expect.objectContaining({ code: 'mcp_keycloak_conflict' } satisfies Partial<McpProvisioningError>)
  );
});
