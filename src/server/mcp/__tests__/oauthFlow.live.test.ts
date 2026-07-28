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

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';

// Live-stack test: proves a stock MCP SDK client completes registration,
// authorization, token exchange, and one read-only tool call against the
// provisioned Keycloak realm. Run with:
//   MCP_LIVE_OAUTH_TEST=true NODE_ENV=test npx jest oauthFlow.live --forceExit
const liveDescribe = process.env.MCP_LIVE_OAUTH_TEST === 'true' ? describe : describe.skip;

const RESOURCE_URL = process.env.MCP_LIVE_RESOURCE_URL || 'http://localhost:5001/mcp';
const USERNAME = process.env.MCP_LIVE_USERNAME || 'lifecycle';
const PASSWORD = process.env.MCP_LIVE_PASSWORD || 'lifecycle';
const REDIRECT_URI = 'http://127.0.0.1:33417/callback';
const CLIENT_SCOPE = 'openid basic mcp offline_access';

interface RegistrationManagement {
  clientUri: string;
  accessToken: string;
}

interface ManagedRegistration {
  clientInformation: OAuthClientInformationFull;
  management: RegistrationManagement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function registrationEndpoint(metadata: AuthorizationServerMetadata): URL {
  if (!metadata.registration_endpoint) {
    throw new Error('Authorization server does not advertise dynamic client registration');
  }
  return new URL(metadata.registration_endpoint);
}

function parseManagement(value: unknown, expectedRegistrationEndpoint: URL): RegistrationManagement {
  if (
    !isRecord(value) ||
    typeof value.registration_client_uri !== 'string' ||
    typeof value.registration_access_token !== 'string' ||
    !value.registration_access_token
  ) {
    throw new Error('Successful registration omitted cleanup credentials');
  }
  const clientUri = new URL(value.registration_client_uri);
  const endpointPath = expectedRegistrationEndpoint.pathname.replace(/\/+$/, '');
  if (clientUri.protocol !== 'https:' && clientUri.protocol !== 'http:') {
    throw new Error('Registration management URI is not an HTTP endpoint');
  }
  if (
    clientUri.origin !== expectedRegistrationEndpoint.origin ||
    !clientUri.pathname.startsWith(`${endpointPath}/`) ||
    clientUri.username ||
    clientUri.password ||
    clientUri.hash
  ) {
    throw new Error('Registration management URI does not belong to the registration endpoint');
  }
  return {
    clientUri: clientUri.toString(),
    accessToken: value.registration_access_token,
  };
}

async function deleteManagedClient(management: RegistrationManagement): Promise<void> {
  const response = await fetch(management.clientUri, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${management.accessToken}` },
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Dynamic client cleanup failed with HTTP ${response.status}`);
  }
  await response.body?.cancel();
}

async function registerManagedClient(
  authorizationServer: string,
  metadata: AuthorizationServerMetadata,
  clientMetadata: OAuthClientMetadata,
  scope?: string
): Promise<ManagedRegistration> {
  const endpoint = registrationEndpoint(metadata);
  let management: RegistrationManagement | null = null;
  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (new URL(url).toString() !== endpoint.toString()) {
      throw new Error('SDK attempted registration at an unexpected endpoint');
    }
    const response = await fetch(url, { ...init, redirect: 'error' });
    if (response.ok) {
      management = parseManagement(await response.clone().json(), endpoint);
    }
    return response;
  };

  try {
    const clientInformation = await registerClient(authorizationServer, {
      metadata,
      clientMetadata,
      scope,
      fetchFn,
    });
    if (!management) throw new Error('Successful registration was not captured for cleanup');
    return { clientInformation, management };
  } catch (error) {
    if (management) await deleteManagedClient(management);
    throw error;
  }
}

async function expectRegistrationRejected(
  metadata: AuthorizationServerMetadata,
  clientMetadata: OAuthClientMetadata
): Promise<void> {
  const endpoint = registrationEndpoint(metadata);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(clientMetadata),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    return;
  }

  const body = await response.json();
  const management = parseManagement(body, endpoint);
  await deleteManagedClient(management);
  throw new Error(`Keycloak unexpectedly accepted redirect URI ${clientMetadata.redirect_uris[0]}`);
}

// Path-aware jar: Keycloak realms on one host reuse cookie names with distinct Path attributes.
class CookieJar {
  private readonly cookies = new Map<string, { name: string; value: string; path: string }>();

  absorb(response: Response): void {
    const getSetCookie = (
      response.headers as Headers & {
        getSetCookie?: () => string[];
      }
    ).getSetCookie;
    if (!getSetCookie) throw new Error('Live OAuth test runtime does not expose Set-Cookie headers');
    for (const line of getSetCookie.call(response.headers)) {
      const [pair, ...attributes] = line.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const path =
        attributes
          .map((attribute) => attribute.trim())
          .find((attribute) => attribute.toLowerCase().startsWith('path='))
          ?.slice('path='.length) || '/';
      const name = pair.slice(0, separator).trim();
      this.cookies.set(`${name}@${path}`, { name, value: pair.slice(separator + 1).trim(), path });
    }
  }

  header(url: string): string {
    const requestPath = new URL(url).pathname;
    return [...this.cookies.values()]
      .filter((cookie) => requestPath === cookie.path || requestPath.startsWith(cookie.path.replace(/\/?$/, '/')))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseFormAction(html: string): string {
  const match = html.match(/<form[^>]*\baction="([^"]+)"/i);
  if (!match) throw new Error(`No form found in authorization page: ${html.slice(0, 500)}`);
  return decodeHtmlAttribute(match[1]);
}

function parseHiddenInputs(html: string): URLSearchParams {
  const params = new URLSearchParams();
  for (const input of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = input[0].match(/\bname="([^"]*)"/i);
    const value = input[0].match(/\bvalue="([^"]*)"/i);
    if (name?.[1]) params.set(decodeHtmlAttribute(name[1]), decodeHtmlAttribute(value?.[1] ?? ''));
  }
  return params;
}

async function submitForm(jar: CookieJar, action: string, params: URLSearchParams): Promise<Response> {
  const response = await fetch(action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header(action) },
    body: params.toString(),
    redirect: 'manual',
  });
  jar.absorb(response);
  return response;
}

/** Walks Keycloak's login and consent pages the way a browser would, returning the authorization code. */
async function driveAuthorization(authorizationUrl: URL): Promise<string> {
  const jar = new CookieJar();
  let current: string | null = authorizationUrl.toString();
  let base = current;
  let response: Response | null = null;

  for (let step = 0; step < 10; step += 1) {
    if (current) {
      if (current.startsWith(REDIRECT_URI)) {
        const code = new URL(current).searchParams.get('code');
        if (!code) throw new Error(`Redirect reached without a code: ${current}`);
        return code;
      }
      base = current;
      response = await fetch(current, { headers: { Cookie: jar.header(current) }, redirect: 'manual' });
      jar.absorb(response);
    }
    if (!response) throw new Error('Authorization walk lost its response');
    if (response.status >= 300 && response.status < 400) {
      current = new URL(response.headers.get('location')!, base).toString();
      continue;
    }
    if (response.status !== 200) {
      throw new Error(`Authorization walk got HTTP ${response.status} at ${base}`);
    }
    const html = await response.text();
    const action = new URL(parseFormAction(html), base).toString();
    const params = parseHiddenInputs(html);
    if (/name="username"/i.test(html)) {
      params.set('username', USERNAME);
      params.set('password', PASSWORD);
      params.set('credentialId', '');
    } else if (/name="accept"/i.test(html)) {
      params.set('accept', 'Yes');
    } else {
      throw new Error(`Unrecognized authorization page: ${html.slice(0, 500)}`);
    }
    response = await submitForm(jar, action, params);
    base = action;
    current =
      response.status >= 300 && response.status < 400
        ? new URL(response.headers.get('location')!, base).toString()
        : null;
  }
  throw new Error('Authorization walk did not reach the redirect URI within 10 steps');
}

liveDescribe('stock MCP client OAuth flow (live stack)', () => {
  jest.setTimeout(120_000);

  it('registers with a ported loopback redirect, signs in, and calls a read-only tool', async () => {
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(RESOURCE_URL);
    expect(resourceMetadata.resource).toBe(RESOURCE_URL);
    const authorizationServer = resourceMetadata.authorization_servers?.[0];
    expect(authorizationServer).toBeTruthy();

    const metadata = await discoverAuthorizationServerMetadata(authorizationServer!);
    expect(metadata).toBeTruthy();

    const registration = await registerManagedClient(
      authorizationServer!,
      metadata!,
      {
        client_name: 'Lifecycle MCP live-flow test',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      CLIENT_SCOPE
    );
    expect(registration.clientInformation.client_id).toBeTruthy();
    expect(registration.clientInformation.token_endpoint_auth_method).toBe('none');

    try {
      const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServer!, {
        metadata,
        clientInformation: registration.clientInformation,
        redirectUrl: REDIRECT_URI,
        scope: CLIENT_SCOPE,
        resource: new URL(RESOURCE_URL),
      });

      const authorizationCode = await driveAuthorization(authorizationUrl);

      const tokens = await exchangeAuthorization(authorizationServer!, {
        metadata,
        clientInformation: registration.clientInformation,
        authorizationCode,
        codeVerifier,
        redirectUri: REDIRECT_URI,
        resource: new URL(RESOURCE_URL),
      });
      expect(tokens.access_token).toBeTruthy();

      const client = new Client({ name: 'lifecycle-live-flow-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(RESOURCE_URL), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'get_context', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(Array.isArray(result.content)).toBe(true);
        expect((result.content as unknown[]).length).toBeGreaterThan(0);
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      await deleteManagedClient(registration.management);
    }
  });

  it('accepts a public client with a ported localhost redirect', async () => {
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(RESOURCE_URL);
    const authorizationServer = resourceMetadata.authorization_servers?.[0];
    expect(authorizationServer).toBeTruthy();
    const metadata = await discoverAuthorizationServerMetadata(authorizationServer!);
    expect(metadata).toBeTruthy();

    const registration = await registerManagedClient(authorizationServer!, metadata!, {
      client_name: 'Lifecycle MCP localhost live test',
      redirect_uris: ['http://localhost:53988/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
    try {
      expect(registration.clientInformation.client_id).toBeTruthy();
      expect(registration.clientInformation.token_endpoint_auth_method).toBe('none');
    } finally {
      await deleteManagedClient(registration.management);
    }
  });

  it.each([
    ['omitted method', undefined],
    ['client_secret_basic', 'client_secret_basic'],
    ['client_secret_post', 'client_secret_post'],
  ] as const)('accepts an HTTPS confidential client with %s', async (_label, authMethod) => {
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(RESOURCE_URL);
    const authorizationServer = resourceMetadata.authorization_servers?.[0];
    expect(authorizationServer).toBeTruthy();
    const metadata = await discoverAuthorizationServerMetadata(authorizationServer!);
    expect(metadata).toBeTruthy();

    const registration = await registerManagedClient(authorizationServer!, metadata!, {
      client_name: `Lifecycle MCP confidential ${authMethod ?? 'default'} live test`,
      redirect_uris: ['https://mcp-client.example.test/callback'],
      ...(authMethod ? { token_endpoint_auth_method: authMethod } : {}),
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
    try {
      expect(registration.clientInformation.client_id).toBeTruthy();
      expect(registration.clientInformation.client_secret).toBeTruthy();
      expect(['client_secret_basic', 'client_secret_post']).toContain(
        registration.clientInformation.token_endpoint_auth_method
      );
    } finally {
      await deleteManagedClient(registration.management);
    }
  });

  it.each([
    ['public arbitrary remote HTTP', 'http://mcp-client.example.test/callback', 'none'],
    ['confidential arbitrary remote HTTP', 'http://mcp-client.example.test/callback', 'client_secret_post'],
    ['public wildcard context', 'https://mcp-client.example.test/*', 'none'],
    ['confidential wildcard context', 'https://mcp-client.example.test/*', 'client_secret_post'],
    ['loopback fragment', 'http://127.0.0.1:33417/callback#fragment', 'none'],
    ['private-use scheme', 'com.example.app:/callback', 'none'],
  ] as const)('rejects %s redirect registration', async (_label, redirectUri, authMethod) => {
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(RESOURCE_URL);
    const authorizationServer = resourceMetadata.authorization_servers?.[0];
    expect(authorizationServer).toBeTruthy();
    const metadata = await discoverAuthorizationServerMetadata(authorizationServer!);
    expect(metadata).toBeTruthy();

    await expectRegistrationRejected(metadata!, {
      client_name: `Lifecycle MCP rejected ${_label} live test`,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: authMethod,
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  });
});
