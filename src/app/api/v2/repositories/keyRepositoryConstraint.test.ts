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
import type { Principal } from 'server/lib/principal';

const mockListOnboardedRepositories = jest.fn();
const mockListInstalledRepositories = jest.fn();
const mockOnboardRepository = jest.fn();

jest.mock('server/services/repository', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    listOnboardedRepositories: mockListOnboardedRepositories,
    listInstalledRepositories: mockListInstalledRepositories,
    onboardRepository: mockOnboardRepository,
    parseOnboardedParam: () => undefined,
  })),
}));

jest.mock('server/lib/principal', () => ({ resolvePrincipal: jest.fn() }));

import { resolvePrincipal } from 'server/lib/principal';
import { GET, POST } from './route';

const mockResolvePrincipal = resolvePrincipal as jest.Mock;

const keyPrincipal = (
  repoIds: number[] | null,
  repositoryNames: string[] | null = repoIds ? ['org/allowed'] : null
): Principal => ({
  kind: 'personal_key',
  authMethod: 'api_key',
  userId: 'sub-1',
  actor: 'sub-1',
  roles: [],
  scopes: ['repos:read', 'repos:write'],
  tokenId: 7,
  repositoryAllowlist: repositoryNames,
  repositoryAllowlistRepoIds: repoIds,
  identity: null,
});

const makeRequest = (url: string, body?: unknown) =>
  ({
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
    json: jest.fn().mockResolvedValue(body ?? {}),
  } as unknown as NextRequest);

beforeEach(() => {
  jest.clearAllMocks();
  mockListOnboardedRepositories.mockResolvedValue({
    repositories: [],
    pagination: { current: 1, total: 1, items: 0, limit: 25 },
  });
  mockListInstalledRepositories.mockResolvedValue({
    repositories: [],
    pagination: { current: 1, total: 1, items: 0, limit: 25 },
  });
  mockOnboardRepository.mockResolvedValue({ repository: { id: 1 }, created: true });
});

describe('repository listing pushes the key repository constraint into the query', () => {
  it('passes the allowlist ids to the onboarded listing', async () => {
    mockResolvePrincipal.mockResolvedValue(keyPrincipal([42]));

    const res = await GET(makeRequest('http://localhost/api/v2/repositories'));

    expect(res.status).toBe(200);
    expect(mockListOnboardedRepositories).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedGithubRepositoryIds: [42],
        allowedRepositoryFullNames: ['org/allowed'],
      })
    );
  });

  it('passes the allowlist ids to the installed listing', async () => {
    mockResolvePrincipal.mockResolvedValue(keyPrincipal([42]));

    await GET(makeRequest('http://localhost/api/v2/repositories?view=all'));

    expect(mockListInstalledRepositories).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedGithubRepositoryIds: [42],
        allowedRepositoryFullNames: ['org/allowed'],
      })
    );
  });

  it.each(['onboarded', 'all'])('forwards a legacy name-only constraint to the %s listing', async (view) => {
    mockResolvePrincipal.mockResolvedValue(keyPrincipal(null, ['org/allowed']));

    await GET(makeRequest(`http://localhost/api/v2/repositories${view === 'all' ? '?view=all' : ''}`));

    const list = view === 'all' ? mockListInstalledRepositories : mockListOnboardedRepositories;
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedGithubRepositoryIds: null,
        allowedRepositoryFullNames: ['org/allowed'],
      })
    );
  });

  it('leaves an unrestricted principal unfiltered', async () => {
    mockResolvePrincipal.mockResolvedValue(keyPrincipal(null));

    await GET(makeRequest('http://localhost/api/v2/repositories'));

    expect(mockListOnboardedRepositories).toHaveBeenCalledWith(
      expect.objectContaining({ allowedGithubRepositoryIds: null, allowedRepositoryFullNames: null })
    );
  });
});

describe('repository onboarding authorizes against the installation repository id', () => {
  it('forwards the allowlist ids so the service can authorize the target', async () => {
    mockResolvePrincipal.mockResolvedValue(keyPrincipal([42]));

    const res = await POST(makeRequest('http://localhost/api/v2/repositories', { fullName: 'org/allowed' }));

    expect(res.status).toBe(201);
    expect(mockOnboardRepository).toHaveBeenCalledWith('org/allowed', undefined, [42], ['org/allowed']);
  });

  it('forwards a legacy name-only constraint so the service authorizes the target', async () => {
    mockResolvePrincipal.mockResolvedValue(keyPrincipal(null, ['org/allowed']));

    const res = await POST(makeRequest('http://localhost/api/v2/repositories', { fullName: 'org/allowed' }));

    expect(res.status).toBe(201);
    expect(mockOnboardRepository).toHaveBeenCalledWith('org/allowed', undefined, null, ['org/allowed']);
  });

  it('lets a key onboard rather than rejecting it as an unsupported credential kind', async () => {
    mockResolvePrincipal.mockResolvedValue(keyPrincipal(null));

    const res = await POST(makeRequest('http://localhost/api/v2/repositories', { fullName: 'org/any' }));

    expect(res.status).toBe(201);
    expect(mockOnboardRepository).toHaveBeenCalledWith('org/any', undefined, null, null);
  });
});
