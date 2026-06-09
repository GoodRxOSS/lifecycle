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

export class ListDirectoryTool extends BaseTool {
  static readonly Name = 'list_directory';

  constructor(private githubClient: GitHubClient) {
    super(
      'List files and directories in a path of one of THIS environment\'s repositories. PROACTIVE USE: When you see "no such file or directory" errors in build/deploy logs, IMMEDIATELY call this to discover the correct filename. Example: If logs show "sysops/dockerfiles/app.dockerfile: no such file", call list_directory("sysops/dockerfiles") to find the actual file. Default repository_owner/repository_name to this build\'s primary repository; repositories outside this environment are rejected.',
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
          directory_path: {
            type: 'string',
            description:
              'Any directory path to list (e.g., sysops/dockerfiles, src, helm/charts). Use empty string "" for root directory.',
          },
        },
        required: ['directory_path'],
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
      const directoryPath = args.directory_path as string;

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

      const octokitWithAuth = await this.githubClient.getOctokitWithAuth('agent-runtime-list-directory', {
        requireUserAuth: false,
        toolCallId: context?.toolCallId,
      });
      const octokit = octokitWithAuth.octokit;
      auth = octokitWithAuth.auth;

      const response = await octokit.request(`GET /repos/${owner}/${repo}/contents/${directoryPath}`, {
        ref: branch,
      });

      if (!Array.isArray(response.data)) {
        return { ...this.createErrorResult(`Path "${directoryPath}" is not a directory`, 'NOT_A_DIRECTORY'), auth };
      }

      const items = response.data.map((item: any) => ({
        name: item.name,
        type: item.type,
        path: item.path,
      }));

      const filteredItems = items.filter(
        (item: { name: string; type: string; path: string }) => !this.githubClient.isFileExcluded(item.path)
      );

      const result = {
        success: true,
        path: directoryPath || '/',
        items: filteredItems,
        count: filteredItems.length,
      };

      const displayContent = `Directory: ${directoryPath || '/'} (${filteredItems.length} items)`;
      return { ...this.createSuccessResult(JSON.stringify(result), displayContent), auth };
    } catch (error: any) {
      return {
        ...this.createErrorResult(
          error.message || `Failed to list directory ${args.directory_path}`,
          'EXECUTION_ERROR'
        ),
        auth,
      };
    }
  }
}
