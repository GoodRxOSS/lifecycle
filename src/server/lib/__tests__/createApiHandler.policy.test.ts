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

jest.mock('server/models/ApiToken');
jest.mock('server/models/Repository');
jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/services/globalConfig', () => {
  const getAllConfigs = jest.fn();
  const getConfig = jest.fn();
  return {
    __esModule: true,
    default: { getInstance: () => ({ getAllConfigs, getConfig }) },
    __getAllConfigs: getAllConfigs,
    __getConfig: getConfig,
  };
});
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('server/services/authRateLimit', () => ({ checkApiKeyRateLimit: jest.fn() }));
jest.mock('server/services/authAudit', () => ({ recordAuthAuditEvent: jest.fn() }));

import { NextRequest, NextResponse } from 'next/server';
import ApiToken from 'server/models/ApiToken';
import { checkApiKeyRateLimit } from 'server/services/authRateLimit';
import { recordAuthAuditEvent } from 'server/services/authAudit';
import { createApiHandler, createPrincipalApiHandler, createPublicApiHandler } from '../createApiHandler';
import { AppError } from '../appError';
import type { Principal } from '../principal';

const mockGetAllConfigs = (jest.requireMock('server/services/globalConfig') as any).__getAllConfigs as jest.Mock;
const mockGetConfig = (jest.requireMock('server/services/globalConfig') as any).__getConfig as jest.Mock;
const mockCheckRateLimit = checkApiKeyRateLimit as jest.Mock;
const mockRecordDenied = recordAuthAuditEvent as jest.Mock;

const VALID_TOKEN = `lfc_${'a'.repeat(40)}`;

const encodeUser = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const sessionHeader = (roles: string[], sub = 'u-1') => ({ 'x-user': encodeUser({ sub, realm_access: { roles } }) });

const request = (headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost/api/v2/environments', { headers });

const personalRecord = (scopes: string[]) => ({
  id: 9,
  name: 'mine',
  kind: 'personal',
  scopes,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  ownerUserId: 'sub-1',
  ownerGithubUsername: 'octo',
  ownerEmail: 'owner@corp.com',
  ownerPreferredUsername: 'octo-pref',
  ownerDisplayName: 'Octo Cat',
  createdAt: new Date().toISOString(),
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: new Date().toISOString(),
});

const okHandler = jest.fn(async () => NextResponse.json({ ok: true }, { status: 200 }));

let query: any;
const originalEnableAuth = process.env.ENABLE_AUTH;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_AUTH = 'true';
  query = {
    findOne: jest.fn(),
    findById: jest.fn().mockReturnThis(),
    patch: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  (ApiToken.query as jest.Mock) = jest.fn(() => query);
  mockGetAllConfigs.mockResolvedValue({ api_keys: { personalAuthEnabled: true, serviceAuthEnabled: true } });
  mockGetConfig.mockResolvedValue({ personalAuthEnabled: true, serviceAuthEnabled: true });
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

afterAll(() => {
  if (originalEnableAuth === undefined) {
    delete process.env.ENABLE_AUTH;
  } else {
    process.env.ENABLE_AUTH = originalEnableAuth;
  }
});

describe('createApiHandler (session policy)', () => {
  it('rejects key-shaped bearers by shape with zero token or config lookups', async () => {
    const handler = createApiHandler(okHandler, { auth: 'session' });

    const res = await handler(request({ authorization: `Bearer ${VALID_TOKEN}`, ...sessionHeader(['admin']) }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('interactive_auth_required');
    expect(body.error.message).toBe('This endpoint requires an interactive session; API keys are not accepted here.');
    expect(ApiToken.query).not.toHaveBeenCalled();
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
    expect(mockGetConfig).not.toHaveBeenCalled();
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('shape-rejects any lfc_ prefixed bearer, case-insensitively, even malformed ones', async () => {
    const handler = createApiHandler(okHandler, { auth: 'session' });

    for (const authorization of ['bearer lfc_short', `BEARER lfc_pat_${'b'.repeat(40)}`]) {
      const res = await handler(request({ authorization }));
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('interactive_auth_required');
    }
    expect(ApiToken.query).not.toHaveBeenCalled();
  });

  it('401s authentication_required with a bearer challenge when no session is present', async () => {
    const handler = createApiHandler(okHandler, { auth: 'session' });

    const res = await handler(request());
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe('authentication_required');
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="lifecycle"');
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('403s forbidden_role for a roleless session and passes a user-role session (D15)', async () => {
    const handler = createApiHandler(okHandler, { auth: 'session' });

    const roleless = await handler(request(sessionHeader([])));
    expect(roleless.status).toBe(403);
    expect((await roleless.json()).error.code).toBe('forbidden_role');

    const user = await handler(request(sessionHeader(['user'])));
    expect(user.status).toBe(200);
    expect(okHandler).toHaveBeenCalledTimes(1);
  });

  it('keeps requireRole parity for roles: [admin]', async () => {
    const handler = createApiHandler(okHandler, { auth: 'session', roles: ['admin'] });

    const denied = await handler(request(sessionHeader(['user'])));
    const deniedBody = await denied.json();
    expect(denied.status).toBe(403);
    expect(deniedBody).toMatchObject({
      error: { message: 'Forbidden: insufficient permissions' },
      data: null,
    });

    const allowed = await handler(request(sessionHeader(['admin'])));
    expect(allowed.status).toBe(200);
  });

  it('fails open to the local-dev admin identity when auth is off', async () => {
    process.env.ENABLE_AUTH = 'false';
    const handler = createApiHandler(okHandler, { auth: 'session', roles: ['admin'] });

    const res = await handler(request());

    expect(res.status).toBe(200);
    expect(okHandler).toHaveBeenCalledTimes(1);
  });
});

describe('createPrincipalApiHandler', () => {
  const principalHandler = () => {
    const seen: { principal: Principal | null } = { principal: null };
    const handler = jest.fn(async (_req: NextRequest, principal: Principal) => {
      seen.principal = principal;
      return NextResponse.json({ ok: true }, { status: 200 });
    });
    return { handler, seen };
  };

  it('passes sessions regardless of the required scope', async () => {
    const { handler, seen } = principalHandler();
    const wrapped = createPrincipalApiHandler({ scope: 'env:write' }, handler);

    const res = await wrapped(request(sessionHeader(['user'])));

    expect(res.status).toBe(200);
    expect(seen.principal).toMatchObject({ kind: 'user', authMethod: 'session', scopes: null });
  });

  it('403s forbidden_role for a roleless session (D15)', async () => {
    const { handler } = principalHandler();
    const wrapped = createPrincipalApiHandler({ scope: 'env:read' }, handler);

    const res = await wrapped(request(sessionHeader([])));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden_role');
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes a key whose write scope covers the required read scope', async () => {
    query.findOne.mockResolvedValue(personalRecord(['env:write']));
    const { handler, seen } = principalHandler();
    const wrapped = createPrincipalApiHandler({ scope: 'env:read' }, handler);

    const res = await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}` }));

    expect(res.status).toBe(200);
    expect(seen.principal).toMatchObject({ kind: 'personal_key', actor: 'sub-1', scopes: ['env:write'] });
  });

  it('403s forbidden_scope with an insufficient_scope challenge for an under-scoped key', async () => {
    query.findOne.mockResolvedValue(personalRecord(['env:read']));
    const { handler } = principalHandler();
    const wrapped = createPrincipalApiHandler({ scope: 'env:write' }, handler);

    const res = await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}` }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden_scope');
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer error="insufficient_scope", scope="env:write"');
    expect(handler).not.toHaveBeenCalled();
  });

  it('403s forbidden_credential_kind when the principal kind is filtered out', async () => {
    query.findOne.mockResolvedValue(personalRecord(['env:write']));
    const { handler } = principalHandler();
    const wrapped = createPrincipalApiHandler({ scope: 'env:read', kinds: ['service_key'] }, handler);

    const res = await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}` }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden_credential_kind');
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts any authenticated principal when scope is null', async () => {
    query.findOne.mockResolvedValue(personalRecord(['sites:read']));
    const { handler } = principalHandler();
    const wrapped = createPrincipalApiHandler({ scope: null }, handler);

    expect((await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}` }))).status).toBe(200);
    expect((await wrapped(request(sessionHeader(['user'])))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('401s an invalid key with an invalid_token challenge', async () => {
    query.findOne.mockResolvedValue(undefined);
    const { handler } = principalHandler();
    const wrapped = createPrincipalApiHandler({ scope: 'env:read' }, handler);

    const res = await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}` }));

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('invalid_credential');
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="lifecycle", error="invalid_token"');
  });

  it('401s a missing credential with a plain bearer challenge', async () => {
    const { handler } = principalHandler();
    const wrapped = createPrincipalApiHandler({ scope: 'env:read' }, handler);

    const res = await wrapped(request());

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('authentication_required');
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="lifecycle"');
  });

  it('429s rate_limited with a Retry-After header when a key is over the limit', async () => {
    query.findOne.mockResolvedValue(personalRecord(['env:write']));
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const { handler } = principalHandler();
    const wrapped = createPrincipalApiHandler({ scope: 'env:read' }, handler);

    const res = await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}` }));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error.code).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not consult the rate limiter for a session principal', async () => {
    const { handler } = principalHandler();
    const wrapped = createPrincipalApiHandler({ scope: 'env:read' }, handler);

    const res = await wrapped(request(sessionHeader(['user'])));

    expect(res.status).toBe(200);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  describe('authorization-denial audit', () => {
    it('records auth.denied with key attribution and the required scope on forbidden_scope', async () => {
      query.findOne.mockResolvedValue(personalRecord(['env:read']));
      const { handler } = principalHandler();
      const wrapped = createPrincipalApiHandler({ scope: 'env:write' }, handler);

      const res = await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}`, 'x-request-id': 'req-7' }));

      expect(res.status).toBe(403);
      expect(mockRecordDenied).toHaveBeenCalledWith({
        event: 'auth.denied',
        principalKind: 'personal_key',
        principalId: 'sub-1',
        actorId: 'sub-1',
        tokenId: 9,
        requestId: 'req-7',
        route: 'GET /api/v2/environments',
        outcome: 'denied',
        meta: { reason: 'forbidden_scope', requiredScope: 'env:write', grantedScopes: ['env:read'] },
      });
    });

    it('truncates caller-chosen route and requestId to the audit column width', async () => {
      query.findOne.mockResolvedValue(personalRecord(['env:read']));
      const { handler } = principalHandler();
      const wrapped = createPrincipalApiHandler({ scope: 'env:write' }, handler);
      const longSegment = 'x'.repeat(400);

      const res = await wrapped(
        new NextRequest(`http://localhost/api/v2/environments/${longSegment}`, {
          headers: { authorization: `Bearer ${VALID_TOKEN}`, 'x-request-id': 'r'.repeat(400) },
        })
      );

      expect(res.status).toBe(403);
      const recorded = mockRecordDenied.mock.calls[0][0];
      expect(recorded.route).toHaveLength(255);
      expect(recorded.route.startsWith('GET /api/v2/environments/xxx')).toBe(true);
      expect(recorded.requestId).toHaveLength(255);
    });

    it('records auth.denied on forbidden_credential_kind', async () => {
      query.findOne.mockResolvedValue(personalRecord(['env:write']));
      const { handler } = principalHandler();
      const wrapped = createPrincipalApiHandler({ scope: 'env:read', kinds: ['service_key'] }, handler);

      const res = await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}` }));

      expect(res.status).toBe(403);
      expect(mockRecordDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.denied',
          principalKind: 'personal_key',
          tokenId: 9,
          outcome: 'denied',
          meta: { reason: 'forbidden_credential_kind', allowedKinds: ['service_key'] },
        })
      );
    });

    it('records auth.denied on forbidden_role for a roleless session', async () => {
      const { handler } = principalHandler();
      const wrapped = createPrincipalApiHandler({ scope: 'env:read' }, handler);

      const res = await wrapped(request(sessionHeader([], 'u-9')));

      expect(res.status).toBe(403);
      expect(mockRecordDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.denied',
          principalKind: 'user',
          principalId: 'u-9',
          actorId: 'u-9',
          tokenId: null,
          outcome: 'denied',
          meta: { reason: 'forbidden_role' },
        })
      );
    });

    it('records auth.denied when a handler throws forbidden_repository, then maps it to 403', async () => {
      query.findOne.mockResolvedValue(personalRecord(['env:write']));
      const wrapped = createPrincipalApiHandler({ scope: 'env:read' }, async () => {
        throw new AppError({
          httpStatus: 403,
          code: 'forbidden_repository',
          message: 'API token is not allowed to target repository acme/payments.',
          details: { repository: 'acme/payments' },
        });
      });

      const res = await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}` }));

      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('forbidden_repository');
      expect(mockRecordDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.denied',
          principalKind: 'personal_key',
          tokenId: 9,
          outcome: 'denied',
          meta: { reason: 'forbidden_repository', repository: 'acme/payments' },
        })
      );
    });

    it('records nothing on success, rate-limit 429s, or non-authorization handler errors', async () => {
      query.findOne.mockResolvedValue(personalRecord(['env:write']));
      const { handler } = principalHandler();
      const wrapped = createPrincipalApiHandler({ scope: 'env:read' }, handler);
      expect((await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}` }))).status).toBe(200);

      mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
      expect((await wrapped(request({ authorization: `Bearer ${VALID_TOKEN}` }))).status).toBe(429);

      mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
      const throwing = createPrincipalApiHandler({ scope: 'env:read' }, async () => {
        throw new AppError({ httpStatus: 404, code: 'not_found', message: 'nope' });
      });
      expect((await throwing(request({ authorization: `Bearer ${VALID_TOKEN}` }))).status).toBe(404);

      expect(mockRecordDenied).not.toHaveBeenCalled();
    });
  });
});

describe('createPublicApiHandler', () => {
  it('runs the handler without any platform auth', async () => {
    const handler = createPublicApiHandler(okHandler);

    const res = await handler(request());

    expect(res.status).toBe(200);
    expect(okHandler).toHaveBeenCalledTimes(1);
  });
});

describe('__routePolicy markers', () => {
  const markerOf = (fn: unknown) => (fn as { __routePolicy?: unknown }).__routePolicy;

  it('stamps a frozen, non-enumerable marker on all three wrappers', () => {
    const session = createApiHandler(okHandler, { auth: 'session' });
    const admin = createApiHandler(okHandler, { auth: 'session', roles: ['admin'] });
    const principal = createPrincipalApiHandler({ scope: 'env:read', kinds: ['service_key'] }, async () =>
      NextResponse.json({})
    );
    const anyPrincipal = createPrincipalApiHandler({ scope: null }, async () => NextResponse.json({}));
    const publicHandler = createPublicApiHandler(okHandler);

    expect(markerOf(session)).toEqual({ policy: 'session' });
    expect(markerOf(admin)).toEqual({ policy: 'session', roles: ['admin'] });
    expect(markerOf(principal)).toEqual({ policy: 'principal', scope: 'env:read', kinds: ['service_key'] });
    expect(markerOf(anyPrincipal)).toEqual({ policy: 'principal', scope: null });
    expect(markerOf(publicHandler)).toEqual({ policy: 'public' });

    for (const fn of [session, admin, principal, anyPrincipal, publicHandler]) {
      const descriptor = Object.getOwnPropertyDescriptor(fn, '__routePolicy');
      expect(descriptor?.enumerable).toBe(false);
      expect(descriptor?.writable).toBe(false);
      expect(Object.isFrozen(markerOf(fn))).toBe(true);
    }
    expect(Object.isFrozen((markerOf(admin) as { roles: string[] }).roles)).toBe(true);
    expect(Object.isFrozen((markerOf(principal) as { kinds: string[] }).kinds)).toBe(true);
  });
});
