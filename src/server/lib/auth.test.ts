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

const mockCreateRemoteJWKSet = jest.fn();
const mockJwtVerify = jest.fn();

jest.mock('jose', () => ({
  createRemoteJWKSet: (...args: unknown[]) => mockCreateRemoteJWKSet(...args),
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}));

import { verifyAuth, verifyBearerToken } from './auth';

const originalIssuer = process.env.KEYCLOAK_ISSUER;
const originalAudience = process.env.KEYCLOAK_CLIENT_ID;
const originalJwksUrl = process.env.KEYCLOAK_JWKS_URL;

function restoreEnvValue(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.KEYCLOAK_ISSUER = 'http://localhost:8081/realms/lifecycle';
  process.env.KEYCLOAK_CLIENT_ID = 'lifecycle-core';
  process.env.KEYCLOAK_JWKS_URL = 'http://localhost:8081/realms/lifecycle/protocol/openid-connect/certs';
  mockCreateRemoteJWKSet.mockReturnValue('jwks');
});

afterAll(() => {
  restoreEnvValue('KEYCLOAK_ISSUER', originalIssuer);
  restoreEnvValue('KEYCLOAK_CLIENT_ID', originalAudience);
  restoreEnvValue('KEYCLOAK_JWKS_URL', originalJwksUrl);
});

describe('verifyBearerToken', () => {
  it('logs JWT verification failures without serializing token claims', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = Object.assign(new Error('"exp" claim timestamp check failed'), {
      code: 'ERR_JWT_EXPIRED',
      name: 'JWTExpired',
      claim: 'exp',
      reason: 'check_failed',
      payload: {
        email: 'sensitive@example.com',
        preferred_username: 'sensitive-user',
      },
    });
    mockJwtVerify.mockRejectedValue(error);

    const result = await verifyBearerToken('expired-token');

    expect(result).toEqual({
      success: false,
      error: {
        message: 'Authentication failed: "exp" claim timestamp check failed',
        status: 401,
      },
    });
    expect(warnSpy).toHaveBeenCalledWith('Auth: JWT verification failed', {
      name: 'JWTExpired',
      message: '"exp" claim timestamp check failed',
      code: 'ERR_JWT_EXPIRED',
      claim: 'exp',
      reason: 'check_failed',
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('sensitive@example.com');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('sensitive-user');

    warnSpy.mockRestore();
  });

  it('fails closed when required Keycloak configuration is missing', async () => {
    delete process.env.KEYCLOAK_CLIENT_ID;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await verifyBearerToken('some.jwt.token');

    expect(result).toEqual({
      success: false,
      error: { message: 'Server configuration error', status: 500 },
    });
    expect(errorSpy).toHaveBeenCalledWith('Auth: missing Keycloak environment variables');
    expect(mockCreateRemoteJWKSet).not.toHaveBeenCalled();
    expect(mockJwtVerify).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('fails safely when the runtime cannot construct the configured JWKS URL', async () => {
    process.env.KEYCLOAK_JWKS_URL = 'https://identity.example.test/unique-jwks';
    const originalUrl = globalThis.URL;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      (globalThis as { URL?: typeof URL }).URL = undefined;

      await expect(verifyBearerToken('some.jwt.token')).resolves.toEqual({
        success: false,
        error: { message: 'Authentication failed: URL constructor is not available', status: 401 },
      });
      expect(mockJwtVerify).not.toHaveBeenCalled();
    } finally {
      globalThis.URL = originalUrl;
      warnSpy.mockRestore();
    }
  });
});

describe('verifyAuth bearer extraction', () => {
  const requestWith = (authorization: string | null) => ({
    headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : null) },
  });

  it('extracts the token with a case-insensitive scheme', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'user-1' } });

    const result = await verifyAuth(requestWith('bearer some.jwt.token'));

    expect(result.success).toBe(true);
    expect(mockJwtVerify).toHaveBeenCalledWith('some.jwt.token', 'jwks', expect.anything());
  });

  it.each([
    ['trailing junk after the token', 'Bearer some.jwt.token extra'],
    ['a non-bearer scheme', 'Basic c2VjcmV0'],
    ['a scheme without a token', 'Bearer'],
  ])('rejects %s without attempting verification', async (_label, authorization) => {
    const result = await verifyAuth(requestWith(authorization));

    expect(result).toEqual({
      success: false,
      error: { message: 'Bearer token is missing or malformed', status: 401 },
    });
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  it('distinguishes a missing Authorization header from a malformed one', async () => {
    const result = await verifyAuth(requestWith(null));

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Authorization header is missing');
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  it.each([
    ['missing headers', {}],
    ['headers without a get method', { headers: {} }],
  ])('treats requests with %s as missing the Authorization header', async (_label, request) => {
    const result = await verifyAuth(request as any);

    expect(result).toEqual({
      success: false,
      error: { message: 'Authorization header is missing', status: 401 },
    });
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });
});
