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

import type { NextRequest } from 'next/server';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import GlobalConfigService from 'server/services/globalConfig';
import type { AgentRequestGitHubAuth } from 'server/services/agent/githubAuth';
import { normalizeAgentRequestGitHubAuth } from 'server/services/agent/githubAuth';

const logger = () => getLogger();

interface GitHubAuthenticatedUserResponse {
  id?: unknown;
  login?: unknown;
}

interface GitHubRepositoryResponse {
  full_name?: unknown;
  permissions?: unknown;
}

export interface RequestGitHubUserToken {
  // GitHub handle from the authenticated request, or from the Keycloak access
  // token claims when the request identity has not been hydrated yet.
  githubUsername: string | null;
  // GitHub access token fetched through Keycloak's GitHub identity broker.
  // Treat this as sensitive: never log it or return it to the client.
  githubToken: string | null;
}

export type RequestGitHubAuth = AgentRequestGitHubAuth;

export interface GitHubAuthenticatedUserProbe {
  ok: boolean;
  id: number | null;
  login: string | null;
  status: number;
  scopes: string[];
  rateLimitRemaining: string | null;
}

export type GitHubRepositoryWritePermission = 'granted' | 'denied' | 'unknown';

export interface GitHubRepositoryWritePermissionProbe {
  ok: boolean;
  repository: string;
  status: number;
  permission: GitHubRepositoryWritePermission;
  permissions: {
    admin: boolean;
    maintain: boolean;
    push: boolean;
  } | null;
  scopes: string[];
  rateLimitRemaining: string | null;
}

function normalizeClaim(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizeGitHubUserId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }

  return value;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeRepositoryPermissions(value: unknown): GitHubRepositoryWritePermissionProbe['permissions'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    admin: normalizeBoolean(record.admin),
    maintain: normalizeBoolean(record.maintain),
    push: normalizeBoolean(record.push),
  };
}

function resolveRepositoryWritePermission(
  status: number,
  permissions: GitHubRepositoryWritePermissionProbe['permissions']
): GitHubRepositoryWritePermission {
  if (status === 401 || status === 403 || status === 404) {
    return 'denied';
  }

  if (!permissions) {
    return 'unknown';
  }

  return permissions.admin || permissions.maintain || permissions.push ? 'granted' : 'denied';
}

function getBearerToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  return token || null;
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) {
    return null;
  }

  const [, payload] = token.split('.');
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, 'base64url' as BufferEncoding).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getGitHubUsernameFromKeycloakAccessToken(
  keycloakAccessToken: string | null | undefined
): string | null {
  const payload = decodeJwtPayload(keycloakAccessToken);
  return normalizeClaim(payload?.github_username) || normalizeClaim(payload?.githubUsername);
}

function parseBrokerTokenResponse(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const jsonToken =
      (typeof parsed.access_token === 'string' && parsed.access_token) ||
      (typeof parsed.token === 'string' && parsed.token);
    if (jsonToken) {
      return jsonToken;
    }
  } catch {
    // ignore and fall through to query-string parsing
  }

  const params = new URLSearchParams(trimmed);
  return params.get('access_token') || params.get('token');
}

export async function fetchGitHubBrokerToken(keycloakAccessToken: string): Promise<string | null> {
  const issuer = process.env.KEYCLOAK_ISSUER_INTERNAL?.trim() || process.env.KEYCLOAK_ISSUER?.trim();
  if (!issuer) {
    logger().warn('GitHub: broker token skipped reason=issuer_missing');
    return null;
  }

  const response = await fetch(`${issuer}/broker/github/token`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${keycloakAccessToken}`,
    },
  });

  if (!response.ok) {
    logger().warn(
      {
        status: response.status,
      },
      `GitHub: broker token failed status=${response.status}`
    );
    return null;
  }

  return parseBrokerTokenResponse(await response.text());
}

export async function resolveRequestGitHubAuth(req: NextRequest): Promise<RequestGitHubAuth> {
  const keycloakAccessToken = getBearerToken(req);
  const userIdentity = getRequestUserIdentity(req);
  const githubUsername = userIdentity?.githubUsername || getGitHubUsernameFromKeycloakAccessToken(keycloakAccessToken);

  if (process.env.ENABLE_AUTH !== 'true') {
    try {
      return normalizeAgentRequestGitHubAuth({
        githubToken: await GlobalConfigService.getInstance().getGithubClientToken(),
        source: 'app',
        githubUsername,
      });
    } catch (error) {
      logger().warn({ error }, 'GitHub: app token lookup failed auth=disabled');
      return normalizeAgentRequestGitHubAuth({ githubToken: null, source: 'none', githubUsername });
    }
  }

  if (!keycloakAccessToken) {
    return normalizeAgentRequestGitHubAuth({ githubToken: null, source: 'none', githubUsername });
  }

  try {
    return normalizeAgentRequestGitHubAuth({
      githubToken: await fetchGitHubBrokerToken(keycloakAccessToken),
      source: 'user',
      githubUsername,
    });
  } catch (error) {
    logger().warn({ error }, 'GitHub: broker token failed reason=unexpected_error');
    return normalizeAgentRequestGitHubAuth({ githubToken: null, source: 'none', githubUsername });
  }
}

export async function resolveRequestGitHubToken(req: NextRequest): Promise<string | null> {
  return (await resolveRequestGitHubAuth(req)).githubToken;
}

/**
 * Resolves the current request's GitHub identity and user token.
 *
 * Usage:
 * - Call this from server/API request handlers that need to make GitHub API
 *   calls as the signed-in user.
 * - Pass the same NextRequest that contains the user's Keycloak bearer token.
 * - Use the returned `githubToken` only on the server, then call GitHub with an
 *   `Authorization: Bearer <token>` header.
 *
 * What this does:
 * - Reads the user's GitHub handle from request identity when available.
 * - Falls back to the `github_username` / `githubUsername` claim in the
 *   Keycloak access token.
 * - Fetches the GitHub broker token through Keycloak via
 *   `resolveRequestGitHubToken`. With auth enabled, Keycloak owns the external
 *   token lookup/refresh flow.
 *
 * What this does not do:
 * - It does not verify the token against GitHub. Use
 *   `fetchGitHubAuthenticatedUser` when you need to prove the token is usable.
 * - It does not expose the token to the browser. Keep the token server-side.
 */
export async function resolveRequestGitHubUserToken(req: NextRequest): Promise<RequestGitHubUserToken> {
  const keycloakAccessToken = getBearerToken(req);
  const userIdentity = getRequestUserIdentity(req);
  const githubUsername = userIdentity?.githubUsername || getGitHubUsernameFromKeycloakAccessToken(keycloakAccessToken);

  return {
    githubUsername,
    githubToken: (await resolveRequestGitHubAuth(req)).githubToken,
  };
}

function splitHeaderValues(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function getResponseHeader(response: Response, name: string): string | null {
  const headers = (response as Response & { headers?: Headers }).headers;
  if (!headers || typeof headers.get !== 'function') {
    return null;
  }

  return headers.get(name);
}

export async function fetchGitHubAuthenticatedUser(githubToken: string): Promise<GitHubAuthenticatedUserProbe> {
  const response = await fetch('https://api.github.com/user', {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'User-Agent': 'lifecycle-github-token-check',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  const baseProbe = {
    status: response.status,
    scopes: splitHeaderValues(getResponseHeader(response, 'x-oauth-scopes')),
    rateLimitRemaining: getResponseHeader(response, 'x-ratelimit-remaining'),
  };

  if (!response.ok) {
    return {
      ...baseProbe,
      ok: false,
      id: null,
      login: null,
    };
  }

  let body: GitHubAuthenticatedUserResponse | null = null;
  try {
    body = (await response.json()) as GitHubAuthenticatedUserResponse;
  } catch {
    body = null;
  }

  return {
    ...baseProbe,
    ok: Boolean(normalizeGitHubUserId(body?.id)),
    id: normalizeGitHubUserId(body?.id),
    login: normalizeClaim(body?.login),
  };
}

export async function fetchGitHubRepositoryWritePermission(
  githubToken: string,
  owner: string,
  repo: string
): Promise<GitHubRepositoryWritePermissionProbe> {
  const repository = `${owner.trim()}/${repo.trim()}`;
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner.trim())}/${encodeURIComponent(repo.trim())}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${githubToken}`,
        'User-Agent': 'lifecycle-github-repository-permission-check',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  const baseProbe = {
    repository,
    status: response.status,
    scopes: splitHeaderValues(getResponseHeader(response, 'x-oauth-scopes')),
    rateLimitRemaining: getResponseHeader(response, 'x-ratelimit-remaining'),
  };

  if (!response.ok) {
    return {
      ...baseProbe,
      ok: false,
      permission: resolveRepositoryWritePermission(response.status, null),
      permissions: null,
    };
  }

  let body: GitHubRepositoryResponse | null = null;
  try {
    body = (await response.json()) as GitHubRepositoryResponse;
  } catch {
    body = null;
  }

  const permissions = normalizeRepositoryPermissions(body?.permissions);
  return {
    ...baseProbe,
    ok: true,
    permission: resolveRepositoryWritePermission(response.status, permissions),
    permissions,
  };
}
