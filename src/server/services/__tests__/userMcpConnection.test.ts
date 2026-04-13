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

jest.mock('server/models/UserMcpConnection');
jest.mock('server/lib/encryption', () => ({
  encrypt: jest.fn((value: string) => `enc:${value}`),
  decrypt: jest.fn((value: string) => value.replace(/^enc:/, '')),
}));

import UserMcpConnectionService from 'server/services/userMcpConnection';
import UserMcpConnection from 'server/models/UserMcpConnection';
import { encrypt } from 'server/lib/encryption';

const mockQuery: any = {
  where: jest.fn(),
  first: jest.fn(),
  insertAndFetch: jest.fn(),
  orderBy: jest.fn(),
  patch: jest.fn(),
  whereIn: jest.fn(),
  delete: jest.fn(),
};

describe('UserMcpConnectionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (UserMcpConnection.query as jest.Mock) = jest.fn().mockReturnValue(mockQuery);
    mockQuery.where.mockReturnValue(mockQuery);
    mockQuery.whereIn.mockReturnValue(mockQuery);
    mockQuery.first.mockResolvedValue(null);
    mockQuery.insertAndFetch.mockResolvedValue(undefined);
    mockQuery.orderBy.mockResolvedValue([]);
    mockQuery.patch.mockResolvedValue(undefined);
    mockQuery.delete.mockResolvedValue(1);
  });

  it('stores encrypted per-user connection values with a definition fingerprint', async () => {
    await UserMcpConnectionService.upsertConnection({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'example-org/example-repo',
      slug: 'sample-connector',
      state: {
        type: 'fields',
        values: { apiToken: 'sample-token', siteUrl: 'https://sample-site.example.com' },
      },
      definitionFingerprint: 'fingerprint-1',
      discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      validationError: null,
      validatedAt: '2026-04-06T18:00:00.000Z',
    });

    expect(encrypt).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'fields',
        values: { apiToken: 'sample-token', siteUrl: 'https://sample-site.example.com' },
      })
    );
    expect(mockQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        scope: 'example-org/example-repo',
        slug: 'sample-connector',
        definitionFingerprint: 'fingerprint-1',
      })
    );
  });

  it('returns masked connection state including discovered tools and stale=false when the fingerprint matches', async () => {
    mockQuery.first.mockResolvedValue({
      id: 1,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'example-org/example-repo',
      slug: 'sample-connector',
      encryptedState:
        'enc:{"type":"fields","values":{"apiToken":"sample-token","siteUrl":"https://sample-site.example.com"}}',
      definitionFingerprint: 'fingerprint-1',
      discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      validationError: null,
      validatedAt: '2026-04-06T18:00:00.000Z',
      updatedAt: '2026-04-06T18:01:00.000Z',
    });

    const result = await UserMcpConnectionService.getMaskedState(
      'sample-user',
      'example-org/example-repo',
      'sample-connector',
      'sample-user',
      'fingerprint-1'
    );

    expect(result).toEqual({
      slug: 'sample-connector',
      scope: 'example-org/example-repo',
      authMode: 'fields',
      configured: true,
      stale: false,
      configuredFieldKeys: ['apiToken', 'siteUrl'],
      validatedAt: '2026-04-06T18:00:00.000Z',
      validationError: null,
      discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      updatedAt: '2026-04-06T18:01:00.000Z',
    });
  });

  it('marks a connection stale when the shared definition fingerprint changes', async () => {
    mockQuery.first.mockResolvedValue({
      id: 1,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'example-org/example-repo',
      slug: 'sample-connector',
      encryptedState: 'enc:{"type":"fields","values":{"apiToken":"sample-token"}}',
      definitionFingerprint: 'fingerprint-old',
      discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      validationError: null,
      validatedAt: '2026-04-06T18:00:00.000Z',
      updatedAt: '2026-04-06T18:01:00.000Z',
    });

    const result = await UserMcpConnectionService.getMaskedState(
      'sample-user',
      'example-org/example-repo',
      'sample-connector',
      'sample-user',
      'fingerprint-new'
    );

    expect(result).toEqual({
      slug: 'sample-connector',
      scope: 'example-org/example-repo',
      authMode: 'fields',
      configured: false,
      stale: true,
      configuredFieldKeys: [],
      validatedAt: '2026-04-06T18:00:00.000Z',
      validationError: 'Connection needs to be refreshed because the shared MCP changed.',
      discoveredTools: [],
      updatedAt: '2026-04-06T18:01:00.000Z',
    });
  });

  it('preserves oauth client information and tokens when reading a stored connection', async () => {
    mockQuery.first.mockResolvedValue({
      id: 1,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      encryptedState:
        'enc:{"type":"oauth","tokens":{"access_token":"sample-access-token","token_type":"Bearer","refresh_token":"sample-refresh-token"},"clientInformation":{"client_id":"sample-client-id","client_secret":"sample-client-secret"},"codeVerifier":"sample-code-verifier","oauthState":"sample-oauth-state"}',
      definitionFingerprint: 'fingerprint-oauth',
      discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      validationError: null,
      validatedAt: '2026-04-06T18:00:00.000Z',
      updatedAt: '2026-04-06T18:01:00.000Z',
    });

    const result = await UserMcpConnectionService.getDecryptedConnection(
      'sample-user',
      'global',
      'sample-oauth',
      'sample-user',
      'fingerprint-oauth'
    );

    expect(result).toEqual({
      state: {
        type: 'oauth',
        tokens: {
          access_token: 'sample-access-token',
          token_type: 'Bearer',
          refresh_token: 'sample-refresh-token',
        },
        clientInformation: {
          client_id: 'sample-client-id',
          client_secret: 'sample-client-secret',
        },
        codeVerifier: 'sample-code-verifier',
        oauthState: 'sample-oauth-state',
      },
      definitionFingerprint: 'fingerprint-oauth',
      stale: false,
      discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      validationError: null,
      validatedAt: '2026-04-06T18:00:00.000Z',
      updatedAt: '2026-04-06T18:01:00.000Z',
    });
  });

  it('normalizes timestamp fields from Date objects to ISO strings', async () => {
    mockQuery.first.mockResolvedValue({
      id: 1,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      encryptedState: 'enc:{"type":"oauth","codeVerifier":"sample-code-verifier","oauthState":"sample-oauth-state"}',
      definitionFingerprint: 'fingerprint-oauth',
      discoveredTools: [],
      validationError: null,
      validatedAt: new Date('2026-04-06T18:00:00.000Z'),
      updatedAt: new Date('2026-04-06T18:01:00.000Z'),
    });

    const result = await UserMcpConnectionService.getDecryptedConnection(
      'sample-user',
      'global',
      'sample-oauth',
      'sample-user',
      'fingerprint-oauth'
    );

    expect(result?.validatedAt).toBe('2026-04-06T18:00:00.000Z');
    expect(result?.updatedAt).toBe('2026-04-06T18:01:00.000Z');
  });
});
