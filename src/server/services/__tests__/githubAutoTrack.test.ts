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

jest.mock('server/lib/utils', () => ({
  getKeepLabel: jest.fn(),
  getDisabledLabel: jest.fn(),
  getDeployLabel: jest.fn(),
  parsePullRequestLabels: jest.fn(() => []),
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  updateLogContext: jest.fn(),
  LogStage: {},
}));
jest.mock('server/lib/github', () => ({
  getYamlFileContent: jest.fn(),
  getPullRequestLabels: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));
jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfig: jest.fn(),
}));

import Github from '../github';

describe('enqueueAutoTrackedApiBuilds', () => {
  const makeService = (builds: any[]) => {
    const chain: any = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
    };
    chain.whereNull = jest.fn((col: string) => (col === 'deletedAt' ? Promise.resolve(builds) : chain));
    const enqueue = jest.fn();
    const db = {
      models: { Build: { query: jest.fn(() => chain) } },
      services: { BuildService: { enqueueResolveAndDeployBuild: enqueue } },
    };
    const queueManager = { registerQueue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })) };
    const service = new Github(db as any, {} as any, {} as any, queueManager as any);
    return { service, chain, enqueue };
  };

  it('filters to live auto-tracked API builds on the pushed repo+branch and enqueues with the pushed sha', async () => {
    const { service, chain, enqueue } = makeService([
      { id: 1, uuid: 'tracked-env-111111' },
      { id: 2, uuid: 'tracked-env-222222' },
    ]);

    await (service as any).enqueueAutoTrackedApiBuilds(42, 'Main', 'sha123');

    expect(chain.where).toHaveBeenCalledWith('triggerType', 'api');
    expect(chain.where).toHaveBeenCalledWith('autoTrack', true);
    expect(chain.where).toHaveBeenCalledWith('deployEnabled', true);
    expect(chain.where).toHaveBeenCalledWith('githubRepositoryId', 42);
    expect(chain.where).toHaveBeenCalledWith('branchName', 'Main');
    expect(chain.whereRaw).not.toHaveBeenCalled();
    expect(chain.whereNull).toHaveBeenCalledWith('configSha');
    expect(chain.whereNotIn).toHaveBeenCalledWith('status', ['torn_down', 'tearing_down']);

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: 1, triggerRef: 'sha123', sourceBranch: 'Main' })
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: 2, triggerRef: 'sha123', sourceBranch: 'Main' })
    );
  });

  it('enqueues nothing when no auto-tracked builds match', async () => {
    const { service, enqueue } = makeService([]);

    await (service as any).enqueueAutoTrackedApiBuilds(42, 'main', null);

    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('handlePushWebhook auto-track wiring', () => {
  it('checks auto-tracked API builds even when no active deploy row matches the push', async () => {
    const deployChain: any = {
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue([]),
    };
    const db = {
      models: {
        PullRequest: { findOne: jest.fn().mockResolvedValue(null) },
        Deploy: { query: jest.fn(() => deployChain) },
      },
      services: { BuildService: { enqueueResolveAndDeployBuild: jest.fn() } },
    };
    const service = new Github(
      db as any,
      {} as any,
      {} as any,
      { registerQueue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })) } as any
    );
    const autoTrack = jest.spyOn(service as any, 'enqueueAutoTrackedApiBuilds').mockResolvedValue(undefined);
    jest.spyOn(service, 'handlePushForStaticEnv').mockResolvedValue(undefined);

    await service.handlePushWebhook({
      ref: 'refs/heads/main',
      before: 'aaaa111',
      after: 'sha123',
      commits: [],
      repository: { id: 42, full_name: 'org/repo' },
    } as any);

    expect(autoTrack).toHaveBeenCalledWith(42, 'main', 'sha123');
  });

  it('continues the existing PR redeploy flow when the API auto-track lookup fails', async () => {
    const build = {
      id: 7,
      isStatic: false,
      trackDefaultBranches: false,
      pullRequest: { status: 'open', deployOnUpdate: true },
    };
    const activeDeployChain: any = {
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue([
        {
          id: 17,
          devMode: false,
          build,
          deployable: { defaultBranchName: 'other', name: 'app' },
        },
      ]),
    };
    const failedDeployChain: any = {
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockResolvedValue([{ id: 17 }]),
    };
    const enqueueResolveAndDeployBuild = jest.fn();
    const db = {
      models: {
        PullRequest: { findOne: jest.fn() },
        Deploy: {
          query: jest.fn().mockReturnValueOnce(activeDeployChain).mockReturnValueOnce(failedDeployChain),
        },
      },
      services: { BuildService: { enqueueResolveAndDeployBuild } },
    };
    const service = new Github(
      db as any,
      {} as any,
      {} as any,
      { registerQueue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })) } as any
    );
    jest.spyOn(service as any, 'enqueueAutoTrackedApiBuilds').mockRejectedValue(new Error('database unavailable'));

    await service.handlePushWebhook({
      ref: 'refs/heads/main',
      before: '0000000',
      after: 'sha123',
      commits: [],
      repository: { id: 42, full_name: 'org/repo' },
    } as any);

    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: 7,
        triggerRef: 'sha123',
        sourceRef: 'sha123',
        sourceGithubRepositoryId: 42,
        sourceBranch: 'main',
      })
    );
    expect(enqueueResolveAndDeployBuild.mock.calls[0][0]).not.toHaveProperty('githubRepositoryId');
  });

  it('tracks opted-in API dependency default branches without requiring root autoTrack', async () => {
    const build = {
      id: 8,
      isStatic: false,
      triggerType: 'api',
      githubRepositoryId: 42,
      deployEnabled: true,
      autoTrack: false,
      trackDefaultBranches: true,
      pullRequest: null,
    };
    const activeDeployChain: any = {
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue([
        {
          id: 18,
          devMode: false,
          build,
          deployable: { defaultBranchName: 'main', name: 'dependency' },
        },
      ]),
    };
    const failedDeployChain: any = {
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockResolvedValue([]),
    };
    const enqueueResolveAndDeployBuild = jest.fn();
    const db = {
      models: {
        PullRequest: { findOne: jest.fn() },
        Deploy: {
          query: jest.fn().mockReturnValueOnce(activeDeployChain).mockReturnValueOnce(failedDeployChain),
        },
      },
      services: { BuildService: { enqueueResolveAndDeployBuild } },
    };
    const service = new Github(
      db as any,
      {} as any,
      {} as any,
      { registerQueue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })) } as any
    );
    jest.spyOn(service as any, 'enqueueAutoTrackedApiBuilds').mockResolvedValue(undefined);

    await service.handlePushWebhook({
      ref: 'refs/heads/main',
      before: '0000000',
      after: 'dependency-sha',
      commits: [],
      repository: { id: 99, full_name: 'org/dependency' },
    } as any);

    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: 8,
        githubRepositoryId: 99,
        sourceGithubRepositoryId: 99,
        triggerRef: 'dependency-sha',
        sourceRef: 'dependency-sha',
        sourceBranch: 'main',
      })
    );
  });

  it('tracks a same-repository dependency when its effective branch differs from the root branch', async () => {
    const build = {
      id: 10,
      branchName: 'main',
      triggerType: 'api',
      githubRepositoryId: 42,
      deployEnabled: true,
      autoTrack: false,
      trackDefaultBranches: true,
      pullRequest: null,
    };
    const activeDeployChain: any = {
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue([
        {
          id: 20,
          devMode: false,
          build,
          deployable: { defaultBranchName: 'stable', name: 'same-repo-dependency' },
        },
      ]),
    };
    const failedDeployChain: any = {
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockResolvedValue([]),
    };
    const enqueueResolveAndDeployBuild = jest.fn();
    const db = {
      models: {
        PullRequest: { findOne: jest.fn() },
        Deploy: {
          query: jest.fn().mockReturnValueOnce(activeDeployChain).mockReturnValueOnce(failedDeployChain),
        },
      },
      services: { BuildService: { enqueueResolveAndDeployBuild } },
    };
    const service = new Github(
      db as any,
      {} as any,
      {} as any,
      { registerQueue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })) } as any
    );
    jest.spyOn(service as any, 'enqueueAutoTrackedApiBuilds').mockResolvedValue(undefined);

    await service.handlePushWebhook({
      ref: 'refs/heads/stable',
      before: '0000000',
      after: 'dependency-sha',
      commits: [],
      repository: { id: 42, full_name: 'org/repo' },
    } as any);

    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: 10,
        githubRepositoryId: 42,
        sourceGithubRepositoryId: 42,
        sourceBranch: 'stable',
        sourceRef: 'dependency-sha',
      })
    );
  });

  it('does not let trackDefaultBranches bypass autoTrack=false for a root repository push', async () => {
    const activeDeployChain: any = {
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue([
        {
          id: 19,
          devMode: false,
          build: {
            id: 9,
            branchName: 'main',
            triggerType: 'api',
            githubRepositoryId: 42,
            deployEnabled: true,
            autoTrack: false,
            trackDefaultBranches: true,
            pullRequest: null,
          },
          deployable: { defaultBranchName: 'main', name: 'root' },
        },
      ]),
    };
    const enqueueResolveAndDeployBuild = jest.fn();
    const db = {
      models: {
        PullRequest: { findOne: jest.fn() },
        Deploy: { query: jest.fn(() => activeDeployChain) },
      },
      services: { BuildService: { enqueueResolveAndDeployBuild } },
    };
    const service = new Github(
      db as any,
      {} as any,
      {} as any,
      { registerQueue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })) } as any
    );
    jest.spyOn(service as any, 'enqueueAutoTrackedApiBuilds').mockResolvedValue(undefined);

    await service.handlePushWebhook({
      ref: 'refs/heads/main',
      before: '0000000',
      after: 'root-sha',
      commits: [],
      repository: { id: 42, full_name: 'org/repo' },
    } as any);

    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('invokes the auto-track lookup with the pushed repo, branch, and head sha', async () => {
    const deploy = {
      devMode: false,
      build: {
        id: 1,
        trackDefaultBranches: false,
        pullRequest: null,
      },
      deployable: { defaultBranchName: 'other', name: 'app' },
    };
    const deployChain: any = {
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockResolvedValue([deploy]),
    };
    const db = {
      models: {
        PullRequest: { findOne: jest.fn().mockResolvedValue(null) },
        Deploy: { query: jest.fn(() => deployChain) },
        Build: { query: jest.fn() },
      },
      services: { BuildService: { enqueueResolveAndDeployBuild: jest.fn() } },
    };
    const queueManager = { registerQueue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })) };
    const service = new Github(db as any, {} as any, {} as any, queueManager as any);
    const autoTrack = jest.spyOn(service as any, 'enqueueAutoTrackedApiBuilds').mockResolvedValue(undefined);

    await service.handlePushWebhook({
      ref: 'refs/heads/main',
      before: 'aaaa111',
      after: 'sha123',
      commits: [],
      repository: { id: 42, full_name: 'org/repo' },
    } as any);

    expect(autoTrack).toHaveBeenCalledWith(42, 'main', 'sha123');
    expect(db.services.BuildService.enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('propagates the pushed SHA as both queue identity and immutable source ref', async () => {
    const { service, enqueue } = (() => {
      const chain: any = {
        where: jest.fn().mockReturnThis(),
        whereRaw: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
      };
      chain.whereNull = jest.fn((column: string) =>
        column === 'deletedAt' ? Promise.resolve([{ id: 1, uuid: 'tracked-env-111111' }]) : chain
      );
      const enqueue = jest.fn();
      const db = {
        models: { Build: { query: jest.fn(() => chain) } },
        services: { BuildService: { enqueueResolveAndDeployBuild: enqueue } },
      };
      return {
        service: new Github(
          db as any,
          {} as any,
          {} as any,
          { registerQueue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })) } as any
        ),
        enqueue,
      };
    })();

    await (service as any).enqueueAutoTrackedApiBuilds(42, 'main', 'sha123');

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: 1,
        triggerRef: 'sha123',
        sourceRef: 'sha123',
        sourceGithubRepositoryId: 42,
        sourceBranch: 'main',
      })
    );
  });
});
