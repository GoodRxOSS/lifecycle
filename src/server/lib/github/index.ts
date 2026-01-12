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

import yaml from 'js-yaml';
import crypto from 'crypto';
import { NextApiRequest } from 'next';
import { GITHUB_WEBHOOK_SECRET } from 'shared/config';
import { LifecycleError } from 'server/lib/errors';
import { getLogger } from 'server/lib/logger/index';
import { createOctokitClient } from 'server/lib/github/client';
import { cacheRequest } from 'server/lib/github/cacheRequest';
import { LIFECYCLE_FILE_NAME_REGEX } from 'server/lib/github/constants';
import { RepoOptions, PullRequestCommentOptions, CheckIfCommentExistsOptions } from 'server/lib/github/types';
import { getRefForBranchName } from 'server/lib/github/utils';
import { Deploy } from 'server/models';
import { LifecycleYamlConfigOptions } from 'server/models/yaml/types';

export async function createOrUpdatePullRequestComment({
  installationId,
  pullRequestNumber,
  fullName,
  message,
  commentId,
  etag,
}: PullRequestCommentOptions) {
  try {
    const client = await createOctokitClient({ installationId, caller: 'createOrUpdatePullRequestComment' });
    let requestUrl;
    if (!commentId) requestUrl = `POST /repos/${fullName}/issues/${pullRequestNumber}/comments`;
    else requestUrl = `PATCH /repos/${fullName}/issues/comments/${commentId}`;
    return await client.request(requestUrl, {
      data: { body: message },
      headers: { etag },
    });
  } catch (error) {
    getLogger({
      error,
      repo: fullName,
      pr: pullRequestNumber,
    }).error('GitHub: comment update failed');
    throw new Error(error?.message || 'Unable to create or update pull request comment');
  }
}

export async function updatePullRequestLabels({
  installationId,
  pullRequestNumber,
  fullName,
  labels,
}: {
  installationId: number;
  pullRequestNumber: number;
  fullName: string;
  labels: string[];
}) {
  try {
    const client = await createOctokitClient({ installationId, caller: 'updatePullRequestLabels' });
    const requestUrl = `PUT /repos/${fullName}/issues/${pullRequestNumber}/labels`;
    return await client.request(requestUrl, {
      data: { labels },
    });
  } catch (error) {
    getLogger({
      error,
      repo: fullName,
      pr: pullRequestNumber,
      labels: labels.toString(),
    }).error('GitHub: labels update failed');
    throw error;
  }
}

export async function getPullRequest(owner: string, name: string, pullRequestNumber: number, _installationId: number) {
  try {
    return await cacheRequest(`GET /repos/${owner}/${name}/pulls/${pullRequestNumber}`);
  } catch (error) {
    getLogger({
      error,
      repo: `${owner}/${name}`,
      pr: pullRequestNumber,
    }).error('GitHub: pull request fetch failed');
    throw new Error(error?.message || 'Unable to retrieve pull request');
  }
}

export async function getPullRequestByRepositoryFullName(fullName: string, pullRequestNumber: number) {
  try {
    return await cacheRequest(`GET /repos/${fullName}/pulls/${pullRequestNumber}`);
  } catch (error) {
    getLogger({
      error,
      repo: fullName,
      pr: pullRequestNumber,
    }).error('GitHub: pull request fetch failed');
    throw new Error(error?.message || 'Unable to retrieve pull request');
  }
}

/**
 * Fetches current labels from GitHub API for a pull request
 * Used by TTL cleanup to avoid stale label data from database
 */
export async function getPullRequestLabels({
  installationId,
  pullRequestNumber,
  fullName,
}: {
  installationId: number;
  pullRequestNumber: number;
  fullName: string;
}): Promise<string[]> {
  try {
    const client = await createOctokitClient({
      installationId,
      caller: 'getPullRequestLabels',
    });
    const response = await client.request(`GET /repos/${fullName}/issues/${pullRequestNumber}`);
    return response.data.labels.map((label: any) => label.name);
  } catch (error) {
    getLogger({
      error,
      repo: fullName,
      pr: pullRequestNumber,
    }).error('GitHub: labels fetch failed');
    throw error;
  }
}

export async function createDeploy({ owner, name, branch, installationId }: RepoOptions) {
  try {
    const octokit = await createOctokitClient({ installationId, caller: 'createDeploy' });
    return await octokit.request(`POST /repos/${owner}/${name}/builds`, {
      data: {
        ref: branch,
        environment: 'staging',
      },
    });
  } catch (error) {
    getLogger({
      error,
      repo: `${owner}/${name}`,
      branch,
    }).error('GitHub: deploy create failed');
    throw new Error(error?.message || 'Unable to create deploy');
  }
}

export function verifyWebhookSignature(req: NextApiRequest) {
  const incomingSignature = req?.headers?.['x-hub-signature'] as string;

  if (!incomingSignature) return false;

  const verificationSignature = `sha1=${crypto
    .createHmac('sha1', GITHUB_WEBHOOK_SECRET)
    .update(JSON.stringify(req?.body))
    .digest('hex')}`;

  const isValid = crypto.timingSafeEqual(Buffer.from(incomingSignature), Buffer.from(verificationSignature));
  return isValid;
}

export async function getShaForDeploy(deploy: Deploy) {
  let fullName;
  let branchName;
  try {
    await deploy.$fetchGraph('deployable.repository');
    const repository = deploy?.deployable?.repository;
    if (!repository) throw new Error(`[DEPLOY ${deploy.uuid}] Repository not found to get sha`);
    fullName = repository?.fullName;
    branchName = deploy?.branchName;
    if (!fullName || !branchName) throw new Error(`[DEPLOY ${deploy.uuid}] Repository name or branch name not found`);
    const [owner, name] = fullName.split('/');
    return await getSHAForBranch(branchName, owner, name);
  } catch (error) {
    const msg = 'Unable to retrieve SHA for deploy';
    throw new Error(error?.message || msg);
  }
}

export async function getSHAForBranch(branchName: string, owner: string, name: string): Promise<string> {
  try {
    const ref = await getRefForBranchName(owner, name, branchName);
    return ref?.data?.object?.sha;
  } catch (error) {
    getLogger({
      error,
      repo: `${owner}/${name}`,
      branch: branchName,
    }).warn('GitHub: SHA fetch failed');
    throw new Error(error?.message || 'Unable to retrieve SHA from branch');
  }
}

export async function getYamlFileContent({ fullName, branch = '', sha = '', isJSON = false }) {
  try {
    const identifier = sha?.length > 0 ? sha : branch;
    const treeResp = await cacheRequest(`GET /repos/${fullName}/git/trees/${identifier}`);

    const files = treeResp?.data?.tree || [];
    if (!files) {
      throw new ConfigFileNotFound("Didn't find any files");
    }

    const configPath = files?.find(({ path }) => path.match(LIFECYCLE_FILE_NAME_REGEX)).path;
    if (!configPath) {
      throw new Error('Unable to find config file');
    }

    const contentResp = await cacheRequest(`GET /repos/${fullName}/contents/${configPath}?ref=${identifier}`);
    const content = contentResp?.data?.content;
    if (!content) {
      throw new Error('Unable to get config content from the config file');
    }

    const configData = content && Buffer.from(content, 'base64').toString('utf8');
    if (!configData) {
      throw new Error('Unable to get config data from the config file');
    }

    if (isJSON) {
      const json = yaml.load(configData, { json: true }) as LifecycleYamlConfigOptions;
      if (!json) throw new Error('Unable to parse the config data');
      return json;
    }

    return configData;
  } catch (error) {
    getLogger({ error, repo: fullName, branch }).warn('GitHub: yaml fetch failed');
    throw new ConfigFileNotFound('Config file not found');
  }
}

export async function getYamlFileContentFromPullRequest(fullName: string, pullRequestNumber: number) {
  try {
    const pullRequestResp = await getPullRequestByRepositoryFullName(fullName, pullRequestNumber);
    const branch = pullRequestResp?.data?.head?.ref;
    if (!branch) throw new Error('Unable to get branch from pull request');
    const config = await getYamlFileContent({ fullName, branch });
    if (!config) throw new Error('Unable to get config from pull request');
    return config;
  } catch (error) {
    getLogger({
      error,
      repo: fullName,
      pr: pullRequestNumber,
    }).warn('GitHub: yaml fetch failed');
    throw new ConfigFileNotFound('Config file not found');
  }
}

export async function getYamlFileContentFromBranch(
  fullName: string,
  branchName: string
): Promise<string | LifecycleYamlConfigOptions> {
  try {
    const config = await getYamlFileContent({ fullName, branch: branchName });
    return config;
  } catch (error) {
    getLogger({
      error,
      repo: fullName,
      branch: branchName,
    }).warn('GitHub: yaml fetch failed');
    throw new ConfigFileNotFound('Config file not found');
  }
}

export async function checkIfCommentExists({
  fullName,
  pullRequestNumber,
  commentIdentifier,
}: CheckIfCommentExistsOptions) {
  try {
    const resp = await cacheRequest(`GET /repos/${fullName}/issues/${pullRequestNumber}/comments`);
    const comments = resp?.data;
    const isExistingComment = comments.find(({ body }) => body?.includes(commentIdentifier)) || false;
    return isExistingComment;
  } catch (error) {
    getLogger({
      error,
      repo: fullName,
      pr: pullRequestNumber,
    }).error('GitHub: comments check failed');
    return false;
  }
}

export class ConfigFileNotFound extends LifecycleError {
  constructor(msg: string, uuid: string = null, service: string = null) {
    super(uuid, service, msg);
  }
}
