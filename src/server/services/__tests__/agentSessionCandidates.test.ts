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
  resolveAgentSessionServiceCandidates,
  resolveAgentSessionServiceCandidatesForBuild,
  resolveRequestedAgentSessionServices,
} from '../agentSessionCandidates';
import { DeployStatus, DeployTypes } from 'shared/constants';

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
});
