/**
 * Copyright 2026 GoodRx, Inc.
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

import { getUnsafeWorkspaceMutationReason, isReadOnlyWorkspaceCommand } from '../sandboxExecSafety';

describe('isReadOnlyWorkspaceCommand', () => {
  it('allows simple read-only git inspection commands', () => {
    expect(isReadOnlyWorkspaceCommand('git remote -v')).toBe(true);
    expect(isReadOnlyWorkspaceCommand('git status --short --branch')).toBe(true);
    expect(isReadOnlyWorkspaceCommand('git diff --stat')).toBe(true);
  });

  it('allows piped read-only inspection commands', () => {
    expect(isReadOnlyWorkspaceCommand('find /workspace -type f 2>/dev/null | head -20')).toBe(true);
    expect(isReadOnlyWorkspaceCommand('rg lifecycle src | head -5')).toBe(true);
  });

  it('rejects mutating git and package manager commands', () => {
    expect(isReadOnlyWorkspaceCommand('git push -u origin feature-branch')).toBe(false);
    expect(isReadOnlyWorkspaceCommand('pnpm install')).toBe(false);
    expect(isReadOnlyWorkspaceCommand('npm run dev')).toBe(false);
  });

  it('rejects shell chaining and subshell evaluation', () => {
    expect(isReadOnlyWorkspaceCommand('git status && git diff')).toBe(false);
    expect(isReadOnlyWorkspaceCommand('git status; git diff')).toBe(false);
    expect(isReadOnlyWorkspaceCommand('git status $(whoami)')).toBe(false);
  });

  it('rejects output redirection except dev-null inspection noise', () => {
    expect(isReadOnlyWorkspaceCommand('cat package.json > package-copy.json')).toBe(false);
    expect(isReadOnlyWorkspaceCommand('find /workspace -type f 2>/dev/null | head -20')).toBe(true);
  });
});

describe('getUnsafeWorkspaceMutationReason', () => {
  it('rejects broad node kill commands that can terminate the workspace gateway', () => {
    expect(getUnsafeWorkspaceMutationReason('kill -9 $(pidof node)')).toContain('workspace gateway');
    expect(getUnsafeWorkspaceMutationReason('pkill -f node')).toContain('workspace gateway');
    expect(getUnsafeWorkspaceMutationReason("ps aux | grep node | awk '{print $2}' | xargs kill -9")).toContain(
      'workspace gateway'
    );
  });

  it('allows targeted process management commands', () => {
    expect(getUnsafeWorkspaceMutationReason('kill 4242')).toBeNull();
    expect(getUnsafeWorkspaceMutationReason('lsof -ti tcp:3000 | xargs kill -9')).toBeNull();
  });
});

describe('workspace mutation command safety', () => {
  it('allows GitHub CLI commands and git pushes through the approved mutation tool', () => {
    expect(getUnsafeWorkspaceMutationReason('gh repo create sample --private')).toBeNull();
    expect(getUnsafeWorkspaceMutationReason('git push -u origin main')).toBeNull();
  });
});
