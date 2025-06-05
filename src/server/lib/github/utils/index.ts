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

import { Octokit } from '@octokit/core';
import rootLogger from 'server/lib/logger';
import { cacheRequest } from 'server/lib/github/cacheRequest';

import { ConstructOctokitClientOptions, GetAppTokenOptions } from 'server/lib/github/types';

const initialLogger = rootLogger.child({
  filename: 'lib/github/utils.ts',
});

export const getAppToken = async ({ installationId, app, logger = initialLogger }: GetAppTokenOptions) => {
  try {
    const resp = await app({ type: 'installation', installationId });
    return resp?.token;
  } catch (error) {
    const msg = 'Unable to get App Token';
    logger.child({ error }).error(`[GITHUB createOctokitClient] Unable to create a new client`);
    throw new Error(error?.message || msg);
  }
};

export const constructOctokitClient = ({ token }: ConstructOctokitClientOptions) => {
  return new Octokit({
    auth: `token ${token}`,
    mediaType: {
      previews: ['machine-man'],
      format: 'json',
    },
  });
};

export async function getRefForBranchName(owner: string, name: string, branchName: string, logger = initialLogger) {
  try {
    return await cacheRequest(`GET /repos/${owner}/${name}/git/ref/heads/${branchName}`);
  } catch (error) {
    const msg = 'Unable to get ref for Branch Name';
    logger.child({ error }).error(`[GITHUB ${owner}/${name}:${branchName}][getRefForBranchName] ${msg}`);
    throw new Error(error?.message || msg);
  }
}

export const constructClientRequestData = (resp, req, caller) => {
  const [type, path] = req.split(' ');
  const headers = resp?.headers;
  const etag = headers?.etag;
  const lastModified = headers?.['last-modified'];
  const limit = headers?.['x-ratelimit-limit'];
  const used = headers?.['x-ratelimit-used'];
  const reset = headers?.['x-ratelimit-reset'];
  return {
    caller,
    path,
    type,
    req,
    cache: {
      etag,
      lastModified,
    },
    rateLimit: {
      limit,
      used,
      reset,
    },
  };
};
