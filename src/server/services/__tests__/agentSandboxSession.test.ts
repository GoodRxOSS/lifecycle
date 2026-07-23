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

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
}));

jest.mock('../build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    hostForDeployableDeploy: jest.fn(),
  })),
}));

jest.mock('../agentSession', () => ({
  __esModule: true,
  default: {
    createSession: jest.fn(),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfig: jest.fn(),
  getDeployingServicesByName: jest.fn(),
}));

import AgentSandboxSessionService from '../agentSandboxSession';
import AgentSessionService from '../agentSession';
import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';
import { fetchLifecycleConfig, getDeployingServicesByName } from 'server/models/yaml';
import { Build, Repository } from 'server/models';
import { BuildStatus, BuildKind, DeployStatus, DeployTypes } from 'shared/constants';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function mockBaseBuildLoad(baseBuild: unknown) {
  const withGraphFetched = jest.fn().mockResolvedValue(baseBuild);
  const whereNull = jest.fn(() => ({ withGraphFetched }));
  const findOne = jest.fn(() => ({ whereNull }));
  jest.spyOn(Build, 'query').mockReturnValueOnce({ findOne } as any);

  return { findOne, whereNull, withGraphFetched };
}

function mockLiveRepositoryLookup(repository: unknown) {
  const whereNull = jest.fn().mockResolvedValue(repository);
  const findOne = jest.fn(() => ({ whereNull }));
  jest.spyOn(Repository, 'query').mockReturnValueOnce({ findOne } as any);

  return { findOne, whereNull };
}

function createSandboxableLifecycleConfig() {
  return {
    environment: {
      defaultServices: [{ name: 'frontend' }],
      optionalServices: [],
    },
  };
}

function createSandboxableYamlService() {
  return {
    name: 'frontend',
    dev: { image: 'node:20', command: 'pnpm dev' },
    github: {
      docker: {
        app: {
          dockerfilePath: 'Dockerfile',
        },
      },
    },
  };
}

function createApiBaseBuild(configSha = '0123456789abcdef0123456789abcdef01234567') {
  return {
    id: 100,
    uuid: 'api-base-build',
    kind: BuildKind.ENVIRONMENT,
    status: BuildStatus.DEPLOYED,
    triggerType: 'api',
    githubRepositoryId: 84,
    branchName: 'feature/api-environment',
    configSha,
    pullRequest: null,
    deploys: [
      {
        id: 10,
        uuid: 'frontend-api-base-build',
        active: true,
        status: DeployStatus.READY,
        branchName: configSha,
        sha: configSha,
        githubRepositoryId: 84,
        repository: { fullName: 'renamed/example-repo', githubRepositoryId: 84 },
        deployable: { name: 'frontend', type: DeployTypes.GITHUB },
      },
    ],
  } as any;
}

describe('agentSandboxSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AgentSessionService.createSession as jest.Mock).mockReset();
    (fetchLifecycleConfig as jest.Mock).mockReset();
    (getDeployingServicesByName as jest.Mock).mockReset();
  });

  it('lists sandbox candidates for a live API-created base using its source branch and pinned config', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const configSha = '0123456789abcdef0123456789abcdef01234567';
    const baseBuild = createApiBaseBuild(configSha);
    const buildQuery = mockBaseBuildLoad(baseBuild);
    const repositoryQuery = mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue(createSandboxableLifecycleConfig());
    (getDeployingServicesByName as jest.Mock).mockReturnValue(createSandboxableYamlService());

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).resolves.toEqual([
      {
        name: 'frontend',
        type: DeployTypes.GITHUB,
        repo: 'example-org/api-repo',
        branch: 'feature/api-environment',
      },
    ]);

    expect(buildQuery.findOne).toHaveBeenCalledWith({ uuid: baseBuild.uuid, kind: BuildKind.ENVIRONMENT });
    expect(buildQuery.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(repositoryQuery.findOne).toHaveBeenCalledWith({ githubRepositoryId: 84 });
    expect(repositoryQuery.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(fetchLifecycleConfig).toHaveBeenCalledWith('example-org/api-repo', configSha);
  });

  it('launches from an API-created base without treating its pinned config ref as the checkout branch', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const configSha = '0123456789abcdef0123456789abcdef01234567';
    const baseBuild = createApiBaseBuild(configSha);
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue(createSandboxableLifecycleConfig());
    (getDeployingServicesByName as jest.Mock).mockReturnValue(createSandboxableYamlService());

    const sandboxBuild = {
      id: 200,
      uuid: 'sandbox-build-1',
      namespace: 'sandbox-namespace',
      pullRequest: null,
      $query: jest.fn().mockReturnValue({ patch: jest.fn().mockResolvedValue(undefined) }),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    } as any;
    const sandboxDeploy = { id: 99, uuid: 'frontend-sandbox-build-1' } as any;
    jest.spyOn(service as any, 'createSandboxBuild').mockResolvedValue({
      build: sandboxBuild,
      sandboxDeploysByBaseDeployId: new Map([[10, sandboxDeploy]]),
    });
    jest.spyOn(BuildEnvironmentVariables.prototype, 'resolve').mockResolvedValue(undefined);
    (service as any).buildService.updateStatusAndComment = jest.fn().mockResolvedValue(undefined);
    (service as any).buildService.generateAndApplyManifests = jest.fn().mockResolvedValue(true);
    (service as any).buildService.deleteBuild = jest.fn().mockResolvedValue(undefined);
    (AgentSessionService.createSession as jest.Mock).mockResolvedValue({ uuid: 'session-1' });

    await expect(
      service.launch({
        userId: 'user-1',
        baseBuildUuid: baseBuild.uuid,
        services: ['frontend'],
        readiness: { timeoutMs: 60000, pollMs: 2000 },
        resources: {
          workspace: { requests: {}, limits: {} },
          editor: { requests: {}, limits: {} },
          workspaceGateway: { requests: {}, limits: {} },
        },
      })
    ).resolves.toEqual(expect.objectContaining({ status: 'created', buildUuid: sandboxBuild.uuid }));

    expect((service as any).createSandboxBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentSource: {
          repo: 'example-org/api-repo',
          branch: 'feature/api-environment',
          configRef: configSha,
          githubRepositoryId: 84,
        },
      })
    );
    expect(AgentSessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: undefined,
        services: [
          expect.objectContaining({
            repo: 'example-org/api-repo',
            branch: 'feature/api-environment',
            revision: configSha,
          }),
        ],
      })
    );
  });

  it('preserves pull-request repository and branch source resolution', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = {
      id: 101,
      uuid: 'pr-base-build',
      kind: BuildKind.ENVIRONMENT,
      status: BuildStatus.DEPLOYED,
      pullRequest: {
        fullName: 'example-org/pr-repo',
        branchName: 'feature/pr-environment',
        pullRequestNumber: 42,
        repository: { fullName: 'example-org/pr-repo', githubRepositoryId: 42 },
      },
      deploys: [
        {
          id: 11,
          uuid: 'frontend-pr-base-build',
          active: true,
          status: DeployStatus.READY,
          branchName: 'feature/pr-environment',
          sha: 'pr-head-sha',
          githubRepositoryId: 42,
          repository: { fullName: 'example-org/pr-repo', githubRepositoryId: 42 },
          deployable: { name: 'frontend', type: DeployTypes.GITHUB },
        },
      ],
    } as any;
    const buildQuery = mockBaseBuildLoad(baseBuild);
    const repositoryQuery = jest.spyOn(Repository, 'query').mockImplementation(() => {
      throw new Error('PR source resolution must not query the repository table');
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue(createSandboxableLifecycleConfig());
    (getDeployingServicesByName as jest.Mock).mockReturnValue(createSandboxableYamlService());

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).resolves.toEqual([
      {
        name: 'frontend',
        type: DeployTypes.GITHUB,
        repo: 'example-org/pr-repo',
        branch: 'feature/pr-environment',
      },
    ]);

    expect(buildQuery.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(repositoryQuery).not.toHaveBeenCalled();
    expect(fetchLifecycleConfig).toHaveBeenCalledWith('example-org/pr-repo', 'feature/pr-environment');
  });

  it('fails closed when an API-created base repository is no longer live', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup(undefined);

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).rejects.toThrow(
      'Base environment build is missing source repository/branch'
    );
    expect(fetchLifecycleConfig).not.toHaveBeenCalled();
  });

  it('rejects a live environment that is not deployed before resolving its source', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = {
      ...createApiBaseBuild(),
      status: BuildStatus.DEPLOYING,
    };
    mockBaseBuildLoad(baseBuild);

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).rejects.toThrow(
      'The environment must be deployed before you can start a sandbox'
    );
    expect(fetchLifecycleConfig).not.toHaveBeenCalled();
  });

  it('does not list a sandboxable service whose active base deploy is not ready', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    baseBuild.deploys[0].status = DeployStatus.DEPLOY_FAILED;
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue(createSandboxableLifecycleConfig());
    (getDeployingServicesByName as jest.Mock).mockReturnValue(createSandboxableYamlService());

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).rejects.toThrow(
      'This environment has no ready services that can start a sandbox'
    );
  });

  it('lists only active ready services when other sandboxable deploys are unavailable', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    baseBuild.deploys.push(
      {
        ...baseBuild.deploys[0],
        id: 11,
        uuid: 'worker-api-base-build',
        status: DeployStatus.DEPLOY_FAILED,
        deployable: { name: 'worker', type: DeployTypes.GITHUB },
      },
      {
        ...baseBuild.deploys[0],
        id: 12,
        uuid: 'jobs-api-base-build',
        active: false,
        deployable: { name: 'jobs', type: DeployTypes.GITHUB },
      }
    );
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue({
      environment: {
        defaultServices: [{ name: 'frontend' }, { name: 'worker' }, { name: 'jobs' }],
        optionalServices: [],
      },
    });
    (getDeployingServicesByName as jest.Mock).mockImplementation((_config, name) => ({
      ...createSandboxableYamlService(),
      name,
    }));

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).resolves.toEqual([
      {
        name: 'frontend',
        type: DeployTypes.GITHUB,
        repo: 'example-org/api-repo',
        branch: 'feature/api-environment',
      },
    ]);
  });

  it('rejects an explicitly requested sandbox service whose active base deploy is not ready', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    baseBuild.deploys[0].status = DeployStatus.DEPLOY_FAILED;
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue(createSandboxableLifecycleConfig());
    (getDeployingServicesByName as jest.Mock).mockReturnValue(createSandboxableYamlService());

    await expect(
      service.launch({
        userId: 'user-1',
        baseBuildUuid: baseBuild.uuid,
        services: ['frontend'],
        readiness: { timeoutMs: 60000, pollMs: 2000 },
        resources: {
          workspace: { requests: {}, limits: {} },
          editor: { requests: {}, limits: {} },
          workspaceGateway: { requests: {}, limits: {} },
        },
      })
    ).rejects.toThrow('Service frontend must be ready before you can start a sandbox');
  });

  it('treats a tombstoned base build as not found', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const buildQuery = mockBaseBuildLoad(undefined);

    await expect(service.getServiceCandidates({ baseBuildUuid: 'deleted-base-build' })).rejects.toThrow(
      'Base build not found'
    );
    expect(buildQuery.findOne).toHaveBeenCalledWith({
      uuid: 'deleted-base-build',
      kind: BuildKind.ENVIRONMENT,
    });
    expect(buildQuery.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(fetchLifecycleConfig).not.toHaveBeenCalled();
  });

  it('treats a non-environment base build as not found', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const buildQuery = mockBaseBuildLoad({
      uuid: 'sandbox-base-build',
      kind: BuildKind.SANDBOX,
    });

    await expect(service.getServiceCandidates({ baseBuildUuid: 'sandbox-base-build' })).rejects.toThrow(
      'Base build not found'
    );
    expect(buildQuery.findOne).toHaveBeenCalledWith({
      uuid: 'sandbox-base-build',
      kind: BuildKind.ENVIRONMENT,
    });
    expect(fetchLifecycleConfig).not.toHaveBeenCalled();
  });

  it('keeps repository identity when resolving duplicate dependency names', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = {
      uuid: 'base-build',
      deploys: [
        {
          id: 1,
          active: true,
          status: DeployStatus.READY,
          deployable: { name: 'frontend' },
          repository: { fullName: 'org/frontend' },
        },
        {
          id: 2,
          active: true,
          status: DeployStatus.READY,
          deployable: { name: 'shared-api' },
          repository: { fullName: 'org/api-a' },
        },
        {
          id: 3,
          active: true,
          status: DeployStatus.READY,
          deployable: { name: 'shared-api' },
          repository: { fullName: 'org/api-b' },
        },
      ],
    } as any;
    const selectedService = {
      name: 'frontend',
      devConfig: { image: 'node:20', command: 'pnpm dev' },
      baseDeploy: baseBuild.deploys[0],
      serviceRepo: 'org/frontend',
      serviceBranch: 'main',
      yamlService: {
        name: 'frontend',
        requires: [{ name: 'shared-api', repository: 'org/api-b' }],
      },
    } as any;

    (fetchLifecycleConfig as jest.Mock).mockResolvedValue({});
    (getDeployingServicesByName as jest.Mock).mockReturnValue({
      name: 'shared-api',
      requires: [],
    });

    const includedDeployIds = await (service as any).resolveDependencyClosure(baseBuild, [selectedService], {
      repo: 'env/static-environments',
      branch: 'main',
    });

    expect([...includedDeployIds]).toEqual(expect.arrayContaining([1, 3]));
    expect(includedDeployIds.has(2)).toBe(false);
  });

  it('keeps branch identity when resolving duplicate dependency names from the same repo', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = {
      uuid: 'base-build',
      deploys: [
        {
          id: 1,
          active: true,
          status: DeployStatus.READY,
          branchName: 'main',
          deployable: { name: 'frontend' },
          repository: { fullName: 'org/frontend' },
        },
        {
          id: 2,
          active: true,
          status: DeployStatus.READY,
          branchName: 'main',
          deployable: { name: 'shared-api' },
          repository: { fullName: 'org/api' },
        },
        {
          id: 3,
          active: true,
          status: DeployStatus.READY,
          branchName: 'release',
          deployable: { name: 'shared-api' },
          repository: { fullName: 'org/api' },
        },
      ],
    } as any;
    const selectedService = {
      name: 'frontend',
      devConfig: { image: 'node:20', command: 'pnpm dev' },
      baseDeploy: baseBuild.deploys[0],
      serviceRepo: 'org/frontend',
      serviceBranch: 'main',
      yamlService: {
        name: 'frontend',
        requires: [{ name: 'shared-api', repository: 'org/api', branch: 'release' }],
      },
    } as any;

    (fetchLifecycleConfig as jest.Mock).mockResolvedValue({});
    (getDeployingServicesByName as jest.Mock).mockReturnValue({
      name: 'shared-api',
      requires: [],
    });

    const includedDeployIds = await (service as any).resolveDependencyClosure(baseBuild, [selectedService], {
      repo: 'env/static-environments',
      branch: 'main',
    });

    expect([...includedDeployIds]).toEqual(expect.arrayContaining([1, 3]));
    expect(includedDeployIds.has(2)).toBe(false);
  });

  it('rejects a selected dependency closure when an active required deploy is not ready', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = {
      uuid: 'base-build',
      deploys: [
        {
          id: 1,
          active: true,
          status: DeployStatus.READY,
          branchName: 'main',
          deployable: { name: 'frontend' },
          repository: { fullName: 'org/frontend' },
        },
        {
          id: 2,
          active: true,
          status: DeployStatus.DEPLOY_FAILED,
          branchName: 'main',
          deployable: { name: 'api' },
          repository: { fullName: 'org/api' },
        },
      ],
    } as any;
    const selectedService = {
      name: 'frontend',
      devConfig: { image: 'node:20', command: 'pnpm dev' },
      baseDeploy: baseBuild.deploys[0],
      serviceRepo: 'org/frontend',
      serviceBranch: 'main',
      yamlService: {
        name: 'frontend',
        requires: [{ name: 'api', repository: 'org/api' }],
      },
    } as any;

    await expect(
      (service as any).resolveDependencyClosure(baseBuild, [selectedService], {
        repo: 'env/static-environments',
        branch: 'main',
      })
    ).rejects.toThrow('Service api must be ready before you can start a sandbox');
    expect(fetchLifecycleConfig).not.toHaveBeenCalled();
  });

  it('fails closed when multiple top-level sandbox candidates share the same name', () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);

    expect(() =>
      (service as any).resolveSelectedService('shared-api', [
        { name: 'shared-api', serviceRepo: 'org/api-a' },
        { name: 'shared-api', serviceRepo: 'org/api-b' },
      ])
    ).toThrow('Multiple sandbox services matched shared-api');
  });

  it('resolves a repo-qualified sandbox service when names collide', () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);

    const selected = (service as any).resolveSelectedService(
      { name: 'shared-api', repo: 'org/api-b', branch: 'main' },
      [
        { name: 'shared-api', serviceRepo: 'org/api-a', serviceBranch: 'main' },
        { name: 'shared-api', serviceRepo: 'org/api-b', serviceBranch: 'main' },
      ]
    );

    expect(selected.serviceRepo).toBe('org/api-b');
    expect(selected.serviceBranch).toBe('main');
  });

  it('resolves multiple selected sandbox services without duplicating matches', () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);

    const selected = (service as any).resolveSelectedServices(
      [
        { name: 'frontend', repo: 'org/frontend', branch: 'main' },
        { name: 'worker', repo: 'org/worker', branch: 'main' },
        { name: 'frontend', repo: 'org/frontend', branch: 'main' },
      ],
      [
        { name: 'frontend', serviceRepo: 'org/frontend', serviceBranch: 'main' },
        { name: 'worker', serviceRepo: 'org/worker', serviceBranch: 'main' },
      ]
    );

    expect(selected).toHaveLength(2);
    expect(selected.map((item: any) => item.name)).toEqual(['frontend', 'worker']);
  });

  it('resolves sandbox candidates in parallel', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const frontendSource = createDeferred<any>();
    const workerSource = createDeferred<any>();

    jest
      .spyOn(service as any, 'resolveServiceSource')
      .mockImplementationOnce(() => frontendSource.promise)
      .mockImplementationOnce(() => workerSource.promise);

    const resolvePromise = (service as any).resolveCandidateServices(
      {
        uuid: 'base-build',
        deploys: [
          {
            id: 1,
            active: true,
            deployable: { name: 'frontend' },
            repository: { fullName: 'example-org/frontend' },
            branchName: 'main',
          },
          {
            id: 2,
            active: true,
            deployable: { name: 'worker' },
            repository: { fullName: 'example-org/worker' },
            branchName: 'main',
          },
        ],
      } as any,
      {
        environment: {
          defaultServices: [{ name: 'frontend' }, { name: 'worker' }],
          optionalServices: [],
        },
      } as any,
      {
        repo: 'example-org/environment',
        branch: 'main',
      }
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect((service as any).resolveServiceSource).toHaveBeenCalledTimes(2);

    frontendSource.resolve({
      repo: 'example-org/frontend',
      branch: 'main',
      yamlService: {
        name: 'frontend',
        dev: { image: 'node:20', command: 'pnpm dev' },
        github: {
          docker: {
            app: {
              dockerfilePath: 'Dockerfile',
            },
          },
        },
      },
    });
    workerSource.resolve({
      repo: 'example-org/worker',
      branch: 'main',
      yamlService: {
        name: 'worker',
        dev: { image: 'node:20', command: 'pnpm start' },
        github: {
          docker: {
            app: {
              dockerfilePath: 'Dockerfile',
            },
          },
        },
      },
    });

    const candidates = await resolvePromise;
    expect(candidates.map((candidate: any) => candidate.name)).toEqual(['frontend', 'worker']);
  });

  it('maps selected services to cloned sandbox deploys by base deploy id', () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const selectedService = {
      name: 'sample-service-3',
      serviceRepo: 'example-org/sample-service-3',
      baseDeploy: {
        id: 42,
        repository: { fullName: 'example-org/sample-service-3' },
      },
    } as any;
    const sandboxDeploy = {
      id: 7,
      uuid: 'sample-service-3-sandbox',
      deployable: { name: 'sample-service-3' },
      repository: { fullName: 'example-org/other-service' },
    } as any;

    const mapped = (service as any).resolveSelectedSandboxDeploys(
      [selectedService],
      new Map([[selectedService.baseDeploy.id, sandboxDeploy]])
    );

    expect(mapped).toEqual([
      {
        selectedService,
        sandboxDeploy,
      },
    ]);
  });

  it('creates sandbox launches with sandbox buildKind', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const createSessionMock = AgentSessionService.createSession as jest.Mock;
    const sandboxBuild = {
      id: 200,
      uuid: 'sandbox-build-1',
      namespace: 'sample-namespace',
      pullRequest: null,
      $query: jest.fn().mockReturnValue({
        patch: jest.fn().mockResolvedValue(undefined),
      }),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    } as any;
    const selectedService = {
      name: 'frontend',
      devConfig: {},
      baseDeploy: {
        id: 10,
        active: true,
        status: DeployStatus.READY,
        branchName: 'main',
        sha: 'abc123',
      },
      serviceRepo: 'example-org/frontend',
      serviceBranch: 'main',
    } as any;
    const sandboxDeploy = {
      id: 99,
      uuid: 'sandbox-deploy-1',
    } as any;

    jest.spyOn(service as any, 'loadBaseBuildAndCandidates').mockResolvedValue({
      baseBuild: {
        pullRequest: null,
      },
      environmentSource: {
        repo: 'example-org/environment',
        branch: 'main',
      },
      lifecycleConfig: {
        environment: {},
      },
      candidates: [selectedService],
      resolvedCandidates: [selectedService],
    });
    jest.spyOn(service as any, 'createSandboxBuild').mockResolvedValue({
      build: sandboxBuild,
      sandboxDeploysByBaseDeployId: new Map([[10, sandboxDeploy]]),
    });
    jest.spyOn(service as any, 'resolveSelectedSandboxDeploys').mockReturnValue([{ selectedService, sandboxDeploy }]);
    jest.spyOn(BuildEnvironmentVariables.prototype, 'resolve').mockResolvedValue(undefined);

    (service as any).buildService.updateStatusAndComment = jest.fn().mockResolvedValue(undefined);
    (service as any).buildService.generateAndApplyManifests = jest.fn().mockResolvedValue(true);
    (service as any).buildService.deleteBuild = jest.fn().mockResolvedValue(undefined);
    createSessionMock.mockResolvedValue({
      uuid: 'session-1',
    });

    const result = await service.launch({
      userId: 'user-1',
      baseBuildUuid: 'base-build-1',
      services: ['frontend'],
      model: 'sample-model',
      workspaceImage: 'sample-agent-image',
      workspaceEditorImage: 'sample-editor-image',
      readiness: { timeoutMs: 60000, pollMs: 2000 },
      resources: {
        workspace: { requests: {}, limits: {} },
        editor: { requests: {}, limits: {} },
        workspaceGateway: { requests: {}, limits: {} },
      },
    });

    expect((service as any).buildService.updateStatusAndComment).toHaveBeenNthCalledWith(
      1,
      sandboxBuild,
      BuildStatus.DEPLOYING,
      expect.any(String),
      false,
      false
    );
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buildUuid: 'sandbox-build-1',
        buildKind: BuildKind.SANDBOX,
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'created',
        buildUuid: 'sandbox-build-1',
      })
    );
  });

  it('rolls back sandbox build when opening_session createSession fails', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const createSessionMock = AgentSessionService.createSession as jest.Mock;
    const patchSandboxBuild = jest.fn().mockResolvedValue(undefined);
    const sandboxBuild = {
      id: 200,
      uuid: 'sandbox-build-1',
      namespace: 'sample-namespace',
      pullRequest: null,
      $query: jest.fn().mockReturnValue({
        patch: patchSandboxBuild,
      }),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    } as any;
    const selectedService = {
      name: 'frontend',
      devConfig: {
        image: 'node:20',
        command: 'pnpm dev',
      },
      baseDeploy: {
        id: 10,
        active: true,
        status: DeployStatus.READY,
        branchName: 'main',
        sha: 'abc123',
      },
      serviceRepo: 'example-org/frontend',
      serviceBranch: 'main',
    } as any;
    const sandboxDeploy = {
      id: 99,
      uuid: 'sandbox-deploy-1',
    } as any;
    const userIdentity = {
      userId: 'sample-user',
      githubUsername: 'sample-user',
      preferredUsername: 'sample-user',
      email: 'sample-user@example.com',
      displayName: 'Sample User',
    };
    const events: string[] = [];
    const createSessionError = new Error('workspace startup failed');

    jest.spyOn(service as any, 'loadBaseBuildAndCandidates').mockResolvedValue({
      baseBuild: {
        pullRequest: { pullRequestNumber: 42 },
      },
      environmentSource: {
        repo: 'example-org/environment',
        branch: 'main',
      },
      lifecycleConfig: {
        environment: {
          agentSession: {
            skills: ['sample-skill'],
          },
        },
      },
      candidates: [selectedService],
      resolvedCandidates: [selectedService],
    });
    jest.spyOn(service as any, 'createSandboxBuild').mockResolvedValue({
      build: sandboxBuild,
      sandboxDeploysByBaseDeployId: new Map([[10, sandboxDeploy]]),
    });
    jest.spyOn(service as any, 'resolveSelectedSandboxDeploys').mockReturnValue([{ selectedService, sandboxDeploy }]);
    jest.spyOn(BuildEnvironmentVariables.prototype, 'resolve').mockResolvedValue(undefined);

    (service as any).buildService.updateStatusAndComment = jest.fn().mockResolvedValue(undefined);
    (service as any).buildService.generateAndApplyManifests = jest.fn().mockResolvedValue(true);
    (service as any).buildService.deleteBuild = jest.fn().mockResolvedValue(undefined);
    createSessionMock.mockImplementation(async () => {
      events.push('createSession');
      throw createSessionError;
    });

    await expect(
      service.launch({
        userId: 'sample-user',
        userIdentity,
        githubToken: 'sample-token',
        baseBuildUuid: 'base-build-1',
        services: ['frontend'],
        model: 'sample-model',
        workspaceImage: 'sample-agent-image',
        workspaceEditorImage: 'sample-editor-image',
        workspaceGatewayImage: 'sample-gateway-image',
        nodeSelector: { role: 'sample-node' },
        keepAttachedServicesOnSessionNode: true,
        readiness: { timeoutMs: 60000, pollMs: 2000 },
        resources: {
          workspace: { requests: {}, limits: {} },
          editor: { requests: {}, limits: {} },
          workspaceGateway: { requests: {}, limits: {} },
        },
        workspaceStorage: {
          storageSize: '10Gi',
          accessMode: 'ReadWriteOnce',
          requestedSize: '10Gi',
        },
        redisTtlSeconds: 30,
        onProgress: async (stage) => {
          events.push(`progress:${stage}`);
        },
      })
    ).rejects.toThrow(createSessionError);

    expect((service as any).buildService.updateStatusAndComment).toHaveBeenNthCalledWith(
      1,
      sandboxBuild,
      BuildStatus.DEPLOYING,
      expect.any(String),
      false,
      false
    );
    expect((service as any).buildService.generateAndApplyManifests).toHaveBeenCalledWith({
      build: sandboxBuild,
      githubRepositoryId: null,
      namespace: 'sample-namespace',
    });
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sample-user',
        userIdentity,
        githubToken: 'sample-token',
        buildUuid: 'sandbox-build-1',
        buildKind: BuildKind.SANDBOX,
        model: 'sample-model',
        namespace: 'sample-namespace',
        services: [
          {
            name: 'frontend',
            deployId: 99,
            devConfig: selectedService.devConfig,
            resourceName: 'sandbox-deploy-1',
            repo: 'example-org/frontend',
            branch: 'main',
            revision: 'abc123',
          },
        ],
        prNumber: 42,
        workspaceImage: 'sample-agent-image',
        workspaceEditorImage: 'sample-editor-image',
        workspaceGatewayImage: 'sample-gateway-image',
        nodeSelector: { role: 'sample-node' },
        keepAttachedServicesOnSessionNode: true,
        workspaceStorage: {
          storageSize: '10Gi',
          accessMode: 'ReadWriteOnce',
          requestedSize: '10Gi',
        },
        redisTtlSeconds: 30,
      })
    );
    expect(events).toEqual(
      expect.arrayContaining([
        'progress:creating_sandbox_build',
        'progress:resolving_environment',
        'progress:deploying_resources',
        'progress:opening_session',
        'createSession',
      ])
    );
    expect(events.indexOf('progress:opening_session')).toBeLessThan(events.indexOf('createSession'));
    expect((service as any).buildService.deleteBuild).toHaveBeenCalledWith(sandboxBuild);
  });
});
