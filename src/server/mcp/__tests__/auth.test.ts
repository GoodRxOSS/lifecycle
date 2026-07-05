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

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { IncomingMessage } from 'http';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { authenticateMcpRequest, buildWwwAuthenticate, type McpAuthFailure, type McpAuthSuccess } from '../auth';

const RESOURCE_URL = 'http://localhost:3000/mcp';
const ISSUER = 'http://localhost/realms/lifecycle-test';

let jwksServer: Server;
let privateKey: KeyLike;
let originalEnv: NodeJS.ProcessEnv;

function fakeRequest(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as IncomingMessage;
}

async function signToken(claims: Record<string, unknown>, options: { audience?: string; issuer?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? RESOURCE_URL)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

beforeAll(async () => {
  originalEnv = { ...process.env };

  const { publicKey, privateKey: generatedPrivateKey } = await generateKeyPair('RS256');
  privateKey = generatedPrivateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const { port } = jwksServer.address() as AddressInfo;

  process.env.ENABLE_AUTH = 'true';
  process.env.KEYCLOAK_ISSUER = ISSUER;
  process.env.KEYCLOAK_JWKS_URL = `http://127.0.0.1:${port}/certs`;
  process.env.MCP_RESOURCE_URL = RESOURCE_URL;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  process.env = originalEnv;
});

describe('authenticateMcpRequest', () => {
  it('rejects requests without a bearer token with an RFC 9728 challenge', async () => {
    const result = (await authenticateMcpRequest(fakeRequest())) as McpAuthFailure;

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.wwwAuthenticate).toContain('resource_metadata=');
    expect(result.wwwAuthenticate).toContain('/.well-known/oauth-protected-resource/mcp');
    expect(result.wwwAuthenticate).toContain('scope="mcp offline_access"');
  });

  it('accepts a token audience-bound to the MCP resource URL and maps identity claims', async () => {
    const token = await signToken({
      sub: 'user-123',
      email: 'dev@example.com',
      preferred_username: 'dev',
      github_username: 'dev-gh',
      realm_access: { roles: ['user', 'offline_access'] },
    });

    const result = (await authenticateMcpRequest(fakeRequest(`Bearer ${token}`))) as McpAuthSuccess;

    expect(result.ok).toBe(true);
    expect(result.identity.userId).toBe('user-123');
    expect(result.identity.githubUsername).toBe('dev-gh');
    expect(result.identity.roles).toEqual(['user']);
  });

  it('rejects tokens with the REST API audience (audience isolation)', async () => {
    const token = await signToken({ sub: 'user-123' }, { audience: 'lifecycle-core' });

    const result = (await authenticateMcpRequest(fakeRequest(`Bearer ${token}`))) as McpAuthFailure;

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.wwwAuthenticate).toContain('error="invalid_token"');
  });

  it('rejects tokens from a different issuer', async () => {
    const token = await signToken({ sub: 'user-123' }, { issuer: 'http://evil.example.com/realms/other' });

    const result = (await authenticateMcpRequest(fakeRequest(`Bearer ${token}`))) as McpAuthFailure;

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('rejects expired tokens', async () => {
    const token = await new SignJWT({ sub: 'user-123' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE_URL)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(privateKey);

    const result = (await authenticateMcpRequest(fakeRequest(`Bearer ${token}`))) as McpAuthFailure;

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('returns the local development identity when auth is disabled', async () => {
    process.env.ENABLE_AUTH = 'false';
    try {
      const result = (await authenticateMcpRequest(fakeRequest())) as McpAuthSuccess;

      expect(result.ok).toBe(true);
      expect(result.identity.userId).toBeTruthy();
      expect(result.identity.roles).toContain('admin');
    } finally {
      process.env.ENABLE_AUTH = 'true';
    }
  });
});

describe('buildWwwAuthenticate', () => {
  it('includes error code and sanitized description when provided', () => {
    const header = buildWwwAuthenticate('invalid_token', 'token "expired"');

    expect(header.startsWith('Bearer ')).toBe(true);
    expect(header).toContain('error="invalid_token"');
    expect(header).toContain(`error_description="token 'expired'"`);
  });
});
