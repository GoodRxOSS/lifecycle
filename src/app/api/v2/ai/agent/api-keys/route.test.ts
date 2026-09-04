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

const mockGetEffectiveConfig = jest.fn();

jest.mock('server/services/agentRuntime/config/agentRuntimeConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getEffectiveConfig: (...args: unknown[]) => mockGetEffectiveConfig(...args),
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
  searchParams?: Record<string, string>,
  jsonError?: unknown
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
    json:
      jsonError === undefined
        ? jest.fn().mockResolvedValue(body === undefined ? {} : body)
        : jest.fn().mockRejectedValue(jsonError),
  } as unknown as NextRequest;
}

describe('API /api/v2/ai/agent/api-keys', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;
  const originalLocalDevUserId = process.env.LOCAL_DEV_USER_ID;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

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

    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    restoreEnv();
    delete process.env.ANTHROPIC_API_KEY;
    mockGetEffectiveConfig.mockResolvedValue({
      enabled: true,
      providers: [
        {
          name: 'anthropic',
          enabled: true,
          apiKeyEnvVar: 'ANTHROPIC_API_KEY',
          models: [],
        },
      ],
    });
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
      const res = await GET(makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }));
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
      const res = await GET(makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.hasKey).toBe(true);
      expect(json.data.maskedKey).toBe('sk-ant...xyz9');
    });

    it('returns shared key status when the provider env key is configured', async () => {
      process.env.ANTHROPIC_API_KEY = 'shared-anthropic-key';
      mockGetMaskedKey.mockResolvedValue(null);

      const res = await GET(makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }));

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.hasKey).toBe(true);
      expect(json.data.maskedKey).toBeUndefined();
    });

    it('returns 400 when provider is invalid', async () => {
      const res = await GET(
        makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }, { provider: 'sample' })
      );
      expect(res.status).toBe(400);
    });

    it('normalizes a requested provider and returns only that provider state', async () => {
      mockGetMaskedKey.mockResolvedValue({
        provider: 'openai',
        maskedKey: 'sk-...abcd',
        updatedAt: null,
      });

      const res = await GET(
        makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }, { provider: ' OpenAI ' })
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(mockGetMaskedKey).toHaveBeenCalledWith('user-1', 'openai', null);
      expect(json.data.providers).toEqual([
        { provider: 'openai', hasKey: true, maskedKey: 'sk-...abcd', updatedAt: null },
      ]);
    });

    it('filters, normalizes, and de-duplicates enabled configured providers', async () => {
      mockGetEffectiveConfig.mockResolvedValueOnce({
        providers: [
          { name: ' OpenAI ', enabled: true },
          { name: 'openai' },
          { name: 'gemini', enabled: false },
          { name: 'unsupported', enabled: true },
          { name: 42, enabled: true },
        ],
      });
      mockGetMaskedKey.mockResolvedValue(null);

      const res = await GET(makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.providers).toEqual([{ provider: 'openai', hasKey: false }]);
      expect(mockGetMaskedKey).toHaveBeenCalledTimes(1);
    });

    it.each([
      { label: 'no provider list', config: {} },
      { label: 'no supported enabled providers', config: { providers: [{ name: 'sample', enabled: true }] } },
    ])('falls back to every stored provider when runtime config has $label', async ({ config }) => {
      mockGetEffectiveConfig.mockResolvedValueOnce(config);
      mockGetMaskedKey.mockResolvedValue(null);

      const res = await GET(makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.providers.map((state: { provider: string }) => state.provider)).toEqual([
        'anthropic',
        'openai',
        'gemini',
      ]);
    });

    it('falls back to every stored provider when runtime config lookup fails', async () => {
      mockGetEffectiveConfig.mockRejectedValueOnce(new Error('config unavailable'));
      mockGetMaskedKey.mockResolvedValue(null);

      const res = await GET(makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.providers).toHaveLength(3);
    });

    it('returns 500 when provider key-state lookup fails', async () => {
      mockGetMaskedKey.mockRejectedValueOnce(new Error('database unavailable'));

      const res = await GET(makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }));

      expect(res.status).toBe(500);
    });
  });

  describe('POST', () => {
    it('returns 401 when no user', async () => {
      process.env.ENABLE_AUTH = 'true';
      const res = await POST(makeRequest({ apiKey: 'sk-test' }));
      expect(res.status).toBe(401);
    });

    it('returns 400 when apiKey is missing', async () => {
      const res = await POST(
        makeRequest({ provider: 'anthropic' }, { sub: 'user-1', realm_access: { roles: ['user'] } })
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when provider is missing', async () => {
      const res = await POST(makeRequest({ apiKey: 'sk-test' }, { sub: 'user-1', realm_access: { roles: ['user'] } }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toContain('provider must be one of');
    });

    it('returns 400 when Anthropic validation fails', async () => {
      mockFetch.mockResolvedValue({ status: 401 });
      const res = await POST(
        makeRequest({ provider: 'anthropic', apiKey: 'bad-key' }, { sub: 'user-1', realm_access: { roles: ['user'] } })
      );
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
      const res = await POST(
        makeRequest(
          { provider: 'anthropic', apiKey: 'sample-provider-key' },
          { sub: 'user-1', realm_access: { roles: ['user'] } }
        )
      );
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

    it('treats malformed JSON as a missing provider', async () => {
      const res = await POST(
        makeRequest(
          undefined,
          { sub: 'user-1', realm_access: { roles: ['user'] } },
          undefined,
          new SyntaxError('invalid JSON')
        )
      );

      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockStoreKey).not.toHaveBeenCalled();
    });

    it('treats a null JSON body as a missing provider', async () => {
      const res = await POST(makeRequest(null, { sub: 'user-1', realm_access: { roles: ['user'] } }));

      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockStoreKey).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'a number', apiKey: 42 },
      { label: 'a blank string', apiKey: '   ' },
    ])('rejects apiKey as $label before validation', async ({ apiKey }) => {
      const res = await POST(
        makeRequest({ provider: 'anthropic', apiKey }, { sub: 'user-1', realm_access: { roles: ['user'] } })
      );

      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockStoreKey).not.toHaveBeenCalled();
    });

    it.each([
      {
        provider: 'openai',
        apiKey: 'sk-openai',
        expectedUrl: 'https://api.openai.com/v1/models',
        expectedOptions: { headers: { Authorization: 'Bearer sk-openai' } },
      },
      {
        provider: 'gemini',
        apiKey: 'gemini-key',
        expectedUrl: 'https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key',
        expectedOptions: undefined,
      },
    ])('validates and stores an API key for $provider', async ({ provider, apiKey, expectedUrl, expectedOptions }) => {
      mockFetch.mockResolvedValueOnce({ status: 200 });
      mockStoreKey.mockResolvedValueOnce(undefined);
      mockGetMaskedKey.mockResolvedValueOnce({
        provider,
        maskedKey: 'masked-key',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const res = await POST(
        makeRequest({ provider, apiKey: ` ${apiKey} ` }, { sub: 'user-1', realm_access: { roles: ['user'] } })
      );

      expect(res.status).toBe(201);
      if (expectedOptions === undefined) {
        expect(mockFetch).toHaveBeenCalledWith(expectedUrl);
      } else {
        expect(mockFetch).toHaveBeenCalledWith(expectedUrl, expectedOptions);
      }
      expect(mockStoreKey).toHaveBeenCalledWith('user-1', provider, apiKey, null);
    });

    it.each([
      { provider: 'anthropic', status: 403 },
      { provider: 'openai', status: 401 },
      { provider: 'openai', status: 403 },
      { provider: 'gemini', status: 401 },
      { provider: 'gemini', status: 403 },
    ])('rejects an API key for $provider when validation returns $status', async ({ provider, status }) => {
      mockFetch.mockResolvedValueOnce({ status });

      const res = await POST(
        makeRequest({ provider, apiKey: 'invalid-key' }, { sub: 'user-1', realm_access: { roles: ['user'] } })
      );

      expect(res.status).toBe(400);
      expect(mockStoreKey).not.toHaveBeenCalled();
    });

    it('rejects a key when provider validation cannot reach the upstream API', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network unavailable'));

      const res = await POST(
        makeRequest({ provider: 'openai', apiKey: 'sample-key' }, { sub: 'user-1', realm_access: { roles: ['user'] } })
      );

      expect(res.status).toBe(400);
      expect(mockStoreKey).not.toHaveBeenCalled();
    });

    it('returns the stored state even if storage does not expose a masked key', async () => {
      mockFetch.mockResolvedValueOnce({ status: 200 });
      mockStoreKey.mockResolvedValueOnce(undefined);
      mockGetMaskedKey.mockResolvedValueOnce(null);

      const res = await POST(
        makeRequest(
          { provider: 'anthropic', apiKey: 'sample-key' },
          { sub: 'user-1', realm_access: { roles: ['user'] } }
        )
      );
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data).toEqual({ provider: 'anthropic', hasKey: false });
    });

    it('returns 500 when key storage fails', async () => {
      mockFetch.mockResolvedValueOnce({ status: 200 });
      mockStoreKey.mockRejectedValueOnce(new Error('database unavailable'));

      const res = await POST(
        makeRequest(
          { provider: 'anthropic', apiKey: 'sample-key' },
          { sub: 'user-1', realm_access: { roles: ['user'] } }
        )
      );

      expect(res.status).toBe(500);
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
      const res = await DELETE(
        makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }, { provider: 'anthropic' })
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 when provider is missing', async () => {
      const res = await DELETE(makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }));
      expect(res.status).toBe(400);
    });

    it('returns 200 on successful deletion', async () => {
      mockDeleteKey.mockResolvedValue(true);
      const res = await DELETE(
        makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }, { provider: 'anthropic' })
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.deleted).toBe(true);
    });

    it('normalizes the delete provider before removing the key', async () => {
      mockDeleteKey.mockResolvedValueOnce(true);

      const res = await DELETE(
        makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }, { provider: ' Gemini ' })
      );

      expect(res.status).toBe(200);
      expect(mockDeleteKey).toHaveBeenCalledWith('user-1', 'gemini', null);
    });

    it('returns 500 when key deletion fails', async () => {
      mockDeleteKey.mockRejectedValueOnce(new Error('database unavailable'));

      const res = await DELETE(
        makeRequest(undefined, { sub: 'user-1', realm_access: { roles: ['user'] } }, { provider: 'anthropic' })
      );

      expect(res.status).toBe(500);
    });
  });
});
