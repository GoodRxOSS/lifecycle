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

const mockWarn = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ warn: mockWarn })),
}));

import { clearEndpointModelDiscoveryCache, discoverEndpointModelIds } from '../gatewayModelDiscovery';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

const BASE_URL = 'https://gateway.example.test/v1';

function modelsResponse(ids: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) };
}

describe('discoverEndpointModelIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    clearEndpointModelDiscoveryCache();
  });

  it('lists unique, trimmed model ids from the endpoint with the api key', async () => {
    mockFetch.mockResolvedValueOnce(modelsResponse(['model-a', ' model-b ', 'model-a', '', 42]));

    await expect(discoverEndpointModelIds({ baseUrl: `${BASE_URL}/`, apiKey: 'key-1' })).resolves.toEqual([
      'model-a',
      'model-b',
    ]);
    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/models`, {
      headers: { Authorization: 'Bearer key-1' },
      signal: expect.any(AbortSignal),
    });
  });

  it('serves cached ids without refetching inside the cache window', async () => {
    mockFetch.mockResolvedValueOnce(modelsResponse(['model-a']));

    await discoverEndpointModelIds({ baseUrl: BASE_URL, apiKey: 'key-1' });
    await discoverEndpointModelIds({ baseUrl: BASE_URL, apiKey: 'key-1' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent callers', async () => {
    mockFetch.mockResolvedValueOnce(modelsResponse(['model-a']));

    const results = await Promise.all([
      discoverEndpointModelIds({ baseUrl: BASE_URL, apiKey: 'key-1' }),
      discoverEndpointModelIds({ baseUrl: BASE_URL, apiKey: 'key-1' }),
    ]);

    expect(results).toEqual([['model-a'], ['model-a']]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('caches per api key', async () => {
    mockFetch.mockResolvedValueOnce(modelsResponse(['model-a'])).mockResolvedValueOnce(modelsResponse(['model-b']));

    await expect(discoverEndpointModelIds({ baseUrl: BASE_URL, apiKey: 'key-1' })).resolves.toEqual(['model-a']);
    await expect(discoverEndpointModelIds({ baseUrl: BASE_URL, apiKey: 'key-2' })).resolves.toEqual(['model-b']);
  });

  it('returns null when the first request fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    await expect(discoverEndpointModelIds({ baseUrl: BASE_URL, apiKey: 'key-1' })).resolves.toBeNull();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known ids when a refresh fails', async () => {
    jest.useFakeTimers();
    mockFetch.mockResolvedValueOnce(modelsResponse(['model-a'])).mockRejectedValueOnce(new Error('unreachable'));

    await discoverEndpointModelIds({ baseUrl: BASE_URL, apiKey: 'key-1' });
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);

    await expect(discoverEndpointModelIds({ baseUrl: BASE_URL, apiKey: 'key-1' })).resolves.toEqual(['model-a']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('treats a response without a data array as a failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ models: [] }) });

    await expect(discoverEndpointModelIds({ baseUrl: BASE_URL, apiKey: 'key-1' })).resolves.toBeNull();
  });
});
