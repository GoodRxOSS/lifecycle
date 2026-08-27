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
import { decrypt, encrypt } from 'server/lib/encryption';

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

  it('preserves a pending interactive flow when a non-interactive writer invalidates credentials', async () => {
    mockQuery.first.mockResolvedValue({
      id: 7,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      encryptedState:
        'enc:{"type":"oauth","tokens":{"access_token":"old-access"},"clientInformation":{"client_id":"interactive-client"},"codeVerifier":"interactive-verifier","oauthState":"interactive-state"}',
      definitionFingerprint: 'fingerprint-oauth',
    });

    // Simulates invalidateCredentials('tokens') from an agent-run provider: tokens cleared in memory.
    await UserMcpConnectionService.upsertConnection({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      state: { type: 'oauth', clientInformation: { client_id: 'interactive-client' } },
      definitionFingerprint: 'fingerprint-oauth',
      discoveredTools: [],
      validationError: 'reconnect required',
      validatedAt: null,
      preservePendingFlowState: true,
    });

    expect(JSON.parse((encrypt as jest.Mock).mock.calls[0][0])).toEqual({
      type: 'oauth',
      clientInformation: { client_id: 'interactive-client' },
      codeVerifier: 'interactive-verifier',
      oauthState: 'interactive-state',
    });
    expect(mockQuery.patch).toHaveBeenCalledWith(expect.objectContaining({ validationError: 'reconnect required' }));
  });

  it('preserves the interactive client and pending state over a non-interactive dynamic registration', async () => {
    mockQuery.first.mockResolvedValue({
      id: 7,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      encryptedState:
        'enc:{"type":"oauth","clientInformation":{"client_id":"interactive-client"},"codeVerifier":"interactive-verifier","oauthState":"interactive-state"}',
      definitionFingerprint: 'fingerprint-oauth',
    });

    // Simulates the SDK's saveClientInformation fallback during a non-interactive auth() attempt.
    await UserMcpConnectionService.upsertConnection({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      state: {
        type: 'oauth',
        clientInformation: { client_id: 'runtime-client' },
        codeVerifier: 'runtime-verifier',
        oauthState: 'runtime-state',
      },
      definitionFingerprint: 'fingerprint-oauth',
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      preservePendingFlowState: true,
    });

    expect(JSON.parse((encrypt as jest.Mock).mock.calls[0][0])).toEqual({
      type: 'oauth',
      clientInformation: { client_id: 'interactive-client' },
      codeVerifier: 'interactive-verifier',
      oauthState: 'interactive-state',
    });
  });

  it('lets a non-interactive writer replace the client when no flow is pending', async () => {
    mockQuery.first.mockResolvedValue({
      id: 7,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      encryptedState:
        'enc:{"type":"oauth","tokens":{"access_token":"old-access"},"clientInformation":{"client_id":"rejected-client"}}',
      definitionFingerprint: 'fingerprint-oauth',
    });

    // Simulates the SDK healing an invalid_client: invalidate('all') then fresh dynamic registration.
    await UserMcpConnectionService.upsertConnection({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      state: { type: 'oauth', clientInformation: { client_id: 'fresh-client' } },
      definitionFingerprint: 'fingerprint-oauth',
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      preservePendingFlowState: true,
    });

    expect(JSON.parse((encrypt as jest.Mock).mock.calls[0][0])).toEqual({
      type: 'oauth',
      clientInformation: { client_id: 'fresh-client' },
    });
  });

  it('replaces the stored state wholesale when preservePendingFlowState is not set', async () => {
    mockQuery.first.mockResolvedValue({
      id: 7,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      encryptedState: 'enc:{"type":"oauth","codeVerifier":"interactive-verifier","oauthState":"interactive-state"}',
      definitionFingerprint: 'fingerprint-oauth',
    });

    await UserMcpConnectionService.upsertConnection({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      state: { type: 'oauth', tokens: { access_token: 'fresh-access', token_type: 'bearer' } },
      definitionFingerprint: 'fingerprint-oauth',
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
    });

    expect(JSON.parse((encrypt as jest.Mock).mock.calls[0][0])).toEqual({
      type: 'oauth',
      tokens: { access_token: 'fresh-access', token_type: 'bearer' },
    });
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

  it('treats an undecryptable record as unconfigured with a reconnect message instead of throwing', async () => {
    (decrypt as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });
    mockQuery.first.mockResolvedValue({
      id: 1,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-connector',
      encryptedState: 'enc-with-rotated-key',
      definitionFingerprint: 'fingerprint-1',
      discoveredTools: [{ name: 'inspectItem', inputSchema: {} }],
      validationError: null,
      validatedAt: '2026-04-06T18:00:00.000Z',
      updatedAt: '2026-04-06T18:01:00.000Z',
    });

    const result = await UserMcpConnectionService.getMaskedState(
      'sample-user',
      'global',
      'sample-connector',
      'sample-user',
      'fingerprint-1'
    );

    expect(result.configured).toBe(false);
    expect(result.configuredFieldKeys).toEqual([]);
    expect(result.validationError).toBe(
      'Stored connection could not be read (the encryption key may have changed). Reconnect this MCP.'
    );
  });

  it('returns a null decrypted state for an undecryptable record so runtime resolution drops it', async () => {
    (decrypt as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });
    mockQuery.first.mockResolvedValue({
      id: 1,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      encryptedState: 'enc-with-rotated-key',
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

    expect(result?.state).toBeNull();
    expect(result?.validationError).toBe(
      'Stored connection could not be read (the encryption key may have changed). Reconnect this MCP.'
    );
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

  it('returns the requested empty-state auth mode when no connection exists', async () => {
    await expect(
      UserMcpConnectionService.getMaskedState('sample-user', 'global', 'missing', 'sample-user', undefined, 'oauth')
    ).resolves.toEqual({
      slug: 'missing',
      scope: 'global',
      authMode: 'oauth',
      configured: false,
      stale: false,
      configuredFieldKeys: [],
      validatedAt: null,
      validationError: null,
      discoveredTools: [],
      updatedAt: null,
    });
    await expect(
      UserMcpConnectionService.getDecryptedConnection('sample-user', 'global', 'missing', 'sample-user')
    ).resolves.toBeNull();
  });

  it('reconciles an owner-key match to the current user identity', async () => {
    const record = {
      id: 9,
      userId: 'old-user-id',
      ownerGithubUsername: 'ExampleUser',
      scope: 'global',
      slug: 'sample-oauth',
      encryptedState: 'enc:{"type":"oauth","tokens":{"refresh_token":"refresh"}}',
      definitionFingerprint: 'fingerprint-oauth',
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    };
    mockQuery.first.mockResolvedValue(record);

    const result = await UserMcpConnectionService.getMaskedState(
      'current-user-id',
      'global',
      'sample-oauth',
      ' ExampleUser '
    );

    expect(mockQuery.patch).toHaveBeenCalledWith({
      userId: 'current-user-id',
      ownerGithubUsername: 'ExampleUser',
    });
    expect(record.userId).toBe('current-user-id');
    expect(result).toMatchObject({ authMode: 'oauth', configured: true, stale: false });
  });

  it('falls back to the user key and migrates ownership when the canonical owner has no row', async () => {
    const fallback = {
      id: 10,
      userId: 'user-id',
      ownerGithubUsername: 'user-id',
      scope: 'global',
      slug: 'sample-fields',
      encryptedState: 'enc:{"type":"fields","values":{"token":"value"}}',
      definitionFingerprint: 'fingerprint-fields',
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    };
    mockQuery.first.mockResolvedValueOnce(null).mockResolvedValueOnce(fallback);

    const result = await UserMcpConnectionService.getDecryptedConnection(
      'user-id',
      'global',
      'sample-fields',
      'github-user'
    );

    expect(result?.state).toEqual({ type: 'fields', values: { token: 'value' } });
    expect(mockQuery.patch).toHaveBeenCalledWith({ userId: 'user-id', ownerGithubUsername: 'github-user' });
  });

  it('returns no connection when neither canonical owner nor user fallback has a row', async () => {
    mockQuery.first.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await expect(
      UserMcpConnectionService.getDecryptedConnection('user-id', 'global', 'missing', 'github-user')
    ).resolves.toBeNull();
  });

  it('preserves an incoming fields state when pending-flow protection is irrelevant', async () => {
    mockQuery.first.mockResolvedValue({
      id: 7,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      encryptedState: 'enc:{"type":"oauth","oauthState":"pending"}',
    });

    await UserMcpConnectionService.upsertConnection({
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-fields',
      state: { type: 'fields', values: { apiToken: 'fresh-token' } },
      definitionFingerprint: 'fingerprint-fields',
      discoveredTools: [],
      validatedAt: null,
      preservePendingFlowState: true,
    });

    expect(JSON.parse((encrypt as jest.Mock).mock.calls[0][0])).toEqual({
      type: 'fields',
      values: { apiToken: 'fresh-token' },
    });
  });

  it('treats unknown stored state types as unreadable and non-stale without a current fingerprint', async () => {
    mockQuery.first.mockResolvedValue({
      id: 1,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'unknown-state',
      encryptedState: 'enc:{"type":"unknown"}',
      definitionFingerprint: 'fingerprint-1',
      discoveredTools: [],
      validationError: null,
      validatedAt: 123,
      updatedAt: null,
    });

    const result = await UserMcpConnectionService.getMaskedState(
      'sample-user',
      'global',
      'unknown-state',
      'sample-user'
    );

    expect(result).toMatchObject({ authMode: 'none', configured: false, stale: false, validatedAt: null });
    expect(result.validationError).toContain('Stored connection could not be read');
  });

  it('treats structurally invalid decrypted JSON as unreadable state', async () => {
    mockQuery.first.mockResolvedValue({
      id: 1,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'invalid-state',
      encryptedState: 'enc:null',
      definitionFingerprint: 'fingerprint-1',
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    });

    const result = await UserMcpConnectionService.getDecryptedConnection(
      'sample-user',
      'global',
      'invalid-state',
      'sample-user'
    );

    expect(result?.state).toBeNull();
    expect(result?.validationError).toContain('Stored connection could not be read');
  });

  it('lists masked states once per unique non-empty scope', async () => {
    const records = [
      {
        id: 1,
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        scope: 'global',
        slug: 'sample-fields',
        encryptedState: 'enc:{"type":"fields","values":{"token":"value"}}',
        definitionFingerprint: 'fingerprint-fields',
        discoveredTools: [{ name: 'inspect', inputSchema: {} }],
        validationError: null,
        validatedAt: null,
        updatedAt: null,
      },
    ];
    mockQuery.whereIn.mockResolvedValue(records);

    const result = await UserMcpConnectionService.listMaskedStatesByScopes(
      'sample-user',
      ['global', '', 'global'],
      'sample-user'
    );

    expect(mockQuery.whereIn).toHaveBeenCalledWith('scope', ['global']);
    expect(result.get('global:sample-fields')).toMatchObject({
      configured: true,
      discoveredTools: records[0].discoveredTools,
    });
  });

  it('falls back to user-owned rows when bulk masked lookup has no canonical-owner matches', async () => {
    const fallback = {
      id: 2,
      userId: 'user-id',
      ownerGithubUsername: 'user-id',
      scope: 'global',
      slug: 'sample-fields',
      encryptedState: 'enc:{"type":"fields","values":{"token":"value"}}',
      definitionFingerprint: 'fingerprint-fields',
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    };
    mockQuery.whereIn.mockResolvedValueOnce([]).mockResolvedValueOnce([fallback]);

    const result = await UserMcpConnectionService.listMaskedStatesByScopes('user-id', ['global'], 'github-user');

    expect(mockQuery.patch).toHaveBeenCalledWith({ userId: 'user-id', ownerGithubUsername: 'github-user' });
    expect(result.has('global:sample-fields')).toBe(true);
  });

  it('lists decrypted connections and applies definition fingerprint staleness', async () => {
    const record = {
      id: 3,
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      scope: 'global',
      slug: 'sample-oauth',
      encryptedState: 'enc:{"type":"oauth","tokens":{"access_token":"access"}}',
      definitionFingerprint: 'old-fingerprint',
      discoveredTools: [{ name: 'inspect', inputSchema: {} }],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    };
    mockQuery.whereIn.mockResolvedValue([record]);

    const result = await UserMcpConnectionService.listDecryptedConnectionsByScopes(
      'sample-user',
      ['global'],
      'sample-user',
      new Map([['global:sample-oauth', 'new-fingerprint']])
    );

    expect(result.get('global:sample-oauth')).toMatchObject({ state: null, stale: true, discoveredTools: [] });
  });

  it('falls back to user-owned rows during bulk decrypted lookup and reconciles ownership', async () => {
    const fallback = {
      id: 5,
      userId: 'user-id',
      ownerGithubUsername: 'user-id',
      scope: 'global',
      slug: 'sample-oauth',
      encryptedState: 'enc:{"type":"oauth","tokens":{"access_token":"access"}}',
      definitionFingerprint: 'fingerprint-oauth',
      discoveredTools: [],
      validationError: null,
      validatedAt: null,
      updatedAt: null,
    };
    mockQuery.whereIn.mockResolvedValueOnce([]).mockResolvedValueOnce([fallback]);

    const result = await UserMcpConnectionService.listDecryptedConnectionsByScopes(
      'user-id',
      ['global'],
      'github-user'
    );

    expect(mockQuery.patch).toHaveBeenCalledWith({ userId: 'user-id', ownerGithubUsername: 'github-user' });
    expect(result.get('global:sample-oauth')?.state).toMatchObject({ type: 'oauth' });
  });

  it.each([
    ['returns false when no connection exists', null, 1, false],
    ['returns false when deletion affects no row', { id: 4 }, 0, false],
    ['returns true when deletion removes the row', { id: 4 }, 1, true],
  ])('%s', async (_label, record, deletedCount, expected) => {
    mockQuery.first.mockResolvedValue(record);
    mockQuery.delete.mockResolvedValue(deletedCount);

    await expect(
      UserMcpConnectionService.deleteConnection('sample-user', 'global', 'sample', 'sample-user')
    ).resolves.toBe(expected);
  });

  it('lists masked users without exposing state values and marks stale definitions', async () => {
    mockQuery.orderBy.mockResolvedValue([
      {
        userId: 'user-1',
        ownerGithubUsername: '',
        scope: 'global',
        slug: 'sample-server',
        encryptedState: 'enc:{"type":"fields","values":{"secret":"value"}}',
        definitionFingerprint: 'current-fingerprint',
        discoveredTools: [{ name: 'inspect', inputSchema: {} }],
        validationError: null,
        validatedAt: '2026-04-06T18:00:00.000Z',
        updatedAt: '2026-04-06T18:01:00.000Z',
      },
      {
        userId: 'user-2',
        ownerGithubUsername: 'github-user-2',
        scope: 'global',
        slug: 'sample-server',
        encryptedState: 'enc:{"type":"oauth","tokens":{"refresh_token":"refresh"}}',
        definitionFingerprint: 'old-fingerprint',
        discoveredTools: [{ name: 'write', inputSchema: {} }],
        validationError: 'Reconnect required',
        validatedAt: null,
        updatedAt: null,
      },
    ]);

    const result = await UserMcpConnectionService.listMaskedUsersForServer(
      'global',
      'sample-server',
      'current-fingerprint'
    );

    expect(result).toEqual([
      {
        userId: 'user-1',
        ownerGithubUsername: null,
        authMode: 'fields',
        stale: false,
        configuredFieldKeys: ['secret'],
        discoveredToolCount: 1,
        validationError: null,
        validatedAt: '2026-04-06T18:00:00.000Z',
        updatedAt: '2026-04-06T18:01:00.000Z',
      },
      {
        userId: 'user-2',
        ownerGithubUsername: 'github-user-2',
        authMode: 'oauth',
        stale: true,
        configuredFieldKeys: [],
        discoveredToolCount: 0,
        validationError: 'Reconnect required',
        validatedAt: null,
        updatedAt: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('value');
    expect(JSON.stringify(result)).not.toContain('refresh');
  });
});
