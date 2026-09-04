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

const mockBuildQuery = jest.fn();
const mockFetchLifecycleConfig = jest.fn();
const mockResolveBuildSourceRepository = jest.fn();

jest.mock('server/models/Build', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockBuildQuery(...args),
  },
}));

jest.mock('server/models/yaml', () => ({
  ...jest.requireActual('server/models/yaml'),
  fetchLifecycleConfig: (...args: unknown[]) => mockFetchLifecycleConfig(...args),
}));

jest.mock('server/lib/buildSource', () => ({
  ...jest.requireActual('server/lib/buildSource'),
  resolveBuildSourceRepository: (...args: unknown[]) => mockResolveBuildSourceRepository(...args),
}));

import { YamlConfigParser } from 'server/lib/yamlConfigParser';
import type { Deploy } from 'server/models';
import type Build from 'server/models/Build';
import {
  loadAgentSessionServiceCandidates,
  resolveAgentSessionCandidateBuildSource,
  resolveAgentSessionServiceCandidates,
  resolveAgentSessionServiceCandidatesForBuild,
  resolveRequestedAgentSessionServices,
} from '../agentSessionCandidates';
import { DeployStatus, DeployTypes } from 'shared/constants';

function buildManagedGithubLifecycleConfig(...serviceNames: string[]) {
  const services = serviceNames
    .map(
      (name) => `
  - name: '${name}'
    dev:
      image: 'repo/${name}:dev'
      command: 'pnpm dev'
    github:
      repository: 'example-org/example-repo'
      branchName: 'main'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: '${name}/Dockerfile'`
    )
    .join('');

  return new YamlConfigParser().parseYamlConfigFromString(`---
version: '1.0.0'
services:${services}
`);
}

function buildCandidate(
  name: string,
  repo: string,
  branch: string,
  deployId: number
): ReturnType<typeof resolveAgentSessionServiceCandidates>[number] {
  return {
    name,
    type: DeployTypes.GITHUB,
    deployId,
    devConfig: { image: 'node:20', command: 'pnpm dev' },
    repo,
    branch,
    revision: `revision-${deployId}`,
    baseDeploy: { id: deployId } as unknown as Deploy,
  };
}

describe('agentSessionCandidates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('includes only repo-local dev services backed by lifecycle-managed image builds', () => {
    const parser = new YamlConfigParser();
    const lifecycleConfig = parser.parseYamlConfigFromString(`---
version: '1.0.0'
services:
  - name: 'github-app'
    dev:
      image: 'repo/github-app:dev'
      command: 'npm run dev'
    github:
      repository: 'org/example'
      branchName: 'main'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: 'app/Dockerfile'
  - name: 'helm-app'
    dev:
      image: 'repo/helm-app:dev'
      command: 'npm run dev'
    helm:
      repository: 'org/example'
      branchName: 'main'
      chart:
        name: './helm/app'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: 'helm-app/Dockerfile'
  - name: 'redis'
    dev:
      image: 'repo/redis:dev'
      command: 'redis-server'
    helm:
      repository: 'org/example'
      branchName: 'main'
      chart:
        name: 'redis'
  - name: 'external-image'
    dev:
      image: 'repo/external-image:dev'
      command: 'sleep infinity'
    docker:
      dockerImage: 'docker.io/org/external-image'
      defaultTag: 'latest'
`);

    const deploys = [
      {
        id: 11,
        active: true,
        status: DeployStatus.DEPLOYED,
        deployable: { name: 'github-app', type: DeployTypes.GITHUB },
      },
      {
        id: 12,
        active: true,
        status: DeployStatus.READY,
        deployable: { name: 'helm-app', type: DeployTypes.HELM },
      },
      {
        id: 13,
        active: true,
        status: DeployStatus.DEPLOYED,
        deployable: { name: 'redis', type: DeployTypes.HELM },
      },
      {
        id: 14,
        active: true,
        status: DeployStatus.DEPLOYED,
        deployable: { name: 'external-image', type: DeployTypes.DOCKER },
      },
      {
        id: 15,
        active: true,
        status: DeployStatus.DEPLOYED,
        deployable: { name: 'other-repo-service', type: DeployTypes.GITHUB },
      },
    ] as unknown as Deploy[];

    expect(resolveAgentSessionServiceCandidates(deploys, lifecycleConfig)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'github-app',
          type: DeployTypes.GITHUB,
          detail: DeployStatus.DEPLOYED,
          deployId: 11,
        }),
        expect.objectContaining({
          name: 'helm-app',
          type: DeployTypes.HELM,
          detail: DeployStatus.READY,
          deployId: 12,
        }),
      ])
    );

    const names = resolveAgentSessionServiceCandidates(deploys, lifecycleConfig).map((candidate) => candidate.name);
    expect(names).toEqual(['github-app', 'helm-app']);
  });

  test('requires repo-qualified service references when names collide across repositories', () => {
    const candidates = [
      {
        name: 'web',
        type: DeployTypes.GITHUB,
        deployId: 11,
        devConfig: { image: 'node:20', command: 'pnpm dev' },
        repo: 'example-org/ui',
        branch: 'feature/ui',
        revision: 'abc123',
        baseDeploy: { id: 11 } as unknown as Deploy,
      },
      {
        name: 'web',
        type: DeployTypes.GITHUB,
        deployId: 12,
        devConfig: { image: 'node:20', command: 'pnpm dev' },
        repo: 'example-org/marketing-site',
        branch: 'feature/web-refresh',
        revision: 'def456',
        baseDeploy: { id: 12 } as unknown as Deploy,
      },
    ];

    expect(() => resolveRequestedAgentSessionServices(candidates, ['web'])).toThrow(
      'Multiple services matched the request; specify repo to disambiguate'
    );

    expect(resolveRequestedAgentSessionServices(candidates, [{ name: 'web', repo: 'example-org/ui' }])).toEqual([
      candidates[0],
    ]);
  });

  test('preserves request order and matches repository names case-insensitively while requiring an exact branch', () => {
    const api = buildCandidate('api', 'example-org/api', 'feature/api', 21);
    const web = buildCandidate('web', 'example-org/ui', 'feature/ui', 22);
    const otherWeb = buildCandidate('web', 'example-org/marketing', 'feature/ui', 23);

    expect(
      resolveRequestedAgentSessionServices(
        [web, otherWeb, api],
        ['api', { name: 'web', repo: '  EXAMPLE-ORG/UI  ', branch: 'feature/ui' }]
      )
    ).toEqual([api, web]);

    expect(() =>
      resolveRequestedAgentSessionServices(
        [web, otherWeb, api],
        [{ name: 'web', repo: 'example-org/ui', branch: 'feature/other' }, 'worker']
      )
    ).toThrow('Unknown services for build: web (example-org/ui:feature/other), worker');
  });

  test('uses a branch qualifier to disambiguate same-name services in one repository', () => {
    const main = buildCandidate('web', 'example-org/ui', 'main', 31);
    const feature = buildCandidate('web', 'example-org/ui', 'feature/ui', 32);

    expect(() =>
      resolveRequestedAgentSessionServices([main, feature], [{ name: 'web', repo: 'example-org/ui' }])
    ).toThrow('Multiple services matched the request; specify repo to disambiguate: web (example-org/ui)');
    expect(
      resolveRequestedAgentSessionServices(
        [main, feature],
        [{ name: 'web', repo: 'example-org/ui', branch: 'feature/ui' }]
      )
    ).toEqual([feature]);

    const duplicateFeature = buildCandidate('web', 'example-org/ui', 'feature/ui', 33);
    expect(() =>
      resolveRequestedAgentSessionServices(
        [feature, duplicateFeature],
        [{ name: 'web', repo: 'example-org/ui', branch: 'feature/ui' }]
      )
    ).toThrow('Multiple services matched the request; specify repo to disambiguate: web (example-org/ui:feature/ui)');
  });

  test('loads only live PR builds with the deployable-only candidate graph', async () => {
    const build = {
      uuid: 'pr-build',
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
      },
      deploys: [],
    } as unknown as Build;
    const withGraphFetched = jest.fn().mockResolvedValue(build);
    const whereNull = jest.fn(() => ({ withGraphFetched }));
    const findOne = jest.fn(() => ({ whereNull }));
    mockBuildQuery.mockReturnValueOnce({ findOne });
    mockResolveBuildSourceRepository.mockResolvedValueOnce({
      fullName: 'example-org/example-repo',
      githubRepositoryId: 42,
    });

    await expect(loadAgentSessionServiceCandidates('pr-build')).resolves.toEqual([]);

    expect(findOne).toHaveBeenCalledWith({ uuid: 'pr-build' });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
    expect(withGraphFetched).toHaveBeenCalledWith('[pullRequest.[repository], deploys.[deployable, repository]]');
  });

  test('reports a missing live build without resolving source or lifecycle configuration', async () => {
    const withGraphFetched = jest.fn().mockResolvedValue(null);
    const whereNull = jest.fn(() => ({ withGraphFetched }));
    const findOne = jest.fn(() => ({ whereNull }));
    mockBuildQuery.mockReturnValueOnce({ findOne });

    await expect(loadAgentSessionServiceCandidates('missing-build')).rejects.toThrow('Build not found');

    expect(findOne).toHaveBeenCalledWith({ uuid: 'missing-build' });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
    expect(withGraphFetched).toHaveBeenCalledWith('[pullRequest.[repository], deploys.[deployable, repository]]');
    expect(mockResolveBuildSourceRepository).not.toHaveBeenCalled();
    expect(mockFetchLifecycleConfig).not.toHaveBeenCalled();
  });

  test('normalizes API build source fields and prefers the resolved repository identity', async () => {
    const build = {
      uuid: 'api-source-build',
      pullRequest: null,
      branchName: '  main  ',
      configSha: '  immutable-config-ref  ',
      githubRepositoryId: 84,
    } as unknown as Build;
    mockResolveBuildSourceRepository.mockResolvedValueOnce({
      fullName: '  Example-Org/API  ',
      githubRepositoryId: '108',
    });

    await expect(resolveAgentSessionCandidateBuildSource(build)).resolves.toEqual({
      repo: 'Example-Org/API',
      branch: 'main',
      configRef: 'immutable-config-ref',
      githubRepositoryId: 108,
    });
    expect(mockResolveBuildSourceRepository).toHaveBeenCalledWith(build);
  });

  test('falls back to the build repository id and branch ref, and fails closed without source coordinates', async () => {
    const build = {
      uuid: 'api-source-fallback',
      pullRequest: null,
      branchName: 'main',
      configSha: null,
      githubRepositoryId: '84',
    } as unknown as Build;
    mockResolveBuildSourceRepository.mockResolvedValueOnce({
      fullName: 'example-org/api',
      githubRepositoryId: null,
    });

    await expect(resolveAgentSessionCandidateBuildSource(build)).resolves.toEqual({
      repo: 'example-org/api',
      branch: 'main',
      configRef: 'main',
      githubRepositoryId: 84,
    });

    mockResolveBuildSourceRepository.mockResolvedValueOnce(null);
    await expect(
      resolveAgentSessionCandidateBuildSource({ ...build, branchName: ' ' } as unknown as Build)
    ).resolves.toBeNull();

    mockResolveBuildSourceRepository.mockResolvedValueOnce({ fullName: ' ', githubRepositoryId: null });
    await expect(resolveAgentSessionCandidateBuildSource(build)).resolves.toBeNull();
  });

  test('keeps PR source coordinates when no repository identity is available', async () => {
    const build = {
      uuid: 'pr-source-without-repository-id',
      pullRequest: {
        fullName: 'example-org/pr-repo',
        branchName: 'feature/pr',
        repository: null,
      },
    } as unknown as Build;
    mockResolveBuildSourceRepository.mockResolvedValueOnce(null);

    await expect(resolveAgentSessionCandidateBuildSource(build)).resolves.toEqual({
      repo: 'example-org/pr-repo',
      branch: 'feature/pr',
      configRef: 'feature/pr',
      githubRepositoryId: null,
    });
  });

  test('preserves PR repository and branch candidate resolution', async () => {
    const lifecycleConfig = new YamlConfigParser().parseYamlConfigFromString(`---
version: '1.0.0'
services:
  - name: 'app'
    dev:
      image: 'repo/app:dev'
      command: 'pnpm dev'
    github:
      repository: 'example-org/example-repo'
      branchName: 'main'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: 'Dockerfile'
`);
    const build = {
      uuid: 'pr-build',
      pullRequest: {
        fullName: 'example-org/example-repo',
        branchName: 'feature/sample',
      },
      deploys: [
        {
          id: 11,
          uuid: 'app-pr-build',
          active: true,
          status: DeployStatus.READY,
          branchName: 'feature/sample',
          sha: 'pr-revision',
          githubRepositoryId: 42,
          repository: { fullName: 'example-org/example-repo', githubRepositoryId: 42 },
          deployable: { name: 'app', type: DeployTypes.GITHUB },
        },
      ],
    } as unknown as Build;
    mockResolveBuildSourceRepository.mockResolvedValueOnce({
      fullName: 'example-org/example-repo',
      githubRepositoryId: 42,
    });
    mockFetchLifecycleConfig.mockResolvedValueOnce(lifecycleConfig);

    await expect(resolveAgentSessionServiceCandidatesForBuild(build)).resolves.toEqual([
      expect.objectContaining({
        name: 'app',
        repo: 'example-org/example-repo',
        branch: 'feature/sample',
        revision: 'pr-revision',
      }),
    ]);
    expect(mockFetchLifecycleConfig).toHaveBeenCalledWith('example-org/example-repo', 'feature/sample');
  });

  test('resolves API build candidates through repository identity while keeping the checkout branch', async () => {
    const configSha = '0123456789abcdef0123456789abcdef01234567';
    const lifecycleConfig = new YamlConfigParser().parseYamlConfigFromString(`---
version: '1.0.0'
services:
  - name: 'app'
    dev:
      image: 'repo/app:dev'
      command: 'pnpm dev'
    github:
      repository: 'example-org/api-repo'
      branchName: 'main'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: 'Dockerfile'
`);
    const build = {
      uuid: 'api-build',
      pullRequest: null,
      triggerType: 'api',
      githubRepositoryId: 84,
      branchName: 'main',
      configSha,
      deploys: [
        {
          id: 12,
          uuid: 'app-api-build',
          active: true,
          status: DeployStatus.READY,
          branchName: configSha,
          sha: configSha,
          githubRepositoryId: 84,
          repository: { fullName: 'example-org/api-repo', githubRepositoryId: 84 },
          deployable: { name: 'app', type: DeployTypes.GITHUB },
        },
      ],
    } as unknown as Build;
    mockResolveBuildSourceRepository.mockResolvedValueOnce({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
    });
    mockFetchLifecycleConfig.mockResolvedValueOnce(lifecycleConfig);

    await expect(resolveAgentSessionServiceCandidatesForBuild(build)).resolves.toEqual([
      expect.objectContaining({
        name: 'app',
        repo: 'example-org/api-repo',
        branch: 'main',
        revision: configSha,
      }),
    ]);
    expect(mockResolveBuildSourceRepository).toHaveBeenCalledWith(build);
    expect(mockFetchLifecycleConfig).toHaveBeenCalledWith('example-org/api-repo', configSha);
  });

  test('keeps a same-repository service branch override while reading config from the pinned ref', async () => {
    const configSha = 'fedcba9876543210fedcba9876543210fedcba98';
    const lifecycleConfig = new YamlConfigParser().parseYamlConfigFromString(`---
version: '1.0.0'
services:
  - name: 'app'
    dev:
      image: 'repo/app:dev'
      command: 'pnpm dev'
    github:
      repository: 'example-org/api-repo'
      branchName: 'main'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: 'Dockerfile'
`);
    const build = {
      uuid: 'api-build-with-override',
      pullRequest: null,
      triggerType: 'api',
      githubRepositoryId: 84,
      branchName: 'main',
      configSha,
      deploys: [
        {
          id: 14,
          uuid: 'app-api-build-with-override',
          active: true,
          status: DeployStatus.READY,
          branchName: 'feature/service-override',
          sha: 'override-revision',
          githubRepositoryId: 84,
          repository: { fullName: 'example-org/api-repo', githubRepositoryId: 84 },
          deployable: { name: 'app', type: DeployTypes.GITHUB },
        },
      ],
    } as unknown as Build;
    mockResolveBuildSourceRepository.mockResolvedValueOnce({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
    });
    mockFetchLifecycleConfig.mockResolvedValueOnce(lifecycleConfig);

    await expect(resolveAgentSessionServiceCandidatesForBuild(build)).resolves.toEqual([
      expect.objectContaining({
        name: 'app',
        branch: 'feature/service-override',
        revision: 'override-revision',
      }),
    ]);
    expect(mockFetchLifecycleConfig).toHaveBeenCalledWith('example-org/api-repo', configSha);
  });

  test('caches repository config reads and sorts candidates by service then repository and branch', async () => {
    const sourceConfig = buildManagedGithubLifecycleConfig('zeta', 'beta');
    const otherConfig = buildManagedGithubLifecycleConfig('zeta', 'alpha');
    const buildSource = {
      repo: 'example-org/source',
      branch: 'main',
      configRef: 'source-config-ref',
      githubRepositoryId: 10,
    };
    const build = {
      uuid: 'multi-repo-build',
      deploys: [
        {
          id: 41,
          active: true,
          status: DeployStatus.READY,
          branchName: 'source-config-ref',
          sha: ' ',
          repository: { fullName: 'example-org/source', githubRepositoryId: 10 },
          deployable: { name: 'zeta', type: DeployTypes.GITHUB },
        },
        {
          id: 42,
          active: true,
          status: DeployStatus.DEPLOYED,
          branchName: 'feature/cross-repo',
          sha: 'alpha-revision',
          repository: { fullName: 'example-org/other', githubRepositoryId: 20 },
          deployable: { name: 'alpha', type: DeployTypes.GITHUB },
        },
        {
          id: 43,
          uuid: 'beta',
          active: true,
          status: DeployStatus.READY,
          branchName: 'source-config-ref',
          sha: 'beta-revision',
          githubRepositoryId: 10,
          repository: { fullName: null, githubRepositoryId: 10 },
          deployable: null,
        },
        {
          id: 44,
          active: true,
          status: DeployStatus.READY,
          branchName: 'feature/cross-repo',
          sha: 'zeta-other-revision',
          repository: { fullName: 'example-org/other', githubRepositoryId: 20 },
          deployable: { name: 'zeta', type: DeployTypes.GITHUB },
        },
      ],
    } as unknown as Build;
    mockFetchLifecycleConfig.mockImplementation(async (repo: string) =>
      repo === 'example-org/source' ? sourceConfig : otherConfig
    );

    const candidates = await resolveAgentSessionServiceCandidatesForBuild(build, buildSource);

    expect(candidates.map(({ name, repo, branch }) => `${name}:${repo}:${branch}`)).toEqual([
      'alpha:example-org/other:feature/cross-repo',
      'beta:example-org/source:main',
      'zeta:example-org/other:feature/cross-repo',
      'zeta:example-org/source:main',
    ]);
    expect(candidates.find(({ deployId }) => deployId === 41)?.revision).toBeNull();
    expect(candidates.find(({ deployId }) => deployId === 43)).toEqual(
      expect.objectContaining({ name: 'beta', repo: 'example-org/source', branch: 'main' })
    );
    expect(mockFetchLifecycleConfig).toHaveBeenCalledTimes(2);
    expect(mockFetchLifecycleConfig).toHaveBeenCalledWith('example-org/source', 'source-config-ref');
    expect(mockFetchLifecycleConfig).toHaveBeenCalledWith('example-org/other', 'feature/cross-repo');
    expect(mockResolveBuildSourceRepository).not.toHaveBeenCalled();
  });

  test('shares a failed config fetch across same-repository deploys and omits all affected candidates', async () => {
    const buildSource = {
      repo: 'example-org/source',
      branch: 'main',
      configRef: 'main',
      githubRepositoryId: null,
    };
    const build = {
      uuid: 'config-fetch-failure',
      deploys: ['api', 'worker'].map((name, index) => ({
        id: 51 + index,
        active: true,
        branchName: 'main',
        repository: { fullName: 'example-org/source', githubRepositoryId: null },
        deployable: { name, type: DeployTypes.GITHUB },
      })),
    } as unknown as Build;
    mockFetchLifecycleConfig.mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(resolveAgentSessionServiceCandidatesForBuild(build, buildSource)).resolves.toEqual([]);
    expect(mockFetchLifecycleConfig).toHaveBeenCalledTimes(1);
    expect(mockFetchLifecycleConfig).toHaveBeenCalledWith('example-org/source', 'main');
  });

  test('uses the build branch when a cross-repository deploy has no branch override', async () => {
    const lifecycleConfig = buildManagedGithubLifecycleConfig('app');
    const buildSource = {
      repo: 'example-org/source',
      branch: 'main',
      configRef: 'source-config-ref',
      githubRepositoryId: 10,
    };
    const build = {
      uuid: 'cross-repo-default-branch',
      deploys: [
        {
          id: 55,
          active: true,
          branchName: null,
          repository: { fullName: 'example-org/other', githubRepositoryId: 20 },
          deployable: { name: 'app', type: DeployTypes.GITHUB },
        },
      ],
    } as unknown as Build;
    mockFetchLifecycleConfig.mockResolvedValueOnce(lifecycleConfig);

    await expect(resolveAgentSessionServiceCandidatesForBuild(build, buildSource)).resolves.toEqual([
      expect.objectContaining({
        name: 'app',
        repo: 'example-org/other',
        branch: 'main',
      }),
    ]);
    expect(mockFetchLifecycleConfig).toHaveBeenCalledWith('example-org/other', 'main');
  });

  test('filters inactive or unscoped deploys before config reads', async () => {
    const buildSource = {
      repo: 'example-org/source',
      branch: 'main',
      configRef: 'main',
      githubRepositoryId: 10,
    };
    const build = {
      uuid: 'invalid-deploys',
      deploys: [
        {
          id: 61,
          active: false,
          branchName: 'main',
          repository: { fullName: 'example-org/source', githubRepositoryId: 10 },
          deployable: { name: 'inactive', type: DeployTypes.GITHUB },
        },
        {
          id: 62,
          active: true,
          branchName: 'main',
          githubRepositoryId: 20,
          repository: null,
          deployable: { name: 'unscoped', type: DeployTypes.GITHUB },
        },
      ],
    } as unknown as Build;

    await expect(resolveAgentSessionServiceCandidatesForBuild(build, buildSource)).resolves.toEqual([]);
    expect(mockFetchLifecycleConfig).not.toHaveBeenCalled();

    await expect(
      resolveAgentSessionServiceCandidatesForBuild({ uuid: 'unloaded-deploys' } as unknown as Build, buildSource)
    ).resolves.toEqual([]);
    expect(mockFetchLifecycleConfig).not.toHaveBeenCalled();
  });

  test('omits deploys whose config service is absent or not eligible for a managed dev build', async () => {
    const lifecycleConfig = new YamlConfigParser().parseYamlConfigFromString(`---
version: '1.0.0'
services:
  - name: 'external-image'
    dev:
      image: 'repo/external-image:dev'
      command: 'sleep infinity'
    docker:
      dockerImage: 'docker.io/example/external-image'
      defaultTag: 'latest'
`);
    const buildSource = {
      repo: 'example-org/source',
      branch: 'main',
      configRef: 'main',
      githubRepositoryId: 10,
    };
    const build = {
      uuid: 'ineligible-services',
      deploys: ['missing-service', 'external-image'].map((name, index) => ({
        id: 71 + index,
        active: true,
        branchName: 'main',
        repository: { fullName: 'example-org/source', githubRepositoryId: 10 },
        deployable: { name, type: DeployTypes.GITHUB },
      })),
    } as unknown as Build;
    mockFetchLifecycleConfig.mockResolvedValueOnce(lifecycleConfig);

    await expect(resolveAgentSessionServiceCandidatesForBuild(build, buildSource)).resolves.toEqual([]);
    expect(mockFetchLifecycleConfig).toHaveBeenCalledTimes(1);
  });

  test('fails closed when an API build repository identity no longer resolves', async () => {
    const build = {
      uuid: 'orphaned-api-build',
      pullRequest: null,
      triggerType: 'api',
      githubRepositoryId: 84,
      branchName: 'main',
      deploys: [
        {
          id: 13,
          active: true,
          branchName: 'main',
          repository: { fullName: 'renamed-or-reused/repo', githubRepositoryId: 99 },
          deployable: { name: 'app', type: DeployTypes.GITHUB },
        },
      ],
    } as unknown as Build;
    mockResolveBuildSourceRepository.mockResolvedValueOnce(null);

    await expect(resolveAgentSessionServiceCandidatesForBuild(build)).rejects.toThrow('Build source not found');
    expect(mockFetchLifecycleConfig).not.toHaveBeenCalled();
  });

  test('legacy candidate resolution preserves config order and normalizes optional deploy fields', () => {
    const lifecycleConfig = buildManagedGithubLifecycleConfig('app', 'worker', 'inactive-app');
    const deploys = [
      {
        id: 81,
        active: true,
        status: DeployStatus.READY,
        branchName: ' ',
        sha: null,
        repository: null,
        deployable: { name: 'app', type: DeployTypes.GITHUB },
      },
      {
        id: 83,
        active: true,
        status: DeployStatus.DEPLOYED,
        branchName: '  feature/worker  ',
        sha: '  worker-revision  ',
        repository: { fullName: '  example-org/worker  ' },
        deployable: { name: 'worker', type: DeployTypes.GITHUB },
      },
      {
        id: 82,
        active: false,
        status: DeployStatus.DEPLOYED,
        branchName: 'main',
        sha: 'inactive-revision',
        repository: { fullName: 'example-org/example-repo' },
        deployable: { name: 'inactive-app', type: DeployTypes.GITHUB },
      },
      {
        id: 84,
        active: true,
        deployable: null,
      },
    ] as unknown as Deploy[];

    expect(resolveAgentSessionServiceCandidates(deploys, lifecycleConfig)).toEqual([
      expect.objectContaining({
        name: 'app',
        deployId: 81,
        repo: '',
        branch: '',
        revision: null,
      }),
      expect.objectContaining({
        name: 'worker',
        deployId: 83,
        repo: 'example-org/worker',
        branch: 'feature/worker',
        revision: 'worker-revision',
      }),
    ]);
  });
});
