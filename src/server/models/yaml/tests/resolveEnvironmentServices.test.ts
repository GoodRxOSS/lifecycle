/**
 * Copyright 2026 Lifecycle contributors
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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';

mockRedisClient();

import { ParsingError } from 'server/lib/yamlConfigParser';
import { ValidationError } from 'server/lib/yamlConfigValidator';
import type { LifecycleConfig } from '../Config';
import type { DependencyService, Service } from '../YamlService';
import {
  resolveEnvironmentServices,
  resolveExactEnvironmentService,
  type ResolveEnvironmentServicesDependencies,
  type ResolverRepository,
} from '../resolveEnvironmentServices';

function githubService(
  name: string,
  requires: DependencyService[] = [],
  repository?: string,
  branchName = 'main'
): Service {
  return {
    name,
    requires,
    github: repository == null ? {} : { repository, branchName },
  } as unknown as Service;
}

function dockerService(name: string): Service {
  return { name, docker: { dockerImage: 'example/image', defaultTag: 'latest' } } as unknown as Service;
}

function config({
  defaults = [],
  optionals = [],
  services = [],
}: {
  defaults?: DependencyService[];
  optionals?: DependencyService[];
  services?: Service[];
}): LifecycleConfig {
  return {
    version: '1.0.0',
    environment: { defaultServices: defaults, optionalServices: optionals },
    services,
  };
}

function repository(id: number, fullName: string): ResolverRepository {
  return { githubRepositoryId: id, fullName };
}

function configKey(fullName: string, branch: string): string {
  return `${fullName.toLowerCase()}@${branch}`;
}

function dependencies({
  repositories,
  configs,
  fetchConfig,
}: {
  repositories: ResolverRepository[];
  configs?: Map<string, LifecycleConfig | null>;
  fetchConfig?: ResolveEnvironmentServicesDependencies<ResolverRepository>['fetchConfig'];
}) {
  const repositoriesByName = new Map(repositories.map((repo) => [repo.fullName.toLowerCase(), repo]));
  const resolveRepository = jest.fn(async (fullName: string) => repositoriesByName.get(fullName.toLowerCase()) ?? null);
  const fetch = jest.fn(
    fetchConfig ??
      (async (repo: ResolverRepository, branch: string) => configs?.get(configKey(repo.fullName, branch)) ?? null)
  );
  return {
    value: {
      resolveRepository,
      fetchConfig: fetch,
    },
    resolveRepository,
    fetchConfig: fetch,
  };
}

describe('resolveExactEnvironmentService', () => {
  it('uses the first exact declaration and preserves one-level requires order', () => {
    const first = githubService('web', [{ name: 'redis' }, { name: 'postgres' }, { name: 'missing' }]);
    const duplicate = githubService('web');
    const redis = dockerService('redis');
    const postgres = dockerService('postgres');
    const resolved = resolveExactEnvironmentService(config({ services: [first, redis, duplicate, postgres] }), {
      name: 'web',
    });

    expect(resolved?.service).toBe(first);
    expect(resolved?.requiredServices).toEqual([redis, postgres]);
    expect(resolveExactEnvironmentService(config({ services: [first] }), { name: 'absent' })).toBeNull();
    expect(resolveExactEnvironmentService(config({ services: [first] }), {} as DependencyService)).toBeNull();
  });
});

describe('resolveEnvironmentServices', () => {
  it('emits exactly one row per environment entry and never promotes requires to rows', async () => {
    const root = repository(1, 'org/root');
    const remote = repository(2, 'org/remote');
    const deps = dependencies({
      repositories: [root, remote],
      configs: new Map([
        [
          configKey(remote.fullName, 'all-helm'),
          config({
            services: [
              githubService('remote-app', [{ name: 'grpc-echo' }, { name: 'redis-helm' }]),
              dockerService('grpc-echo'),
              dockerService('redis-helm'),
            ],
          }),
        ],
      ]),
    });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [
          { name: 'local-app', repository: undefined },
          { name: 'remote-app', repository: remote.fullName, branch: 'all-helm' },
        ],
        services: [githubService('local-app', [{ name: 'local-dep' }]), dockerService('local-dep')],
      }),
      dependencies: deps.value,
    });

    expect(
      result.services.map(({ name, repository: repo, branch, status }) => ({ name, repository: repo, branch, status }))
    ).toEqual([
      { name: 'local-app', repository: 'org/root', branch: 'main', status: 'resolved' },
      { name: 'remote-app', repository: 'org/remote', branch: 'all-helm', status: 'resolved' },
    ]);
    expect(result).toMatchObject({ complete: true, truncated: false, pending: [], unresolved: [] });
  });

  it('orders rows defaults-then-optionals with matching default-active state', async () => {
    const root = repository(1, 'org/root');
    const deps = dependencies({ repositories: [root] });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [{ name: 'web' }],
        optionals: [{ name: 'worker' }],
        services: [githubService('web'), dockerService('worker')],
      }),
      dependencies: deps.value,
    });

    expect(result.services.map(({ name, defaultActive }) => ({ name, defaultActive }))).toEqual([
      { name: 'web', defaultActive: true },
      { name: 'worker', defaultActive: false },
    ]);
    expect(deps.fetchConfig).not.toHaveBeenCalled();
  });

  it('falls back to the root catalog when environment lists are empty', async () => {
    const root = repository(1, 'org/root');
    const deps = dependencies({ repositories: [root] });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'feature',
      rootConfig: config({ services: [githubService('web', [], 'org/web-source'), dockerService('worker')] }),
      dependencies: deps.value,
    });

    expect(result.services.map(({ name, defaultActive, branch }) => ({ name, defaultActive, branch }))).toEqual([
      { name: 'web', defaultActive: true, branch: 'feature' },
      { name: 'worker', defaultActive: true, branch: 'feature' },
    ]);
    expect(result.services[0].branchRepository).toBe('org/web-source');
    expect(result.services[0].branchConfigurationRepository).toBeNull();
    expect(result.services[0].effectiveBranch).toBe('feature');
    expect(result.services[1]).not.toHaveProperty('branchRepository');
    expect(result.services[1]).not.toHaveProperty('branchConfigurationRepository');
  });

  it('resolves a remote entry at main when its branch is omitted', async () => {
    const root = repository(1, 'org/root');
    const remote = repository(2, 'org/remote');
    const deps = dependencies({
      repositories: [root, remote],
      configs: new Map([
        [configKey(remote.fullName, 'main'), config({ services: [githubService('remote-app', [], 'org/app-source')] })],
      ]),
    });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'feature',
      rootConfig: config({ defaults: [{ name: 'remote-app', repository: remote.fullName }] }),
      dependencies: deps.value,
    });

    expect(deps.fetchConfig).toHaveBeenCalledWith(remote, 'main');
    expect(result.services).toEqual([
      expect.objectContaining({
        name: 'remote-app',
        repository: 'org/remote',
        branchRepository: 'org/app-source',
        branchConfigurationRepository: 'org/remote',
        effectiveBranch: 'main',
        branch: 'main',
        resolvedFromRepositoryId: 2,
        status: 'resolved',
      }),
    ]);
  });

  it('reports the source branch used by implicit and linked services when no override is supplied', async () => {
    const root = repository(1, 'org/root');
    const linked = repository(2, 'org/config');
    const deps = dependencies({
      repositories: [root, linked],
      configs: new Map([
        [
          configKey(linked.fullName, 'release'),
          config({
            services: [
              githubService('same-source', [], 'org/config', 'configured-but-ignored'),
              githubService('different-source', [], 'org/source', 'source-release'),
            ],
          }),
        ],
      ]),
    });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'feature',
      rootConfig: config({
        defaults: [
          { name: 'root-app' },
          { name: 'same-source', repository: linked.fullName, branch: 'release' },
          { name: 'different-source', repository: linked.fullName, branch: 'release' },
        ],
        services: [githubService('root-app', [], 'org/root', 'configured-but-ignored')],
      }),
      dependencies: deps.value,
    });

    expect(result.services.map(({ name, effectiveBranch }) => ({ name, effectiveBranch }))).toEqual([
      { name: 'root-app', effectiveBranch: 'feature' },
      { name: 'same-source', effectiveBranch: 'release' },
      { name: 'different-source', effectiveBranch: 'source-release' },
    ]);
  });

  it('does not reinterpret an explicitly empty branch as an omitted branch', async () => {
    const root = repository(1, 'org/root');
    const remote = repository(2, 'org/remote');
    const deps = dependencies({ repositories: [root, remote] });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({ defaults: [{ name: 'remote-app', repository: remote.fullName, branch: '' }] }),
      dependencies: deps.value,
    });

    expect(deps.fetchConfig).toHaveBeenCalledWith(remote, '');
    expect(result.services[0]).toMatchObject({ status: 'unresolved', reason: 'config_unavailable', branch: '' });
  });

  it('fetches an explicit same-repository reference from its declared branch', async () => {
    const root = repository(1, 'org/root');
    const deps = dependencies({
      repositories: [root],
      configs: new Map([[configKey(root.fullName, 'stable'), config({ services: [githubService('pinned')] })]]),
    });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [{ name: 'pinned', repository: 'ORG/ROOT', branch: 'stable' }, { name: 'local' }],
        services: [githubService('local')],
      }),
      dependencies: deps.value,
    });

    expect(deps.fetchConfig).toHaveBeenCalledTimes(1);
    expect(deps.fetchConfig).toHaveBeenCalledWith(root, 'stable');
    expect(result.services.map(({ name, branch, status }) => ({ name, branch, status }))).toEqual([
      { name: 'pinned', branch: 'stable', status: 'resolved' },
      { name: 'local', branch: 'main', status: 'resolved' },
    ]);
    expect(result.services[0].branchConfigurationRepository).toBe('org/root');
    expect(result.services[1].branchConfigurationRepository).toBeNull();
  });

  it('reuses the root config for a same-repository reference at the root branch without refetching', async () => {
    const root = repository(1, 'org/root');
    const deps = dependencies({ repositories: [root] });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [{ name: 'local', repository: root.fullName, branch: 'main' }],
        services: [githubService('local')],
      }),
      dependencies: deps.value,
    });

    expect(deps.fetchConfig).not.toHaveBeenCalled();
    expect(result.services[0]).toMatchObject({ name: 'local', status: 'resolved' });
  });

  it('reports a name miss as service_not_found without expanding the referenced repository', async () => {
    const root = repository(1, 'org/root');
    const remote = repository(2, 'org/remote');
    const deps = dependencies({
      repositories: [root, remote],
      configs: new Map([
        [
          configKey(remote.fullName, 'main'),
          config({
            defaults: [{ name: 'web' }],
            optionals: [{ name: 'worker' }],
            services: [githubService('web'), dockerService('worker')],
          }),
        ],
      ]),
    });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [{ name: 'not-a-service', repository: remote.fullName }, { name: 'local-miss' }],
      }),
      dependencies: deps.value,
    });

    expect(
      result.services.map(({ name, repository: repo, status, reason }) => ({ name, repository: repo, status, reason }))
    ).toEqual([
      { name: 'not-a-service', repository: 'org/remote', status: 'unresolved', reason: 'service_not_found' },
      { name: 'local-miss', repository: 'org/root', status: 'unresolved', reason: 'service_not_found' },
    ]);
    expect(result.unresolved).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it('renders an explicitly blank repository as unresolved instead of treating it as local', async () => {
    const root = repository(1, 'org/root');
    const deps = dependencies({ repositories: [root] });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [{ name: 'web', repository: '   ' }],
        services: [githubService('web')],
      }),
      dependencies: deps.value,
    });

    expect(result.services[0]).toMatchObject({
      name: 'web',
      status: 'unresolved',
      reason: 'repository_name_missing',
    });
    expect(deps.resolveRepository).not.toHaveBeenCalled();
  });

  it('reports a nameless entry as service_name_missing', async () => {
    const root = repository(1, 'org/root');
    const deps = dependencies({ repositories: [root] });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({ defaults: [{ name: '   ' } as DependencyService] }),
      dependencies: deps.value,
    });

    expect(result.services[0]).toMatchObject({
      name: '(unnamed service)',
      status: 'unresolved',
      reason: 'service_name_missing',
    });
  });

  it('deduplicates entries resolving to the same service and upgrades default-active', async () => {
    const root = repository(1, 'org/root');
    const deps = dependencies({ repositories: [root] });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [{ name: 'web' }, { name: 'web', repository: root.fullName, branch: 'main' }],
        optionals: [{ name: 'web' }],
        services: [githubService('web')],
      }),
      dependencies: deps.value,
    });

    expect(result.services).toHaveLength(1);
    expect(result.services[0]).toMatchObject({
      name: 'web',
      defaultActive: true,
      status: 'resolved',
      branchConfigurationRepository: 'org/root',
    });
  });

  it('keeps same-name services on different branches as distinct rows with stable collision suffixes', async () => {
    const root = repository(1, 'org/root');
    const remote = repository(2, 'org/remote');
    const deps = dependencies({
      repositories: [root, remote],
      configs: new Map([
        [configKey(remote.fullName, 'main'), config({ services: [githubService('shared')] })],
        [configKey(remote.fullName, 'release'), config({ services: [githubService('shared')] })],
      ]),
    });

    const run = () =>
      resolveEnvironmentServices({
        rootRepository: root,
        rootBranch: 'main',
        rootConfig: config({
          defaults: [
            { name: 'shared' },
            { name: 'shared', repository: remote.fullName, branch: 'main' },
            { name: 'shared', repository: remote.fullName, branch: 'release' },
          ],
          services: [githubService('shared')],
        }),
        dependencies: deps.value,
      });

    const first = await run();
    const second = await run();

    expect(first.services).toHaveLength(3);
    expect(first.services[0]).toMatchObject({ name: 'shared', repository: 'org/root' });
    expect(first.services[1].name).toMatch(/^shared-[0-9a-f]{6,}$/);
    expect(first.services[2].name).toMatch(/^shared-[0-9a-f]{6,}$/);
    expect(first.services[1].name).not.toBe(first.services[2].name);
    expect(first.services.map(({ originalName }) => originalName)).toEqual(['shared', 'shared', 'shared']);
    expect(second.services.map(({ name }) => name)).toEqual(first.services.map(({ name }) => name));
  });

  it('reports serviceId references as unsupported instead of resolving a coincident YAML name', async () => {
    const root = repository(1, 'org/root');
    const deps = dependencies({ repositories: [root] });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [
          { serviceId: 7, name: 'db-service' },
          { serviceId: 7, name: 'db-service' },
        ],
        services: [githubService('db-service')],
      }),
      dependencies: deps.value,
    });

    expect(result.services).toEqual([
      expect.objectContaining({
        key: 'issue:org/root@main:db-service:service_id_not_supported',
        name: 'db-service',
        repository: 'org/root',
        branch: 'main',
        resolvedFromRepositoryId: null,
        status: 'unresolved',
        reason: 'service_id_not_supported',
      }),
    ]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({
        name: 'db-service',
        status: 'unresolved',
        reason: 'service_id_not_supported',
      }),
    ]);
    expect(deps.resolveRepository).not.toHaveBeenCalled();
    expect(deps.fetchConfig).not.toHaveBeenCalled();
  });

  it('classifies repository, config, parse, validation, and rate-limit failures', async () => {
    const root = repository(1, 'org/root');
    const remote = repository(2, 'org/remote');
    const failures = new Map<string, unknown>([
      ['org/parse', new ParsingError('bad yaml')],
      ['org/validate', new ValidationError('invalid')],
      ['org/rate', Object.assign(new Error('API rate limit exceeded'), { status: 403 })],
      ['org/limited', Object.assign(new Error('boom'), { status: 429 })],
      ['org/generic', new Error('socket hang up')],
    ]);
    const deps = dependencies({
      repositories: [
        root,
        remote,
        repository(3, 'org/parse'),
        repository(4, 'org/validate'),
        repository(5, 'org/rate'),
        repository(6, 'org/limited'),
        repository(7, 'org/generic'),
      ],
      fetchConfig: async (repo: ResolverRepository) => {
        const failure = failures.get(repo.fullName);
        if (failure) throw failure;
        return null;
      },
    });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [
          { name: 'a', repository: 'org/unknown' },
          { name: 'b', repository: remote.fullName },
          { name: 'c', repository: 'org/parse' },
          { name: 'd', repository: 'org/validate' },
          { name: 'e', repository: 'org/rate' },
          { name: 'f', repository: 'org/limited' },
          { name: 'g', repository: 'org/generic' },
        ],
      }),
      dependencies: deps.value,
    });

    expect(result.services.map(({ name, status, reason }) => ({ name, status, reason }))).toEqual([
      { name: 'a', status: 'unresolved', reason: 'repo_not_onboarded' },
      { name: 'b', status: 'unresolved', reason: 'config_unavailable' },
      { name: 'c', status: 'invalid', reason: 'invalid_lifecycle_yaml' },
      { name: 'd', status: 'invalid', reason: 'invalid_lifecycle_yaml' },
      { name: 'e', status: 'rate_limited', reason: 'github_rate_limited' },
      { name: 'f', status: 'rate_limited', reason: 'github_rate_limited' },
      { name: 'g', status: 'unresolved', reason: 'config_fetch_failed' },
    ]);
    expect(result.unresolved).toHaveLength(7);
  });

  it('preserves entry order even when concurrent fetches finish in reverse order', async () => {
    const root = repository(1, 'org/root');
    const slow = repository(2, 'org/slow');
    const fast = repository(3, 'org/fast');
    const configs = new Map([
      [configKey(slow.fullName, 'main'), config({ services: [githubService('slow-leaf')] })],
      [configKey(fast.fullName, 'main'), config({ services: [githubService('fast-leaf')] })],
    ]);
    const deps = dependencies({
      repositories: [root, slow, fast],
      fetchConfig: async (repo: ResolverRepository, branch: string) => {
        await new Promise((resolve) => setTimeout(resolve, repo === slow ? 15 : 1));
        return configs.get(configKey(repo.fullName, branch));
      },
    });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [
          { name: 'slow-leaf', repository: slow.fullName },
          { name: 'fast-leaf', repository: fast.fullName },
        ],
      }),
      dependencies: deps.value,
    });

    expect(result.services.map(({ name }) => name)).toEqual(['slow-leaf', 'fast-leaf']);
  });

  it('memoizes repository and config lookups for concurrent references', async () => {
    const root = repository(1, 'org/root');
    const remote = repository(2, 'org/remote');
    const deps = dependencies({
      repositories: [root, remote],
      configs: new Map([
        [configKey(remote.fullName, 'main'), config({ services: [githubService('one'), githubService('two')] })],
      ]),
    });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [
          { name: 'one', repository: remote.fullName },
          { name: 'two', repository: 'ORG/REMOTE' },
        ],
      }),
      dependencies: deps.value,
    });

    expect(deps.resolveRepository).toHaveBeenCalledTimes(1);
    expect(deps.fetchConfig).toHaveBeenCalledTimes(1);
    expect(result.services.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'one', status: 'resolved' },
      { name: 'two', status: 'resolved' },
    ]);
  });

  it('clamps concurrent fetches to six', async () => {
    const root = repository(1, 'org/root');
    const remotes = Array.from({ length: 20 }, (_, index) => repository(index + 2, `org/remote-${index}`));
    let inFlight = 0;
    let maxInFlight = 0;
    const deps = dependencies({
      repositories: [root, ...remotes],
      fetchConfig: async (repo: ResolverRepository) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return config({ services: [githubService(repo.fullName.split('/')[1])] });
      },
    });

    await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: remotes.map((repo) => ({ name: repo.fullName.split('/')[1], repository: repo.fullName })),
      }),
      dependencies: deps.value,
    });

    expect(maxInFlight).toBeLessThanOrEqual(6);
  });

  it('truncates at the reference cap with a terminal row and without resolving deferred entries', async () => {
    const root = repository(1, 'org/root');
    const remotes = Array.from({ length: 3 }, (_, index) => repository(index + 2, `org/remote-${index}`));
    const deps = dependencies({
      repositories: [root, ...remotes],
      fetchConfig: async (repo: ResolverRepository) =>
        config({ services: [githubService(repo.fullName.split('/')[1])] }),
    });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: remotes.map((repo) => ({ name: repo.fullName.split('/')[1], repository: repo.fullName })),
      }),
      dependencies: deps.value,
      limits: { maxReferences: 2 },
    });

    expect(deps.fetchConfig).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.services).toHaveLength(3);
    expect(result.services[2]).toMatchObject({
      name: 'remote-2',
      repository: 'org/remote-2',
      status: 'truncated',
      reason: 'max_references_exceeded',
    });
  });

  it('counts duplicate references toward the reference cap', async () => {
    const root = repository(1, 'org/root');
    const deps = dependencies({ repositories: [root] });

    const result = await resolveEnvironmentServices({
      rootRepository: root,
      rootBranch: 'main',
      rootConfig: config({
        defaults: [{ name: 'web' }, { name: 'web' }, { name: 'tail' }],
        services: [githubService('web'), githubService('tail')],
      }),
      dependencies: deps.value,
      limits: { maxReferences: 2 },
    });

    expect(result.truncated).toBe(true);
    expect(result.services.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'web', status: 'resolved' },
      { name: 'tail', status: 'truncated' },
    ]);
  });
});
