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

const mockVerifyAuth = jest.fn();
const mockGetBuildByUUID = jest.fn();
const mockAssertBuildRepositoryAllowed = jest.fn();
const mockAssertLogStreamPodContainer = jest.fn();

jest.mock('server/lib/auth', () => ({ verifyAuth: (...args: unknown[]) => mockVerifyAuth(...args) }));
jest.mock('server/models/ApiToken');
jest.mock('server/models/Repository');
jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('server/services/authRateLimit', () => ({
  checkApiKeyRateLimit: jest.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));
jest.mock('server/services/authAudit', () => ({ recordAuthAuditEvent: jest.fn() }));
jest.mock('server/services/apiToken', () => {
  const actual = jest.requireActual('server/services/apiToken');
  return { __esModule: true, ...actual, default: { verifyToken: jest.fn(), touchLastUsed: jest.fn() } };
});
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getConfig: jest.fn().mockResolvedValue({ serviceAuthEnabled: true, personalAuthEnabled: true }),
    }),
  },
}));
jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ getBuildByUUID: mockGetBuildByUUID })),
}));
jest.mock('server/lib/repositoryAuthorization', () => ({
  assertBuildRepositoryAllowed: (...args: unknown[]) => mockAssertBuildRepositoryAllowed(...args),
}));
jest.mock('server/lib/logStreamPodAccess', () => ({
  assertLogStreamPodContainer: (...args: unknown[]) => mockAssertLogStreamPodContainer(...args),
}));

import { NextRequest } from 'next/server';
import ApiTokenService from 'server/services/apiToken';
import { AppError } from 'server/lib/appError';
import { readLogStreamTicketClaims } from 'server/lib/logStreamTicket';
import { POST } from './route';
import { authMiddleware } from 'server/middlewares/auth';

const verifyToken = ApiTokenService.verifyToken as jest.Mock;
const originalMode = process.env.LIFECYCLE_MODE;
const originalAppEnv = process.env.APP_ENV;
const originalEnableAuth = process.env.ENABLE_AUTH;
const originalSecret = process.env.CHAT_PREVIEW_GRANT_SECRET;
const KEY = `lfc_svc_${'a'.repeat(40)}`;

const encodeUser = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const sessionHeaders = { 'x-user': encodeUser({ sub: 'user-1', realm_access: { roles: ['user'] } }) };
const keyHeaders = { authorization: `Bearer ${KEY}` };

function makeRequest(body: unknown, headers: Record<string, string> = sessionHeaders): NextRequest {
  return new NextRequest('http://localhost/api/v2/logs/stream-tickets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = { buildUuid: 'build-1', podName: 'web-0', containerName: 'web' };

describe('POST /api/v2/logs/stream-tickets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    process.env.LIFECYCLE_MODE = 'web';
    process.env.APP_ENV = 'production';
    process.env.CHAT_PREVIEW_GRANT_SECRET = 'test-ticket-secret';
    mockGetBuildByUUID.mockResolvedValue({ uuid: 'build-1', namespace: 'env-build-1' });
    mockAssertBuildRepositoryAllowed.mockResolvedValue(undefined);
    mockAssertLogStreamPodContainer.mockResolvedValue(undefined);
    verifyToken.mockResolvedValue(null);
    mockVerifyAuth.mockResolvedValue({
      success: false,
      error: { status: 401, message: 'Authentication is required.' },
    });
  });

  afterAll(() => {
    if (originalMode === undefined) delete process.env.LIFECYCLE_MODE;
    else process.env.LIFECYCLE_MODE = originalMode;
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    if (originalEnableAuth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = originalEnableAuth;
    if (originalSecret === undefined) delete process.env.CHAT_PREVIEW_GRANT_SECRET;
    else process.env.CHAT_PREVIEW_GRANT_SECRET = originalSecret;
  });

  it('mints a ticket pinned to the environment namespace once the pod and container are verified there', async () => {
    const response = await POST(makeRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetBuildByUUID).toHaveBeenCalledWith('build-1');
    expect(mockAssertBuildRepositoryAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ uuid: 'build-1' })
    );
    expect(mockAssertLogStreamPodContainer).toHaveBeenCalledWith({
      namespace: 'env-build-1',
      podName: 'web-0',
      containerName: 'web',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(body.data.maxAgeSeconds).toBe(300);
    expect(readLogStreamTicketClaims(body.data.ticket)).toMatchObject({
      buildUuid: 'build-1',
      namespace: 'env-build-1',
      podName: 'web-0',
      containerName: 'web',
      actor: 'user-1',
    });
  });

  it('derives the namespace from the environment when the build row has none', async () => {
    mockGetBuildByUUID.mockResolvedValueOnce({ uuid: 'build-1', namespace: null });

    const response = await POST(makeRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(readLogStreamTicketClaims(body.data.ticket)).toMatchObject({ namespace: 'env-build-1' });
  });

  it('never lets the caller choose the namespace', async () => {
    const response = await POST(makeRequest({ ...validBody, namespace: 'kube-system' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_body');
    expect(mockAssertLogStreamPodContainer).not.toHaveBeenCalled();
  });

  it('does not search another namespace when the pod is absent from the environment', async () => {
    mockAssertLogStreamPodContainer.mockRejectedValueOnce(
      new AppError({ httpStatus: 404, code: 'log_stream_pod_not_found', message: 'Pod not found.' })
    );
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(404);
    expect(mockAssertLogStreamPodContainer).toHaveBeenCalledTimes(1);
    expect(mockAssertLogStreamPodContainer).toHaveBeenCalledWith({
      namespace: 'env-build-1',
      podName: 'web-0',
      containerName: 'web',
    });
  });

  it.each(['job', 'unknown'])('does not issue tickets in %s mode', async (mode) => {
    process.env.LIFECYCLE_MODE = mode;
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(403);
    expect(mockGetBuildByUUID).not.toHaveBeenCalled();
    expect(mockAssertLogStreamPodContainer).not.toHaveBeenCalled();
  });

  it.each([undefined, 'false'])('denies production issuance with ENABLE_AUTH=%s', async (auth) => {
    if (auth === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = auth;
    const response = await POST(makeRequest(validBody, {}));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('authentication_unavailable');
    expect(mockGetBuildByUUID).not.toHaveBeenCalled();
    expect(mockAssertLogStreamPodContainer).not.toHaveBeenCalled();
  });

  it('preserves issuance for explicit auth-disabled local development', async () => {
    process.env.APP_ENV = 'development';
    delete process.env.ENABLE_AUTH;
    const response = await POST(makeRequest(validBody, {}));
    expect(response.status).toBe(200);
    expect((await response.json()).data.ticket).toMatch(/^lfclt_v1\./);
  });

  it('refuses a token that may not read the environment repository before any Kubernetes call', async () => {
    mockAssertBuildRepositoryAllowed.mockRejectedValueOnce(
      new AppError({ httpStatus: 403, code: 'forbidden_repository', message: 'Not allowed.' })
    );

    const response = await POST(makeRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('forbidden_repository');
    expect(mockAssertLogStreamPodContainer).not.toHaveBeenCalled();
  });

  it('refuses a pod outside the environment', async () => {
    mockAssertLogStreamPodContainer.mockRejectedValue(
      new AppError({ httpStatus: 404, code: 'log_stream_pod_not_found', message: 'Pod not found in this environment.' })
    );

    const response = await POST(makeRequest({ ...validBody, podName: 'kube-apiserver-control-plane' }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('log_stream_pod_not_found');
    expect(body.data).toBeNull();
  });

  it('returns 404 for an unknown environment', async () => {
    mockGetBuildByUUID.mockResolvedValueOnce(null);

    const response = await POST(makeRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('environment_not_found');
    expect(mockAssertLogStreamPodContainer).not.toHaveBeenCalled();
  });

  it.each([
    ['a path-like pod name', { ...validBody, podName: '../kube-system/etcd' }],
    ['an uppercase container name', { ...validBody, containerName: 'Web' }],
    ['a missing build uuid', { podName: 'web-0', containerName: 'web' }],
    ['a non-object body', '[]'],
  ])('rejects %s before looking anything up', async (_label, body) => {
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    expect(mockGetBuildByUUID).not.toHaveBeenCalled();
    expect(mockAssertLogStreamPodContainer).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const response = await POST(makeRequest(validBody, {}));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('authentication_required');
    expect(mockGetBuildByUUID).not.toHaveBeenCalled();
  });

  it('requires the env:read scope on API keys', async () => {
    verifyToken.mockResolvedValue({ id: 7, name: 'ci', kind: 'service', scopes: ['sites:read'] });

    const response = await POST(makeRequest(validBody, keyHeaders));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('forbidden_scope');
    expect(mockGetBuildByUUID).not.toHaveBeenCalled();
  });

  it('mints a ticket for a service key with env:read and records the token as the actor', async () => {
    verifyToken.mockResolvedValue({ id: 7, name: 'ci', kind: 'service', scopes: ['env:read'] });

    const response = await POST(makeRequest(validBody, keyHeaders));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(readLogStreamTicketClaims(body.data.ticket)).toMatchObject({ actor: 'token:ci', namespace: 'env-build-1' });
  });

  it('rejects a spoofed principal through the real authentication middleware', async () => {
    const response = await authMiddleware(makeRequest(validBody), POST);
    expect(response.status).toBe(401);
    expect(mockGetBuildByUUID).not.toHaveBeenCalled();
    expect(mockAssertLogStreamPodContainer).not.toHaveBeenCalled();
  });

  it('uses the verified session principal after middleware replaces a spoofed header', async () => {
    mockVerifyAuth.mockResolvedValue({
      success: true,
      payload: { sub: 'verified-user', realm_access: { roles: ['user'] } },
    });
    const response = await authMiddleware(
      makeRequest(validBody, { ...sessionHeaders, authorization: 'Bearer session-jwt' }),
      POST
    );
    expect(response.status).toBe(200);
    expect(readLogStreamTicketClaims((await response.json()).data.ticket)).toMatchObject({ actor: 'verified-user' });
  });

  it('does not accept a forged key-shaped token passed through edge middleware', async () => {
    const response = await authMiddleware(makeRequest(validBody, { ...sessionHeaders, ...keyHeaders }), POST);
    expect(response.status).toBe(401);
    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(verifyToken).toHaveBeenCalled();
    expect(mockGetBuildByUUID).not.toHaveBeenCalled();
  });

  it('verifies service keys after middleware removes spoofed session identity', async () => {
    verifyToken.mockResolvedValue({ id: 7, name: 'ci', kind: 'service', scopes: ['env:read'] });
    const response = await authMiddleware(makeRequest(validBody, { ...sessionHeaders, ...keyHeaders }), POST);
    expect(response.status).toBe(200);
    expect(readLogStreamTicketClaims((await response.json()).data.ticket)).toMatchObject({ actor: 'token:ci' });
  });

  it('does not issue after a Kubernetes access denial', async () => {
    mockAssertLogStreamPodContainer.mockRejectedValueOnce(new Error('Kubernetes access denied'));
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(500);
    expect((await response.json()).data).toBeNull();
  });
});
