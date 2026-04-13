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

import { GithubService } from 'server/models/yaml';
import Service from 'server/services/_service';

export type PullRequestLabel = Partial<{
  id: number;
  name: string;
  color: string;
}>;
export type BranchData = {
  action: string;
  branch: string;
  id: number;
  githubPullRequestId: number;
  installationId: number;
  labels: PullRequestLabel[];
  login: string;
  name: string;
  number: number;
  ownerId: number;
  url: string;
  sha: string;
  status: string;
  title: string;
};

export type GithubPullRequestData = {
  action: string;
  installation: {
    id: number;
  };
  number: number;
  pull_request: {
    head: {
      ref: string;
      sha: string;
    };
    id: number;
    labels: PullRequestLabel[];
    state: string;
    title: string;
    user: {
      login: string;
    };
  };
  repository: {
    full_name: string;
    id: number;
    owner: {
      id: number;
      html_url: string;
    };
  };
  sender: {
    login: string;
  };
};

export type GithubIssueCommentData = {
  comment: {
    id: number;
    body: string;
  };
  sender: {
    login: string;
  };
};

export type GithubInstallationData = {
  action: string;
  installation: {
    account: {
      login: string;
    };
  };
  repositories: Array<
    Partial<{
      id: number;
      name: string;
      full_name: string;
    }>
  >;
};

// findOrCreateDefaultService take in a Repository Model but only needs an ID
export type RepositoryWithID = {
  githubRepositoryId: number;
};

export interface IGithubService extends GithubService, Service {}
