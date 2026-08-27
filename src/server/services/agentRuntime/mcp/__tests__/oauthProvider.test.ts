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

jest.mock('server/services/userMcpConnection', () => ({
  __esModule: true,
  default: { upsertConnection: jest.fn() },
}));

import UserMcpConnectionService from 'server/services/userMcpConnection';
import {
  getMcpOAuthRegistrationRedirectUrl,
  getMcpOAuthTokenEndpointAuthMethod,
  isMcpOAuthClientAuthenticationCompatible,
  OAUTH_RECONNECT_REQUIRED_MESSAGE,
  OAuthAuthorizationRequiredError,
  PersistentOAuthClientProvider,
} from '../oauthProvider';

const mockUpsertConnection = UserMcpConnectionService.upsertConnection as jest.Mock;

function makeProvider(options: { interactive: boolean; validationError?: string | null }) {
  return new PersistentOAuthClientProvider({
    userId: 'sample-user',
    ownerGithubUsername: 'sample-user',
    scope: 'global',
    slug: 'sample-oauth',
    definitionFingerprint: 'sample-definition-fingerprint',
    authConfig: {
      mode: 'oauth',
      provider: 'generic-oauth2.1',
    },
    redirectUrl: 'https://app.example.com/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback',
    initialState: { type: 'oauth' },
    ...options,
  });
}

describe('PersistentOAuthClientProvider', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockUpsertConnection.mockReset();
  });

  it('uses public-client authentication only for HTTP loopback callbacks', () => {
    const loopbackRedirect = 'http://127.0.0.1:49152/oauth/callback';
    const hostedRedirect = 'https://app.example.com/oauth/callback';

    expect(getMcpOAuthTokenEndpointAuthMethod(loopbackRedirect)).toBe('none');
    expect(getMcpOAuthTokenEndpointAuthMethod(hostedRedirect)).toBe('client_secret_basic');
    expect(
      isMcpOAuthClientAuthenticationCompatible(
        {
          client_id: 'public-client',
        },
        loopbackRedirect
      )
    ).toBe(true);
    expect(
      isMcpOAuthClientAuthenticationCompatible(
        {
          client_id: 'stale-confidential-client',
          client_secret: 'must-not-be-sent',
        },
        loopbackRedirect
      )
    ).toBe(false);
  });

  it('normalizes only IP-loopback registration redirects while preserving the runtime callback', () => {
    expect(getMcpOAuthRegistrationRedirectUrl('http://127.0.0.1:49152/oauth/callback')).toBe(
      'http://127.0.0.1/oauth/callback'
    );
    expect(getMcpOAuthRegistrationRedirectUrl('http://localhost:49152/oauth/callback')).toBe(
      'http://localhost:49152/oauth/callback'
    );
    expect(getMcpOAuthRegistrationRedirectUrl('https://app.example.com:8443/oauth/callback')).toBe(
      'https://app.example.com:8443/oauth/callback'
    );
  });

  it('registers a hosted HTTPS callback as a confidential client', () => {
    const provider = new PersistentOAuthClientProvider({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      definitionFingerprint: 'sample-definition-fingerprint',
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
        clientName: 'Sample MCP',
      },
      oauthScope: 'sample.read',
      redirectUrl: 'https://app.example.com/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback',
      interactive: false,
    });

    expect(provider.clientMetadata).toEqual({
      redirect_uris: ['https://app.example.com/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback'],
      application_type: 'web',
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Sample MCP',
      client_uri: 'https://app.example.com',
      scope: 'sample.read',
    });
  });

  it.each([
    ['http://127.0.0.1:49152/oauth/callback', 'http://127.0.0.1/oauth/callback'],
    ['http://[::1]:49152/oauth/callback', 'http://[::1]/oauth/callback'],
  ])('registers an IP loopback callback without its dynamic port: %s', (redirectUrl, registrationRedirect) => {
    const provider = new PersistentOAuthClientProvider({
      userId: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      definitionFingerprint: 'sample-definition-fingerprint',
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
      },
      redirectUrl,
      interactive: false,
    });

    expect(provider.redirectUrl).toBe(redirectUrl);
    expect(provider.clientMetadata).toEqual(
      expect.objectContaining({
        application_type: 'native',
        redirect_uris: [registrationRedirect],
        token_endpoint_auth_method: 'none',
      })
    );
  });

  it('marks localhost as native without rewriting it to an IP literal', () => {
    const redirectUrl = 'http://localhost:49152/oauth/callback';
    const provider = new PersistentOAuthClientProvider({
      userId: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      definitionFingerprint: 'sample-definition-fingerprint',
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
      },
      redirectUrl,
      interactive: false,
    });

    expect(provider.clientMetadata).toEqual(
      expect.objectContaining({
        application_type: 'native',
        redirect_uris: [redirectUrl],
        token_endpoint_auth_method: 'none',
      })
    );
  });

  it('exposes and persists the complete OAuth credential state without losing validation metadata', async () => {
    const initialTokens = { access_token: 'initial-access-token', token_type: 'bearer' } as const;
    const initialClientInformation = {
      client_id: 'initial-client',
      client_secret: 'initial-client-secret',
    };
    const discoveredTools = [
      {
        name: 'readSample',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
    ];
    const provider = new PersistentOAuthClientProvider({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-github-user',
      scope: 'global',
      slug: 'sample-oauth',
      definitionFingerprint: 'sample-definition-fingerprint',
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
      },
      redirectUrl: 'https://app.example.com/oauth/callback',
      initialState: {
        type: 'oauth',
        tokens: initialTokens,
        clientInformation: initialClientInformation,
        codeVerifier: 'initial-verifier',
        oauthState: 'initial-state',
      },
      discoveredTools,
      validatedAt: '2026-05-01T00:00:00.000Z',
      validationError: 'previous validation failure',
      interactive: true,
    });

    await expect(provider.tokens()).resolves.toEqual(initialTokens);
    await expect(provider.clientInformation()).resolves.toEqual(initialClientInformation);
    await expect(provider.codeVerifier()).resolves.toBe('initial-verifier');
    await expect(provider.storedState()).resolves.toBe('initial-state');
    expect(provider.currentState).toEqual(
      expect.objectContaining({
        type: 'oauth',
        tokens: initialTokens,
        clientInformation: initialClientInformation,
      })
    );

    const rotatedClientInformation = {
      client_id: 'rotated-client',
      client_secret: 'rotated-client-secret',
    };
    await provider.saveClientInformation(rotatedClientInformation);

    expect(mockUpsertConnection).toHaveBeenLastCalledWith({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-github-user',
      scope: 'global',
      slug: 'sample-oauth',
      state: expect.objectContaining({
        type: 'oauth',
        tokens: initialTokens,
        clientInformation: rotatedClientInformation,
        codeVerifier: 'initial-verifier',
        oauthState: 'initial-state',
      }),
      definitionFingerprint: 'sample-definition-fingerprint',
      discoveredTools,
      validationError: 'previous validation failure',
      validatedAt: '2026-05-01T00:00:00.000Z',
      preservePendingFlowState: false,
    });
    await expect(provider.clientInformation()).resolves.toEqual(rotatedClientInformation);

    const rotatedTokens = { access_token: 'rotated-access-token', token_type: 'bearer' } as const;
    await provider.saveTokens(rotatedTokens);

    await expect(provider.tokens()).resolves.toEqual(rotatedTokens);
    expect(mockUpsertConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ tokens: rotatedTokens }),
        validationError: null,
      })
    );
  });

  it('generates deterministic-width OAuth state with an optional flow prefix without persisting it', async () => {
    const unprefixed = makeProvider({ interactive: false });
    const prefixed = new PersistentOAuthClientProvider({
      userId: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      definitionFingerprint: 'sample-definition-fingerprint',
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
      },
      redirectUrl: 'https://app.example.com/oauth/callback',
      statePrefix: 'flow-123',
      interactive: true,
    });

    await expect(unprefixed.state()).resolves.toMatch(/^[0-9a-f]{32}$/);
    await expect(prefixed.state()).resolves.toMatch(/^flow-123\.[0-9a-f]{32}$/);
    expect(mockUpsertConnection).not.toHaveBeenCalled();
  });

  it('rejects stale public credentials for a hosted callback and accepts confidential credentials', () => {
    const redirectUrl = 'https://app.example.com/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback';

    expect(
      isMcpOAuthClientAuthenticationCompatible(
        {
          client_id: 'stale-public-client',
        },
        redirectUrl
      )
    ).toBe(false);
    expect(
      isMcpOAuthClientAuthenticationCompatible(
        {
          client_id: 'confidential-client',
          client_secret: 'client-secret',
        },
        redirectUrl
      )
    ).toBe(true);
  });

  it('does not persist pending verifier/state from non-interactive flows', async () => {
    const runtime = makeProvider({ interactive: false });
    await runtime.saveCodeVerifier('runtime-verifier');
    await runtime.saveState('runtime-state');
    await expect(runtime.codeVerifier()).resolves.toBe('runtime-verifier');
    await expect(runtime.storedState()).resolves.toBe('runtime-state');
    expect(mockUpsertConnection).not.toHaveBeenCalled();

    const interactive = makeProvider({ interactive: true });
    await interactive.saveCodeVerifier('interactive-verifier');
    await interactive.saveState('interactive-state');
    expect(mockUpsertConnection).toHaveBeenCalledTimes(2);
    expect(mockUpsertConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          codeVerifier: 'interactive-verifier',
          oauthState: 'interactive-state',
        }),
        preservePendingFlowState: false,
      })
    );
    await expect(interactive.storedState()).resolves.toBe('interactive-state');
  });

  it('marks every non-interactive persist as read-only for pending-flow state', async () => {
    const runtime = makeProvider({ interactive: false });

    await runtime.saveClientInformation({ client_id: 'runtime-client' });
    expect(mockUpsertConnection).toHaveBeenLastCalledWith(expect.objectContaining({ preservePendingFlowState: true }));

    await runtime.saveTokens({ access_token: 'rotated-access-token', token_type: 'bearer' });
    expect(mockUpsertConnection).toHaveBeenLastCalledWith(expect.objectContaining({ preservePendingFlowState: true }));

    await runtime.invalidateCredentials('tokens');
    expect(mockUpsertConnection).toHaveBeenLastCalledWith(expect.objectContaining({ preservePendingFlowState: true }));
  });

  it('preserves the stored validation error until tokens are saved', async () => {
    const provider = makeProvider({ interactive: true, validationError: 'previous failure' });

    await provider.saveState('pending-state');
    expect(mockUpsertConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ validationError: 'previous failure' })
    );

    await provider.saveTokens({ access_token: 'sample-access-token', token_type: 'bearer' });
    expect(mockUpsertConnection).toHaveBeenLastCalledWith(expect.objectContaining({ validationError: null }));
  });

  it('propagates persistence failures from credential updates', async () => {
    const persistenceError = new Error('connection persistence failed');
    mockUpsertConnection.mockRejectedValueOnce(persistenceError);
    const provider = makeProvider({ interactive: true, validationError: 'previous failure' });

    await expect(provider.saveTokens({ access_token: 'sample-access-token', token_type: 'bearer' })).rejects.toBe(
      persistenceError
    );

    expect(mockUpsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          tokens: { access_token: 'sample-access-token', token_type: 'bearer' },
        }),
        validationError: null,
        preservePendingFlowState: false,
      })
    );
  });

  it.each(['all', 'client', 'tokens', 'verifier'] as const)(
    'applies the %s credential invalidation contract and persists its validation state',
    async (scope) => {
      const clientInformation = { client_id: 'sample-client', client_secret: 'sample-secret' };
      const tokens = { access_token: 'sample-access-token', token_type: 'bearer' } as const;
      const discoveredTools = [{ name: 'readSample', inputSchema: {} }];
      const provider = new PersistentOAuthClientProvider({
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        scope: 'global',
        slug: 'sample-oauth',
        definitionFingerprint: 'sample-definition-fingerprint',
        authConfig: {
          mode: 'oauth',
          provider: 'generic-oauth2.1',
        },
        redirectUrl: 'https://app.example.com/oauth/callback',
        initialState: {
          type: 'oauth',
          clientInformation,
          tokens,
          codeVerifier: 'sample-verifier',
          oauthState: 'sample-state',
        },
        discoveredTools,
        validatedAt: '2026-05-01T00:00:00.000Z',
        validationError: 'previous validation failure',
        interactive: false,
      });

      await provider.invalidateCredentials(scope);

      const expectedState = {
        all: { type: 'oauth' },
        client: {
          type: 'oauth',
          clientInformation: undefined,
          tokens: undefined,
          codeVerifier: undefined,
          oauthState: undefined,
        },
        tokens: {
          type: 'oauth',
          clientInformation,
          tokens: undefined,
          codeVerifier: undefined,
          oauthState: undefined,
        },
        verifier: {
          type: 'oauth',
          clientInformation,
          tokens,
          codeVerifier: undefined,
          oauthState: undefined,
        },
      }[scope];
      const preservesValidation = scope === 'verifier';

      expect(provider.currentState).toEqual(expectedState);
      expect(mockUpsertConnection).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: expectedState,
          discoveredTools: preservesValidation ? discoveredTools : [],
          validatedAt: preservesValidation ? '2026-05-01T00:00:00.000Z' : null,
          validationError: preservesValidation ? 'previous validation failure' : OAUTH_RECONNECT_REQUIRED_MESSAGE,
        })
      );
    }
  );

  it('refuses to hand out a missing PKCE code verifier instead of returning an empty string', async () => {
    const provider = new PersistentOAuthClientProvider({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      definitionFingerprint: 'sample-definition-fingerprint',
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
      },
      redirectUrl: 'https://app.example.com/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback',
      initialState: { type: 'oauth' },
      interactive: false,
    });

    await expect(provider.codeVerifier()).rejects.toThrow(OAuthAuthorizationRequiredError);

    const withVerifier = new PersistentOAuthClientProvider({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      definitionFingerprint: 'sample-definition-fingerprint',
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
      },
      redirectUrl: 'https://app.example.com/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback',
      initialState: { type: 'oauth', codeVerifier: 'sample-code-verifier' },
      interactive: false,
    });

    await expect(withVerifier.codeVerifier()).resolves.toBe('sample-code-verifier');
  });

  it('captures an interactive authorization URL without persisting credential state', async () => {
    const provider = makeProvider({ interactive: true });
    const authorizationUrl = new URL('https://auth.example.com/authorize?client_id=sample-client');

    await expect(provider.redirectToAuthorization(authorizationUrl)).resolves.toBeUndefined();

    expect(provider.authorizationUrl).toBe(authorizationUrl);
    expect(mockUpsertConnection).not.toHaveBeenCalled();
  });

  it('tells non-interactive callers to reconnect when OAuth authorization is required', async () => {
    const provider = new PersistentOAuthClientProvider({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      definitionFingerprint: 'sample-definition-fingerprint',
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
      },
      redirectUrl: 'https://app.example.com/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback',
      interactive: false,
    });

    const authorizationUrl = new URL('https://auth.example.com/authorize');
    await expect(provider.redirectToAuthorization(authorizationUrl)).rejects.toThrow(OAuthAuthorizationRequiredError);
    await expect(provider.redirectToAuthorization(authorizationUrl)).rejects.toThrow(
      'MCP OAuth connection expired or needs authorization. Reconnect this MCP connection to continue.'
    );
    expect(provider.authorizationUrl).toBe(authorizationUrl);
    expect(mockUpsertConnection).not.toHaveBeenCalled();
  });

  it('requires protected-resource metadata to identify the exact configured MCP URL', async () => {
    const provider = makeProvider({ interactive: true });
    const serverUrl = 'https://mcp.example.com/tenant/mcp';

    await expect(provider.validateResourceURL(serverUrl, serverUrl)).resolves.toEqual(new URL(serverUrl));
    await expect(provider.validateResourceURL(serverUrl)).rejects.toThrow(
      'MCP protected-resource metadata did not identify its resource.'
    );
    await expect(provider.validateResourceURL(serverUrl, 'https://attacker.example/mcp')).rejects.toThrow(
      'but the configured MCP URL is'
    );
    await expect(provider.validateResourceURL(serverUrl, 'https://mcp.example.com/')).rejects.toThrow(
      'but the configured MCP URL is'
    );
    await expect(provider.validateResourceURL(serverUrl, 'https://mcp.example.com/tenant/other')).rejects.toThrow(
      'but the configured MCP URL is'
    );
    await expect(provider.validateResourceURL(serverUrl, `${serverUrl}/`)).rejects.toThrow(
      'but the configured MCP URL is'
    );
  });

  it('rejects resource identifiers with credentials, queries, or fragments', async () => {
    const provider = makeProvider({ interactive: true });

    await expect(
      provider.validateResourceURL('https://mcp.example.com/mcp', 'https://user@mcp.example.com/mcp')
    ).rejects.toThrow('must not include credentials, a query, or a fragment');
    await expect(
      provider.validateResourceURL('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp?tenant=other')
    ).rejects.toThrow('must not include credentials, a query, or a fragment');
    await expect(
      provider.validateResourceURL('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp#fragment')
    ).rejects.toThrow('must not include credentials, a query, or a fragment');
  });

  it.each([
    'https://user:password@mcp.example.com/mcp',
    'https://mcp.example.com/mcp?tenant=sample',
    'https://mcp.example.com/mcp#fragment',
  ])('rejects unsafe configured MCP resource identifiers before authorization: %s', async (serverUrl) => {
    const provider = makeProvider({ interactive: true });

    await expect(provider.validateResourceURL(serverUrl, 'https://mcp.example.com/mcp')).rejects.toThrow(
      'configured MCP URL must not include credentials, a query, or a fragment.'
    );

    expect(mockUpsertConnection).not.toHaveBeenCalled();
  });
});
