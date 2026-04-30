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

const logger = () => getLogger();

export interface RequestGitHubUserToken {
  // GitHub handle from the authenticated request, or from the Keycloak access
  // token claims when the request identity has not been hydrated yet.
  githubUsername: string | null;
  // GitHub access token fetched through Keycloak's GitHub identity broker.
  // Treat this as sensitive: never log it or return it to the client.
  githubToken: string | null;
}

function normalizeClaim(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
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

export async function resolveRequestGitHubToken(req: NextRequest): Promise<string | null> {
  if (process.env.ENABLE_AUTH !== 'true') {
    try {
      return await GlobalConfigService.getInstance().getGithubClientToken();
    } catch (error) {
      logger().warn({ error }, 'GitHub: app token lookup failed auth=disabled');
      return null;
    }
  }

  const keycloakAccessToken = getBearerToken(req);
  if (!keycloakAccessToken) {
    return null;
  }

  try {
    return await fetchGitHubBrokerToken(keycloakAccessToken);
  } catch (error) {
    logger().warn({ error }, 'GitHub: broker token failed reason=unexpected_error');
    return null;
  }
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
 * - It does not verify the token against GitHub. Call the GitHub endpoint you
 *   need from the server if you want to prove the token is usable.
 * - It does not expose the token to the browser. Keep the token server-side.
 */
export async function resolveRequestGitHubUserToken(req: NextRequest): Promise<RequestGitHubUserToken> {
  const keycloakAccessToken = getBearerToken(req);
  const userIdentity = getRequestUserIdentity(req);
  const githubUsername = userIdentity?.githubUsername || getGitHubUsernameFromKeycloakAccessToken(keycloakAccessToken);

  return {
    githubUsername,
    githubToken: await resolveRequestGitHubToken(req),
  };
}
