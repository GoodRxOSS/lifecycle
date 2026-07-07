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

const mockCreateApiEnvironment = jest.fn();
const mockListEnvironments = jest.fn();
const mockGetEnvironmentDetail = jest.fn();
const mockExtendApiEnvironment = jest.fn();
const mockRequestApiEnvironmentDeletion = jest.fn();
const mockRedeployBuild = jest.fn();
const mockApplyApiEnvironmentPatch = jest.fn();
const mockListRepositoryBranches = jest.fn();
const mockPreviewEnvironmentConfig = jest.fn();
const mockBuildFindOne = jest.fn();
const mockRepositoryFirst = jest.fn();

jest.mock('server/models/Repository', () => ({
  __esModule: true,
  default: {
    query: () => ({
      whereRaw: function () {
        return this;
      },
      whereNull: function () {
        return this;
      },
      first: mockRepositoryFirst,
    }),
  },
}));

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    createApiEnvironment: mockCreateApiEnvironment,
    listEnvironments: mockListEnvironments,
    getEnvironmentDetail: mockGetEnvironmentDetail,
    extendApiEnvironment: mockExtendApiEnvironment,
    requestApiEnvironmentDeletion: mockRequestApiEnvironmentDeletion,
    redeployBuild: mockRedeployBuild,
    applyApiEnvironmentPatch: mockApplyApiEnvironmentPatch,
    listRepositoryBranches: mockListRepositoryBranches,
    previewEnvironmentConfig: mockPreviewEnvironmentConfig,
    db: { models: { Build: { query: () => ({ findOne: mockBuildFindOne }) } } },
  })),
}));
jest.mock('server/services/override', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    db: { models: { Build: { query: () => ({ findOne: mockBuildFindOne }) } } },
  })),
}));
jest.mock('server/services/apiToken', () => {
  const actual = jest.requireActual('server/services/apiToken');
  return { __esModule: true, ...actual, default: { verifyToken: jest.fn(), touchLastUsed: jest.fn() } };
});
jest.mock('server/lib/get-user', () => ({ getRequestUserIdentity: jest.fn() }));
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

import { NextRequest } from 'next/server';
import ApiTokenService from 'server/services/apiToken';
import { GET as listEnvironments, POST as createEnvironment } from 'src/app/api/v2/environments/route';
import {
  GET as getEnvironment,
  PATCH as patchEnvironment,
  DELETE as deleteEnvironment,
} from 'src/app/api/v2/environments/[uuid]/route';
import { POST as deployEnvironment } from 'src/app/api/v2/environments/[uuid]/deploy/route';
import { POST as extendEnvironment } from 'src/app/api/v2/environments/[uuid]/extend/route';
import { GET as listBranches } from 'src/app/api/v2/environments/branches/route';
import { GET as previewConfig } from 'src/app/api/v2/environments/config-preview/route';

const verifyToken = ApiTokenService.verifyToken as jest.Mock;
const getIdentity = jest.requireMock('server/lib/get-user').getRequestUserIdentity as jest.Mock;
const getAllConfigs = (jest.requireMock('server/services/globalConfig') as any).__getAllConfigs as jest.Mock;
const getConfig = (jest.requireMock('server/services/globalConfig') as any).__getConfig as jest.Mock;
const TOKEN = `lfc_${'a'.repeat(40)}`;
const originalEnableAuth = process.env.ENABLE_AUTH;

const writeToken = (allowlist: string[] | null = null) => {
  verifyToken.mockResolvedValue({ id: 7, name: 'ci', scopes: ['env:write'], repositoryAllowlist: allowlist });
};

const request = (method: string, body?: unknown, url = 'http://localhost/api/v2/environments') =>
  new NextRequest(url, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  process.env.ENABLE_AUTH = 'true';
  getIdentity.mockReturnValue(undefined);
  getAllConfigs.mockResolvedValue({ api_keys: { serviceAuthEnabled: true, personalAuthEnabled: true } });
  getConfig.mockResolvedValue({ serviceAuthEnabled: true, personalAuthEnabled: true });
});

afterEach(() => jest.clearAllMocks());

afterAll(() => {
  if (originalEnableAuth === undefined) delete process.env.ENABLE_AUTH;
  else process.env.ENABLE_AUTH = originalEnableAuth;
});

describe('POST /api/v2/environments', () => {
  it('401s without credentials', async () => {
    const res = await createEnvironment(new NextRequest('http://localhost/api/v2/environments', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('400s invalid bodies before touching the service', async () => {
    writeToken();
    const res = await createEnvironment(request('POST', { repository: 'org/repo' }));
    expect(res.status).toBe(400);
    expect(mockCreateApiEnvironment).not.toHaveBeenCalled();
  });

  it('400s arrays, malformed services, scalar type mismatches, and non-integer TTLs', async () => {
    writeToken();
    const base = { repository: 'org/repo', branch: 'main' };
    const invalidBodies = [
      [],
      { ...base, services: {} },
      { ...base, services: [null] },
      { ...base, services: [[]] },
      { ...base, services: [{}] },
      { ...base, services: [{ name: '' }] },
      { ...base, services: [{ name: 'web', active: 'yes' }] },
      { ...base, services: [{ name: 'web', branchOrExternalUrl: 3 }] },
      {
        ...base,
        services: [
          { name: 'web', active: true },
          { name: 'web', active: false },
        ],
      },
      { ...base, deployEnabled: 1 },
      { ...base, trackDefaultBranches: 'false' },
      { ...base, autoTrack: null },
      { ...base, ttlHours: '12' },
      { ...base, ttlHours: 1.5 },
      { ...base, ttlHours: 0 },
      { ...base, ttlHours: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, environmentId: '1' },
      { ...base, environmentId: 1.5 },
      { ...base, environmentId: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, sha: 123 },
      { ...base, idempotencyKey: 123 },
      { ...base, env: null },
      { ...base, initEnv: null },
    ];

    for (const body of invalidBodies) {
      const res = await createEnvironment(request('POST', body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_body');
    }
    expect(mockCreateApiEnvironment).not.toHaveBeenCalled();
  });

  it('400s unknown top-level and service-override fields, naming the offender', async () => {
    writeToken();
    const base = { repository: 'org/repo', branch: 'main' };

    const topLevel = await createEnvironment(request('POST', { ...base, bogusField: 1 }));
    expect(topLevel.status).toBe(400);
    const topLevelBody = await topLevel.json();
    expect(topLevelBody.error.code).toBe('invalid_body');
    expect(topLevelBody.error.message).toContain('"bogusField"');

    const typo = await createEnvironment(request('POST', { ...base, ttlHour: 12 }));
    expect(typo.status).toBe(400);
    expect((await typo.json()).error.message).toContain('"ttlHour"');

    const nested = await createEnvironment(
      request('POST', { ...base, services: [{ name: 'web', branch: 'feature' }] })
    );
    expect(nested.status).toBe(400);
    const nestedBody = await nested.json();
    expect(nestedBody.error.code).toBe('invalid_body');
    expect(nestedBody.error.message).toContain('services[0]');
    expect(nestedBody.error.message).toContain('"branch"');

    expect(mockCreateApiEnvironment).not.toHaveBeenCalled();
  });

  it('422s autoTrack with an immutable sha before touching the service', async () => {
    writeToken();

    const res = await createEnvironment(
      request('POST', { repository: 'org/repo', branch: 'main', sha: 'abc123', autoTrack: true })
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('auto_track_pinned_source');
    expect(mockCreateApiEnvironment).not.toHaveBeenCalled();
  });

  it('400s env/initEnv values that are not flat string maps', async () => {
    writeToken();

    for (const body of [
      { repository: 'org/repo', branch: 'main', env: { GROUP: { KEY: '{{vault:prod/db:password}}' } } },
      { repository: 'org/repo', branch: 'main', env: { PORT: 3000 } },
      { repository: 'org/repo', branch: 'main', env: ['{{vault:prod/db:password}}'] },
      { repository: 'org/repo', branch: 'main', initEnv: { LIST: ['{{vault:prod/db:password}}'] } },
    ]) {
      const res = await createEnvironment(request('POST', body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_body');
    }
    expect(mockCreateApiEnvironment).not.toHaveBeenCalled();
  });

  it('400s a non-string name before any service work', async () => {
    writeToken();

    const res = await createEnvironment(request('POST', { repository: 'org/repo', branch: 'main', name: 123 }));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(mockCreateApiEnvironment).not.toHaveBeenCalled();
  });

  it('403s repositories outside the token allowlist with a stable code', async () => {
    writeToken(['org/other']);
    const res = await createEnvironment(request('POST', { repository: 'org/repo', branch: 'main' }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden_repository');
    expect(mockCreateApiEnvironment).not.toHaveBeenCalled();
  });

  it('202s a new environment with the poll contract and threads token attribution', async () => {
    writeToken(['org/repo']);
    mockCreateApiEnvironment.mockResolvedValue({
      build: { uuid: 'happy-env-123456', status: 'queued', namespace: 'env-happy-env-123456', expiresAt: 'later' },
      replayed: false,
    });

    const res = await createEnvironment(
      request('POST', { repository: 'org/repo', branch: 'main', ttlHours: 48, idempotencyKey: 'k1' })
    );
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.data).toMatchObject({
      uuid: 'happy-env-123456',
      status: 'queued',
      statusUrl: '/api/v2/environments/happy-env-123456',
      replayed: false,
    });
    expect(mockCreateApiEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'org/repo',
        branch: 'main',
        ttlHours: 48,
        idempotencyKey: 'k1',
        createdByTokenId: 7,
      }),
      null
    );
  });

  it('forwards a repository-constrained key allowlist so an idempotent replay is re-authorized', async () => {
    verifyToken.mockResolvedValue({
      id: 7,
      name: 'ci',
      scopes: ['env:write'],
      repositoryAllowlist: ['org/repo'],
      repositoryAllowlistRepoIds: [42],
    });
    mockRepositoryFirst.mockResolvedValue({ githubRepositoryId: 42 });
    mockCreateApiEnvironment.mockResolvedValue({ build: { uuid: 'scoped-env-1' }, replayed: false });

    const res = await createEnvironment(
      request('POST', { repository: 'org/repo', branch: 'main', idempotencyKey: 'k1' })
    );

    expect(res.status).toBe(202);
    expect(mockCreateApiEnvironment).toHaveBeenCalledWith(expect.any(Object), [42]);
  });

  it('200s an idempotent replay', async () => {
    writeToken();
    mockCreateApiEnvironment.mockResolvedValue({
      build: { uuid: 'existing-env-1', status: 'deployed', namespace: 'env-existing-env-1', expiresAt: null },
      replayed: true,
    });

    const res = await createEnvironment(
      request('POST', { repository: 'org/repo', branch: 'main', idempotencyKey: 'k1' })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.replayed).toBe(true);
  });

  it('propagates typed service errors (e.g. config_invalid 422)', async () => {
    writeToken();
    const { AppError } = jest.requireActual('server/lib/appError');
    mockCreateApiEnvironment.mockRejectedValue(
      new AppError({ httpStatus: 422, code: 'config_invalid', message: 'bad yaml' })
    );

    const res = await createEnvironment(request('POST', { repository: 'org/repo', branch: 'main' }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error.code).toBe('config_invalid');
  });
});

describe('GET /api/v2/environments', () => {
  it('wires query params through, including token-scoped mine and the repository allowlist', async () => {
    writeToken(['org/repo']);
    mockListEnvironments.mockResolvedValue({ data: [], paginationMetadata: { page: 1 } });

    const res = await listEnvironments(
      request(
        'GET',
        undefined,
        'http://localhost/api/v2/environments?mine=true&trigger=api&search=foo&exclude=torn_down,error&hasReadyActiveService=true'
      )
    );

    expect(res.status).toBe(200);
    expect(mockListEnvironments).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeStatuses: 'torn_down,error',
        search: 'foo',
        trigger: 'api',
        hasReadyActiveService: true,
        createdByTokenId: 7,
        githubLogin: null,
        repositoryAllowlist: ['org/repo'],
      })
    );
  });

  it('rejects an invalid ready-service filter instead of silently broadening the list', async () => {
    writeToken();

    const res = await listEnvironments(
      request('GET', undefined, 'http://localhost/api/v2/environments?hasReadyActiveService=yes')
    );

    expect(res.status).toBe(400);
    expect(mockListEnvironments).not.toHaveBeenCalled();
  });
});

describe('GET /api/v2/environments as a JWT user', () => {
  const jwtRequest = (url: string) => new NextRequest(url, { method: 'GET' });

  it('allows mine=true for users without a linked GitHub identity, keyed on their sub', async () => {
    getIdentity.mockReturnValue({ userId: 'u-1', roles: ['user'] });
    mockListEnvironments.mockResolvedValue({ data: [], paginationMetadata: { page: 1 } });

    const res = await listEnvironments(jwtRequest('http://localhost/api/v2/environments?mine=true'));

    expect(res.status).toBe(200);
    expect(mockListEnvironments).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'u-1', githubLogin: null })
    );
  });

  it('threads the GitHub login for mine=true users with a linked identity', async () => {
    getIdentity.mockReturnValue({ userId: 'u-1', roles: ['user'], githubUsername: 'octocat' });
    mockListEnvironments.mockResolvedValue({ data: [], paginationMetadata: { page: 1 } });

    const res = await listEnvironments(jwtRequest('http://localhost/api/v2/environments?mine=true'));

    expect(res.status).toBe(200);
    expect(mockListEnvironments).toHaveBeenCalledWith(
      expect.objectContaining({ createdByTokenId: null, githubLogin: 'octocat' })
    );
  });
});

const mockWhereKind = jest.fn();
const mockBuildLookup = (build: unknown) => {
  if (
    build &&
    typeof build === 'object' &&
    !Array.isArray(build) &&
    !Object.prototype.hasOwnProperty.call(build, 'id')
  ) {
    Object.assign(build, { id: 101 });
  }
  mockWhereKind.mockImplementation(() => ({
    whereNull: () => ({ withGraphFetched: jest.fn().mockResolvedValue(build) }),
  }));
  mockBuildFindOne.mockReturnValue({ where: mockWhereKind });
};

describe('GET /api/v2/environments/{uuid}', () => {
  it('404s with env_not_found', async () => {
    writeToken();
    mockBuildLookup(undefined);

    const res = await getEnvironment(request('GET', undefined, 'http://localhost/api/v2/environments/x'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('env_not_found');
  });

  it('403s environments outside a repo-scoped token allowlist', async () => {
    writeToken(['org/allowed']);
    mockBuildLookup({ uuid: 'x', pullRequest: { fullName: 'org/other', repository: { fullName: 'org/other' } } });

    const res = await getEnvironment(request('GET', undefined, 'http://localhost/api/v2/environments/x'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden_repository');
    expect(mockGetEnvironmentDetail).not.toHaveBeenCalled();
  });

  it('200s an allowlisted environment', async () => {
    writeToken(['org/allowed']);
    mockBuildLookup({ uuid: 'x', pullRequest: { fullName: 'org/allowed', repository: { fullName: 'org/allowed' } } });
    mockGetEnvironmentDetail.mockResolvedValue({ uuid: 'x', status: 'deployed' });

    const res = await getEnvironment(request('GET', undefined, 'http://localhost/api/v2/environments/x'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(200);
    expect(mockGetEnvironmentDetail).toHaveBeenCalledWith('x', 101);
  });

  it('404s when the authorized build is no longer live instead of returning a same-uuid successor', async () => {
    writeToken();
    mockBuildLookup({ id: 202, uuid: 'x', pullRequest: null });
    mockGetEnvironmentDetail.mockResolvedValue(null);

    const res = await getEnvironment(request('GET', undefined, 'http://localhost/api/v2/environments/x'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('env_not_found');
    expect(mockGetEnvironmentDetail).toHaveBeenCalledWith('x', 202);
  });
});

describe('PATCH /api/v2/environments/{uuid}', () => {
  it('403s a patch outside the token allowlist before mutating', async () => {
    writeToken(['org/allowed']);
    mockBuildLookup({
      uuid: 'x',
      pullRequest: { fullName: 'org/victim', repository: { fullName: 'org/victim' } },
      deploys: [],
    });

    const res = await patchEnvironment(
      request('PATCH', { env: { A: 'b' } }, 'http://localhost/api/v2/environments/x'),
      { params: { uuid: 'x' } }
    );

    expect(res.status).toBe(403);
    expect(mockApplyApiEnvironmentPatch).not.toHaveBeenCalled();
  });

  it('400s non-string env values before looking up the build', async () => {
    writeToken();

    const res = await patchEnvironment(
      request(
        'PATCH',
        { env: { GROUP: { KEY: '{{vault:prod/db:password}}' } } },
        'http://localhost/api/v2/environments/x'
      ),
      { params: { uuid: 'x' } }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(mockBuildFindOne).not.toHaveBeenCalled();
    expect(mockApplyApiEnvironmentPatch).not.toHaveBeenCalled();
  });

  it('400s arrays, malformed services, and non-boolean flags before looking up the build', async () => {
    writeToken();
    const invalidBodies = [
      [],
      { services: {} },
      { services: [null] },
      { services: [[]] },
      { services: null },
      { services: [{}] },
      { services: [{ name: '' }] },
      { services: [{ name: 'web', active: 1 }] },
      { services: [{ name: 'web', branchOrExternalUrl: false }] },
      {
        services: [
          { name: 'web', active: true },
          { name: 'web', active: false },
        ],
      },
      { deployEnabled: 'false' },
      { autoTrack: 1 },
      { trackDefaultBranches: null },
      { env: null },
      { initEnv: null },
    ];

    for (const body of invalidBodies) {
      const res = await patchEnvironment(request('PATCH', body, 'http://localhost/api/v2/environments/x'), {
        params: { uuid: 'x' },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_body');
    }
    expect(mockBuildFindOne).not.toHaveBeenCalled();
    expect(mockApplyApiEnvironmentPatch).not.toHaveBeenCalled();
  });

  it('400s unknown PATCH fields before looking up the build', async () => {
    writeToken();

    for (const body of [{ ttlHours: 12 }, { services: [{ name: 'web', enabled: true }] }]) {
      const res = await patchEnvironment(request('PATCH', body, 'http://localhost/api/v2/environments/x'), {
        params: { uuid: 'x' },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_body');
    }
    expect(mockBuildFindOne).not.toHaveBeenCalled();
    expect(mockApplyApiEnvironmentPatch).not.toHaveBeenCalled();
  });

  it('422s autoTrack for a pinned environment before mutating it', async () => {
    writeToken();
    mockBuildLookup({ id: 303, uuid: 'x', configSha: 'abc123', pullRequest: null, deploys: [] });

    const res = await patchEnvironment(
      request('PATCH', { autoTrack: true }, 'http://localhost/api/v2/environments/x'),
      { params: { uuid: 'x' } }
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('auto_track_pinned_source');
    expect(mockApplyApiEnvironmentPatch).not.toHaveBeenCalled();
  });

  it('applies the patch through the service and returns fresh detail', async () => {
    writeToken();
    const build = { uuid: 'x', pullRequest: null, deploys: [] };
    mockBuildLookup(build);
    mockGetEnvironmentDetail.mockResolvedValue({ uuid: 'x', status: 'deployed' });

    const res = await patchEnvironment(
      request('PATCH', { deployEnabled: false, env: { A: 'b' } }, 'http://localhost/api/v2/environments/x'),
      { params: { uuid: 'x' } }
    );

    expect(res.status).toBe(200);
    expect(mockApplyApiEnvironmentPatch).toHaveBeenCalledWith(
      build,
      expect.anything(),
      expect.objectContaining({ deployEnabled: false, env: { A: 'b' } })
    );
    expect(mockGetEnvironmentDetail).toHaveBeenCalledWith('x', 101);
  });

  it('keeps omitted PATCH fields as no-ops', async () => {
    writeToken();
    const build = { id: 606, uuid: 'x', pullRequest: null, deploys: [] };
    mockBuildLookup(build);
    mockGetEnvironmentDetail.mockResolvedValue({ uuid: 'x', status: 'deployed' });

    const res = await patchEnvironment(request('PATCH', {}, 'http://localhost/api/v2/environments/x'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(200);
    expect(mockApplyApiEnvironmentPatch).toHaveBeenCalledWith(build, expect.anything(), {
      services: null,
      env: null,
      initEnv: null,
      deployEnabled: undefined,
      autoTrack: undefined,
      trackDefaultBranches: undefined,
    });
  });

  it('404s after applying a patch if the authorized build was replaced', async () => {
    writeToken();
    mockBuildLookup({ id: 404, uuid: 'x', pullRequest: null, deploys: [] });
    mockGetEnvironmentDetail.mockResolvedValue(null);

    const res = await patchEnvironment(
      request('PATCH', { deployEnabled: false }, 'http://localhost/api/v2/environments/x'),
      { params: { uuid: 'x' } }
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('env_not_found');
    expect(mockGetEnvironmentDetail).toHaveBeenCalledWith('x', 404);
  });

  it('409s when teardown claims the authorized build before the patch mutates it', async () => {
    writeToken();
    const { AppError } = jest.requireActual('server/lib/appError');
    mockBuildLookup({ id: 707, uuid: 'x', pullRequest: null, deploys: [] });
    mockApplyApiEnvironmentPatch.mockRejectedValue(
      new AppError({
        httpStatus: 409,
        code: 'env_tearing_down',
        message: 'Environment x is being torn down.',
      })
    );

    const res = await patchEnvironment(
      request('PATCH', { env: { A: 'b' } }, 'http://localhost/api/v2/environments/x'),
      { params: { uuid: 'x' } }
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('env_tearing_down');
    expect(mockGetEnvironmentDetail).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v2/environments/{uuid}', () => {
  it('409s static environments with env_static_protected', async () => {
    writeToken();
    mockBuildLookup({ uuid: 'x', isStatic: true, pullRequest: null, githubRepositoryId: null });

    const res = await deleteEnvironment(request('DELETE', undefined, 'http://localhost/api/v2/environments/x'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('env_static_protected');
    expect(mockRequestApiEnvironmentDeletion).not.toHaveBeenCalled();
  });

  it('403s teardown of a webhook PR environment outside the token allowlist', async () => {
    writeToken(['org/allowed']);
    mockBuildLookup({
      uuid: 'x',
      isStatic: false,
      pullRequest: { fullName: 'org/victim', repository: { fullName: 'org/victim' } },
    });

    const res = await deleteEnvironment(request('DELETE', undefined, 'http://localhost/api/v2/environments/x'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(403);
    expect(mockRequestApiEnvironmentDeletion).not.toHaveBeenCalled();
  });

  it('202s after atomically claiming teardown for the exact authorized PR-less environment', async () => {
    writeToken();
    const build = {
      id: 707,
      uuid: 'x',
      isStatic: false,
      pullRequest: null,
      pullRequestId: null,
      githubRepositoryId: null,
    };
    mockBuildLookup(build);
    mockRequestApiEnvironmentDeletion.mockResolvedValue({ ...build, status: 'tearing_down' });

    const res = await deleteEnvironment(request('DELETE', undefined, 'http://localhost/api/v2/environments/x'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(202);
    expect(mockRequestApiEnvironmentDeletion).toHaveBeenCalledWith('x', 707);
    expect(await res.json()).toMatchObject({ data: { uuid: 'x', status: 'tearing_down_queued' } });
  });

  it.each(['tearing_down', 'torn_down'])(
    'does not mint a new teardown token for an environment already %s',
    async (status) => {
      writeToken();
      const build = {
        id: 707,
        uuid: 'x',
        status,
        runUUID: 'existing-run',
        isStatic: false,
        pullRequest: null,
        pullRequestId: null,
        githubRepositoryId: null,
      };
      mockBuildLookup(build);
      mockRequestApiEnvironmentDeletion.mockResolvedValue(build);

      const res = await deleteEnvironment(request('DELETE', undefined, 'http://localhost/api/v2/environments/x'), {
        params: { uuid: 'x' },
      });

      expect(res.status).toBe(202);
      expect(mockRequestApiEnvironmentDeletion).toHaveBeenCalledWith('x', 707);
    }
  );

  it('does not touch the deploy gate when deleting PR-created environments', async () => {
    writeToken();
    const build = {
      id: 707,
      uuid: 'x',
      isStatic: false,
      pullRequest: { fullName: 'org/repo', repository: { fullName: 'org/repo' } },
      pullRequestId: 5,
    };
    mockBuildLookup(build);
    mockRequestApiEnvironmentDeletion.mockResolvedValue(build);

    const res = await deleteEnvironment(request('DELETE', undefined, 'http://localhost/api/v2/environments/x'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(202);
    expect(mockRequestApiEnvironmentDeletion).toHaveBeenCalledWith('x', 707);
  });
});

describe('per-uuid routes are scoped to environment-kind builds', () => {
  it('404s uuids that resolve to non-environment builds and pins the kind filter on every handler', async () => {
    writeToken();
    mockBuildLookup(undefined);
    const url = 'http://localhost/api/v2/environments/sandbox-uuid-1';
    const ctx = { params: { uuid: 'sandbox-uuid-1' } };

    const responses = [
      await getEnvironment(request('GET', undefined, url), ctx),
      await patchEnvironment(request('PATCH', { env: { A: 'b' } }, url), ctx),
      await deleteEnvironment(request('DELETE', undefined, url), ctx),
      await deployEnvironment(request('POST', {}, `${url}/deploy`), ctx),
      await extendEnvironment(request('POST', {}, `${url}/extend`), ctx),
    ];

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('env_not_found');
    }
    expect(mockWhereKind).toHaveBeenCalledTimes(5);
    for (const call of mockWhereKind.mock.calls) {
      expect(call).toEqual(['kind', 'environment']);
    }
  });
});

describe('POST /api/v2/environments/{uuid}/deploy', () => {
  it('403s a deploy outside the token allowlist before redeploying', async () => {
    writeToken(['org/allowed']);
    mockBuildLookup({
      uuid: 'x',
      deployEnabled: true,
      pullRequest: { fullName: 'org/victim', repository: { fullName: 'org/victim' } },
    });

    const res = await deployEnvironment(request('POST', {}, 'http://localhost/api/v2/environments/x/deploy'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(403);
    expect(mockRedeployBuild).not.toHaveBeenCalled();
  });

  it('409s when deploys are paused', async () => {
    writeToken();
    mockBuildLookup({ uuid: 'x', pullRequest: null, deployEnabled: false });

    const res = await deployEnvironment(request('POST', {}, 'http://localhost/api/v2/environments/x/deploy'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('deploy_disabled');
    expect(mockRedeployBuild).not.toHaveBeenCalled();
  });

  it('202s and queues a redeploy for enabled environments', async () => {
    writeToken();
    mockBuildLookup({ uuid: 'x', pullRequest: null, deployEnabled: true });

    const res = await deployEnvironment(request('POST', {}, 'http://localhost/api/v2/environments/x/deploy'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(202);
    expect(mockRedeployBuild).toHaveBeenCalledWith('x', 101);
  });

  it('404s instead of redeploying a same-uuid successor when the authorized build disappeared', async () => {
    writeToken();
    mockBuildLookup({ id: 505, uuid: 'x', pullRequest: null, deployEnabled: true });
    mockRedeployBuild.mockResolvedValue({ status: 'not_found' });

    const res = await deployEnvironment(request('POST', {}, 'http://localhost/api/v2/environments/x/deploy'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('env_not_found');
    expect(mockRedeployBuild).toHaveBeenCalledWith('x', 505);
  });

  it('409s when teardown claims the authorized build before redeploy enqueue', async () => {
    writeToken();
    mockBuildLookup({ id: 808, uuid: 'x', pullRequest: null, deployEnabled: true });
    mockRedeployBuild.mockResolvedValue({ status: 'tearing_down' });

    const res = await deployEnvironment(request('POST', {}, 'http://localhost/api/v2/environments/x/deploy'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('env_tearing_down');
    expect(mockRedeployBuild).toHaveBeenCalledWith('x', 808);
  });

  it('409s when a concurrent pause wins before redeploy enqueue', async () => {
    writeToken();
    mockBuildLookup({ id: 809, uuid: 'x', pullRequest: null, deployEnabled: true });
    mockRedeployBuild.mockResolvedValue({ status: 'deploy_disabled' });

    const res = await deployEnvironment(request('POST', {}, 'http://localhost/api/v2/environments/x/deploy'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('deploy_disabled');
    expect(mockRedeployBuild).toHaveBeenCalledWith('x', 809);
  });
});

describe('POST /api/v2/environments/{uuid}/extend', () => {
  it('403s an extension outside the token allowlist', async () => {
    writeToken(['org/allowed']);
    mockBuildLookup({ uuid: 'x', pullRequest: { fullName: 'org/victim', repository: { fullName: 'org/victim' } } });

    const res = await extendEnvironment(request('POST', {}, 'http://localhost/api/v2/environments/x/extend'), {
      params: { uuid: 'x' },
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden_repository');
    expect(mockExtendApiEnvironment).not.toHaveBeenCalled();
  });

  it('400s non-positive hours', async () => {
    writeToken();
    const res = await extendEnvironment(
      request('POST', { hours: -1 }, 'http://localhost/api/v2/environments/x/extend'),
      { params: { uuid: 'x' } }
    );
    expect(res.status).toBe(400);
  });

  it('400s string, fractional, null, and non-finite hours before looking up the build', async () => {
    writeToken();

    for (const hours of ['12', 1.5, null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const res = await extendEnvironment(request('POST', { hours }, 'http://localhost/api/v2/environments/x/extend'), {
        params: { uuid: 'x' },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_body');
    }
    expect(mockBuildFindOne).not.toHaveBeenCalled();
    expect(mockExtendApiEnvironment).not.toHaveBeenCalled();
  });

  it('400s malformed JSON instead of silently applying the default extension', async () => {
    writeToken();
    const req = new NextRequest('http://localhost/api/v2/environments/x/extend', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{',
    });

    const res = await extendEnvironment(req, { params: { uuid: 'x' } });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(mockExtendApiEnvironment).not.toHaveBeenCalled();
  });

  it('returns the new lease', async () => {
    writeToken();
    mockBuildLookup({ uuid: 'x', pullRequest: null, githubRepositoryId: null });
    mockExtendApiEnvironment.mockResolvedValue({ uuid: 'x', expiresAt: 'later' });

    const res = await extendEnvironment(
      request('POST', { hours: 12 }, 'http://localhost/api/v2/environments/x/extend'),
      {
        params: { uuid: 'x' },
      }
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ uuid: 'x', expiresAt: 'later' });
    expect(mockExtendApiEnvironment).toHaveBeenCalledWith('x', 12, 101);
  });
});

describe('GET /api/v2/environments/branches', () => {
  const url = (qs: string) => `http://localhost/api/v2/environments/branches${qs}`;

  it('401s without credentials', async () => {
    const res = await listBranches(new NextRequest(url('?repository=org/repo')));
    expect(res.status).toBe(401);
  });

  it('400s without a repository param', async () => {
    writeToken();
    const res = await listBranches(request('GET', undefined, url('')));
    expect(res.status).toBe(400);
    expect(mockListRepositoryBranches).not.toHaveBeenCalled();
  });

  it('403s a repository outside the token allowlist', async () => {
    writeToken(['org/allowed']);
    const res = await listBranches(request('GET', undefined, url('?repository=org/other')));
    expect(res.status).toBe(403);
    expect(mockListRepositoryBranches).not.toHaveBeenCalled();
  });

  it('200s with branches and defaultBranch', async () => {
    writeToken();
    mockListRepositoryBranches.mockResolvedValue({ branches: ['main', 'dev'], defaultBranch: 'main' });
    const res = await listBranches(request('GET', undefined, url('?repository=org/repo')));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ branches: ['main', 'dev'], defaultBranch: 'main' });
    expect(mockListRepositoryBranches).toHaveBeenCalledWith('org/repo');
  });
});

describe('GET /api/v2/environments/config-preview', () => {
  const url = (qs: string) => `http://localhost/api/v2/environments/config-preview${qs}`;

  it('400s without repository or branch', async () => {
    writeToken();
    const noRepo = await previewConfig(request('GET', undefined, url('?branch=main')));
    expect(noRepo.status).toBe(400);
    const noBranch = await previewConfig(request('GET', undefined, url('?repository=org/repo')));
    expect(noBranch.status).toBe(400);
    expect(mockPreviewEnvironmentConfig).not.toHaveBeenCalled();
  });

  it('403s a repository outside the token allowlist', async () => {
    writeToken(['org/allowed']);
    const res = await previewConfig(request('GET', undefined, url('?repository=org/other&branch=main')));
    expect(res.status).toBe(403);
    expect(mockPreviewEnvironmentConfig).not.toHaveBeenCalled();
  });

  it('200s with the parsed service preview', async () => {
    writeToken();
    mockPreviewEnvironmentConfig.mockResolvedValue({
      valid: true,
      services: [{ name: 'web', type: 'github', defaultActive: true, editable: true }],
    });
    const res = await previewConfig(request('GET', undefined, url('?repository=org/repo&branch=main')));
    expect(res.status).toBe(200);
    expect((await res.json()).data.services[0].name).toBe('web');
    expect(mockPreviewEnvironmentConfig).toHaveBeenCalledWith('org/repo', 'main');
  });
});
