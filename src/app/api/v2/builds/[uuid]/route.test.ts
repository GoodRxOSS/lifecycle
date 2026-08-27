import { NextRequest } from 'next/server';
import type { Principal } from 'server/lib/principal';

const mockResolvePrincipal = jest.fn();
const mockScopeSatisfies = jest.fn();
const mockCheckApiKeyRateLimit = jest.fn();
const mockRecordAuthAuditEvent = jest.fn();
const mockAssertBuildRepositoryAllowed = jest.fn();
const mockGetBuildByUUID = jest.fn();
const mockApplyBuildConfigPatch = jest.fn();
const mockBuildQuery = jest.fn();
const mockLogger = { error: jest.fn(), info: jest.fn() };

jest.mock('nanoid', () => ({ nanoid: () => 'run-123' }));

jest.mock('server/lib/principal', () => ({
  resolvePrincipal: (...args: unknown[]) => mockResolvePrincipal(...args),
}));

jest.mock('server/services/apiToken', () => ({
  scopeSatisfies: (...args: unknown[]) => mockScopeSatisfies(...args),
}));

jest.mock('server/services/authRateLimit', () => ({
  checkApiKeyRateLimit: (...args: unknown[]) => mockCheckApiKeyRateLimit(...args),
}));

jest.mock('server/services/authAudit', () => ({
  recordAuthAuditEvent: (...args: unknown[]) => mockRecordAuthAuditEvent(...args),
}));

jest.mock('server/lib/repositoryAuthorization', () => ({
  assertBuildRepositoryAllowed: (...args: unknown[]) => mockAssertBuildRepositoryAllowed(...args),
}));

jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn(() => ({ getBuildByUUID: (...args: unknown[]) => mockGetBuildByUUID(...args) })),
}));

jest.mock('server/services/override', () => ({
  __esModule: true,
  BuildUuidValidationError: class BuildUuidValidationError extends Error {},
  default: jest.fn(() => ({
    db: { models: { Build: { query: (...args: unknown[]) => mockBuildQuery(...args) } } },
    applyBuildConfigPatch: (...args: unknown[]) => mockApplyBuildConfigPatch(...args),
  })),
}));

import { AppError } from 'server/lib/appError';
import { BuildUuidValidationError } from 'server/services/override';
import { GET, PATCH } from './route';

const userPrincipal = {
  kind: 'user',
  authMethod: 'session',
  userId: 'user-1',
  actor: 'user-1',
  roles: ['user'],
  scopes: null,
  tokenId: null,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: { userId: 'user-1', roles: ['user'] },
} as Principal;

const unscopedServicePrincipal = {
  kind: 'service_key',
  authMethod: 'api_key',
  userId: null,
  actor: 'token:ci',
  roles: [],
  scopes: [],
  tokenId: 7,
  repositoryAllowlist: null,
  repositoryAllowlistRepoIds: null,
  identity: null,
} as Principal;

const build = {
  id: 41,
  uuid: 'build-old',
  isStatic: false,
  pullRequest: { id: 3 },
};

function request(method: 'GET' | 'PATCH', body?: unknown, rawBody?: string): NextRequest {
  return new NextRequest('http://localhost/api/v2/builds/build-old', {
    method,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-build-detail' },
    ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const context = (uuid = 'build-old') => ({ params: Promise.resolve({ uuid }) });

function queryResult(value: unknown) {
  const query = {
    findOne: jest.fn(),
    whereNull: jest.fn(),
    withGraphFetched: jest.fn(),
  };
  query.findOne.mockReturnValue(query);
  query.whereNull.mockReturnValue(query);
  query.withGraphFetched.mockResolvedValue(value);
  return query;
}

describe('/api/v2/builds/[uuid]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolvePrincipal.mockResolvedValue(userPrincipal);
    mockScopeSatisfies.mockImplementation((granted: string[], required: string) => granted.includes(required));
    mockCheckApiKeyRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mockRecordAuthAuditEvent.mockResolvedValue(undefined);
    mockAssertBuildRepositoryAllowed.mockResolvedValue(undefined);
    mockGetBuildByUUID.mockResolvedValue(build);
    mockBuildQuery.mockReturnValue(queryResult(build));
    mockApplyBuildConfigPatch.mockResolvedValue({ ...build, uuid: 'build-new' });
  });

  it.each([
    ['GET', GET, 'env:read'],
    ['PATCH', PATCH, 'env:write'],
  ])('enforces %s scope before reading or mutating a build', async (_method, handler, requiredScope) => {
    mockResolvePrincipal.mockResolvedValue(unscopedServicePrincipal);

    const response = await handler(request('PATCH', { isStatic: true }), context());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toEqual(
      expect.objectContaining({
        code: 'forbidden_scope',
        details: { requiredScope, grantedScopes: [] },
      })
    );
    expect(mockGetBuildByUUID).not.toHaveBeenCalled();
    expect(mockBuildQuery).not.toHaveBeenCalled();
    expect(mockApplyBuildConfigPatch).not.toHaveBeenCalled();
  });

  it('returns a repository-authorized build', async () => {
    const response = await GET(request('GET'), context());

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(build);
    expect(mockGetBuildByUUID).toHaveBeenCalledWith('build-old');
    expect(mockAssertBuildRepositoryAllowed).toHaveBeenCalledWith(userPrincipal, build);
  });

  it('returns 404 without authorizing when the build does not exist', async () => {
    mockGetBuildByUUID.mockResolvedValue(null);

    const response = await GET(request('GET'), context('missing'));

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe('Build with UUID missing not found');
    expect(mockAssertBuildRepositoryAllowed).not.toHaveBeenCalled();
  });

  it('preserves a repository authorization denial', async () => {
    mockAssertBuildRepositoryAllowed.mockRejectedValue(
      new AppError({
        httpStatus: 403,
        code: 'forbidden_repository',
        message: 'This key cannot access the build repository.',
      })
    );

    const response = await GET(request('GET'), context());

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden_repository');
  });

  it('maps unexpected build reads to 500', async () => {
    mockGetBuildByUUID.mockRejectedValue(new Error('build read failed'));

    const response = await GET(request('GET'), context());

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('build read failed');
  });

  it.each([
    ['invalid JSON', undefined, '{broken', 'request body must be an object'],
    ['null body', null, undefined, 'request body must be an object'],
    ['array body', [], undefined, 'request body must be an object'],
    ['primitive body', 'static', undefined, 'request body must be an object'],
    ['unsupported field', { unknown: true }, undefined, 'Unsupported field(s): unknown'],
    ['empty patch', {}, undefined, 'At least one build config field is required'],
    ['non-string uuid', { uuid: 42 }, undefined, 'uuid must be a string'],
    ['short uuid', { uuid: 'ab' }, undefined, 'UUID must be between 3 and 50 characters'],
    [
      'invalid uuid characters',
      { uuid: 'Build_New' },
      undefined,
      'UUID can only contain lowercase letters, numbers, and hyphens',
    ],
    ['leading hyphen', { uuid: '-build' }, undefined, 'UUID cannot start or end with a hyphen'],
    ['non-boolean static mode', { isStatic: 'true' }, undefined, 'isStatic must be a boolean'],
    ['non-boolean branch tracking', { trackDefaultBranches: 1 }, undefined, 'trackDefaultBranches must be a boolean'],
    ['null runtime comment env', { commentRuntimeEnv: null }, undefined, 'commentRuntimeEnv must be an object'],
    ['array runtime comment env', { commentRuntimeEnv: [] }, undefined, 'commentRuntimeEnv must be an object'],
    ['null init comment env', { commentInitEnv: null }, undefined, 'commentInitEnv must be an object'],
  ])('rejects %s before looking up a build', async (_label, body, rawBody, message) => {
    const response = await PATCH(request('PATCH', body, rawBody), context());

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(message);
    expect(mockBuildQuery).not.toHaveBeenCalled();
    expect(mockAssertBuildRepositoryAllowed).not.toHaveBeenCalled();
    expect(mockApplyBuildConfigPatch).not.toHaveBeenCalled();
  });

  it('patches every supported field and rehydrates the exact updated row', async () => {
    const patch = {
      uuid: 'build-new',
      isStatic: true,
      trackDefaultBranches: false,
      commentRuntimeEnv: { API_URL: 'https://example.com' },
      commentInitEnv: { SETUP: 'true' },
    };
    const query = queryResult(build);
    mockBuildQuery.mockReturnValue(query);
    const hydrated = { ...build, ...patch };
    mockGetBuildByUUID.mockResolvedValue(hydrated);

    const response = await PATCH(request('PATCH', patch), context());

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(hydrated);
    expect(query.findOne).toHaveBeenCalledWith({ uuid: 'build-old' });
    expect(query.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(query.withGraphFetched).toHaveBeenCalledWith('pullRequest');
    expect(mockAssertBuildRepositoryAllowed).toHaveBeenCalledWith(userPrincipal, build);
    expect(mockApplyBuildConfigPatch).toHaveBeenCalledWith({
      build,
      pullRequest: build.pullRequest,
      patch,
      runUuid: 'run-123',
    });
    expect(mockGetBuildByUUID).toHaveBeenCalledWith('build-new', {
      liveOnly: true,
      expectedBuildId: 41,
    });
  });

  it('returns 404 before authorization when no live patch target exists', async () => {
    mockBuildQuery.mockReturnValue(queryResult(null));

    const response = await PATCH(request('PATCH', { isStatic: true }), context('missing'));

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe('Build with UUID missing not found');
    expect(mockAssertBuildRepositoryAllowed).not.toHaveBeenCalled();
    expect(mockApplyBuildConfigPatch).not.toHaveBeenCalled();
  });

  it('returns 404 if the exact updated row cannot be rehydrated', async () => {
    mockGetBuildByUUID.mockResolvedValue(null);

    const response = await PATCH(request('PATCH', { isStatic: true }), context());

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe('Build with UUID build-new not found');
  });

  it('maps a UUID conflict from the override service to 400', async () => {
    mockApplyBuildConfigPatch.mockRejectedValue(new BuildUuidValidationError('UUID is already in use'));

    const response = await PATCH(request('PATCH', { uuid: 'build-new' }), context());

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('UUID is already in use');
  });

  it('maps unexpected patch failures to 500', async () => {
    mockApplyBuildConfigPatch.mockRejectedValue(new Error('override write failed'));

    const response = await PATCH(request('PATCH', { isStatic: true }), context());

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('override write failed');
  });
});
