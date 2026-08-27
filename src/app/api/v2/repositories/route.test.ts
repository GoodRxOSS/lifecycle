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

function makeRequest(url: string, body: unknown = {}, jsonError?: unknown) {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
    json: jsonError === undefined ? jest.fn().mockResolvedValue(body) : jest.fn().mockRejectedValue(jsonError),
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
        allowedGithubRepositoryIds: null,
        allowedRepositoryFullNames: null,
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
        allowedGithubRepositoryIds: null,
        allowedRepositoryFullNames: null,
      });
    });

    test('rejects unknown views', async () => {
      const response = await GET(makeRequest('http://localhost/api/v2/repositories?view=legacy'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toContain('view must be onboarded or all');
    });

    test('forwards a numeric installation id and default filters to installed listing', async () => {
      const response = await GET(makeRequest('http://localhost/api/v2/repositories?view=all&installationId=42'));

      expect(response.status).toBe(200);
      expect(mockParseOnboardedParam).toHaveBeenCalledWith(null);
      expect(mockListInstalledRepositories).toHaveBeenCalledWith({
        query: '',
        page: 1,
        limit: 25,
        installationId: 42,
        onboarded: undefined,
        refresh: false,
        allowedGithubRepositoryIds: null,
        allowedRepositoryFullNames: null,
      });
    });

    test('rejects a non-numeric installation id before listing', async () => {
      const response = await GET(makeRequest('http://localhost/api/v2/repositories?installationId=not-a-number'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toBe('installationId must be a number');
      expect(mockListOnboardedRepositories).not.toHaveBeenCalled();
      expect(mockListInstalledRepositories).not.toHaveBeenCalled();
    });

    test('maps an invalid onboarded filter to 400 without listing', async () => {
      const error = new Error('onboarded must be true or false');
      mockParseOnboardedParam.mockImplementationOnce(() => {
        throw error;
      });

      const response = await GET(makeRequest('http://localhost/api/v2/repositories?view=all&onboarded=maybe'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toBe(error.message);
      expect(mockListInstalledRepositories).not.toHaveBeenCalled();
    });

    test.each([
      { label: 'onboarded', url: 'http://localhost/api/v2/repositories', service: mockListOnboardedRepositories },
      {
        label: 'installed',
        url: 'http://localhost/api/v2/repositories?view=all',
        service: mockListInstalledRepositories,
      },
    ])('returns 500 when the $label repository listing fails', async ({ url, service }) => {
      service.mockRejectedValueOnce(new Error('GitHub unavailable'));

      const response = await GET(makeRequest(url));

      expect(response.status).toBe(500);
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
      expect(mockOnboardRepository).toHaveBeenCalledWith('example-org/api', undefined, null, null);
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

    test('accepts the legacy repository field and GitHub installation id alias', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/v2/repositories', {
          fullName: null,
          repository: 'example-org/legacy',
          installationId: null,
          githubInstallationId: '42',
        })
      );

      expect(response.status).toBe(201);
      expect(mockOnboardRepository).toHaveBeenCalledWith('example-org/legacy', 42, null, null);
    });

    test.each([
      { label: 'a number', fullName: 42 },
      { label: 'a blank string', fullName: '   ' },
    ])('rejects fullName as $label', async ({ fullName }) => {
      const response = await POST(makeRequest('http://localhost/api/v2/repositories', { fullName }));

      expect(response.status).toBe(400);
      expect(mockOnboardRepository).not.toHaveBeenCalled();
    });

    test('rejects a non-numeric onboarding installation id', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/v2/repositories', {
          fullName: 'example-org/api',
          installationId: 'not-a-number',
        })
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toBe('installationId must be a number');
      expect(mockOnboardRepository).not.toHaveBeenCalled();
    });

    test('returns 200 when onboarding refreshes an existing repository', async () => {
      mockOnboardRepository.mockResolvedValueOnce({
        repository: { id: 1, fullName: 'example-org/api', onboarded: true },
        created: false,
      });

      const response = await POST(makeRequest('http://localhost/api/v2/repositories', { fullName: 'example-org/api' }));

      expect(response.status).toBe(200);
    });

    test('rejects malformed JSON before onboarding', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/v2/repositories', undefined, new SyntaxError('invalid JSON'))
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toBe('Invalid JSON in request body');
      expect(mockOnboardRepository).not.toHaveBeenCalled();
    });

    test.each([
      { label: 'invalid full name', error: new Error('Invalid repository fullName'), status: 400 },
      { label: 'missing installation', error: new Error('installation ID is required'), status: 400 },
      { label: 'missing repository', error: new Error('Repository not found'), status: 404 },
      { label: 'non-Error invalid full name', error: 'Invalid repository fullName', status: 400 },
    ])('maps $label onboarding failures to $status', async ({ error, status }) => {
      mockOnboardRepository.mockRejectedValueOnce(error);

      const response = await POST(makeRequest('http://localhost/api/v2/repositories', { fullName: 'example-org/api' }));

      expect(response.status).toBe(status);
    });

    test('returns 500 for an unexpected onboarding failure', async () => {
      mockOnboardRepository.mockRejectedValueOnce(new Error('GitHub unavailable'));

      const response = await POST(makeRequest('http://localhost/api/v2/repositories', { fullName: 'example-org/api' }));

      expect(response.status).toBe(500);
    });
  });
});
