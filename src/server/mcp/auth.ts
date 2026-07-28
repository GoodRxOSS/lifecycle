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

import type { IncomingMessage } from 'http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AppError, isAppError } from 'server/lib/appError';
import { getIdentityFromClaims } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import type { Principal } from 'server/lib/principal';
import { getMcpResourceMetadataUrl, getMcpResourceUrl, isAuthEnabled, MCP_SCOPE } from './config';

export interface McpAuthSuccess {
  ok: true;
  principal: Principal;
}

export interface McpAuthFailure {
  ok: false;
  status: number;
  message: string;
  wwwAuthenticate?: string;
  retryAfterSeconds?: number;
}

export type McpAuthResult = McpAuthSuccess | McpAuthFailure;

let cachedJwks: { url: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function getJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  if (!cachedJwks || cachedJwks.url !== jwksUrl) {
    cachedJwks = { url: jwksUrl, jwks: createRemoteJWKSet(new URL(jwksUrl)) };
  }
  return cachedJwks.jwks;
}

/** RFC 9728 §5.1 challenge pointing clients at protected-resource metadata. */
function buildWwwAuthenticate(errorCode?: string, scopes: readonly string[] = [MCP_SCOPE]): string {
  const parts: string[] = [];
  if (errorCode) parts.push(`error="${errorCode}"`);
  parts.push(`scope="${scopes.join(' ')}"`);
  try {
    parts.push(`resource_metadata="${getMcpResourceMetadataUrl()}"`);
  } catch {
    // A malformed installation URL must not turn the challenge into a throw.
  }
  return `Bearer ${parts.join(', ')}`;
}

function failure(
  status: number,
  message: string,
  options: {
    challengeError?: string;
    challengeScopes?: readonly string[];
    retryAfterSeconds?: number;
    includeChallenge?: boolean;
  } = {}
): McpAuthFailure {
  return {
    ok: false,
    status,
    message,
    ...(options.includeChallenge === false
      ? {}
      : { wwwAuthenticate: buildWwwAuthenticate(options.challengeError, options.challengeScopes) }),
    ...(options.retryAfterSeconds ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
  };
}

async function verifyOAuthToken(token: string): Promise<JWTPayload> {
  const issuer = process.env.KEYCLOAK_ISSUER?.trim();
  const jwksUrl = process.env.KEYCLOAK_JWKS_URL?.trim();
  if (!issuer || !jwksUrl) {
    throw new AppError({
      httpStatus: 503,
      code: 'authentication_unavailable',
      message: 'OAuth verification is not configured.',
    });
  }

  const { payload } = await jwtVerify(token, getJwks(jwksUrl), {
    issuer,
    audience: getMcpResourceUrl(),
    algorithms: ['RS256'],
    clockTolerance: 30,
  });
  return payload;
}

function bearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const match = typeof header === 'string' ? header.match(/^bearer\s+(.+)$/i) : null;
  return match?.[1].trim() || null;
}

function hasMcpScope(payload: JWTPayload): boolean {
  return typeof payload.scope === 'string' && payload.scope.split(/\s+/).filter(Boolean).includes(MCP_SCOPE);
}

function realmRoles(payload: JWTPayload): string[] | null {
  const realmAccess = (payload as Record<string, unknown>).realm_access;
  if (!realmAccess || typeof realmAccess !== 'object') return null;
  const roles = (realmAccess as Record<string, unknown>).roles;
  return Array.isArray(roles) && roles.every((role) => typeof role === 'string') ? roles : null;
}

function oauthPrincipal(payload: JWTPayload, roles: Array<'user' | 'admin'>): Principal | null {
  const identity = getIdentityFromClaims(payload);
  if (!identity) return null;
  return {
    kind: 'user',
    authMethod: 'oauth',
    userId: identity.userId,
    actor: identity.userId,
    roles,
    scopes: null,
    tokenId: null,
    repositoryAllowlist: null,
    repositoryAllowlistRepoIds: null,
    identity: { ...identity, roles },
  };
}

/**
 * Authenticate one stateless MCP request. Lifecycle MCP intentionally accepts
 * OAuth bearer tokens only; API keys remain available to their existing REST
 * consumers and never enter this path.
 */
export async function authenticateMcpRequest(req: IncomingMessage): Promise<McpAuthResult> {
  if (!isAuthEnabled()) {
    return failure(503, 'OAuth verification is not configured.', {
      retryAfterSeconds: 30,
      includeChallenge: false,
    });
  }

  const token = bearerToken(req);
  if (!token) {
    return failure(401, 'Missing bearer token.');
  }

  try {
    const payload = await verifyOAuthToken(token);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || !Number.isInteger(payload.exp)) {
      throw new AppError({
        httpStatus: 401,
        code: 'invalid_credential',
        message: 'Bearer token has no finite expiry.',
      });
    }
    if (
      (payload.iat !== undefined && (!Number.isInteger(payload.iat) || Number(payload.iat) > now + 30)) ||
      (payload.nbf !== undefined && !Number.isInteger(payload.nbf))
    ) {
      throw new AppError({
        httpStatus: 401,
        code: 'invalid_credential',
        message: 'Bearer token has invalid time claims.',
      });
    }
    if (!hasMcpScope(payload)) {
      throw new AppError({
        httpStatus: 403,
        code: 'insufficient_scope',
        message: 'Bearer token is missing the required mcp scope.',
      });
    }

    const roles = realmRoles(payload);
    if (!roles) {
      throw new AppError({
        httpStatus: 401,
        code: 'invalid_credential',
        message: 'Bearer token has no realm roles claim.',
      });
    }
    const lifecycleRoles = roles.filter((role): role is 'user' | 'admin' => role === 'user' || role === 'admin');
    if (lifecycleRoles.length === 0) {
      throw new AppError({
        httpStatus: 403,
        code: 'forbidden_role',
        message: 'Lifecycle MCP requires the user or admin role.',
      });
    }

    const principal = oauthPrincipal(payload, lifecycleRoles);
    if (!principal || !principal.identity) {
      throw new AppError({
        httpStatus: 401,
        code: 'invalid_credential',
        message: 'Bearer token has no valid subject.',
      });
    }
    return { ok: true, principal };
  } catch (error) {
    if (isAppError(error) && error.code === 'insufficient_scope') {
      return failure(403, 'Bearer token is missing the required mcp scope.', {
        challengeError: 'insufficient_scope',
        challengeScopes: [MCP_SCOPE],
      });
    }
    if (isAppError(error) && error.code === 'forbidden_role') {
      return failure(403, 'Lifecycle MCP requires the user or admin role.', {
        includeChallenge: false,
      });
    }
    if (isAppError(error) && error.httpStatus === 503) {
      getLogger().error({ error }, 'MCP auth: OAuth verification unavailable');
      return failure(503, 'OAuth verification is temporarily unavailable.', {
        retryAfterSeconds: 30,
        includeChallenge: false,
      });
    }

    getLogger().warn(
      { error: error instanceof Error ? error.name : 'unknown' },
      'MCP auth: OAuth bearer verification failed'
    );
    return failure(401, 'Invalid or expired bearer token.', {
      challengeError: 'invalid_token',
    });
  }
}
