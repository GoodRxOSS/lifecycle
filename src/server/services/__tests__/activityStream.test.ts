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

const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};
const mockApplyBuildOverrides = jest.fn();
const mockRegisterQueue = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockCommentQueueAdd = jest.fn();
const mockExtractContextForQueue = jest.fn();
const mockFastlyGetServiceDashboardUrl = jest.fn();
const mockFastlyGetServiceId = jest.fn();
const mockFastlyPurgeAllServiceCache = jest.fn();
const mockHasDeployLabel = jest.fn();
const mockHasStatusCommentLabel = jest.fn();
const mockIsControlCommentsEnabled = jest.fn();
const mockIsDefaultStatusCommentsEnabled = jest.fn();
const mockCheckIfCommentExists = jest.fn();
const mockCreateOrUpdatePullRequestComment = jest.fn();
const mockFindPullRequest = jest.fn();
const mockProcessActivityStreamUpdate = jest.fn();
const mockEnqueueResolveAndDeployBuild = jest.fn();
const mockIsBotUser = jest.fn();
const mockRedisDel = jest.fn();
const mockRedlockLock = jest.fn();
const mockUnlock = jest.fn();
const mockRenderDashboardMarkdown = jest.fn();
const mockDetermineChartType = jest.fn();
const mockIsStaging = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: {
    getConnection: jest.fn(),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
  withLogContext: jest.fn((_context, fn) => fn()),
  extractContextForQueue: (...args: unknown[]) => mockExtractContextForQueue(...args),
  LogStage: {},
}));

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'generated-run-uuid'),
}));

jest.mock('shared/config', () => ({
  LIFECYCLE_UI_URL: 'https://lifecycle.example.com',
  QUEUE_NAMES: {
    COMMENT_QUEUE: 'comment',
  },
}));

jest.mock('server/lib/fastly', () =>
  jest.fn().mockImplementation(() => ({
    getServiceDashboardUrl: (...args: unknown[]) => mockFastlyGetServiceDashboardUrl(...args),
    getFastlyServiceId: (...args: unknown[]) => mockFastlyGetServiceId(...args),
    purgeAllServiceCache: (...args: unknown[]) => mockFastlyPurgeAllServiceCache(...args),
  }))
);

jest.mock('server/lib/metrics', () => ({
  Metrics: jest.fn().mockImplementation(() => ({
    increment: jest.fn().mockReturnThis(),
    event: jest.fn().mockReturnThis(),
  })),
}));

jest.mock('server/lib/nativeHelm', () => ({
  ChartType: { LOCAL: 'local', ORG_CHART: 'org', PUBLIC: 'public' },
  determineChartType: (...args: unknown[]) => mockDetermineChartType(...args),
}));

jest.mock('server/lib/utils', () => ({
  enableKillSwitch: jest.fn(),
  flattenObject: jest.fn((value) => value),
  getDeployLabel: jest.fn().mockResolvedValue('lifecycle-deploy!'),
  getDisabledLabel: jest.fn().mockResolvedValue('lifecycle-disabled!'),
  getStatusCommentLabel: jest.fn().mockResolvedValue('lifecycle-status-comments!'),
  hasDeployLabel: (...args: unknown[]) => mockHasDeployLabel(...args),
  hasStatusCommentLabel: (...args: unknown[]) => mockHasStatusCommentLabel(...args),
  isControlCommentsEnabled: (...args: unknown[]) => mockIsControlCommentsEnabled(...args),
  isDefaultStatusCommentsEnabled: (...args: unknown[]) => mockIsDefaultStatusCommentsEnabled(...args),
  isStaging: (...args: unknown[]) => mockIsStaging(...args),
}));

jest.mock('server/lib/github', () => ({
  checkIfCommentExists: (...args: unknown[]) => mockCheckIfCommentExists(...args),
  createOrUpdatePullRequestComment: (...args: unknown[]) => mockCreateOrUpdatePullRequestComment(...args),
}));

jest.mock('server/lib/kubernetes', () => ({
  deleteNamespace: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
      getOrgChartName: jest.fn(),
    })),
  },
}));

jest.mock('server/services/deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    hostForDeployableDeploy: jest.fn(),
  })),
}));

jest.mock('server/services/buildMetadata', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    renderDashboardMarkdown: (...args: unknown[]) => mockRenderDashboardMarkdown(...args),
  })),
}));

jest.mock('../override', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    applyBuildOverrides: (...args: unknown[]) => mockApplyBuildOverrides(...args),
  })),
}));

import ActivityStream from '../activityStream';
import { BuildKind, BuildStatus, CommentParser, DeployStatus, DeployTypes, PullRequestStatus } from 'shared/constants';

function createActivityStream(overrides: { db?: any; redis?: any; redlock?: any } = {}) {
  mockRegisterQueue.mockReturnValue({
    add: mockCommentQueueAdd,
  });

  const db = overrides.db || {
    models: {
      PullRequest: {
        findOne: mockFindPullRequest,
      },
    },
    services: {
      ActivityStream: {
        updatePullRequestActivityStream: mockProcessActivityStreamUpdate,
      },
      BotUser: {
        isBotUser: mockIsBotUser,
      },
      BuildService: {
        enqueueResolveAndDeployBuild: mockEnqueueResolveAndDeployBuild,
      },
      Deploy: {
        hostForDeployableDeploy: jest.fn(),
      },
    },
  };

  return new ActivityStream(
    db as any,
    (overrides.redis || { del: mockRedisDel }) as any,
    (overrides.redlock || { lock: mockRedlockLock }) as any,
    {
      registerQueue: mockRegisterQueue,
    } as any
  );
}

function createBuild(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    uuid: 'build-uuid',
    kind: BuildKind.ENVIRONMENT,
    status: BuildStatus.QUEUED,
    isStatic: false,
    enabledFeatures: [],
    trackDefaultBranches: false,
    commentRuntimeEnv: {},
    deploys: [],
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createPullRequest(overrides: Record<string, unknown> = {}) {
  const patch = jest.fn().mockResolvedValue(undefined);
  return {
    id: 17,
    fullName: 'lifecycle/example',
    branchName: 'feature/activity-stream',
    pullRequestNumber: 23,
    labels: [],
    status: PullRequestStatus.OPEN,
    deployOnUpdate: true,
    githubLogin: 'developer',
    $query: jest.fn(() => ({ patch })),
    patch,
    ...overrides,
  };
}

function createDeploy({ deployable, ...overrides }: Record<string, any> = {}) {
  return {
    id: 1,
    uuid: 'api-deploy',
    active: true,
    branchName: 'feature/activity-stream',
    publicUrl: 'api.services.example.com',
    status: DeployStatus.BUILDING,
    deployable: {
      name: 'api',
      type: DeployTypes.GITHUB,
      active: true,
      public: true,
      dependsOnServiceId: null,
      hostPortMapping: null,
      repositoryId: 10,
      repository: { fullName: 'lifecycle/api' },
      ...deployable,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDetermineChartType.mockResolvedValue('public');
  mockIsStaging.mockReturnValue(false);
  mockGetAllConfigs.mockResolvedValue({
    domainDefaults: { http: 'services.example.com', grpc: 'grpc.example.com' },
  });
  mockExtractContextForQueue.mockReturnValue({ correlationId: 'correlation-id' });
  mockFastlyGetServiceDashboardUrl.mockResolvedValue(null);
  mockFastlyGetServiceId.mockResolvedValue(null);
  mockFastlyPurgeAllServiceCache.mockResolvedValue(undefined);
  mockHasDeployLabel.mockResolvedValue(false);
  mockHasStatusCommentLabel.mockResolvedValue(false);
  mockIsControlCommentsEnabled.mockResolvedValue(true);
  mockIsDefaultStatusCommentsEnabled.mockResolvedValue(false);
  mockCheckIfCommentExists.mockResolvedValue(null);
  mockCreateOrUpdatePullRequestComment.mockResolvedValue({
    data: { id: 501 },
    headers: { etag: 'new-etag' },
  });
  mockIsBotUser.mockResolvedValue(false);
  mockRedlockLock.mockResolvedValue({ unlock: mockUnlock });
  mockUnlock.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(1);
  mockRenderDashboardMarkdown.mockResolvedValue('dashboard details\n');
});

describe('ActivityStream comment overrides', () => {
  it('parses comment overrides and delegates structured updates to OverrideService', async () => {
    const service = createActivityStream();
    const build = {
      id: 42,
      uuid: 'current-build',
    };
    const deploys = [{ id: 1 }];
    const pullRequest = {
      deployOnUpdate: true,
    };
    const commentBody = [
      CommentParser.HEADER,
      '- [x] api: feature/api',
      '- [ ] cache: main',
      'url: new-build',
      'ENV:FEATURE_ENABLED:true',
      CommentParser.FOOTER,
      '- [x] Redeploy on pushes to default branches',
    ].join('\n');

    await (service as any).applyCommentOverrides({
      build,
      deploys,
      pullRequest,
      commentBody,
      runUuid: 'run-uuid',
    });

    expect(mockApplyBuildOverrides).toHaveBeenCalledWith({
      build,
      deploys,
      pullRequest,
      runUuid: 'run-uuid',
      overrides: {
        serviceOverrides: [
          {
            active: true,
            serviceName: 'api',
            branchOrExternalUrl: 'feature/api',
          },
          {
            active: false,
            serviceName: 'cache',
            branchOrExternalUrl: 'main',
          },
        ],
        vanityUrl: 'new-build',
        envOverrides: {
          FEATURE_ENABLED: 'true',
        },
        redeployOnPush: true,
      },
    });
  });

  it('does not delegate when build id is missing', async () => {
    const service = createActivityStream();
    const commentBody = [CommentParser.HEADER, '- [x] api: feature/api', CommentParser.FOOTER].join('\n');

    await (service as any).applyCommentOverrides({
      build: {
        uuid: 'current-build',
      },
      deploys: [],
      pullRequest: {},
      commentBody,
      runUuid: 'run-uuid',
    });

    expect(mockApplyBuildOverrides).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith('Build: missing for comment edit overrides');
  });

  it('uses the configured local public scheme in the PR environment table', async () => {
    const service = createActivityStream();
    const build = {
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      deploys: [
        {
          id: 1,
          active: true,
          branchName: 'main',
          publicUrl: 'app-calm-waterfall-156345.127.0.0.1.nip.io',
          deployable: {
            name: 'app',
            type: 'github',
            public: true,
            hostPortMapping: null,
          },
        },
      ],
    };
    mockGetAllConfigs.mockResolvedValue({
      domainDefaults: { http: '127.0.0.1.nip.io', grpc: '127.0.0.1.nip.io' },
    });

    const block = await (service as any).environmentBlock(build);

    expect(block).toContain('| app | main | http://app-calm-waterfall-156345.127.0.0.1.nip.io|');
    expect(block).not.toContain('https://app-calm-waterfall-156345.127.0.0.1.nip.io');
  });

  it('still renders the PR environment table when config lookup fails', async () => {
    const service = createActivityStream();
    const build = {
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      deploys: [
        {
          id: 1,
          active: true,
          branchName: 'main',
          publicUrl: 'app.example.com',
          deployable: {
            name: 'app',
            type: 'github',
            public: true,
            hostPortMapping: null,
          },
        },
      ],
    };
    mockGetAllConfigs.mockRejectedValueOnce(new Error('config unavailable'));

    const block = await (service as any).environmentBlock(build);

    expect(block).toContain('| app | main | https://app.example.com|');
  });

  it('keeps PR environment rows readable when a public host is not available yet', async () => {
    const service = createActivityStream();
    const build = {
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      deploys: [
        {
          id: 1,
          active: true,
          branchName: 'main',
          publicUrl: null,
          deployable: {
            name: 'app',
            type: 'github',
            public: true,
            hostPortMapping: { admin: 3000 },
          },
        },
      ],
    };

    const block = await (service as any).environmentBlock(build);

    expect(block).toContain('| admin-app | main | |');
    expect(block).not.toContain('null');
    expect(block).not.toContain('undefined');
  });

  it('exposes private local charts while keeping private public charts out of the environment table', async () => {
    const service = createActivityStream();
    const publicChart = createDeploy({
      id: 1,
      publicUrl: 'hidden.example.com',
      deployable: { name: 'hidden-chart', type: DeployTypes.HELM, public: false, repositoryId: null },
    });
    const localChart = createDeploy({
      id: 2,
      branchName: 'main',
      publicUrl: 'local-chart.example.com',
      deployable: {
        name: 'local-chart',
        type: DeployTypes.HELM,
        public: false,
        repositoryId: 10,
        repository: { fullName: 'lifecycle/local-chart' },
      },
    });
    mockDetermineChartType.mockImplementation(async (deploy) => (deploy.id === 1 ? 'public' : 'local'));
    const build = createBuild({ deploys: [publicChart, localChart] });

    const block = await (service as any).environmentBlock(build);

    expect(block).not.toContain('hidden-chart');
    expect(block).toContain(
      '| [local-chart](https://github.com/lifecycle/local-chart/tree/main) | main | https://local-chart.example.com|'
    );
  });
});

describe('ActivityStream.processComments', () => {
  it('loads the current pull request graph and performs an immediate activity stream update', async () => {
    const service = createActivityStream();
    const build = createBuild({ deploys: [{ id: 1 }] });
    const repository = { githubInstallationId: 99 };
    const pullRequest = createPullRequest({ build, repository, $fetchGraph: jest.fn().mockResolvedValue(undefined) });
    mockFindPullRequest.mockResolvedValue(pullRequest);

    await service.processComments({
      data: {
        id: 17,
        sender: 'worker',
        correlationId: 'correlation-id',
        _ddTraceContext: { traceId: 'trace-id' },
        targetGithubRepositoryId: 321,
      },
    });

    expect(mockFindPullRequest).toHaveBeenCalledWith({ id: 17 });
    expect(pullRequest.$fetchGraph).toHaveBeenCalledWith('[build.[deploys.[deployable]], repository]');
    expect(mockProcessActivityStreamUpdate).toHaveBeenCalledWith(
      build,
      build.deploys,
      pullRequest,
      repository,
      true,
      true,
      null,
      false,
      321
    );
    expect(mockLogger.debug).toHaveBeenCalledWith('Comment updated for PR 17');
  });

  it('treats a build without loaded deployments as an empty deployment list', async () => {
    const service = createActivityStream();
    const build = createBuild({ deploys: undefined });
    const repository = { githubInstallationId: 99 };
    const pullRequest = createPullRequest({ build, repository, $fetchGraph: jest.fn().mockResolvedValue(undefined) });
    mockFindPullRequest.mockResolvedValue(pullRequest);

    await service.processComments({ data: { id: 17, sender: 'worker', correlationId: 'correlation-id' } });

    expect(mockProcessActivityStreamUpdate).toHaveBeenCalledWith(
      build,
      [],
      pullRequest,
      repository,
      true,
      true,
      null,
      false,
      undefined
    );
  });

  it('does not enqueue an update when the pull request no longer has a build', async () => {
    const service = createActivityStream();
    const pullRequest = createPullRequest({ build: null, $fetchGraph: jest.fn().mockResolvedValue(undefined) });
    mockFindPullRequest.mockResolvedValue(pullRequest);

    await expect(
      service.processComments({ data: { id: 17, sender: 'worker', correlationId: 'correlation-id' } })
    ).resolves.toBeUndefined();

    expect(mockProcessActivityStreamUpdate).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith('Build: id not found pullRequestId=17');
  });

  it('logs processing failures without failing the comment worker job', async () => {
    const service = createActivityStream();
    const error = new Error('database unavailable');
    mockFindPullRequest.mockRejectedValueOnce(error);

    await expect(
      service.processComments({ data: { id: 17, sender: 'worker', correlationId: 'correlation-id' } })
    ).resolves.toBeUndefined();

    expect(mockProcessActivityStreamUpdate).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith({ error }, 'Comment: processing failed pullRequestId=17');
  });
});

describe('ActivityStream.updateBuildsAndDeploysFromCommentEdit', () => {
  function createCommentEditFixture() {
    const service = createActivityStream();
    const deploys = [{ id: 1 }];
    const build = createBuild({ deploys });
    const repository = { githubInstallationId: 99 };
    const pullRequest = createPullRequest({
      build,
      repository,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    });
    const updateSpy = jest.spyOn(service, 'updatePullRequestActivityStream').mockResolvedValue(undefined);
    return { service, build, deploys, repository, pullRequest, updateSpy };
  }

  it.each(['#REDEPLOY', '[x] Redeploy Environment'])(
    'redeploys for the supported comment action %s',
    async (action) => {
      const { service, build, deploys, repository, pullRequest, updateSpy } = createCommentEditFixture();

      await service.updateBuildsAndDeploysFromCommentEdit(pullRequest as any, action);

      expect(mockEnqueueResolveAndDeployBuild).toHaveBeenCalledWith({
        buildId: build.id,
        runUUID: 'generated-run-uuid',
      });
      expect(mockApplyBuildOverrides).not.toHaveBeenCalled();
      expect(mockFastlyGetServiceId).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith(build, deploys, pullRequest, repository, true, true, null, true);
    }
  );

  it('purges each available Fastly service and refreshes the comment without a status update', async () => {
    const { service, build, deploys, repository, pullRequest, updateSpy } = createCommentEditFixture();
    mockFastlyGetServiceId
      .mockResolvedValueOnce('compute-shield-id')
      .mockResolvedValueOnce('optimizely-id')
      .mockResolvedValueOnce('fastly-id');

    await service.updateBuildsAndDeploysFromCommentEdit(pullRequest as any, '[x] Purge Fastly Service Cache');

    expect(mockFastlyGetServiceId).toHaveBeenNthCalledWith(1, build.uuid, 'compute-shield');
    expect(mockFastlyGetServiceId).toHaveBeenNthCalledWith(2, build.uuid, 'optimizely');
    expect(mockFastlyGetServiceId).toHaveBeenNthCalledWith(3, build.uuid, 'fastly');
    expect(mockFastlyPurgeAllServiceCache).toHaveBeenNthCalledWith(1, 'compute-shield-id', build.uuid, 'fastly');
    expect(mockFastlyPurgeAllServiceCache).toHaveBeenNthCalledWith(2, 'optimizely-id', build.uuid, 'optimizely');
    expect(mockFastlyPurgeAllServiceCache).toHaveBeenNthCalledWith(3, 'fastly-id', build.uuid, 'fastly');
    expect(mockEnqueueResolveAndDeployBuild).not.toHaveBeenCalled();
    expect(mockApplyBuildOverrides).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith(build, deploys, pullRequest, repository, true, false, null, true);
  });

  it('contains Fastly purge failures and still refreshes the comment', async () => {
    const { service, build, deploys, repository, pullRequest, updateSpy } = createCommentEditFixture();
    const error = new Error('Fastly unavailable');
    mockFastlyGetServiceId.mockRejectedValueOnce(error);

    await service.updateBuildsAndDeploysFromCommentEdit(pullRequest as any, '[x] Purge Fastly Service Cache');

    expect(mockLogger.error).toHaveBeenCalledWith({ error }, 'Fastly: cache purge failed');
    expect(updateSpy).toHaveBeenCalledWith(build, deploys, pullRequest, repository, true, false, null, true);
  });

  it('applies parsed overrides and then refreshes both comment surfaces', async () => {
    const { service, build, deploys, repository, pullRequest, updateSpy } = createCommentEditFixture();
    const commentBody = [
      CommentParser.HEADER,
      '- [x] api: feature/api',
      'ENV:FEATURE_ENABLED:true',
      CommentParser.FOOTER,
    ].join('\n');

    await service.updateBuildsAndDeploysFromCommentEdit(pullRequest as any, commentBody);

    expect(mockApplyBuildOverrides).toHaveBeenCalledWith({
      build,
      deploys,
      pullRequest,
      runUuid: 'generated-run-uuid',
      overrides: {
        serviceOverrides: [{ active: true, serviceName: 'api', branchOrExternalUrl: 'feature/api' }],
        vanityUrl: null,
        envOverrides: { FEATURE_ENABLED: 'true' },
        redeployOnPush: false,
      },
    });
    expect(updateSpy).toHaveBeenCalledWith(build, deploys, pullRequest, repository, true, true, null, true);
  });

  it('still refreshes the comments when applying overrides fails, then preserves the original failure', async () => {
    const { service, build, deploys, repository, pullRequest, updateSpy } = createCommentEditFixture();
    const error = new Error('override failed');
    mockApplyBuildOverrides.mockRejectedValueOnce(error);

    const commentBody = [CommentParser.HEADER, '- [x] api: feature/api', CommentParser.FOOTER].join('\n');
    await expect(service.updateBuildsAndDeploysFromCommentEdit(pullRequest as any, commentBody)).rejects.toBe(error);

    expect(updateSpy).toHaveBeenCalledWith(build, deploys, pullRequest, repository, true, true, null, true);
  });

  it('does not fail the completed action when the final comment refresh fails', async () => {
    const { service, pullRequest, updateSpy } = createCommentEditFixture();
    const error = new Error('GitHub unavailable');
    updateSpy.mockRejectedValueOnce(error);

    await expect(
      service.updateBuildsAndDeploysFromCommentEdit(pullRequest as any, '#REDEPLOY')
    ).resolves.toBeUndefined();

    expect(mockEnqueueResolveAndDeployBuild).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith({ error }, 'ActivityFeed: comment edit update failed');
  });
});

describe('ActivityStream.updatePullRequestActivityStream', () => {
  const repository = { githubInstallationId: 99 };

  async function renderStatusComment({
    status,
    deployOnUpdate = true,
    deploys = [],
    buildOverrides = {},
  }: {
    status: BuildStatus;
    deployOnUpdate?: boolean;
    deploys?: any[];
    buildOverrides?: Record<string, unknown>;
  }) {
    const service = createActivityStream();
    const build = createBuild({ status, isStatic: true, deploys, ...buildOverrides });
    const pullRequest = createPullRequest({ deployOnUpdate });
    mockIsControlCommentsEnabled.mockResolvedValueOnce(false);

    await service.updatePullRequestActivityStream(
      build as any,
      deploys,
      pullRequest as any,
      repository as any,
      false,
      true,
      null,
      false
    );

    return {
      build,
      pullRequest,
      message: mockCreateOrUpdatePullRequestComment.mock.calls[0][0].message as string,
    };
  }

  async function renderMissionControlComment({
    status,
    deployOnUpdate = true,
    deploys = [],
    buildOverrides = {},
  }: {
    status: BuildStatus | string;
    deployOnUpdate?: boolean;
    deploys?: any[];
    buildOverrides?: Record<string, unknown>;
  }) {
    const service = createActivityStream();
    const build = createBuild({ status, deploys, ...buildOverrides });
    const pullRequest = createPullRequest({ deployOnUpdate });

    await service.updatePullRequestActivityStream(
      build as any,
      deploys,
      pullRequest as any,
      repository as any,
      true,
      false,
      null,
      false
    );

    return {
      build,
      pullRequest,
      message: mockCreateOrUpdatePullRequestComment.mock.calls[0][0].message as string,
    };
  }

  it('ignores sandbox builds before consulting comment settings or acquiring a lock', async () => {
    const service = createActivityStream();

    await service.updatePullRequestActivityStream(
      createBuild({ kind: BuildKind.SANDBOX }) as any,
      [],
      createPullRequest() as any,
      repository as any,
      true,
      true
    );

    expect(mockHasStatusCommentLabel).not.toHaveBeenCalled();
    expect(mockRedlockLock).not.toHaveBeenCalled();
    expect(mockCommentQueueAdd).not.toHaveBeenCalled();
  });

  it('rejects a build without an id before acquiring a lock', async () => {
    const service = createActivityStream();
    const pullRequest = createPullRequest();

    await expect(
      service.updatePullRequestActivityStream(
        createBuild({ id: undefined }) as any,
        [],
        pullRequest as any,
        repository as any,
        true,
        true
      )
    ).rejects.toThrow('No build ID found for this build!');

    expect(mockLogger.error).toHaveBeenCalledWith(
      `Build: id not found repo=${pullRequest.fullName}/${pullRequest.branchName}`
    );
    expect(mockRedlockLock).not.toHaveBeenCalled();
  });

  it('queues a deduplicated update with trace context and releases the build lock', async () => {
    const service = createActivityStream();
    const build = createBuild();
    const pullRequest = createPullRequest();

    await service.updatePullRequestActivityStream(
      build as any,
      [],
      pullRequest as any,
      repository as any,
      true,
      true,
      null,
      true,
      321
    );

    expect(mockRedlockLock).toHaveBeenCalledWith(`build.${build.id}`, 9000);
    expect(mockCommentQueueAdd).toHaveBeenCalledWith(
      'comment',
      { id: pullRequest.id, targetGithubRepositoryId: 321, correlationId: 'correlation-id' },
      { jobId: `pr-${pullRequest.id}`, removeOnComplete: true, removeOnFail: true }
    );
    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });

  it('logs a queue failure and still releases the build lock', async () => {
    const service = createActivityStream();
    const build = createBuild();
    const pullRequest = createPullRequest();
    const error = new Error('queue unavailable');
    mockCommentQueueAdd.mockRejectedValueOnce(error);

    await expect(
      service.updatePullRequestActivityStream(build as any, [], pullRequest as any, repository as any, true, true)
    ).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      { error },
      `ActivityFeed: update failed repo=${pullRequest.fullName}/${pullRequest.branchName}`
    );
    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });

  it('uses an error update to bypass the queue and perform the requested immediate work', async () => {
    const service = createActivityStream();
    const build = createBuild();

    await service.updatePullRequestActivityStream(
      build as any,
      [],
      createPullRequest() as any,
      repository as any,
      false,
      false,
      new Error('build failed'),
      true
    );

    expect(mockCommentQueueAdd).not.toHaveBeenCalled();
    expect(mockIsControlCommentsEnabled).not.toHaveBeenCalled();
    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });

  it('logs lock acquisition failures without attempting work or unlock', async () => {
    const service = createActivityStream();
    const build = createBuild();
    const pullRequest = createPullRequest();
    const error = new Error('lock unavailable');
    mockRedlockLock.mockRejectedValueOnce(error);

    await expect(
      service.updatePullRequestActivityStream(build as any, [], pullRequest as any, repository as any, true, true)
    ).resolves.toBeUndefined();

    expect(mockCommentQueueAdd).not.toHaveBeenCalled();
    expect(mockUnlock).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      { error },
      `ActivityFeed: update failed repo=${pullRequest.fullName}/${pullRequest.branchName}`
    );
  });

  it('force-releases the Redis lock when Redlock cannot unlock it', async () => {
    const service = createActivityStream();
    const build = createBuild();
    mockUnlock.mockRejectedValueOnce(new Error('unlock failed'));

    await service.updatePullRequestActivityStream(
      build as any,
      [],
      createPullRequest() as any,
      repository as any,
      false,
      false,
      null,
      false
    );

    expect(mockRedisDel).toHaveBeenCalledWith(`build.${build.id}`);
  });

  it('logs when both normal and forced lock release fail', async () => {
    const service = createActivityStream();
    const build = createBuild();
    const pullRequest = createPullRequest();
    const error = new Error('redis unavailable');
    mockUnlock.mockRejectedValueOnce(new Error('unlock failed'));
    mockRedisDel.mockRejectedValueOnce(error);

    await service.updatePullRequestActivityStream(
      build as any,
      [],
      pullRequest as any,
      repository as any,
      false,
      false,
      null,
      false
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      { error },
      `Lock: force unlock failed resource=build.${build.id} repo=${pullRequest.fullName}/${pullRequest.branchName}`
    );
  });

  it('does not consult control-comment settings when neither comment surface was requested', async () => {
    const service = createActivityStream();

    await service.updatePullRequestActivityStream(
      createBuild() as any,
      [],
      createPullRequest() as any,
      repository as any,
      false,
      false,
      null,
      false
    );

    expect(mockIsControlCommentsEnabled).not.toHaveBeenCalled();
    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  it('honors disabled Mission Control comments', async () => {
    const service = createActivityStream();
    mockIsControlCommentsEnabled.mockResolvedValueOnce(false);

    await service.updatePullRequestActivityStream(
      createBuild() as any,
      [],
      createPullRequest() as any,
      repository as any,
      true,
      false,
      null,
      false
    );

    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith('Mission control comments are disabled');
  });

  it('recovers and persists a missing Mission Control comment id while rendering the current build state', async () => {
    const service = createActivityStream();
    const build = createBuild();
    const pullRequest = createPullRequest();
    mockCheckIfCommentExists.mockResolvedValueOnce({ id: 88 });

    await service.updatePullRequestActivityStream(
      build as any,
      [],
      pullRequest as any,
      repository as any,
      true,
      false,
      null,
      false
    );

    expect(mockCheckIfCommentExists).toHaveBeenCalledWith({
      fullName: pullRequest.fullName,
      pullRequestNumber: pullRequest.pullRequestNumber,
      commentIdentifier: 'mission control comment: enabled',
    });
    expect(mockCreateOrUpdatePullRequestComment).toHaveBeenCalledWith({
      installationId: repository.githubInstallationId,
      pullRequestNumber: pullRequest.pullRequestNumber,
      fullName: pullRequest.fullName,
      message: expect.stringContaining('### 💻✨ Your environment is pending ⏳.'),
      commentId: 88,
      etag: undefined,
    });
    expect(mockCreateOrUpdatePullRequestComment.mock.calls[0][0].message).toContain(
      'To deploy this environment, just add a `lifecycle-deploy!` label.'
    );
    expect(mockCreateOrUpdatePullRequestComment.mock.calls[0][0].message).toContain('## ✏️ Environment Overrides');
    expect(mockCreateOrUpdatePullRequestComment.mock.calls[0][0].message).toContain('mission control comment: enabled');
    expect(pullRequest.patch).toHaveBeenNthCalledWith(1, { commentId: 88 });
    expect(pullRequest.patch).toHaveBeenNthCalledWith(2, { commentId: 501, etag: 'new-etag' });
    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });

  it('uses staging-specific identifiers in both persisted comment surfaces', async () => {
    const service = createActivityStream();
    const build = createBuild({ isStatic: true });
    const pullRequest = createPullRequest();
    mockIsStaging.mockReturnValue(true);

    await service.updatePullRequestActivityStream(
      build as any,
      [],
      pullRequest as any,
      repository as any,
      true,
      true,
      null,
      false
    );

    expect(mockCheckIfCommentExists).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ commentIdentifier: 'mission control stg comment: enabled' })
    );
    expect(mockCheckIfCommentExists).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ commentIdentifier: 'stg status comment: enabled' })
    );
    expect(mockCreateOrUpdatePullRequestComment.mock.calls[0][0].message).toContain(
      'mission control stg comment: enabled'
    );
    expect(mockCreateOrUpdatePullRequestComment.mock.calls[1][0].message).toContain('stg status comment: enabled');
  });

  it('renders the editable service, environment, feature, and action controls in Mission Control', async () => {
    mockFastlyGetServiceDashboardUrl.mockResolvedValueOnce('https://manage.fastly.example/service');
    const deploys = [
      createDeploy({
        id: 1,
        uuid: 'fastly-edge',
        deployable: { name: 'github-service', type: DeployTypes.GITHUB },
      }),
      createDeploy({
        id: 2,
        publicUrl: 'https://external.example.com',
        deployable: { name: 'external-service', type: DeployTypes.EXTERNAL_HTTP },
      }),
      createDeploy({
        id: 3,
        deployable: { name: 'configuration-service', type: DeployTypes.CONFIGURATION },
      }),
      createDeploy({ id: 4, deployable: { name: 'codefresh-service', type: DeployTypes.CODEFRESH } }),
      createDeploy({
        id: 5,
        deployable: {
          name: 'docker-service',
          type: DeployTypes.DOCKER,
          dockerImage: 'example/image',
          defaultTag: 'stable',
        },
      }),
      createDeploy({ id: 6, deployable: { name: 'helm-service', type: DeployTypes.HELM } }),
      createDeploy({
        id: 7,
        active: false,
        deployable: { name: 'optional-service', type: DeployTypes.EXTERNAL_HTTP, active: false },
      }),
      createDeploy({
        id: 8,
        deployable: { name: 'internal-service', type: DeployTypes.GITHUB, dependsOnServiceId: 1 },
      }),
    ];

    const { message } = await renderMissionControlComment({
      status: BuildStatus.QUEUED,
      deploys,
      buildOverrides: {
        enabledFeatures: ['preview-routing'],
        trackDefaultBranches: true,
        commentRuntimeEnv: { FEATURE_ENABLED: 'true' },
      },
    });

    expect(message).toContain('* LC testing features: preview-routing');
    expect(message).toContain('- [x] github-service: feature/activity-stream');
    expect(message).toContain('- [x] external-service: https://external.example.com');
    expect(message).toContain('- [x] configuration-service: feature/activity-stream');
    expect(message).toContain('- [x] codefresh-service: feature/activity-stream');
    expect(message).toContain('- [x] docker-service: example/image@stable');
    expect(message).toContain('- [x] helm-service: feature/activity-stream');
    expect(message).toContain('- [ ] optional-service: api.services.example.com');
    expect(message).not.toContain('internal-service: feature/activity-stream');
    expect(message).toContain('ENV:FEATURE_ENABLED:true');
    expect(message).toContain('- [ ] Purge Fastly Service Cache');
    expect(message).toContain('- [x] Redeploy on pushes to default branches');
  });

  it('persists the primary Mission Control state when optional editor and environment sections fail', async () => {
    const editorError = new Error('editor graph unavailable');
    const environmentError = new Error('environment graph unavailable');
    const fetchGraph = jest.fn((graph: string) => {
      if (graph === '[deploys.[deployable]]') return Promise.reject(editorError);
      if (graph === '[deploys.[deployable.repository]]') return Promise.reject(environmentError);
      return Promise.resolve();
    });

    const { message } = await renderMissionControlComment({
      status: BuildStatus.DEPLOYED,
      buildOverrides: { $fetchGraph: fetchGraph },
    });

    expect(message).toContain('### 💻✨ Your environment is deployed ✅.');
    expect(message).toContain('mission control comment: enabled');
    expect(mockLogger.error).toHaveBeenCalledWith({ error: editorError }, 'Comment: mission control generation failed');
    expect(mockLogger.error).toHaveBeenCalledWith({ error: environmentError }, 'Comment: env block generation failed');
  });

  it('contains a Mission Control rendering failure and releases the build lock', async () => {
    const service = createActivityStream();
    const build = createBuild();
    const pullRequest = createPullRequest();
    const error = new Error('label lookup unavailable');
    mockHasDeployLabel.mockRejectedValueOnce(error);

    await service.updatePullRequestActivityStream(
      build as any,
      [],
      pullRequest as any,
      repository as any,
      true,
      false,
      null,
      false
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      { error },
      `Comment: mission control generation failed repo=${pullRequest.fullName}/${pullRequest.branchName}`
    );
    expect(mockCreateOrUpdatePullRequestComment).toHaveBeenCalledWith(expect.objectContaining({ message: '' }));
    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [BuildStatus.BUILDING, true, '### 💻✨ Your environment is building 🏗️.'],
    [BuildStatus.BUILT, false, '### 💻✨ Your environment is building 🏗️.'],
    [BuildStatus.DEPLOYING, true, '### 💻✨ Your environment is deploying 🚀.'],
    [BuildStatus.ERROR, true, '### 💻✨ Your environment deployed with an Error ⚠️.'],
    [BuildStatus.CONFIG_ERROR, true, '### 💻✨ Your environment has a configuration error ⚠️.'],
    [BuildStatus.DEPLOYED, true, '### 💻✨ Your environment is deployed ✅.'],
    ['unknown', true, '### 💻✨ Your environment has an uncaptured Status ⚠️.'],
  ])('renders the Mission Control state for build status %s', async (status, deployOnUpdate, expected) => {
    const { message } = await renderMissionControlComment({ status, deployOnUpdate });

    expect(message).toContain(expected);
  });

  it('reports a deployed build with active deployment errors as an error state', async () => {
    const deploys = [createDeploy({ status: DeployStatus.ERROR, active: true })];

    const { message } = await renderMissionControlComment({ status: BuildStatus.DEPLOYED, deploys });

    expect(message).toContain('### 💻✨ Your environment deployed with an Error ⚠️.');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Build: deployedWithErrors status=deployed deploys=')
    );
  });

  it('does not create a status comment when none of its enablement gates are active', async () => {
    const service = createActivityStream();
    mockIsControlCommentsEnabled.mockResolvedValueOnce(false);

    await service.updatePullRequestActivityStream(
      createBuild({ isStatic: false }) as any,
      [],
      createPullRequest() as any,
      repository as any,
      false,
      true,
      null,
      false
    );

    expect(mockHasStatusCommentLabel).toHaveBeenCalledWith([]);
    expect(mockIsDefaultStatusCommentsEnabled).toHaveBeenCalledWith('lifecycle/example');
    expect(mockCreateOrUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  it.each([
    ['a static build', true, false, false],
    ['the pull request status label', false, true, false],
    ['the repository default', false, false, true],
  ])('renders and persists a status comment enabled by %s', async (_source, isStatic, hasLabel, hasDefault) => {
    const service = createActivityStream();
    const build = createBuild({ isStatic });
    const pullRequest = createPullRequest();
    mockIsControlCommentsEnabled.mockResolvedValueOnce(false);
    mockHasStatusCommentLabel.mockResolvedValueOnce(hasLabel);
    mockIsDefaultStatusCommentsEnabled.mockResolvedValueOnce(hasDefault);
    mockCheckIfCommentExists.mockResolvedValueOnce({ id: 89 });

    await service.updatePullRequestActivityStream(
      build as any,
      [],
      pullRequest as any,
      repository as any,
      false,
      true,
      null,
      false
    );

    expect(mockCreateOrUpdatePullRequestComment).toHaveBeenCalledWith({
      installationId: repository.githubInstallationId,
      pullRequestNumber: pullRequest.pullRequestNumber,
      fullName: pullRequest.fullName,
      message: expect.stringContaining('## ⏳ Pending'),
      commentId: 89,
      etag: undefined,
    });
    expect(mockCreateOrUpdatePullRequestComment.mock.calls[0][0].message).toContain('status comment: enabled');
    expect(pullRequest.patch).toHaveBeenNthCalledWith(1, { statusCommentId: 89 });
    expect(pullRequest.patch).toHaveBeenNthCalledWith(2, { statusCommentId: 501, etag: 'new-etag' });
  });

  it('renders user-facing deployment states and supporting detail in status comments', async () => {
    const deploys = [createDeploy({ status: DeployStatus.READY })];

    const deploying = await renderStatusComment({ status: BuildStatus.DEPLOYING, deploys });

    expect(deploying.message).toContain('## 🚀 Deploying');
    expect(deploying.message).toContain('dashboard details');
    expect(deploying.message).toContain('### Lifecycle Environments');
  });

  it.each([
    [BuildStatus.BUILDING, true, '## 🏗️ Building', "We'll deploy your code once we've finished this build step."],
    [BuildStatus.BUILT, false, '## 🏗️ Building', 'To deploy this environment'],
    [BuildStatus.ERROR, true, '## ⚠️ Deployed with Error', 'dashboard details'],
    [BuildStatus.CONFIG_ERROR, true, '## ⚠️ Configuration Error', 'problem with the file'],
    [BuildStatus.DEPLOYED, true, '## ✅ Deployed', 'dashboard details'],
    [BuildStatus.PENDING, true, '## ⚠️ Unexpected Build Status', 'The build status is pending.'],
  ])(
    'renders the status-comment contract for build status %s',
    async (status, deployOnUpdate, expectedHeading, expectedDetail) => {
      const deploys = [createDeploy({ status: DeployStatus.READY })];

      const { message } = await renderStatusComment({ status, deployOnUpdate, deploys });

      expect(message).toContain(expectedHeading);
      expect(message).toContain(expectedDetail);
      expect(message).toContain('status comment: enabled');
    }
  );

  it.each([
    [BuildStatus.BUILDING, '## 🏗️ Building', false],
    [BuildStatus.DEPLOYING, '## 🚀 Deploying', true],
    [BuildStatus.ERROR, '## ⚠️ Deployed with Error', true],
    [BuildStatus.DEPLOYED, '## ✅ Deployed', true],
  ])(
    'persists a partial %s status comment when supplemental sections fail',
    async (status, expectedHeading, hasDashboard) => {
      const graphError = new Error('deployment graph unavailable');
      const dashboardError = new Error('dashboard unavailable');
      const fetchGraph = jest.fn((graph: string) =>
        graph === '[deploys.[deployable.repository]]' ? Promise.reject(graphError) : Promise.resolve()
      );
      if (hasDashboard) mockRenderDashboardMarkdown.mockRejectedValueOnce(dashboardError);

      const { message } = await renderStatusComment({
        status,
        deploys: [createDeploy()],
        buildOverrides: { $fetchGraph: fetchGraph },
      });

      expect(message).toContain(expectedHeading);
      expect(message).toContain('status comment: enabled');
      expect(mockLogger.error).toHaveBeenCalledWith({ error: graphError }, 'Comment: build status generation failed');
      expect(mockLogger.error).toHaveBeenCalledWith({ error: graphError }, 'Comment: env block generation failed');
      if (hasDashboard) {
        expect(mockLogger.error).toHaveBeenCalledWith(
          { error: dashboardError },
          'Comment: dashboard generation failed'
        );
      }
    }
  );

  it('uses the bot-specific pending guidance', async () => {
    mockIsBotUser.mockResolvedValueOnce(true);

    const { message } = await renderStatusComment({ status: BuildStatus.QUEUED });

    expect(message).toContain('This PR is created by a bot user, add lifecycle-deploy! to build environment');
    expect(message).not.toContain('lifecycle-disabled! label present');
  });

  it('maps each deployment status into the public build-status table', async () => {
    const statuses = [
      [DeployStatus.BUILDING, '🏗️ BUILDING'],
      [DeployStatus.BUILT, '👍 BUILT'],
      [DeployStatus.ERROR, '⚠️ ERROR'],
      [DeployStatus.CLONING, '⬇️ CLONING'],
      [DeployStatus.READY, '✅ READY'],
      [DeployStatus.DEPLOYING, '🚀 DEPLOYING'],
      [DeployStatus.DEPLOY_FAILED, '⚠️ FAILED'],
      [DeployStatus.QUEUED, '⏳ QUEUED'],
      [DeployStatus.WAITING, '⏳ WAITING'],
      [DeployStatus.BUILD_FAILED, '❌ BUILD FAILED'],
      [DeployStatus.DEPLOYED, DeployStatus.DEPLOYED],
    ] as const;
    const deploys = statuses.map(([status], index) =>
      createDeploy({
        id: index + 1,
        status,
        deployable: { name: `service-${index + 1}`, type: DeployTypes.GITHUB },
      })
    );
    deploys.push(
      createDeploy({
        id: deploys.length + 1,
        status: DeployStatus.READY,
        deployable: { name: 'codefresh-service', type: DeployTypes.CODEFRESH, repositoryId: null },
      }),
      createDeploy({
        id: deploys.length + 2,
        status: DeployStatus.READY,
        deployable: { name: 'restore-service', type: DeployTypes.AURORA_RESTORE, repositoryId: null },
      })
    );

    const { message } = await renderStatusComment({ status: BuildStatus.BUILDING, deploys });

    for (const [, expectedStatus] of statuses) {
      expect(message).toContain(`_${expectedStatus}_`);
    }
    expect(message).toContain('| codefresh-service | feature/activity-stream | _✅ READY_ |');
    expect(message).toContain('| restore-service || _✅ READY_ |');
  });

  it('contains Mission Control persistence failures and releases the lock', async () => {
    const service = createActivityStream();
    const build = createBuild();
    const pullRequest = createPullRequest();
    const error = new Error('GitHub unavailable');
    mockCreateOrUpdatePullRequestComment.mockRejectedValueOnce(error);

    await service.updatePullRequestActivityStream(
      build as any,
      [],
      pullRequest as any,
      repository as any,
      true,
      false,
      null,
      false
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      { error },
      `GitHub: mission control update failed repo=${pullRequest.fullName}/${pullRequest.branchName}`
    );
    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });

  it('contains status-comment lookup failures and releases the lock', async () => {
    const service = createActivityStream();
    const pullRequest = createPullRequest();
    const error = new Error('GitHub lookup unavailable');
    mockIsControlCommentsEnabled.mockResolvedValueOnce(false);
    mockCheckIfCommentExists.mockRejectedValueOnce(error);

    await service.updatePullRequestActivityStream(
      createBuild({ isStatic: true }) as any,
      [],
      pullRequest as any,
      repository as any,
      false,
      true,
      null,
      false
    );

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { error },
      `Comment: status update failed repo=${pullRequest.fullName}/${pullRequest.branchName} queued=`
    );
    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });
});
