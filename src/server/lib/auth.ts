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

import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose';

interface AuthResult {
  success: boolean;
  payload?: JWTPayload;
  error?: {
    message: string;
    status: number;
  };
}

type HeadersLike = {
  get(name: string): string | null | undefined;
};

type RequestWithHeaders = {
  headers?: HeadersLike | null;
};

type JwtVerificationErrorSummary = {
  name: string;
  message: string;
  code?: unknown;
  claim?: unknown;
  reason?: unknown;
};

type RemoteJwksUrl = Parameters<typeof createRemoteJWKSet>[0];
type UrlConstructor = new (input: string, base?: string) => unknown;

function getAuthorizationHeader(request: RequestWithHeaders): string | null {
  const headers = request.headers;
  if (!headers || typeof headers.get !== 'function') {
    return null;
  }

  return headers.get('Authorization') || headers.get('authorization') || null;
}

function buildJwksUrl(input: string): RemoteJwksUrl {
  const urlCtor = (globalThis as unknown as { URL?: UrlConstructor }).URL;
  if (typeof urlCtor !== 'function') {
    throw new Error('URL constructor is not available');
  }

  return new urlCtor(input) as RemoteJwksUrl;
}

function summarizeJwtVerificationError(error: unknown): JwtVerificationErrorSummary {
  const maybeError = error as Partial<JwtVerificationErrorSummary> | null | undefined;
  const summary: JwtVerificationErrorSummary = {
    name: error instanceof Error ? error.name : typeof maybeError?.name === 'string' ? maybeError.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };

  if (maybeError?.code !== undefined) {
    summary.code = maybeError.code;
  }
  if (maybeError?.claim !== undefined) {
    summary.claim = maybeError.claim;
  }
  if (maybeError?.reason !== undefined) {
    summary.reason = maybeError.reason;
  }

  return summary;
}

export async function verifyBearerToken(token: string | null | undefined): Promise<AuthResult> {
  if (!token) {
    return {
      success: false,
      error: { message: 'Bearer token is missing or malformed', status: 401 },
    };
  }

  const issuer = process.env.KEYCLOAK_ISSUER;
  const audience = process.env.KEYCLOAK_CLIENT_ID;
  const jwksUrl = process.env.KEYCLOAK_JWKS_URL;

  if (!issuer || !audience || !jwksUrl) {
    console.error('Auth: missing Keycloak environment variables');
    return {
      success: false,
      error: { message: 'Server configuration error', status: 500 },
    };
  }

  try {
    const JWKS = createRemoteJWKSet(buildJwksUrl(jwksUrl));

    const { payload } = await jwtVerify(token, JWKS, {
      issuer,
      audience,
    });

    return { success: true, payload };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    console.warn('Auth: JWT verification failed', summarizeJwtVerificationError(error));

    return {
      success: false,
      error: { message: `Authentication failed: ${errorMessage}`, status: 401 },
    };
  }
}

export async function verifyAuth(request: RequestWithHeaders): Promise<AuthResult> {
  const authHeader = getAuthorizationHeader(request);

  if (!authHeader) {
    return {
      success: false,
      error: { message: 'Authorization header is missing', status: 401 },
    };
  }

  const token = authHeader.split(' ')[1];
  return verifyBearerToken(token);
}
