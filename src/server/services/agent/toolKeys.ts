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

export const SESSION_WORKSPACE_SERVER_SLUG = 'sandbox';
export const SESSION_WORKSPACE_SERVER_NAME = 'Session Workspace';
export const SESSION_WORKSPACE_READONLY_TOOL_NAME = 'workspace.exec';
export const SESSION_WORKSPACE_MUTATION_TOOL_NAME = 'workspace.exec_mutation';
export const LIFECYCLE_BUILTIN_SERVER_SLUG = 'lifecycle';
export const LIFECYCLE_BUILTIN_SERVER_NAME = 'Lifecycle';
export const CHAT_PUBLISH_HTTP_TOOL_NAME = 'publish_http';

export function buildAgentToolKey(serverSlug: string, toolName: string): string {
  return `mcp__${serverSlug}__${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function buildWorkspaceReadonlyExecDescription(serverName: string): string {
  return (
    `Run a read-only workspace inspection command through ${serverName}. ` +
    'Use this for safe file, git, and directory inspection only. ' +
    'Do not chain commands with &&, ||, or ;. Run separate inspection commands instead. ' +
    'Examples: git remote -v, git status --short --branch, ls -la, find . -name "*.ts", rg pattern src.'
  );
}

export function buildWorkspaceMutationExecDescription(serverName: string): string {
  return (
    `Run a mutating or networked workspace command through ${serverName}. ` +
    'Use this for installs, starting processes, GitHub CLI operations, git pushes, local git commits, and other state-changing operations that are not direct file-content edits. ' +
    'When creating or changing file contents, use workspace.write_file or workspace.edit_file so the file changes can be reviewed. ' +
    'This path is intended for commands that require approval.'
  );
}
