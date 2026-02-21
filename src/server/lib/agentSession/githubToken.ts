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
import { getLogger } from 'server/lib/logger';
import GlobalConfigService from 'server/services/globalConfig';

const logger = getLogger();

function getBearerToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  return token || null;
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
    logger.warn(
      'GitHub broker token lookup skipped because neither KEYCLOAK_ISSUER_INTERNAL nor KEYCLOAK_ISSUER is configured'
    );
    return null;
  }

  const response = await fetch(`${issuer}/broker/github/token`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${keycloakAccessToken}`,
    },
  });

  if (!response.ok) {
    logger.warn(
      {
        status: response.status,
      },
      'GitHub broker token lookup failed'
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
      logger.warn({ error }, 'GitHub app token lookup failed while auth is disabled');
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
    logger.warn({ error }, 'GitHub broker token lookup threw unexpectedly');
    return null;
  }
}
