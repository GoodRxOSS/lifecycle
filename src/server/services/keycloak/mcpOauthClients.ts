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

import { randomUUID } from 'node:crypto';
import { AppError, BadRequestError, ConflictError, NotFoundError } from 'server/lib/appError';
import { recordAuthAuditEvent } from '../authAudit';
import { KeycloakAdminClient, KeycloakAdminError } from './adminClient';
import { mcpManagementClientOptions } from './mcpProvisioning';

const CLIENT_ID_PREFIX = 'lifecycle-mcp-';
const CLIENT_DESCRIPTION = 'Lifecycle MCP OAuth client. Managed by Lifecycle.';
const MAX_CLIENTS = 100;
const MAX_NAME_LENGTH = 80;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MANAGED_ATTRIBUTE = 'lifecycle.managed';
const FEATURE_ATTRIBUTE = 'lifecycle.feature';
const CREATED_AT_ATTRIBUTE = 'lifecycle.created-at';
const CREATED_BY_ATTRIBUTE = 'lifecycle.created-by';
const PKCE_ATTRIBUTE = 'pkce.code.challenge.method';

interface KeycloakClientRepresentation {
  id?: string;
  clientId?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  protocol?: string;
  publicClient?: boolean;
  standardFlowEnabled?: boolean;
  implicitFlowEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
  serviceAccountsEnabled?: boolean;
  fullScopeAllowed?: boolean;
  consentRequired?: boolean;
  redirectUris?: string[];
  webOrigins?: string[];
  attributes?: Record<string, string>;
  defaultClientScopes?: string[];
  optionalClientScopes?: string[];
}

interface KeycloakClientPort {
  get<T>(path: string): Promise<T>;
  post(path: string, body: unknown): Promise<void>;
  delete(path: string, body?: unknown): Promise<void>;
}

export interface LifecycleMcpOauthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: string | null;
}

export interface CreateLifecycleMcpOauthClient {
  name: string;
  redirectUris: string[];
}

export interface McpOauthClientServiceDependencies {
  client: KeycloakClientPort;
  createClientId: () => string;
  now: () => Date;
  recordAudit: typeof recordAuthAuditEvent;
}

function defaultDependencies(): McpOauthClientServiceDependencies {
  const options = mcpManagementClientOptions(process.env);
  if (!options) {
    throw new AppError({
      httpStatus: 503,
      code: 'mcp_keycloak_not_configured',
      message: 'Lifecycle MCP sign-in setup is incomplete.',
    });
  }
  return {
    client: new KeycloakAdminClient(options),
    createClientId: () => `${CLIENT_ID_PREFIX}${randomUUID()}`,
    now: () => new Date(),
    recordAudit: recordAuthAuditEvent,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactCreateInput(value: unknown): CreateLifecycleMcpOauthClient {
  if (!isRecord(value) || Object.keys(value).some((key) => !['name', 'redirectUris'].includes(key))) {
    throw new BadRequestError(
      'MCP OAuth client configuration must contain only name and redirectUris.',
      'invalid_mcp_oauth_client'
    );
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new BadRequestError(
      `Client name must be between 1 and ${MAX_NAME_LENGTH} characters.`,
      'invalid_mcp_oauth_client_name'
    );
  }
  if (
    !Array.isArray(value.redirectUris) ||
    value.redirectUris.length < 1 ||
    value.redirectUris.length > MAX_REDIRECT_URIS
  ) {
    throw new BadRequestError(
      `Provide between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`,
      'invalid_mcp_oauth_client_redirects'
    );
  }
  const redirectUris = value.redirectUris.map((candidate) => validateRedirectUri(candidate));
  if (new Set(redirectUris).size !== redirectUris.length) {
    throw new BadRequestError('Redirect URIs must be unique.', 'invalid_mcp_oauth_client_redirects');
  }
  return { name, redirectUris };
}

function validateRedirectUri(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_REDIRECT_URI_LENGTH ||
    value !== value.trim()
  ) {
    throw new BadRequestError('Each redirect URI must be a valid absolute URI.', 'invalid_mcp_oauth_client_redirect');
  }
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new BadRequestError('Each redirect URI must be a valid absolute URI.', 'invalid_mcp_oauth_client_redirect');
  }
  if (uri.username || uri.password || uri.hash || value.includes('*')) {
    throw new BadRequestError(
      'Redirect URIs cannot contain credentials, fragments, or wildcards.',
      'invalid_mcp_oauth_client_redirect'
    );
  }
  if (uri.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname.toLowerCase())) {
    throw new BadRequestError(
      'HTTP redirect URIs are allowed only for localhost or loopback addresses.',
      'invalid_mcp_oauth_client_redirect'
    );
  }
  if (['data:', 'file:', 'javascript:'].includes(uri.protocol)) {
    throw new BadRequestError('This redirect URI scheme is not allowed.', 'invalid_mcp_oauth_client_redirect');
  }
  if (!['http:', 'https:'].includes(uri.protocol) && !uri.hostname && (!uri.pathname || uri.pathname === '/')) {
    throw new BadRequestError(
      'Private-scheme redirect URIs must include an application host and callback path.',
      'invalid_mcp_oauth_client_redirect'
    );
  }
  return value;
}

function isManagedClient(client: KeycloakClientRepresentation): boolean {
  return (
    client.clientId?.startsWith(CLIENT_ID_PREFIX) === true &&
    client.attributes?.[MANAGED_ATTRIBUTE] === 'true' &&
    client.attributes?.[FEATURE_ATTRIBUTE] === 'mcp'
  );
}

function publicClientRepresentation(
  input: CreateLifecycleMcpOauthClient,
  clientId: string,
  actorId: string,
  createdAt: string
): KeycloakClientRepresentation {
  return {
    clientId,
    name: input.name,
    description: CLIENT_DESCRIPTION,
    enabled: true,
    protocol: 'openid-connect',
    publicClient: true,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    fullScopeAllowed: false,
    consentRequired: true,
    redirectUris: input.redirectUris,
    webOrigins: [],
    attributes: {
      [MANAGED_ATTRIBUTE]: 'true',
      [FEATURE_ATTRIBUTE]: 'mcp',
      [CREATED_AT_ATTRIBUTE]: createdAt,
      [CREATED_BY_ATTRIBUTE]: actorId,
      [PKCE_ATTRIBUTE]: 'S256',
    },
    defaultClientScopes: ['basic'],
    optionalClientScopes: ['mcp', 'offline_access'],
  };
}

function exposedClient(client: KeycloakClientRepresentation): LifecycleMcpOauthClient | null {
  if (!isManagedClient(client) || !client.clientId || !client.name || !Array.isArray(client.redirectUris)) return null;
  return {
    clientId: client.clientId,
    name: client.name,
    redirectUris: client.redirectUris.filter((uri): uri is string => typeof uri === 'string'),
    createdAt: client.attributes?.[CREATED_AT_ATTRIBUTE] ?? null,
  };
}

function hasExpectedSecurityState(
  client: KeycloakClientRepresentation,
  desired: KeycloakClientRepresentation
): boolean {
  return (
    isManagedClient(client) &&
    client.clientId === desired.clientId &&
    client.name === desired.name &&
    client.description === desired.description &&
    client.enabled === true &&
    client.protocol === 'openid-connect' &&
    client.publicClient === true &&
    client.standardFlowEnabled === true &&
    client.implicitFlowEnabled === false &&
    client.directAccessGrantsEnabled === false &&
    client.serviceAccountsEnabled === false &&
    client.fullScopeAllowed === false &&
    client.consentRequired === true &&
    client.attributes?.[PKCE_ATTRIBUTE] === 'S256' &&
    Array.isArray(client.redirectUris) &&
    client.redirectUris.length === desired.redirectUris?.length &&
    desired.redirectUris?.every((uri) => client.redirectUris?.includes(uri)) === true &&
    client.defaultClientScopes?.includes('basic') === true &&
    client.optionalClientScopes?.includes('mcp') === true &&
    client.optionalClientScopes?.includes('offline_access') === true
  );
}

function mappedKeycloakError(error: KeycloakAdminError): AppError {
  if (error.kind === 'bad_request') {
    return new BadRequestError(
      'This client could not be saved. Check the name and redirect URIs, then try again.',
      'invalid_mcp_oauth_client',
      { providerStatus: error.status }
    );
  }
  if (error.kind === 'conflict') {
    return new ConflictError(
      'The MCP OAuth client conflicts with existing sign-in configuration.',
      'mcp_oauth_client_conflict'
    );
  }
  return new AppError({
    httpStatus: 503,
    code: 'mcp_keycloak_unavailable',
    message: 'Lifecycle could not update MCP sign-in clients.',
    retryable: error.kind === 'rate_limited' || error.kind === 'unavailable',
    cause: error,
  });
}

export default class McpOauthClientService {
  private static instance: McpOauthClientService;

  static getInstance(): McpOauthClientService {
    if (!this.instance) this.instance = new McpOauthClientService();
    return this.instance;
  }

  constructor(private readonly dependencies: McpOauthClientServiceDependencies = defaultDependencies()) {}

  async list(): Promise<LifecycleMcpOauthClient[]> {
    try {
      const clients = await this.dependencies.client.get<KeycloakClientRepresentation[]>(
        `/clients?clientId=${encodeURIComponent(
          CLIENT_ID_PREFIX
        )}&search=true&briefRepresentation=false&first=0&max=${MAX_CLIENTS}`
      );
      if (!Array.isArray(clients)) {
        throw new AppError({
          httpStatus: 503,
          code: 'mcp_keycloak_invalid_state',
          message: 'Lifecycle received invalid MCP sign-in client data.',
        });
      }
      return clients
        .map(exposedClient)
        .filter((client): client is LifecycleMcpOauthClient => client !== null)
        .sort(
          (left, right) =>
            String(right.createdAt).localeCompare(String(left.createdAt)) || left.name.localeCompare(right.name)
        );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof KeycloakAdminError) throw mappedKeycloakError(error);
      throw error;
    }
  }

  async create(value: unknown, actorId: string, requestId: string | null): Promise<LifecycleMcpOauthClient> {
    const input = exactCreateInput(value);
    try {
      if ((await this.list()).length >= MAX_CLIENTS) {
        throw new ConflictError(
          `Lifecycle supports up to ${MAX_CLIENTS} pre-registered MCP clients.`,
          'mcp_oauth_client_limit'
        );
      }
      const clientId = this.dependencies.createClientId();
      const createdAt = this.dependencies.now().toISOString();
      const desired = publicClientRepresentation(input, clientId, actorId, createdAt);
      await this.dependencies.client.post('/clients', desired);
      const created = await this.findExact(clientId);
      if (!created?.id || !hasExpectedSecurityState(created, desired)) {
        if (created?.id) {
          await this.dependencies.client.delete(`/clients/${encodeURIComponent(created.id)}`).catch(() => undefined);
        }
        throw new AppError({
          httpStatus: 503,
          code: 'mcp_keycloak_invalid_state',
          message: 'Lifecycle could not verify the new MCP sign-in client.',
        });
      }
      const result = exposedClient(created);
      if (!result) {
        throw new AppError({
          httpStatus: 503,
          code: 'mcp_keycloak_invalid_state',
          message: 'Lifecycle could not verify the new MCP sign-in client.',
        });
      }
      await this.dependencies.recordAudit({
        event: 'mcp.oauth_client_created',
        principalKind: 'oauth_client',
        principalId: clientId,
        actorId,
        requestId,
        route: 'POST /api/v2/config/mcp/oauth-clients',
        outcome: 'created',
        meta: { name: result.name, redirectUris: result.redirectUris },
      });
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof KeycloakAdminError) throw mappedKeycloakError(error);
      throw error;
    }
  }

  async delete(clientId: string, actorId: string, requestId: string | null): Promise<void> {
    if (!clientId.startsWith(CLIENT_ID_PREFIX) || clientId.length > 128) {
      throw new NotFoundError('MCP OAuth client not found.', 'mcp_oauth_client_not_found');
    }
    try {
      const client = await this.findExact(clientId);
      const exposed = client ? exposedClient(client) : null;
      if (!client?.id || !exposed) {
        throw new NotFoundError('MCP OAuth client not found.', 'mcp_oauth_client_not_found');
      }
      await this.dependencies.client.delete(`/clients/${encodeURIComponent(client.id)}`);
      await this.dependencies.recordAudit({
        event: 'mcp.oauth_client_deleted',
        principalKind: 'oauth_client',
        principalId: clientId,
        actorId,
        requestId,
        route: 'DELETE /api/v2/config/mcp/oauth-clients/{clientId}',
        outcome: 'deleted',
        meta: { name: exposed.name, redirectUris: exposed.redirectUris },
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof KeycloakAdminError) throw mappedKeycloakError(error);
      throw error;
    }
  }

  private async findExact(clientId: string): Promise<KeycloakClientRepresentation | null> {
    const clients = await this.dependencies.client.get<KeycloakClientRepresentation[]>(
      `/clients?clientId=${encodeURIComponent(clientId)}&search=false&briefRepresentation=false&first=0&max=2`
    );
    if (!Array.isArray(clients)) {
      throw new AppError({
        httpStatus: 503,
        code: 'mcp_keycloak_invalid_state',
        message: 'Lifecycle received invalid MCP sign-in client data.',
      });
    }
    const exact = clients.filter((candidate) => candidate.clientId === clientId);
    if (exact.length > 1) {
      throw new ConflictError(
        'More than one sign-in client uses this client ID. Remove the duplicate, then try again.',
        'mcp_oauth_client_conflict'
      );
    }
    return exact[0] ?? null;
  }
}

export const mcpOauthClientLimits = {
  maxClients: MAX_CLIENTS,
  maxNameLength: MAX_NAME_LENGTH,
  maxRedirectUris: MAX_REDIRECT_URIS,
  maxRedirectUriLength: MAX_REDIRECT_URI_LENGTH,
} as const;
