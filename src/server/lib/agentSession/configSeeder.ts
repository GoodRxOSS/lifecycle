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

export interface InitScriptOpts {
  repoUrl: string;
  branch: string;
  revision?: string;
  workspacePath: string;
  installCommand?: string;
  claudeMdContent?: string;
  claudePermissions?: {
    allow: string[];
    deny: string[];
  };
  claudeCommitAttribution?: string;
  claudePrAttribution?: string;
  gitUserName?: string;
  gitUserEmail?: string;
  githubUsername?: string;
  useGitHubToken?: boolean;
}

function escapeDoubleQuotedShell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

export function generateInitScript(opts: InitScriptOpts): string {
  const {
    repoUrl,
    branch,
    revision,
    workspacePath,
    installCommand,
    claudeMdContent,
    claudePermissions,
    claudeCommitAttribution,
    claudePrAttribution,
    gitUserName,
    gitUserEmail,
    githubUsername,
    useGitHubToken,
  } = opts;

  const settings = {
    permissions: {
      allow: claudePermissions?.allow || ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)'],
      deny: claudePermissions?.deny || [],
    },
    ...(claudeCommitAttribution !== undefined || claudePrAttribution !== undefined
      ? {
          attribution: {
            commit: claudeCommitAttribution || '',
            pr: claudePrAttribution || '',
          },
        }
      : {}),
  };

  const settingsJson = JSON.stringify(settings, null, 2);

  const lines = [
    '#!/bin/sh',
    'set -e',
    '',
    `mkdir -p "${escapeDoubleQuotedShell(workspacePath)}"`,
    `git config --global --add safe.directory "${escapeDoubleQuotedShell(workspacePath)}"`,
  ];

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

  lines.push(
    `git clone --branch "${escapeDoubleQuotedShell(branch)}" --single-branch "${escapeDoubleQuotedShell(
      repoUrl
    )}" "${escapeDoubleQuotedShell(workspacePath)}"`,
    `cd "${escapeDoubleQuotedShell(workspacePath)}"`
  );

  if (revision) {
    lines.push(`git checkout "${escapeDoubleQuotedShell(revision)}"`);
  }

  if (installCommand) {
    lines.push('', installCommand);
  }

  lines.push('', 'mkdir -p ~/.claude', '');

  if (claudeMdContent) {
    lines.push(`cat > ~/.claude/CLAUDE.md << 'CLAUDE_MD_EOF'`);
    lines.push(claudeMdContent);
    lines.push('CLAUDE_MD_EOF');
    lines.push('');
  }

  lines.push(`cat > ~/.claude/settings.json << 'SETTINGS_EOF'`);
  lines.push(settingsJson);
  lines.push('SETTINGS_EOF');
  lines.push('');

  lines.push(
    'mkdir -p .git/hooks',
    `cat > .git/hooks/pre-push << 'HOOK_EOF'`,
    '#!/bin/sh',
    'remote="$1"',
    'while read local_ref local_sha remote_ref remote_sha; do',
    `  branch_name="\${remote_ref##refs/heads/}"`,
    `  if [ "$branch_name" = "main" ] || [ "$branch_name" = "master" ]; then`,
    '    echo "ERROR: Pushing to $branch_name is not allowed"',
    '    exit 1',
    '  fi',
    'done',
    'exit 0',
    'HOOK_EOF',
    'chmod +x .git/hooks/pre-push'
  );

  return lines.join('\n') + '\n';
}
