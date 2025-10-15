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
import Github from '../github';
import { DeployStatus, PullRequestStatus } from 'shared/constants';
import { PushEvent } from '@octokit/webhooks-types';

mockRedisClient();

jest.mock('server/lib/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

describe('Github Service - handlePushWebhook', () => {
  let githubService: Github;
  let mockDb: any;
  let mockRedis: any;
  let mockRedlock: any;
  let mockQueueManager: any;

  const createMockPushEvent = (
    repoId: number = 12345,
    repoName: string = 'test/repo',
    branchName: string = 'main'
  ): PushEvent =>
    ({
      ref: `refs/heads/${branchName}`,
      before: '0000000000000000000000000000000000000000',
      after: 'abc123def456',
      repository: {
        id: repoId,
        full_name: repoName,
      },
    } as PushEvent);

  const createMockBuild = (buildId: number, buildUuid: string = 'test-uuid-123') => ({
    id: buildId,
    uuid: buildUuid,
    enableFullYaml: false,
    trackDefaultBranches: true,
    pullRequest: {
      status: PullRequestStatus.OPEN,
      deployOnUpdate: true,
    },
  });

  const createMockDeploy = (buildId: number, status: string = DeployStatus.READY, deployableId: number = 1) => ({
    id: deployableId,
    buildId,
    status,
    active: true,
    branchName: 'main',
    githubRepositoryId: 12345,
    build: createMockBuild(buildId),
    service: {
      branchName: 'main',
    },
    deployable: {
      defaultBranchName: 'main',
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockDb = {
      models: {
        PullRequest: {
          findOne: jest.fn().mockResolvedValue(null),
        },
        Deploy: {
          query: jest.fn(),
        },
      },
      services: {
        BuildService: {
          resolveAndDeployBuildQueue: {
            add: jest.fn().mockResolvedValue(undefined),
          },
        },
      },
    };

    mockRedis = {};
    mockRedlock = {};

    mockQueueManager = {
      registerQueue: jest.fn().mockReturnValue({
        add: jest.fn(),
        process: jest.fn(),
        on: jest.fn(),
      }),
    };

    githubService = new Github(mockDb, mockRedis, mockRedlock, mockQueueManager);
  });

  describe('Failed Deploy Detection', () => {
    test('should include githubRepositoryId when no deploys have failed', async () => {
      const buildId = 100;
      const mockDeploy = createMockDeploy(buildId, DeployStatus.READY);

      const mockAllDeploysQuery = {
        where: jest.fn().mockReturnThis(),
        whereNot: jest.fn().mockReturnThis(),
        withGraphFetched: jest.fn().mockResolvedValue([mockDeploy]),
      };

      const mockFailedDeploysQuery = {
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([]), // No failed deploys
      };

      let callCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockAllDeploysQuery : mockFailedDeploysQuery;
      });

      const pushEvent = createMockPushEvent();
      await githubService.handlePushWebhook(pushEvent);

      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
        buildId,
        githubRepositoryId: 12345,
      });
    });

    test('should omit githubRepositoryId when deploys have ERROR status', async () => {
      const buildId = 100;
      const mockDeploy = createMockDeploy(buildId, DeployStatus.READY);
      const mockFailedDeploy = { id: 1, status: DeployStatus.ERROR, buildId };

      const mockAllDeploysQuery = {
        where: jest.fn().mockReturnThis(),
        whereNot: jest.fn().mockReturnThis(),
        withGraphFetched: jest.fn().mockResolvedValue([mockDeploy]),
      };

      const mockFailedDeploysQuery = {
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([mockFailedDeploy]),
      };

      let callCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockAllDeploysQuery : mockFailedDeploysQuery;
      });

      const pushEvent = createMockPushEvent();
      await githubService.handlePushWebhook(pushEvent);

      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
        buildId,
      });

      const addCall = mockDb.services.BuildService.resolveAndDeployBuildQueue.add.mock.calls[0];
      expect(addCall[1]).not.toHaveProperty('githubRepositoryId');
    });

    test('should handle multiple failed deploys correctly', async () => {
      const buildId = 100;
      const mockDeploy = createMockDeploy(buildId, DeployStatus.READY);
      const mockFailedDeploys = [
        { id: 1, status: DeployStatus.ERROR, buildId },
        { id: 2, status: DeployStatus.BUILD_FAILED, buildId },
        { id: 3, status: DeployStatus.DEPLOY_FAILED, buildId },
      ];

      const mockAllDeploysQuery = {
        where: jest.fn().mockReturnThis(),
        whereNot: jest.fn().mockReturnThis(),
        withGraphFetched: jest.fn().mockResolvedValue([mockDeploy]),
      };

      const mockFailedDeploysQuery = {
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue(mockFailedDeploys),
      };

      let callCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockAllDeploysQuery : mockFailedDeploysQuery;
      });

      const pushEvent = createMockPushEvent();
      await githubService.handlePushWebhook(pushEvent);

      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
        buildId,
      });
    });

    test('should handle multiple builds and check each for failures independently', async () => {
      const buildId1 = 100;
      const buildId2 = 200;
      const mockBuild1 = createMockBuild(buildId1, 'uuid-100');
      const mockBuild2 = createMockBuild(buildId2, 'uuid-200');

      const mockDeploy1 = { ...createMockDeploy(buildId1), build: mockBuild1 };
      const mockDeploy2 = { ...createMockDeploy(buildId2), build: mockBuild2 };

      const mockAllDeploysQuery = {
        where: jest.fn().mockReturnThis(),
        whereNot: jest.fn().mockReturnThis(),
        withGraphFetched: jest.fn().mockResolvedValue([mockDeploy1, mockDeploy2]),
      };

      let queryCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) {
          return mockAllDeploysQuery;
        } else if (queryCount === 2) {
          return {
            where: jest.fn().mockReturnThis(),
            whereIn: jest.fn().mockResolvedValue([]),
          };
        } else {
          return {
            where: jest.fn().mockReturnThis(),
            whereIn: jest.fn().mockResolvedValue([{ id: 1, status: DeployStatus.ERROR, buildId: buildId2 }]),
          };
        }
      });

      const pushEvent = createMockPushEvent();
      await githubService.handlePushWebhook(pushEvent);

      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenNthCalledWith(1, 'resolve-deploy', {
        buildId: buildId1,
        githubRepositoryId: 12345,
      });

      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenNthCalledWith(2, 'resolve-deploy', {
        buildId: buildId2,
      });
    });

    test('should not add to queue when PR is closed', async () => {
      const buildId = 100;
      const mockBuild = {
        ...createMockBuild(buildId),
        pullRequest: {
          status: PullRequestStatus.CLOSED,
          deployOnUpdate: true,
        },
      };
      const mockDeploy = { ...createMockDeploy(buildId), build: mockBuild };

      const mockAllDeploysQuery = {
        where: jest.fn().mockReturnThis(),
        whereNot: jest.fn().mockReturnThis(),
        withGraphFetched: jest.fn().mockResolvedValue([mockDeploy]),
      };

      mockDb.models.Deploy.query.mockReturnValue(mockAllDeploysQuery);

      const pushEvent = createMockPushEvent();
      await githubService.handlePushWebhook(pushEvent);

      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).not.toHaveBeenCalled();
    });

    test('should not add to queue when deployOnUpdate is false', async () => {
      const buildId = 100;
      const mockBuild = {
        ...createMockBuild(buildId),
        pullRequest: {
          status: PullRequestStatus.OPEN,
          deployOnUpdate: false,
        },
      };
      const mockDeploy = { ...createMockDeploy(buildId), build: mockBuild };

      const mockAllDeploysQuery = {
        where: jest.fn().mockReturnThis(),
        whereNot: jest.fn().mockReturnThis(),
        withGraphFetched: jest.fn().mockResolvedValue([mockDeploy]),
      };

      mockDb.models.Deploy.query.mockReturnValue(mockAllDeploysQuery);

      const pushEvent = createMockPushEvent();
      await githubService.handlePushWebhook(pushEvent);

      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).not.toHaveBeenCalled();
    });
  });
});
