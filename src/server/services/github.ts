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

import { parse as fParse } from 'flatted';
import _ from 'lodash';
import Service from './_service';
import { withLogContext, getLogger, extractContextForQueue, LogStage } from 'server/lib/logger';
import {
  IssueCommentEvent,
  PullRequestEvent,
  PushEvent,
  RepositoryEvent as GithubRepositoryEvent,
} from '@octokit/webhooks-types';
import {
  GithubPullRequestActions,
  GithubWebhookTypes,
  PullRequestStatus,
  FallbackLabels,
  DeployStatus,
  BuildStatus,
} from 'shared/constants';
import { QUEUE_NAMES } from 'shared/config';
import { NextApiRequest } from 'next';
import * as github from 'server/lib/github';
import { Repository, Build, PullRequest, Deploy } from 'server/models';
import * as YamlService from 'server/models/yaml';
import { LifecycleYamlConfigOptions } from 'server/models/yaml/types';
import { createOrUpdateGithubDeployment, deleteGithubDeploymentAndEnvironment } from 'server/lib/github/deployments';
import { enableKillSwitch, isStaging, hasDeployLabel, isLifecycleLabel } from 'server/lib/utils';
import { redisClient } from 'server/lib/dependencies';
import RepositoryService from './repository';
import {
  getEffectiveIgnoreFiles,
  PushIgnoreDecision,
  PushIgnoreServicePolicy,
  shouldSkipPushDeploy,
} from 'server/lib/pushIgnoreFiles';

const SKIPPED_PUSH_WEBHOOK_STATUSES = new Set<string>([BuildStatus.DEPLOYED, BuildStatus.ERROR, BuildStatus.TORN_DOWN]);
const IGNORE_FILES_FEATURE_FLAG = 'ignoreFiles';

interface PullRequestPatchState {
  deployLabelPresent: boolean;
  deployOnUpdate: boolean;
}

type LifecycleConfigCache = Map<string, Promise<YamlService.LifecycleConfig>>;
type PushEventWithCommitCounts = PushEvent & {
  distinct_size?: number;
  size?: number;
};

export default class GithubService extends Service {
  private readonly repositoryService = new RepositoryService(this.db, this.redis, this.redlock, this.queueManager);

  public shouldProcessWebhook = async (body: {
    repository?: {
      id?: number;
      full_name?: string;
      html_url?: string;
      owner?: { id?: number };
    };
    installation?: { id?: number };
  }): Promise<boolean> => {
    const repositoryPayload = body?.repository;
    const installationId = body?.installation?.id;

    if (!repositoryPayload) {
      return true;
    }

    if (!repositoryPayload?.id) {
      getLogger().warn('Webhook: skipped reason=missing_repository_id');
      return false;
    }

    if (!installationId) {
      getLogger({ githubRepositoryId: repositoryPayload.id }).warn('Webhook: skipped reason=missing_installation_id');
      return false;
    }

    const onboarded = await this.repositoryService.isRepositoryOnboarded(installationId, repositoryPayload.id);

    if (!onboarded) {
      getLogger({
        githubRepositoryId: repositoryPayload.id,
        githubInstallationId: installationId,
        fullName: repositoryPayload.full_name,
      }).debug('Webhook: skipped reason=repository_not_onboarded');
    }

    return onboarded;
  };

  handleRepositoryWebhook = async (body: GithubRepositoryEvent) => {
    const { action, repository, installation } = body;
    getLogger({}).info(`GitHub: repository event action=${action} repo=${repository?.full_name}`);

    if (action !== 'renamed') {
      return;
    }

    if (!installation?.id || !repository?.id || !repository?.full_name) {
      getLogger({
        githubRepositoryId: repository?.id,
        fullName: repository?.full_name,
      }).warn('GitHub: repository rename skipped reason=missing_required_metadata');
      return;
    }

    await this.db.services.Repository.syncRepositoryRename({
      githubRepositoryId: repository.id,
      githubInstallationId: installation.id,
      ownerId: repository.owner?.id,
      ownerLogin: repository.owner?.login,
      name: repository.name,
      fullName: repository.full_name,
      htmlUrl: repository.html_url,
    });
  };

  // Handle the pull request webhook mapping the entrance with webhook body
  async handlePullRequestHook({
    action,
    number,
    repository: {
      id: repositoryId,
      owner: { id: ownerId },
      full_name: fullName,
    },
    installation,
    pull_request: {
      id: githubPullRequestId,
      head: { ref: branch, sha: branchSha },
      title,
      user: { login: githubLogin },
      state: status,
      labels,
    },
  }: PullRequestEvent) {
    const isOpened = [GithubPullRequestActions.OPENED, GithubPullRequestActions.REOPENED].includes(
      action as GithubPullRequestActions
    );
    const isClosed = action === GithubPullRequestActions.CLOSED;
    let lifecycleConfig = {} as LifecycleYamlConfigOptions;
    let pullRequest: PullRequest, repository: Repository | undefined, build: Build;

    try {
      const installationId = installation?.id;
      if (!installationId) {
        getLogger({ githubRepositoryId: repositoryId }).warn('PR: skipped reason=missing_installation_id');
        return;
      }

      repository = await this.db.services.Repository.findRepository(ownerId, repositoryId, installationId);

      if (!repository) {
        getLogger({}).info(`PR: skipping non-onboarded repository repo=${fullName} repositoryId=${repositoryId}`);
        return;
      }

      if (isOpened) {
        try {
          lifecycleConfig = (await github.getYamlFileContent({
            sha: branchSha,
            branch,
            fullName,
            isJSON: true,
          })) as LifecycleYamlConfigOptions;
        } catch (error) {
          getLogger({}).warn({ error }, `Config: fetch failed repo=${fullName}/${branch}`);
        }
      }
      const autoDeploy = lifecycleConfig?.environment?.autoDeploy;

      pullRequest = await this.db.services.PullRequest.findOrCreatePullRequest(repository, githubPullRequestId, {
        title,
        status,
        number,
        deployOnUpdate: autoDeploy ?? false,
        fullName,
        githubLogin,
        branch,
      });

      const pullRequestState = await this.patchPullRequest({
        pullRequest,
        labels,
        action,
        status,
        autoDeploy,
      });
      getLogger({}).info(
        `PR state: action=${action} repo=${fullName} branch=${branch} labels=[${labels
          .map((label) => label.name)
          .join(',')}] deployLabelPresent=${pullRequestState?.deployLabelPresent} deployOnUpdate=${
          pullRequestState?.deployOnUpdate
        }`
      );

      const pullRequestId = pullRequest?.id;
      const latestCommit = pullRequest?.latestCommit;

      if (isOpened) {
        if (!latestCommit) await pullRequest.$query().patch({ latestCommit: branchSha });
        const environmentId = repository?.defaultEnvId;
        // only create build and deploys. do not build or deploy here
        await this.db.services.BuildService.createBuildAndDeploys({
          repositoryId,
          repositoryBranchName: branch,
          installationId,
          pullRequestId,
          environmentId,
          lifecycleConfig,
        });

        const shouldQueueBuildFromOpen =
          pullRequestState?.deployOnUpdate === true && pullRequestState?.deployLabelPresent === true;
        const deployDecision = shouldQueueBuildFromOpen
          ? 'queue-build'
          : pullRequestState?.deployOnUpdate
          ? 'sync-deploy-label'
          : 'no-deploy';
        getLogger({}).info(
          `PR open decision: repo=${fullName} branch=${branch} pullRequestId=${pullRequestId} decision=${deployDecision}`
        );

        if (shouldQueueBuildFromOpen) {
          build = await this.db.models.Build.findOne({
            pullRequestId,
          });
          if (!build) {
            getLogger({}).warn(`Build: not found for opened PR repo=${fullName}/${branch}`);
          } else {
            await this.db.services.BuildService.enqueueResolveAndDeployBuild({
              buildId: build.id,
              ...extractContextForQueue(),
            });
          }
        } else if (pullRequestState?.deployOnUpdate) {
          // If autoDeploy is enabled but the label was not on the opened PR payload,
          // add it asynchronously and let the follow-up label webhook advance the build.
          await this.db.services.LabelService.labelQueue.add('label', {
            pullRequestId: pullRequest.id,
            action: 'enable',
            waitForComment: true,
            labels: labels.map((l) => l.name),
            ...extractContextForQueue(),
          });
        }
      } else if (isClosed) {
        build = await this.db.models.Build.findOne({
          pullRequestId,
        });
        if (!build) {
          getLogger({}).warn(`Build: not found for closed PR repo=${fullName}/${branch}`);
          return;
        }
        await this.db.services.BuildService.deleteBuild(build);
        // remove deploy label on PR close via queue
        await this.db.services.LabelService.labelQueue.add('label', {
          pullRequestId: pullRequest.id,
          action: 'disable',
          waitForComment: false,
          labels: labels.map((l) => l.name),
          ...extractContextForQueue(),
        });
      }
    } catch (error) {
      getLogger().fatal({ error }, `Github: PR event handling failed repo=${fullName} branch=${branch}`);
    }
  }

  handleIssueCommentWebhook = async ({
    comment: { id: commentId, body },
    sender: { login: commentCreatorUsername },
  }: IssueCommentEvent & {
    installation: { id: number; account: { login: string } };
  }) => {
    const isBot = commentCreatorUsername.includes('[bot]') === true;
    let pullRequest;
    try {
      pullRequest = await this.db.models.PullRequest.findOne({
        commentId,
      });

      if (!pullRequest || isBot) return;
      await pullRequest.$fetchGraph('[build, repository]');
      const buildUuid = pullRequest.build?.uuid;

      return withLogContext({ buildUuid }, async () => {
        getLogger().info(`PR: edited by=${commentCreatorUsername}`);
        await this.db.services.ActivityStream.updateBuildsAndDeploysFromCommentEdit(pullRequest, body);
      });
    } catch (error) {
      getLogger().error({ error }, `GitHub: issue comment handling failed`);
    }
  };

  handleLabelWebhook = async (body) => {
    const {
      action,
      label: changedLabel,
      pull_request: { id: githubPullRequestId, labels, state: status },
    } = body;
    let pullRequest: PullRequest, build: Build;
    try {
      const changedLabelName = changedLabel?.name?.toLowerCase();
      const isLifecycle = await isLifecycleLabel(changedLabelName);
      if (!isLifecycle) {
        getLogger().debug(`PR label: skipping label=${changedLabelName} action=${action}`);
        return;
      }

      // this is a hacky way to force deploy by adding a label
      const labelNames = labels.map(({ name }) => name.toLowerCase()) || [];
      const shouldDeploy = isStaging() && labelNames.includes(FallbackLabels.DEPLOY_STG);
      if (shouldDeploy) {
        // we overwrite the action so the handlePullRequestHook can handle the cretion
        body.action = GithubPullRequestActions.OPENED;
        await this.handlePullRequestHook(body);
      }
      pullRequest = await this.db.models.PullRequest.findOne({
        githubPullRequestId,
      });

      if (!pullRequest) return;

      await pullRequest.$fetchGraph('[build, repository]');
      build = pullRequest?.build;
      await this.patchPullRequest({
        pullRequest,
        labels,
        action,
        status,
        autoDeploy: false,
      });
      getLogger().info(
        `PR label state: action=${action} changedLabel=${changedLabelName} pullRequestId=${
          pullRequest.id
        } labels=[${labels.map(({ name }) => name).join(',')}] deployOnUpdate=${pullRequest.deployOnUpdate}`
      );

      if (pullRequest.deployOnUpdate === false) {
        // when pullRequest.deployOnUpdate is false, it means that there is no `lifecycle-deploy!` label
        // or there is `lifecycle-disabled!` label in the PR
        getLogger().info(
          `PR label decision: action=${action} changedLabel=${changedLabelName} pullRequestId=${pullRequest.id} decision=delete-build`
        );
        return this.db.services.BuildService.deleteBuild(build);
      }

      const buildId = build?.id;
      if (!buildId) {
        getLogger().error(`Build: id not found for=handleLabelWebhook`);
      }
      await this.db.services.BuildService.enqueueResolveAndDeployBuild({
        buildId,
        ...extractContextForQueue(),
      });
    } catch (error) {
      getLogger().error({ error }, `Label: webhook processing failed`);
    }
  };

  private async getLifecycleConfigForPush(
    repoName: string,
    branchName: string,
    lifecycleConfigCache: LifecycleConfigCache
  ): Promise<YamlService.LifecycleConfig> {
    const cacheKey = `${repoName}:${branchName}`;
    if (!lifecycleConfigCache.has(cacheKey)) {
      lifecycleConfigCache.set(cacheKey, YamlService.fetchLifecycleConfig(repoName, branchName));
    }

    return lifecycleConfigCache.get(cacheKey)!;
  }

  private getDeployServiceName(deploy: Deploy): string | null {
    return (deploy.build?.enableFullYaml ? deploy.deployable?.name : deploy.service?.name) ?? null;
  }

  private async getPushIgnoreServicePolicies({
    repoName,
    branchName,
    deploys,
    lifecycleConfigCache,
  }: {
    repoName: string;
    branchName: string;
    deploys: Deploy[];
    lifecycleConfigCache: LifecycleConfigCache;
  }): Promise<PushIgnoreServicePolicy[]> {
    const lifecycleConfig = await this.getLifecycleConfigForPush(repoName, branchName, lifecycleConfigCache);
    if (!lifecycleConfig) {
      throw new Error(`Lifecycle config not found for ${repoName}:${branchName}`);
    }

    return deploys.map((deploy) => {
      const serviceName = this.getDeployServiceName(deploy);
      if (!serviceName) {
        throw new Error(`Deploy ${deploy.id} does not have a service name`);
      }

      const service = lifecycleConfig.services?.find((candidate) => candidate.name === serviceName);
      if (!service) {
        throw new Error(`Service ${serviceName} not found in ${repoName}:${branchName}`);
      }

      return {
        serviceName,
        ignoreFiles: getEffectiveIgnoreFiles(lifecycleConfig.environment?.ignoreFiles, service.ignoreFiles),
      };
    });
  }

  private async shouldSkipBuildDeployForPush({
    repoName,
    branchName,
    build,
    affectedDeploys,
    changedFiles,
    lifecycleConfigCache,
  }: {
    repoName: string;
    branchName: string;
    build: Build;
    affectedDeploys: Deploy[];
    changedFiles: string[];
    lifecycleConfigCache: LifecycleConfigCache;
  }): Promise<PushIgnoreDecision> {
    try {
      const servicePolicies = await this.getPushIgnoreServicePolicies({
        repoName,
        branchName,
        deploys: affectedDeploys,
        lifecycleConfigCache,
      });

      return shouldSkipPushDeploy({ changedFiles, servicePolicies });
    } catch (error) {
      getLogger({ error, buildId: build.id, repo: repoName, branch: branchName }).warn(
        'Push: ignoreFiles policy resolution failed, redeploying'
      );
      return { shouldSkip: false, reason: 'policy_resolution_failed' };
    }
  }

  private async isIgnoreFilesFeatureEnabled(): Promise<boolean> {
    try {
      const { features } = await this.db.services.GlobalConfig.getAllConfigs();
      return features?.[IGNORE_FILES_FEATURE_FLAG] === true;
    } catch (error) {
      getLogger({ error, featureFlag: IGNORE_FILES_FEATURE_FLAG }).warn(
        'Push: ignoreFiles feature flag fetch failed, using dry-run mode'
      );
      return false;
    }
  }

  private async queueWebhooksForSkippedPush(build: Build): Promise<void> {
    if (!SKIPPED_PUSH_WEBHOOK_STATUSES.has(build.status)) {
      getLogger({ buildId: build.id, status: build.status }).info('Push: skipped deploy without webhook');
      return;
    }

    await this.db.services.Webhook.webhookQueue.add('webhook', {
      buildId: build.id,
      ...extractContextForQueue(),
    });
    getLogger({ buildId: build.id, status: build.status }).info('Push: skipped deploy and queued webhooks');
  }

  handlePushWebhook = async (pushEvent: PushEvent) => {
    const { ref, before: previousCommit, after: latestCommit, repository } = pushEvent;
    const pushEventWithCounts = pushEvent as PushEventWithCommitCounts;
    const { id: githubRepositoryId, full_name: repoName } = repository;
    const branchName = ref.split('refs/heads/')[1];
    if (!branchName) return;
    const hasVoidCommit = [previousCommit, latestCommit].some((commit) => this.isVoidCommit(commit));
    getLogger({}).debug(`Push event repo=${repoName} branch=${branchName}`);
    const models = this.db.models;
    let changedFilesForPush: github.ChangedFilesForPushResult | null = null;
    const lifecycleConfigCache: LifecycleConfigCache = new Map();

    const loadChangedFilesForPush = async () => {
      if (!changedFilesForPush) {
        changedFilesForPush = github.getChangedFilesFromPushPayload({
          commits: pushEvent.commits,
          commitCount: pushEventWithCounts.distinct_size ?? pushEventWithCounts.size,
        });

        if (!changedFilesForPush.canSkip) {
          getLogger({
            repo: repoName,
            branch: branchName,
            reason: changedFilesForPush.reason,
          }).info('Push: changed files unavailable from payload, falling back to compare');
          changedFilesForPush = await github.getChangedFilesForPush({
            fullName: repoName,
            before: previousCommit,
            after: latestCommit,
          });
        }
      }

      return changedFilesForPush;
    };

    try {
      if (!hasVoidCommit) {
        const pullRequest = await models.PullRequest.findOne({
          latestCommit: previousCommit,
        });

        if (pullRequest) {
          await pullRequest.$query().patch({ latestCommit });
        }
      }

      const allDeploys = await models.Deploy.query()
        .where('branchName', branchName)
        .where('githubRepositoryId', githubRepositoryId)
        .where('active', true)
        .whereNot('status', 'torn_down')
        .withGraphFetched('[build.[pullRequest], service, deployable]');

      if (!allDeploys.length) {
        // additional check for static env branch
        await this.handlePushForStaticEnv({ githubRepositoryId, branchName });
        return;
      }
      const deploysToRebuild = allDeploys.filter((deploy) => {
        if (!deploy?.build) return false;
        if (deploy.devMode) {
          getLogger().info(`Push: skipping dev mode service deployId=${deploy.id} service=${deploy.service?.name}`);
          return false;
        }
        const serviceBranchName = deploy.build.enableFullYaml
          ? deploy.deployable?.defaultBranchName
          : deploy.service?.branchName;
        if (!serviceBranchName) {
          return false;
        }
        const shouldBuild =
          deploy.build.trackDefaultBranches || serviceBranchName.toLowerCase() !== branchName.toLowerCase();

        return shouldBuild;
      });
      const allBuilds = _.uniqBy(
        deploysToRebuild.map((deploy) => deploy.build),
        (b) => b.id
      );
      const buildsToDeploy = allBuilds.filter(
        (b) => b.pullRequest.status === PullRequestStatus.OPEN && b.pullRequest.deployOnUpdate
      );

      for (const build of buildsToDeploy) {
        const buildId = build?.id;
        if (!buildId) {
          getLogger().error(`Build: id not found for=handlePushWebhook`);
        }
        // Only check for failed deploys on PR environments, not static environments
        let hasFailedDeploys = false;
        if (!build.isStatic) {
          const failedDeploys = await models.Deploy.query()
            .where('buildId', buildId)
            .where('active', true)
            .whereIn('status', [DeployStatus.ERROR, DeployStatus.BUILD_FAILED, DeployStatus.DEPLOY_FAILED]);

          hasFailedDeploys = failedDeploys.length > 0;

          if (hasFailedDeploys) {
            getLogger().info(
              `Push: redeploying reason=failedDeploys count=${failedDeploys.length} repo=${repoName} branch=${branchName}`
            );
          }
        }

        if (!hasFailedDeploys) {
          if (!hasVoidCommit) {
            const changedFilesResult = await loadChangedFilesForPush();
            if (changedFilesResult.canSkip) {
              const affectedDeploys = deploysToRebuild.filter((deploy) => deploy.build?.id === buildId);
              const skipDecision = await this.shouldSkipBuildDeployForPush({
                repoName,
                branchName,
                build,
                affectedDeploys,
                changedFiles: changedFilesResult.files,
                lifecycleConfigCache,
              });

              if (skipDecision.shouldSkip) {
                const ignoreFilesEnabled = await this.isIgnoreFilesFeatureEnabled();
                getLogger({
                  buildId,
                  repo: repoName,
                  branch: branchName,
                  reason: skipDecision.reason,
                  ignoreFilesEnabled,
                }).info(
                  ignoreFilesEnabled
                    ? 'Push: skipped deploy reason=ignoreFiles'
                    : 'Push: dry-run would skip deploy reason=ignoreFiles'
                );

                if (ignoreFilesEnabled) {
                  await this.queueWebhooksForSkippedPush(build);
                  continue;
                }
              } else {
                getLogger({
                  buildId,
                  repo: repoName,
                  branch: branchName,
                  reason: skipDecision.reason,
                  serviceName: skipDecision.serviceName,
                  filePath: skipDecision.filePath,
                }).info('Push: deploying reason=ignoreFiles_not_matched');
              }
            } else {
              getLogger({
                buildId,
                repo: repoName,
                branch: branchName,
                reason: changedFilesResult.reason,
              }).info('Push: deploying reason=changed_files_unavailable');
            }
          }

          getLogger().info(`Push: deploying repo=${repoName} branch=${branchName}`);
        }

        await this.db.services.BuildService.enqueueResolveAndDeployBuild({
          buildId,
          ...(hasFailedDeploys ? {} : { githubRepositoryId }),
          ...extractContextForQueue(),
        });
      }
    } catch (error) {
      getLogger({}).error({ error }, `Push: webhook processing failed`);
    }
  };

  /**
   * Static environment builds are often defined in a separate config repo, so they may not have deploy records
   * for the pushed repo and branch. In that case, rebuild the whole static environment for matching default-branch pushes.
   * Static environments intentionally bypass ignoreFiles diff checks because their service graph can change from
   * the config repo itself, and redeploying is the safer default.
   */
  handlePushForStaticEnv = async ({
    githubRepositoryId,
    branchName,
  }: {
    githubRepositoryId: number;
    branchName: string;
  }): Promise<void> => {
    try {
      const build = await this.db.models.Build.query()
        .whereIn('pullRequestId', (prBuilder) => {
          prBuilder
            .from(this.db.models.PullRequest.tableName)
            .select('id')
            .where('branchName', branchName)
            .whereIn('repositoryId', (repoBuilder) => {
              repoBuilder
                .from(this.db.models.Repository.tableName)
                .select('id')
                .where('githubRepositoryId', githubRepositoryId);
            });
        })
        .andWhere('isStatic', true)
        .andWhere('trackDefaultBranches', true)
        .first();

      if (!build) return;

      getLogger().info(`Push: redeploying reason=staticEnv`);
      await this.db.services.BuildService.enqueueResolveAndDeployBuild({
        buildId: build?.id,
        ...extractContextForQueue(),
      });
    } catch (error) {
      getLogger({}).error(
        { error },
        `Push: static env webhook failed branch=${branchName} repositoryId=${githubRepositoryId}`
      );
    }
  };

  dispatchWebhook = async (req: NextApiRequest) => {
    const { body } = req;
    const type = req.headers['x-github-event'];

    getLogger({}).debug(`Incoming Github Webhook type=${type}`);

    const isVerified = github.verifyWebhookSignature(req);
    if (!isVerified) {
      throw new Error('Webhook not verified');
    }

    const shouldProcessWebhook = await this.shouldProcessWebhook(body);
    if (!shouldProcessWebhook) {
      return;
    }

    switch (type) {
      case GithubWebhookTypes.PULL_REQUEST:
        try {
          const labelNames = body.pull_request.labels.map(({ name }) => name.toLowerCase()) || [];
          if (isStaging() && !labelNames.includes(FallbackLabels.DEPLOY_STG)) {
            getLogger({}).debug(`Staging run detected, skipping processing of this event`);
            return;
          }
          const hasLabelChange = [GithubWebhookTypes.LABELED, GithubWebhookTypes.UNLABELED].includes(body.action);
          if (hasLabelChange) return await this.handleLabelWebhook(body);
          else return await this.handlePullRequestHook(body);
        } catch (e) {
          getLogger({}).error({ error: e }, `GitHub: PULL_REQUEST event handling failed`);
          throw e;
        }
      case GithubWebhookTypes.PUSH:
        try {
          return await this.handlePushWebhook(body);
        } catch (e) {
          getLogger({}).error({ error: e }, `GitHub: PUSH event handling failed`);
          throw e;
        }
      case GithubWebhookTypes.ISSUE_COMMENT:
        try {
          return await this.handleIssueCommentWebhook(body);
        } catch (e) {
          getLogger({}).error({ error: e }, `GitHub: ISSUE_COMMENT event handling failed`);
          throw e;
        }
      case GithubWebhookTypes.REPOSITORY:
        try {
          return await this.handleRepositoryWebhook(body as GithubRepositoryEvent);
        } catch (e) {
          getLogger({}).error({ error: e }, `GitHub: REPOSITORY event handling failed`);
          throw e;
        }
      default:
    }
  };

  webhookQueue = this.queueManager.registerQueue(QUEUE_NAMES.WEBHOOK_PROCESSING, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  processWebhooks = async (job) => {
    const { correlationId, sender, message, _ddTraceContext } = job.data;

    return withLogContext({ correlationId, sender, _ddTraceContext }, async () => {
      try {
        getLogger({ stage: LogStage.WEBHOOK_PROCESSING }).debug('Webhook: processing');
        await this.db.services.GithubService.dispatchWebhook(fParse(message));
      } catch (error) {
        getLogger({ stage: LogStage.WEBHOOK_PROCESSING }).fatal({ error }, 'Error processing webhook');
      }
    });
  };

  githubDeploymentQueue = this.queueManager.registerQueue(QUEUE_NAMES.GITHUB_DEPLOYMENT, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 3,
      removeOnComplete: true,
    },
  });

  processGithubDeployment = async (job) => {
    const { deployId, action, sender, correlationId, _ddTraceContext } = job.data;

    return withLogContext({ correlationId, sender, _ddTraceContext, deployUuid: String(deployId) }, async () => {
      const deploy = await this.db.models.Deploy.query().findById(deployId);
      if (!deploy) {
        getLogger({ stage: LogStage.DEPLOY_FAILED }).warn(
          `GitHub deployment skipped: deployId=${deployId} reason=deploy_not_found`
        );
        return;
      }
      try {
        getLogger({ stage: LogStage.DEPLOY_STARTING }).debug(
          `GitHub deployment: action=${action} deployId=${deployId}`
        );

        switch (action) {
          case 'create': {
            await createOrUpdateGithubDeployment(deploy);
            break;
          }
          case 'delete': {
            await deleteGithubDeploymentAndEnvironment(deploy);
            break;
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }

        getLogger({ stage: LogStage.DEPLOY_COMPLETE }).debug(
          `GitHub deployment completed: action=${action} deployId=${deployId}`
        );
      } catch (error) {
        getLogger({ stage: LogStage.DEPLOY_FAILED }).error(
          `GitHub deployment failed: job=${job?.id} action=${action} error=${error.message}`
        );
        throw error;
      }
    });
  };

  private patchPullRequest = async ({
    pullRequest,
    labels,
    action,
    status,
    autoDeploy = false,
  }): Promise<PullRequestPatchState | undefined> => {
    const labelNames = labels.map(({ name }) => name.toLowerCase()) || [];
    const user = pullRequest?.githubLogin;
    const fullName = pullRequest?.fullName;
    const branch = pullRequest?.branchName;
    try {
      const isBot = await this.db.services.BotUser.isBotUser(user);
      const deployLabelPresent = await hasDeployLabel(labelNames);
      const isDeploy = deployLabelPresent || autoDeploy;
      const isKillSwitch = await enableKillSwitch({
        isBotUser: isBot,
        fullName,
        branch,
        action,
        status,
        labels: labelNames,
      });
      const isDeployOnUpdate = isKillSwitch ? false : isDeploy;
      await pullRequest.$query().patch({
        deployOnUpdate: isDeployOnUpdate,
        labels: JSON.stringify(labelNames),
      });
      return {
        deployLabelPresent,
        deployOnUpdate: isDeployOnUpdate,
      };
    } catch (error) {
      getLogger().error({ error }, `PR: patch failed repo=${pullRequest?.fullName}/${branch}`);
    }
  };

  private isVoidCommit = (commit: string) => commit.split('').every((i) => i === '0');
}
