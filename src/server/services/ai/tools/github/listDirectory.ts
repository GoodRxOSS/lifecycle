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

export class ListDirectoryTool extends BaseTool {
  static readonly Name = 'list_directory';

  constructor(private githubClient: GitHubClient) {
    super(
      'List files and directories in ANY repository path. PROACTIVE USE: When you see "no such file or directory" errors in build/deploy logs, IMMEDIATELY call this to discover the correct filename. Example: If logs show "sysops/dockerfiles/app.dockerfile: no such file", call list_directory("sysops/dockerfiles") to find the actual file.',
      {
        type: 'object',
        properties: {
          repository_owner: { type: 'string', description: 'Repository owner' },
          repository_name: { type: 'string', description: 'Repository name' },
          branch: { type: 'string', description: 'Branch name' },
          directory_path: {
            type: 'string',
            description:
              'Any directory path to list (e.g., sysops/dockerfiles, src, helm/charts). Use empty string "" for root directory.',
          },
        },
        required: ['repository_owner', 'repository_name', 'branch', 'directory_path'],
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
      const branch = args.branch as string;
      const directoryPath = args.directory_path as string;

      const octokit = await this.githubClient.getOctokit('ai-agent-list-directory');

      const response = await octokit.request(`GET /repos/${owner}/${repo}/contents/${directoryPath}`, {
        ref: branch,
      });

      if (!Array.isArray(response.data)) {
        return this.createErrorResult(`Path "${directoryPath}" is not a directory`, 'NOT_A_DIRECTORY');
      }

      const items = response.data.map((item: any) => ({
        name: item.name,
        type: item.type,
        path: item.path,
      }));

      const result = {
        success: true,
        path: directoryPath || '/',
        items,
        count: items.length,
      };

      return this.createSuccessResult(JSON.stringify(result));
    } catch (error: any) {
      return this.createErrorResult(
        error.message || `Failed to list directory ${args.directory_path}`,
        'EXECUTION_ERROR'
      );
    }
  }
}
