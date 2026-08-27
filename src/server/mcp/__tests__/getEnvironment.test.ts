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

const mockGetBuildByUUID = jest.fn();
const mockRepositoryQuery = jest.fn();

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getBuildByUUID: (...args: unknown[]) => mockGetBuildByUUID(...args),
  })),
}));

jest.mock('server/models/Repository', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockRepositoryQuery(...args),
  },
}));

import type Build from 'server/models/Build';
import { BuildKind, BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';
import {
  isEnvironmentBuild,
  resolveNamedEnvironmentRead,
  resolveNamedEnvironmentReadDependencies,
  serializeEnvironmentState,
  type LoadedEnvironment,
} from '../tools/core/getEnvironment';

function environmentBuild(overrides: Record<string, unknown> = {}): Build {
  return {
    id: 41,
    uuid: 'candidate-123456',
    kind: BuildKind.ENVIRONMENT,
    status: BuildStatus.DEPLOYED,
    branchName: 'main',
    triggerType: 'api',
    isStatic: false,
    deployEnabled: true,
    autoTrack: false,
    trackDefaultBranches: false,
    namespace: 'env-candidate-123456',
    commentRuntimeEnv: {},
    commentInitEnv: {},
    deploys: [],
    ...overrides,
  } as unknown as Build;
}

function loaded(build: Build): LoadedEnvironment {
  return {
    build,
    repository: { githubRepositoryId: 7, fullName: 'goodrx/example' },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('serializeEnvironmentState', () => {
  it('sanitizes detailed service fields, invalid URLs, dependencies, and failures', () => {
    const build = environmentBuild({
      status: BuildStatus.ERROR,
      deploys: [
        {
          active: true,
          status: DeployStatus.ERROR,
          statusMessage: 'container failed',
          branchName: 'feature/test',
          sha: 'abc123',
          dockerImage: 'registry.example/api:abc123',
          publicHref: 'http://[',
          deployable: {
            name: 'api',
            type: DeployTypes.DOCKER,
            deploymentDependsOn: ['database', 'database', ' cache '],
          },
        },
      ],
    });

    const result = serializeEnvironmentState(loaded(build), { format: 'detailed' });

    expect(result).toMatchObject({
      format: 'detailed',
      environmentId: 41,
      repository: 'goodrx/example',
      failingServices: ['api'],
      servicesTruncated: false,
      services: [
        {
          name: 'api',
          type: 'docker',
          status: 'error',
          active: true,
          branch: 'feature/test',
          statusMessage: 'container failed',
          sha: 'abc123',
          dockerImage: 'registry.example/api:abc123',
          dependsOn: ['cache', 'database'],
        },
      ],
    });
    expect((result.services as Array<Record<string, unknown>>)[0]).not.toHaveProperty('url');
  });

  it('uses concise defaults and omits non-HTTP service addresses', () => {
    const result = serializeEnvironmentState(
      loaded(
        environmentBuild({
          deploys: [
            {
              active: true,
              status: DeployStatus.READY,
              publicHref: 'ftp://files.example.test/archive',
              deployable: { name: 'files', type: null },
            },
            { active: false, status: DeployStatus.READY, deployable: { name: '', type: DeployTypes.DOCKER } },
          ],
        })
      )
    );

    expect(result.format).toBe('concise');
    expect(result.services).toEqual([{ name: 'files', type: 'unknown', status: 'ready', active: true }]);
  });

  it.each([
    ['the deploys relation is not loaded', undefined],
    ['a deployable relation is not loaded', [{ active: true, status: DeployStatus.READY, deployable: undefined }]],
  ])('returns an empty service list when %s', (_description, deploys) => {
    const result = serializeEnvironmentState(loaded(environmentBuild({ deploys })));

    expect(result).toMatchObject({
      services: [],
      failingServices: [],
      servicesTruncated: false,
    });
    expect(result).not.toHaveProperty('note');
  });

  it('bounds oversized service collections by count and serialized response bytes', () => {
    const deploys = Array.from({ length: 101 }, (_, index) => ({
      active: true,
      status: DeployStatus.READY,
      dockerImage: `registry.example/${index}:${'x'.repeat(1100)}`,
      deployable: { name: `service-${String(index).padStart(3, '0')}`, type: DeployTypes.DOCKER },
    }));

    const result = serializeEnvironmentState(loaded(environmentBuild({ deploys })), { format: 'detailed' });

    expect((result.services as unknown[]).length).toBeLessThan(100);
    expect(result.servicesTruncated).toBe(true);
    expect(result.note).toMatch(/services omitted to keep the response bounded/);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(90_000);
  });

  it('reports the singular service omitted by the fixed service-count limit', () => {
    const deploys = Array.from({ length: 101 }, (_, index) => ({
      active: true,
      status: DeployStatus.READY,
      deployable: { name: `service-${index}`, type: DeployTypes.DOCKER },
    }));

    const result = serializeEnvironmentState(loaded(environmentBuild({ deploys })));

    expect((result.services as unknown[]).length).toBe(100);
    expect(result.note).toBe('1 service omitted to keep the response bounded.');
  });
});

describe('isEnvironmentBuild', () => {
  it('rejects absent builds as well as other persisted build kinds', () => {
    expect(isEnvironmentBuild(null)).toBe(false);
    expect(isEnvironmentBuild(undefined)).toBe(false);
    expect(isEnvironmentBuild(environmentBuild({ kind: BuildKind.SANDBOX }))).toBe(false);
    expect(isEnvironmentBuild(environmentBuild())).toBe(true);
  });
});

describe('resolveNamedEnvironmentReadDependencies', () => {
  it('loads a live environment and anchors it by GitHub repository id', async () => {
    const build = environmentBuild({ githubRepositoryId: 7 });
    const repository = { githubRepositoryId: 7, fullName: 'goodrx/example' };
    const whereNull = jest.fn().mockResolvedValue(repository);
    const findOne = jest.fn().mockReturnValue({ whereNull });
    mockGetBuildByUUID.mockResolvedValue(build);
    mockRepositoryQuery.mockReturnValue({ findOne });

    const dependencies = resolveNamedEnvironmentReadDependencies();

    await expect(dependencies.loadEnvironment('candidate-123456')).resolves.toEqual({ build, repository });
    expect(mockGetBuildByUUID).toHaveBeenCalledWith('candidate-123456', { liveOnly: true });
    expect(findOne).toHaveBeenCalledWith({ githubRepositoryId: 7 });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
  });

  it('falls back to pull-request identity when no repository-id anchor exists', async () => {
    const build = environmentBuild({
      githubRepositoryId: null,
      pullRequest: { fullName: 'GoodRx/Fallback' },
    });
    const query = {
      whereRaw: jest.fn(),
      whereNull: jest.fn(),
      first: jest.fn().mockResolvedValue(undefined),
    };
    query.whereRaw.mockReturnValue(query);
    query.whereNull.mockReturnValue(query);
    mockGetBuildByUUID.mockResolvedValue(build);
    mockRepositoryQuery.mockReturnValue(query);

    const dependencies = resolveNamedEnvironmentReadDependencies();

    await expect(dependencies.loadEnvironment('candidate-123456')).resolves.toEqual({
      build,
      repository: { githubRepositoryId: null, fullName: 'GoodRx/Fallback' },
    });
    expect(query.whereRaw).toHaveBeenCalledWith('lower("fullName") = ?', ['goodrx/fallback']);
  });

  it('retains a build repository id when the active repository row is missing', async () => {
    const build = environmentBuild({ githubRepositoryId: 7, pullRequest: null });
    const whereNull = jest.fn().mockResolvedValue(undefined);
    mockGetBuildByUUID.mockResolvedValue(build);
    mockRepositoryQuery.mockReturnValue({ findOne: jest.fn().mockReturnValue({ whereNull }) });

    const dependencies = resolveNamedEnvironmentReadDependencies();

    await expect(dependencies.loadEnvironment('candidate-123456')).resolves.toEqual({
      build,
      repository: { githubRepositoryId: 7, fullName: '' },
    });
  });

  it('does not query repositories when the build has no repository anchors', async () => {
    const build = environmentBuild({ githubRepositoryId: null, pullRequest: null });
    mockGetBuildByUUID.mockResolvedValue(build);

    const dependencies = resolveNamedEnvironmentReadDependencies();

    await expect(dependencies.loadEnvironment('candidate-123456')).resolves.toEqual({
      build,
      repository: { githubRepositoryId: null, fullName: '' },
    });
    expect(mockRepositoryQuery).not.toHaveBeenCalled();
  });

  it('keeps non-environment builds outside the live environment resolver', async () => {
    mockGetBuildByUUID.mockResolvedValue(environmentBuild({ kind: BuildKind.SANDBOX }));

    const dependencies = resolveNamedEnvironmentReadDependencies();

    await expect(dependencies.loadEnvironment('candidate-123456')).resolves.toBeNull();
    expect(mockRepositoryQuery).not.toHaveBeenCalled();
  });

  it('returns normalized destruction evidence only for deleted environment builds', async () => {
    const dependencies = resolveNamedEnvironmentReadDependencies();
    mockGetBuildByUUID.mockResolvedValueOnce(environmentBuild({ deletedAt: new Date('2026-07-20T00:00:00.000Z') }));

    await expect(dependencies.loadDestroyedEnvironment('candidate-123456')).resolves.toEqual({
      destroyedAt: '2026-07-20T00:00:00.000Z',
    });

    mockGetBuildByUUID.mockResolvedValueOnce(environmentBuild({ deletedAt: null }));
    await expect(dependencies.loadDestroyedEnvironment('candidate-123456')).resolves.toBeNull();
    expect(mockGetBuildByUUID).toHaveBeenLastCalledWith('candidate-123456', { liveOnly: false });
  });

  it('fails closed when persisted destruction time cannot be normalized', async () => {
    mockGetBuildByUUID.mockResolvedValue(environmentBuild({ deletedAt: 'not-a-date' }));

    const dependencies = resolveNamedEnvironmentReadDependencies();

    await expect(dependencies.loadDestroyedEnvironment('candidate-123456')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('resolveNamedEnvironmentRead destruction evidence', () => {
  it('uses the default build lookups and reports a stable error when no environment exists', async () => {
    mockGetBuildByUUID.mockResolvedValue(null);

    await expect(resolveNamedEnvironmentRead('missing-environment')).rejects.toMatchObject({
      code: 'env_not_found',
      message: 'That environment was not found.',
    });

    expect(mockGetBuildByUUID).toHaveBeenNthCalledWith(1, 'missing-environment', { liveOnly: true });
    expect(mockGetBuildByUUID).toHaveBeenNthCalledWith(2, 'missing-environment', { liveOnly: false });
    expect(mockRepositoryQuery).not.toHaveBeenCalled();
  });

  it('fails closed when injected destruction evidence has an invalid timestamp', async () => {
    await expect(
      resolveNamedEnvironmentRead('candidate-123456', {
        loadEnvironment: async () => null,
        loadDestroyedEnvironment: async () => ({ destroyedAt: 'not-a-date' }),
      })
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
