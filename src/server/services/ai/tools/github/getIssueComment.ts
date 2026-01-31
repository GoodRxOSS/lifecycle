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

import { BaseTool } from '../baseTool';
import { ToolResult, ToolSafetyLevel } from '../../types/tool';
import { GitHubClient } from '../shared/githubClient';

export class GetIssueCommentTool extends BaseTool {
  static readonly Name = 'get_issue_comment';

  constructor(private githubClient: GitHubClient) {
    super(
      'Get a specific comment from a GitHub issue or pull request by comment ID. Use this to read the Lifecycle PR comment that shows which services are ENABLED (checked) vs DISABLED (unchecked).',
      {
        type: 'object',
        properties: {
          repository_owner: { type: 'string', description: 'Repository owner' },
          repository_name: { type: 'string', description: 'Repository name' },
          comment_id: { type: 'number', description: 'Comment ID from pull_requests.commentId or issues' },
        },
        required: ['repository_owner', 'repository_name', 'comment_id'],
      },
      ToolSafetyLevel.SAFE,
      'github'
    );
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED', false);
    }

    try {
      const owner = args.repository_owner as string;
      const repo = args.repository_name as string;
      const commentId = args.comment_id as number;

      const octokit = await this.githubClient.getOctokit('ai-agent-get-issue-comment');

      const response = await octokit.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner,
        repo,
        comment_id: commentId,
      });

      const result = {
        success: true,
        body: response.data.body,
        createdAt: response.data.created_at,
        updatedAt: response.data.updated_at,
        author: response.data.user?.login,
      };

      const displayContent = `Comment by ${result.author || 'unknown'} at ${result.createdAt}`;
      return this.createSuccessResult(JSON.stringify(result), displayContent);
    } catch (error: any) {
      return this.createErrorResult(error.message || `Failed to fetch comment ${args.comment_id}`, 'EXECUTION_ERROR');
    }
  }
}
