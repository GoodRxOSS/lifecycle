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

import {
  GithubPullRequestData,
  GithubIssueCommentData,
  GithubInstallationData,
  BranchData,
} from 'server/services/types/github';

export const GITHUB_REPOSITORY_DATA = {
  ownerId: 1296269,
  githubRepositoryId: 1296269,
  githubInstallationId: 123,
  fullName: 'octocat/hello-world',
  htmlUrl: 'https://github.com/octocat',
  defaultEnvId: 1,
};

export const GITHUB_PULL_REQUEST_DATA: GithubPullRequestData = {
  action: 'opened',
  installation: { id: 123 },
  number: 42,
  pull_request: {
    head: { ref: 'feature/awesome-feature', sha: 'abc123' },
    labels: [{ name: 'enhancement' }],
    state: 'open',
    title: 'Add awesome feature',
    user: { login: 'octocat' },
    id: 123,
  },
  repository: {
    full_name: 'octocat/hello-world',
    id: 1296269,
    owner: { id: 1, html_url: 'https://github.com/octocat' },
  },
  sender: {
    login: 'octocat',
  },
};

export const GITHUB_ISSUE_COMMENT_DATA: GithubIssueCommentData = {
  comment: {
    id: 123,
    body: 'This is a comment',
  },
  sender: {
    login: 'octocat',
  },
};

export const GITHUB_INSTALLATION_DATA: GithubInstallationData = {
  action: 'created',
  installation: {
    account: {
      login: 'octocat',
    },
  },
  repositories: [{ name: 'octocat/hello-world' }],
};

export const BRANCH_DATA: BranchData = {
  id: GITHUB_PULL_REQUEST_DATA.pull_request.id,
  githubPullRequestId: GITHUB_PULL_REQUEST_DATA.pull_request.id,
  installationId: GITHUB_PULL_REQUEST_DATA.installation.id,
  name: GITHUB_PULL_REQUEST_DATA.repository.full_name,
  ownerId: GITHUB_PULL_REQUEST_DATA.repository.owner.id,
  url: GITHUB_PULL_REQUEST_DATA.repository.owner.html_url,
  labels: GITHUB_PULL_REQUEST_DATA.pull_request.labels,
  login: GITHUB_PULL_REQUEST_DATA.pull_request.user.login,
  number: GITHUB_PULL_REQUEST_DATA.number,
  sha: GITHUB_PULL_REQUEST_DATA.pull_request.head.sha,
  status: GITHUB_PULL_REQUEST_DATA.pull_request.state,
  title: GITHUB_PULL_REQUEST_DATA.pull_request.title,
  action: GITHUB_PULL_REQUEST_DATA.action,
  branch: GITHUB_PULL_REQUEST_DATA.pull_request.head.ref,
};
