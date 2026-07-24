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
import { GitHubClient, GitHubUserAuthRequiredError, isGitHubUserAuthorizationError } from '../shared/githubClient';
import { GITHUB_USER_AUTH_REQUIRED_CODE } from 'server/services/agent/githubAuth';
import { YamlConfigParser } from 'server/lib/yamlConfigParser';
import { YamlConfigValidator } from 'server/lib/yamlConfigValidator';
import { renderLifecycleSchemaSlices } from 'server/lib/yamlSchemas/schemaSlice';

// TODO: Make this configurable in db
export const MAX_LINES_REMOVED = 10;
export const MAX_LINES_CHANGED = 150;
const MAX_EXACT_DIFF_MATRIX_CELLS = 1_000_000;

function normalizeRepoPath(filePath: string): string {
  return filePath.trim().replace(/^\/+/, '').replace(/^\.\//, '');
}

export function isLifecycleConfigPath(filePath: string): boolean {
  const base = filePath.split('/').pop() || filePath;
  return base === 'lifecycle.yaml' || base === 'lifecycle.yml';
}

/** Validates proposed lifecycle.yaml content so an invalid config never reaches the PR branch. */
export function validateLifecycleConfigContent(content: string): { valid: boolean; error?: string } {
  try {
    const config = new YamlConfigParser().parseYamlConfigFromString(content);
    new YamlConfigValidator().validate(config?.version, config);
    return { valid: true };
  } catch (error: any) {
    return { valid: false, error: error?.message || String(error) };
  }
}

function countDiffLines(oldContent: string, newContent: string): { additions: number; deletions: number } {
  if (oldContent === newContent) {
    return { additions: 0, deletions: 0 };
  }

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Guard the O(n*m) LCS matrix; oversized inputs fall back to a conservative full-rewrite count.
  if (oldLines.length * newLines.length > MAX_EXACT_DIFF_MATRIX_CELLS) {
    return { additions: newLines.length, deletions: oldLines.length };
  }

  const dp = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? dp[oldIndex + 1][newIndex + 1] + 1
          : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  const lcsLength = dp[0][0];
  return { additions: newLines.length - lcsLength, deletions: oldLines.length - lcsLength };
}

export function validateDiff(
  oldContent: string,
  newContent: string
): { valid: boolean; error?: string; linesRemoved: number; linesChanged: number } {
  const { additions, deletions } = countDiffLines(oldContent, newContent);
  const linesRemoved = deletions;
  const linesChanged = additions + deletions;

  if (linesRemoved > MAX_LINES_REMOVED) {
    return {
      valid: false,
      linesRemoved,
      linesChanged,
      error: `SAFETY ERROR: Your update removes ${linesRemoved} lines from the original file. Only modify the specific lines needed for the fix. Use the exact content from get_file as your starting point, change only the targeted lines, and resubmit.`,
    };
  }

  if (linesChanged > MAX_LINES_CHANGED) {
    return {
      valid: false,
      linesRemoved,
      linesChanged,
      error: `SAFETY ERROR: Your update changes ${linesChanged} lines. This exceeds the expected scope for a targeted fix. Use the exact content from get_file as your starting point, change only the targeted lines, and resubmit.`,
    };
  }

  return { valid: true, linesRemoved, linesChanged };
}

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
      const owner = args.repository_owner as string;
      const repo = args.repository_name as string;
      const branch = args.branch as string;
      const filePath = normalizeRepoPath(args.file_path as string);
      const newContent = args.new_content as string;
      const commitMessage = args.commit_message as string;

      if (!this.githubClient.isRepoAllowed(owner, repo)) {
        return this.createErrorResult(
          `Repository "${owner}/${repo}" is outside this environment's repositories and cannot be modified.`,
          'REPO_NOT_ALLOWED'
        );
      }

      if (!this.githubClient.isFilePathAllowed(filePath, 'write')) {
        return this.createErrorResult(
          `SAFETY ERROR: File path "${filePath}" is not allowed for modification. Allowed files include:
        1) Configuration files (lifecycle.yaml, lifecycle.yml)
        2) Files explicitly referenced in lifecycle configuration
        3) Additional paths configured via allowedWritePatterns in the agent runtime config`,
          'FILE_PATH_NOT_ALLOWED'
        );
      }

      const branchValidation = this.githubClient.validateBranch(branch);
      if (!branchValidation.valid) {
        return this.createErrorResult(branchValidation.error!, 'BRANCH_VALIDATION_FAILED');
      }

      // Reads + no-op/validation run on read auth; a no-op must not dead-end on the approval-only write handoff.
      const readOctokitWithAuth = await this.githubClient.getOctokitWithAuth('agent-runtime-update-file', {
        requireUserAuth: false,
        toolCallId: context?.toolCallId,
      });
      auth = readOctokitWithAuth.auth;

      let currentFileSha: string | undefined;
      let currentFileContent: string | undefined;
      try {
        const currentFile = await readOctokitWithAuth.octokit.request(
          `GET /repos/${owner}/${repo}/contents/${filePath}`,
          {
            ref: branch,
          }
        );
        if (currentFile.data && 'sha' in currentFile.data) {
          currentFileSha = currentFile.data.sha;
        }
        if (currentFile.data && 'content' in currentFile.data) {
          currentFileContent = Buffer.from(currentFile.data.content as string, 'base64').toString('utf-8');
        }
      } catch (error) {
        currentFileSha = undefined;
      }

      // Verbatim: the SDK already JSON-decodes; unescaping double-decodes and diverges from the approved diff.
      const contentToCommit = newContent;

      if (currentFileContent !== undefined && currentFileContent === contentToCommit) {
        const result = {
          success: true,
          changed: false,
          commit_created: false,
          message: `No changes to ${filePath}; content already matches ${branch}.`,
          repository: `${owner}/${repo}`,
          branch,
          file_path: filePath,
        };

        return {
          ...this.createSuccessResult(JSON.stringify(result), `No changes to ${filePath}\nNo commit created.`),
          auth,
        };
      }

      if (isLifecycleConfigPath(filePath)) {
        const validation = validateLifecycleConfigContent(contentToCommit);
        if (!validation.valid) {
          const slices = renderLifecycleSchemaSlices(validation.error || '');
          return {
            ...this.createErrorResult(
              `The proposed ${filePath} is not a valid Lifecycle config and was NOT committed. Fix the content, verify it with validate_lifecycle_config, and resubmit. Validation error:\n${
                validation.error
              }${slices ? `\nRelevant schema for the failing paths:\n${slices}` : ''}`,
              'LIFECYCLE_CONFIG_INVALID'
            ),
            auth,
          };
        }
      }

      if (currentFileContent !== undefined) {
        const diffResult = validateDiff(currentFileContent, contentToCommit);
        if (!diffResult.valid) {
          return { ...this.createErrorResult(diffResult.error!, 'DIFF_VALIDATION_FAILED'), auth };
        }
      }

      // Only the commit itself requires the approval-granted user write authorization.
      const octokitWithAuth = await this.githubClient.getOctokitWithAuth('agent-runtime-update-file', {
        requireUserAuth: true,
        toolCallId: context?.toolCallId,
      });
      const octokit = octokitWithAuth.octokit;
      auth = octokitWithAuth.auth;

      const response = await octokit.request(`PUT /repos/${owner}/${repo}/contents/${filePath}`, {
        message: `[Lifecycle AI] ${commitMessage}`,
        content: Buffer.from(contentToCommit).toString('base64'),
        branch,
        ...(currentFileSha && { sha: currentFileSha }),
      });

      const commitSha = response.data.commit.sha;
      const commitUrl = response.data.commit.html_url;
      const result = {
        success: true,
        message: `Successfully ${currentFileSha ? 'updated' : 'created'} ${filePath}`,
        commit_sha: commitSha,
        commit_url: commitUrl,
        commit_message: `[Lifecycle AI] ${commitMessage}`,
        repository: `${owner}/${repo}`,
        branch,
        file_path: filePath,
      };

      const displayContent = `${currentFileSha ? 'Updated' : 'Created'} ${filePath}\nCommit: ${commitUrl}`;
      return { ...this.createSuccessResult(JSON.stringify(result), displayContent), auth };
    } catch (error: any) {
      if (error instanceof GitHubUserAuthRequiredError) {
        return { ...this.createErrorResult(error.message, GITHUB_USER_AUTH_REQUIRED_CODE), auth: error.auth };
      }
      if (isGitHubUserAuthorizationError(error)) {
        return {
          ...this.createErrorResult(
            'GitHub authorization is required to apply this repair. Reconnect GitHub and approve again.',
            GITHUB_USER_AUTH_REQUIRED_CODE
          ),
          auth,
        };
      }
      return { ...this.createErrorResult(error.message || 'Failed to commit changes', 'EXECUTION_ERROR'), auth };
    }
  }
}
