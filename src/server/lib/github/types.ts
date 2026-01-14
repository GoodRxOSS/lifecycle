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

import Redis from 'ioredis';
import { AuthInterface } from '@octokit/auth-app/dist-types/types';
import { Logger } from 'pino';

export interface RepoOptions {
  ownerId?: number;
  repositoryId: number;
  branch: string;
  installationId: number;
  owner?: string;
  name?: string;
  githubPullRequestId?: number;
}

export type DeployState = 'error' | 'failure' | 'inactive' | 'in_progress' | 'queued' | 'pending' | 'success';

export type GetAppTokenOptions = {
  installationId: number;
  app: AuthInterface;
  logger?: Logger;
};

export type CreateOctokitClientOptions = {
  accessToken?: string;
  installationId?: number;
  caller?: string;
  cache?: typeof Redis;
};

export type ConstructOctokitClientOptions = {
  token: string | undefined;
};

export type GithubClientOptions = {
  client_id: string;
  client_secret: string;
  code: string;
};

export type GetAccessTokenOptions = {
  endpoint: string;
  githubClientOptions: GithubClientOptions;
  headers: Record<string, string>;
};

export interface CloneOptions {
  repositoryId: number;
  installationId: number;
  branch: string;
}

export type GetRepoDataOpions = {
  installationId: number;
  repositoryId: number;
};

export interface PullRequestCommentOptions {
  installationId: number;
  pullRequestNumber: number;
  fullName: string;
  message: string;
  commentId?: number;
  etag?: string;
  isTesting?: boolean;
  logger?: Logger;
}

export interface GetLifecycleConfigOptions {
  repo: string;
  ref: string;
  owner: string;
  installationId: number;
}

export interface CacheRequestDataYHeaders {
  'if-none-match'?: string;
  'if-modified-since'?: string;
}

export interface CacheRequestData {
  headers?: CacheRequestDataYHeaders;
  owner?: string;
  branch?: string;
  repo?: string;
  pull_number?: number;
  ref?: string;
}

export interface CacheResponseDataHeaders {
  etag?: string;
  'last-modified'?: string;
}

export interface CacheResponseData {
  data?: Record<string, unknown>;
  headers: CacheResponseDataHeaders;
}

export interface CheckIfCommentExistsOptions {
  fullName: string;
  pullRequestNumber: number;
  commentIdentifier: string;
}

export interface DetermineIfQueueIsNeededOptions {
  data;
}
