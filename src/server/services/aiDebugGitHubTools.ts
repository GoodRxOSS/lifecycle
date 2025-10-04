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

import BaseService from './_service';
import { createOctokitClient } from '../lib/github/client';

export interface GitHubToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export default class AIDebugGitHubToolsService extends BaseService {
  private allowedBranch: string | null = null;

  setAllowedBranch(branch: string) {
    this.allowedBranch = branch;
  }

  getToolDefinitions(): GitHubToolDefinition[] {
    return [
      {
        name: 'get_lifecycle_config',
        description:
          'Fetch the lifecycle.yaml configuration file from the repository. Use this to understand service configurations, probe settings, resource limits, etc.',
        input_schema: {
          type: 'object',
          properties: {
            repository_owner: { type: 'string', description: 'Repository owner (organization or user)' },
            repository_name: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Branch name (usually the PR branch)' },
          },
          required: ['repository_owner', 'repository_name', 'branch'],
        },
      },
      {
        name: 'commit_lifecycle_fix',
        description:
          'Commit a fix to the lifecycle.yaml file on the PR branch. Use this to fix configuration issues like wrong ports, resource limits, etc.',
        input_schema: {
          type: 'object',
          properties: {
            repository_owner: { type: 'string', description: 'Repository owner' },
            repository_name: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Branch name to commit to' },
            new_content: { type: 'string', description: 'The new content for lifecycle.yaml' },
            commit_message: { type: 'string', description: 'Commit message describing the fix' },
          },
          required: ['repository_owner', 'repository_name', 'branch', 'new_content', 'commit_message'],
        },
      },
      {
        name: 'get_referenced_file',
        description:
          'Read any file referenced in lifecycle.yaml (Dockerfile paths, Helm valueFiles, etc.). Examples: sysops/dockerfiles/app.dockerfile, sysops/helm/lfc/service/app.yaml',
        input_schema: {
          type: 'object',
          properties: {
            repository_owner: { type: 'string', description: 'Repository owner' },
            repository_name: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Branch name' },
            file_path: {
              type: 'string',
              description:
                'Path to file referenced in lifecycle.yaml (e.g., sysops/dockerfiles/app.dockerfile, helm/lc-apps/values.yaml)',
            },
          },
          required: ['repository_owner', 'repository_name', 'branch', 'file_path'],
        },
      },
      {
        name: 'update_referenced_file',
        description:
          'Update or create files referenced in lifecycle.yaml (Dockerfiles, Helm values, etc.). Use this to fix issues in Dockerfiles or Helm configuration.',
        input_schema: {
          type: 'object',
          properties: {
            repository_owner: { type: 'string', description: 'Repository owner' },
            repository_name: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Branch name to commit to' },
            file_path: { type: 'string', description: 'Path to file (must be referenced in lifecycle.yaml)' },
            new_content: { type: 'string', description: 'The new file content' },
            commit_message: { type: 'string', description: 'Commit message' },
          },
          required: ['repository_owner', 'repository_name', 'branch', 'file_path', 'new_content', 'commit_message'],
        },
      },
      {
        name: 'list_directory',
        description:
          'List files and directories in a repository path. Use this to discover actual file names when a path is wrong (e.g., if Dockerfile not found at sysops/dockerfiles/app.dockerfile, list sysops/dockerfiles/ to find the correct name).',
        input_schema: {
          type: 'object',
          properties: {
            repository_owner: { type: 'string', description: 'Repository owner' },
            repository_name: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Branch name' },
            directory_path: {
              type: 'string',
              description:
                'Directory path to list (e.g., sysops/dockerfiles, helm/lc-apps). Use empty string for root directory.',
            },
          },
          required: ['repository_owner', 'repository_name', 'branch', 'directory_path'],
        },
      },
    ];
  }

  async executeTool(toolName: string, input: any): Promise<any> {
    switch (toolName) {
      case 'get_lifecycle_config':
        return this.getLifecycleConfig(input.repository_owner, input.repository_name, input.branch);
      case 'commit_lifecycle_fix':
        return this.commitLifecycleFix(
          input.repository_owner,
          input.repository_name,
          input.branch,
          input.new_content,
          input.commit_message
        );
      case 'get_referenced_file':
        return this.getReferencedFile(input.repository_owner, input.repository_name, input.branch, input.file_path);
      case 'update_referenced_file':
        return this.updateReferencedFile(
          input.repository_owner,
          input.repository_name,
          input.branch,
          input.file_path,
          input.new_content,
          input.commit_message
        );
      case 'list_directory':
        return this.listDirectory(input.repository_owner, input.repository_name, input.branch, input.directory_path);
      default:
        throw new Error(`Unknown GitHub tool: ${toolName}`);
    }
  }

  private async getLifecycleConfig(owner: string, repo: string, branch: string): Promise<any> {
    try {
      const octokit = await createOctokitClient({ caller: 'ai-debug-get-lifecycle-config' });

      // Try to get lifecycle.yaml
      let path = 'lifecycle.yaml';
      let response;

      try {
        response = await octokit.request(`GET /repos/${owner}/${repo}/contents/${path}`, {
          ref: branch,
        });
      } catch (error) {
        // Try lifecycle.yml if .yaml doesn't exist
        path = 'lifecycle.yml';
        response = await octokit.request(`GET /repos/${owner}/${repo}/contents/${path}`, {
          ref: branch,
        });
      }

      if (response.data && 'content' in response.data && response.data.type === 'file') {
        const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
        return {
          success: true,
          path,
          content,
          sha: response.data.sha,
        };
      }

      return {
        success: false,
        error: 'lifecycle.yaml is not a file or does not exist',
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Failed to fetch lifecycle.yaml',
      };
    }
  }

  private async commitLifecycleFix(
    owner: string,
    repo: string,
    branch: string,
    newContent: string,
    commitMessage: string
  ): Promise<any> {
    // CRITICAL SAFETY CHECK: Only allow commits to the PR branch
    if (!this.allowedBranch) {
      return {
        success: false,
        error: 'SAFETY ERROR: No allowed branch set. Cannot commit.',
      };
    }

    if (branch !== this.allowedBranch) {
      return {
        success: false,
        error: `SAFETY ERROR: Attempted to commit to branch "${branch}" but only "${this.allowedBranch}" is allowed. This prevents accidental commits to main/master.`,
      };
    }

    try {
      const octokit = await createOctokitClient({ caller: 'ai-debug-commit-lifecycle-fix' });

      // First, get the current file to get its SHA
      let path = 'lifecycle.yaml';
      let currentFile;

      try {
        currentFile = await octokit.request(`GET /repos/${owner}/${repo}/contents/${path}`, {
          ref: branch,
        });
      } catch (error) {
        // Try lifecycle.yml
        path = 'lifecycle.yml';
        currentFile = await octokit.request(`GET /repos/${owner}/${repo}/contents/${path}`, {
          ref: branch,
        });
      }

      if (!currentFile.data || !('sha' in currentFile.data)) {
        return {
          success: false,
          error: 'Could not get file SHA',
        };
      }

      // Commit the updated file
      const response = await octokit.request(`PUT /repos/${owner}/${repo}/contents/${path}`, {
        message: `[AI Fix] ${commitMessage}`,
        content: Buffer.from(newContent).toString('base64'),
        branch,
        sha: currentFile.data.sha,
      });

      return {
        success: true,
        message: `Successfully committed fix to ${path}`,
        commit_sha: response.data.commit.sha,
        commit_url: response.data.commit.html_url,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Failed to commit changes',
      };
    }
  }

  private isFilePathAllowed(filePath: string): boolean {
    // Allow files that are commonly referenced in lifecycle.yaml
    const allowedPatterns = [
      /dockerfile/i, // Dockerfiles (e.g., sysops/dockerfiles/app.dockerfile)
      /helm.*\.ya?ml$/i, // Helm value files (e.g., sysops/helm/lfc/service/app.yaml)
      /\.dockerfile$/i, // .dockerfile extension
      /^docker\//i, // docker/ directory
      /^helm\//i, // helm/ directory
      /^sysops\//i, // sysops/ directory
      /^\.github\//i, // .github/ directory (workflows, etc.)
    ];

    return allowedPatterns.some((pattern) => pattern.test(filePath));
  }

  private async getReferencedFile(owner: string, repo: string, branch: string, filePath: string): Promise<any> {
    // SAFETY CHECK: Path must match allowed patterns
    if (!this.isFilePathAllowed(filePath)) {
      return {
        success: false,
        error: `SAFETY ERROR: File path "${filePath}" is not allowed. Only files referenced in lifecycle.yaml are accessible (Dockerfiles, Helm values, sysops configs).`,
      };
    }

    try {
      const octokit = await createOctokitClient({ caller: 'ai-debug-get-helm-lfc-file' });

      const response = await octokit.request(`GET /repos/${owner}/${repo}/contents/${filePath}`, {
        ref: branch,
      });

      if (response.data && 'content' in response.data && response.data.type === 'file') {
        const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
        return {
          success: true,
          path: filePath,
          content,
          sha: response.data.sha,
        };
      }

      return {
        success: false,
        error: `${filePath} is not a file or does not exist`,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || `Failed to fetch ${filePath}`,
      };
    }
  }

  private async updateReferencedFile(
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
    newContent: string,
    commitMessage: string
  ): Promise<any> {
    // SAFETY CHECK: Path must match allowed patterns
    if (!this.isFilePathAllowed(filePath)) {
      return {
        success: false,
        error: `SAFETY ERROR: File path "${filePath}" is not allowed. Only files referenced in lifecycle.yaml are accessible (Dockerfiles, Helm values, sysops configs).`,
      };
    }

    // SAFETY CHECK: Only allow commits to the PR branch
    if (!this.allowedBranch) {
      return {
        success: false,
        error: 'SAFETY ERROR: No allowed branch set. Cannot commit.',
      };
    }

    if (branch !== this.allowedBranch) {
      return {
        success: false,
        error: `SAFETY ERROR: Attempted to commit to branch "${branch}" but only "${this.allowedBranch}" is allowed.`,
      };
    }

    try {
      const octokit = await createOctokitClient({ caller: 'ai-debug-update-helm-lfc-file' });

      // Try to get the current file to get its SHA (file might not exist yet)
      let currentFileSha: string | undefined;
      try {
        const currentFile = await octokit.request(`GET /repos/${owner}/${repo}/contents/${filePath}`, {
          ref: branch,
        });
        if (currentFile.data && 'sha' in currentFile.data) {
          currentFileSha = currentFile.data.sha;
        }
      } catch (error) {
        // File doesn't exist yet - that's okay, we'll create it
        currentFileSha = undefined;
      }

      // Commit the file (create or update)
      const response = await octokit.request(`PUT /repos/${owner}/${repo}/contents/${filePath}`, {
        message: `[AI Fix] ${commitMessage}`,
        content: Buffer.from(newContent).toString('base64'),
        branch,
        ...(currentFileSha && { sha: currentFileSha }),
      });

      return {
        success: true,
        message: `Successfully ${currentFileSha ? 'updated' : 'created'} ${filePath}`,
        commit_sha: response.data.commit.sha,
        commit_url: response.data.commit.html_url,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Failed to commit changes',
      };
    }
  }

  private async listDirectory(owner: string, repo: string, branch: string, directoryPath: string): Promise<any> {
    if (!this.isDirectoryPathAllowed(directoryPath)) {
      return {
        success: false,
        error: `SAFETY ERROR: Directory path "${directoryPath}" is not allowed. Only directories containing config files are accessible (dockerfiles, helm, sysops, .github).`,
      };
    }

    try {
      const octokit = await createOctokitClient({ caller: 'ai-debug-list-directory' });

      const response = await octokit.request(`GET /repos/${owner}/${repo}/contents/${directoryPath}`, {
        ref: branch,
      });

      if (!Array.isArray(response.data)) {
        return {
          success: false,
          error: `Path "${directoryPath}" is not a directory`,
        };
      }

      const items = response.data.map((item: any) => ({
        name: item.name,
        type: item.type,
        path: item.path,
      }));

      return {
        success: true,
        path: directoryPath || '/',
        items,
        count: items.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || `Failed to list directory ${directoryPath}`,
      };
    }
  }

  private isDirectoryPathAllowed(dirPath: string): boolean {
    const allowedPatterns = [
      /^$/, // Root directory
      /^\.github/i, // .github directory
      /^sysops/i, // sysops directory
      /^helm/i, // helm directory
      /^docker/i, // docker directory
      /dockerfile/i, // Any path containing dockerfile
    ];

    return allowedPatterns.some((pattern) => pattern.test(dirPath));
  }
}
