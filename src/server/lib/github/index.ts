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
import rootLogger from 'server/lib/logger';
import { createOctokitClient } from 'server/lib/github/client';
import { cacheRequest } from 'server/lib/github/cacheRequest';
import { LIFECYCLE_FILE_NAME_REGEX } from 'server/lib/github/constants';
import { RepoOptions, PullRequestCommentOptions, CheckIfCommentExistsOptions } from 'server/lib/github/types';
import { getRefForBranchName } from 'server/lib/github/utils';
import { Deploy } from 'server/models';
import { LifecycleYamlConfigOptions } from 'server/models/yaml/types';

export const initialLogger = rootLogger.child({
  filename: 'lib/github/index.ts',
});

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
    const msg = 'Unable to create or update pull request comment';
    initialLogger.child({ error }).error(`[GITHUB ${fullName}/${pullRequestNumber}] ${msg} - original error: ${error}`);
    throw new Error(error?.message || msg);
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
    initialLogger
      .child({ error })
      .error(
        `[GITHUB ${fullName}/${pullRequestNumber}] Unable to update pull request with '${labels.toString()}': ${error}`
      );
    throw error;
  }
}

export async function getPullRequest(
  owner: string,
  name: string,
  pullRequestNumber: number,
  _installationId: number,
  logger = initialLogger
) {
  try {
    return await cacheRequest(`GET /repos/${owner}/${name}/pulls/${pullRequestNumber}`);
  } catch (error) {
    const msg = 'Unable to retrieve pull request';
    logger.error(`[GITHUB ${owner}/${name}/pulls/${pullRequestNumber}] ${msg}: ${error}`);
    throw new Error(error?.message || msg);
  }
}

export async function getPullRequestByRepositoryFullName(
  fullName: string,
  pullRequestNumber: number,
  logger = initialLogger
) {
  try {
    return await cacheRequest(`GET /repos/${fullName}/pulls/${pullRequestNumber}`);
  } catch (error) {
    const msg = 'Unable to retrieve pull request';
    logger.error(`[GITHUB ${fullName}/pulls/${pullRequestNumber}] ${msg}: ${error}`);
    throw new Error(error?.message || msg);
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
    initialLogger.error(`[GITHUB ${fullName}/${pullRequestNumber}] Unable to fetch labels: ${error}`);
    throw error;
  }
}

export async function createDeploy({ owner, name, branch, installationId, logger = initialLogger }: RepoOptions) {
  try {
    const octokit = await createOctokitClient({ installationId, caller: 'createDeploy' });
    return await octokit.request(`POST /repos/${owner}/${name}/builds`, {
      data: {
        ref: branch,
        environment: 'staging',
      },
    });
  } catch (error) {
    const msg = 'Unable to create deploy';
    logger.child({ error }).error(`[GITHUB ${owner}/${name}/${branch}] ${msg}`);
    throw new Error(error?.message || msg);
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

export async function getSHAForBranch(
  branchName: string,
  owner: string,
  name: string,
  logger = initialLogger
): Promise<string> {
  try {
    const ref = await getRefForBranchName(owner, name, branchName);
    return ref?.data?.object?.sha;
  } catch (error) {
    const msg = 'Unable to retrieve SHA from branch';
    logger.child({ error }).warn(`[GITHUB ${owner}/${name}/${branchName}] ${msg}`);
    throw new Error(error?.message || msg);
  }
}

export async function getYamlFileContent({ fullName, branch = '', sha = '', isJSON = false, logger = initialLogger }) {
  const text = `[${fullName}:${branch}][getYamlFileContent]`;
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
    const msg = 'warning: no lifecycle yaml found or parsed';
    logger.child({ error }).warn(`${text}${msg}`);
    throw new ConfigFileNotFound(error?.message || msg);
  }
}

export async function getYamlFileContentFromPullRequest(
  fullName: string,
  pullRequestNumber: number,
  logger = initialLogger
) {
  const [owner, repo] = fullName.split('/');
  try {
    const pullRequestResp = await getPullRequestByRepositoryFullName(fullName, pullRequestNumber);
    const branch = pullRequestResp?.data?.head?.ref;
    if (!branch) throw new Error('Unable to get branch from pull request');
    const config = await getYamlFileContent({ fullName, branch });
    if (!config) throw new Error('Unable to get config from pull request');
    return config;
  } catch (error) {
    const msg = 'Unable to retrieve YAML file content from pull request';
    logger.child({ error }).warn(`[GITHUB ${owner}/${repo}/pulls/${pullRequestNumber}] ${msg}`);
    throw new ConfigFileNotFound(error?.message || msg);
  }
}

export async function getYamlFileContentFromBranch(
  fullName: string,
  branchName: string,
  logger = initialLogger
): Promise<string | LifecycleYamlConfigOptions> {
  const [owner, repo] = fullName.split('/');
  try {
    const config = await getYamlFileContent({ fullName, branch: branchName });
    return config;
  } catch (error) {
    const msg = 'Unable to retrieve YAML file content from branch';
    logger.child({ error }).warn(`[GITHUB ${owner}/${repo}/${branchName}] ${msg}`);
    throw new ConfigFileNotFound(error?.message || msg);
  }
}

export async function checkIfCommentExists({
  fullName,
  pullRequestNumber,
  commentIdentifier,
  logger = initialLogger,
}: CheckIfCommentExistsOptions) {
  try {
    const resp = await cacheRequest(`GET /repos/${fullName}/issues/${pullRequestNumber}/comments`);
    const comments = resp?.data;
    const isExistingComment = comments.find(({ body }) => body?.includes(commentIdentifier)) || false;
    return isExistingComment;
  } catch (error) {
    const msg = 'Unable check for coments';
    logger.child({ error }).error(`[GITHUB ${fullName}][checkIfCommentExists] ${msg}`);
    return false;
  }
}

export class ConfigFileNotFound extends LifecycleError {
  constructor(msg: string, uuid: string = null, service: string = null) {
    super(uuid, service, msg);
  }
}
