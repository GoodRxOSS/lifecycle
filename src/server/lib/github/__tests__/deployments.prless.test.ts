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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

import * as client from 'server/lib/github/client';
import * as githubIndex from 'server/lib/github/index';
import {
  createGithubDeployment,
  createOrUpdateGithubDeployment,
  deleteGithubDeployment,
  deleteGithubDeploymentAndEnvironment,
  deleteGithubEnvironment,
  getDeployment,
  updateDeploymentStatus,
} from 'server/lib/github/deployments';

jest.mock('server/services/globalConfig', () => {
  const RedisMock = {
    hgetall: jest.fn(),
    hset: jest.fn(),
    expire: jest.fn(),
  };
  return {
    getInstance: jest.fn(() => ({
      redis: RedisMock,
    })),
  };
});

jest.mock('server/lib/github/client');
jest.mock('server/lib/github/index', () => ({
  getPullRequest: jest.fn(),
}));

describe('GitHub deployment functions with PR-less builds', () => {
  const mockPatch = jest.fn();
  const mockOctokit = { request: jest.fn() };

  const prlessDeploy = (overrides: Record<string, unknown> = {}) => ({
    uuid: 'app-api-env-123456',
    githubDeploymentId: null,
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
    $query: jest.fn(() => ({ patch: mockPatch })),
    build: {
      pullRequest: null,
      statusMessage: 'ok',
      status: 'deployed',
    },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (client.createOctokitClient as jest.Mock).mockResolvedValue(mockOctokit);
  });

  test('createOrUpdateGithubDeployment skips without calling GitHub', async () => {
    await expect(createOrUpdateGithubDeployment(prlessDeploy() as any)).resolves.toBeUndefined();

    expect(githubIndex.getPullRequest).not.toHaveBeenCalled();
    expect(mockOctokit.request).not.toHaveBeenCalled();
  });

  test('deleteGithubDeploymentAndEnvironment skips every GitHub call even with a stale deployment id', async () => {
    await expect(
      deleteGithubDeploymentAndEnvironment(prlessDeploy({ githubDeploymentId: 'stale-id' }) as any)
    ).resolves.toBeUndefined();

    expect(mockOctokit.request).not.toHaveBeenCalled();
  });

  test('createGithubDeployment rejects before any GitHub call', async () => {
    await expect(createGithubDeployment(prlessDeploy() as any, 'abc123')).rejects.toThrow(
      'requires a pull request repository'
    );

    expect(mockOctokit.request).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  test('deleteGithubDeployment returns null without calling GitHub or patching', async () => {
    await expect(deleteGithubDeployment(prlessDeploy({ githubDeploymentId: 'stale-id' }) as any)).resolves.toBeNull();

    expect(mockOctokit.request).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  test('deleteGithubEnvironment skips without calling GitHub', async () => {
    await expect(deleteGithubEnvironment(prlessDeploy() as any)).resolves.toBeUndefined();

    expect(mockOctokit.request).not.toHaveBeenCalled();
  });

  test('updateDeploymentStatus returns null without calling GitHub', async () => {
    await expect(updateDeploymentStatus(prlessDeploy() as any, 12345)).resolves.toBeNull();

    expect(mockOctokit.request).not.toHaveBeenCalled();
  });

  test('getDeployment returns null without calling GitHub', async () => {
    await expect(getDeployment(prlessDeploy({ githubDeploymentId: 'stale-id' }) as any)).resolves.toBeNull();

    expect(mockOctokit.request).not.toHaveBeenCalled();
  });
});
