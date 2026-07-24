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
    mockUpsertConnection.mockClear();
  });

  it('includes a valid client URI in dynamic registration metadata', () => {
    const provider = new PersistentOAuthClientProvider({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      definitionFingerprint: 'sample-definition-fingerprint',
      authConfig: {
        mode: 'oauth',
        provider: 'generic-oauth2.1',
        scope: 'sample.read',
        clientName: 'Sample MCP',
      },
      redirectUrl: 'https://app.example.com/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback',
      interactive: false,
    });

    expect(provider.clientMetadata).toEqual({
      redirect_uris: ['https://app.example.com/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Sample MCP',
      client_uri: 'https://app.example.com',
      scope: 'sample.read',
    });
  });

  it('does not persist pending verifier/state from non-interactive flows', async () => {
    const runtime = makeProvider({ interactive: false });
    await runtime.saveCodeVerifier('runtime-verifier');
    await runtime.saveState('runtime-state');
    expect(mockUpsertConnection).not.toHaveBeenCalled();

    const interactive = makeProvider({ interactive: true });
    await interactive.saveCodeVerifier('interactive-verifier');
    await interactive.saveState('interactive-state');
    expect(mockUpsertConnection).toHaveBeenCalledTimes(2);
    expect(mockUpsertConnection).toHaveBeenLastCalledWith(expect.objectContaining({ preservePendingFlowState: false }));
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

  it('records a reconnect message when credentials are invalidated', async () => {
    const provider = makeProvider({ interactive: false });

    await provider.invalidateCredentials('tokens');
    expect(mockUpsertConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ validationError: OAUTH_RECONNECT_REQUIRED_MESSAGE })
    );

    mockUpsertConnection.mockClear();
    const verifierOnly = makeProvider({ interactive: false });
    await verifierOnly.invalidateCredentials('verifier');
    expect(mockUpsertConnection).toHaveBeenLastCalledWith(expect.objectContaining({ validationError: null }));
  });

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

    await expect(provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))).rejects.toThrow(
      OAuthAuthorizationRequiredError
    );
    await expect(provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))).rejects.toThrow(
      'MCP OAuth connection expired or needs authorization. Reconnect this MCP connection to continue.'
    );
  });
});
