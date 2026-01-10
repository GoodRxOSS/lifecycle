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
import { getLogger } from 'server/lib/logger/index';

const githubDeploymentStatuses = {
  deployed: 'success',
  error: 'failure',
  config_error: 'error',
};

function lifecycleToGithubStatus(status: string) {
  if (
    [DeployStatus.CLONING, DeployStatus.QUEUED, DeployStatus.BUILDING, DeployStatus.BUILT].includes(
      status as DeployStatus
    )
  ) {
    return 'in_progress';
  }

  return githubDeploymentStatuses[status];
}

export async function createOrUpdateGithubDeployment(deploy: Deploy) {
  getLogger().debug('Creating or updating github deployment');
  try {
    getLogger().info('Deploy status update');
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
    await createGithubDeployment(deploy, lastCommit);
    if (build?.status === 'deployed') {
      await updateDeploymentStatus(deploy, githubDeploymentId);
    }
  } catch (error) {
    getLogger({ error }).error('Error creating or updating github deployment');
    throw error;
  }
}

export async function deleteGithubDeploymentAndEnvironment(deploy: Deploy) {
  if (deploy.githubDeploymentId !== null) {
    await deploy.$fetchGraph('build.pullRequest.repository');
    await Promise.all([deleteGithubDeployment(deploy), deleteGithubEnvironment(deploy)]);
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
        transient_environment: false,
        production_environment: false,
      },
    });
    const githubDeploymentId = resp?.data?.id;
    if (!githubDeploymentId) throw new Error('No deployment ID returned from github');
    await deploy.$query().patch({ githubDeploymentId });
    return resp;
  } catch (error) {
    getLogger({
      error,
      repo: fullName,
    }).error('Error creating github deployment');
    throw error;
  }
}

export async function deleteGithubDeployment(deploy: Deploy) {
  getLogger().debug('Deleting github deployment');
  if (!deploy?.build) await deploy.$fetchGraph('build.pullRequest.repository');
  const resp = await cacheRequest(
    `DELETE /repos/${deploy.build.pullRequest.repository.fullName}/deployments/${deploy.githubDeploymentId}`
  );

  await deploy.$query().patch({ githubDeploymentId: null });

  return resp;
}

export async function deleteGithubEnvironment(deploy: Deploy) {
  getLogger().debug('Deleting github environment');
  if (!deploy?.build) await deploy.$fetchGraph('build.pullRequest.repository');
  const repository = deploy.build.pullRequest.repository;
  try {
    await cacheRequest(`DELETE /repos/${repository.fullName}/environments/${deploy.uuid}`);
  } catch (e) {
    if (e.status !== 404) {
      throw e;
    }
  }
}

export async function updateDeploymentStatus(deploy: Deploy, deploymentId: number) {
  getLogger().debug('Updating github deployment status');
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
