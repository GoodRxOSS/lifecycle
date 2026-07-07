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
import * as githubIndex from 'server/lib/github/index';
import {
  createGithubDeployment,
  createOrUpdateGithubDeployment,
  deleteGithubDeployment,
  deleteGithubDeploymentAndEnvironment,
  deleteGithubEnvironment,
  updateDeploymentStatus,
} from 'server/lib/github/deployments';
import type { Deploy } from 'server/models';

const mockGetAllConfigs = jest.fn();

jest.mock('server/services/globalConfig', () => {
  const RedisMock = {
    hgetall: jest.fn(),
    hset: jest.fn(),
    expire: jest.fn(),
  };
  return {
    getInstance: jest.fn(() => ({
      redis: RedisMock,
      getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
    })),
  };
});

jest.mock('server/lib/github/client');
jest.mock('server/lib/github/index', () => ({
  getPullRequest: jest.fn(),
}));
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
          fullName: 'example-org/example-repo',
        },
        branchName: 'feature-branch',
      },
      statusMessage: 'Build successful',
    },
    publicUrl: 'app.example.com',
  };

  const mockOctokit = {
    request: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    client.createOctokitClient.mockResolvedValue(mockOctokit);
    mockGetAllConfigs.mockResolvedValue({
      domainDefaults: { http: 'services.example.com', grpc: 'grpc.example.com' },
    });
  });

  test('createOrUpdateGithubDeployment - create new deployment', async () => {
    mockDeploy.githubDeploymentId = null;
    mockOctokit.request.mockResolvedValue({ data: { id: 'deployment-id' } });

    await createOrUpdateGithubDeployment(mockDeploy as unknown as Deploy);

    expect(mockDeploy.$fetchGraph).toHaveBeenCalledWith('build.pullRequest.repository');
    expect(mockOctokit.request).toHaveBeenCalled();
  });

  test('createOrUpdateGithubDeployment - update existing deployment', async () => {
    mockDeploy.githubDeploymentId = 'existing-id';
    mockOctokit.request.mockResolvedValue({});

    await createOrUpdateGithubDeployment(mockDeploy as unknown as Deploy);

    expect(mockDeploy.$fetchGraph).toHaveBeenCalledWith('build.pullRequest.repository');
    expect(mockOctokit.request).toHaveBeenCalled();
  });

  test('deleteGithubDeploymentAndEnvironment - with deployment ID', async () => {
    mockDeploy.githubDeploymentId = 'existing-id';
    mockOctokit.request.mockResolvedValue({});
    await deleteGithubDeploymentAndEnvironment(mockDeploy as unknown as Deploy);

    expect(mockDeploy.$fetchGraph).toHaveBeenCalledWith('build.pullRequest.repository');
    expect(mockOctokit.request).toHaveBeenCalledTimes(3); // markInactive + deleteDeployment + deleteEnvironment
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

    await deleteGithubEnvironment(mockDeploy as unknown as Deploy);

    expect(mockOctokit.request).toHaveBeenCalledWith(
      `DELETE /repos/${mockDeploy.build.pullRequest.repository.fullName}/environments/${mockDeploy.uuid}`
    );
  });

  test('deleteGithubDeployment - successful deletion', async () => {
    mockOctokit.request.mockResolvedValue({});

    const resp = await deleteGithubDeployment(mockDeploy as unknown as Deploy);

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

    await expect(deleteGithubDeployment(mockDeploy as unknown as Deploy)).rejects.toThrow('GitHub API request failed');
    expect(mockOctokit.request).toHaveBeenCalledWith(
      `DELETE /repos/${mockDeploy.build.pullRequest.repository.fullName}/deployments/${mockDeploy.githubDeploymentId}`
    );
  });

  test('createOrUpdateGithubDeployment - uses newly created deployment ID for status update', async () => {
    const newDeploymentId = 999888;
    const mockDeployForIdTest = {
      uuid: '1234',
      githubDeploymentId: null,
      status: 'deployed',
      $fetchGraph: jest.fn(),
      $query: jest.fn(() => ({
        patch: mockPatch,
      })),
      build: {
        status: 'deployed',
        pullRequest: {
          repository: {
            fullName: 'example-org/example-repo',
          },
          pullRequestNumber: 123,
          branchName: 'feature-branch',
        },
        statusMessage: 'Build successful',
      },
    };

    (githubIndex.getPullRequest as jest.Mock).mockResolvedValue({
      data: { head: { sha: 'abc123' } },
    });

    mockOctokit.request.mockImplementation((url) => {
      if (url.includes('POST /repos') && url.includes('/deployments') && !url.includes('/statuses')) {
        return Promise.resolve({ data: { id: newDeploymentId } });
      }
      if (url.includes('/statuses')) {
        return Promise.resolve({ data: {} });
      }
      return Promise.resolve({ data: {} });
    });

    await createOrUpdateGithubDeployment(mockDeployForIdTest);

    expect(mockOctokit.request).toHaveBeenCalledWith(
      expect.stringContaining(`/deployments/${newDeploymentId}/statuses`),
      expect.any(Object)
    );
  });

  test('createGithubDeployment - sets transient_environment to true', async () => {
    const deploymentId = '123456';
    mockOctokit.request.mockResolvedValue({ data: { id: deploymentId } });

    await createGithubDeployment(mockDeploy as unknown as Deploy, 'abc123');

    expect(mockOctokit.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        data: expect.objectContaining({
          transient_environment: true,
        }),
      })
    );
  });

  test('updateDeploymentStatus - maps deployed status to success', async () => {
    const mockDeployWithStatus = {
      ...mockDeploy,
      status: 'deployed',
      build: {
        ...mockDeploy.build,
        status: 'deployed',
      },
    } as unknown as Deploy;
    mockOctokit.request.mockResolvedValue({ data: {} });

    await updateDeploymentStatus(mockDeployWithStatus, 12345);

    expect(mockOctokit.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'success',
          environment_url: 'https://app.example.com',
        }),
      })
    );
  });

  test('updateDeploymentStatus - uses HTTP for the documented local domain', async () => {
    const mockDeployWithStatus = {
      ...mockDeploy,
      status: 'deployed',
      publicUrl: 'app-calm-waterfall-156345.127.0.0.1.nip.io',
      build: {
        ...mockDeploy.build,
        status: 'deployed',
      },
    } as unknown as Deploy;
    mockGetAllConfigs.mockResolvedValue({
      domainDefaults: { http: '127.0.0.1.nip.io', grpc: '127.0.0.1.nip.io' },
    });
    mockOctokit.request.mockResolvedValue({ data: {} });

    await updateDeploymentStatus(mockDeployWithStatus, 12345);

    expect(mockOctokit.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'success',
          environment_url: 'http://app-calm-waterfall-156345.127.0.0.1.nip.io',
        }),
      })
    );
  });

  test('updateDeploymentStatus - still posts a successful PR deployment when config lookup fails', async () => {
    const mockDeployWithStatus = {
      ...mockDeploy,
      status: 'deployed',
      build: {
        ...mockDeploy.build,
        status: 'deployed',
      },
    } as unknown as Deploy;
    mockGetAllConfigs.mockRejectedValueOnce(new Error('config unavailable'));
    mockOctokit.request.mockResolvedValue({ data: {} });

    await updateDeploymentStatus(mockDeployWithStatus, 12345);

    expect(mockOctokit.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'success',
          environment_url: 'https://app.example.com',
        }),
      })
    );
  });

  test('updateDeploymentStatus - maps building status to in_progress', async () => {
    const mockDeployBuilding = {
      ...mockDeploy,
      status: 'building',
      build: {
        ...mockDeploy.build,
        status: 'building',
      },
    } as unknown as Deploy;
    mockOctokit.request.mockResolvedValue({ data: {} });

    await updateDeploymentStatus(mockDeployBuilding, 12345);

    expect(mockOctokit.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'in_progress',
        }),
      })
    );
  });

  test('updateDeploymentStatus - maps deploy_failed status to failure', async () => {
    const mockDeployFailed = {
      ...mockDeploy,
      status: 'deploy_failed',
      build: {
        ...mockDeploy.build,
        status: 'active',
      },
    } as unknown as Deploy;
    mockOctokit.request.mockResolvedValue({ data: {} });

    await updateDeploymentStatus(mockDeployFailed, 12345);

    expect(mockOctokit.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'failure',
        }),
      })
    );
  });

  test('updateDeploymentStatus - maps torn_down status to inactive', async () => {
    const mockDeployTornDown = {
      ...mockDeploy,
      status: 'torn_down',
      build: {
        ...mockDeploy.build,
        status: 'active',
      },
    } as unknown as Deploy;
    mockOctokit.request.mockResolvedValue({ data: {} });

    await updateDeploymentStatus(mockDeployTornDown, 12345);

    expect(mockOctokit.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'inactive',
        }),
      })
    );
  });
});
