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

import { NextRequest } from 'next/server';

const mockAssertNamedRepositoryAllowed = jest.fn();
const mockValidateLifecycleSchema = jest.fn();
const mockPrincipal = {
  kind: 'service_key',
  scopes: ['repos:read'],
  repositoryAllowlist: ['org/repo'],
};

jest.mock('server/lib/createApiHandler', () => ({
  createPrincipalApiHandler:
    (_policy: unknown, handler: (...args: unknown[]) => Promise<Response>) => (req: NextRequest) =>
      handler(req, mockPrincipal),
}));

jest.mock('server/lib/repositoryAuthorization', () => ({
  assertNamedRepositoryAllowed: (...args: unknown[]) => mockAssertNamedRepositoryAllowed(...args),
}));

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    validateLifecycleSchema: (...args: unknown[]) => mockValidateLifecycleSchema(...args),
  })),
}));

import { GET } from './route';

function makeRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/v2/schema/validate${query}`, { method: 'GET' });
}

describe('GET /api/v2/schema/validate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertNamedRepositoryAllowed.mockResolvedValue(undefined);
    mockValidateLifecycleSchema.mockResolvedValue({ valid: true, errors: [] });
  });

  it.each([
    { label: 'a missing repository', query: '?branch=main' },
    { label: 'a blank repository', query: '?repo=%20%20&branch=main' },
    { label: 'a missing branch', query: '?repo=org%2Frepo' },
    { label: 'a blank branch', query: '?repo=org%2Frepo&branch=%20%20' },
  ])('rejects $label before repository authorization', async ({ query }) => {
    const response = await GET(makeRequest(query));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('An unknown error occurred.');
    expect(mockAssertNamedRepositoryAllowed).not.toHaveBeenCalled();
    expect(mockValidateLifecycleSchema).not.toHaveBeenCalled();
  });

  it('authorizes the named repository and returns the schema validation result', async () => {
    mockValidateLifecycleSchema.mockResolvedValue({
      valid: false,
      errors: [{ path: 'services.web', message: 'image is required' }],
    });

    const response = await GET(makeRequest('?repo=org%2Frepo&branch=feature'));

    expect(response.status).toBe(200);
    expect(mockAssertNamedRepositoryAllowed).toHaveBeenCalledWith(mockPrincipal, 'org/repo');
    expect(mockValidateLifecycleSchema).toHaveBeenCalledWith('org/repo', 'feature');
    expect(mockAssertNamedRepositoryAllowed.mock.invocationCallOrder[0]).toBeLessThan(
      mockValidateLifecycleSchema.mock.invocationCallOrder[0]
    );
    expect((await response.json()).data).toEqual({
      valid: false,
      errors: [{ path: 'services.web', message: 'image is required' }],
    });
  });

  it('does not validate schema when repository authorization fails', async () => {
    mockAssertNamedRepositoryAllowed.mockRejectedValue(new Error('repository forbidden'));

    await expect(GET(makeRequest('?repo=org%2Frepo&branch=main'))).rejects.toThrow('repository forbidden');
    expect(mockValidateLifecycleSchema).not.toHaveBeenCalled();
  });
});
