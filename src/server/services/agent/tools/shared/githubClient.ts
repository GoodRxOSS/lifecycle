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

import { createOctokitClient } from 'server/lib/github/client';
import picomatch from 'picomatch';
import type { AgentRequestGitHubAuth, AgentGitHubAuthSource } from 'server/services/agent/githubAuth';
import {
  GITHUB_USER_AUTH_REQUIRED_CODE,
  GITHUB_USER_AUTH_REQUIRED_MESSAGE,
  normalizeAgentRequestGitHubAuth,
} from 'server/services/agent/githubAuth';
import type { ToolAuthProvenance } from '../types';

type DiagnosticGitHubAuthSource = AgentGitHubAuthSource;

export type DiagnosticGitHubAuthProvenance = ToolAuthProvenance & {
  provider: 'github';
  source: DiagnosticGitHubAuthSource;
};

export type DiagnosticGitHubApprovalAuthResolver = (context: {
  runUuid?: string | null;
  toolCallId?: string | null;
}) => Promise<AgentRequestGitHubAuth | null>;

export class GitHubUserAuthRequiredError extends Error {
  readonly code = GITHUB_USER_AUTH_REQUIRED_CODE;
  readonly auth: DiagnosticGitHubAuthProvenance;

  constructor(auth: DiagnosticGitHubAuthProvenance) {
    super(GITHUB_USER_AUTH_REQUIRED_MESSAGE);
    this.name = 'GitHubUserAuthRequiredError';
    this.auth = auth;
  }
}

export function isGitHubUserAuthorizationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

export class GitHubClient {
  private allowedBranch: string | null = null;
  private referencedFiles: Set<string> = new Set();
  private excludedFilePatterns: string[] = [];
  private allowedWritePatterns: string[] = [];
  // SECURITY: owner/repo set this build spans; reads outside it are rejected to prevent cross-tenant access.
  private allowedRepos: Set<string> | null = null;
  private defaultRepo: { owner: string; repo: string } | null = null;
  // SECURITY: the build's own PR number; PR mutations targeting any other PR are rejected.
  private allowedPullRequestNumber: number | null = null;
  private requestAuth: AgentRequestGitHubAuth = normalizeAgentRequestGitHubAuth(null);
  private requestAuthResolver: DiagnosticGitHubApprovalAuthResolver | null = null;
  private runUuid: string | null = null;

  private normalizeFilePath(filePath: string): string {
    return filePath.trim().replace(/^\/+/, '').replace(/^\.\//, '');
  }

  private normalizeRepoKey(owner: string, repo: string): string {
    return `${owner}/${repo}`.trim().toLowerCase();
  }

  setAllowedBranch(branch: string) {
    this.allowedBranch = branch;
  }

  setRunUuid(runUuid: string | null | undefined): void {
    this.runUuid = runUuid || null;
  }

  setRequestAuth(
    auth: (AgentRequestGitHubAuth & { resolveApprovalAuth?: DiagnosticGitHubApprovalAuthResolver }) | null | undefined
  ): void {
    this.requestAuth = normalizeAgentRequestGitHubAuth(auth);
    this.requestAuthResolver = auth?.resolveApprovalAuth || null;
  }

  setAllowedRepos(repos: string[] | null | undefined): void {
    if (!repos || repos.length === 0) {
      this.allowedRepos = null;
      return;
    }

    this.allowedRepos = new Set(
      repos.map((entry) => entry?.trim().toLowerCase()).filter((entry): entry is string => Boolean(entry))
    );
  }

  isRepoAllowed(owner: string, repo: string): boolean {
    if (!this.allowedRepos) {
      return true;
    }

    return this.allowedRepos.has(this.normalizeRepoKey(owner, repo));
  }

  getAllowedRepos(): string[] {
    return this.allowedRepos ? [...this.allowedRepos] : [];
  }

  setDefaultRepo(fullName: string | null | undefined): void {
    const [owner, repo] = (fullName || '').trim().split('/');
    this.defaultRepo = owner && repo ? { owner, repo } : null;
  }

  setAllowedPullRequestNumber(pullRequestNumber: number | null | undefined): void {
    this.allowedPullRequestNumber = typeof pullRequestNumber === 'number' ? pullRequestNumber : null;
  }

  getAllowedPullRequestNumber(): number | null {
    return this.allowedPullRequestNumber;
  }

  getDefaultRepo(): { owner: string; repo: string } | null {
    return this.defaultRepo;
  }

  /**
   * Throws a FILE_ACCESS_DENIED-style error when owner/repo is outside the build scope.
   */
  assertRepoAllowed(owner: string, repo: string): void {
    if (!this.isRepoAllowed(owner, repo)) {
      throw new Error(
        `Repository "${owner}/${repo}" is outside this environment's repositories (${this.getAllowedRepos().join(
          ', '
        )}) and cannot be accessed.`
      );
    }
  }

  setReferencedFiles(files: string[]) {
    this.referencedFiles = new Set(files.map((file) => this.normalizeFilePath(file).toLowerCase()));
  }

  setExcludedFilePatterns(patterns: string[]): void {
    this.excludedFilePatterns = patterns;
  }

  setAllowedWritePatterns(patterns: string[]): void {
    this.allowedWritePatterns = patterns;
  }

  isFileExcluded(filePath: string): boolean {
    if (this.excludedFilePatterns.length === 0) return false;
    return picomatch.isMatch(this.normalizeFilePath(filePath), this.excludedFilePatterns, { dot: true, nocase: true });
  }

  getAllowedBranch(): string | null {
    return this.allowedBranch;
  }

  isFilePathAllowed(filePath: string, mode: 'read' | 'write'): boolean {
    if (this.isFileExcluded(filePath)) {
      return false;
    }

    if (mode === 'read') {
      return true;
    }

    const normalizedPath = this.normalizeFilePath(filePath);
    const normalizedLowerPath = normalizedPath.toLowerCase();

    if (this.referencedFiles.has(normalizedLowerPath)) {
      return true;
    }

    if (
      this.allowedWritePatterns.length > 0 &&
      picomatch.isMatch(normalizedPath, this.allowedWritePatterns, { dot: true, nocase: true })
    ) {
      return true;
    }

    return false;
  }

  validateBranch(branch: string): { valid: boolean; error?: string } {
    if (!this.allowedBranch) {
      return {
        valid: false,
        error: 'SAFETY ERROR: No allowed branch set. Cannot commit.',
      };
    }

    if (branch !== this.allowedBranch) {
      return {
        valid: false,
        error: `SAFETY ERROR: Attempted to commit to branch "${branch}" but only "${this.allowedBranch}" is allowed. This prevents accidental commits to main/master.`,
      };
    }

    return { valid: true };
  }

  extractReferencedFilesFromYaml(yamlContent: string): string[] {
    const referencedFiles: string[] = [];

    const dockerfileMatches = yamlContent.matchAll(/dockerfilePath:\s*['"']?([^\s'"]+)['"']?/gi);
    for (const match of dockerfileMatches) {
      if (match[1]) {
        referencedFiles.push(match[1]);
      }
    }

    const valueFilesMatches = yamlContent.matchAll(/valueFiles:\s*\n((?:\s*-\s*[^\n]+\n?)+)/gi);
    for (const match of valueFilesMatches) {
      const valueFilesList = match[1];
      const individualFiles = valueFilesList.matchAll(/^\s*-\s*['"']?([^\s'"#]+)['"']?/gim);
      for (const fileMatch of individualFiles) {
        if (fileMatch[1]) {
          referencedFiles.push(fileMatch[1]);
        }
      }
    }

    const chartPathMatches = yamlContent.matchAll(/chart:\s*['"']?(\.[^\s'"]+)['"']?/gi);
    for (const match of chartPathMatches) {
      if (match[1]) {
        referencedFiles.push(match[1]);
      }
    }

    return [...new Set(referencedFiles)];
  }

  private provenance(
    source: DiagnosticGitHubAuthSource,
    required: boolean,
    githubUsername?: string | null
  ): DiagnosticGitHubAuthProvenance {
    return {
      provider: 'github',
      source,
      required,
      githubUsername: githubUsername || null,
    };
  }

  private async resolveApprovalAuth(toolCallId?: string | null): Promise<AgentRequestGitHubAuth | null> {
    if (!this.requestAuthResolver) {
      return null;
    }

    return normalizeAgentRequestGitHubAuth(
      await this.requestAuthResolver({
        runUuid: this.runUuid,
        toolCallId,
      })
    );
  }

  async getOctokitWithAuth(
    caller: string,
    options: { requireUserAuth: boolean; toolCallId?: string | null }
  ): Promise<{ octokit: Awaited<ReturnType<typeof createOctokitClient>>; auth: DiagnosticGitHubAuthProvenance }> {
    const requestAuth = normalizeAgentRequestGitHubAuth(this.requestAuth);

    if (options.requireUserAuth) {
      const approvalAuth = normalizeAgentRequestGitHubAuth(await this.resolveApprovalAuth(options.toolCallId));
      const auth = approvalAuth.githubToken ? approvalAuth : requestAuth;
      if (auth.source !== 'user' || !auth.githubToken || auth.writeAuthorized !== true) {
        throw new GitHubUserAuthRequiredError(this.provenance('none', true, auth.githubUsername));
      }

      return {
        octokit: await createOctokitClient({ accessToken: auth.githubToken, caller }),
        auth: this.provenance('user', true, auth.githubUsername),
      };
    }

    if (requestAuth.source === 'user' && requestAuth.githubToken) {
      return {
        octokit: await createOctokitClient({ accessToken: requestAuth.githubToken, caller }),
        auth: this.provenance('user', false, requestAuth.githubUsername),
      };
    }

    return {
      octokit: await createOctokitClient({ caller }),
      auth: this.provenance('app', false),
    };
  }

  async getOctokit(caller: string) {
    return createOctokitClient({ caller });
  }
}
