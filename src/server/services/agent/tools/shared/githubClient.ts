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

export class GitHubClient {
  private allowedBranch: string | null = null;
  private referencedFiles: Set<string> = new Set();
  private excludedFilePatterns: string[] = [];
  private allowedWritePatterns: string[] = [];
  // SECURITY: owner/repo set this build spans; reads outside it are rejected to prevent cross-tenant access.
  private allowedRepos: Set<string> | null = null;

  private normalizeFilePath(filePath: string): string {
    return filePath.trim().replace(/^\/+/, '').replace(/^\.\//, '');
  }

  private normalizeRepoKey(owner: string, repo: string): string {
    return `${owner}/${repo}`.trim().toLowerCase();
  }

  setAllowedBranch(branch: string) {
    this.allowedBranch = branch;
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

  async getOctokit(caller: string) {
    return createOctokitClient({ caller });
  }
}
