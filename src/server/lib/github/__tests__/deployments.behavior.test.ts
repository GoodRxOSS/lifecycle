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

jest.mock('server/lib/github/cacheRequest', () => ({ cacheRequest: jest.fn() }));
jest.mock('server/lib/github/index', () => ({ getPullRequest: jest.fn() }));
jest.mock('server/lib/logger', () => ({ getLogger: jest.fn() }));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
}));

import type { Deploy } from 'server/models';
import { cacheRequest } from 'server/lib/github/cacheRequest';
import {
  createGithubDeployment,
  createOrUpdateGithubDeployment,
  deleteGithubDeployment,
  deleteGithubDeploymentAndEnvironment,
  deleteGithubEnvironment,
  getDeployment,
  updateDeploymentStatus,
} from 'server/lib/github/deployments';
import { getPullRequest } from 'server/lib/github/index';
import { getLogger } from 'server/lib/logger';
import GlobalConfigService from 'server/services/globalConfig';

const mockCacheRequest = cacheRequest as jest.Mock;
const mockGetPullRequest = getPullRequest as jest.Mock;
const mockGetAllConfigs = jest.fn();
const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function makeBuild(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    statusMessage: 'Environment ready',
    pullRequest: {
      pullRequestNumber: 12,
      repository: { fullName: 'goodrx/lifecycle' },
    },
    ...overrides,
  };
}

function makeDeploy(overrides: Record<string, unknown> = {}) {
  const patch = jest.fn().mockResolvedValue(undefined);
  const deploy = {
    uuid: 'env-123',
    githubDeploymentId: 101,
    status: 'ready',
    publicUrl: null,
    build: makeBuild(),
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
    $query: jest.fn(() => ({ patch })),
    ...overrides,
  } as unknown as Deploy;
  return { deploy, patch };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCacheRequest.mockReset().mockResolvedValue({ data: {} });
  mockGetPullRequest.mockReset().mockResolvedValue({ data: { head: { sha: 'new-sha' } } });
  mockGetAllConfigs.mockReset().mockResolvedValue({
    domainDefaults: { http: 'services.example.com', grpc: 'grpc.example.com' },
  });
  (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({ getAllConfigs: mockGetAllConfigs });
  (getLogger as jest.Mock).mockReturnValue(mockLogger);
});

describe('createOrUpdateGithubDeployment', () => {
  it('deletes a stale-SHA deployment and creates a replacement for the latest pull-request commit', async () => {
    const { deploy, patch } = makeDeploy();
    mockCacheRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint === 'GET /repos/goodrx/lifecycle/deployments/101') return { data: { sha: 'old-sha' } };
      if (endpoint === 'POST /repos/goodrx/lifecycle/deployments') return { data: { id: 202 } };
      return { data: {} };
    });

    await expect(createOrUpdateGithubDeployment(deploy)).resolves.toBeUndefined();

    expect(mockGetPullRequest).toHaveBeenCalledWith('goodrx', 'lifecycle', 12, null);
    expect((deploy as any).$fetchGraph).toHaveBeenCalledTimes(2);
    expect(mockCacheRequest.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      'GET /repos/goodrx/lifecycle/deployments/101',
      'POST /repos/goodrx/lifecycle/deployments/101/statuses',
      'DELETE /repos/goodrx/lifecycle/deployments/101',
      'DELETE /repos/goodrx/lifecycle/environments/env-123',
      'POST /repos/goodrx/lifecycle/deployments',
      'POST /repos/goodrx/lifecycle/deployments/202/statuses',
    ]);
    expect(mockCacheRequest).toHaveBeenCalledWith(
      'POST /repos/goodrx/lifecycle/deployments',
      expect.objectContaining({ data: expect.objectContaining({ ref: 'new-sha', environment: 'env-123' }) })
    );
    expect(patch).toHaveBeenNthCalledWith(1, { githubDeploymentId: null });
    expect(patch).toHaveBeenNthCalledWith(2, { githubDeploymentId: 202 });
  });

  it('logs and rethrows an outer orchestration failure without issuing a deployment request', async () => {
    const { deploy, patch } = makeDeploy();
    const error = new Error('pull request unavailable');
    mockGetPullRequest.mockRejectedValueOnce(error);

    await expect(createOrUpdateGithubDeployment(deploy)).rejects.toBe(error);

    expect(mockLogger.error).toHaveBeenCalledWith('GitHub deployment failed: error=pull request unavailable');
    expect(mockCacheRequest).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('deployment cleanup', () => {
  it('warns when the inactive status cannot be posted but still deletes the deployment and environment', async () => {
    const { deploy, patch } = makeDeploy();
    const error = new Error('status endpoint unavailable');
    mockCacheRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith('/deployments/101/statuses')) throw error;
      return { data: {} };
    });

    await expect(deleteGithubDeploymentAndEnvironment(deploy)).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'GitHub deployment: failed to mark inactive deploymentId=101 error=status endpoint unavailable'
    );
    expect(mockCacheRequest).toHaveBeenCalledWith('DELETE /repos/goodrx/lifecycle/deployments/101');
    expect(mockCacheRequest).toHaveBeenCalledWith('DELETE /repos/goodrx/lifecycle/environments/env-123');
    expect(patch).toHaveBeenCalledWith({ githubDeploymentId: null });
  });

  it('loads the deployment graph before deleting when the build relation is not loaded', async () => {
    const build = makeBuild();
    const { deploy, patch } = makeDeploy({ build: undefined });
    (deploy as any).$fetchGraph.mockImplementationOnce(async () => {
      (deploy as any).build = build;
    });
    const response = { data: { deleted: true } };
    mockCacheRequest.mockResolvedValueOnce(response);

    await expect(deleteGithubDeployment(deploy)).resolves.toBe(response);

    expect((deploy as any).$fetchGraph).toHaveBeenCalledWith('build.pullRequest.repository');
    expect(mockCacheRequest).toHaveBeenCalledWith('DELETE /repos/goodrx/lifecycle/deployments/101');
    expect(patch).toHaveBeenCalledWith({ githubDeploymentId: null });
  });

  it('loads the deployment graph before deleting an environment when the build relation is not loaded', async () => {
    const build = makeBuild();
    const { deploy } = makeDeploy({ build: undefined });
    (deploy as any).$fetchGraph.mockImplementationOnce(async () => {
      (deploy as any).build = build;
    });

    await expect(deleteGithubEnvironment(deploy)).resolves.toBeUndefined();

    expect((deploy as any).$fetchGraph).toHaveBeenCalledWith('build.pullRequest.repository');
    expect(mockCacheRequest).toHaveBeenCalledWith('DELETE /repos/goodrx/lifecycle/environments/env-123');
  });
});

describe('createGithubDeployment', () => {
  it('rejects a successful GitHub response that omits the deployment id and does not patch the model', async () => {
    const { deploy, patch } = makeDeploy();
    mockCacheRequest.mockResolvedValueOnce({ data: {} });

    await expect(createGithubDeployment(deploy, 'new-sha')).rejects.toThrow('No deployment ID returned from github');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'GitHub deployment create failed: repo=goodrx/lifecycle error=No deployment ID returned from github'
    );
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('deleteGithubEnvironment failures', () => {
  it('treats a missing environment as an idempotent successful deletion', async () => {
    const { deploy } = makeDeploy();
    mockCacheRequest.mockRejectedValueOnce({ status: 404, message: 'Not Found' });

    await expect(deleteGithubEnvironment(deploy)).resolves.toBeUndefined();

    expect(mockLogger.debug).toHaveBeenCalledWith('GitHub environment: not found environment=env-123');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('warns specifically when GitHub refuses environment deletion', async () => {
    const { deploy } = makeDeploy();
    mockCacheRequest.mockRejectedValueOnce({ status: 403, message: 'Forbidden' });

    await expect(deleteGithubEnvironment(deploy)).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'GitHub environment: no permission to delete environment=env-123 (check GitHub App permissions)'
    );
  });

  it('warns with status and error details for other GitHub failures', async () => {
    const { deploy } = makeDeploy();
    mockCacheRequest.mockRejectedValueOnce({ status: 500, message: 'GitHub unavailable' });

    await expect(deleteGithubEnvironment(deploy)).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'GitHub environment: delete failed environment=env-123 status=500 error=GitHub unavailable'
    );
  });
});

describe('getDeployment', () => {
  it('loads the deployment graph before lookup and sends GitHub owner/repository parameters', async () => {
    const build = makeBuild();
    const { deploy } = makeDeploy({ build: undefined });
    (deploy as any).$fetchGraph.mockImplementationOnce(async () => {
      (deploy as any).build = build;
    });
    const response = { data: { id: 101, sha: 'new-sha' } };
    mockCacheRequest.mockResolvedValueOnce(response);

    await expect(getDeployment(deploy)).resolves.toBe(response);

    expect((deploy as any).$fetchGraph).toHaveBeenCalledWith('build.pullRequest.repository');
    expect(mockCacheRequest).toHaveBeenCalledWith('GET /repos/goodrx/lifecycle/deployments/101', {
      data: { owner: 'goodrx', repo: 'lifecycle', deployment_id: 101 },
    });
  });
});

describe('updateDeploymentStatus', () => {
  it('reports a build-level error even when the deployment lifecycle status is otherwise successful', async () => {
    const { deploy } = makeDeploy({
      status: 'ready',
      publicUrl: 'app.example.com',
      build: makeBuild({ status: 'error', statusMessage: 'Build failed' }),
    });

    await updateDeploymentStatus(deploy, 101);

    expect(mockCacheRequest).toHaveBeenCalledWith('POST /repos/goodrx/lifecycle/deployments/101/statuses', {
      data: {
        state: 'error',
        environment: 'env-123',
        description: 'Build failed',
      },
    });
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
  });
});
