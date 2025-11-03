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

import rootLogger from 'server/lib/logger';
import { PullRequest, Repository } from 'server/models';
import BaseService from './_service';
import { UniqueViolationError } from 'objection';
import _ from 'lodash';
import * as github from 'server/lib/github';
import { QUEUE_NAMES } from 'shared/config';
import GlobalConfigService from './globalConfig';
import { redisClient } from 'server/lib/dependencies';

export interface PullRequestOptions {
  title: string;
  status: string;
  deployOnUpdate: boolean;
  number: number;
  fullName: string;
  githubLogin: string;
  branch: string;
}

const logger = rootLogger.child({
  filename: 'services/pullRequest.ts',
});

export default class PullRequestService extends BaseService {
  /**
   * Get Pull Request Model. If it doesn't exist in the database, create a new one.
   * @param repository Github Repository the PR is created.
   * @param githubPullRequestId The Github pull request ID.
   * @param options Additional meta data to help creating the pull request in the database.
   * @returns Pull request model
   */
  async findOrCreatePullRequest(repository: Repository, githubPullRequestId: number, options: PullRequestOptions) {
    const { title, status, number: pullRequestNumber, fullName, deployOnUpdate, githubLogin } = options;

    let pullRequest = await this.db.models.PullRequest.findOne({
      repositoryId: repository.id,
      githubPullRequestId,
    });

    if (!pullRequest) {
      // If not found, try to create new one
      try {
        pullRequest = await this.db.models.PullRequest.create({
          githubPullRequestId,
          repositoryId: repository.id,
          deployOnUpdate,
          githubLogin: options.githubLogin,
          branchName: options.branch,
        });
      } catch (error) {
        if (error instanceof UniqueViolationError) {
          logger.info(
            `[REPO]${fullName} [PR#]${pullRequestNumber} Pull request already exists, fetching existing record`
          );
          pullRequest = await this.db.models.PullRequest.findOne({
            repositoryId: repository.id,
            githubPullRequestId,
          });

          if (!pullRequest) {
            // should never happen, but just in case
            throw new Error(
              `Failed to find pull request after unique violation for repo ${repository.id}, PR ${githubPullRequestId}`
            );
          }
        } else {
          logger.error(`[REPO]${fullName} [PR#]${pullRequestNumber} Failed to create pull request: ${error}`);
          throw error;
        }
      }
    }

    const updates: any = {
      title,
      status,
      pullRequestNumber,
      fullName,
    };

    if (pullRequest.githubLogin == null && githubLogin) {
      updates.githubLogin = githubLogin;
    }

    if (status === 'open' && !pullRequest.deployOnUpdate && deployOnUpdate) {
      updates.deployOnUpdate = deployOnUpdate;
    }

    await pullRequest.$query().patch(updates);

    pullRequest.$setRelated('repository', repository);
    return pullRequest;
  }

  async lifecycleEnabledForPullRequest(pullRequest: PullRequest): Promise<boolean> {
    // Check the status & labels for the pull request in github
    try {
      await pullRequest.$fetchGraph('repository');

      const labelsConfig = await GlobalConfigService.getInstance().getLabels();
      const hasLabel = await this.pullRequestHasLabelsAndState(
        pullRequest.pullRequestNumber,
        pullRequest.repository.githubInstallationId,
        pullRequest.repository.fullName.split('/')[0],
        pullRequest.repository.fullName.split('/')[1],
        labelsConfig.deploy,
        'open'
      );
      return hasLabel;
    } catch (e) {
      logger.error(`[REPO]${pullRequest.fullName} [PR NUM]${pullRequest.pullRequestNumber}: ${e}`);
      return true;
    }
  }

  async pullRequestHasLabelsAndState(
    githubPullRequestId: number,
    installationId: number,
    owner,
    name,
    labels: string[],
    state: string
  ): Promise<boolean> {
    // Check the status & labels for the pull request in github
    try {
      const response = await github.getPullRequest(owner, name, githubPullRequestId, installationId);
      const labelSet = new Set(_.map(response.data.labels, (l) => l.name));

      const hasLabels = _.every(labels, (l) => labelSet.has(l));
      const hasState = response.data.state === state;
      return hasLabels && hasState;
    } catch (e) {
      logger.error(`[REPO]${name} [PR ID]${githubPullRequestId}: ${e}`);
      return true;
    }
  }

  cleanupClosedPRQueue = this.queueManager.registerQueue(QUEUE_NAMES.CLEANUP, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  // eslint-disable-next-line no-unused-vars
  processCleanupClosedPRs = async (_job) => {
    try {
      await this.db.services.BuildService.cleanupBuilds();
    } catch (error) {
      logger.error(`Error processing cleanup closed PRs:`, error);
    }
  };

  /**
   *
   * @param pullRequest
   * @returns
   */
  async updatePullRequestBranchName(pullRequest: PullRequest): Promise<string> {
    let branchName: string;

    if (pullRequest != null) {
      await pullRequest.$fetchGraph('repository');

      const response = await github
        .getPullRequestByRepositoryFullName(pullRequest.repository.fullName, pullRequest.pullRequestNumber)
        .catch((error) => {
          logger.error(`${error}`);
          return null;
        });

      if (response?.data?.head?.ref != null) {
        branchName = response.data.head.ref;
        await pullRequest.$query().patch({
          branchName,
        });
      }
    }

    return branchName;
  }
}
