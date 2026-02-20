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
import { IssueCommentEvent, PullRequestEvent, PushEvent } from '@octokit/webhooks-types';
import {
  GithubPullRequestActions,
  GithubWebhookTypes,
  PullRequestStatus,
  FallbackLabels,
  DeployStatus,
} from 'shared/constants';
import { QUEUE_NAMES } from 'shared/config';
import { NextApiRequest } from 'next';
import * as github from 'server/lib/github';
import { Environment, Repository, Build, PullRequest } from 'server/models';
import { LifecycleYamlConfigOptions } from 'server/models/yaml/types';
import { createOrUpdateGithubDeployment, deleteGithubDeploymentAndEnvironment } from 'server/lib/github/deployments';
import { enableKillSwitch, isStaging, hasDeployLabel } from 'server/lib/utils';
import { redisClient } from 'server/lib/dependencies';

export default class GithubService extends Service {
  // Handle the pull request webhook mapping the entrance with webhook body
  async handlePullRequestHook({
    action,
    number,
    repository: {
      id: repositoryId,
      owner: { id: ownerId, html_url: htmlUrl },
      name,
      full_name: fullName,
    },
    installation: { id: installationId },
    pull_request: {
      id: githubPullRequestId,
      head: { ref: branch, sha: branchSha },
      title,
      user: { login: githubLogin },
      state: status,
      labels,
    },
  }: PullRequestEvent) {
    getLogger({}).info(`PR: ${action} repo=${fullName} branch=${branch}`);
    const isOpened = [GithubPullRequestActions.OPENED, GithubPullRequestActions.REOPENED].includes(
      action as GithubPullRequestActions
    );
    const isClosed = action === GithubPullRequestActions.CLOSED;
    let environment = {} as Environment;
    let lifecycleConfig = {} as LifecycleYamlConfigOptions;
    let pullRequest: PullRequest, repository: Repository, build: Build;

    try {
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
      repository = await this.db.services.Repository.findRepository(ownerId, repositoryId, installationId);
      const autoDeploy = lifecycleConfig?.environment?.autoDeploy;

      if (!repository) {
        environment = await this.db.services.Environment.findOrCreateEnvironment(name, name, autoDeploy);

        repository = await this.db.services.Repository.findOrCreateRepository(
          ownerId,
          repositoryId,
          installationId,
          fullName,
          htmlUrl,
          environment.id
        );

        // NOTE: we don't want to create a service record by default anymore to avoid naming the service after the repo name
        // const isFullYaml = this.db.services.Environment.enableFullYamlSupport(environment);
        // if (isFullYaml) this.db.services.LCService.findOrCreateDefaultService(environment, repository);
      }

      pullRequest = await this.db.services.PullRequest.findOrCreatePullRequest(repository, githubPullRequestId, {
        title,
        status,
        number,
        deployOnUpdate: autoDeploy ?? false,
        fullName,
        githubLogin,
        branch,
      });

      await this.patchPullRequest({
        pullRequest,
        labels,
        action,
        status,
        autoDeploy,
      });

      const pullRequestId = pullRequest?.id;
      const latestCommit = pullRequest?.latestCommit;

      if (isOpened) {
        if (!latestCommit) await pullRequest.$query().patch({ latestCommit: branchSha });
        const environmentId = repository?.defaultEnvId;
        await pullRequest.$query().first();
        const isDeploy = pullRequest?.deployOnUpdate;
        // only create build and deploys. do not build or deploy here
        await this.db.services.BuildService.createBuildAndDeploys({
          repositoryId: repositoryId.toString(),
          repositoryBranchName: branch,
          installationId,
          pullRequestId,
          environmentId,
          lifecycleConfig,
        });

        // if auto deploy, add deploy label via queue
        if (isDeploy) {
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
      pull_request: { id: githubPullRequestId, labels, state: status },
    } = body;
    let pullRequest: PullRequest, build: Build, _repository: Repository;
    try {
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
      _repository = pullRequest?.repository;
      await this.patchPullRequest({
        pullRequest,
        labels,
        action,
        status,
        autoDeploy: false,
      });
      getLogger().info(`Label: ${action} labels=[${labels.map(({ name }) => name).join(',')}]`);

      if (pullRequest.deployOnUpdate === false) {
        // when pullRequest.deployOnUpdate is false, it means that there is no `lifecycle-deploy!` label
        // or there is `lifecycle-disabled!` label in the PR
        return this.db.services.BuildService.deleteBuild(build);
      }

      const buildId = build?.id;
      if (!buildId) {
        getLogger().error(`Build: id not found for=handleLabelWebhook`);
      }
      await this.db.services.BuildService.resolveAndDeployBuildQueue.add('resolve-deploy', {
        buildId,
        ...extractContextForQueue(),
      });
    } catch (error) {
      getLogger().error({ error }, `Label: webhook processing failed`);
    }
  };

  handlePushWebhook = async ({ ref, before: previousCommit, after: latestCommit, repository }: PushEvent) => {
    const { id: githubRepositoryId, full_name: repoName } = repository;
    const branchName = ref.split('refs/heads/')[1];
    if (!branchName) return;
    const hasVoidCommit = [previousCommit, latestCommit].some((commit) => this.isVoidCommit(commit));
    getLogger({}).debug(`Push event repo=${repoName} branch=${branchName}`);
    const models = this.db.models;

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
        const serviceBranchName: string = deploy.build.enableFullYaml
          ? deploy.deployable.defaultBranchName
          : deploy.service.branchName;
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
          getLogger().info(`Push: deploying repo=${repoName} branch=${branchName}`);
        }

        await this.db.services.BuildService.resolveAndDeployBuildQueue.add('resolve-deploy', {
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
   * okay! most times the static environment builds are in a separate repo. because of this, we will not have a deploy with this repo's
   * github repository id and branch name causing pushes to this branch to not trigger a redeploy.
   * Ideally when a service is added or removed in a static env branch, we want to rebuild the whole environment.
   * this is a patch to achieve this
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
      await this.db.services.BuildService.resolveAndDeployBuildQueue.add('resolve-deploy', {
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

  private patchPullRequest = async ({ pullRequest, labels, action, status, autoDeploy = false }) => {
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
    } catch (error) {
      getLogger().error({ error }, `PR: patch failed repo=${pullRequest?.fullName}/${branch}`);
    }
  };

  private isVoidCommit = (commit: string) => commit.split('').every((i) => i === '0');
}
