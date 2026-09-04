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

import McpOAuthFlowService, { buildMcpOAuthState, extractMcpOAuthFlowId } from '../oauthFlow';

describe('McpOAuthFlowService', () => {
  const redis = {
    del: jest.fn(),
    eval: jest.fn(),
    get: jest.fn(),
    setex: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    redis.setex.mockResolvedValue('OK');
    redis.get.mockResolvedValue(null);
    redis.eval.mockResolvedValue(null);
    redis.del.mockResolvedValue(1);
  });

  function storedRecord(overrides: Record<string, unknown> = {}) {
    return {
      flowId: 'flow-123',
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      slug: 'sample-oauth',
      scope: 'global',
      definitionFingerprint: 'sample-definition-fingerprint',
      appOrigin: 'https://app.example.com',
      createdAt: '2026-04-08T00:00:00.000Z',
      ...overrides,
    };
  }

  it('creates a short-lived flow record in redis', async () => {
    const record = await McpOAuthFlowService.create(
      {
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        slug: 'sample-oauth',
        scope: 'global',
        definitionFingerprint: 'sample-definition-fingerprint',
        appOrigin: 'https://app.example.com',
      },
      redis as any
    );

    expect(record).toEqual(
      expect.objectContaining({
        userId: 'sample-user',
        ownerGithubUsername: 'sample-user',
        slug: 'sample-oauth',
        scope: 'global',
        definitionFingerprint: 'sample-definition-fingerprint',
        appOrigin: 'https://app.example.com',
      })
    );
    expect(record.flowId).toBeTruthy();
    expect(redis.setex).toHaveBeenCalledWith(expect.stringContaining(record.flowId), 600, expect.any(String));
  });

  it('defaults optional identity and origin fields to null in the persisted record', async () => {
    const record = await McpOAuthFlowService.create(
      {
        userId: 'sample-user',
        ownerGithubUsername: null,
        slug: 'sample-oauth',
        scope: 'global',
        definitionFingerprint: 'sample-definition-fingerprint',
        appOrigin: null,
      },
      redis as any
    );

    expect(record).toEqual(expect.objectContaining({ ownerGithubUsername: null, appOrigin: null }));
    expect(JSON.parse(redis.setex.mock.calls[0][2])).toEqual(record);
  });

  it('propagates persistence failures instead of returning an unrecorded flow', async () => {
    const error = new Error('redis unavailable');
    redis.setex.mockRejectedValue(error);

    await expect(
      McpOAuthFlowService.create(
        {
          userId: 'sample-user',
          ownerGithubUsername: null,
          slug: 'sample-oauth',
          scope: 'global',
          definitionFingerprint: 'sample-definition-fingerprint',
          appOrigin: null,
        },
        redis as any
      )
    ).rejects.toBe(error);
  });

  it('gets a flow by its trimmed id and normalizes stored strings', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify(
        storedRecord({
          flowId: ' flow-123 ',
          userId: ' sample-user ',
          ownerGithubUsername: '   ',
          slug: ' sample-oauth ',
          scope: ' global ',
          definitionFingerprint: ' fingerprint ',
          appOrigin: '   ',
          createdAt: ' 2026-04-08T00:00:00.000Z ',
        })
      )
    );

    await expect(McpOAuthFlowService.get(' flow-123 ', redis as any)).resolves.toEqual({
      flowId: 'flow-123',
      userId: 'sample-user',
      ownerGithubUsername: null,
      slug: 'sample-oauth',
      scope: 'global',
      definitionFingerprint: 'fingerprint',
      appOrigin: null,
      createdAt: '2026-04-08T00:00:00.000Z',
    });
    expect(redis.get).toHaveBeenCalledWith('lifecycle:agent:mcp-oauth-flow:flow-123');
  });

  it('does not query redis for an empty flow id', async () => {
    await expect(McpOAuthFlowService.get('   ', redis as any)).resolves.toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-string redis response', 42],
    ['invalid JSON', '{not-json'],
    ['a non-object JSON value', 'null'],
    ['a record missing required fields', JSON.stringify({ flowId: 'flow-123' })],
  ])('treats %s as a missing flow', async (_label, raw) => {
    redis.get.mockResolvedValue(raw);

    await expect(McpOAuthFlowService.get('flow-123', redis as any)).resolves.toBeNull();
  });

  it('consumes a flow only once', async () => {
    const record = storedRecord();
    redis.eval.mockResolvedValueOnce(JSON.stringify(record)).mockResolvedValueOnce(null);

    expect(await McpOAuthFlowService.consume('flow-123', redis as any)).toEqual(record);
    expect(await McpOAuthFlowService.consume('flow-123', redis as any)).toBeNull();
    expect(redis.eval).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("redis.call('del', KEYS[1])"),
      1,
      'lifecycle:agent:mcp-oauth-flow:flow-123'
    );
  });

  it('does not evaluate the consume script for an empty flow id', async () => {
    await expect(McpOAuthFlowService.consume('   ', redis as any)).resolves.toBeNull();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('invalidates a flow key', async () => {
    await McpOAuthFlowService.invalidate(' flow-123 ', redis as any);

    expect(redis.del).toHaveBeenCalledWith('lifecycle:agent:mcp-oauth-flow:flow-123');
  });

  it('does not delete a key for an empty flow id', async () => {
    await McpOAuthFlowService.invalidate('   ', redis as any);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('encodes and decodes flow ids in oauth state values', () => {
    const oauthState = buildMcpOAuthState('flow-123');

    expect(oauthState).toMatch(/^flow-123\./);
    expect(extractMcpOAuthFlowId(oauthState)).toBe('flow-123');
    expect(extractMcpOAuthFlowId('legacy-state')).toBeNull();
  });

  it('rejects an empty flow id when building state', () => {
    expect(() => buildMcpOAuthState('   ')).toThrow('Flow id is required to build an OAuth state token');
  });

  it.each([null, undefined, '   ', '.nonce'])('does not extract a flow id from invalid state %p', (state) => {
    expect(extractMcpOAuthFlowId(state)).toBeNull();
  });

  it('trims state before extracting the flow id', () => {
    expect(extractMcpOAuthFlowId('  flow-123.nonce  ')).toBe('flow-123');
  });
});
