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
import { getLogger } from 'server/lib/logger';
import { readBoundedResponseText, ResponseBodyTooLargeError } from 'server/lib/readBoundedResponse';
import {
  isLoopbackHostname,
  isMcpServingProcess,
  loadMcpRuntimeConfig,
  type McpRuntimeConfig,
} from 'server/mcp/config';
import { mcpManagementClientOptions, McpProvisioningError, provisionLifecycleMcp } from './keycloak/mcpProvisioning';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_DOCUMENT_BYTES = 256 * 1024;
const REGISTRATION_PROBE_REDIRECT_URI = 'http://127.0.0.1:53987/callback';

export interface McpEnablementIssue {
  code:
    | 'mcp_not_available'
    | 'mcp_endpoint_invalid'
    | 'mcp_oauth_not_configured'
    | 'mcp_keycloak_not_configured'
    | 'mcp_application_signing_unavailable'
    | 'mcp_change_confirmation_unavailable';
  message: string;
}

export type McpEnablementResult =
  | { ok: true; endpoint: string }
  | { ok: false; endpoint: string | null; issue: McpEnablementIssue };

export interface McpEnablementOptions {
  requireChanges?: boolean;
  requestId?: string | null;
}

export interface McpEnablementDependencies {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  loadRuntimeConfig: () => McpRuntimeConfig;
  isServingProcess: () => boolean;
  provision: (endpoint: string, env: NodeJS.ProcessEnv) => Promise<void>;
  timeoutMs: number;
}

interface OidcDiscovery {
  registrationEndpoint: string | null;
  codeChallengeMethods: string[];
  jwksUri: URL;
}

interface RegistrationManagement {
  clientUri: URL;
  accessToken: string;
}

function dependencies(overrides: Partial<McpEnablementDependencies> = {}): McpEnablementDependencies {
  return {
    env: process.env,
    fetch: globalThis.fetch,
    loadRuntimeConfig: loadMcpRuntimeConfig,
    isServingProcess: isMcpServingProcess,
    provision: provisionLifecycleMcp,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...overrides,
  };
}

function unavailable(
  code: McpEnablementIssue['code'],
  message: string,
  endpoint: string | null = null
): McpEnablementResult {
  return { ok: false, endpoint, issue: { code, message } };
}

function providerUrl(value: unknown, label: string, allowInternalHttp = false): URL {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing`);
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && !allowInternalHttp && !isLoopbackHostname(url.hostname))
  ) {
    throw new Error(`${label} is not a safe HTTP endpoint`);
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readBoundedJson(response: Response, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readBoundedResponseText(response, MAX_PROVIDER_DOCUMENT_BYTES);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new Error(`${label} exceeds the response-size limit`);
    }
    throw new Error(`${label} could not be read`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function fetchJson(fetcher: typeof fetch, url: URL, signal: AbortSignal, label: string): Promise<unknown> {
  const response = await fetcher(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return readBoundedJson(response, label);
}

function parseDiscovery(value: unknown, expectedIssuer: string): OidcDiscovery {
  const canonicalIssuer = expectedIssuer.replace(/\/+$/, '');
  if (!isRecord(value) || value.issuer !== canonicalIssuer) {
    throw new Error('OIDC discovery issuer does not match KEYCLOAK_ISSUER');
  }
  providerUrl(value.authorization_endpoint, 'authorization_endpoint');
  providerUrl(value.token_endpoint, 'token_endpoint');
  const jwksUri = providerUrl(value.jwks_uri, 'jwks_uri');
  return {
    registrationEndpoint:
      typeof value.registration_endpoint === 'string' && value.registration_endpoint.trim()
        ? providerUrl(value.registration_endpoint, 'registration_endpoint').toString()
        : null,
    codeChallengeMethods: Array.isArray(value.code_challenge_methods_supported)
      ? value.code_challenge_methods_supported.filter((entry): entry is string => typeof entry === 'string')
      : [],
    jwksUri,
  };
}

function hasUsableRs256Key(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.keys)) return false;
  return value.keys.some(
    (candidate) =>
      isRecord(candidate) &&
      candidate.kty === 'RSA' &&
      (candidate.use === undefined || candidate.use === 'sig') &&
      (candidate.alg === undefined || candidate.alg === 'RS256') &&
      typeof candidate.n === 'string' &&
      candidate.n.length > 0 &&
      typeof candidate.e === 'string' &&
      candidate.e.length > 0
  );
}

export function hasMcpApplicationSigningKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^[0-9a-f]{64}$/i.test(env.ENCRYPTION_KEY?.trim() ?? '');
}

export function inspectMcpEnablement(
  _options: McpEnablementOptions = {},
  overrides: Partial<McpEnablementDependencies> = {}
): McpEnablementResult {
  const deps = dependencies(overrides);
  let runtime: McpRuntimeConfig;
  try {
    runtime = deps.loadRuntimeConfig();
  } catch {
    return unavailable('mcp_endpoint_invalid', 'Lifecycle APP_HOST is not configured as a valid public URL.');
  }
  const endpoint = runtime.resourceUrl;
  if (!deps.isServingProcess()) {
    return unavailable('mcp_not_available', 'Lifecycle MCP is served only by the Lifecycle web process.', endpoint);
  }

  try {
    const endpointUrl = new URL(endpoint);
    if (endpointUrl.protocol !== 'https:' && !isLoopbackHostname(endpointUrl.hostname)) {
      return unavailable('mcp_endpoint_invalid', 'Lifecycle APP_HOST must use HTTPS.', endpoint);
    }
  } catch {
    return unavailable('mcp_endpoint_invalid', 'Lifecycle APP_HOST is not configured as a valid public URL.');
  }
  if (!runtime.authEnabled) {
    return unavailable(
      'mcp_oauth_not_configured',
      'Enable Lifecycle authentication before turning on Lifecycle MCP.',
      endpoint
    );
  }
  try {
    providerUrl(deps.env.KEYCLOAK_ISSUER, 'KEYCLOAK_ISSUER');
    providerUrl(deps.env.KEYCLOAK_JWKS_URL, 'KEYCLOAK_JWKS_URL', true);
  } catch {
    return unavailable(
      'mcp_oauth_not_configured',
      'Configure Lifecycle OAuth issuer and signing keys before turning on Lifecycle MCP.',
      endpoint
    );
  }
  if (!mcpManagementClientOptions(deps.env)) {
    return unavailable(
      'mcp_keycloak_not_configured',
      'Complete Lifecycle MCP sign-in setup before turning it on.',
      endpoint
    );
  }
  if (!hasMcpApplicationSigningKey(deps.env)) {
    return unavailable(
      'mcp_application_signing_unavailable',
      'Configure Lifecycle application encryption before turning on Lifecycle MCP.',
      endpoint
    );
  }
  return { ok: true, endpoint };
}

/** Validates local and public OAuth prerequisites before the exact Keycloak reconciliation and readback. */
export async function enableMcp(
  options: McpEnablementOptions = {},
  overrides: Partial<McpEnablementDependencies> = {}
): Promise<McpEnablementResult> {
  const deps = dependencies(overrides);
  const local = inspectMcpEnablement(options, deps);
  if (!local.ok) return local;

  const discovery = await verifyPublicOauthEndpoints(deps, options.requestId);

  try {
    await deps.provision(local.endpoint, deps.env);
  } catch (error) {
    if (error instanceof McpProvisioningError) {
      const status = error.code === 'mcp_keycloak_unavailable' ? 503 : 409;
      throw new McpEnablementError(error.code, error.message, status, error);
    }
    throw new McpEnablementError(
      'mcp_keycloak_unavailable',
      'Lifecycle MCP sign-in setup is temporarily unavailable.',
      503,
      error
    );
  }
  await verifyPortedLoopbackRegistration(deps, discovery.registrationEndpoint!, options.requestId);
  return local;
}

async function verifyPublicOauthEndpoints(
  deps: McpEnablementDependencies,
  requestId: string | null | undefined
): Promise<OidcDiscovery> {
  const issuerValue = deps.env.KEYCLOAK_ISSUER!.trim().replace(/\/+$/, '');
  const issuer = providerUrl(issuerValue, 'KEYCLOAK_ISSUER');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const discoveryUrl = new URL(`${issuer.pathname.replace(/\/+$/, '')}/.well-known/openid-configuration`, issuer);
    const discovery = parseDiscovery(
      await fetchJson(deps.fetch, discoveryUrl, controller.signal, 'OIDC discovery'),
      issuerValue
    );
    if (!discovery.codeChallengeMethods.includes('S256')) {
      throw new McpEnablementError(
        'mcp_oauth_not_configured',
        'Lifecycle OAuth must advertise PKCE with the S256 challenge method.',
        409
      );
    }
    if (!discovery.registrationEndpoint) {
      throw new McpEnablementError(
        'mcp_registration_unavailable',
        'Lifecycle OAuth does not advertise client registration required by MCP clients.',
        409
      );
    }
    if (!hasUsableRs256Key(await fetchJson(deps.fetch, discovery.jwksUri, controller.signal, 'OAuth signing keys'))) {
      throw new McpEnablementError(
        'mcp_oauth_not_configured',
        'Lifecycle OAuth does not publish a usable RS256 signing key.',
        409
      );
    }
    return discovery;
  } catch (error) {
    if (error instanceof McpEnablementError) throw error;
    getLogger().warn(
      {
        error: error instanceof Error ? { name: error.name } : 'unknown',
        requestId,
      },
      'MCP enablement public OAuth verification failed'
    );
    throw new McpEnablementError(
      'mcp_oauth_unavailable',
      'Lifecycle could not verify the public OAuth endpoints required by MCP.',
      503,
      error
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseRegistrationManagement(value: unknown, registrationEndpoint: URL): RegistrationManagement {
  if (
    !isRecord(value) ||
    typeof value.client_id !== 'string' ||
    !value.client_id ||
    typeof value.registration_client_uri !== 'string' ||
    typeof value.registration_access_token !== 'string' ||
    !value.registration_access_token
  ) {
    throw new Error('Dynamic registration returned incomplete cleanup credentials');
  }

  const clientUri = providerUrl(value.registration_client_uri, 'registration_client_uri');
  const endpointPath = registrationEndpoint.pathname.replace(/\/+$/, '');
  if (
    clientUri.origin !== registrationEndpoint.origin ||
    !clientUri.pathname.startsWith(`${endpointPath}/`) ||
    clientUri.search ||
    clientUri.hash
  ) {
    throw new Error('Dynamic registration returned an unsafe cleanup endpoint');
  }
  return { clientUri, accessToken: value.registration_access_token };
}

async function verifyPortedLoopbackRegistration(
  deps: McpEnablementDependencies,
  registrationEndpointValue: string,
  requestId: string | null | undefined
): Promise<void> {
  const registrationEndpoint = providerUrl(registrationEndpointValue, 'registration_endpoint');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const registrationResponse = await deps.fetch(registrationEndpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Lifecycle MCP enablement probe',
        redirect_uris: [REGISTRATION_PROBE_REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'openid mcp offline_access',
      }),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!registrationResponse.ok) {
      await registrationResponse.body?.cancel();
      throw new McpEnablementError(
        'mcp_registration_unavailable',
        'Lifecycle OAuth rejected the ported loopback callback required by MCP clients.',
        409
      );
    }

    const management = parseRegistrationManagement(
      await readBoundedJson(registrationResponse, 'Dynamic registration response'),
      registrationEndpoint
    );
    const cleanupResponse = await deps.fetch(management.clientUri, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${management.accessToken}` },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!cleanupResponse.ok) {
      await cleanupResponse.body?.cancel();
      throw new Error(`Dynamic registration cleanup returned HTTP ${cleanupResponse.status}`);
    }
    await cleanupResponse.body?.cancel();
  } catch (error) {
    if (error instanceof McpEnablementError) throw error;
    getLogger().warn(
      {
        error: error instanceof Error ? { name: error.name } : 'unknown',
        requestId,
      },
      'MCP enablement dynamic registration verification failed'
    );
    throw new McpEnablementError(
      'mcp_oauth_unavailable',
      'Lifecycle could not verify dynamic registration required by MCP clients.',
      503,
      error
    );
  } finally {
    clearTimeout(timeout);
  }
}

export class McpEnablementError extends AppError {
  constructor(code: string, message: string, httpStatus: 409 | 503, cause?: unknown) {
    super({ httpStatus, code, message, ...(cause === undefined ? {} : { cause }) });
    this.name = 'McpEnablementError';
  }
}
