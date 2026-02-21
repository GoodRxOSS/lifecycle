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

import { generateInitScript } from '../configSeeder';

describe('configSeeder', () => {
  describe('generateInitScript', () => {
    const baseOpts = {
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'feature/test',
      workspacePath: '/workspace',
    };

    it('contains git clone with branch', () => {
      const script = generateInitScript(baseOpts);
      expect(script).toContain('git clone --branch "feature/test"');
      expect(script).toContain('"https://github.com/org/repo.git"');
      expect(script).toContain('"/workspace"');
    });

    it('marks the workspace as a safe git directory before checkout steps', () => {
      const script = generateInitScript(baseOpts);
      expect(script).toContain('mkdir -p "/workspace"');
      expect(script).toContain('git config --global --add safe.directory "/workspace"');
    });

    it('contains install command when provided', () => {
      const script = generateInitScript({ ...baseOpts, installCommand: 'pnpm install' });
      expect(script).toContain('pnpm install');
    });

    it('does not contain install command when not provided', () => {
      const script = generateInitScript(baseOpts);
      expect(script).not.toContain('pnpm install');
    });

    it('writes CLAUDE.md when content is provided', () => {
      const script = generateInitScript({ ...baseOpts, claudeMdContent: 'Project rules here' });
      expect(script).toContain('CLAUDE.md');
      expect(script).toContain('Project rules here');
    });

    it('writes settings.json with permissions', () => {
      const script = generateInitScript(baseOpts);
      expect(script).toContain('settings.json');
      expect(script).toContain('Bash(*)');
      expect(script).toContain('Read(*)');
      expect(script).toContain('Write(*)');
      expect(script).toContain('Edit(*)');
      expect(script).toContain('Glob(*)');
      expect(script).toContain('Grep(*)');
    });

    it('writes Claude attribution settings when provided', () => {
      const script = generateInitScript({
        ...baseOpts,
        claudeCommitAttribution: 'Generated with (sample-lifecycle-app)',
        claudePrAttribution: 'Generated with (sample-lifecycle-app)',
      });

      expect(script).toContain('"attribution"');
      expect(script).toContain('"commit": "Generated with (sample-lifecycle-app)"');
      expect(script).toContain('"pr": "Generated with (sample-lifecycle-app)"');
    });

    it('writes custom Claude permissions when provided', () => {
      const script = generateInitScript({
        ...baseOpts,
        claudePermissions: {
          allow: ['Read(*)'],
          deny: ['Bash(*)'],
        },
      });

      expect(script).toContain('"allow": [');
      expect(script).toContain('"Read(*)"');
      expect(script).toContain('"deny": [');
      expect(script).toContain('"Bash(*)"');
    });

    it('sets up pre-push branch protection hook', () => {
      const script = generateInitScript(baseOpts);
      expect(script).toContain('pre-push');
      expect(script).toContain('Pushing to $branch_name is not allowed');
      expect(script).toContain('main');
      expect(script).toContain('master');
      expect(script).toContain('chmod +x .git/hooks/pre-push');
    });

    it('starts with shebang', () => {
      const script = generateInitScript(baseOpts);
      expect(script.startsWith('#!/bin/sh')).toBe(true);
    });

    it('configures git identity when user context is provided', () => {
      const script = generateInitScript({
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
      const script = generateInitScript({
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
