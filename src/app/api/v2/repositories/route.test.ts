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

import { NextRequest } from 'next/server';

const mockListOnboardedRepositories = jest.fn();
const mockListInstalledRepositories = jest.fn();
const mockOnboardRepository = jest.fn();
const mockParseOnboardedParam = jest.fn((value?: string | null) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
});

jest.mock('server/services/repository', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    listOnboardedRepositories: mockListOnboardedRepositories,
    listInstalledRepositories: mockListInstalledRepositories,
    onboardRepository: mockOnboardRepository,
    parseOnboardedParam: mockParseOnboardedParam,
  })),
}));

import { GET, POST } from './route';

function makeRequest(url: string, body?: unknown) {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
    json: jest.fn().mockResolvedValue(body || {}),
  } as unknown as NextRequest;
}

describe('/api/v2/repositories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListOnboardedRepositories.mockResolvedValue({
      repositories: [{ id: 1, fullName: 'example-org/api', onboarded: true }],
      pagination: { current: 1, total: 1, items: 1, limit: 25 },
    });
    mockListInstalledRepositories.mockResolvedValue({
      repositories: [{ githubRepositoryId: 2, fullName: 'example-org/web', onboarded: false }],
      pagination: { current: 1, total: 1, items: 1, limit: 25 },
    });
    mockOnboardRepository.mockResolvedValue({
      repository: { id: 1, fullName: 'example-org/api', onboarded: true },
      created: true,
    });
  });

  describe('GET', () => {
    test('lists onboarded repositories by default', async () => {
      const response = await GET(makeRequest('http://localhost/api/v2/repositories?q=api&page=2&limit=10'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockListOnboardedRepositories).toHaveBeenCalledWith({
        query: 'api',
        page: 2,
        limit: 10,
        installationId: undefined,
      });
      expect(body.data.repositories).toEqual([{ id: 1, fullName: 'example-org/api', onboarded: true }]);
      expect(body.metadata.pagination).toEqual({ current: 1, total: 1, items: 1, limit: 25 });
    });

    test('lists installed repositories annotated for dropdown filtering', async () => {
      const response = await GET(
        makeRequest('http://localhost/api/v2/repositories?view=all&onboarded=false&q=web&refresh=true')
      );

      expect(response.status).toBe(200);
      expect(mockParseOnboardedParam).toHaveBeenCalledWith('false');
      expect(mockListInstalledRepositories).toHaveBeenCalledWith({
        query: 'web',
        page: 1,
        limit: 25,
        installationId: undefined,
        onboarded: false,
        refresh: true,
      });
    });

    test('rejects unknown views', async () => {
      const response = await GET(makeRequest('http://localhost/api/v2/repositories?view=legacy'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toContain('view must be onboarded or all');
    });
  });

  describe('POST', () => {
    test('onboards a repository and returns 201 for newly created rows', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/v2/repositories', {
          fullName: 'example-org/api',
        })
      );
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(mockOnboardRepository).toHaveBeenCalledWith('example-org/api', undefined);
      expect(body.data).toEqual({
        repository: { id: 1, fullName: 'example-org/api', onboarded: true },
        created: true,
      });
    });

    test('rejects missing fullName', async () => {
      const response = await POST(makeRequest('http://localhost/api/v2/repositories', {}));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toContain('Missing required field: fullName');
    });
  });
});
