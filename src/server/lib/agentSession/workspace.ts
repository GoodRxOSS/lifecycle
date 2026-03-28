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

import { posix as pathPosix } from 'path';

export const AGENT_WORKSPACE_ROOT = '/workspace';
export const AGENT_WORKSPACE_SUBPATH = 'repo';
export const AGENT_EDITOR_WORKSPACE_FILE = '/tmp/agent-session.code-workspace';
const AGENT_ADDITIONAL_REPOS_ROOT = `${AGENT_WORKSPACE_ROOT}/repos`;

export interface AgentSessionWorkspaceRepo {
  repo: string;
  repoUrl: string;
  branch: string;
  revision?: string | null;
  mountPath: string;
  primary?: boolean;
}

export interface AgentSessionSelectedService {
  name: string;
  deployId: number;
  repo: string;
  branch: string;
  revision?: string | null;
  resourceName?: string | null;
  workspacePath: string;
  workDir?: string | null;
}

function splitRepoFullName(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repository full name: ${repo}`);
  }

  return { owner, name };
}

export function repoNameFromRepoUrl(repoUrl?: string | null): string | null {
  if (!repoUrl) {
    return null;
  }

  const normalized = repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  return normalized || null;
}

export function buildAgentWorkspaceRepoMountPath(repo: string, primary = false): string {
  if (primary) {
    return AGENT_WORKSPACE_ROOT;
  }

  const { owner, name } = splitRepoFullName(repo);
  return pathPosix.join(AGENT_ADDITIONAL_REPOS_ROOT, owner, name);
}

export function normalizeAgentWorkspaceRepo(
  repo: Pick<AgentSessionWorkspaceRepo, 'repo' | 'repoUrl' | 'branch' | 'revision'>,
  primary = false
): AgentSessionWorkspaceRepo {
  return {
    repo: repo.repo,
    repoUrl: repo.repoUrl,
    branch: repo.branch,
    revision: repo.revision || null,
    mountPath: buildAgentWorkspaceRepoMountPath(repo.repo, primary),
    primary,
  };
}

export function rewriteWorkspacePathForRepo(value: string, repoRoot: string): string {
  if (!value.trim()) {
    return value;
  }

  if (value === AGENT_WORKSPACE_ROOT) {
    return repoRoot;
  }

  if (value.startsWith(`${AGENT_WORKSPACE_ROOT}/`)) {
    return `${repoRoot}${value.slice(AGENT_WORKSPACE_ROOT.length)}`;
  }

  if (value.startsWith('/')) {
    return value;
  }

  return pathPosix.join(repoRoot, value);
}

export function rewriteWorkspaceScriptForRepo(value: string, repoRoot: string): string {
  if (!value.trim() || repoRoot === AGENT_WORKSPACE_ROOT) {
    return value;
  }

  return value.split(AGENT_WORKSPACE_ROOT).join(repoRoot);
}

export function buildAgentEditorWorkspaceContents(workspaceRepos: AgentSessionWorkspaceRepo[]): string {
  return JSON.stringify(
    {
      folders: workspaceRepos.map((repo) => ({
        name: repo.repo,
        path: repo.mountPath,
      })),
    },
    null,
    2
  );
}
