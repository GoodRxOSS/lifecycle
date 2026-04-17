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

import { PersistentOAuthClientProvider } from '../oauthProvider';

describe('PersistentOAuthClientProvider', () => {
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
});
