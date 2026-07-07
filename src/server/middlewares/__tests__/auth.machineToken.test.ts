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

jest.mock('server/lib/auth', () => ({
  verifyAuth: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { authMiddleware } from 'server/middlewares/auth';
import { verifyAuth } from 'server/lib/auth';

const mockVerifyAuth = verifyAuth as jest.Mock;

const VALID_TOKEN = `lfc_${'a'.repeat(40)}`;
const originalEnableAuth = process.env.ENABLE_AUTH;

const makeRequest = (url: string, headers: Record<string, string> = {}) => new NextRequest(url, { headers });

const runMiddleware = async (req: NextRequest) => {
  const next = jest.fn().mockResolvedValue('next-result');
  const result = await authMiddleware(req, next);
  return { next, result };
};

afterEach(() => {
  process.env.ENABLE_AUTH = originalEnableAuth;
  jest.clearAllMocks();
});

describe('authMiddleware machine-token pass-through', () => {
  beforeEach(() => {
    process.env.ENABLE_AUTH = 'true';
  });

  it('passes lfc bearers on /api/v2/environments through without JWT verification, stripping x-user', async () => {
    const req = makeRequest('http://localhost/api/v2/environments', {
      authorization: `Bearer ${VALID_TOKEN}`,
      'x-user': 'spoofed',
    });

    const { next } = await runMiddleware(req);

    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = next.mock.calls[0][0] as NextRequest;
    expect(forwarded.headers.get('x-user')).toBeNull();
    expect(forwarded.headers.get('authorization')).toBe(`Bearer ${VALID_TOKEN}`);
  });

  it('covers environment sub-paths', async () => {
    const req = makeRequest('http://localhost/api/v2/environments/happy-otter-123456/extend', {
      authorization: `Bearer ${VALID_TOKEN}`,
    });

    await runMiddleware(req);
    expect(mockVerifyAuth).not.toHaveBeenCalled();
  });

  it('still requires a verified JWT on /api/v2/environments without an lfc bearer', async () => {
    mockVerifyAuth.mockResolvedValue({ success: false, error: new Error('nope') });
    const req = makeRequest('http://localhost/api/v2/environments');

    const { next, result } = await runMiddleware(req);

    expect(mockVerifyAuth).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect((result as Response).status).toBe(401);
  });

  it('forwards lfc bearers on every other v2 path without JWT verification', async () => {
    const req = makeRequest('http://localhost/api/v2/builds', {
      authorization: `Bearer ${VALID_TOKEN}`,
      'x-user': 'spoofed',
    });

    const { next } = await runMiddleware(req);

    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = next.mock.calls[0][0] as NextRequest;
    expect(forwarded.headers.get('x-user')).toBeNull();
  });

  it('rejects malformed lfc bearers via the normal JWT path', async () => {
    mockVerifyAuth.mockResolvedValue({ success: false, error: new Error('nope') });
    const req = makeRequest('http://localhost/api/v2/environments', {
      authorization: 'Bearer lfc_tooshort',
    });

    const { result } = await runMiddleware(req);

    expect(mockVerifyAuth).toHaveBeenCalledTimes(1);
    expect((result as Response).status).toBe(401);
  });

  it('keeps the verified-JWT rewrite behavior for valid JWTs', async () => {
    mockVerifyAuth.mockResolvedValue({ success: true, payload: { sub: 'user-1' } });
    const req = makeRequest('http://localhost/api/v2/environments', {
      authorization: 'Bearer some.jwt.token',
      'x-user': 'spoofed',
    });

    const { next } = await runMiddleware(req);

    const forwarded = next.mock.calls[0][0] as NextRequest;
    const decoded = JSON.parse(Buffer.from(forwarded.headers.get('x-user')!, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ sub: 'user-1' });
  });
});

describe('authMiddleware unchanged behavior outside auth mode', () => {
  it('passes everything through with x-user stripped when ENABLE_AUTH is not true', async () => {
    delete process.env.ENABLE_AUTH;
    const req = makeRequest('http://localhost/api/v2/environments', { 'x-user': 'spoofed' });

    const { next } = await runMiddleware(req);

    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = next.mock.calls[0][0] as NextRequest;
    expect(forwarded.headers.get('x-user')).toBeNull();
  });

  it('ignores non-v2 paths entirely', async () => {
    process.env.ENABLE_AUTH = 'true';
    const req = makeRequest('http://localhost/api/v1/builds');

    const { next } = await runMiddleware(req);

    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(req);
  });
});
