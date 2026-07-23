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

const mockWarn = jest.fn();
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: mockWarn, info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockRepositoryFindOne = jest.fn();
const mockRepositoryWhereNull = jest.fn();
jest.mock('server/models', () => ({
  Repository: {
    query: () => ({
      findOne: (...args: unknown[]) => {
        mockRepositoryFindOne(...args);
        return { whereNull: (...whereArgs: unknown[]) => mockRepositoryWhereNull(...whereArgs) };
      },
    }),
  },
}));

import { getBuildSource, isDeployEnabled, resolveBuildSourceRepository } from 'server/lib/buildSource';
import type Build from 'server/models/Build';

const prBuild = (deployOnUpdate: boolean, extra: Record<string, unknown> = {}) =>
  ({
    uuid: 'happy-otter-123456',
    pullRequest: {
      fullName: 'org/repo',
      branchName: 'feature-1',
      deployOnUpdate,
      repository: { githubRepositoryId: 42 },
    },
    ...extra,
  } as unknown as Build);

const apiBuild = (extra: Record<string, unknown> = {}) =>
  ({
    uuid: 'calm-river-654321',
    pullRequest: null,
    githubRepositoryId: 42,
    branchName: 'main',
    configSha: null,
    ...extra,
  } as unknown as Build);

afterEach(() => jest.clearAllMocks());

describe('isDeployEnabled', () => {
  it('returns the literal pullRequest.deployOnUpdate whenever a PR exists', () => {
    expect(isDeployEnabled(prBuild(true))).toBe(true);
    expect(isDeployEnabled(prBuild(false))).toBe(false);
  });

  it('never consults build.deployEnabled when a PR exists', () => {
    expect(isDeployEnabled(prBuild(false, { deployEnabled: true }))).toBe(false);
    expect(isDeployEnabled(prBuild(true, { deployEnabled: false }))).toBe(true);
  });

  it('gates PR-less builds on deployEnabled === true only', () => {
    expect(isDeployEnabled(apiBuild({ deployEnabled: true }))).toBe(true);
    expect(isDeployEnabled(apiBuild({ deployEnabled: false }))).toBe(false);
    expect(isDeployEnabled(apiBuild())).toBe(false);
    expect(isDeployEnabled(apiBuild({ deployEnabled: null }))).toBe(false);
  });
});

describe('getBuildSource', () => {
  it('prefers the PullRequest and returns exactly its values', () => {
    const build = prBuild(true);
    const source = getBuildSource(build);

    expect(source.fullName).toBe('org/repo');
    expect(source.branchName).toBe('feature-1');
    expect(source.githubRepositoryId).toBe(42);
    expect(source.configSha).toBeNull();
    expect(source.pullRequest).toBe(build.pullRequest);
  });

  it('ignores build source columns when a PR exists (prefer-PR adapter)', () => {
    const build = prBuild(true, { branchName: 'divergent', githubRepositoryId: 999 });
    const source = getBuildSource(build);

    expect(source.branchName).toBe('feature-1');
    expect(source.githubRepositoryId).toBe(42);
  });

  it('reads the build trigger columns for PR-less builds', () => {
    const source = getBuildSource(apiBuild({ configSha: 'abc123' }));

    expect(source.fullName).toBeNull();
    expect(source.branchName).toBe('main');
    expect(source.githubRepositoryId).toBe(42);
    expect(source.configSha).toBe('abc123');
    expect(source.pullRequest).toBeNull();
  });

  it('shadow-compares sampled webhook builds and logs divergence without throwing', () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    const build = prBuild(true, { branchName: 'divergent', githubRepositoryId: 42 });

    const source = getBuildSource(build);

    expect(source.branchName).toBe('feature-1');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('shadow-compare divergence'));
    random.mockRestore();
  });

  it('does not shadow-compare when the build carries no source columns', () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    getBuildSource(prBuild(true));

    expect(mockWarn).not.toHaveBeenCalled();
    random.mockRestore();
  });
});

describe('resolveBuildSourceRepository', () => {
  it('returns the already-loaded pullRequest.repository without any fetch', async () => {
    const build = prBuild(true);
    (build.pullRequest as any).$fetchGraph = jest.fn();

    const repository = await resolveBuildSourceRepository(build);

    expect(repository).toBe(build.pullRequest!.repository);
    expect((build.pullRequest as any).$fetchGraph).not.toHaveBeenCalled();
    expect(mockRepositoryFindOne).not.toHaveBeenCalled();
  });

  it('fetches the PR repository graph when not loaded', async () => {
    const build = prBuild(true);
    const fetched = { githubRepositoryId: 42, fullName: 'org/repo' };
    delete (build.pullRequest as any).repository;
    (build.pullRequest as any).$fetchGraph = jest.fn().mockImplementation(async function (this: any) {
      this.repository = fetched;
    });

    const repository = await resolveBuildSourceRepository(build);

    expect(repository).toBe(fetched);
    expect((build.pullRequest as any).$fetchGraph).toHaveBeenCalledWith('[repository]');
  });

  it('looks PR-less builds up by the githubRepositoryId join key', async () => {
    const record = { githubRepositoryId: 42, fullName: 'org/repo' };
    mockRepositoryWhereNull.mockResolvedValue(record);

    const repository = await resolveBuildSourceRepository(apiBuild());

    expect(repository).toBe(record);
    expect(mockRepositoryFindOne).toHaveBeenCalledWith({ githubRepositoryId: 42 });
    expect(mockRepositoryWhereNull).toHaveBeenCalledWith('deletedAt');
  });

  it('returns null when a PR-less build has no source repository id', async () => {
    expect(await resolveBuildSourceRepository(apiBuild({ githubRepositoryId: null }))).toBeNull();
    expect(mockRepositoryFindOne).not.toHaveBeenCalled();
  });

  it('does not resolve a soft-deleted PR-less source repository', async () => {
    mockRepositoryWhereNull.mockResolvedValue(null);

    await expect(resolveBuildSourceRepository(apiBuild())).resolves.toBeNull();
    expect(mockRepositoryWhereNull).toHaveBeenCalledWith('deletedAt');
  });
});
