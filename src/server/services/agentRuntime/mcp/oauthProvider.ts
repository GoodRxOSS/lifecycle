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

import * as crypto from 'crypto';
import type { OAuthClientInformation, OAuthClientMetadata, OAuthClientProvider, OAuthTokens } from '@ai-sdk/mcp';
import UserMcpConnectionService from 'server/services/userMcpConnection';
import type { McpDiscoveredTool, McpOauthAuthConfig, McpStoredUserConnectionState } from './types';

type PersistedOAuthState = Extract<McpStoredUserConnectionState, { type: 'oauth' }>;
type McpOAuthClientMetadata = OAuthClientMetadata & {
  application_type: 'native' | 'web';
};

function isHttpLoopback(redirect: URL): boolean {
  const hostname = redirect.hostname.toLowerCase();
  return (
    redirect.protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
  );
}

function getOAuthApplicationType(redirectUrl: string): McpOAuthClientMetadata['application_type'] {
  const redirect = new URL(redirectUrl);
  return isHttpLoopback(redirect) ? 'native' : 'web';
}

export function getMcpOAuthTokenEndpointAuthMethod(redirectUrl: string): 'none' | 'client_secret_basic' {
  return isHttpLoopback(new URL(redirectUrl)) ? 'none' : 'client_secret_basic';
}

export function isMcpOAuthClientAuthenticationCompatible(
  clientInformation: OAuthClientInformation,
  redirectUrl: string
): boolean {
  const expectedMethod = getMcpOAuthTokenEndpointAuthMethod(redirectUrl);
  if (expectedMethod === 'none') {
    return !clientInformation.client_secret;
  }
  return Boolean(clientInformation.client_secret);
}

export function getMcpOAuthRegistrationRedirectUrl(redirectUrl: string): string {
  const redirect = new URL(redirectUrl);
  // RFC 8252 permits an authorization request to choose any port for an IP
  // loopback redirect. Keycloak 26.4 accepts that form only when the DCR
  // metadata registers the same IP/path without a port.
  if (redirect.protocol === 'http:' && (redirect.hostname === '127.0.0.1' || redirect.hostname === '[::1]')) {
    redirect.port = '';
  }
  return redirect.toString();
}

export const OAUTH_RECONNECT_REQUIRED_MESSAGE =
  'MCP OAuth connection expired or needs authorization. Reconnect this MCP connection to continue.';

export class OAuthAuthorizationRequiredError extends Error {
  constructor(message = OAUTH_RECONNECT_REQUIRED_MESSAGE) {
    super(message);
    this.name = 'OAuthAuthorizationRequiredError';
  }
}

type PersistentOAuthClientProviderOptions = {
  userId: string;
  ownerGithubUsername?: string | null;
  scope: string;
  slug: string;
  definitionFingerprint: string;
  authConfig: McpOauthAuthConfig;
  oauthScope?: string;
  redirectUrl: string;
  statePrefix?: string;
  initialState?: PersistedOAuthState | null;
  discoveredTools?: McpDiscoveredTool[];
  validatedAt?: string | null;
  validationError?: string | null;
  interactive?: boolean;
};

export class PersistentOAuthClientProvider implements OAuthClientProvider {
  private stateValue: PersistedOAuthState;
  private discoveredTools: McpDiscoveredTool[];
  private validatedAtValue: string | null;
  private validationErrorValue: string | null;
  private authorizationUrlValue: URL | null = null;

  constructor(private readonly options: PersistentOAuthClientProviderOptions) {
    this.stateValue = options.initialState || { type: 'oauth' };
    this.discoveredTools = options.discoveredTools || [];
    this.validatedAtValue = options.validatedAt || null;
    this.validationErrorValue = options.validationError || null;
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): McpOAuthClientMetadata {
    return {
      redirect_uris: [getMcpOAuthRegistrationRedirectUrl(this.redirectUrl)],
      application_type: getOAuthApplicationType(this.redirectUrl),
      token_endpoint_auth_method: getMcpOAuthTokenEndpointAuthMethod(this.redirectUrl),
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: this.options.authConfig.clientName || `${this.options.slug} MCP`,
      client_uri: new URL(this.redirectUrl).origin,
      ...(this.options.oauthScope ? { scope: this.options.oauthScope } : {}),
    };
  }

  get authorizationUrl(): URL | null {
    return this.authorizationUrlValue;
  }

  get currentState(): PersistedOAuthState {
    return this.stateValue;
  }

  private async persist(overrides?: {
    discoveredTools?: McpDiscoveredTool[];
    validatedAt?: string | null;
  }): Promise<void> {
    if (overrides?.discoveredTools) {
      this.discoveredTools = overrides.discoveredTools;
    }
    if (overrides?.validatedAt !== undefined) {
      this.validatedAtValue = overrides.validatedAt;
    }

    await UserMcpConnectionService.upsertConnection({
      userId: this.options.userId,
      ownerGithubUsername: this.options.ownerGithubUsername,
      scope: this.options.scope,
      slug: this.options.slug,
      state: this.stateValue,
      definitionFingerprint: this.options.definitionFingerprint,
      discoveredTools: this.discoveredTools,
      validationError: this.validationErrorValue,
      validatedAt: this.validatedAtValue,
      // Non-interactive runs are read-only for pending-flow state; a concurrent Connect popup owns it.
      preservePendingFlowState: !this.options.interactive,
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.stateValue.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.stateValue = {
      ...this.stateValue,
      tokens,
    };
    this.validationErrorValue = null;
    await this.persist();
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrlValue = authorizationUrl;
    if (!this.options.interactive) {
      throw new OAuthAuthorizationRequiredError();
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.stateValue = {
      ...this.stateValue,
      codeVerifier,
    };
    // Non-interactive flows can never complete a redirect; persisting their pending
    // verifier/state would clobber a concurrently pending interactive flow.
    if (this.options.interactive) {
      await this.persist();
    }
  }

  async codeVerifier(): Promise<string> {
    if (!this.stateValue.codeVerifier) {
      // Never exchange with an empty PKCE verifier; force a fresh interactive flow instead.
      throw new OAuthAuthorizationRequiredError(
        'Missing PKCE code verifier for this MCP connection. Restart the connection.'
      );
    }

    return this.stateValue.codeVerifier;
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return this.stateValue.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformation): Promise<void> {
    this.stateValue = {
      ...this.stateValue,
      clientInformation,
    };
    await this.persist();
  }

  async state(): Promise<string> {
    const nonce = crypto.randomBytes(16).toString('hex');
    if (!this.options.statePrefix) {
      return nonce;
    }

    return `${this.options.statePrefix}.${nonce}`;
  }

  async saveState(state: string): Promise<void> {
    this.stateValue = {
      ...this.stateValue,
      oauthState: state,
    };
    if (this.options.interactive) {
      await this.persist();
    }
  }

  async storedState(): Promise<string | undefined> {
    return this.stateValue.oauthState;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    switch (scope) {
      case 'all':
        this.stateValue = { type: 'oauth' };
        this.discoveredTools = [];
        this.validatedAtValue = null;
        break;
      case 'client':
        this.stateValue = {
          ...this.stateValue,
          clientInformation: undefined,
          tokens: undefined,
          codeVerifier: undefined,
          oauthState: undefined,
        };
        this.discoveredTools = [];
        this.validatedAtValue = null;
        break;
      case 'tokens':
        this.stateValue = {
          ...this.stateValue,
          tokens: undefined,
          codeVerifier: undefined,
          oauthState: undefined,
        };
        this.discoveredTools = [];
        this.validatedAtValue = null;
        break;
      case 'verifier':
        this.stateValue = {
          ...this.stateValue,
          codeVerifier: undefined,
          oauthState: undefined,
        };
        break;
    }

    if (scope !== 'verifier') {
      // Credentials were rejected by the authorization server; record why instead of wiping errors.
      this.validationErrorValue = OAUTH_RECONNECT_REQUIRED_MESSAGE;
    }

    await this.persist();
  }

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL> {
    if (!resource) {
      throw new Error('MCP protected-resource metadata did not identify its resource.');
    }

    const expected = new URL(serverUrl);
    const advertised = new URL(resource);
    for (const [label, url] of [
      ['configured MCP URL', expected],
      ['protected-resource metadata', advertised],
    ] as const) {
      if (url.username || url.password || url.search || url.hash) {
        throw new Error(`${label} must not include credentials, a query, or a fragment.`);
      }
    }

    // RFC 9728 section 3.3 requires identity, not merely a same-origin or
    // path-prefix relationship. Returning the expected URL also guarantees the
    // same identifier is sent on authorization, token, and refresh requests.
    if (advertised.href !== expected.href) {
      throw new Error(
        `MCP protected-resource metadata identifies ${advertised.href}, but the configured MCP URL is ${expected.href}.`
      );
    }

    return expected;
  }
}
