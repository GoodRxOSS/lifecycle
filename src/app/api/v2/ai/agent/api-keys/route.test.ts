/**
 * Copyright 2025 GoodRx, Inc.
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

import { NextRequest } from 'next/server';

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
}));

jest.mock('server/services/userApiKey', () => ({
  __esModule: true,
  default: {
    getMaskedKey: jest.fn(),
    storeKey: jest.fn(),
    deleteKey: jest.fn(),
  },
}));

jest.mock('server/services/aiAgentConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getEffectiveConfig: jest.fn().mockResolvedValue({
        enabled: true,
        providers: [
          {
            name: 'anthropic',
            enabled: true,
            apiKeyEnvVar: 'ANTHROPIC_API_KEY',
            models: [],
          },
        ],
      }),
    })),
  },
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { GET, POST, DELETE } from './route';
import UserApiKeyService from 'server/services/userApiKey';

const mockGetMaskedKey = UserApiKeyService.getMaskedKey as jest.Mock;
const mockStoreKey = UserApiKeyService.storeKey as jest.Mock;
const mockDeleteKey = UserApiKeyService.deleteKey as jest.Mock;

function makeRequest(
  body?: unknown,
  userClaims?: Record<string, unknown>,
  searchParams?: Record<string, string>
): NextRequest {
  const headers = new Headers([['x-request-id', 'req-test']]);
  if (userClaims) {
    headers.set('x-user', Buffer.from(JSON.stringify(userClaims), 'utf8').toString('base64url'));
  }

  const nextUrl = new URL('http://localhost/api/v2/ai/agent/api-keys');
  for (const [key, value] of Object.entries(searchParams || {})) {
    nextUrl.searchParams.set(key, value);
  }

  return {
    headers,
    nextUrl,
    json: jest.fn().mockResolvedValue(body || {}),
  } as unknown as NextRequest;
}

describe('API /api/v2/ai/agent/api-keys', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;
  const originalLocalDevUserId = process.env.LOCAL_DEV_USER_ID;

  const restoreEnv = () => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }

    if (originalLocalDevUserId === undefined) {
      delete process.env.LOCAL_DEV_USER_ID;
    } else {
      process.env.LOCAL_DEV_USER_ID = originalLocalDevUserId;
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    restoreEnv();
  });

  afterAll(() => {
    restoreEnv();
  });

  describe('GET', () => {
    it('returns 401 when no user', async () => {
      process.env.ENABLE_AUTH = 'true';
      const res = await GET(makeRequest());
      expect(res.status).toBe(401);
    });

    it('returns hasKey false when no key exists', async () => {
      mockGetMaskedKey.mockResolvedValue(null);
      const res = await GET(makeRequest(undefined, { sub: 'user-1' }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.hasKey).toBe(false);
    });

    it('uses the local dev user when auth is disabled', async () => {
      process.env.ENABLE_AUTH = 'false';
      process.env.LOCAL_DEV_USER_ID = 'vm-local';
      mockGetMaskedKey.mockResolvedValue(null);

      const res = await GET(makeRequest());

      expect(res.status).toBe(200);
      expect(mockGetMaskedKey).toHaveBeenCalledWith('vm-local', 'anthropic', null);
    });

    it('returns masked key info when key exists', async () => {
      mockGetMaskedKey.mockResolvedValue({
        provider: 'anthropic',
        maskedKey: 'sk-ant...xyz9',
        updatedAt: '2026-01-01T00:00:00Z',
      });
      const res = await GET(makeRequest(undefined, { sub: 'user-1' }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.hasKey).toBe(true);
      expect(json.data.maskedKey).toBe('sk-ant...xyz9');
    });

    it('returns 400 when provider is invalid', async () => {
      const res = await GET(makeRequest(undefined, { sub: 'user-1' }, { provider: 'sample' }));
      expect(res.status).toBe(400);
    });
  });

  describe('POST', () => {
    it('returns 401 when no user', async () => {
      process.env.ENABLE_AUTH = 'true';
      const res = await POST(makeRequest({ apiKey: 'sk-test' }));
      expect(res.status).toBe(401);
    });

    it('returns 400 when apiKey is missing', async () => {
      const res = await POST(makeRequest({ provider: 'anthropic' }, { sub: 'user-1' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when provider is missing', async () => {
      const res = await POST(makeRequest({ apiKey: 'sk-test' }, { sub: 'user-1' }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toContain('provider must be one of');
    });

    it('returns 400 when Anthropic validation fails', async () => {
      mockFetch.mockResolvedValue({ status: 401 });
      const res = await POST(makeRequest({ provider: 'anthropic', apiKey: 'bad-key' }, { sub: 'user-1' }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toContain('Invalid API key');
    });

    it('stores key and returns 201 on success', async () => {
      mockFetch.mockResolvedValue({ status: 200 });
      mockStoreKey.mockResolvedValue(undefined);
      mockGetMaskedKey.mockResolvedValue({
        provider: 'anthropic',
        maskedKey: 'sample...abcd',
        updatedAt: '2026-01-01T00:00:00Z',
      });
      const res = await POST(makeRequest({ provider: 'anthropic', apiKey: 'sample-provider-key' }, { sub: 'user-1' }));
      expect(res.status).toBe(201);
      expect(mockStoreKey).toHaveBeenCalledWith('user-1', 'anthropic', 'sample-provider-key', null);
    });

    it('stores the key for the local dev user when auth is disabled', async () => {
      process.env.ENABLE_AUTH = 'false';
      process.env.LOCAL_DEV_USER_ID = 'vm-local';
      mockFetch.mockResolvedValue({ status: 200 });
      mockStoreKey.mockResolvedValue(undefined);
      mockGetMaskedKey.mockResolvedValue({
        provider: 'anthropic',
        maskedKey: 'sample...abcd',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const res = await POST(makeRequest({ provider: 'anthropic', apiKey: 'sample-provider-key' }));

      expect(res.status).toBe(201);
      expect(mockStoreKey).toHaveBeenCalledWith('vm-local', 'anthropic', 'sample-provider-key', null);
    });
  });

  describe('DELETE', () => {
    it('returns 401 when no user', async () => {
      process.env.ENABLE_AUTH = 'true';
      const res = await DELETE(makeRequest());
      expect(res.status).toBe(401);
    });

    it('returns 404 when no key exists', async () => {
      mockDeleteKey.mockResolvedValue(false);
      const res = await DELETE(makeRequest(undefined, { sub: 'user-1' }, { provider: 'anthropic' }));
      expect(res.status).toBe(404);
    });

    it('returns 400 when provider is missing', async () => {
      const res = await DELETE(makeRequest(undefined, { sub: 'user-1' }));
      expect(res.status).toBe(400);
    });

    it('returns 200 on successful deletion', async () => {
      mockDeleteKey.mockResolvedValue(true);
      const res = await DELETE(makeRequest(undefined, { sub: 'user-1' }, { provider: 'anthropic' }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.deleted).toBe(true);
    });
  });
});
