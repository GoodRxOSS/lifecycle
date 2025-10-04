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

export class UpdateFileTool extends BaseTool {
  static readonly Name = 'update_file';

  constructor(private githubClient: GitHubClient) {
    super(
      'Update or create any configuration file in the repository. Can modify lifecycle.yaml, lifecycle.yml, Dockerfiles, Helm charts, values files, and other configuration files. Use this when you need to fix configuration issues.',
      {
        type: 'object',
        properties: {
          repository_owner: { type: 'string', description: 'Repository owner' },
          repository_name: { type: 'string', description: 'Repository name' },
          branch: { type: 'string', description: 'Branch name to commit to' },
          file_path: {
            type: 'string',
            description:
              'Path to file to update (e.g., lifecycle.yaml, lifecycle.yml, sysops/dockerfiles/app.dockerfile, helm/values.yaml)',
          },
          new_content: { type: 'string', description: 'The new file content' },
          commit_message: { type: 'string', description: 'Commit message describing the change' },
        },
        required: ['repository_owner', 'repository_name', 'branch', 'file_path', 'new_content', 'commit_message'],
      },
      ToolSafetyLevel.DANGEROUS,
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
      const newContent = args.new_content as string;
      const commitMessage = args.commit_message as string;

      if (!this.githubClient.isFilePathAllowed(filePath, 'write')) {
        return this.createErrorResult(
          `SAFETY ERROR: File path "${filePath}" is not allowed for modification. Allowed files include:
        1) Configuration files (lifecycle.yaml, lifecycle.yml)
        2) Files explicitly referenced in lifecycle configuration
        3) Dockerfiles in sysops/dockerfiles/
        4) Helm charts and values in helm/ or sysops/helm/
        5) Common config files (package.json, requirements.txt, etc.)`,
          'FILE_PATH_NOT_ALLOWED',
          false
        );
      }

      const branchValidation = this.githubClient.validateBranch(branch);
      if (!branchValidation.valid) {
        return this.createErrorResult(branchValidation.error!, 'BRANCH_VALIDATION_FAILED', false);
      }

      const octokit = await this.githubClient.getOctokit('ai-agent-update-file');

      let currentFileSha: string | undefined;
      try {
        const currentFile = await octokit.request(`GET /repos/${owner}/${repo}/contents/${filePath}`, {
          ref: branch,
        });
        if (currentFile.data && 'sha' in currentFile.data) {
          currentFileSha = currentFile.data.sha;
        }
      } catch (error) {
        currentFileSha = undefined;
      }

      const contentToCommit = newContent.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');

      const response = await octokit.request(`PUT /repos/${owner}/${repo}/contents/${filePath}`, {
        message: `[Lifecycle AI] ${commitMessage}`,
        content: Buffer.from(contentToCommit).toString('base64'),
        branch,
        ...(currentFileSha && { sha: currentFileSha }),
      });

      const result = {
        success: true,
        message: `Successfully ${currentFileSha ? 'updated' : 'created'} ${filePath}`,
        commit_sha: response.data.commit.sha,
        commit_url: response.data.commit.html_url,
      };

      return this.createSuccessResult(JSON.stringify(result));
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Failed to commit changes', 'EXECUTION_ERROR');
    }
  }
}
