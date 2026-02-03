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

  setAllowedBranch(branch: string) {
    this.allowedBranch = branch;
  }

  setReferencedFiles(files: string[]) {
    this.referencedFiles = new Set(files.map((f) => f.toLowerCase()));
  }

  setExcludedFilePatterns(patterns: string[]): void {
    this.excludedFilePatterns = patterns;
  }

  isFileExcluded(filePath: string): boolean {
    if (this.excludedFilePatterns.length === 0) return false;
    return picomatch.isMatch(filePath, this.excludedFilePatterns, { dot: true, nocase: true });
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

    const normalizedPath = filePath.toLowerCase();

    if (this.referencedFiles.has(normalizedPath)) {
      return true;
    }

    const allowedPatterns = [
      /^sysops\/dockerfiles\/.+\.dockerfile$/i,
      /^helm\/.+\.(yaml|yml)$/i,
      /^\.github\/workflows\/.+\.(yaml|yml)$/i,
      /^sysops\/helm\/.+\.(yaml|yml)$/i,
      /^docker-compose\.(yaml|yml)$/i,
      /^package\.json$/i,
      /^requirements\.txt$/i,
      /^go\.(mod|sum)$/i,
      /^pom\.xml$/i,
      /^build\.gradle$/i,
    ];

    return allowedPatterns.some((pattern) => pattern.test(normalizedPath));
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
