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

  it('consumes a flow only once', async () => {
    const storedRecord = {
      flowId: 'flow-123',
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      slug: 'sample-oauth',
      scope: 'global',
      definitionFingerprint: 'sample-definition-fingerprint',
      appOrigin: 'https://app.example.com',
      createdAt: '2026-04-08T00:00:00.000Z',
    };
    redis.eval.mockResolvedValueOnce(JSON.stringify(storedRecord)).mockResolvedValueOnce(null);

    expect(await McpOAuthFlowService.consume('flow-123', redis as any)).toEqual(storedRecord);
    expect(await McpOAuthFlowService.consume('flow-123', redis as any)).toBeNull();
  });

  it('invalidates a flow key', async () => {
    await McpOAuthFlowService.invalidate('flow-123', redis as any);

    expect(redis.del).toHaveBeenCalledWith('lifecycle:agent:mcp-oauth-flow:flow-123');
  });

  it('encodes and decodes flow ids in oauth state values', () => {
    const oauthState = buildMcpOAuthState('flow-123');

    expect(oauthState).toMatch(/^flow-123\./);
    expect(extractMcpOAuthFlowId(oauthState)).toBe('flow-123');
    expect(extractMcpOAuthFlowId('legacy-state')).toBeNull();
  });
});
