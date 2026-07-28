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

import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticateMcpRequest, type McpAuthFailure, type McpAuthSuccess } from '../auth';

const RESOURCE_URL = 'http://localhost:3000/mcp';
const ISSUER = 'http://localhost/realms/lifecycle-test';

let jwksServer: Server;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let originalEnv: NodeJS.ProcessEnv;

function fakeRequest(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as IncomingMessage;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-123',
    github_username: 'octocat',
    preferred_username: 'octocat',
    scope: 'openid mcp',
    realm_access: { roles: ['user'] },
    ...overrides,
  };
}

async function signToken(
  tokenClaims: Record<string, unknown>,
  options: {
    issuer?: string;
    audience?: string;
    expires?: boolean;
    signingKey?: CryptoKey;
    algorithm?: 'RS256' | 'ES256';
  } = {}
): Promise<string> {
  let token = new SignJWT(tokenClaims)
    .setProtectedHeader({ alg: options.algorithm ?? 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? RESOURCE_URL)
    .setIssuedAt();
  if (options.expires !== false) token = token.setExpirationTime('5m');
  return token.sign(options.signingKey ?? privateKey);
}

beforeAll(async () => {
  originalEnv = { ...process.env };
  const generated = await generateKeyPair('RS256');
  privateKey = generated.privateKey;
  const jwk = { ...(await exportJWK(generated.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const { port } = jwksServer.address() as AddressInfo;

  process.env.ENABLE_AUTH = 'true';
  process.env.KEYCLOAK_ISSUER = ISSUER;
  process.env.KEYCLOAK_JWKS_URL = `http://127.0.0.1:${port}/certs`;
  process.env.APP_HOST = 'http://localhost:3000';
});

afterEach(() => {
  process.env.ENABLE_AUTH = 'true';
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  process.env = originalEnv;
});

describe('authenticateMcpRequest', () => {
  it('requires an OAuth bearer token and advertises protected-resource metadata', async () => {
    const result = (await authenticateMcpRequest(fakeRequest())) as McpAuthFailure;
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        status: 401,
        message: 'Missing bearer token.',
      })
    );
    expect(result.wwwAuthenticate).toContain('scope="mcp"');
    expect(result.wwwAuthenticate).toContain('/.well-known/oauth-protected-resource/mcp');
  });

  it('builds the normal Lifecycle OAuth user principal', async () => {
    const token = await signToken(claims());
    const result = (await authenticateMcpRequest(fakeRequest(`Bearer ${token}`))) as McpAuthSuccess;
    expect(result.ok).toBe(true);
    expect(result.principal).toEqual(
      expect.objectContaining({
        kind: 'user',
        authMethod: 'oauth',
        userId: 'user-123',
        roles: ['user'],
        scopes: null,
        tokenId: null,
      })
    );
    expect(result.principal.identity?.githubUsername).toBe('octocat');
  });

  it.each([
    ['wrong issuer', { issuer: `${ISSUER}-other` }],
    ['wrong audience', { audience: `${RESOURCE_URL}/other` }],
  ])('rejects a token with %s', async (_label, options) => {
    const token = await signToken(claims(), options);
    const result = (await authenticateMcpRequest(fakeRequest(`Bearer ${token}`))) as McpAuthFailure;
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 401 }));
    expect(result.wwwAuthenticate).toContain('error="invalid_token"');
  });

  it('rejects a signature from an untrusted key', async () => {
    const other = await generateKeyPair('RS256');
    const token = await signToken(claims(), { signingKey: other.privateKey });
    const result = (await authenticateMcpRequest(fakeRequest(`Bearer ${token}`))) as McpAuthFailure;
    expect(result.status).toBe(401);
  });

  it('accepts RS256 only', async () => {
    const ec = await generateKeyPair('ES256');
    const token = await signToken(claims(), {
      signingKey: ec.privateKey,
      algorithm: 'ES256',
    });
    const result = (await authenticateMcpRequest(fakeRequest(`Bearer ${token}`))) as McpAuthFailure;
    expect(result.status).toBe(401);
  });

  it.each([
    ['finite expiry', claims(), { expires: false }],
    ['stable subject', claims({ sub: undefined }), {}],
    ['realm roles', claims({ realm_access: undefined }), {}],
    ['base role', claims({ realm_access: { roles: ['viewer'] } }), {}],
  ])('rejects a token without the required %s', async (_label, tokenClaims, options) => {
    const token = await signToken(tokenClaims, options);
    const result = (await authenticateMcpRequest(fakeRequest(`Bearer ${token}`))) as McpAuthFailure;
    expect(result.ok).toBe(false);
    expect([401, 403]).toContain(result.status);
  });

  it('returns the exact insufficient-scope contract', async () => {
    const token = await signToken(claims({ scope: 'openid profile' }));
    const result = (await authenticateMcpRequest(fakeRequest(`Bearer ${token}`))) as McpAuthFailure;

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        status: 403,
        message: 'Bearer token is missing the required mcp scope.',
      })
    );
    expect(result.wwwAuthenticate).toContain('error="insufficient_scope"');
    expect(result.wwwAuthenticate).toContain('scope="mcp"');
    expect(result.wwwAuthenticate).toContain('resource_metadata=');
  });

  it('does not provide a local-session fallback when authentication is disabled', async () => {
    process.env.ENABLE_AUTH = 'false';
    const result = (await authenticateMcpRequest(fakeRequest('Bearer anything'))) as McpAuthFailure;
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 503 }));
  });

  it('treats API-key-shaped bearer values as invalid OAuth credentials', async () => {
    const result = (await authenticateMcpRequest(fakeRequest(`Bearer lfc_${'a'.repeat(64)}`))) as McpAuthFailure;
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 401 }));
    expect(result.wwwAuthenticate).toContain('error="invalid_token"');
  });
});
