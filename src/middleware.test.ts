/**
 * Copyright 2026 Lifecycle contributors
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

const mockChain = jest.fn();
const mockCompiledMiddleware = jest.fn();
const mockCorsMiddleware = jest.fn();
const mockRequestIdMiddleware = jest.fn();
const mockAuthMiddleware = jest.fn();

jest.mock('server/middlewares/chain', () => ({
  chain: (...args: unknown[]) => mockChain(...args),
}));

jest.mock('server/middlewares', () => ({
  authMiddleware: mockAuthMiddleware,
  corsMiddleware: mockCorsMiddleware,
  requestIdMiddleware: mockRequestIdMiddleware,
}));

describe('API middleware composition', () => {
  beforeEach(() => {
    jest.resetModules();
    mockChain.mockReset().mockReturnValue(mockCompiledMiddleware);
  });

  it('applies CORS, request identity, then authentication to both API versions', async () => {
    const loaded = await import('./middleware');

    expect(mockChain).toHaveBeenCalledWith([mockCorsMiddleware, mockRequestIdMiddleware, mockAuthMiddleware]);
    expect(loaded.middleware).toBe(mockCompiledMiddleware);
    expect(loaded.config.matcher).toEqual(['/api/v1/:path*', '/api/v2/:path*']);
  });
});
