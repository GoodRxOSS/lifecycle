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

export const GITHUB_USER_AUTH_REQUIRED_CODE = 'GITHUB_USER_AUTH_REQUIRED';
export const GITHUB_USER_AUTH_REQUIRED_MESSAGE =
  'GitHub authorization is required to approve this repair. Reconnect GitHub and approve again.';
export const GITHUB_USER_AUTH_REQUIRED_PERMISSION = 'repository_write';

export type AgentGitHubAuthSource = 'user' | 'app' | 'none';

export interface AgentRequestGitHubAuth {
  githubToken: string | null;
  source: AgentGitHubAuthSource;
  githubUsername?: string | null;
  writeAuthorized?: boolean;
}

export type AgentWriteAuthorizedGitHubAuth = AgentRequestGitHubAuth & {
  githubToken: string;
  source: 'user';
  writeAuthorized: true;
};

export function normalizeAgentRequestGitHubAuth(auth?: AgentRequestGitHubAuth | null): AgentRequestGitHubAuth {
  const githubToken = auth?.githubToken?.trim() || null;
  const source = githubToken ? auth?.source || 'user' : 'none';

  return {
    githubToken,
    source,
    githubUsername: auth?.githubUsername || null,
    writeAuthorized: source === 'user' && Boolean(githubToken) && auth?.writeAuthorized === true,
  };
}

export function hasWriteAuthorizedUserGitHubAuth(
  auth?: AgentRequestGitHubAuth | null
): auth is AgentWriteAuthorizedGitHubAuth {
  const normalized = normalizeAgentRequestGitHubAuth(auth);
  return normalized.source === 'user' && Boolean(normalized.githubToken) && normalized.writeAuthorized === true;
}

export function markGitHubAuthWriteAuthorized(auth: AgentRequestGitHubAuth): AgentRequestGitHubAuth {
  const normalized = normalizeAgentRequestGitHubAuth(auth);
  return {
    ...normalized,
    writeAuthorized: normalized.source === 'user' && Boolean(normalized.githubToken),
  };
}

export function buildAgentRequestGitHubAuthFromToken(
  githubToken: string | null | undefined,
  source: AgentGitHubAuthSource = 'user',
  options: {
    githubUsername?: string | null;
    writeAuthorized?: boolean;
  } = {}
): AgentRequestGitHubAuth {
  return normalizeAgentRequestGitHubAuth({
    githubToken: githubToken?.trim() || null,
    source: githubToken?.trim() ? source : 'none',
    githubUsername: options.githubUsername || null,
    writeAuthorized: options.writeAuthorized === true,
  });
}
