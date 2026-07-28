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

import { canonicalJson } from 'server/lib/canonicalJson';
import {
  deriveKeycloakAdminBaseUrl,
  KeycloakAdminClient,
  KeycloakAdminError,
  type KeycloakAdminClientOptions,
} from './adminClient';

const DEFAULT_MANAGEMENT_CLIENT_ID = 'lifecycle-api-keycloak-management';
const CLIENT_SCOPE_NAME = 'mcp';
const CLIENT_SCOPE_DESCRIPTION = 'Lifecycle MCP access. Managed by Lifecycle.';
const PUBLIC_PROFILE_NAME = 'lifecycle-mcp-dcr';
const PUBLIC_PROFILE_DESCRIPTION = 'Lifecycle-managed security requirements for MCP OAuth clients.';
const CONFIDENTIAL_PROFILE_NAME = 'lifecycle-mcp-confidential-dcr';
const CONFIDENTIAL_PROFILE_DESCRIPTION = 'Lifecycle-managed security requirements for hosted MCP OAuth clients.';
const PUBLIC_POLICY_NAME = 'lifecycle-mcp-anonymous-dcr';
const PUBLIC_POLICY_DESCRIPTION = 'Lifecycle-managed policy for anonymous MCP OAuth client registration.';
const CONFIDENTIAL_POLICY_NAME = 'lifecycle-mcp-anonymous-confidential-dcr';
const CONFIDENTIAL_POLICY_DESCRIPTION = 'Lifecycle-managed policy for anonymous hosted MCP OAuth client registration.';
const CLIENT_SECRET_AUTHENTICATOR = 'client-secret';
const COMPONENT_PROVIDER_TYPE = 'org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy';
const NO_NORMAL_REDIRECT_HOST = '(?!)';

type JsonObject = Record<string, unknown>;

interface ClientScopeRepresentation {
  id?: string;
  name?: string;
  description?: string;
  protocol?: string;
  attributes?: Record<string, string>;
}

interface ProtocolMapperRepresentation {
  id?: string;
  name?: string;
  protocol?: string;
  protocolMapper?: string;
  config?: Record<string, string>;
}

interface RoleRepresentation {
  id?: string;
  name?: string;
}

interface ComponentRepresentation {
  id?: string;
  name?: string;
  parentId?: string;
  providerId?: string;
  providerType?: string;
  subType?: string;
  config?: Record<string, string[]>;
}

interface ClientProfileRepresentation {
  name?: string;
  description?: string;
  executors?: Array<{ executor?: string; configuration?: JsonObject }>;
}

interface ClientPolicyRepresentation {
  name?: string;
  description?: string;
  enabled?: boolean;
  conditions?: Array<{ condition?: string; configuration?: JsonObject }>;
  profiles?: string[];
}

export type McpProvisioningErrorCode =
  | 'mcp_keycloak_not_configured'
  | 'mcp_keycloak_unauthorized'
  | 'mcp_keycloak_forbidden'
  | 'mcp_keycloak_conflict'
  | 'mcp_keycloak_unavailable'
  | 'mcp_keycloak_invalid_state';

export class McpProvisioningError extends Error {
  constructor(readonly code: McpProvisioningErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'McpProvisioningError';
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function mcpManagementClientOptions(env: NodeJS.ProcessEnv): KeycloakAdminClientOptions | null {
  const issuer = env.KEYCLOAK_ISSUER_INTERNAL?.trim() || env.KEYCLOAK_ISSUER?.trim();
  const secret = env.KEYCLOAK_MANAGEMENT_CLIENT_SECRET?.trim();
  const adminBaseUrl = env.KEYCLOAK_ADMIN_BASE_URL?.trim() || (issuer ? deriveKeycloakAdminBaseUrl(issuer) : null);
  if (!issuer || !secret || !adminBaseUrl) return null;
  return {
    issuer,
    adminBaseUrl,
    clientId: env.KEYCLOAK_MANAGEMENT_CLIENT_ID?.trim() || DEFAULT_MANAGEMENT_CLIENT_ID,
    clientSecret: secret,
    allowInternalHttp: Boolean(env.KEYCLOAK_ISSUER_INTERNAL?.trim()),
  };
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizedComponent(component: ComponentRepresentation): ComponentRepresentation {
  const config = { ...(component.config ?? {}) };
  if (config['allowed-client-scopes']) {
    config['allowed-client-scopes'] = [...config['allowed-client-scopes']].sort();
  }
  return {
    name: component.name,
    parentId: component.parentId,
    providerId: component.providerId,
    providerType: component.providerType,
    subType: component.subType,
    config,
  };
}

function normalizedScope(scope: ClientScopeRepresentation): Omit<ClientScopeRepresentation, 'id'> {
  return {
    name: scope.name,
    description: scope.description,
    protocol: scope.protocol,
    attributes: scope.attributes,
  };
}

function normalizedMapper(mapper: ProtocolMapperRepresentation): Omit<ProtocolMapperRepresentation, 'id'> {
  return {
    name: mapper.name,
    protocol: mapper.protocol,
    protocolMapper: mapper.protocolMapper,
    config: mapper.config,
  };
}

function desiredClientScope(): Required<Omit<ClientScopeRepresentation, 'id'>> {
  return {
    name: CLIENT_SCOPE_NAME,
    description: CLIENT_SCOPE_DESCRIPTION,
    protocol: 'openid-connect',
    attributes: {
      'display.on.consent.screen': 'true',
      'include.in.token.scope': 'true',
      'consent.screen.text': 'Use Lifecycle MCP on your behalf',
    },
  };
}

function claimMapper(
  name: string,
  protocolMapper: string,
  config: Record<string, string>
): Omit<ProtocolMapperRepresentation, 'id'> {
  return {
    name,
    protocol: 'openid-connect',
    protocolMapper,
    config,
  };
}

function ordinaryClaimConfig(claimName: string): Record<string, string> {
  return {
    'claim.name': claimName,
    'jsonType.label': 'String',
    'access.token.claim': 'true',
    'id.token.claim': 'true',
    'userinfo.token.claim': 'true',
    'introspection.token.claim': 'true',
  };
}

function desiredMappers(endpoint: string): Array<Omit<ProtocolMapperRepresentation, 'id'>> {
  return [
    claimMapper('Lifecycle MCP audience', 'oidc-audience-mapper', {
      'included.custom.audience': endpoint,
      'access.token.claim': 'true',
      'id.token.claim': 'false',
      'userinfo.token.claim': 'false',
      'introspection.token.claim': 'true',
    }),
    claimMapper('Preferred username', 'oidc-usermodel-property-mapper', {
      'user.attribute': 'username',
      ...ordinaryClaimConfig('preferred_username'),
    }),
    claimMapper('Email', 'oidc-usermodel-property-mapper', {
      'user.attribute': 'email',
      ...ordinaryClaimConfig('email'),
    }),
    claimMapper('Github username', 'oidc-usermodel-attribute-mapper', {
      'user.attribute': 'githubUsername',
      ...ordinaryClaimConfig('github_username'),
    }),
    claimMapper('Lifecycle realm roles', 'oidc-usermodel-realm-role-mapper', {
      'claim.name': 'realm_access.roles',
      'jsonType.label': 'String',
      multivalued: 'true',
      'access.token.claim': 'true',
      'id.token.claim': 'false',
      'userinfo.token.claim': 'false',
      'introspection.token.claim': 'true',
    }),
  ];
}

const COMMON_PROFILE_EXECUTORS: NonNullable<ClientProfileRepresentation['executors']> = [
  { executor: 'pkce-enforcer', configuration: { 'auto-configure': true } },
  { executor: 'consent-required', configuration: { 'auto-configure': true } },
  { executor: 'full-scope-disabled', configuration: { 'auto-configure': true } },
  { executor: 'reject-implicit-grant', configuration: { 'auto-configure': true } },
  { executor: 'reject-ropc-grant', configuration: { 'auto-configure': true } },
  {
    executor: 'secure-client-authenticator',
    configuration: { 'allowed-client-authenticators': [CLIENT_SECRET_AUTHENTICATOR] },
  },
];

const DESIRED_PUBLIC_PROFILE: ClientProfileRepresentation = {
  name: PUBLIC_PROFILE_NAME,
  description: PUBLIC_PROFILE_DESCRIPTION,
  executors: [
    ...COMMON_PROFILE_EXECUTORS,
    {
      executor: 'secure-redirect-uris-enforcer',
      configuration: {
        'allow-ipv4-loopback-address': true,
        'allow-ipv6-loopback-address': true,
        'allow-private-use-uri-scheme': false,
        'allow-http-scheme': true,
        'allow-wildcard-context-path': false,
        // Keycloak applies this only to non-loopback hosts; the never-match pattern rejects all of them.
        'allow-permitted-domains': [NO_NORMAL_REDIRECT_HOST],
        // Keycloak 26.4 otherwise rejects ports in registered loopback redirects.
        'oauth-2-1-compliant': false,
        'allow-open-redirect': false,
      },
    },
  ],
};

const DESIRED_CONFIDENTIAL_PROFILE: ClientProfileRepresentation = {
  name: CONFIDENTIAL_PROFILE_NAME,
  description: CONFIDENTIAL_PROFILE_DESCRIPTION,
  executors: [
    ...COMMON_PROFILE_EXECUTORS,
    {
      executor: 'secure-redirect-uris-enforcer',
      configuration: {
        'allow-ipv4-loopback-address': false,
        'allow-ipv6-loopback-address': false,
        'allow-private-use-uri-scheme': false,
        'allow-http-scheme': false,
        'allow-wildcard-context-path': false,
        'allow-permitted-domains': [],
        'oauth-2-1-compliant': true,
        'allow-open-redirect': false,
      },
    },
  ],
};

const DESIRED_PROFILES = [DESIRED_PUBLIC_PROFILE, DESIRED_CONFIDENTIAL_PROFILE];

function updaterConditions(
  accessType: 'public' | 'confidential'
): NonNullable<ClientPolicyRepresentation['conditions']> {
  return [
    {
      condition: 'client-updater-context',
      // Registration-access-token self-updates must satisfy the same constraints.
      configuration: { 'update-client-source': ['ByAnonymous', 'ByRegistrationAccessToken'] },
    },
    {
      condition: 'client-access-type',
      configuration: { type: [accessType] },
    },
  ];
}

const DESIRED_POLICIES: ClientPolicyRepresentation[] = [
  {
    name: PUBLIC_POLICY_NAME,
    description: PUBLIC_POLICY_DESCRIPTION,
    enabled: true,
    conditions: updaterConditions('public'),
    profiles: [PUBLIC_PROFILE_NAME],
  },
  {
    name: CONFIDENTIAL_POLICY_NAME,
    description: CONFIDENTIAL_POLICY_DESCRIPTION,
    enabled: true,
    conditions: updaterConditions('confidential'),
    profiles: [CONFIDENTIAL_PROFILE_NAME],
  },
];

function desiredComponents(realmId: string): ComponentRepresentation[] {
  return [
    {
      name: 'Lifecycle MCP Consent Required',
      parentId: realmId,
      providerId: 'consent-required',
      providerType: COMPONENT_PROVIDER_TYPE,
      subType: 'anonymous',
      config: {},
    },
    {
      name: 'Lifecycle MCP Full Scope Disabled',
      parentId: realmId,
      providerId: 'scope',
      providerType: COMPONENT_PROVIDER_TYPE,
      subType: 'anonymous',
      config: {},
    },
    {
      name: 'Lifecycle MCP Allowed Client Scopes',
      parentId: realmId,
      providerId: 'allowed-client-templates',
      providerType: COMPONENT_PROVIDER_TYPE,
      subType: 'anonymous',
      config: {
        // Keycloak's registration whitelist requires listing openid even though it is a protocol scope, not a stored realm scope.
        'allowed-client-scopes': ['openid', 'basic', CLIENT_SCOPE_NAME, 'offline_access'],
        'allow-default-scopes': ['false'],
      },
    },
  ];
}

function isAdoptableStockComponent(component: ComponentRepresentation, desired: ComponentRepresentation): boolean {
  if (
    component.subType !== 'anonymous' ||
    component.providerType !== COMPONENT_PROVIDER_TYPE ||
    component.providerId !== desired.providerId
  ) {
    return false;
  }
  if (desired.providerId === 'consent-required') {
    return component.name === 'Consent Required' && exact(component.config ?? {}, {});
  }
  if (desired.providerId === 'scope') {
    return component.name === 'Full Scope Disabled' && exact(component.config ?? {}, {});
  }
  return (
    component.name === 'Allowed Client Scopes' && exact(component.config ?? {}, { 'allow-default-scopes': ['true'] })
  );
}

function isStockTrustedHosts(component: ComponentRepresentation): boolean {
  return (
    component.name === 'Trusted Hosts' &&
    component.providerId === 'trusted-hosts' &&
    component.providerType === COMPONENT_PROVIDER_TYPE &&
    component.subType === 'anonymous' &&
    exact(component.config ?? {}, {
      'host-sending-registration-request-must-match': ['true'],
      'client-uris-must-match': ['true'],
    })
  );
}

function conflict(message: string): never {
  throw new McpProvisioningError(
    'mcp_keycloak_conflict',
    'Existing sign-in configuration conflicts with Lifecycle MCP.',
    { cause: new Error(message) }
  );
}

export class LifecycleMcpProvisioner {
  constructor(private readonly client: KeycloakAdminClient) {}

  async reconcile(endpoint: string): Promise<void> {
    try {
      const scopeId = await this.reconcileScope(endpoint);
      await this.reconcileScopeMappings(scopeId);
      await this.reconcileClientProfiles();
      await this.reconcileClientPolicies();
      await this.reconcileRegistrationPolicies();
      await this.verifyExactState(endpoint, scopeId);
    } catch (error) {
      if (error instanceof McpProvisioningError) throw error;
      if (error instanceof KeycloakAdminError) {
        if (error.kind === 'unauthorized') {
          throw new McpProvisioningError(
            'mcp_keycloak_unauthorized',
            'Lifecycle MCP setup is incomplete because its sign-in setup credential was rejected.',
            { cause: error }
          );
        }
        if (error.kind === 'forbidden') {
          throw new McpProvisioningError(
            'mcp_keycloak_forbidden',
            'Lifecycle MCP setup is incomplete because its sign-in setup permission is missing.',
            { cause: error }
          );
        }
        if (error.kind === 'conflict' || error.kind === 'bad_request') {
          throw new McpProvisioningError(
            'mcp_keycloak_conflict',
            'Existing sign-in configuration conflicts with Lifecycle MCP.',
            { cause: error }
          );
        }
        throw new McpProvisioningError(
          'mcp_keycloak_unavailable',
          'Lifecycle MCP sign-in setup is temporarily unavailable.',
          { cause: error }
        );
      }
      throw new McpProvisioningError('mcp_keycloak_invalid_state', 'Lifecycle could not verify MCP sign-in setup.', {
        cause: error,
      });
    }
  }

  private async reconcileScope(endpoint: string): Promise<string> {
    const scopes = await this.client.get<ClientScopeRepresentation[]>('/client-scopes');
    if (!Array.isArray(scopes)) {
      throw new McpProvisioningError('mcp_keycloak_invalid_state', 'Lifecycle received invalid sign-in setup data.');
    }
    const matchingScopes = scopes.filter((candidate) => candidate.name === CLIENT_SCOPE_NAME);
    if (matchingScopes.length > 1) {
      conflict('More than one Keycloak client scope is named mcp.');
    }
    let scope: ClientScopeRepresentation | undefined = matchingScopes[0];
    if (scope && scope.description !== CLIENT_SCOPE_DESCRIPTION) {
      conflict('A Keycloak client scope named mcp already exists and is not managed by Lifecycle.');
    }
    if (!scope) {
      await this.client.post('/client-scopes', desiredClientScope());
      const created = await this.client.get<ClientScopeRepresentation[]>('/client-scopes');
      const createdMatches = created.filter((candidate) => candidate.name === CLIENT_SCOPE_NAME);
      if (createdMatches.length > 1) {
        conflict('More than one Keycloak client scope is named mcp.');
      }
      scope = createdMatches[0];
    }
    if (!scope?.id) {
      throw new McpProvisioningError('mcp_keycloak_invalid_state', 'Lifecycle could not verify MCP sign-in setup.');
    }

    if (!exact(normalizedScope(scope), desiredClientScope())) {
      await this.client.put(`/client-scopes/${encodeURIComponent(scope.id)}`, {
        id: scope.id,
        ...desiredClientScope(),
      });
    }
    await this.reconcileMappers(scope.id, endpoint);

    const [defaultScopes, optionalScopes] = await Promise.all([
      this.client.get<ClientScopeRepresentation[]>('/default-default-client-scopes'),
      this.client.get<ClientScopeRepresentation[]>('/default-optional-client-scopes'),
    ]);
    if (defaultScopes.some((candidate) => candidate.id === scope?.id)) {
      await this.client.delete(`/default-default-client-scopes/${encodeURIComponent(scope.id)}`);
    }
    if (!optionalScopes.some((candidate) => candidate.id === scope?.id)) {
      await this.client.put(`/default-optional-client-scopes/${encodeURIComponent(scope.id)}`, {});
    }
    return scope.id;
  }

  private async reconcileMappers(scopeId: string, endpoint: string): Promise<void> {
    const path = `/client-scopes/${encodeURIComponent(scopeId)}/protocol-mappers/models`;
    const existing = await this.client.get<ProtocolMapperRepresentation[]>(path);
    if (!Array.isArray(existing)) {
      throw new McpProvisioningError('mcp_keycloak_invalid_state', 'Lifecycle received invalid sign-in setup data.');
    }
    const desired = desiredMappers(endpoint);
    const desiredNames = new Set(desired.map((mapper) => mapper.name));
    for (const name of desiredNames) {
      if (existing.filter((mapper) => mapper.name === name).length > 1) {
        conflict(`More than one Keycloak protocol mapper is named ${name}.`);
      }
    }

    for (const mapper of existing) {
      if (!mapper.id) {
        throw new McpProvisioningError('mcp_keycloak_invalid_state', 'Lifecycle received invalid sign-in setup data.');
      }
      if (!mapper.name || !desiredNames.has(mapper.name)) {
        await this.client.delete(`${path}/${encodeURIComponent(mapper.id)}`);
      }
    }
    for (const mapper of desired) {
      const current = existing.find((candidate) => candidate.name === mapper.name);
      if (current?.id) {
        if (!exact(normalizedMapper(current), mapper)) {
          await this.client.put(`${path}/${encodeURIComponent(current.id)}`, { id: current.id, ...mapper });
        }
      } else {
        await this.client.post(path, mapper);
      }
    }
  }

  private async reconcileScopeMappings(scopeId: string): Promise<void> {
    const rolePath = `/client-scopes/${encodeURIComponent(scopeId)}/scope-mappings/realm`;
    const [userRole, adminRole, current] = await Promise.all([
      this.client.get<RoleRepresentation>('/roles/user'),
      this.client.get<RoleRepresentation>('/roles/admin'),
      this.client.get<RoleRepresentation[]>(rolePath),
    ]);
    if (!userRole.id || !adminRole.id || !Array.isArray(current)) {
      throw new McpProvisioningError(
        'mcp_keycloak_invalid_state',
        'Lifecycle could not verify the MCP permission mappings.'
      );
    }
    const desired = [userRole, adminRole];
    const extras = current.filter((role) => role.name !== 'user' && role.name !== 'admin');
    if (extras.length > 0) await this.client.delete(rolePath, extras);
    const currentNames = new Set(current.map((role) => role.name));
    const missing = desired.filter((role) => !currentNames.has(role.name));
    if (missing.length > 0) await this.client.post(rolePath, missing);
  }

  private async reconcileClientProfiles(): Promise<void> {
    const path = '/client-policies/profiles';
    const representation = await this.client.get<{ profiles?: ClientProfileRepresentation[] }>(path);
    const profiles = representation.profiles;
    if (!Array.isArray(profiles)) {
      throw new McpProvisioningError('mcp_keycloak_invalid_state', 'Lifecycle received invalid sign-in setup data.');
    }
    let next = profiles;
    let changed = false;
    for (const desired of DESIRED_PROFILES) {
      const matchingProfiles = next.filter((profile) => profile.name === desired.name);
      if (matchingProfiles.length > 1) {
        conflict(`More than one Keycloak client profile is named ${desired.name}.`);
      }
      const existing = matchingProfiles[0];
      if (existing && existing.description !== desired.description) {
        conflict(`A Keycloak client profile named ${desired.name} already exists and is not managed by Lifecycle.`);
      }
      if (!exact(existing, desired)) {
        next = existing ? next.map((profile) => (profile === existing ? desired : profile)) : [...next, desired];
        changed = true;
      }
    }
    if (changed) {
      await this.client.put(path, { profiles: next });
    }
  }

  private async reconcileClientPolicies(): Promise<void> {
    const path = '/client-policies/policies';
    const representation = await this.client.get<{ policies?: ClientPolicyRepresentation[] }>(path);
    const policies = representation.policies;
    if (!Array.isArray(policies)) {
      throw new McpProvisioningError('mcp_keycloak_invalid_state', 'Lifecycle received invalid sign-in setup data.');
    }
    let next = policies;
    let changed = false;
    for (const desired of DESIRED_POLICIES) {
      const matchingPolicies = next.filter((policy) => policy.name === desired.name);
      if (matchingPolicies.length > 1) {
        conflict(`More than one Keycloak client policy is named ${desired.name}.`);
      }
      const existing = matchingPolicies[0];
      if (existing && existing.description !== desired.description) {
        conflict(`A Keycloak client policy named ${desired.name} already exists and is not managed by Lifecycle.`);
      }
      if (!exact(existing, desired)) {
        next = existing ? next.map((policy) => (policy === existing ? desired : policy)) : [...next, desired];
        changed = true;
      }
    }
    if (changed) {
      await this.client.put(path, { policies: next });
    }
  }

  private async reconcileRegistrationPolicies(): Promise<void> {
    const realm = await this.client.get<{ id?: string }>('/');
    if (!realm.id) {
      throw new McpProvisioningError('mcp_keycloak_invalid_state', 'Lifecycle received invalid sign-in setup data.');
    }
    const path = `/components?parent=${encodeURIComponent(realm.id)}&type=${encodeURIComponent(
      COMPONENT_PROVIDER_TYPE
    )}`;
    const components = await this.client.get<ComponentRepresentation[]>(path);
    if (!Array.isArray(components)) {
      throw new McpProvisioningError('mcp_keycloak_invalid_state', 'Lifecycle received invalid sign-in setup data.');
    }

    for (const desired of desiredComponents(realm.id)) {
      const matchingComponents = components.filter((component) => component.name === desired.name);
      if (matchingComponents.length > 1) {
        conflict(`More than one Keycloak registration policy is named ${desired.name}.`);
      }
      let current = matchingComponents[0];
      if (
        current &&
        (current.providerId !== desired.providerId ||
          current.providerType !== desired.providerType ||
          current.subType !== desired.subType)
      ) {
        conflict(`A Keycloak registration policy named ${desired.name} conflicts with Lifecycle MCP.`);
      }
      const providerComponents = components.filter(
        (component) =>
          component.providerId === desired.providerId &&
          component.providerType === desired.providerType &&
          component.subType === desired.subType
      );
      if (current && (providerComponents.length !== 1 || providerComponents[0] !== current)) {
        conflict(`More than one anonymous Keycloak ${desired.providerId} registration policy is active.`);
      }
      if (!current) {
        const candidates = providerComponents;
        if (candidates.length > 1 || (candidates.length === 1 && !isAdoptableStockComponent(candidates[0], desired))) {
          conflict(`Existing Keycloak ${desired.providerId} registration policy is customized.`);
        }
        current = candidates[0];
      }
      if (current?.id) {
        if (!exact(normalizedComponent(current), normalizedComponent(desired))) {
          await this.client.put(`/components/${encodeURIComponent(current.id)}`, {
            id: current.id,
            ...desired,
          });
        }
      } else {
        await this.client.post('/components', desired);
      }
    }

    const trustedHosts = components.filter(
      (component) => component.providerId === 'trusted-hosts' && component.subType === 'anonymous'
    );
    if (trustedHosts.length > 1 || (trustedHosts.length === 1 && !isStockTrustedHosts(trustedHosts[0]))) {
      conflict('The anonymous Keycloak trusted-host registration policy is customized.');
    }
    if (trustedHosts[0]?.id) {
      await this.client.delete(`/components/${encodeURIComponent(trustedHosts[0].id)}`);
    }
  }

  private async verifyExactState(endpoint: string, scopeId: string): Promise<void> {
    const [scopes, mappers, roleMappings, defaultScopes, optionalScopes, profiles, policies, realm] = await Promise.all(
      [
        this.client.get<ClientScopeRepresentation[]>('/client-scopes'),
        this.client.get<ProtocolMapperRepresentation[]>(
          `/client-scopes/${encodeURIComponent(scopeId)}/protocol-mappers/models`
        ),
        this.client.get<RoleRepresentation[]>(`/client-scopes/${encodeURIComponent(scopeId)}/scope-mappings/realm`),
        this.client.get<ClientScopeRepresentation[]>('/default-default-client-scopes'),
        this.client.get<ClientScopeRepresentation[]>('/default-optional-client-scopes'),
        this.client.get<{ profiles?: ClientProfileRepresentation[] }>('/client-policies/profiles'),
        this.client.get<{ policies?: ClientPolicyRepresentation[] }>('/client-policies/policies'),
        this.client.get<{ id?: string }>('/'),
      ]
    );
    const matchingScopes = scopes.filter(
      (candidate) => candidate.id === scopeId || candidate.name === CLIENT_SCOPE_NAME
    );
    const scope = matchingScopes.find((candidate) => candidate.id === scopeId);
    const expectedScope = desiredClientScope();
    if (
      matchingScopes.length !== 1 ||
      !scope ||
      !exact(
        {
          name: scope.name,
          description: scope.description,
          protocol: scope.protocol,
          attributes: scope.attributes,
        },
        expectedScope
      )
    ) {
      this.invalidReadback('client scope');
    }

    const normalizedMappers = mappers
      .map(({ name, protocol, protocolMapper, config }) => ({
        name,
        protocol,
        protocolMapper,
        config,
      }))
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    const expectedMappers = desiredMappers(endpoint).sort((left, right) =>
      String(left.name).localeCompare(String(right.name))
    );
    if (
      !exact(normalizedMappers, expectedMappers) ||
      defaultScopes.some((candidate) => candidate.id === scopeId) ||
      !optionalScopes.some((candidate) => candidate.id === scopeId) ||
      !exact(
        roleMappings
          .map((role) => role.name)
          .filter(Boolean)
          .sort(),
        ['admin', 'user']
      )
    ) {
      this.invalidReadback('scope mappings');
    }

    const profilesMatch = DESIRED_PROFILES.every((desired) => {
      const matching = profiles.profiles?.filter((candidate) => candidate.name === desired.name) ?? [];
      return matching.length === 1 && exact(matching[0], desired);
    });
    const policiesMatch = DESIRED_POLICIES.every((desired) => {
      const matching = policies.policies?.filter((candidate) => candidate.name === desired.name) ?? [];
      return matching.length === 1 && exact(matching[0], desired);
    });
    if (!profilesMatch || !policiesMatch || !realm.id) {
      this.invalidReadback('client policy');
    }

    const components = await this.client.get<ComponentRepresentation[]>(
      `/components?parent=${encodeURIComponent(realm.id)}&type=${encodeURIComponent(COMPONENT_PROVIDER_TYPE)}`
    );
    for (const desired of desiredComponents(realm.id)) {
      const matchingComponents = components.filter((candidate) => candidate.name === desired.name);
      const current = matchingComponents[0];
      const matchingProviderComponents = components.filter(
        (candidate) =>
          candidate.providerId === desired.providerId &&
          candidate.providerType === desired.providerType &&
          candidate.subType === desired.subType
      );
      if (
        matchingComponents.length !== 1 ||
        matchingProviderComponents.length !== 1 ||
        matchingProviderComponents[0]?.id !== current?.id ||
        !current ||
        !exact(normalizedComponent(current), normalizedComponent(desired))
      ) {
        this.invalidReadback(`registration policy ${desired.providerId}`);
      }
    }
    if (components.some((component) => component.providerId === 'trusted-hosts' && component.subType === 'anonymous')) {
      this.invalidReadback('trusted-host policy');
    }
  }

  private invalidReadback(phase: string): never {
    throw new McpProvisioningError('mcp_keycloak_invalid_state', 'Lifecycle could not verify MCP sign-in setup.', {
      cause: new Error(`MCP Keycloak readback mismatch: ${phase}`),
    });
  }
}

export async function provisionLifecycleMcp(endpoint: string, env: NodeJS.ProcessEnv): Promise<void> {
  const options = mcpManagementClientOptions(env);
  if (!options) {
    throw new McpProvisioningError('mcp_keycloak_not_configured', 'Lifecycle MCP sign-in setup is incomplete.');
  }
  await new LifecycleMcpProvisioner(new KeycloakAdminClient(options)).reconcile(endpoint);
}
