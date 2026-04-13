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

import { generateInitScript, generateRuntimeSeedScript } from '../configSeeder';

describe('configSeeder', () => {
  describe('generateInitScript', () => {
    const baseOpts = {
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'feature/test',
      workspacePath: '/workspace',
    };

    it('contains git clone with progress, shallow depth, and branch', () => {
      const script = generateInitScript(baseOpts);
      expect(script).toContain('git clone --progress --depth 50 --branch "feature/test"');
      expect(script).toContain('"https://github.com/org/repo.git"');
      expect(script).toContain('"/workspace"');
    });

    it('unshallows the branch before checkout when a revision is requested', () => {
      const script = generateInitScript({
        ...baseOpts,
        revision: 'abc123def456',
      });

      expect(script).toContain('git rev-parse --verify --quiet "abc123def456^{commit}" >/dev/null');
      expect(script).toContain('git fetch --unshallow origin "feature/test" || git fetch origin "feature/test"');
      expect(script).toContain('git checkout "abc123def456"');
    });

    it('creates the workspace directory before cloning', () => {
      const script = generateInitScript(baseOpts);
      expect(script).toContain('mkdir -p "/workspace"');
    });

    it('contains install command when provided', () => {
      const script = generateInitScript({ ...baseOpts, installCommand: 'pnpm install' });
      expect(script).toContain('pnpm install');
    });

    it('does not contain install command when not provided', () => {
      const script = generateInitScript(baseOpts);
      expect(script).not.toContain('pnpm install');
    });

    it('does not write deprecated assistant bootstrap files', () => {
      const script = generateInitScript(baseOpts);
      expect(script).not.toContain('CLAUDE.md');
      expect(script).not.toContain('settings.json');
    });

    it('does not include runtime seed steps', () => {
      const script = generateInitScript(baseOpts);
      expect(script).not.toContain('git config --global --add safe.directory "/workspace"');
      expect(script).not.toContain('pre-push');
      expect(script).not.toContain('git config --global user.name');
    });

    it('configures a GitHub credential helper before the first clone when token auth is enabled', () => {
      const script = generateInitScript({
        ...baseOpts,
        useGitHubToken: true,
      });

      const credentialHelperIndex = script.indexOf(
        'git config --global credential.helper \'!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f\''
      );
      const cloneIndex = script.indexOf('git clone --progress --depth 50 --branch "feature/test"');

      expect(credentialHelperIndex).toBeGreaterThan(-1);
      expect(cloneIndex).toBeGreaterThan(-1);
      expect(credentialHelperIndex).toBeLessThan(cloneIndex);
    });
  });

  describe('generateRuntimeSeedScript', () => {
    const baseOpts = {
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'feature/test',
      workspacePath: '/workspace',
    };

    it('marks the workspace as a safe git directory', () => {
      const script = generateRuntimeSeedScript(baseOpts);
      expect(script).toContain('git config --global --add safe.directory "/workspace"');
    });

    it('sets up pre-push branch protection hook', () => {
      const script = generateRuntimeSeedScript(baseOpts);
      expect(script).toContain('pre-push');
      expect(script).toContain('Pushing to $branch_name is not allowed');
      expect(script).toContain('main');
      expect(script).toContain('master');
      expect(script).toContain('chmod +x "/workspace/.git/hooks/pre-push"');
    });

    it('clones additional repositories into repo-specific workspace paths', () => {
      const script = generateInitScript({
        workspaceRepos: [
          {
            repo: 'org/ui',
            repoUrl: 'https://github.com/org/ui.git',
            branch: 'feature/ui',
            revision: 'abc123',
            mountPath: '/workspace',
            primary: true,
          },
          {
            repo: 'org/api',
            repoUrl: 'https://github.com/org/api.git',
            branch: 'feature/api',
            revision: null,
            mountPath: '/workspace/repos/org/api',
            primary: false,
          },
        ],
      });

      expect(script).toContain('git clone --progress --depth 50 --branch "feature/ui" --single-branch');
      expect(script).toContain('git clone --progress --depth 50 --branch "feature/api" --single-branch');
      expect(script).toContain('"/workspace/repos/org"');
      expect(script).toContain('"/workspace/repos/org/api"');
    });

    it('starts with shebang', () => {
      const script = generateInitScript(baseOpts);
      expect(script.startsWith('#!/bin/sh')).toBe(true);
    });

    it('configures git identity when user context is provided', () => {
      const script = generateRuntimeSeedScript({
        ...baseOpts,
        gitUserName: 'Sample User',
        gitUserEmail: 'sample-user@example.com',
        githubUsername: 'sample-user',
      });

      expect(script).toContain('git config --global user.name "Sample User"');
      expect(script).toContain('git config --global user.email "sample-user@example.com"');
      expect(script).toContain('git config --global github.user "sample-user"');
    });

    it('configures a GitHub credential helper when token auth is enabled', () => {
      const script = generateRuntimeSeedScript({
        ...baseOpts,
        useGitHubToken: true,
      });

      expect(script).toContain('if [ -n "${GITHUB_TOKEN:-}" ]; then');
      expect(script).toContain(
        'git config --global credential.helper \'!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f\''
      );
    });
  });
});
