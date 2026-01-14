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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

import * as client from 'server/lib/github/client';
import {
  createGithubDeployment,
  createOrUpdateGithubDeployment,
  deleteGithubDeployment,
  deleteGithubDeploymentAndEnvironment,
  deleteGithubEnvironment,
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
jest.mock('axios');

describe('GitHub Deployment Functions', () => {
  const mockPatch = jest.fn();

  const mockDeploy = {
    uuid: '1234',
    githubDeploymentId: null,
    $fetchGraph: jest.fn(),
    $query: jest.fn(() => ({
      patch: mockPatch,
    })),
    build: {
      pullRequest: {
        repository: {
          fullName: 'user/repo',
        },
        branchName: 'feature-branch',
      },
      statusMessage: 'Build successful',
    },
  };

  const mockOctokit = {
    request: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    client.createOctokitClient.mockResolvedValue(mockOctokit);
  });

  test('createOrUpdateGithubDeployment - create new deployment', async () => {
    mockDeploy.githubDeploymentId = null;
    mockOctokit.request.mockResolvedValue({ data: { id: 'deployment-id' } });

    await createOrUpdateGithubDeployment(mockDeploy);

    expect(mockDeploy.$fetchGraph).toHaveBeenCalledWith('build.pullRequest.repository');
    expect(mockOctokit.request).toHaveBeenCalled();
  });

  test('createOrUpdateGithubDeployment - update existing deployment', async () => {
    mockDeploy.githubDeploymentId = 'existing-id';
    mockOctokit.request.mockResolvedValue({});

    await createOrUpdateGithubDeployment(mockDeploy);

    expect(mockDeploy.$fetchGraph).toHaveBeenCalledWith('build.pullRequest.repository');
    expect(mockOctokit.request).toHaveBeenCalled();
  });

  test('deleteGithubDeploymentAndEnvironment - with deployment ID', async () => {
    mockDeploy.githubDeploymentId = 'existing-id';
    mockOctokit.request.mockResolvedValue({});
    await deleteGithubDeploymentAndEnvironment(mockDeploy);

    expect(mockDeploy.$fetchGraph).toHaveBeenCalledWith('build.pullRequest.repository');
    expect(mockOctokit.request).toHaveBeenCalledTimes(2);
  });

  test('createGithubDeployment - success', async () => {
    const deploymentId = '123456';
    mockOctokit.request.mockResolvedValue({ data: { id: deploymentId } });

    const resp = await createGithubDeployment(mockDeploy);

    expect(mockOctokit.request).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
    expect(resp).toHaveProperty('data.id', deploymentId);
    expect(mockDeploy.$query().patch).toHaveBeenCalledWith({ githubDeploymentId: deploymentId });
  });

  test('deleteGithubEnvironment - successful deletion', async () => {
    mockOctokit.request.mockResolvedValue({});

    await deleteGithubEnvironment(mockDeploy);

    expect(mockOctokit.request).toHaveBeenCalledWith(
      `DELETE /repos/${mockDeploy.build.pullRequest.repository.fullName}/environments/${mockDeploy.uuid}`
    );
  });

  test('deleteGithubDeployment - successful deletion', async () => {
    mockOctokit.request.mockResolvedValue({});

    const resp = await deleteGithubDeployment(mockDeploy);

    expect(mockOctokit.request).toHaveBeenCalledWith(
      `DELETE /repos/${mockDeploy.build.pullRequest.repository.fullName}/deployments/${mockDeploy.githubDeploymentId}`
    );
    expect(mockDeploy.$query).toHaveBeenCalledTimes(1);
    expect(mockPatch).toHaveBeenCalledWith({ githubDeploymentId: null });
    expect(resp).toBeDefined();
  });

  test('deleteGithubDeployment - error during deletion', async () => {
    const error = new Error('Network error');
    mockOctokit.request.mockRejectedValue(error);

    await expect(deleteGithubDeployment(mockDeploy)).rejects.toThrow('GitHub API request failed');
    expect(mockOctokit.request).toHaveBeenCalledWith(
      `DELETE /repos/${mockDeploy.build.pullRequest.repository.fullName}/deployments/${mockDeploy.githubDeploymentId}`
    );
  });
});
