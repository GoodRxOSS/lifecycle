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
import { ToolExecutionContext, ToolResult } from '../types';
import { GitHubClient } from '../shared/githubClient';
import { OutputLimiter } from '../outputLimiter';

export class GetFileTool extends BaseTool {
  static readonly Name = 'get_file';

  constructor(private githubClient: GitHubClient) {
    super(
      "Read any file from one of THIS environment's repositories. Returns raw file content and total line count. Use this to read configuration files (lifecycle.yaml, lifecycle.yml), Dockerfiles, Helm values, source code, or any other file. Default repository_owner/repository_name to this build's primary repository; repositories outside this environment are rejected.",
      {
        type: 'object',
        properties: {
          repository_owner: {
            type: 'string',
            description: "Repository owner. Defaults to this build's primary repo owner.",
          },
          repository_name: {
            type: 'string',
            description: "Repository name. Defaults to this build's primary repo name.",
          },
          branch: { type: 'string', description: "Branch name. Defaults to this build's PR branch." },
          file_path: {
            type: 'string',
            description:
              'Path to any file in the repository (e.g., lifecycle.yaml, lifecycle.yml, sysops/dockerfiles/app.dockerfile, src/index.ts)',
          },
        },
        required: ['file_path'],
      }
    );
  }

  async execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED');
    }

    let auth: ToolResult['auth'];
    try {
      const defaultRepo = this.githubClient.getDefaultRepo();
      const owner = (args.repository_owner as string) || defaultRepo?.owner;
      const repo = (args.repository_name as string) || defaultRepo?.repo;
      const branch = (args.branch as string) || this.githubClient.getAllowedBranch();
      const filePath = args.file_path as string;

      if (!owner || !repo || !branch) {
        return this.createErrorResult(
          'repository_owner, repository_name, and branch are required when no default repository is configured.',
          'MISSING_REPO'
        );
      }

      // SECURITY: lock to the build's repositories; reject out-of-scope repos.
      if (!this.githubClient.isRepoAllowed(owner, repo)) {
        return this.createErrorResult(
          `Repository "${owner}/${repo}" is outside this environment's repositories and cannot be accessed.`,
          'FILE_ACCESS_DENIED'
        );
      }

      if (!this.githubClient.isFilePathAllowed(filePath, 'read')) {
        return this.createErrorResult(
          `File "${filePath}" is restricted by access control policy and cannot be read.`,
          'FILE_ACCESS_DENIED'
        );
      }

      const octokitWithAuth = await this.githubClient.getOctokitWithAuth('agent-runtime-get-file', {
        requireUserAuth: false,
        toolCallId: context?.toolCallId,
      });
      const octokit = octokitWithAuth.octokit;
      auth = octokitWithAuth.auth;

      const response = await octokit.request(`GET /repos/${owner}/${repo}/contents/${filePath}`, {
        ref: branch,
      });

      if (response.data && 'content' in response.data && response.data.type === 'file') {
        const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
        const totalLines = content.split('\n').length;

        const truncatedContent = OutputLimiter.truncate(content, 25000);
        const truncationNote = truncatedContent.length < content.length ? ', truncated' : '';
        const agentContent = `File ${filePath} (${totalLines} lines, sha ${response.data.sha}${truncationNote}):\n\`\`\`\n${truncatedContent}\n\`\`\``;

        const displayContent = `File: ${filePath} (${totalLines} lines)`;
        return { ...this.createSuccessResult(agentContent, displayContent), auth };
      }

      return { ...this.createErrorResult(`${filePath} is not a file or does not exist`, 'FILE_NOT_FOUND'), auth };
    } catch (error: any) {
      return {
        ...this.createErrorResult(error.message || `Failed to fetch ${args.file_path}`, 'EXECUTION_ERROR'),
        auth,
      };
    }
  }
}
