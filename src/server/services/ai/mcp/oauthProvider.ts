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

export class OAuthAuthorizationRequiredError extends Error {
  constructor(message = 'OAuth authorization is required for this MCP connection') {
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
  redirectUrl: string;
  statePrefix?: string;
  initialState?: PersistedOAuthState | null;
  discoveredTools?: McpDiscoveredTool[];
  validatedAt?: string | null;
  interactive?: boolean;
};

export class PersistentOAuthClientProvider implements OAuthClientProvider {
  private stateValue: PersistedOAuthState;
  private discoveredTools: McpDiscoveredTool[];
  private validatedAtValue: string | null;
  private authorizationUrlValue: URL | null = null;

  constructor(private readonly options: PersistentOAuthClientProviderOptions) {
    this.stateValue = options.initialState || { type: 'oauth' };
    this.discoveredTools = options.discoveredTools || [];
    this.validatedAtValue = options.validatedAt || null;
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: this.options.authConfig.clientName || `${this.options.slug} MCP`,
      client_uri: new URL(this.redirectUrl).origin,
      scope: this.options.authConfig.scope,
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
      validationError: null,
      validatedAt: this.validatedAtValue,
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
    await this.persist();
  }

  async codeVerifier(): Promise<string> {
    return this.stateValue.codeVerifier || '';
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
    await this.persist();
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

    await this.persist();
  }

  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    const configuredResource = this.options.authConfig.resource;
    const effective = configuredResource || resource;
    return effective ? new URL(effective) : undefined;
  }
}
