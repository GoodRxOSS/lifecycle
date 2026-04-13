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

import { posix as pathPosix } from 'path';
import type { AgentSessionWorkspaceRepo } from './workspace';

export const SESSION_WORKSPACE_SHARED_HOME_DIR = '/home/agent/.lifecycle-session';
export const SESSION_WORKSPACE_HOME_VOLUME_NAME = 'session-home';

export interface InitScriptOpts {
  repoUrl?: string;
  branch?: string;
  revision?: string;
  workspacePath?: string;
  workspaceRepos?: AgentSessionWorkspaceRepo[];
  installCommand?: string;
  gitUserName?: string;
  gitUserEmail?: string;
  githubUsername?: string;
  useGitHubToken?: boolean;
}

function escapeDoubleQuotedShell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

function resolveInitWorkspaceRepos(opts: InitScriptOpts): AgentSessionWorkspaceRepo[] {
  if (opts.workspaceRepos && opts.workspaceRepos.length > 0) {
    return opts.workspaceRepos;
  }

  if (!opts.repoUrl || !opts.branch || !opts.workspacePath) {
    throw new Error('repoUrl, branch, and workspacePath are required when workspaceRepos is not provided');
  }

  return [
    {
      repo: opts.repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
      repoUrl: opts.repoUrl,
      branch: opts.branch,
      revision: opts.revision || null,
      mountPath: opts.workspacePath,
      primary: true,
    },
  ];
}

function appendPrePushHook(lines: string[], repoPath: string) {
  lines.push(
    `if [ -d "${escapeDoubleQuotedShell(repoPath)}/.git" ]; then`,
    `  mkdir -p "${escapeDoubleQuotedShell(repoPath)}/.git/hooks"`,
    `  cat > "${escapeDoubleQuotedShell(repoPath)}/.git/hooks/pre-push" << 'HOOK_EOF'`,
    '#!/bin/sh',
    'while read _ _ remote_ref _; do',
    `  branch_name="\${remote_ref##refs/heads/}"`,
    `  if [ "$branch_name" = "main" ] || [ "$branch_name" = "master" ]; then`,
    '    echo "ERROR: Pushing to $branch_name is not allowed"',
    '    exit 1',
    '  fi',
    'done',
    'exit 0',
    'HOOK_EOF',
    `  chmod +x "${escapeDoubleQuotedShell(repoPath)}/.git/hooks/pre-push"`,
    'fi'
  );
}

function appendGitIdentityAndAuthLines(lines: string[], opts: InitScriptOpts) {
  const { gitUserName, gitUserEmail, githubUsername, useGitHubToken } = opts;

  if (gitUserName) {
    lines.push(`git config --global user.name "${escapeDoubleQuotedShell(gitUserName)}"`);
  }

  if (gitUserEmail) {
    lines.push(`git config --global user.email "${escapeDoubleQuotedShell(gitUserEmail)}"`);
  }

  if (githubUsername) {
    lines.push(`git config --global github.user "${escapeDoubleQuotedShell(githubUsername)}"`);
  }

  if (useGitHubToken) {
    lines.push(
      'if [ -n "${GITHUB_TOKEN:-}" ]; then',
      '  git config --global credential.helper \'!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f\'',
      'fi'
    );
  }
}

function appendRuntimeSeedLines(lines: string[], workspaceRepos: AgentSessionWorkspaceRepo[], opts: InitScriptOpts) {
  appendGitIdentityAndAuthLines(lines, opts);

  for (const repo of workspaceRepos) {
    lines.push(
      `if ! git config --global --get-all safe.directory | grep -Fx "${escapeDoubleQuotedShell(
        repo.mountPath
      )}" >/dev/null 2>&1; then`,
      `  git config --global --add safe.directory "${escapeDoubleQuotedShell(repo.mountPath)}"`,
      'fi'
    );
  }

  for (const repo of workspaceRepos) {
    lines.push('');
    appendPrePushHook(lines, repo.mountPath);
  }
}

export function generateRuntimeSeedScript(opts: InitScriptOpts): string {
  const workspaceRepos = resolveInitWorkspaceRepos(opts);
  const lines = ['#!/bin/sh', 'set -e'];

  appendRuntimeSeedLines(lines, workspaceRepos, opts);

  return lines.join('\n') + '\n';
}

export function generateInitScript(opts: InitScriptOpts): string {
  const { installCommand } = opts;
  const workspaceRepos = resolveInitWorkspaceRepos(opts);
  const primaryRepo = workspaceRepos.find((repo) => repo.primary) || workspaceRepos[0];

  const lines = ['#!/bin/sh', 'set -e'];

  appendGitIdentityAndAuthLines(lines, opts);

  for (const repo of workspaceRepos) {
    const parentDir = pathPosix.dirname(repo.mountPath);
    const cloneRoot = parentDir === '/' ? repo.mountPath : parentDir;
    lines.push(
      '',
      `mkdir -p "${escapeDoubleQuotedShell(cloneRoot)}"`,
      `git clone --progress --depth 50 --branch "${escapeDoubleQuotedShell(
        repo.branch
      )}" --single-branch "${escapeDoubleQuotedShell(repo.repoUrl)}" "${escapeDoubleQuotedShell(repo.mountPath)}"`,
      `cd "${escapeDoubleQuotedShell(repo.mountPath)}"`
    );

    if (!repo.revision) {
      continue;
    }

    lines.push(
      `if ! git rev-parse --verify --quiet "${escapeDoubleQuotedShell(repo.revision)}^{commit}" >/dev/null; then`,
      `  git fetch --unshallow origin "${escapeDoubleQuotedShell(
        repo.branch
      )}" || git fetch origin "${escapeDoubleQuotedShell(repo.branch)}"`,
      'fi'
    );
    lines.push(`git checkout "${escapeDoubleQuotedShell(repo.revision)}"`);
  }

  if (installCommand) {
    lines.push('', `cd "${escapeDoubleQuotedShell(primaryRepo.mountPath)}"`, installCommand);
  }

  return lines.join('\n') + '\n';
}
