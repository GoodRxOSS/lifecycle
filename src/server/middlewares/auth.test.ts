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

import { NextRequest, NextResponse } from 'next/server';

const mockVerifyAuth = jest.fn();

jest.mock('server/lib/auth', () => ({
  verifyAuth: (...args: unknown[]) => mockVerifyAuth(...args),
}));

import { authMiddleware } from './auth';

const VALID_TOKEN = `lfc_${'a'.repeat(40)}`;
const originalEnableAuth = process.env.ENABLE_AUTH;

const makeRequest = (url: string, headers?: HeadersInit) => new NextRequest(url, { headers });

const runMiddleware = async (req: NextRequest) => {
  const next = jest.fn().mockResolvedValue(NextResponse.next());
  const result = await authMiddleware(req, next);
  return { next, result };
};

const forwardedRequest = (next: jest.Mock) => next.mock.calls[0][0] as NextRequest;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_AUTH = 'true';
});

afterAll(() => {
  if (originalEnableAuth === undefined) {
    delete process.env.ENABLE_AUTH;
  } else {
    process.env.ENABLE_AUTH = originalEnableAuth;
  }
});

describe('authMiddleware x-user stripping', () => {
  it('strips a crafted x-user when ENABLE_AUTH is off', async () => {
    process.env.ENABLE_AUTH = 'false';
    const req = makeRequest('http://localhost/api/v2/repositories', { 'x-user': 'spoofed' });

    const { next } = await runMiddleware(req);

    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(forwardedRequest(next).headers.get('x-user')).toBeNull();
  });

  it('strips a crafted x-user on the MCP OAuth callback exempt path', async () => {
    const req = makeRequest(
      'http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?code=sample-code&state=flow-123.sample-state',
      { 'x-user': 'spoofed' }
    );

    const { next } = await runMiddleware(req);

    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(forwardedRequest(next).headers.get('x-user')).toBeNull();
  });

  it('strips a crafted x-user on the key-shape pass-through branch', async () => {
    const req = makeRequest('http://localhost/api/v2/repositories', {
      authorization: `Bearer ${VALID_TOKEN}`,
      'x-user': 'spoofed',
    });

    const { next } = await runMiddleware(req);

    expect(forwardedRequest(next).headers.get('x-user')).toBeNull();
    expect(forwardedRequest(next).headers.get('authorization')).toBe(`Bearer ${VALID_TOKEN}`);
  });

  it('replaces a crafted x-user with the verified JWT payload', async () => {
    mockVerifyAuth.mockResolvedValue({ success: true, payload: { sub: 'user-1' } });
    const req = makeRequest('http://localhost/api/v2/repositories', {
      authorization: 'Bearer some.jwt.token',
      'x-user': 'spoofed',
    });

    const { next } = await runMiddleware(req);

    const forwarded = forwardedRequest(next);
    const decoded = JSON.parse(Buffer.from(forwarded.headers.get('x-user')!, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ sub: 'user-1' });
  });

  it('leaves non-v2 requests untouched', async () => {
    const req = makeRequest('http://localhost/api/v1/builds', { 'x-user': 'legacy' });

    const { next } = await runMiddleware(req);

    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(req);
    expect(forwardedRequest(next).headers.get('x-user')).toBe('legacy');
  });
});

describe('authMiddleware key-shape pass-through', () => {
  it.each([
    ['legacy', `lfc_${'a'.repeat(40)}`],
    ['personal-prefixed', `lfc_pat_${'b'.repeat(40)}`],
    ['service-prefixed', `lfc_svc_${'c'.repeat(40)}`],
  ])('forwards a %s key shape on arbitrary v2 paths without JWT verification', async (_label, token) => {
    const req = makeRequest('http://localhost/api/v2/repositories', { authorization: `Bearer ${token}` });

    const { next } = await runMiddleware(req);

    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['64-hex', `lfc_${'d'.repeat(64)}`],
    ['41-hex', `lfc_${'e'.repeat(41)}`],
    ['non-hex', `lfc_${'z'.repeat(40)}`],
    ['uppercase', `LFC_PAT_${'B'.repeat(40)}`],
  ])('sends a %s near-miss key to JWT verification rather than forwarding it', async (_label, token) => {
    mockVerifyAuth.mockResolvedValue({ success: false, error: { message: 'Unauthorized', status: 401 } });
    const req = makeRequest('http://localhost/api/v2/repositories', { authorization: `Bearer ${token}` });

    const { next, result } = await runMiddleware(req);

    expect(mockVerifyAuth).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(result.status).toBe(401);
  });

  it('matches the bearer scheme case-insensitively', async () => {
    const req = makeRequest('http://localhost/api/v2/builds', { authorization: `bearer ${VALID_TOKEN}` });

    const { next } = await runMiddleware(req);

    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sends non-key-shaped lfc bearers through the JWT path', async () => {
    mockVerifyAuth.mockResolvedValue({ success: false, error: { message: 'Unauthorized', status: 401 } });
    const req = makeRequest('http://localhost/api/v2/repositories', { authorization: 'Bearer lfc_tooshort' });

    const { next, result } = await runMiddleware(req);

    expect(mockVerifyAuth).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect((result as Response).status).toBe(401);
  });
});

describe('authMiddleware strict Authorization parsing', () => {
  it.each([
    ['comma-joined value', 'Bearer abc, Bearer def'],
    ['oversized value', `Bearer ${'a'.repeat(17000)}`],
  ])('401s invalid_credential for a %s', async (_label, authorization) => {
    const req = makeRequest('http://localhost/api/v2/repositories', { authorization });

    const { next, result } = await runMiddleware(req);
    const body = await (result as Response).json();

    expect(next).not.toHaveBeenCalled();
    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect((result as Response).status).toBe(401);
    expect(body.error.code).toBe('invalid_credential');
    expect((result as Response).headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="lifecycle", error="invalid_token"'
    );
  });

  it('401s duplicate Authorization headers', async () => {
    const headers = new Headers();
    headers.append('authorization', `Bearer ${VALID_TOKEN}`);
    headers.append('authorization', 'Bearer some.jwt.token');
    const req = makeRequest('http://localhost/api/v2/repositories', headers);

    const { next, result } = await runMiddleware(req);

    expect(next).not.toHaveBeenCalled();
    expect((result as Response).status).toBe(401);
  });

  it('rejects malformed Authorization even when ENABLE_AUTH is off', async () => {
    process.env.ENABLE_AUTH = 'false';
    const req = makeRequest('http://localhost/api/v2/repositories', { authorization: 'Bearer a, Bearer b' });

    const { result } = await runMiddleware(req);

    expect((result as Response).status).toBe(401);
  });
});

describe('authMiddleware JWT verification', () => {
  it('rejects API requests without valid bearer auth', async () => {
    mockVerifyAuth.mockResolvedValue({
      success: false,
      error: { message: 'Unauthorized', status: 401 },
    });
    const req = makeRequest('http://localhost/api/v2/ai/agent/settings');

    const { next, result } = await runMiddleware(req);
    const body = await (result as Response).json();

    expect(mockVerifyAuth).toHaveBeenCalledWith(req);
    expect(next).not.toHaveBeenCalled();
    expect((result as Response).status).toBe(401);
    expect(body.error.message).toBe('Unauthorized');
  });

  it('rejects repository self-service API requests without valid bearer auth', async () => {
    mockVerifyAuth.mockResolvedValue({
      success: false,
      error: { message: 'Unauthorized', status: 401 },
    });
    const req = makeRequest('http://localhost/api/v2/repositories');

    const { next, result } = await runMiddleware(req);
    const body = await (result as Response).json();

    expect(mockVerifyAuth).toHaveBeenCalledWith(req);
    expect(next).not.toHaveBeenCalled();
    expect((result as Response).status).toBe(401);
    expect(body.error.message).toBe('Unauthorized');
  });

  it('401s authentication_required with a bare challenge when no credential is presented', async () => {
    mockVerifyAuth.mockResolvedValue({
      success: false,
      error: { message: 'Authorization header is missing', status: 401 },
    });
    const req = makeRequest('http://localhost/api/v2/repositories');

    const { result } = await runMiddleware(req);
    const body = await (result as Response).json();

    expect((result as Response).status).toBe(401);
    expect(body.error.code).toBe('authentication_required');
    expect((result as Response).headers.get('WWW-Authenticate')).toBe('Bearer realm="lifecycle"');
  });

  it('401s invalid_credential with an invalid_token challenge when a bearer is rejected', async () => {
    mockVerifyAuth.mockResolvedValue({
      success: false,
      error: { message: 'Authentication failed: signature verification failed', status: 401 },
    });
    const req = makeRequest('http://localhost/api/v2/repositories', { authorization: 'Bearer some.jwt.token' });

    const { result } = await runMiddleware(req);
    const body = await (result as Response).json();

    expect((result as Response).status).toBe(401);
    expect(body.error.code).toBe('invalid_credential');
    expect((result as Response).headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="lifecycle", error="invalid_token"'
    );
  });

  it('propagates a verifier configuration failure as 500 without a challenge or code', async () => {
    mockVerifyAuth.mockResolvedValue({
      success: false,
      error: { message: 'Server configuration error', status: 500 },
    });
    const req = makeRequest('http://localhost/api/v2/repositories', { authorization: 'Bearer some.jwt.token' });

    const { result } = await runMiddleware(req);
    const body = await (result as Response).json();

    expect((result as Response).status).toBe(500);
    expect(body.error.code).toBeUndefined();
    expect((result as Response).headers.get('WWW-Authenticate')).toBeNull();
  });
});
