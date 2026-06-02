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

import { verifyBearerToken } from './auth';

describe('verifyBearerToken', () => {
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
});
