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
import { getLogger } from 'server/lib/logger';
import { getIdentityFromClaims, type RequestUserIdentity } from 'server/lib/get-user';
import { getMcpResourceMetadataUrl, getMcpResourceUrl, isAuthEnabled, MCP_SCOPE } from './config';

export interface McpAuthSuccess {
  ok: true;
  identity: RequestUserIdentity;
  payload: JWTPayload | null;
}

export interface McpAuthFailure {
  ok: false;
  status: number;
  message: string;
  wwwAuthenticate: string;
}

export type McpAuthResult = McpAuthSuccess | McpAuthFailure;

let cachedJwks: { url: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function getJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  if (!cachedJwks || cachedJwks.url !== jwksUrl) {
    cachedJwks = { url: jwksUrl, jwks: createRemoteJWKSet(new URL(jwksUrl)) };
  }

  return cachedJwks.jwks;
}

/** RFC 9728 §5.1 challenge pointing clients at the protected-resource metadata. */
export function buildWwwAuthenticate(errorCode?: string, description?: string): string {
  const parts = [`resource_metadata="${getMcpResourceMetadataUrl()}"`, `scope="${MCP_SCOPE}"`];
  if (errorCode) {
    parts.unshift(`error="${errorCode}"`);
  }
  if (description) {
    parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  }

  return `Bearer ${parts.join(', ')}`;
}

function failure(status: number, message: string, errorCode?: string): McpAuthFailure {
  return { ok: false, status, message, wwwAuthenticate: buildWwwAuthenticate(errorCode, message) };
}

/**
 * Authenticate an MCP request. Tokens must be audience-bound to the canonical MCP
 * resource URL (never the REST API's client-id audience) per MCP authorization spec.
 */
export async function authenticateMcpRequest(req: IncomingMessage): Promise<McpAuthResult> {
  if (!isAuthEnabled()) {
    const identity = getIdentityFromClaims(null);
    if (!identity) {
      return failure(401, 'Unable to resolve local development identity');
    }
    return { ok: true, identity, payload: null };
  }

  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    return failure(401, 'Missing bearer token');
  }

  const issuer = process.env.KEYCLOAK_ISSUER;
  const jwksUrl = process.env.KEYCLOAK_JWKS_URL;
  if (!issuer || !jwksUrl) {
    getLogger().error('MCP auth: missing KEYCLOAK_ISSUER or KEYCLOAK_JWKS_URL');
    return { ok: false, status: 500, message: 'Server configuration error', wwwAuthenticate: buildWwwAuthenticate() };
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(jwksUrl), {
      issuer,
      audience: getMcpResourceUrl(),
    });

    const identity = getIdentityFromClaims(payload);
    if (!identity) {
      return failure(401, 'Token has no subject', 'invalid_token');
    }

    return { ok: true, identity, payload };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'token verification failed';
    getLogger().warn({ error: message }, 'MCP auth: JWT verification failed');
    return failure(401, `Authentication failed: ${message}`, 'invalid_token');
  }
}
