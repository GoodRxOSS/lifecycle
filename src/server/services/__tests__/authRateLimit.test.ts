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

jest.mock('server/lib/dependencies', () => {
  const evalMock = jest.fn();
  return { redisClient: { getRedis: () => ({ eval: evalMock }) }, __evalMock: evalMock };
});
jest.mock('server/services/globalConfig', () => {
  const getAllConfigs = jest.fn();
  return { __esModule: true, default: { getInstance: () => ({ getAllConfigs }) }, __getAllConfigs: getAllConfigs };
});
jest.mock('server/lib/logger', () => {
  const warn = jest.fn();
  return { getLogger: () => ({ warn, info: jest.fn(), error: jest.fn(), debug: jest.fn() }), __warn: warn };
});

import { checkApiKeyRateLimit, DEFAULT_RATE_LIMIT_PER_MINUTE } from '../authRateLimit';
import type { Principal } from 'server/lib/principal';

const mockEval = (jest.requireMock('server/lib/dependencies') as any).__evalMock as jest.Mock;
const mockGetAllConfigs = (jest.requireMock('server/services/globalConfig') as any).__getAllConfigs as jest.Mock;
const mockWarn = (jest.requireMock('server/lib/logger') as any).__warn as jest.Mock;

const keyPrincipal = (over: Partial<Principal> = {}): Principal => ({
  kind: 'personal_key',
  authMethod: 'api_key',
  userId: 'u-1',
  actor: 'u-1',
  roles: [],
  scopes: ['env:read'],
  tokenId: 1,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: null,
  ...over,
});

const sessionPrincipal = (): Principal => ({
  kind: 'user',
  authMethod: 'session',
  userId: 'u-1',
  actor: 'u-1',
  roles: ['user'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: null,
});

const bucketKeyOf = (call: number) => mockEval.mock.calls[call][2] as string;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllConfigs.mockResolvedValue({ api_keys: { rateLimitPerMinute: 5 } });
});

describe('checkApiKeyRateLimit', () => {
  it('allows a key under the configured limit', async () => {
    mockEval.mockResolvedValue(3);

    const result = await checkApiKeyRateLimit(keyPrincipal());

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it('allows the request that reaches the limit but denies the one past it, with a retry-after', async () => {
    mockEval.mockResolvedValueOnce(5);
    expect(await checkApiKeyRateLimit(keyPrincipal())).toEqual({ allowed: true, retryAfterSeconds: 0 });

    mockEval.mockResolvedValueOnce(6);
    const denied = await checkApiKeyRateLimit(keyPrincipal());
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('falls back to the default limit when config is absent or invalid', async () => {
    mockGetAllConfigs.mockResolvedValue({});
    mockEval.mockResolvedValue(DEFAULT_RATE_LIMIT_PER_MINUTE);
    expect((await checkApiKeyRateLimit(keyPrincipal())).allowed).toBe(true);

    mockEval.mockResolvedValue(DEFAULT_RATE_LIMIT_PER_MINUTE + 1);
    expect((await checkApiKeyRateLimit(keyPrincipal())).allowed).toBe(false);
  });

  it('aggregates by owner: two keys of the same user share one bucket', async () => {
    mockEval.mockResolvedValue(1);

    await checkApiKeyRateLimit(keyPrincipal({ tokenId: 1 }));
    await checkApiKeyRateLimit(keyPrincipal({ tokenId: 2 }));

    expect(bucketKeyOf(0)).toBe(bucketKeyOf(1));
    expect(bucketKeyOf(0)).toContain('u-1');
    expect(bucketKeyOf(0)).not.toContain('token:');
  });

  it('keys a service principal (no userId) on its token id', async () => {
    mockEval.mockResolvedValue(1);

    await checkApiKeyRateLimit(keyPrincipal({ kind: 'service_key', userId: null, tokenId: 42 }));

    expect(bucketKeyOf(0)).toContain('token:42');
  });

  it('never consults Redis for a session principal', async () => {
    const result = await checkApiKeyRateLimit(sessionPrincipal());

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(mockEval).not.toHaveBeenCalled();
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
  });

  it('fails open and warns when Redis errors', async () => {
    mockEval.mockRejectedValue(new Error('redis down'));

    const result = await checkApiKeyRateLimit(keyPrincipal());

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth.ratelimit.fail_open' }),
      expect.any(String)
    );
  });

  it('fails open and warns when Redis hangs past the timeout', async () => {
    mockEval.mockReturnValue(new Promise(() => {}));

    const result = await checkApiKeyRateLimit(keyPrincipal());

    expect(result.allowed).toBe(true);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('rolls the bucket over to a new window as the minute advances', async () => {
    mockEval.mockResolvedValue(1);
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(60_000);
    await checkApiKeyRateLimit(keyPrincipal());

    nowSpy.mockReturnValue(120_000);
    await checkApiKeyRateLimit(keyPrincipal());

    expect(bucketKeyOf(0)).not.toBe(bucketKeyOf(1));
    nowSpy.mockRestore();
  });
});
