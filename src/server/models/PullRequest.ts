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

import Model from './_Model';
import Repository from './Repository';
import { Build } from '.';

export default class PullRequest extends Model {
  /**
   * The PR title in github
   */
  title: string;
  /**
   * PR status
   */
  status: string;
  /**
   * This is the actually identifier for the pull request in github (I believe this is a unique ID).
   */
  githubPullRequestId: number;
  repository: Repository;

  /**
   * Which build we're tracking for this PR
   */
  build: Build;

  /**
   * Whether to deploy this build on a PRs being updated
   */
  deployOnUpdate: boolean;
  /**
   * This is the actual "number" of a PR, which is not its identifier behind the scenes in Github.
   * This is what you see in the URL
   */
  pullRequestNumber: number;
  fullName: string;
  /**
   * This is the comment ID we get from github when we post an activity message.
   * This allows us to go back and update the comment, rather than always issuing a new one.
   */
  commentId: number;
  consoleId: number;
  statusCommentId: number;

  /**
   * An etag denoating the most recent comment etag, which helps us bypass rate limiting inside of
   * github
   */
  etag: string;

  /**
   * The login of the github user that created this pull request
   */
  githubLogin: string;

  branchName: string;
  labels: string[];
  latestCommit: string;

  static tableName = 'pull_requests';
  static timestamps = true;

  static relationMappings = {
    repository: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Repository,
      join: {
        from: 'pull_requests.repositoryId',
        to: 'repositories.id',
      },
    },
    build: {
      relation: Model.HasOneRelation,
      modelClass: () => Build,
      join: {
        from: 'pull_requests.id',
        to: 'builds.pullRequestId',
      },
    },
  };
}
