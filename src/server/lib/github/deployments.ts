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

import { Deploy } from 'server/models';
import { cacheRequest } from 'server/lib/github/cacheRequest';
import { getPullRequest } from 'server/lib/github/index';
import { DeployStatus } from 'shared/constants';
import { getLogger } from 'server/lib/logger';

const githubDeploymentStatuses = {
  deployed: 'success',
  ready: 'success',
  error: 'failure',
  build_failed: 'failure',
  deploy_failed: 'failure',
  config_error: 'error',
  torn_down: 'inactive',
};

function lifecycleToGithubStatus(status: string): string {
  const inProgressStatuses = [
    DeployStatus.CLONING,
    DeployStatus.QUEUED,
    DeployStatus.BUILDING,
    DeployStatus.BUILT,
    DeployStatus.DEPLOYING,
    DeployStatus.WAITING,
    DeployStatus.PENDING,
  ];

  if (inProgressStatuses.includes(status as DeployStatus)) {
    return 'in_progress';
  }

  return githubDeploymentStatuses[status] || 'error';
}

export async function createOrUpdateGithubDeployment(deploy: Deploy) {
  getLogger().debug('GitHub deployment: action=create_or_update');
  try {
    await deploy.$fetchGraph('build.pullRequest.repository');
    const githubDeploymentId = deploy?.githubDeploymentId;
    const build = deploy?.build;
    const pullRequest = build?.pullRequest;
    const repository = pullRequest?.repository;
    const fullName = repository?.fullName;
    const [owner, name] = fullName.split('/');
    const pullRequestNumber = pullRequest?.pullRequestNumber;
    const hasDeployment = githubDeploymentId !== null;
    const pullRequestResp = await getPullRequest(owner, name, pullRequestNumber, null);
    const lastCommit = pullRequestResp?.data?.head?.sha;
    if (hasDeployment) {
      const deploymentResp = await getDeployment(deploy);
      const deploymentSha = deploymentResp?.data?.sha;
      if (lastCommit !== deploymentSha) {
        await deleteGithubDeploymentAndEnvironment(deploy);
      } else {
        await updateDeploymentStatus(deploy, githubDeploymentId);
        return;
      }
    }
    const newDeployment = await createGithubDeployment(deploy, lastCommit);
    const newDeploymentId = newDeployment?.data?.id;
    if (newDeploymentId) {
      await updateDeploymentStatus(deploy, newDeploymentId);
    }
  } catch (error) {
    getLogger().error(`GitHub deployment failed: error=${error.message}`);
    throw error;
  }
}

export async function deleteGithubDeploymentAndEnvironment(deploy: Deploy) {
  if (deploy.githubDeploymentId !== null) {
    await deploy.$fetchGraph('build.pullRequest.repository');
    await markDeploymentInactive(deploy);
    await Promise.all([deleteGithubDeployment(deploy), deleteGithubEnvironment(deploy)]);
  }
}

async function markDeploymentInactive(deploy: Deploy) {
  const repository = deploy.build.pullRequest.repository;
  try {
    await cacheRequest(`POST /repos/${repository.fullName}/deployments/${deploy.githubDeploymentId}/statuses`, {
      data: {
        state: 'inactive',
        environment: deploy.uuid,
        description: 'Environment torn down',
      },
    });
    getLogger().debug(`GitHub deployment: marked inactive deploymentId=${deploy.githubDeploymentId}`);
  } catch (error) {
    getLogger().warn(
      `GitHub deployment: failed to mark inactive deploymentId=${deploy.githubDeploymentId} error=${error.message}`
    );
  }
}

export async function createGithubDeployment(deploy: Deploy, ref: string) {
  const environment = deploy.uuid;
  const pullRequest = deploy?.build?.pullRequest;
  const repository = pullRequest?.repository;
  const fullName = repository?.fullName;
  try {
    const resp = await cacheRequest(`POST /repos/${fullName}/deployments`, {
      data: {
        ref,
        environment,
        auto_merge: false,
        required_contexts: [],
        transient_environment: true,
        production_environment: false,
      },
    });
    const githubDeploymentId = resp?.data?.id;
    if (!githubDeploymentId) throw new Error('No deployment ID returned from github');
    await deploy.$query().patch({ githubDeploymentId });
    return resp;
  } catch (error) {
    getLogger().error(`GitHub deployment create failed: repo=${fullName} error=${error.message}`);
    throw error;
  }
}

export async function deleteGithubDeployment(deploy: Deploy) {
  getLogger().debug('GitHub deployment: action=delete');
  if (!deploy?.build) await deploy.$fetchGraph('build.pullRequest.repository');
  const resp = await cacheRequest(
    `DELETE /repos/${deploy.build.pullRequest.repository.fullName}/deployments/${deploy.githubDeploymentId}`
  );

  await deploy.$query().patch({ githubDeploymentId: null });

  return resp;
}

export async function deleteGithubEnvironment(deploy: Deploy) {
  if (!deploy?.build) await deploy.$fetchGraph('build.pullRequest.repository');
  const repository = deploy.build.pullRequest.repository;
  const environmentName = deploy.uuid;
  try {
    await cacheRequest(`DELETE /repos/${repository.fullName}/environments/${environmentName}`);
    getLogger().debug(`GitHub environment: deleted environment=${environmentName}`);
  } catch (e) {
    if (e.status === 404) {
      getLogger().debug(`GitHub environment: not found environment=${environmentName}`);
    } else if (e.status === 403) {
      getLogger().warn(
        `GitHub environment: no permission to delete environment=${environmentName} (check GitHub App permissions)`
      );
    } else {
      getLogger().warn(
        `GitHub environment: delete failed environment=${environmentName} status=${e.status} error=${e.message}`
      );
    }
  }
}

export async function updateDeploymentStatus(deploy: Deploy, deploymentId: number) {
  getLogger().debug(`GitHub deployment status: action=update deploymentId=${deploymentId}`);
  const repository = deploy.build.pullRequest.repository;
  let buildStatus = determineStatus(deploy);
  const resp = await cacheRequest(`POST /repos/${repository.fullName}/deployments/${deploymentId}/statuses`, {
    data: {
      state: buildStatus,
      environment: deploy.uuid,
      description: deploy.build.statusMessage,
      ...(buildStatus === githubDeploymentStatuses.deployed && { environment_url: `https://${deploy.publicUrl}` }),
    },
  });
  return resp;
}

export async function getDeployment(deploy: Deploy) {
  if (!deploy?.build) await deploy.$fetchGraph('build.pullRequest.repository');

  const githubDeploymentId = deploy?.githubDeploymentId;
  const pullRequest = deploy.build.pullRequest;
  const repository = pullRequest.repository;

  const [owner, repo] = repository.fullName.split('/');
  const resp = await cacheRequest(`GET /repos/${repository.fullName}/deployments/${githubDeploymentId}`, {
    data: {
      owner,
      repo,
      deployment_id: githubDeploymentId,
    },
  });
  return resp;
}

function determineStatus(deploy: Deploy): string {
  let buildStatus: string;

  if (deploy.build.status === 'error') {
    buildStatus = 'error';
  } else if (deploy.build.status === 'deployed') {
    buildStatus = 'success';
  } else {
    buildStatus = lifecycleToGithubStatus(deploy.status);
  }
  return buildStatus;
}
