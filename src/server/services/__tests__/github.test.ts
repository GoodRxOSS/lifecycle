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
import RepositoryService from '../repository';
import { BuildStatus, DeployStatus, PullRequestStatus } from 'shared/constants';
import { PushEvent } from '@octokit/webhooks-types';
import * as githubLib from 'server/lib/github';
import * as YamlService from 'server/models/yaml';

mockRedisClient();

const TEST_OWNER_URL = 'https://example.invalid/example-owner';
const TEST_REPOSITORY_FULL_NAME = 'example-owner/example-repo';

const mockIsLifecycleLabel = jest.fn();
const mockHasDeployLabel = jest.fn();
const mockEnableKillSwitch = jest.fn();
const mockIsStaging = jest.fn().mockReturnValue(false);
const mockLoggerError = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerDebug = jest.fn();

jest.mock('server/lib/utils', () => ({
  ...jest.requireActual('server/lib/utils'),
  isLifecycleLabel: (...args) => mockIsLifecycleLabel(...args),
  hasDeployLabel: (...args) => mockHasDeployLabel(...args),
  enableKillSwitch: (...args) => mockEnableKillSwitch(...args),
  isStaging: (...args) => mockIsStaging(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: mockLoggerError,
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    debug: mockLoggerDebug,
    child: jest.fn().mockReturnThis(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  LogStage: {},
}));

jest.mock('server/lib/github', () => ({
  ...jest.requireActual('server/lib/github'),
  getYamlFileContent: jest.fn(),
  getChangedFilesForPush: jest.fn(),
  verifyWebhookSignature: jest.fn(() => true),
}));

jest.mock('server/models/yaml', () => ({
  ...jest.requireActual('server/models/yaml'),
  fetchLifecycleConfig: jest.fn(),
}));

const createDedupeAwareResolveEnqueue = (queueAdd: jest.Mock) => {
  const queuedKeys = new Set<string>();

  return jest.fn(async (payload) => {
    const queueKey = `${payload.buildId}:${payload.githubRepositoryId ?? 'all'}`;
    if (queuedKeys.has(queueKey)) return undefined;
    queuedKeys.add(queueKey);
    return queueAdd('resolve-deploy', payload);
  });
};

describe('Github Service - repository onboarding gate', () => {
  let githubService: Github;
  let mockDb: any;
  let mockQueueManager: any;
  let isRepositoryOnboarded: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    isRepositoryOnboarded = jest.spyOn(RepositoryService.prototype, 'isRepositoryOnboarded');
    mockDb = {
      services: {
        Repository: {
          syncRepositoryRename: jest.fn(),
        },
      },
    };
    mockQueueManager = {
      registerQueue: jest.fn().mockReturnValue({
        add: jest.fn(),
        process: jest.fn(),
        on: jest.fn(),
      }),
    };
    githubService = new Github(mockDb, {}, {} as any, mockQueueManager);
  });

  test('skips repo-scoped webhooks for repositories that are not onboarded', async () => {
    isRepositoryOnboarded.mockResolvedValue(false);
    const handlePushWebhook = jest.spyOn(githubService, 'handlePushWebhook').mockResolvedValue(undefined);

    await githubService.dispatchWebhook({
      headers: { 'x-github-event': 'push' },
      body: {
        installation: { id: 34 },
        repository: {
          id: 12,
          full_name: 'example-org/example-repo',
        },
      },
    } as any);

    expect(isRepositoryOnboarded).toHaveBeenCalledWith(34, 12);
    expect(handlePushWebhook).not.toHaveBeenCalled();
  });

  test('processes repo-scoped webhooks for onboarded repositories', async () => {
    isRepositoryOnboarded.mockResolvedValue(true);
    const handlePushWebhook = jest.spyOn(githubService, 'handlePushWebhook').mockResolvedValue(undefined);
    const body = {
      installation: { id: 34 },
      repository: {
        id: 12,
        full_name: 'example-org/example-repo',
      },
    };

    await githubService.dispatchWebhook({
      headers: { 'x-github-event': 'push' },
      body,
    } as any);

    expect(handlePushWebhook).toHaveBeenCalledWith(body);
  });

  test('syncs repository metadata on rename webhooks', async () => {
    await githubService.handleRepositoryWebhook({
      action: 'renamed',
      installation: { id: 34 },
      repository: {
        id: 12,
        name: 'renamed-repo',
        full_name: 'example-org/renamed-repo',
        html_url: 'https://github.com/example-org/renamed-repo',
        owner: {
          id: 56,
          login: 'example-org',
        },
      },
    } as any);

    expect(mockDb.services.Repository.syncRepositoryRename).toHaveBeenCalledWith({
      githubRepositoryId: 12,
      githubInstallationId: 34,
      ownerId: 56,
      ownerLogin: 'example-org',
      name: 'renamed-repo',
      fullName: 'example-org/renamed-repo',
      htmlUrl: 'https://github.com/example-org/renamed-repo',
    });
  });
});

describe('Github Service - handlePullRequestHook', () => {
  let githubService: Github;
  let mockDb: any;
  let mockQueueManager: any;
  const mockGetYamlFileContent = githubLib.getYamlFileContent as jest.Mock;

  const createMockPullRequestEvent = ({ labels = [] as { name: string }[], branchSha = 'abc123' } = {}) =>
    ({
      action: 'opened',
      number: 42,
      repository: {
        id: 12345,
        owner: { id: 777, html_url: TEST_OWNER_URL },
        name: 'repo',
        full_name: TEST_REPOSITORY_FULL_NAME,
      },
      installation: { id: 999 },
      pull_request: {
        id: 1001,
        head: { ref: 'feature-branch', sha: branchSha },
        title: 'Test PR',
        user: { login: 'test-user' },
        state: 'open',
        labels,
      },
    } as any);

  const createMockPullRequest = (overrides: any = {}) => {
    const patch = jest.fn().mockResolvedValue(undefined);

    return {
      id: 1,
      deployOnUpdate: false,
      latestCommit: null,
      githubLogin: 'test-user',
      fullName: TEST_REPOSITORY_FULL_NAME,
      branchName: 'feature-branch',
      build: { id: 10, uuid: 'build-uuid' },
      repository: { id: 5 },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn().mockReturnValue({
        patch,
      }),
      __patch: patch,
      ...overrides,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const mockResolveQueueAdd = jest.fn().mockResolvedValue(undefined);
    const mockEnqueueResolveAndDeployBuild = createDedupeAwareResolveEnqueue(mockResolveQueueAdd);

    mockDb = {
      models: {
        Build: {
          findOne: jest.fn().mockResolvedValue({ id: 10 }),
        },
        PullRequest: {
          findOne: jest.fn().mockResolvedValue(null),
        },
      },
      services: {
        Repository: {
          findRepository: jest.fn().mockResolvedValue({
            id: 5,
            defaultEnvId: 15,
            githubInstallationId: 999,
          }),
        },
        PullRequest: {
          findOrCreatePullRequest: jest.fn().mockResolvedValue(createMockPullRequest()),
        },
        BuildService: {
          createBuildAndDeploys: jest.fn().mockResolvedValue(undefined),
          enqueueResolveAndDeployBuild: mockEnqueueResolveAndDeployBuild,
          resolveAndDeployBuildQueue: {
            add: mockResolveQueueAdd,
          },
        },
        LabelService: {
          labelQueue: {
            add: jest.fn().mockResolvedValue(undefined),
          },
        },
        BotUser: {
          isBotUser: jest.fn().mockResolvedValue(false),
        },
      },
    };

    mockQueueManager = {
      registerQueue: jest.fn().mockReturnValue({
        add: jest.fn(),
        process: jest.fn(),
        on: jest.fn(),
      }),
    };

    githubService = new Github(mockDb, {}, {} as any, mockQueueManager);
  });

  test('queues initial build when a non-autoDeploy PR is opened with the deploy label', async () => {
    mockGetYamlFileContent.mockResolvedValue({ environment: { autoDeploy: false } });
    mockHasDeployLabel.mockResolvedValue(true);
    mockEnableKillSwitch.mockResolvedValue(false);

    const mockPullRequest = createMockPullRequest();
    mockDb.services.PullRequest.findOrCreatePullRequest.mockResolvedValue(mockPullRequest);

    await githubService.handlePullRequestHook(
      createMockPullRequestEvent({
        labels: [{ name: 'lifecycle-deploy!' }],
      })
    );

    expect(mockDb.services.BuildService.createBuildAndDeploys).toHaveBeenCalled();
    expect(mockDb.models.Build.findOne).toHaveBeenCalledWith({ pullRequestId: 1 });
    expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
      buildId: 10,
    });
    expect(mockDb.services.LabelService.labelQueue.add).not.toHaveBeenCalled();
    expect(mockPullRequest.__patch).toHaveBeenCalledWith(
      expect.objectContaining({
        deployOnUpdate: true,
        labels: JSON.stringify(['lifecycle-deploy!']),
      })
    );
  });

  test('queues initial build and skips label sync when an autoDeploy PR is opened with the deploy label', async () => {
    mockGetYamlFileContent.mockResolvedValue({ environment: { autoDeploy: true } });
    mockHasDeployLabel.mockResolvedValue(true);
    mockEnableKillSwitch.mockResolvedValue(false);

    const mockPullRequest = createMockPullRequest({ deployOnUpdate: true });
    mockDb.services.PullRequest.findOrCreatePullRequest.mockResolvedValue(mockPullRequest);

    await githubService.handlePullRequestHook(
      createMockPullRequestEvent({
        labels: [{ name: 'lifecycle-deploy!' }],
      })
    );

    expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
      buildId: 10,
    });
    expect(mockDb.services.LabelService.labelQueue.add).not.toHaveBeenCalled();
  });

  test('keeps the existing label sync flow for unlabeled autoDeploy PRs', async () => {
    mockGetYamlFileContent.mockResolvedValue({ environment: { autoDeploy: true } });
    mockHasDeployLabel.mockResolvedValue(false);
    mockEnableKillSwitch.mockResolvedValue(false);

    const mockPullRequest = createMockPullRequest({ deployOnUpdate: true });
    mockDb.services.PullRequest.findOrCreatePullRequest.mockResolvedValue(mockPullRequest);

    await githubService.handlePullRequestHook(
      createMockPullRequestEvent({
        labels: [],
      })
    );

    expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).not.toHaveBeenCalled();
    expect(mockDb.services.LabelService.labelQueue.add).toHaveBeenCalledWith(
      'label',
      expect.objectContaining({
        pullRequestId: 1,
        action: 'enable',
        waitForComment: true,
        labels: [],
      })
    );
  });

  test('skips pull request webhooks for repositories that are not onboarded', async () => {
    mockDb.services.Repository.findRepository.mockResolvedValue(null);

    await githubService.handlePullRequestHook(createMockPullRequestEvent());

    expect(mockGetYamlFileContent).not.toHaveBeenCalled();
    expect(mockDb.services.PullRequest.findOrCreatePullRequest).not.toHaveBeenCalled();
    expect(mockDb.services.BuildService.createBuildAndDeploys).not.toHaveBeenCalled();
  });

  test('queues one effective build across labeled -> opened -> labeled for a pre-labeled autoDeploy PR', async () => {
    mockGetYamlFileContent.mockResolvedValue({ environment: { autoDeploy: true } });
    mockHasDeployLabel.mockResolvedValue(true);
    mockEnableKillSwitch.mockResolvedValue(false);
    mockIsLifecycleLabel.mockImplementation(async (label: string) => label.startsWith('lifecycle-'));

    const mockPullRequest = createMockPullRequest({ deployOnUpdate: true });
    mockDb.services.PullRequest.findOrCreatePullRequest.mockResolvedValue(mockPullRequest);
    mockDb.models.PullRequest.findOne.mockResolvedValue(mockPullRequest);

    const openEvent = createMockPullRequestEvent({
      labels: [{ name: 'question' }, { name: 'lifecycle-deploy!' }],
    });
    const createLabelEvent = (changedLabel: string) => ({
      action: 'labeled',
      label: { name: changedLabel },
      pull_request: {
        id: 1001,
        labels: [{ name: 'question' }, { name: 'lifecycle-deploy!' }],
        state: 'open',
      },
    });

    await githubService.handleLabelWebhook(createLabelEvent('question'));
    await githubService.handlePullRequestHook(openEvent);
    await githubService.handleLabelWebhook(createLabelEvent('lifecycle-deploy!'));

    expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledTimes(1);
    expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
      buildId: 10,
    });
    expect(mockDb.services.LabelService.labelQueue.add).not.toHaveBeenCalled();
  });
});

describe('Github Service - handlePushWebhook', () => {
  let githubService: Github;
  let mockDb: any;
  let mockRedis: any;
  let mockRedlock: any;
  let mockQueueManager: any;
  const mockGetChangedFilesForPush = githubLib.getChangedFilesForPush as jest.Mock;

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
    status: BuildStatus.DEPLOYED,
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
      name: 'api',
      branchName: 'main',
    },
    deployable: {
      name: 'api',
      defaultBranchName: 'main',
    },
  });

  const createAllDeploysQuery = (deploys: any[]) => ({
    where: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    withGraphFetched: jest.fn().mockResolvedValue(deploys),
  });

  const createFailedDeploysQuery = (deploys: any[]) => ({
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockResolvedValue(deploys),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChangedFilesForPush.mockReset();
    (YamlService.fetchLifecycleConfig as jest.Mock).mockReset();
    const mockResolveQueueAdd = jest.fn().mockResolvedValue(undefined);
    const mockEnqueueResolveAndDeployBuild = createDedupeAwareResolveEnqueue(mockResolveQueueAdd);

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
          enqueueResolveAndDeployBuild: mockEnqueueResolveAndDeployBuild,
          resolveAndDeployBuildQueue: {
            add: mockResolveQueueAdd,
          },
        },
        Webhook: {
          webhookQueue: {
            add: jest.fn().mockResolvedValue(undefined),
          },
        },
        GlobalConfig: {
          getAllConfigs: jest.fn().mockResolvedValue({
            features: {
              ignoreFiles: true,
            },
          }),
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

    test('updates latestCommit for a matching previous commit', async () => {
      const patch = jest.fn().mockResolvedValue(undefined);
      const buildId = 100;
      const mockBuild = {
        ...createMockBuild(buildId),
        pullRequest: {
          status: PullRequestStatus.CLOSED,
          deployOnUpdate: true,
        },
      };
      const mockDeploy = { ...createMockDeploy(buildId), build: mockBuild };

      mockDb.models.PullRequest.findOne.mockResolvedValue({
        $query: jest.fn().mockReturnValue({ patch }),
      });
      mockDb.models.Deploy.query.mockReturnValue(createAllDeploysQuery([mockDeploy]));

      const pushEvent = {
        ...createMockPushEvent(),
        before: 'previous-commit',
        after: 'latest-commit',
      } as PushEvent;

      await githubService.handlePushWebhook(pushEvent);

      expect(mockDb.models.PullRequest.findOne).toHaveBeenCalledWith({ latestCommit: 'previous-commit' });
      expect(patch).toHaveBeenCalledWith({ latestCommit: 'latest-commit' });
      expect(mockGetChangedFilesForPush).not.toHaveBeenCalled();
    });

    test('skips deploys when every changed file matches ignoreFiles and queues deployed webhooks', async () => {
      const buildId = 100;
      const mockDeploy = createMockDeploy(buildId);
      mockGetChangedFilesForPush.mockResolvedValue({ canSkip: true, files: ['docs/readme.md'] });
      (YamlService.fetchLifecycleConfig as jest.Mock).mockResolvedValue({
        version: '1.0.0',
        environment: { ignoreFiles: ['docs/**'] },
        services: [{ name: 'api' }],
      } as any);

      let queryCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        queryCount++;
        return queryCount === 1 ? createAllDeploysQuery([mockDeploy]) : createFailedDeploysQuery([]);
      });

      const pushEvent = {
        ...createMockPushEvent(),
        before: 'previous-commit',
        after: 'latest-commit',
        commits: [
          {
            added: [],
            removed: [],
            modified: ['docs/readme.md'],
          },
        ],
        distinct_size: 1,
      } as PushEvent;

      await githubService.handlePushWebhook(pushEvent);

      expect(mockGetChangedFilesForPush).not.toHaveBeenCalled();
      expect(YamlService.fetchLifecycleConfig).toHaveBeenCalledWith('test/repo', 'main');
      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).not.toHaveBeenCalled();
      expect(mockDb.services.Webhook.webhookQueue.add).toHaveBeenCalledWith('webhook', { buildId });
    });

    test('dry-runs ignoreFiles skips when the feature flag is false', async () => {
      const buildId = 100;
      const mockDeploy = createMockDeploy(buildId);
      mockDb.services.GlobalConfig.getAllConfigs.mockResolvedValue({ features: { ignoreFiles: false } });
      (YamlService.fetchLifecycleConfig as jest.Mock).mockResolvedValue({
        version: '1.0.0',
        environment: { ignoreFiles: ['docs/**'] },
        services: [{ name: 'api' }],
      } as any);

      let queryCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        queryCount++;
        return queryCount === 1 ? createAllDeploysQuery([mockDeploy]) : createFailedDeploysQuery([]);
      });

      const pushEvent = {
        ...createMockPushEvent(),
        before: 'previous-commit',
        after: 'latest-commit',
        commits: [
          {
            added: [],
            removed: [],
            modified: ['docs/readme.md'],
          },
        ],
        distinct_size: 1,
      } as PushEvent;

      await githubService.handlePushWebhook(pushEvent);

      expect(mockDb.services.GlobalConfig.getAllConfigs).toHaveBeenCalled();
      expect(mockLoggerInfo).toHaveBeenCalledWith('Push: dry-run would skip deploy reason=ignoreFiles');
      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
        buildId,
        githubRepositoryId: 12345,
      });
      expect(mockDb.services.Webhook.webhookQueue.add).not.toHaveBeenCalled();
    });

    test('dry-runs ignoreFiles skips when the feature flag is missing', async () => {
      const buildId = 100;
      const mockDeploy = createMockDeploy(buildId);
      mockDb.services.GlobalConfig.getAllConfigs.mockResolvedValue({ features: {} });
      (YamlService.fetchLifecycleConfig as jest.Mock).mockResolvedValue({
        version: '1.0.0',
        environment: { ignoreFiles: ['docs/**'] },
        services: [{ name: 'api' }],
      } as any);

      let queryCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        queryCount++;
        return queryCount === 1 ? createAllDeploysQuery([mockDeploy]) : createFailedDeploysQuery([]);
      });

      const pushEvent = {
        ...createMockPushEvent(),
        before: 'previous-commit',
        after: 'latest-commit',
        commits: [
          {
            added: [],
            removed: [],
            modified: ['docs/readme.md'],
          },
        ],
        distinct_size: 1,
      } as PushEvent;

      await githubService.handlePushWebhook(pushEvent);

      expect(mockLoggerInfo).toHaveBeenCalledWith('Push: dry-run would skip deploy reason=ignoreFiles');
      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
        buildId,
        githubRepositoryId: 12345,
      });
      expect(mockDb.services.Webhook.webhookQueue.add).not.toHaveBeenCalled();
    });

    test('falls back to compare when push payload cannot safely provide changed files', async () => {
      const buildId = 100;
      const mockDeploy = createMockDeploy(buildId);
      mockGetChangedFilesForPush.mockResolvedValue({ canSkip: true, files: ['docs/readme.md'] });
      (YamlService.fetchLifecycleConfig as jest.Mock).mockResolvedValue({
        version: '1.0.0',
        environment: { ignoreFiles: ['docs/**'] },
        services: [{ name: 'api' }],
      } as any);

      let queryCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        queryCount++;
        return queryCount === 1 ? createAllDeploysQuery([mockDeploy]) : createFailedDeploysQuery([]);
      });

      const pushEvent = {
        ...createMockPushEvent(),
        before: 'previous-commit',
        after: 'latest-commit',
        commits: [
          {
            added: [],
            removed: ['src/old.ts'],
            modified: [],
          },
        ],
        distinct_size: 1,
      } as PushEvent;

      await githubService.handlePushWebhook(pushEvent);

      expect(mockGetChangedFilesForPush).toHaveBeenCalledWith({
        fullName: 'test/repo',
        before: 'previous-commit',
        after: 'latest-commit',
      });
      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).not.toHaveBeenCalled();
      expect(mockDb.services.Webhook.webhookQueue.add).toHaveBeenCalledWith('webhook', { buildId });
    });

    test('redeploys when ignoreFiles config cannot be fetched', async () => {
      const buildId = 100;
      const mockDeploy = createMockDeploy(buildId);
      mockGetChangedFilesForPush.mockResolvedValue({ canSkip: true, files: ['docs/readme.md'] });
      (YamlService.fetchLifecycleConfig as jest.Mock).mockRejectedValue(new Error('fetch failed'));

      let queryCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        queryCount++;
        return queryCount === 1 ? createAllDeploysQuery([mockDeploy]) : createFailedDeploysQuery([]);
      });

      const pushEvent = {
        ...createMockPushEvent(),
        before: 'previous-commit',
        after: 'latest-commit',
      } as PushEvent;

      await githubService.handlePushWebhook(pushEvent);

      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
        buildId,
        githubRepositoryId: 12345,
      });
      expect(mockDb.services.Webhook.webhookQueue.add).not.toHaveBeenCalled();
    });

    test('redeploys when an affected service has no ignoreFiles policy', async () => {
      const buildId = 100;
      const mockDeploy = createMockDeploy(buildId);
      (YamlService.fetchLifecycleConfig as jest.Mock).mockResolvedValue({
        version: '1.0.0',
        environment: {},
        services: [{ name: 'api' }],
      } as any);

      let queryCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        queryCount++;
        return queryCount === 1 ? createAllDeploysQuery([mockDeploy]) : createFailedDeploysQuery([]);
      });

      const pushEvent = {
        ...createMockPushEvent(),
        before: 'previous-commit',
        after: 'latest-commit',
        commits: [
          {
            added: [],
            removed: [],
            modified: ['docs/readme.md'],
          },
        ],
        distinct_size: 1,
      } as PushEvent;

      await githubService.handlePushWebhook(pushEvent);

      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
        buildId,
        githubRepositoryId: 12345,
      });
      expect(mockDb.services.Webhook.webhookQueue.add).not.toHaveBeenCalled();
      expect(mockLoggerInfo).toHaveBeenCalledWith('Push: deploying reason=ignoreFiles_not_matched');
    });

    test('always redeploys failed deploys without fetching changed files', async () => {
      const buildId = 100;
      const mockDeploy = createMockDeploy(buildId);
      const mockFailedDeploy = { id: 1, status: DeployStatus.ERROR, buildId };

      let queryCount = 0;
      mockDb.models.Deploy.query.mockImplementation(() => {
        queryCount++;
        return queryCount === 1 ? createAllDeploysQuery([mockDeploy]) : createFailedDeploysQuery([mockFailedDeploy]);
      });

      const pushEvent = {
        ...createMockPushEvent(),
        before: 'previous-commit',
        after: 'latest-commit',
      } as PushEvent;

      await githubService.handlePushWebhook(pushEvent);

      expect(mockGetChangedFilesForPush).not.toHaveBeenCalled();
      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
        buildId,
      });
    });

    test('queues skipped-push webhooks only for supported current build statuses', async () => {
      await (githubService as any).queueWebhooksForSkippedPush({ id: 1, status: BuildStatus.DEPLOYED });
      await (githubService as any).queueWebhooksForSkippedPush({ id: 2, status: BuildStatus.ERROR });
      await (githubService as any).queueWebhooksForSkippedPush({ id: 3, status: BuildStatus.TORN_DOWN });
      await (githubService as any).queueWebhooksForSkippedPush({ id: 4, status: BuildStatus.BUILT });

      expect(mockDb.services.Webhook.webhookQueue.add).toHaveBeenCalledTimes(3);
      expect(mockDb.services.Webhook.webhookQueue.add).toHaveBeenNthCalledWith(1, 'webhook', { buildId: 1 });
      expect(mockDb.services.Webhook.webhookQueue.add).toHaveBeenNthCalledWith(2, 'webhook', { buildId: 2 });
      expect(mockDb.services.Webhook.webhookQueue.add).toHaveBeenNthCalledWith(3, 'webhook', { buildId: 3 });
    });

    test('redeploys static environments without fetching changed files', async () => {
      const buildId = 701;
      const repoBuilder = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
      };
      const prBuilder = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn((_column, callback) => {
          callback(repoBuilder);
          return prBuilder;
        }),
      };
      const buildQuery = {
        whereIn: jest.fn((_column, callback) => {
          callback(prBuilder);
          return buildQuery;
        }),
        andWhere: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ id: buildId }),
      };

      mockDb.models.Build = { query: jest.fn().mockReturnValue(buildQuery) };
      mockDb.models.PullRequest.tableName = 'pull_requests';
      mockDb.models.Repository = { tableName: 'repositories' };
      mockDb.models.Deploy.query.mockReturnValue(createAllDeploysQuery([]));

      const pushEvent = {
        ...createMockPushEvent(),
        before: 'previous-commit',
        after: 'latest-commit',
      } as PushEvent;

      await githubService.handlePushWebhook(pushEvent);

      expect(mockGetChangedFilesForPush).not.toHaveBeenCalled();
      expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith('resolve-deploy', {
        buildId,
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

describe('Github Service - handleLabelWebhook', () => {
  let githubService: Github;
  let mockDb: any;
  let mockQueueManager: any;

  const createMockLabelWebhookBody = ({
    action = 'labeled',
    changedLabel = 'ready-for-review',
    allLabels = [{ name: 'ready-for-review' }],
    githubPullRequestId = 1001,
    status = 'open',
  } = {}) => ({
    action,
    label: { name: changedLabel },
    pull_request: {
      id: githubPullRequestId,
      labels: allLabels,
      state: status,
    },
  });

  const createMockPullRequest = (overrides: any = {}) => ({
    id: 1,
    deployOnUpdate: false,
    githubLogin: 'test-user',
    fullName: TEST_REPOSITORY_FULL_NAME,
    branchName: 'feature-branch',
    build: { id: 10, uuid: 'build-uuid' },
    repository: { id: 5 },
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
    $query: jest.fn().mockReturnValue({
      patch: jest.fn().mockResolvedValue(undefined),
      first: jest.fn().mockResolvedValue(undefined),
    }),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const mockResolveQueueAdd = jest.fn().mockResolvedValue(undefined);
    const mockEnqueueResolveAndDeployBuild = jest.fn((payload) => mockResolveQueueAdd('resolve-deploy', payload));

    mockDb = {
      models: {
        PullRequest: {
          findOne: jest.fn().mockResolvedValue(null),
        },
      },
      services: {
        BuildService: {
          deleteBuild: jest.fn().mockResolvedValue(undefined),
          enqueueResolveAndDeployBuild: mockEnqueueResolveAndDeployBuild,
          resolveAndDeployBuildQueue: {
            add: mockResolveQueueAdd,
          },
        },
        BotUser: {
          isBotUser: jest.fn().mockResolvedValue(false),
        },
      },
    };

    mockQueueManager = {
      registerQueue: jest.fn().mockReturnValue({
        add: jest.fn(),
        process: jest.fn(),
        on: jest.fn(),
      }),
    };

    githubService = new Github(mockDb, {}, {} as any, mockQueueManager);
  });

  test('should skip processing when changed label is not a lifecycle label', async () => {
    mockIsLifecycleLabel.mockResolvedValue(false);

    const body = createMockLabelWebhookBody({
      changedLabel: 'ready-for-review',
      allLabels: [{ name: 'lifecycle-deploy!' }, { name: 'ready-for-review' }],
    });

    await githubService.handleLabelWebhook(body);

    expect(mockIsLifecycleLabel).toHaveBeenCalledWith('ready-for-review');
    expect(mockDb.models.PullRequest.findOne).not.toHaveBeenCalled();
    expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).not.toHaveBeenCalled();
    expect(mockDb.services.BuildService.deleteBuild).not.toHaveBeenCalled();
  });

  test('should skip processing for donotmerge label', async () => {
    mockIsLifecycleLabel.mockResolvedValue(false);

    const body = createMockLabelWebhookBody({
      changedLabel: 'donotmerge',
      allLabels: [{ name: 'lifecycle-deploy!' }, { name: 'donotmerge' }],
    });

    await githubService.handleLabelWebhook(body);

    expect(mockIsLifecycleLabel).toHaveBeenCalledWith('donotmerge');
    expect(mockDb.models.PullRequest.findOne).not.toHaveBeenCalled();
  });

  test('should process webhook when deploy label is added', async () => {
    mockIsLifecycleLabel.mockResolvedValue(true);
    mockHasDeployLabel.mockResolvedValue(true);
    mockEnableKillSwitch.mockResolvedValue(false);

    const mockPr = createMockPullRequest({ deployOnUpdate: true });
    mockDb.models.PullRequest.findOne.mockResolvedValue(mockPr);

    const body = createMockLabelWebhookBody({
      action: 'labeled',
      changedLabel: 'lifecycle-deploy!',
      allLabels: [{ name: 'lifecycle-deploy!' }],
    });

    await githubService.handleLabelWebhook(body);

    expect(mockIsLifecycleLabel).toHaveBeenCalledWith('lifecycle-deploy!');
    expect(mockDb.models.PullRequest.findOne).toHaveBeenCalled();
    expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).toHaveBeenCalledWith(
      'resolve-deploy',
      expect.objectContaining({ buildId: 10 })
    );
  });

  test('should delete build when deploy label is removed', async () => {
    mockIsLifecycleLabel.mockResolvedValue(true);
    mockHasDeployLabel.mockResolvedValue(false);
    mockEnableKillSwitch.mockResolvedValue(false);

    const mockPr = createMockPullRequest({ deployOnUpdate: false });
    mockDb.models.PullRequest.findOne.mockResolvedValue(mockPr);

    const body = createMockLabelWebhookBody({
      action: 'unlabeled',
      changedLabel: 'lifecycle-deploy!',
      allLabels: [],
    });

    await githubService.handleLabelWebhook(body);

    expect(mockIsLifecycleLabel).toHaveBeenCalledWith('lifecycle-deploy!');
    expect(mockDb.services.BuildService.deleteBuild).toHaveBeenCalledWith(mockPr.build);
  });

  test('should delete build when disabled label is added', async () => {
    mockIsLifecycleLabel.mockResolvedValue(true);
    mockHasDeployLabel.mockResolvedValue(true);
    mockEnableKillSwitch.mockResolvedValue(true);

    const mockPr = createMockPullRequest({ deployOnUpdate: false });
    mockDb.models.PullRequest.findOne.mockResolvedValue(mockPr);

    const body = createMockLabelWebhookBody({
      action: 'labeled',
      changedLabel: 'lifecycle-disabled!',
      allLabels: [{ name: 'lifecycle-deploy!' }, { name: 'lifecycle-disabled!' }],
    });

    await githubService.handleLabelWebhook(body);

    expect(mockIsLifecycleLabel).toHaveBeenCalledWith('lifecycle-disabled!');
    expect(mockDb.services.BuildService.deleteBuild).toHaveBeenCalledWith(mockPr.build);
  });

  test('should return early when PR is not found in database', async () => {
    mockIsLifecycleLabel.mockResolvedValue(true);
    mockDb.models.PullRequest.findOne.mockResolvedValue(null);

    const body = createMockLabelWebhookBody({
      changedLabel: 'lifecycle-deploy!',
      allLabels: [{ name: 'lifecycle-deploy!' }],
    });

    await githubService.handleLabelWebhook(body);

    expect(mockDb.services.BuildService.resolveAndDeployBuildQueue.add).not.toHaveBeenCalled();
    expect(mockDb.services.BuildService.deleteBuild).not.toHaveBeenCalled();
  });

  test('should handle case-insensitive label names', async () => {
    mockIsLifecycleLabel.mockResolvedValue(false);

    const body = createMockLabelWebhookBody({
      changedLabel: 'Ready-For-Review',
      allLabels: [{ name: 'lifecycle-deploy!' }, { name: 'Ready-For-Review' }],
    });

    await githubService.handleLabelWebhook(body);

    expect(mockIsLifecycleLabel).toHaveBeenCalledWith('ready-for-review');
    expect(mockDb.models.PullRequest.findOne).not.toHaveBeenCalled();
  });
});
