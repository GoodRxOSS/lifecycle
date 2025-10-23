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

export class GetFileTool extends BaseTool {
  static readonly Name = 'get_file';

  constructor(private githubClient: GitHubClient) {
    super(
      'Read any file from the repository. Returns content with line numbers in format "  123: line content". Use this to read configuration files (lifecycle.yaml, lifecycle.yml), Dockerfiles, Helm values, source code, or any other file.',
      {
        type: 'object',
        properties: {
          repository_owner: { type: 'string', description: 'Repository owner' },
          repository_name: { type: 'string', description: 'Repository name' },
          branch: { type: 'string', description: 'Branch name' },
          file_path: {
            type: 'string',
            description:
              'Path to any file in the repository (e.g., lifecycle.yaml, lifecycle.yml, sysops/dockerfiles/app.dockerfile, src/index.ts)',
          },
        },
        required: ['repository_owner', 'repository_name', 'branch', 'file_path'],
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
      const filePath = args.file_path as string;

      const octokit = await this.githubClient.getOctokit('ai-agent-get-file');

      const response = await octokit.request(`GET /repos/${owner}/${repo}/contents/${filePath}`, {
        ref: branch,
      });

      if (response.data && 'content' in response.data && response.data.type === 'file') {
        const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
        const lines = content.split('\n');
        const numberedContent = lines
          .map((line, index) => {
            const lineNum = (index + 1).toString().padStart(5, ' ');
            return `${lineNum}: ${line}`;
          })
          .join('\n');

        const result = {
          success: true,
          path: filePath,
          content: numberedContent,
          rawContent: content,
          sha: response.data.sha,
        };

        return this.createSuccessResult(JSON.stringify(result));
      }

      return this.createErrorResult(`${filePath} is not a file or does not exist`, 'FILE_NOT_FOUND');
    } catch (error: any) {
      return this.createErrorResult(error.message || `Failed to fetch ${args.file_path}`, 'EXECUTION_ERROR');
    }
  }
}
