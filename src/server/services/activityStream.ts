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

import BaseService from './_service';
import { withLogContext, getLogger, extractContextForQueue, LogStage } from 'server/lib/logger';
import { Build, PullRequest, Deploy, Repository } from 'server/models';
import * as github from 'server/lib/github';
import { APP_HOST, QUEUE_NAMES, LIFECYCLE_UI_URL } from 'shared/config';
import { Metrics } from 'server/lib/metrics';
import * as psl from 'psl';
import { CommentHelper } from 'server/lib/comment';
import OverrideService from './override';
import {
  BuildStatus,
  DeployStatus,
  CommentParser,
  DeployTypes,
  CLIDeployTypes,
  PullRequestStatus,
} from 'shared/constants';
import {
  flattenObject,
  enableKillSwitch,
  isStaging,
  hasStatusCommentLabel,
  hasDeployLabel,
  getDeployLabel,
  getDisabledLabel,
  getStatusCommentLabel,
  isDefaultStatusCommentsEnabled,
  isControlCommentsEnabled,
} from 'server/lib/utils';
import Fastly from 'server/lib/fastly';
import { nanoid } from 'nanoid';
import { redisClient } from 'server/lib/dependencies';
import GlobalConfigService from './globalConfig';
import { ChartType, determineChartType } from 'server/lib/nativeHelm';
import { shouldUseNativeHelm } from 'server/lib/nativeHelm';

const createDeployMessage = async () => {
  const deployLabel = await getDeployLabel();
  const disabledLabel = await getDisabledLabel();
  return `To deploy this environment, just add a \`${deployLabel}\` label. Add a \`${disabledLabel}\` to do the opposite. ↗️\n\n`;
};
const COMMENT_EDIT_DESCRIPTION = `You can use the section below to redeploy and update the dev environment for this pull request.\n\n\n`;
const GIT_SERVICE_URL = 'https://github.com';

export default class ActivityStream extends BaseService {
  fastly = new Fastly(this.redis);
  commentQueue = this.queueManager.registerQueue(QUEUE_NAMES.COMMENT_QUEUE, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });

  processComments = async (job) => {
    const { id, sender, correlationId, _ddTraceContext, targetGithubRepositoryId } = job.data;

    return withLogContext({ correlationId, sender, _ddTraceContext }, async () => {
      try {
        getLogger({ stage: LogStage.COMMENT_PROCESSING }).debug(`Processing comment update for PR ${id}`);

        const pullRequest: PullRequest = await this.db.models.PullRequest.findOne({
          id,
        });
        await pullRequest.$fetchGraph('[build.[deploys.[service, deployable]], repository]');
        const { build } = pullRequest;
        if (!build) {
          getLogger({ stage: LogStage.COMMENT_FAILED }).warn(`Build: id not found pullRequestId=${id}`);
          return;
        }

        const { repository } = pullRequest;
        await this.db.services.ActivityStream.updatePullRequestActivityStream(
          build,
          build.deploys,
          pullRequest,
          repository,
          true,
          true,
          null,
          false,
          targetGithubRepositoryId
        );

        getLogger({ stage: LogStage.COMMENT_COMPLETE }).debug(`Comment updated for PR ${id}`);
      } catch (error) {
        getLogger({ stage: LogStage.COMMENT_FAILED }).error(
          { error },
          `Comment: processing failed pullRequestId=${id}`
        );
      }
    });
  };

  /**
   * Figure out if the build contains any fastly related service deployment
   * @param build
   * @returns
   */
  private async containsFastlyDeployment(deploys: Deploy[]): Promise<boolean> {
    const fastlyServices: Deploy[] = deploys.filter((deploy) => deploy.active && deploy.uuid.includes('fastly'));

    return fastlyServices.length > 0;
  }

  /**
   * Handle the comment edit event
   * @param pullRequest
   * @param body
   */
  async updateBuildsAndDeploysFromCommentEdit(pullRequest: PullRequest, commentBody: string) {
    await pullRequest.$fetchGraph('[build.[deploys.[service, deployable]], repository]');
    const { build, repository } = pullRequest;
    const { deploys, id: buildId } = build;
    const buildUuid = build?.uuid;

    return withLogContext({ buildUuid }, async () => {
      let shouldUpdateStatus = true;
      const runUuid = nanoid();

      const REDEPLOY_FLAG = '#REDEPLOY';
      const REDEPLOY_CHECKBOX = '[x] Redeploy Environment';
      const PURGE_FASTLY_CHECKBOX = '[x] Purge Fastly Service Cache';

      const isRedeployRequested = [REDEPLOY_FLAG, REDEPLOY_CHECKBOX].some((flag) => commentBody.includes(flag));
      const isFastlyPurgeRequested = commentBody.includes(PURGE_FASTLY_CHECKBOX);

      try {
        if (isRedeployRequested) {
          getLogger().info('Deploy: redeploy reason=commentEdit');
          await this.db.services.BuildService.resolveAndDeployBuildQueue.add('resolve-deploy', {
            buildId,
            runUUID: runUuid,
            ...extractContextForQueue(),
          });
          return;
        }

        if (isFastlyPurgeRequested) {
          // if fastly purge is requested from comment, we do not have to update the status
          await this.purgeFastlyServiceCache(buildUuid);
          shouldUpdateStatus = false;
          return;
        }

        // handle all environment/service overrides
        await this.applyCommentOverrides({ build, deploys, pullRequest, commentBody, runUuid });
      } finally {
        // after everything update the pr comment
        await this.updatePullRequestActivityStream(
          build,
          deploys,
          pullRequest,
          repository,
          true,
          shouldUpdateStatus,
          null,
          true
        ).catch((error) => {
          getLogger().warn({ error }, 'ActivityFeed: comment edit update failed');
        });
      }
    });
  }

  private async applyCommentOverrides({
    build,
    deploys,
    pullRequest,
    commentBody,
    runUuid,
  }: {
    build: Build;
    deploys: Deploy[];
    pullRequest: PullRequest;
    commentBody: string;
    runUuid: string;
  }) {
    if (!build.id) {
      getLogger().error('Build: missing for comment edit overrides');
      return;
    }

    const serviceOverrides = CommentHelper.parseServiceBranches(commentBody);
    const vanityUrl = CommentHelper.parseVanityUrl(commentBody);
    const envOverrides = CommentHelper.parseEnvironmentOverrides(commentBody);
    const redeployOnPush = CommentHelper.parseRedeployOnPushes(commentBody);

    getLogger().debug(`Parsed environment overrides: ${JSON.stringify(envOverrides)}`);

    await build.$query().patch({
      commentInitEnv: envOverrides,
      commentRuntimeEnv: envOverrides,
      trackDefaultBranches: redeployOnPush,
    });

    getLogger().debug(`Service overrides: ${JSON.stringify(serviceOverrides)}`);

    await Promise.all(serviceOverrides.map((override) => this.patchServiceOverride(build, deploys, override)));

    // handle build uuid updates here
    if (vanityUrl && vanityUrl !== build.uuid) {
      const override = new OverrideService();
      await override.updateBuildUuid(build, vanityUrl);
    }

    // if pull request should be built and deployed again, add it to build queue
    if (pullRequest.deployOnUpdate) {
      await this.db.services.BuildService.resolveAndDeployBuildQueue.add('resolve-deploy', {
        buildId: build.id,
        runUUID: runUuid,
        ...extractContextForQueue(),
      });
    }
  }

  private async patchServiceOverride(build: Build, deploys: Deploy[], { active, serviceName, branchOrExternalUrl }) {
    getLogger().debug(`Patching service: ${serviceName} active=${active} branch/url=${branchOrExternalUrl}`);

    const deploy: Deploy = build.enableFullYaml
      ? deploys.find((d) => d.deployable.name === serviceName)
      : deploys.find((d) => d.service.name === serviceName);

    if (!deploy) {
      getLogger().warn(`Deploy: not found service=${serviceName}`);
      return;
    }

    const { service, deployable } = deploy;

    if (psl.isValid(branchOrExternalUrl)) {
      // External URL override
      // ??? not exactly sure where we use an external url in this context
      await deploy
        .$query()
        .patch({
          publicUrl: branchOrExternalUrl,
          branchName: null,
          dockerImage: null,
          active,
        })
        .catch((error) => {
          getLogger().error({ error }, `Deploy: patch failed service=${serviceName} field=externalUrl`);
        });
    } else {
      getLogger().debug(`Setting branch override: ${branchOrExternalUrl} for deployable: ${deployable?.name}`);
      await deploy.deployable
        .$query()
        .patch({ commentBranchName: branchOrExternalUrl })
        .catch((error) => {
          getLogger().error({ error }, `Deployable: patch failed service=${serviceName} field=branch`);
        });

      await deploy
        .$query()
        .patch({
          branchName: branchOrExternalUrl,
          publicUrl: build.enableFullYaml
            ? this.db.services.Deploy.hostForDeployableDeploy(deploy, deployable)
            : this.db.services.Deploy.hostForServiceDeploy(deploy, service),
          active,
        })
        .catch((error) => {
          getLogger().error({ error }, `Deploy: patch failed service=${serviceName} field=branch`);
        });
    }

    // patch dependent deploys
    if (build.enableFullYaml) {
      const dependents = deploys.filter(
        (d) =>
          d.deployable.dependsOnDeployableName === deploy.deployable.name &&
          d.deployable.buildUUID === deploy.deployable.buildUUID &&
          d.deployable.buildId === deploy.deployable.buildId
      );
      await Promise.all(dependents.map((d) => d.$query().patch({ active })));
    } else {
      const dependents = deploys.filter((d) => d.service.dependsOnServiceId === service.id);
      await Promise.all(dependents.map((d) => d.$query().patch({ active })));
    }
  }

  private async updateMissionControlComment(
    build: Build,
    deploys: Deploy[],
    pullRequest: PullRequest,
    repository: Repository
  ) {
    const fullName = pullRequest?.fullName;
    const pullRequestNumber = pullRequest?.pullRequestNumber;
    const branchName = pullRequest?.branchName;
    try {
      const hasGithubMissionControlComment = await github.checkIfCommentExists({
        fullName,
        pullRequestNumber,
        commentIdentifier: `mission control ${isStaging() ? 'stg ' : ''}comment: enabled`,
      });

      if (hasGithubMissionControlComment && !pullRequest?.commentId) {
        getLogger().warn('Comment: mission control id missing, recovering from GitHub');
        const recoveredCommentId = hasGithubMissionControlComment.id;
        await pullRequest.$query().patch({ commentId: recoveredCommentId });
        pullRequest.commentId = recoveredCommentId;
      }

      const isBot = await this.db.services.BotUser.isBotUser(pullRequest?.githubLogin);
      // get the environment for it's name
      await build.$fetchGraph('environment');
      const message = await this.generateMissionControlComment(build, deploys, repository, pullRequest, isBot);
      const response = await github.createOrUpdatePullRequestComment({
        installationId: repository.githubInstallationId,
        pullRequestNumber: pullRequest.pullRequestNumber,
        fullName: pullRequest.fullName,
        message,
        commentId: pullRequest.commentId,
        etag: pullRequest.etag,
      });
      const etag = response?.headers?.etag;
      const commentId = response?.data?.id;
      await pullRequest.$query().patch({ commentId, etag });
    } catch (error) {
      getLogger().error({ error }, `GitHub: mission control update failed repo=${fullName}/${branchName}`);
    }
  }

  private async updateStatusComment(build: Build, deploys: Deploy[], pullRequest: PullRequest, repository: Repository) {
    const fullName = pullRequest?.fullName;
    let commentId = pullRequest?.statusCommentId;
    const etag = pullRequest?.etag;
    const pullRequestNumber = pullRequest?.pullRequestNumber;
    const installationId = repository?.githubInstallationId;

    const hasStatusComment = await github.checkIfCommentExists({
      fullName,
      pullRequestNumber,
      commentIdentifier: `${isStaging() ? 'stg ' : ''}status comment: enabled`,
    });

    if (hasStatusComment && !commentId) {
      getLogger().warn('Comment: status id missing, recovering from GitHub');
      const recoveredCommentId = hasStatusComment.id;
      await pullRequest.$query().patch({ statusCommentId: recoveredCommentId });
      pullRequest.statusCommentId = recoveredCommentId;
      commentId = recoveredCommentId;
    }
    const message = await this.generateStatusCommentForBuild(build, deploys, pullRequest);
    const response = await github.createOrUpdatePullRequestComment({
      installationId,
      pullRequestNumber,
      fullName,
      message,
      commentId,
      etag,
    });
    await pullRequest.$query().patch({
      statusCommentId: response.data.id,
      etag: response.headers.etag,
    });
  }

  /**
   * Updating all the Lifcycle comment blocks within the Pull Request.
   * @param build The correpsonding build of the pull request
   * @param error Rendering the internal LC error if there is any.
   */
  async updatePullRequestActivityStream(
    build: Build,
    deploys: Deploy[],
    pullRequest: PullRequest,
    repository: Repository,
    updateMissionControl: boolean,
    updateStatus: boolean,
    error: Error = null,
    queue: boolean = true,
    targetGithubRepositoryId?: number
  ) {
    const buildId = build?.id;
    const uuid = build?.uuid;
    const isFullYaml = build?.enableFullYaml;
    const fullName = pullRequest?.fullName;
    const branchName = pullRequest?.branchName;
    const isStatic = build?.isStatic ?? false;
    const labels = pullRequest?.labels || [];
    const hasStatusComment = await hasStatusCommentLabel(labels);
    const isDefaultStatusEnabled = await isDefaultStatusCommentsEnabled(fullName);
    const isShowingStatusComment = isStatic || hasStatusComment || isDefaultStatusEnabled;
    if (!buildId) {
      getLogger().error(`Build: id not found repo=${fullName}/${branchName}`);
      throw new Error('No build ID found for this build!');
    }
    const resource = `build.${buildId}`;
    const queued = queue ? 'queued' : '';
    let lock;
    try {
      lock = await this.redlock.lock(resource, 9000);
      if (queue && !error) {
        await this.commentQueue.add(
          'comment',
          { id: pullRequest.id, targetGithubRepositoryId, ...extractContextForQueue() },
          {
            jobId: `pr-${pullRequest.id}`,
            removeOnComplete: true,
            removeOnFail: true,
          }
        );
        return;
      }

      if (updateStatus || updateMissionControl) {
        const isControlEnabled = await isControlCommentsEnabled(fullName);
        if (isControlEnabled) {
          await this.updateMissionControlComment(build, deploys, pullRequest, repository).catch((error) => {
            getLogger().warn(
              { error },
              `Comment: mission control update failed repo=${fullName}/${branchName} fullYaml=${isFullYaml} queued=${queued}`
            );
          });
        } else {
          getLogger().debug('Mission control comments are disabled');
        }
      }

      if (updateStatus && isShowingStatusComment) {
        await this.updateStatusComment(build, deploys, pullRequest, repository).catch((error) => {
          getLogger().warn(
            { error },
            `Comment: status update failed repo=${fullName}/${branchName} fullYaml=${isFullYaml} queued=${queued}`
          );
        });
      }
    } catch (error) {
      getLogger().error({ error }, `ActivityFeed: update failed repo=${fullName}/${branchName}`);
    } finally {
      if (lock) {
        try {
          await lock.unlock();
        } catch (error) {
          await this.forceUnlock(resource, uuid, fullName, branchName);
        }
      }
    }
  }

  private async forceUnlock(resource: string, buildUuid: string, fullName: string, branchName: string) {
    try {
      await this.redis.del(resource);
    } catch (error) {
      getLogger().error({ error }, `Lock: force unlock failed resource=${resource} repo=${fullName}/${branchName}`);
    }
  }

  /**
   * PR kickoff message
   */
  private async editCommentForBuild(build: Build, deploys: Deploy[]) {
    let message = ``;
    const statusCommentLabel = await getStatusCommentLabel();
    const enableLifecycleStatusComments = `Add \`${statusCommentLabel}\``;
    message += `## ✏️ Environment Overrides\n`;
    message += '<details>\n';
    message += '<summary>Usage</summary>\n\n';

    const enabledFeatures = build?.enabledFeatures || [];
    const hasEnabledFeatures = enabledFeatures?.length > 0;
    if (hasEnabledFeatures) message += `* LC testing features: ${enabledFeatures.join(', ')}\n`;
    message += `* To enable status comments, add the ${enableLifecycleStatusComments} label.\n`;
    message += `* You can enable/disable individual service by clicking the Checkboxes below, OR\nEditing this comment to Enable/Disable multiple services at the same time by changing between \`[]\` and \`[X]\`.\n`;
    message += `* You can also edit the branch name or URL of an external service, to further customize your deployment.\n\n`;
    message += '</details>\n\n';
    message += COMMENT_EDIT_DESCRIPTION;
    message += `\n\n${CommentParser.HEADER}\n\n`;

    await build?.$fetchGraph('[deploys.[service, deployable]]');
    deploys = build?.deploys;

    if (build?.enableFullYaml) {
      message += '\n// **Default Services**\n';
      const filters = [(deploy: Deploy) => deploy.deployable.active, (deploy: Deploy) => !deploy.deployable.active];

      for (const [idx, filter] of filters.entries()) {
        deploys
          .filter(filter)
          .sort((a, b) => (a.deployable.name > b.deployable.name ? 1 : -1))
          .forEach((deploy) => {
            const checked = deploy.active ? 'x' : ' ';

            // Only internal parent services should appear in the list
            if (deploy.deployable.dependsOnServiceId == null) {
              switch (deploy.deployable.type) {
                case DeployTypes.GITHUB:
                  message += `- [${checked}] ${deploy.deployable.name}: ${
                    deploy.branchName ? deploy.branchName : deploy.publicUrl
                  }\n`;
                  break;
                case DeployTypes.EXTERNAL_HTTP:
                  message += `- [${checked}] ${deploy.deployable.name}: ${deploy.publicUrl}\n`;
                  break;
                case DeployTypes.CONFIGURATION:
                case DeployTypes.CODEFRESH:
                  message += `- [${checked}] ${deploy.deployable.name}: ${deploy.branchName}\n`;
                  break;
                case DeployTypes.DOCKER:
                  message += `- [${checked}] ${deploy.deployable.name}: ${deploy.deployable.dockerImage}@${deploy.deployable.defaultTag}\n`;
                  break;
                case DeployTypes.HELM:
                  message += `- [${checked}] ${deploy.deployable.name}: ${deploy.branchName}\n`;
                  break;
              }
            } else {
              getLogger().debug(`Skipping ${deploy.deployable.name} because it is an internal dependency`);
            }
          });

        if (idx === 0) {
          message += '\n\n\n// **Optional Services**\n';
        }
      }
    } else {
      await build?.$fetchGraph('environment');
      const { environment } = build;

      await environment.$fetchGraph('[defaultServices, optionalServices]');

      const optionalServiceIds = new Set(environment.optionalServices.map((s) => s.id));
      const defaultServiceIds = new Set(environment.defaultServices.map((s) => s.id));

      message += '\n// **Default Services**\n';
      const filters = [
        (el: { serviceId: number }) => defaultServiceIds.has(el.serviceId),
        (el: { serviceId: number }) => optionalServiceIds.has(el.serviceId),
      ];
      for (const [idx, filter] of filters.entries()) {
        deploys
          .filter(filter)
          .sort((a, b) => (a.service.name > b.service.name ? 1 : -1))
          .forEach((deploy) => {
            const checked = deploy.active ? 'x' : ' ';
            if (deploy.service.type === DeployTypes.GITHUB) {
              message += `- [${checked}] ${deploy.service.name}: ${
                deploy.branchName ? deploy.branchName : deploy.publicUrl
              }\n`;
            } else if (deploy.service.type === DeployTypes.EXTERNAL_HTTP) {
              message += `- [${checked}] ${deploy.service.name}: ${deploy.publicUrl}\n`;
            } else if ([DeployTypes.CODEFRESH, DeployTypes.CONFIGURATION].includes(deploy.service.type)) {
              message += `- [${checked}] ${deploy.service.name}: ${deploy.branchName}\n`;
            }
          });
        if (idx === 0) {
          message += '\n\n\n// **Optional Services**\n';
        }
      }
    }

    message += '\n\n// **UUID** *(Pick your own custom subdomain)*\n';
    message += `url: ${build.uuid}\n`;

    message +=
      '\n\n// **Override Environment Variables:** *ENV:[KEY]:[VALUE]* --- Example *ENV:GORILLA_FUND:`https://gorillafund.org/`* 🦍 🤝 💪\n';
    message += this.generateEnvBlockForBuild(build);

    message += `\n\n${CommentParser.FOOTER}\n\n`;

    if (build.status !== BuildStatus.TORN_DOWN) {
      message += '## 🛠 Actions\n*(Trigger actions by clicking the checkboxes)*\n';
      if (!build.isStatic) message += `- [ ] Redeploy Environment\n`;
      if (await this.containsFastlyDeployment(deploys)) {
        if ((await this.fastly.getServiceDashboardUrl(build.uuid, 'fastly')) != null) {
          message += `- [ ] Purge Fastly Service Cache\n`;
        }
      }
    }

    if (build.trackDefaultBranches) {
      message += '### Options\n*(Toggle options by clicking the checkboxes)*\n';
      message += `- [x] Redeploy on pushes to default branches\n\n`;
    }

    return message;
  }

  private generateEnvBlockForBuild(build: Build) {
    let message = '';
    Object.entries(flattenObject(build.commentRuntimeEnv)).forEach((el) => {
      message += `ENV:${el[0]}:${el[1]}\n`;
    });
    return message;
  }

  /**
   * Generating Mission Control comment block message. It should be always available in any build status.
   * @param build
   * @returns
   */
  private async generateMissionControlComment(
    build: Build,
    deploys: Deploy[],
    repository: Repository,
    pullRequest: PullRequest,
    isBot?: boolean
  ) {
    const uuid = build?.uuid;
    const branchName = pullRequest?.branchName;
    const fullName = pullRequest?.fullName;
    const status = pullRequest?.status;
    const isOpen = status === PullRequestStatus.OPEN;
    const sha = build?.sha;
    const labels = pullRequest?.labels || [];
    const buildStatus = build?.status;
    let message = '';
    try {
      const repositoryName = fullName?.length && fullName?.includes('/') ? fullName.split('/')[1] : '';
      const isBuilding = [BuildStatus.BUILDING, BuildStatus.BUILT].includes(buildStatus as BuildStatus);
      const isDeploying = buildStatus === BuildStatus.DEPLOYING;
      const isAutoDeployingBuild = pullRequest.deployOnUpdate && buildStatus === BuildStatus.BUILT;
      const isReadyToDeployBuild = !pullRequest.deployOnUpdate && buildStatus === BuildStatus.BUILT;
      const isPending = [
        BuildStatus.QUEUED,
        BuildStatus.TORN_DOWN,
        BuildStatus.PENDING,
        BuildStatus.TEARING_DOWN,
      ].includes(buildStatus as BuildStatus);
      const isDeployed = buildStatus === BuildStatus.DEPLOYED;
      let deployStatus;
      const hasDeployLabelPresent = await hasDeployLabel(labels);
      const tags = { uuid, repositoryName, branchName, env: 'prd', service: 'lifecycle-job', statsEvent: 'deployment' };
      const eventDetails = {
        title: 'Deployment Finished',
        description: `deployment ${uuid} has finished for ${repositoryName} on branch ${branchName}`,
      };
      const isBotUser = await this.db.services.BotUser.isBotUser(pullRequest?.githubLogin);
      // will disable metrics if true
      const isKillSwitch = await enableKillSwitch({
        fullName,
        branch: branchName,
        isBotUser,
        status,
      });
      const statOptions = { sha, uuid, branchName, repositoryName, tags, eventDetails, disable: isKillSwitch };
      const metrics = new Metrics('deployment', statOptions);
      const hasErroringActiveDeploys = deploys.some(
        (deploy) => deploy?.status === DeployStatus.ERROR && deploy?.active
      );
      const isDeployedWithActiveErrors = isDeployed && hasErroringActiveDeploys;
      if (isDeployedWithActiveErrors) {
        const deployStatuses = deploys.map(({ branchName, uuid, status }) => ({ branchName, uuid, status }));
        getLogger().info(`Build: deployedWithErrors status=${buildStatus} deploys=${JSON.stringify(deployStatuses)}`);
        metrics
          .increment('deployWithErrors')
          .event('Deploy Finished with Erroring Deploys', `${eventDetails.description} with erroring deploys`);
      }
      if (isPending || !isOpen) deployStatus = 'is pending ⏳';
      else if (isBuilding) {
        deployStatus = 'is building 🏗️';
      } else if (isAutoDeployingBuild || isDeploying) {
        deployStatus = 'is deploying 🚀';
      } else if (isReadyToDeployBuild) deployStatus = 'is ready to deploy 🚀';
      else if ((buildStatus === BuildStatus.ERROR && pullRequest.deployOnUpdate) || isDeployedWithActiveErrors) {
        deployStatus = 'deployed with an Error ⚠️';
        const tags = { error: 'error_during_deploy', result: 'error' };
        metrics.increment('total', tags).event(eventDetails.title, eventDetails.description);
      } else if (buildStatus === BuildStatus.CONFIG_ERROR) {
        deployStatus = 'has a configuration error ⚠️';
        const tags = { error: 'config_error', result: 'complete' };
        metrics.increment('total', tags).event(eventDetails.title, eventDetails.description);
      } else if (isDeployed) {
        deployStatus = 'is deployed ✅';
        const tags = { result: 'complete', error: '' };
        metrics.increment('total', tags).event(eventDetails.title, eventDetails.description);
      } else {
        deployStatus = 'has an uncaptured Status ⚠️';
        const tags = { error: 'uncaptured_status', result: 'error' };
        metrics.increment('total', tags).event(eventDetails.title, eventDetails.description);
      }
      message = `### 💻✨ Your environment ${deployStatus}.\n`;
      if (LIFECYCLE_UI_URL) {
        message += `View details [here](${LIFECYCLE_UI_URL}/build/${uuid})\n`;
      }
      if (!hasDeployLabelPresent && !isBot && isPending && isOpen) {
        message += await createDeployMessage();
      }

      message += await this.editCommentForBuild(build, deploys).catch((error) => {
        getLogger().error({ error }, `Comment: mission control generation failed fullYaml=${build.enableFullYaml}`);
        return '';
      });

      if (isDeployed) {
        message += '\n---\n\n';
        message += `## 📦 Deployments\n\n`;
        message += await this.environmentBlock(build).catch((error) => {
          getLogger().error({ error }, `Comment: env block generation failed fullYaml=${build.enableFullYaml}`);
          return '';
        });
      }

      message += `\n\nmission control ${isStaging() ? 'stg ' : ''}comment: enabled \n`;
      return message;
    } catch (error) {
      getLogger().error({ error }, `Comment: mission control generation failed repo=${fullName}/${branchName}`);
      return message;
    }
  }

  private getStatusText(deploy: Deploy) {
    switch (deploy.status) {
      case DeployStatus.BUILDING:
        return `🏗️ BUILDING`;
      case DeployStatus.BUILT:
        return `👍 BUILT`;
      case DeployStatus.ERROR:
        return `⚠️ ERROR`;
      case DeployStatus.CLONING:
        return `⬇️ CLONING`;
      case DeployStatus.READY:
        return `✅ READY`;
      case DeployStatus.DEPLOYING:
        return `🚀 DEPLOYING`;
      case DeployStatus.DEPLOY_FAILED:
        return `⚠️ FAILED`;
      case DeployStatus.QUEUED:
        return `⏳ QUEUED`;
      case DeployStatus.WAITING:
        return `⏳ WAITING`;
      case DeployStatus.BUILD_FAILED:
        return `❌ BUILD FAILED`;
      default:
        return deploy.status;
    }
  }

  private async hasAnyServiceWithDeployLogs(deploys: Deploy[]): Promise<boolean> {
    for (const deploy of deploys) {
      if ((await this.isNativeHelmDeployment(deploy)) || this.isGitHubKubernetesDeployment(deploy)) {
        return true;
      }
    }
    return false;
  }

  private async isNativeHelmDeployment(deploy: Deploy): Promise<boolean> {
    return deploy.deployable?.type === DeployTypes.HELM && (await shouldUseNativeHelm(deploy));
  }

  private isNativeBuildDeployment(deploy: Deploy): boolean {
    if (!deploy.deployable) return false;
    return (
      [DeployTypes.GITHUB, DeployTypes.HELM].includes(deploy.deployable.type) &&
      ['buildkit', 'kaniko'].includes(deploy.deployable.builder?.engine)
    );
  }

  private isGitHubKubernetesDeployment(deploy: Deploy): boolean {
    if (!deploy.deployable) return false;
    const deployType = deploy.deployable.type;
    return deployType === DeployTypes.GITHUB || deployType === DeployTypes.DOCKER || CLIDeployTypes.has(deployType);
  }

  /**
   * Generating comment message for status comment for the PR. This comment block should be dynamic change based on build status.
   * @param build
   * @returns
   */
  private async generateStatusCommentForBuild(build: Build, deploys: Deploy[], pullRequest: PullRequest) {
    let message = '';

    const nextStepsList = LIFECYCLE_UI_URL
      ? `### Next steps:\n\n- Review the [Lifecycle UI](${LIFECYCLE_UI_URL}/build/${build.uuid})\n`
      : '';
    const isBot = await this.db.services.BotUser.isBotUser(pullRequest?.githubLogin);
    const isBuilding = [BuildStatus.BUILDING, BuildStatus.BUILT].includes(build.status as BuildStatus);
    const isDeploying = build.status === BuildStatus.DEPLOYING;
    const isAutoDeployingBuild = pullRequest.deployOnUpdate && build.status === BuildStatus.BUILT;
    const isReadyToDeployBuild = !pullRequest.deployOnUpdate && build.status === BuildStatus.BUILT;
    const isPending = [BuildStatus.QUEUED, BuildStatus.TORN_DOWN].includes(build.status as BuildStatus);
    if (isPending) {
      message += '## ⏳ Pending\n';
      message += `Lifecycle Environment either has been torn down or does not exist.`;
      if (isBot) {
        const deployLabel = await getDeployLabel();
        message += `\n\n**This PR is created by a bot user, add ${deployLabel} to build environment**`;
      } else {
        const disabledLabel = await getDisabledLabel();
        message += `\n\n*Note: If ${disabledLabel} label present, remove to build environment*`;
      }
    } else if (isBuilding) {
      message += '## 🏗️ Building\n';
      message += 'We are busy building your code...\n';
      message += '## Build Status\n';
      message += await this.buildStatusBlock(build, deploys, null).catch((error) => {
        getLogger().error({ error }, `Comment: build status generation failed fullYaml=${build.enableFullYaml}`);
        return '';
      });

      message += `\nHere's where you can find your services after they're deployed:\n`;
      message += await this.environmentBlock(build).catch((error) => {
        getLogger().error({ error }, `Comment: env block generation failed fullYaml=${build.enableFullYaml}`);
        return '';
      });

      if (pullRequest.deployOnUpdate === false) {
        message += await createDeployMessage();
      } else {
        message += `\nWe'll deploy your code once we've finished this build step.`;
      }
    } else if (isAutoDeployingBuild || isDeploying) {
      message += '## 🚀 Deploying\n';
      message += `We're deploying your code. Please stand by....\n\n`;
      message += '## Build Status\n';
      message += await this.buildStatusBlock(build, deploys, null).catch((error) => {
        getLogger().error({ error }, `Comment: build status generation failed fullYaml=${build.enableFullYaml}`);
        return '';
      });
      message += `\nHere's where you can find your services after they're deployed:\n`;
      message += await this.environmentBlock(build).catch((e) => {
        getLogger().error({ error: e }, `Comment: env block generation failed fullYaml=${build.enableFullYaml}`);
        return '';
      });
      message += await this.dashboardBlock(build, deploys).catch((e) => {
        getLogger().error({ error: e }, `Comment: dashboard generation failed fullYaml=${build.enableFullYaml}`);
        return '';
      });
    } else if (isReadyToDeployBuild) {
      message += '## 🚀 Ready to deploy\n';
      message += `Your code is built. We're ready to deploy whenever you are.\n`;
      message += await this.deployingBlock(build).catch((e) => {
        getLogger().error(
          { error: e },
          `Comment: deployment status generation failed fullYaml=${build.enableFullYaml}`
        );
        return '';
      });
      message += await createDeployMessage();
    } else if (pullRequest.deployOnUpdate) {
      message = '';
      if (build.status === BuildStatus.ERROR) {
        message += `## ⚠️ Deployed with Error\n`;
        message += `There was a problem deploying your code. Some services may have not rolled out successfully. Here are the URLs for your services:\n\n`;
        message += '## Build Status\n';
        message += await this.buildStatusBlock(build, deploys, null).catch((error) => {
          getLogger().error({ error }, `Comment: build status generation failed fullYaml=${build.enableFullYaml}`);
          return '';
        });
        message += await this.environmentBlock(build).catch((e) => {
          getLogger().error({ error: e }, `Comment: env block generation failed fullYaml=${build.enableFullYaml}`);
          return '';
        });
        message += await this.dashboardBlock(build, deploys).catch((e) => {
          getLogger().error({ error: e }, `Comment: dashboard generation failed fullYaml=${build.enableFullYaml}`);
          return '';
        });
      } else if (build.status === BuildStatus.CONFIG_ERROR) {
        message += `## ⚠️ Configuration Error\n`;
        message += `Lifecycle configuration file is found but there is a problem with the file.\n\n`;
      } else if (build.status === BuildStatus.DEPLOYED) {
        message += '## ✅ Deployed\n';
        message += '## Build Status\n';
        message += await this.buildStatusBlock(build, deploys, null).catch((error) => {
          getLogger().error({ error }, `Comment: build status generation failed fullYaml=${build.enableFullYaml}`);
          return '';
        });
        message += `\nWe've deployed your code. Here's where you can find your services:\n`;
        message += await this.environmentBlock(build).catch((e) => {
          getLogger().error({ error: e }, `Comment: env block generation failed fullYaml=${build.enableFullYaml}`);
          return '';
        });
        message += await this.dashboardBlock(build, deploys).catch((e) => {
          getLogger().error({ error: e }, `Comment: dashboard generation failed fullYaml=${build.enableFullYaml}`);
          return '';
        });
      } else {
        message += `## ⚠️ Unexpected Build Status\n`;
        message += `The build status is ${build?.status || 'undefined'}.\n\n`;
        message += nextStepsList;
      }
    }

    message += `\n\n${
      isStaging() ? 'stg ' : ''
    }status comment: enabled. Mission control statuses may be slightly out of sync.\n`;

    return message;
  }

  private async buildStatusBlock(
    build: Build,
    deploys: Deploy[],
    // eslint-disable-next-line no-unused-vars
    isSelectedDeployType: (deploy: Deploy, fullYamlSupport: boolean, orgChart: string) => boolean
  ): Promise<string> {
    let message = '';

    // Check if any service should show deploy logs column
    const hasDeployLogsColumn = await this.hasAnyServiceWithDeployLogs(deploys);

    // Add table headers
    message += '| Service | Branch | Status | Build Pipeline |';
    if (hasDeployLogsColumn) {
      message += ' Deploy Logs |';
    }
    message += '\n';

    // Add separator row
    message += '|---|---|---|---|';
    if (hasDeployLogsColumn) {
      message += '---|';
    }
    message += '\n';

    await build?.$fetchGraph('[deploys.[service, deployable.repository]]');
    deploys = build.deploys;

    const orgChartName = await GlobalConfigService.getInstance().getOrgChartName();
    if (deploys.length > 1) {
      deploys = deploys.sort((a, b) => a.id - b.id);
    }

    // Convert forEach to for...of to handle async/await properly
    for (const deploy of deploys) {
      const serviceName: string = build.enableFullYaml ? deploy.deployable.name : deploy.service.name;
      const serviceType: DeployTypes = build.enableFullYaml ? deploy.deployable.type : deploy.service.type;
      const serviceNameWithUrl = deploy.deployable.repositoryId
        ? `[${serviceName}](${GIT_SERVICE_URL}/${deploy.deployable?.repository?.fullName}/tree/${deploy.branchName})`
        : serviceName;

      if (isSelectedDeployType == null || isSelectedDeployType(deploy, build.enableFullYaml, orgChartName)) {
        if ([DeployTypes.GITHUB, DeployTypes.HELM].includes(serviceType) && deploy.active) {
          // Show Build Logs link if:
          // 1. It's a Codefresh build and buildLogs URL exists, OR
          // 2. It's a Native Build V2 deployment
          let buildLogsColumn = '';
          if (deploy.buildLogs) {
            // Keep existing Codefresh build logs URL
            buildLogsColumn = deploy.buildLogs;
          } else if (this.isNativeBuildDeployment(deploy)) {
            // Always show Native Build logs link - we query Kubernetes directly
            const actualServiceName = deploy.deployable?.name || serviceName;
            buildLogsColumn = `[Build Logs](${APP_HOST}/builds/${build.uuid}/services/${actualServiceName}/buildLogs)`;
          }

          let row = `| ${serviceNameWithUrl} | ${deploy.branchName} | _${this.getStatusText(
            deploy
          )}_ | ${buildLogsColumn} |`;

          if (hasDeployLogsColumn) {
            const deployLogsColumn =
              (await this.isNativeHelmDeployment(deploy)) || this.isGitHubKubernetesDeployment(deploy)
                ? `[Deploy Logs](${APP_HOST}/builds/${build.uuid}/services/${
                    deploy.deployable?.name || serviceName
                  }/deployLogs)`
                : '';
            row += ` ${deployLogsColumn} |`;
          }

          message += row + '\n';
        } else if (CLIDeployTypes.has(serviceType) && deploy.active) {
          if (serviceType === DeployTypes.CODEFRESH) {
            // For Codefresh, just keep the existing buildLogs URL if available
            const buildLogsColumn = deploy.buildLogs || '';

            let row = `| ${serviceNameWithUrl} | ${deploy.branchName} | _${this.getStatusText(
              deploy
            )}_ | ${buildLogsColumn} |`;

            if (hasDeployLogsColumn) {
              const deployLogsColumn =
                (await this.isNativeHelmDeployment(deploy)) || this.isGitHubKubernetesDeployment(deploy)
                  ? `[Deploy Logs](${APP_HOST}/builds/${build.uuid}/services/${
                      deploy.deployable?.name || serviceName
                    }/deployLogs)`
                  : '';
              row += ` ${deployLogsColumn} |`;
            }

            message += row + '\n';
          } else {
            let row = `| ${serviceNameWithUrl} || _${this.getStatusText(deploy)}_ ||`;

            if (hasDeployLogsColumn) {
              const deployLogsColumn =
                (await this.isNativeHelmDeployment(deploy)) || this.isGitHubKubernetesDeployment(deploy)
                  ? `[Deploy Logs](${APP_HOST}/builds/${build.uuid}/services/${
                      deploy.deployable?.name || serviceName
                    }/deployLogs)`
                  : '';
              row += ` ${deployLogsColumn} |`;
            }

            message += row + '\n';
          }
        }
      }
    }

    return message;
  }

  private async deployingBlock(build: Build): Promise<string> {
    let message = '';
    message += '| Service | Branch | Status |\n';
    message += '|---|---|---|\n';

    await build?.$fetchGraph('[deploys.[service, deployable]]');

    let { deploys } = build;
    if (deploys.length > 1) {
      deploys = deploys.sort((a, b) => a.id - b.id);
    }

    deploys
      .sort((a, b) => a.id - b.id)
      .forEach((deploy) => {
        const serviceName: string = build.enableFullYaml ? deploy.deployable.name : deploy.service.name;

        const serviceType: DeployTypes = build.enableFullYaml ? deploy.deployable.type : deploy.service.type;

        if (serviceType === DeployTypes.GITHUB) {
          message += `|${serviceName}|${deploy.branchName}|${deploy.status}|\n`;
        }
      });

    return message;
  }

  private async environmentBlock(build: Build): Promise<string> {
    let message = '';
    message += '### Lifecycle Environments\n';
    message += '| Service | Branch | Link |\n';
    message += '|---|---|---|\n';

    await build?.$fetchGraph('[deploys.[service, deployable.repository]]');

    let { deploys } = build;
    if (deploys.length > 1) {
      deploys = deploys.sort((a, b) => a.id - b.id);
    }
    for (const deploy of deploys) {
      const { service, deployable } = deploy;
      const chartType = await determineChartType(deploy);
      const isPublicChart = chartType === ChartType.PUBLIC;

      const servicePublic: boolean = build.enableFullYaml ? deployable.public || !isPublicChart : service.public;
      const serviceName: string = build.enableFullYaml ? deployable.name : service.name;
      const serviceType: DeployTypes = build.enableFullYaml ? deployable.type : service.type;
      const serviceHostPortMapping: Record<string, any> = build.enableFullYaml
        ? deployable.hostPortMapping
        : service.hostPortMapping;
      const serviceNameWithUrl = deploy.deployable.repositoryId
        ? `[${serviceName}](${GIT_SERVICE_URL}/${deploy.deployable?.repository?.fullName}/tree/${deploy.branchName})`
        : serviceName;

      if (
        servicePublic &&
        deploy.active &&
        (serviceType === DeployTypes.DOCKER ||
          serviceType === DeployTypes.GITHUB ||
          serviceType === DeployTypes.CODEFRESH ||
          !isPublicChart)
      ) {
        if (serviceHostPortMapping && Object.keys(serviceHostPortMapping).length > 0) {
          Object.keys(serviceHostPortMapping).forEach((key) => {
            message += `| ${key}-${serviceNameWithUrl} | ${deploy.branchName} | https://${key}-${deploy.publicUrl}|\n`;
          });
        } else {
          message += `| ${serviceNameWithUrl} | ${deploy.branchName} | https://${deploy.publicUrl}|\n`;
        }
      }
    }

    return message + '\n';
  }

  private async dashboardBlock(build: Build, deploys: Deploy[]) {
    const datadogLogFastlyUrl = new URL('https://app.datadoghq.com/logs');
    const datadogLogUrl = new URL('https://app.datadoghq.com/logs');
    const datadogServerlessUrl = new URL('https://app.datadoghq.com/functions');
    const datadogTraceUrl = new URL('https://app.datadoghq.com/apm/traces');
    const datadogRumSessionsUrl = new URL('https://app.datadoghq.com/rum/explorer');
    const datadogContainersUrl = new URL('https://app.datadoghq.com/containers');

    datadogLogFastlyUrl.searchParams.append('query', `source:fastly @request.host:*${build.uuid}*`);
    datadogLogFastlyUrl.searchParams.append('paused', 'false');
    datadogLogUrl.searchParams.append('query', `env:lifecycle-${build.uuid}`);
    datadogLogUrl.searchParams.append('paused', 'false');
    datadogServerlessUrl.searchParams.append('text_search', `env:*${build.uuid}*`);
    datadogServerlessUrl.searchParams.append('paused', 'false');
    datadogTraceUrl.searchParams.append('query', `env:*${build.uuid}*`);
    datadogTraceUrl.searchParams.append('paused', 'false');
    datadogRumSessionsUrl.searchParams.append('query', `env:*${build.uuid}*`);
    datadogRumSessionsUrl.searchParams.append('live', 'true');
    datadogContainersUrl.searchParams.append('query', `env:lifecycle-${build.uuid}`);
    datadogContainersUrl.searchParams.append('paused', 'false');

    let message = '<details>\n';
    message += '<summary>Dashboards</summary>\n\n';
    message += '|| Links |\n';
    message += '| ------------- | ------------- |\n';
    message += `| Fastly Logs | ${datadogLogFastlyUrl.href} |\n`;
    message += `| Containers | ${datadogContainersUrl.href} |\n`;
    message += `| Lifecycle Env Logs | ${datadogLogUrl.href} |\n`;
    message += `| Tracing | ${datadogTraceUrl.href} |\n`;
    message += `| Serverless | ${datadogServerlessUrl.href} |\n`;
    message += `| RUM (If Enabled) | ${datadogRumSessionsUrl.href} |\n`;
    if (await this.containsFastlyDeployment(deploys)) {
      const fastlyServiceDashboardUrl: URL = await this.fastly.getServiceDashboardUrl(build.uuid, 'fastly');
      if (fastlyServiceDashboardUrl) {
        message += `| Fastly Dashboard | ${fastlyServiceDashboardUrl.href} |\n`;
      }
    }
    message += '</details>\n';

    return message;
  }

  private async purgeFastlyServiceCache(uuid: string) {
    return withLogContext({ buildUuid: uuid }, async () => {
      try {
        const computeShieldServiceId = await this.fastly.getFastlyServiceId(uuid, 'compute-shield');
        getLogger().debug(`Fastly computeShieldServiceId=${computeShieldServiceId}`);
        if (computeShieldServiceId) {
          await this.fastly.purgeAllServiceCache(computeShieldServiceId, uuid, 'fastly');
        }

        const optimizelyServiceId = await this.fastly.getFastlyServiceId(uuid, 'optimizely');
        getLogger().debug(`Fastly optimizelyServiceId=${optimizelyServiceId}`);
        if (optimizelyServiceId) {
          await this.fastly.purgeAllServiceCache(optimizelyServiceId, uuid, 'optimizely');
        }

        const fastlyServiceId = await this.fastly.getFastlyServiceId(uuid, 'fastly');
        getLogger().debug(`Fastly fastlyServiceId=${fastlyServiceId}`);
        if (fastlyServiceId) {
          await this.fastly.purgeAllServiceCache(fastlyServiceId, uuid, 'fastly');
        }
        getLogger().info(`Fastly: purged serviceId=${fastlyServiceId}`);
      } catch (error) {
        getLogger().error({ error }, 'Fastly: cache purge failed');
      }
    });
  }
}
