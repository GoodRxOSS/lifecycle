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
import GithubService from '../github';
import RepositoryService from '../repository';
import * as github from 'server/lib/github';
import * as YamlService from 'server/models/yaml';
import { createOrUpdateGithubDeployment, deleteGithubDeploymentAndEnvironment } from 'server/lib/github/deployments';
import { PullRequestStatus } from 'shared/constants';
import { stringify as stringifyFlatted } from 'flatted';

mockRedisClient();

const mockIsLifecycleLabel = jest.fn();
const mockHasDeployLabel = jest.fn();
const mockEnableKillSwitch = jest.fn();
const mockIsStaging = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerFatal = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerDebug = jest.fn();

jest.mock('server/lib/utils', () => ({
  ...jest.requireActual('server/lib/utils'),
  isLifecycleLabel: (...args: unknown[]) => mockIsLifecycleLabel(...args),
  hasDeployLabel: (...args: unknown[]) => mockHasDeployLabel(...args),
  enableKillSwitch: (...args: unknown[]) => mockEnableKillSwitch(...args),
  isStaging: (...args: unknown[]) => mockIsStaging(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: mockLoggerError,
    fatal: mockLoggerFatal,
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    debug: mockLoggerDebug,
  })),
  withLogContext: jest.fn((_context, callback) => callback()),
  extractContextForQueue: jest.fn(() => ({ correlationId: 'test-correlation' })),
  LogStage: {
    WEBHOOK_PROCESSING: 'webhook_processing',
    DEPLOY_FAILED: 'deploy_failed',
    DEPLOY_STARTING: 'deploy_starting',
    DEPLOY_COMPLETE: 'deploy_complete',
  },
}));

jest.mock('server/lib/github', () => ({
  ...jest.requireActual('server/lib/github'),
  getYamlFileContent: jest.fn(),
  getChangedFilesFromPushPayload: jest.fn(),
  getChangedFilesForPush: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

jest.mock('server/models/yaml', () => ({
  ...jest.requireActual('server/models/yaml'),
  fetchLifecycleConfig: jest.fn(),
}));

jest.mock('server/lib/github/deployments', () => ({
  createOrUpdateGithubDeployment: jest.fn(),
  deleteGithubDeploymentAndEnvironment: jest.fn(),
}));

const mockVerifyWebhookSignature = github.verifyWebhookSignature as jest.Mock;
const mockGetYamlFileContent = github.getYamlFileContent as jest.Mock;
const mockGetChangedFilesFromPushPayload = github.getChangedFilesFromPushPayload as jest.Mock;
const mockGetChangedFilesForPush = github.getChangedFilesForPush as jest.Mock;
const mockFetchLifecycleConfig = YamlService.fetchLifecycleConfig as jest.Mock;
const mockCreateGithubDeployment = createOrUpdateGithubDeployment as jest.Mock;
const mockDeleteGithubDeployment = deleteGithubDeploymentAndEnvironment as jest.Mock;

function activeDeploysQuery(rows: unknown[]) {
  const query = {
    where: jest.fn(),
    whereNot: jest.fn(),
    withGraphFetched: jest.fn().mockResolvedValue(rows),
  };
  query.where.mockReturnValue(query);
  query.whereNot.mockReturnValue(query);
  return query;
}

function failedDeploysQuery(rows: unknown[]) {
  const query = {
    where: jest.fn(),
    whereIn: jest.fn().mockResolvedValue(rows),
  };
  query.where.mockReturnValue(query);
  return query;
}

function buildQueryResult(result: unknown) {
  const query = {
    whereIn: jest.fn(),
    andWhere: jest.fn(),
    first: jest.fn().mockResolvedValue(result),
  };
  query.whereIn.mockImplementation((_column, callback) => {
    const nested = {
      from: jest.fn(),
      select: jest.fn(),
      where: jest.fn(),
      whereIn: jest.fn(),
    };
    nested.from.mockReturnValue(nested);
    nested.select.mockReturnValue(nested);
    nested.where.mockReturnValue(nested);
    nested.whereIn.mockImplementation((_nestedColumn, nestedCallback) => {
      const repositoryQuery = {
        from: jest.fn(),
        select: jest.fn(),
        where: jest.fn(),
      };
      repositoryQuery.from.mockReturnValue(repositoryQuery);
      repositoryQuery.select.mockReturnValue(repositoryQuery);
      repositoryQuery.where.mockReturnValue(repositoryQuery);
      nestedCallback(repositoryQuery);
      return nested;
    });
    callback(nested);
    return query;
  });
  query.andWhere.mockReturnValue(query);
  return query;
}

function createPullRequest(overrides: Record<string, unknown> = {}) {
  const patch = jest.fn().mockResolvedValue(undefined);
  return {
    id: 17,
    githubLogin: 'developer',
    fullName: 'example/repository',
    branchName: 'feature/test',
    deployOnUpdate: false,
    latestCommit: null,
    build: { id: 23, uuid: 'build-23' },
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
    $query: jest.fn(() => ({ patch })),
    __patch: patch,
    ...overrides,
  };
}

function pullRequestEvent(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    number: 11,
    repository: {
      id: 101,
      name: 'repository',
      full_name: 'example/repository',
      owner: { id: 202 },
    },
    installation: { id: 303 },
    pull_request: {
      id: 404,
      head: { ref: 'feature/test', sha: 'sha-1' },
      title: 'Feature',
      user: { login: 'developer' },
      state: 'open',
      labels: [],
    },
    ...overrides,
  } as any;
}

function createHarness() {
  const webhookQueue = { add: jest.fn(), on: jest.fn(), process: jest.fn() };
  const deploymentQueue = { add: jest.fn(), on: jest.fn(), process: jest.fn() };
  const queueManager = {
    registerQueue: jest.fn().mockReturnValueOnce(webhookQueue).mockReturnValueOnce(deploymentQueue),
  };
  const db: any = {
    models: {
      Build: {
        findOne: jest.fn().mockResolvedValue({ id: 23 }),
        query: jest.fn(),
      },
      PullRequest: {
        findOne: jest.fn().mockResolvedValue(null),
        tableName: 'pullRequests',
      },
      Repository: { tableName: 'repositories' },
      Deploy: { query: jest.fn() },
    },
    services: {
      Repository: {
        findRepository: jest.fn().mockResolvedValue({ id: 3, defaultEnvId: 9 }),
        syncRepositoryRename: jest.fn(),
      },
      PullRequest: {
        findOrCreatePullRequest: jest.fn().mockResolvedValue(createPullRequest()),
      },
      BuildService: {
        createBuildAndDeploys: jest.fn(),
        enqueueBuildDeletion: jest.fn(),
        enqueueResolveAndDeployBuild: jest.fn(),
      },
      LabelService: { labelQueue: { add: jest.fn() } },
      BotUser: { isBotUser: jest.fn().mockResolvedValue(false) },
      ActivityStream: { updateBuildsAndDeploysFromCommentEdit: jest.fn() },
      GlobalConfig: { getAllConfigs: jest.fn().mockResolvedValue({ features: { ignoreFiles: true } }) },
      Webhook: { webhookQueue: { add: jest.fn() } },
      GithubService: { dispatchWebhook: jest.fn() },
    },
  };
  const service = new GithubService(db, {} as any, {} as any, queueManager as any);
  return { service, db, queueManager, webhookQueue, deploymentQueue };
}

function pushEvent(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'refs/heads/main',
    before: 'before-sha',
    after: 'after-sha',
    commits: [{ added: [], removed: [], modified: ['src/index.ts'] }],
    distinct_size: 1,
    repository: { id: 101, full_name: 'example/repository' },
    ...overrides,
  } as any;
}

function rebuildableDeploy(
  buildOverrides: Record<string, unknown> = {},
  deployOverrides: Record<string, unknown> = {}
) {
  const build = {
    id: 23,
    status: 'deployed',
    isStatic: false,
    trackDefaultBranches: true,
    pullRequest: { status: PullRequestStatus.OPEN, deployOnUpdate: true },
    ...buildOverrides,
  };
  return {
    id: 31,
    devMode: false,
    build,
    deployable: { name: 'api', defaultBranchName: 'main' },
    ...deployOverrides,
  };
}

describe('GithubService webhook boundary behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyWebhookSignature.mockReturnValue(true);
    mockIsStaging.mockReturnValue(false);
    mockIsLifecycleLabel.mockResolvedValue(true);
    mockHasDeployLabel.mockResolvedValue(false);
    mockEnableKillSwitch.mockResolvedValue(false);
    mockGetYamlFileContent.mockResolvedValue({});
    mockGetChangedFilesFromPushPayload.mockReturnValue({ canSkip: true, files: ['src/index.ts'] });
    mockGetChangedFilesForPush.mockResolvedValue({ canSkip: true, files: ['src/index.ts'] });
    mockFetchLifecycleConfig.mockResolvedValue({
      version: '1.0.0',
      environment: {},
      services: [{ name: 'api' }],
    });
  });

  it.each([
    ['a payload without a repository', {}, true],
    ['a repository without an id', { repository: {}, installation: { id: 2 } }, false],
    ['a repository without an installation', { repository: { id: 1 } }, false],
  ])('handles %s before consulting onboarding state', async (_label, body, expected) => {
    const onboarded = jest.spyOn(RepositoryService.prototype, 'isRepositoryOnboarded');
    const { service } = createHarness();

    await expect(service.shouldProcessWebhook(body)).resolves.toBe(expected);

    expect(onboarded).not.toHaveBeenCalled();
  });

  it('ignores non-rename repository events and incomplete rename payloads', async () => {
    const { service, db } = createHarness();

    await service.handleRepositoryWebhook({
      action: 'created',
      repository: { full_name: 'example/repository' },
    } as any);
    await service.handleRepositoryWebhook({
      action: 'renamed',
      installation: {},
      repository: { id: 101, full_name: 'example/renamed' },
    } as any);

    expect(db.services.Repository.syncRepositoryRename).not.toHaveBeenCalled();
  });

  it('skips pull request processing without an installation id', async () => {
    const { service, db } = createHarness();
    const event = pullRequestEvent({ installation: undefined });

    await service.handlePullRequestHook(event);

    expect(db.services.Repository.findRepository).not.toHaveBeenCalled();
    expect(db.services.PullRequest.findOrCreatePullRequest).not.toHaveBeenCalled();
  });

  it('continues an opened pull request with default config when config retrieval fails', async () => {
    const { service, db } = createHarness();
    const pullRequest = createPullRequest();
    db.services.PullRequest.findOrCreatePullRequest.mockResolvedValue(pullRequest);
    mockGetYamlFileContent.mockRejectedValue(new Error('GitHub unavailable'));
    jest.spyOn(service as any, 'patchPullRequest').mockResolvedValue({
      deployLabelPresent: false,
      deployOnUpdate: false,
    });

    await service.handlePullRequestHook(pullRequestEvent());

    expect(db.services.PullRequest.findOrCreatePullRequest).toHaveBeenCalledWith(
      expect.anything(),
      404,
      expect.objectContaining({ deployOnUpdate: false })
    );
    expect(db.services.BuildService.createBuildAndDeploys).toHaveBeenCalledTimes(1);
    expect(pullRequest.__patch).toHaveBeenCalledWith({ latestCommit: 'sha-1' });
  });

  it('does not enqueue an opened pull request when its expected build row is absent', async () => {
    const { service, db } = createHarness();
    db.models.Build.findOne.mockResolvedValue(null);
    jest.spyOn(service as any, 'patchPullRequest').mockResolvedValue({
      deployLabelPresent: true,
      deployOnUpdate: true,
    });

    await service.handlePullRequestHook(pullRequestEvent());

    expect(db.services.BuildService.enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('forwards the current label names when auto-deploy needs label synchronization', async () => {
    const { service, db } = createHarness();
    mockGetYamlFileContent.mockResolvedValue({ environment: { autoDeploy: true } });
    jest.spyOn(service as any, 'patchPullRequest').mockResolvedValue({
      deployLabelPresent: false,
      deployOnUpdate: true,
    });
    const event = pullRequestEvent();
    event.pull_request.labels = [{ name: 'question' }];

    await service.handlePullRequestHook(event);

    expect(db.services.LabelService.labelQueue.add).toHaveBeenCalledWith(
      'label',
      expect.objectContaining({ labels: ['question'], action: 'enable', waitForComment: true })
    );
  });

  it('does not enqueue teardown for a closed pull request whose build row is absent', async () => {
    const { service, db } = createHarness();
    db.models.Build.findOne.mockResolvedValue(null);
    jest.spyOn(service as any, 'patchPullRequest').mockResolvedValue({
      deployLabelPresent: false,
      deployOnUpdate: false,
    });

    await service.handlePullRequestHook(
      pullRequestEvent({ action: 'closed', pull_request: { ...pullRequestEvent().pull_request, state: 'closed' } })
    );

    expect(db.services.BuildService.enqueueBuildDeletion).not.toHaveBeenCalled();
    expect(db.services.LabelService.labelQueue.add).not.toHaveBeenCalled();
  });

  it('keeps pull request webhook failures non-fatal to the dispatcher', async () => {
    const { service, db } = createHarness();
    db.services.Repository.findRepository.mockRejectedValue(new Error('database unavailable'));

    await expect(service.handlePullRequestHook(pullRequestEvent())).resolves.toBeUndefined();

    expect(mockLoggerFatal).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.stringContaining('PR event handling failed')
    );
  });

  it('updates build state for a human-edited tracked issue comment', async () => {
    const { service, db } = createHarness();
    const pullRequest = createPullRequest();
    db.models.PullRequest.findOne.mockResolvedValue(pullRequest);

    await service.handleIssueCommentWebhook({
      comment: { id: 19, body: 'rebuild api' },
      sender: { login: 'developer' },
    } as any);

    expect(pullRequest.$fetchGraph).toHaveBeenCalledWith('[build, repository]');
    expect(db.services.ActivityStream.updateBuildsAndDeploysFromCommentEdit).toHaveBeenCalledWith(
      pullRequest,
      'rebuild api'
    );
  });

  it.each([
    ['an untracked comment', null, 'developer'],
    ['a bot comment', createPullRequest(), 'lifecycle[bot]'],
  ])('ignores %s', async (_label, pullRequest, login) => {
    const { service, db } = createHarness();
    db.models.PullRequest.findOne.mockResolvedValue(pullRequest);

    await service.handleIssueCommentWebhook({ comment: { id: 19, body: 'ignored' }, sender: { login } } as any);

    expect(db.services.ActivityStream.updateBuildsAndDeploysFromCommentEdit).not.toHaveBeenCalled();
  });

  it('contains issue-comment lookup failures', async () => {
    const { service, db } = createHarness();
    db.models.PullRequest.findOne.mockRejectedValue(new Error('database unavailable'));

    await expect(
      service.handleIssueCommentWebhook({ comment: { id: 19, body: 'ignored' }, sender: { login: 'developer' } } as any)
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.any(String)
    );
  });

  it('routes the staging fallback label through opened-pull-request handling', async () => {
    const { service, db } = createHarness();
    mockIsStaging.mockReturnValue(true);
    db.models.PullRequest.findOne.mockResolvedValue(null);
    const openHandler = jest.spyOn(service, 'handlePullRequestHook').mockResolvedValue(undefined);
    const body = {
      action: 'labeled',
      label: { name: 'lifecycle-stg-deploy!' },
      pull_request: {
        id: 404,
        labels: [{ name: 'lifecycle-stg-deploy!' }],
        state: 'open',
      },
    } as any;

    await service.handleLabelWebhook(body);

    expect(body.action).toBe('opened');
    expect(openHandler).toHaveBeenCalledWith(body);
  });

  it('enqueues the current label state even when the fetched build has no id', async () => {
    const { service, db } = createHarness();
    const pullRequest = createPullRequest({ deployOnUpdate: true, build: {} });
    db.models.PullRequest.findOne.mockResolvedValue(pullRequest);

    await service.handleLabelWebhook({
      action: 'labeled',
      label: { name: 'lifecycle-deploy!' },
      pull_request: { id: 404, labels: [{ name: 'lifecycle-deploy!' }], state: 'open' },
    });

    expect(db.services.BuildService.enqueueResolveAndDeployBuild).toHaveBeenCalledWith({ buildId: undefined });
  });

  it('contains label-processing and pull-request patch failures', async () => {
    const first = createHarness();
    mockIsLifecycleLabel.mockRejectedValueOnce(new Error('label lookup failed'));
    await expect(
      first.service.handleLabelWebhook({
        action: 'labeled',
        label: { name: 'lifecycle-deploy!' },
        pull_request: { id: 404, labels: [], state: 'open' },
      })
    ).resolves.toBeUndefined();

    const second = createHarness();
    const pullRequest = createPullRequest({ deployOnUpdate: false });
    second.db.models.PullRequest.findOne.mockResolvedValue(pullRequest);
    second.db.services.BotUser.isBotUser.mockRejectedValue(new Error('bot lookup failed'));
    await second.service.handleLabelWebhook({
      action: 'labeled',
      label: { name: 'lifecycle-deploy!' },
      pull_request: { id: 404, labels: [], state: 'open' },
    });

    expect(mockLoggerError).toHaveBeenCalled();
    expect(second.db.services.BuildService.enqueueBuildDeletion).toHaveBeenCalledWith(
      pullRequest.build,
      'deploy_disabled'
    );
  });
});

describe('GithubService push fallback behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChangedFilesFromPushPayload.mockReturnValue({ canSkip: true, files: ['src/index.ts'] });
    mockGetChangedFilesForPush.mockResolvedValue({ canSkip: true, files: ['src/index.ts'] });
    mockFetchLifecycleConfig.mockResolvedValue({
      version: '1.0.0',
      environment: {},
      services: [{ name: 'api' }],
    });
  });

  function preparePush(deploy = rebuildableDeploy()) {
    const harness = createHarness();
    harness.db.models.PullRequest.findOne.mockResolvedValue(null);
    harness.db.models.Deploy.query
      .mockReturnValueOnce(activeDeploysQuery([deploy]))
      .mockReturnValueOnce(failedDeploysQuery([]));
    jest.spyOn(harness.service as any, 'enqueueAutoTrackedApiBuilds').mockResolvedValue(undefined);
    return harness;
  }

  it('ignores a ref that is not a branch ref', async () => {
    const { service, db } = createHarness();

    await service.handlePushWebhook(pushEvent({ ref: 'refs/tags/v1.0.0' }));

    expect(db.models.Deploy.query).not.toHaveBeenCalled();
  });

  it('filters dev-mode and branchless deploys before build scheduling', async () => {
    const harness = createHarness();
    harness.db.models.PullRequest.findOne.mockResolvedValue(null);
    harness.db.models.Deploy.query.mockReturnValueOnce(
      activeDeploysQuery([
        rebuildableDeploy({}, { id: 1, devMode: true }),
        rebuildableDeploy({}, { id: 2, deployable: { name: 'api', defaultBranchName: null } }),
        { id: 3, build: null, deployable: { name: 'api', defaultBranchName: 'main' } },
      ])
    );
    jest.spyOn(harness.service as any, 'enqueueAutoTrackedApiBuilds').mockResolvedValue(undefined);

    await harness.service.handlePushWebhook(pushEvent());

    expect(harness.db.services.BuildService.enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('falls through to deployment when neither payload nor compare can establish changed files', async () => {
    const { service, db } = preparePush();
    mockGetChangedFilesFromPushPayload.mockReturnValue({ canSkip: false, reason: 'incomplete_payload' });
    mockGetChangedFilesForPush.mockResolvedValue({ canSkip: false, reason: 'compare_failed' });

    await service.handlePushWebhook(pushEvent());

    expect(db.services.BuildService.enqueueResolveAndDeployBuild).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith('Push: deploying reason=changed_files_unavailable');
  });

  it('uses dry-run deployment when the ignoreFiles feature lookup fails', async () => {
    const { service, db } = preparePush();
    mockGetChangedFilesFromPushPayload.mockReturnValue({ canSkip: true, files: ['docs/readme.md'] });
    mockFetchLifecycleConfig.mockResolvedValue({
      version: '1.0.0',
      environment: { ignoreFiles: ['docs/**'] },
      services: [{ name: 'api' }],
    });
    db.services.GlobalConfig.getAllConfigs.mockRejectedValue(new Error('config unavailable'));

    await service.handlePushWebhook(pushEvent());

    expect(db.services.BuildService.enqueueResolveAndDeployBuild).toHaveBeenCalledTimes(1);
    expect(db.services.Webhook.webhookQueue.add).not.toHaveBeenCalled();
  });

  it('skips an ignored push without a webhook when the build status is unsupported', async () => {
    const { service, db } = preparePush(rebuildableDeploy({ status: 'building' }));
    mockGetChangedFilesFromPushPayload.mockReturnValue({ canSkip: true, files: ['docs/readme.md'] });
    mockFetchLifecycleConfig.mockResolvedValue({
      version: '1.0.0',
      environment: { ignoreFiles: ['docs/**'] },
      services: [{ name: 'api' }],
    });

    await service.handlePushWebhook(pushEvent());

    expect(db.services.Webhook.webhookQueue.add).not.toHaveBeenCalled();
    expect(db.services.BuildService.enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it.each([
    ['the lifecycle config is absent', null, rebuildableDeploy()],
    [
      'the deploy has no service name',
      { version: '1.0.0', services: [{ name: 'api' }] },
      rebuildableDeploy({}, { deployable: { name: null, defaultBranchName: 'main' } }),
    ],
    ['the named service is absent', { version: '1.0.0', services: [{ name: 'web' }] }, rebuildableDeploy()],
  ])('redeploys when %s', async (_label, lifecycleConfig, deploy) => {
    const { service, db } = preparePush(deploy);
    mockGetChangedFilesFromPushPayload.mockReturnValue({ canSkip: true, files: ['docs/readme.md'] });
    mockFetchLifecycleConfig.mockResolvedValue(lifecycleConfig);

    await service.handlePushWebhook(pushEvent());

    expect(db.services.BuildService.enqueueResolveAndDeployBuild).toHaveBeenCalledTimes(1);
  });

  it('contains static-environment lookup failures', async () => {
    const { service, db } = createHarness();
    db.models.Build.query.mockImplementation(() => {
      throw new Error('query unavailable');
    });

    await expect(
      service.handlePushForStaticEnv({ githubRepositoryId: 101, branchName: 'main' })
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.stringContaining('static env webhook failed')
    );
  });

  it('contains active-deploy lookup failures for push webhooks', async () => {
    const { service, db } = createHarness();
    db.models.PullRequest.findOne.mockResolvedValue(null);
    db.models.Deploy.query.mockImplementation(() => {
      throw new Error('deploy query unavailable');
    });

    await expect(service.handlePushWebhook(pushEvent())).resolves.toBeUndefined();

    expect(db.services.BuildService.enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Push: webhook processing failed'
    );
  });

  it('builds the nested static-environment lookup and forwards optional commit refs', async () => {
    const { service, db } = createHarness();
    db.models.Build.query.mockReturnValue(buildQueryResult({ id: 44 }));

    await service.handlePushForStaticEnv({
      githubRepositoryId: 101,
      branchName: 'main',
      headCommit: 'head-sha',
      beforeCommit: 'before-sha',
    });

    expect(db.services.BuildService.enqueueResolveAndDeployBuild).toHaveBeenCalledWith({
      buildId: 44,
      sourceRef: 'head-sha',
      sourceBeforeRef: 'before-sha',
      sourceGithubRepositoryId: 101,
      sourceBranch: 'main',
    });
  });
});

describe('GithubService dispatch and queue processing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyWebhookSignature.mockReturnValue(true);
    mockIsStaging.mockReturnValue(false);
    mockCreateGithubDeployment.mockResolvedValue(undefined);
    mockDeleteGithubDeployment.mockResolvedValue(undefined);
  });

  it('rejects unverified webhooks before onboarding or dispatch', async () => {
    const { service } = createHarness();
    mockVerifyWebhookSignature.mockReturnValue(false);
    const onboarding = jest.spyOn(service, 'shouldProcessWebhook');

    await expect(service.dispatchWebhook({ headers: {}, body: {} } as any)).rejects.toThrow('Webhook not verified');

    expect(onboarding).not.toHaveBeenCalled();
  });

  it('skips non-fallback pull requests in staging', async () => {
    const { service } = createHarness();
    jest.spyOn(service, 'shouldProcessWebhook').mockResolvedValue(true);
    mockIsStaging.mockReturnValue(true);
    const pullHandler = jest.spyOn(service, 'handlePullRequestHook').mockResolvedValue(undefined);

    await service.dispatchWebhook({
      headers: { 'x-github-event': 'pull_request' },
      body: { action: 'opened', pull_request: { labels: [{ name: 'question' }] } },
    } as any);

    expect(pullHandler).not.toHaveBeenCalled();
  });

  it.each(['labeled', 'unlabeled'])('routes %s pull request events to label handling', async (action) => {
    const { service } = createHarness();
    jest.spyOn(service, 'shouldProcessWebhook').mockResolvedValue(true);
    const labelHandler = jest.spyOn(service, 'handleLabelWebhook').mockResolvedValue(undefined);
    const body = { action, pull_request: { labels: [] } };

    await service.dispatchWebhook({ headers: { 'x-github-event': 'pull_request' }, body } as any);

    expect(labelHandler).toHaveBeenCalledWith(body);
  });

  it('routes ordinary pull request events to pull-request handling', async () => {
    const { service } = createHarness();
    jest.spyOn(service, 'shouldProcessWebhook').mockResolvedValue(true);
    const pullHandler = jest.spyOn(service, 'handlePullRequestHook').mockResolvedValue(undefined);
    const body = { action: 'opened', pull_request: { labels: [] } };

    await service.dispatchWebhook({ headers: { 'x-github-event': 'pull_request' }, body } as any);

    expect(pullHandler).toHaveBeenCalledWith(body);
  });

  it.each([
    ['push', 'handlePushWebhook', { repository: {} }],
    ['issue_comment', 'handleIssueCommentWebhook', {}],
    ['repository', 'handleRepositoryWebhook', {}],
  ])('routes %s events to %s', async (type, method, body) => {
    const { service } = createHarness();
    jest.spyOn(service, 'shouldProcessWebhook').mockResolvedValue(true);
    const handler = jest.spyOn(service as any, method).mockResolvedValue(undefined);

    await service.dispatchWebhook({ headers: { 'x-github-event': type }, body } as any);

    expect(handler).toHaveBeenCalledWith(body);
  });

  it.each([
    ['pull_request', 'handlePullRequestHook', { action: 'opened', pull_request: { labels: [] } }],
    ['push', 'handlePushWebhook', {}],
    ['issue_comment', 'handleIssueCommentWebhook', {}],
    ['repository', 'handleRepositoryWebhook', {}],
  ])('logs and rethrows %s handler failures', async (type, method, body) => {
    const { service } = createHarness();
    jest.spyOn(service, 'shouldProcessWebhook').mockResolvedValue(true);
    jest.spyOn(service as any, method).mockRejectedValue(new Error(`${type} failed`));

    await expect(service.dispatchWebhook({ headers: { 'x-github-event': type }, body } as any)).rejects.toThrow(
      `${type} failed`
    );

    expect(mockLoggerError).toHaveBeenCalled();
  });

  it('ignores unknown verified webhook types', async () => {
    const { service } = createHarness();
    jest.spyOn(service, 'shouldProcessWebhook').mockResolvedValue(true);

    await expect(
      service.dispatchWebhook({ headers: { 'x-github-event': 'installation' }, body: {} } as any)
    ).resolves.toBeUndefined();
  });

  it('parses and dispatches queued webhook messages with their log context', async () => {
    const { service, db } = createHarness();
    const body = { repository: { id: 101 } };

    await service.processWebhooks({
      data: {
        correlationId: 'correlation-1',
        sender: 'github',
        message: stringifyFlatted(body),
        _ddTraceContext: { traceId: 'trace-1' },
      },
    });

    expect(db.services.GithubService.dispatchWebhook).toHaveBeenCalledWith(body);
  });

  it('contains queued webhook dispatch failures', async () => {
    const { service, db } = createHarness();
    db.services.GithubService.dispatchWebhook.mockRejectedValue(new Error('dispatch failed'));

    await expect(
      service.processWebhooks({
        data: { correlationId: 'c', sender: 'github', message: stringifyFlatted({}), _ddTraceContext: {} },
      })
    ).resolves.toBeUndefined();

    expect(mockLoggerFatal).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.any(String)
    );
  });

  it('skips queued GitHub deployment work when the deploy no longer exists', async () => {
    const { service, db } = createHarness();
    db.models.Deploy.query.mockReturnValue({ findById: jest.fn().mockResolvedValue(null) });

    await service.processGithubDeployment({
      id: 'job-1',
      data: { deployId: 31, action: 'create', sender: 'test', correlationId: 'c', _ddTraceContext: {} },
    });

    expect(mockCreateGithubDeployment).not.toHaveBeenCalled();
  });

  it.each([
    ['create', mockCreateGithubDeployment],
    ['delete', mockDeleteGithubDeployment],
  ])('processes a queued %s deployment action', async (action, expectedHandler) => {
    const { service, db } = createHarness();
    const deploy = { id: 31 };
    db.models.Deploy.query.mockReturnValue({ findById: jest.fn().mockResolvedValue(deploy) });

    await service.processGithubDeployment({
      id: 'job-1',
      data: { deployId: 31, action, sender: 'test', correlationId: 'c', _ddTraceContext: {} },
    });

    expect(expectedHandler).toHaveBeenCalledWith(deploy);
  });

  it.each([
    ['an unknown action', 'archive', undefined],
    ['a provider failure', 'create', new Error('GitHub unavailable')],
  ])('logs and rethrows %s', async (_label, action, providerError) => {
    const { service, db } = createHarness();
    db.models.Deploy.query.mockReturnValue({ findById: jest.fn().mockResolvedValue({ id: 31 }) });
    if (providerError) {
      mockCreateGithubDeployment.mockRejectedValue(providerError);
    }

    await expect(
      service.processGithubDeployment({
        id: 'job-1',
        data: { deployId: 31, action, sender: 'test', correlationId: 'c', _ddTraceContext: {} },
      })
    ).rejects.toThrow(providerError?.message || `Unknown action: ${action}`);

    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('GitHub deployment failed'));
  });
});
