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

import { KeycloakAdminClient } from './adminClient';
import { LifecycleMcpProvisioner, McpProvisioningError } from './mcpProvisioning';

type JsonObject = Record<string, any>;

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
] as const)('fails closed on a duplicate reserved %s', async (_label, duplicate) => {
  const fake = new FakeKeycloakAdmin();
  await provisioner(fake).reconcile(endpoint);
  duplicate(fake);

  await expect(provisioner(fake).reconcile(endpoint)).rejects.toEqual(
    expect.objectContaining({ code: 'mcp_keycloak_conflict' } satisfies Partial<McpProvisioningError>)
  );
});
