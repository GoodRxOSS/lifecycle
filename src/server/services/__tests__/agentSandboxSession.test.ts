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

import AgentSandboxSessionService, {
  formatRequestedSandboxServiceLabel,
  formatRequestedSandboxServicesLabel,
  summarizeRequestedSandboxServices,
} from '../agentSandboxSession';
import AgentSessionService from '../agentSession';
import { BuildEnvironmentVariables } from 'server/lib/buildEnvVariables';
import { getLogger } from 'server/lib/logger';
import { fetchLifecycleConfig, getDeployingServicesByName } from 'server/models/yaml';
import { Build, Deploy, Deployable, Repository } from 'server/models';
import { BuildStatus, BuildKind, DeployStatus, DeployTypes } from 'shared/constants';

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

function createLaunchOptions(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    baseBuildUuid: 'base-build-1',
    readiness: { timeoutMs: 60000, pollMs: 2000 },
    resources: {
      workspace: { requests: {}, limits: {} },
      editor: { requests: {}, limits: {} },
      workspaceGateway: { requests: {}, limits: {} },
    },
    ...overrides,
  } as any;
}

describe('agentSandboxSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AgentSessionService.createSession as jest.Mock).mockReset();
    (fetchLifecycleConfig as jest.Mock).mockReset();
    (getDeployingServicesByName as jest.Mock).mockReset();
    (getLogger as jest.Mock).mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    });
  });

  describe('requested service labels', () => {
    it('formats missing, unqualified, and qualified service requests for user-facing errors', () => {
      expect(formatRequestedSandboxServiceLabel()).toBe('unknown service');
      expect(formatRequestedSandboxServiceLabel('frontend')).toBe('frontend');
      expect(formatRequestedSandboxServiceLabel({ name: 'frontend' })).toBe('frontend');
      expect(formatRequestedSandboxServiceLabel({ name: 'frontend', repo: ' org/frontend ' })).toBe(
        'frontend (org/frontend)'
      );
      expect(formatRequestedSandboxServiceLabel({ name: 'frontend', branch: ' feature/dev ' })).toBe(
        'frontend (unknown-repo:feature/dev)'
      );
    });

    it('summarizes service counts without exposing qualifiers', () => {
      expect(summarizeRequestedSandboxServices()).toBe('unknown service');
      expect(summarizeRequestedSandboxServices([])).toBe('unknown service');
      expect(summarizeRequestedSandboxServices(['frontend'])).toBe('frontend');
      expect(summarizeRequestedSandboxServices([{ name: 'worker', repo: 'org/worker' }])).toBe('worker');
      expect(summarizeRequestedSandboxServices(['frontend', 'worker'])).toBe('2 services');
    });

    it('formats short service lists and truncates longer lists deterministically', () => {
      expect(formatRequestedSandboxServicesLabel()).toBe('unknown service');
      expect(formatRequestedSandboxServicesLabel([])).toBe('unknown service');
      expect(formatRequestedSandboxServicesLabel(['frontend', { name: 'worker', repo: 'org/worker' }])).toBe(
        'frontend, worker (org/worker)'
      );
      expect(formatRequestedSandboxServicesLabel(['frontend', 'worker', 'jobs', 'scheduler'])).toBe(
        'frontend, worker +2 more'
      );
    });
  });

  it('rejects a launch when the environment has no dev-mode sandboxable services', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const createSandboxBuild = jest.spyOn(service as any, 'createSandboxBuild');
    jest.spyOn(service as any, 'loadBaseBuildAndCandidates').mockResolvedValue({
      baseBuild: { uuid: 'base-build-1' },
      environmentSource: { repo: 'org/environment', branch: 'main' },
      lifecycleConfig: {},
      candidates: [],
      resolvedCandidates: [],
    });

    await expect(service.launch(createLaunchOptions())).rejects.toThrow(
      'No dev-mode sandboxable services were found in org/environment:main'
    );
    expect(createSandboxBuild).not.toHaveBeenCalled();
    expect(AgentSessionService.createSession).not.toHaveBeenCalled();
  });

  it('returns a stable, qualified selection list without creating resources when no service is requested', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const createSandboxBuild = jest.spyOn(service as any, 'createSandboxBuild');
    const candidates = [
      {
        name: 'worker',
        serviceRepo: 'org/worker',
        serviceBranch: 'main',
        baseDeploy: { deployable: { type: DeployTypes.GITHUB } },
      },
      {
        name: 'api',
        serviceRepo: 'org/api-z',
        serviceBranch: 'release',
        baseDeploy: { deployable: {} },
      },
      {
        name: 'api',
        serviceRepo: 'org/api-a',
        serviceBranch: 'main',
        baseDeploy: { deployable: { type: DeployTypes.DOCKER } },
      },
    ];
    jest.spyOn(service as any, 'loadBaseBuildAndCandidates').mockResolvedValue({
      baseBuild: { uuid: 'base-build-1' },
      environmentSource: { repo: 'org/environment', branch: 'main' },
      lifecycleConfig: {},
      candidates,
      resolvedCandidates: candidates,
    });

    await expect(service.launch(createLaunchOptions())).resolves.toEqual({
      status: 'needs_service_selection',
      services: [
        { name: 'api', type: DeployTypes.DOCKER, repo: 'org/api-a', branch: 'main' },
        { name: 'api', type: DeployTypes.GITHUB, repo: 'org/api-z', branch: 'release' },
        { name: 'worker', type: DeployTypes.GITHUB, repo: 'org/worker', branch: 'main' },
      ],
    });
    expect(createSandboxBuild).not.toHaveBeenCalled();
    expect(AgentSessionService.createSession).not.toHaveBeenCalled();
  });

  it('rejects a launch selection prompt when all sandboxable deploys are unavailable', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const resolvedCandidate = {
      name: 'frontend',
      serviceRepo: 'org/frontend',
      serviceBranch: 'main',
      baseDeploy: { active: true, status: DeployStatus.DEPLOY_FAILED },
    };
    jest.spyOn(service as any, 'loadBaseBuildAndCandidates').mockResolvedValue({
      baseBuild: { uuid: 'base-build-1' },
      environmentSource: { repo: 'org/environment', branch: 'main' },
      lifecycleConfig: {},
      candidates: [],
      resolvedCandidates: [resolvedCandidate],
    });

    await expect(service.launch(createLaunchOptions())).rejects.toThrow(
      'This environment has no ready services that can start a sandbox'
    );
    expect(AgentSessionService.createSession).not.toHaveBeenCalled();
  });

  it('rejects a branch-qualified request that does not match the resolved candidate', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const resolvedCandidate = {
      name: 'frontend',
      serviceRepo: 'org/frontend',
      serviceBranch: 'main',
      baseDeploy: { active: true, status: DeployStatus.READY },
    };
    const createSandboxBuild = jest.spyOn(service as any, 'createSandboxBuild');
    jest.spyOn(service as any, 'loadBaseBuildAndCandidates').mockResolvedValue({
      baseBuild: { uuid: 'base-build-1' },
      environmentSource: { repo: 'org/environment', branch: 'main' },
      lifecycleConfig: {},
      candidates: [resolvedCandidate],
      resolvedCandidates: [resolvedCandidate],
    });

    await expect(
      service.launch(
        createLaunchOptions({
          services: [{ name: 'frontend', repo: ' ORG/FRONTEND ', branch: 'release' }],
        })
      )
    ).rejects.toThrow('Unknown sandbox service: frontend (ORG/FRONTEND:release)');
    expect(createSandboxBuild).not.toHaveBeenCalled();
    expect(AgentSessionService.createSession).not.toHaveBeenCalled();
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

  it('reports resolution progress and stops when the base lifecycle config is unavailable', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    const onProgress = jest.fn();
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue(undefined);

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid, onProgress })).rejects.toThrow(
      `Lifecycle config not found for example-org/api-repo:${baseBuild.configSha}`
    );
    expect(onProgress).toHaveBeenNthCalledWith(1, 'resolving_base_build', `Loading base build ${baseBuild.uuid}`);
    expect(onProgress).toHaveBeenNthCalledWith(
      2,
      'resolving_services',
      'Reading environment config for example-org/api-repo on feature/api-environment'
    );
    expect(getDeployingServicesByName).not.toHaveBeenCalled();
  });

  it('omits unnamed, non-dev, and non-lifecycle-managed service references', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    baseBuild.deploys = [
      {
        ...baseBuild.deploys[0],
        id: 11,
        deployable: { name: 'no-dev', type: DeployTypes.GITHUB },
      },
      {
        ...baseBuild.deploys[0],
        id: 12,
        deployable: { name: 'unmanaged', type: DeployTypes.GITHUB },
      },
    ];
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    const lifecycleConfig = {
      environment: {
        defaultServices: [{}, { name: 'no-dev' }, { name: 'unmanaged' }],
        optionalServices: [],
      },
    };
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue(lifecycleConfig);
    (getDeployingServicesByName as jest.Mock).mockImplementation((_config, name) =>
      name === 'no-dev'
        ? {
            ...createSandboxableYamlService(),
            name,
            dev: undefined,
          }
        : {
            name,
            dev: { image: 'node:20', command: 'pnpm dev' },
            externalHttp: { defaultInternalHostname: 'unmanaged.example.test' },
          }
    );

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).resolves.toEqual([]);
    expect(getDeployingServicesByName).toHaveBeenCalledTimes(2);
  });

  it('deduplicates identical service references before resolving their configuration', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue({
      environment: {
        defaultServices: [{ name: 'frontend' }],
        optionalServices: [{ name: 'frontend' }],
      },
    });
    (getDeployingServicesByName as jest.Mock).mockReturnValue(createSandboxableYamlService());

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).resolves.toHaveLength(1);
    expect(getDeployingServicesByName).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when lifecycle config defines no environment service references', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue({});

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).resolves.toEqual([]);
    expect(getDeployingServicesByName).not.toHaveBeenCalled();
  });

  it.each([
    {
      caseName: 'the referenced repository has no lifecycle config',
      referencedConfig: undefined,
      referencedService: createSandboxableYamlService(),
    },
    {
      caseName: 'the referenced service is absent from its lifecycle config',
      referencedConfig: {},
      referencedService: undefined,
    },
  ])('skips a candidate and warns when $caseName', async ({ referencedConfig, referencedService }) => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    baseBuild.deploys[0] = {
      ...baseBuild.deploys[0],
      githubRepositoryId: 99,
      branchName: 'main',
      repository: { fullName: 'org/frontend', githubRepositoryId: 99 },
    };
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    const environmentConfig = {
      environment: {
        defaultServices: [{ name: 'frontend', repository: 'org/frontend', branch: 'main' }],
        optionalServices: [],
      },
    };
    (fetchLifecycleConfig as jest.Mock)
      .mockResolvedValueOnce(environmentConfig)
      .mockResolvedValueOnce(referencedConfig);
    (getDeployingServicesByName as jest.Mock).mockReturnValue(referencedService);
    const warn = jest.fn();
    (getLogger as jest.Mock).mockReturnValue({ info: jest.fn(), warn, error: jest.fn() });

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).resolves.toEqual([]);
    expect(fetchLifecycleConfig).toHaveBeenNthCalledWith(2, 'org/frontend', 'main');
    expect(warn).toHaveBeenCalledWith(
      `Sandbox: candidate skipped service=frontend buildUuid=${baseBuild.uuid} reason=config_error`
    );
  });

  it('fails closed when multiple active deploys match one qualified environment service reference', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    const matchingDeploy = {
      ...baseBuild.deploys[0],
      branchName: 'feature/api-environment',
      repository: { fullName: 'example-org/api-repo', githubRepositoryId: 84 },
    };
    baseBuild.deploys = [matchingDeploy, { ...matchingDeploy, id: 11, uuid: 'frontend-duplicate' }];
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue({
      environment: {
        defaultServices: [
          {
            name: 'frontend',
            repository: 'example-org/api-repo',
            branch: 'feature/api-environment',
          },
        ],
        optionalServices: [],
      },
    });

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).rejects.toThrow(
      'Multiple active deploys matched sandbox service frontend in example-org/api-repo on feature/api-environment'
    );
    expect(getDeployingServicesByName).not.toHaveBeenCalled();
  });

  it('describes an ambiguous unqualified environment service without adding absent qualifiers', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = createApiBaseBuild();
    baseBuild.deploys.push({
      ...baseBuild.deploys[0],
      id: 11,
      uuid: 'frontend-duplicate',
    });
    mockBaseBuildLoad(baseBuild);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue(createSandboxableLifecycleConfig());

    await expect(service.getServiceCandidates({ baseBuildUuid: baseBuild.uuid })).rejects.toThrow(
      'Multiple active deploys matched sandbox service frontend'
    );
    expect(getDeployingServicesByName).not.toHaveBeenCalled();
  });

  it('sorts same-name candidates by repository and branch when listing them directly', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const candidates = [
      {
        name: 'api',
        serviceRepo: 'org/api-z',
        serviceBranch: 'release',
        baseDeploy: { deployable: { type: DeployTypes.GITHUB } },
      },
      {
        name: 'worker',
        serviceRepo: 'org/worker',
        serviceBranch: 'main',
        baseDeploy: { deployable: { type: DeployTypes.DOCKER } },
      },
      {
        name: 'api',
        serviceRepo: 'org/api-a',
        serviceBranch: 'main',
        baseDeploy: { deployable: { type: DeployTypes.GITHUB } },
      },
    ];
    jest
      .spyOn(service as any, 'loadBaseBuildAndCandidates')
      .mockResolvedValue({ candidates, resolvedCandidates: candidates });

    await expect(service.getServiceCandidates({ baseBuildUuid: 'base-build-1' })).resolves.toEqual([
      { name: 'api', type: DeployTypes.GITHUB, repo: 'org/api-a', branch: 'main' },
      { name: 'api', type: DeployTypes.GITHUB, repo: 'org/api-z', branch: 'release' },
      { name: 'worker', type: DeployTypes.DOCKER, repo: 'org/worker', branch: 'main' },
    ]);
  });

  it.each([
    ['has no active deploy', [], 'Active deploy not found for dependency api in base build base-build-1'],
    [
      'is not ready',
      [
        {
          id: 2,
          active: true,
          status: DeployStatus.DEPLOY_FAILED,
          branchName: 'main',
          deployable: { id: 12, name: 'api' },
          repository: { fullName: 'org/api', githubRepositoryId: 12 },
        },
      ],
      'Service api must be ready before you can start a sandbox',
    ],
  ])(
    'rejects a public launch before opening a transaction when a required service %s',
    async (_case, dependencyDeploys, error) => {
      const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
      const baseDeploy = {
        id: 1,
        active: true,
        status: DeployStatus.READY,
        branchName: 'main',
        deployable: { id: 11, name: 'frontend' },
        repository: { fullName: 'org/frontend', githubRepositoryId: 11 },
      } as any;
      const selectedService = {
        name: 'frontend',
        devConfig: { image: 'node:20', command: 'pnpm dev' },
        baseDeploy,
        serviceRepo: 'org/frontend',
        serviceBranch: 'main',
        serviceConfigRef: 'main',
        serviceGithubRepositoryId: 11,
        yamlService: {
          ...createSandboxableYamlService(),
          requires: [{ name: 'api', repository: 'org/api' }],
        },
      } as any;
      jest.spyOn(service as any, 'loadBaseBuildAndCandidates').mockResolvedValue({
        baseBuild: { uuid: 'base-build-1', deploys: [baseDeploy, ...dependencyDeploys] },
        environmentSource: {
          repo: 'org/environment',
          branch: 'main',
          configRef: 'main',
          githubRepositoryId: 50,
        },
        lifecycleConfig: {},
        candidates: [selectedService],
        resolvedCandidates: [selectedService],
      });
      const transaction = jest.spyOn(Build, 'transaction');

      await expect(service.launch(createLaunchOptions({ services: ['frontend'] }))).rejects.toThrow(error);
      expect(transaction).not.toHaveBeenCalled();
      expect(AgentSessionService.createSession).not.toHaveBeenCalled();
    }
  );

  it('aborts launch inside the clone transaction when an inserted deployable cannot be reloaded', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseDeployable = {
      id: 101,
      name: 'frontend',
      ipWhitelist: [],
      $toJson: jest.fn(() => ({ id: 101, name: 'frontend', ipWhitelist: [] })),
    } as any;
    const baseDeploy = {
      id: 10,
      uuid: 'frontend-base',
      active: true,
      status: DeployStatus.READY,
      branchName: 'main',
      sha: 'frontend-sha',
      repository: { fullName: 'org/frontend', githubRepositoryId: 101 },
      deployable: baseDeployable,
      $toJson: jest.fn(() => ({
        id: 10,
        uuid: 'frontend-base',
        active: true,
        status: DeployStatus.READY,
        branchName: 'main',
        sha: 'frontend-sha',
      })),
    } as any;
    const baseBuild = {
      id: 100,
      uuid: 'base-build-1',
      deploys: [baseDeploy],
      $toJson: jest.fn(() => ({ id: 100, uuid: 'base-build-1', deploys: [baseDeploy] })),
    } as any;
    const selectedService = {
      name: 'frontend',
      devConfig: { image: 'node:20', command: 'pnpm dev' },
      baseDeploy,
      serviceRepo: 'org/frontend',
      serviceBranch: 'main',
      serviceConfigRef: 'main',
      serviceGithubRepositoryId: 101,
      yamlService: createSandboxableYamlService(),
    } as any;
    jest.spyOn(service as any, 'loadBaseBuildAndCandidates').mockResolvedValue({
      baseBuild,
      environmentSource: {
        repo: 'org/environment',
        branch: 'main',
        configRef: 'main',
        githubRepositoryId: 50,
      },
      lifecycleConfig: {},
      candidates: [selectedService],
      resolvedCandidates: [selectedService],
    });
    jest.spyOn(Build, 'transaction').mockImplementation(async (callback: any) => callback({ id: 'trx' }));
    const sandboxBuild = {
      id: 200,
      uuid: 'sandbox-build-1',
      namespace: 'sandbox-namespace',
      $query: jest.fn(),
      $fetchGraph: jest.fn(),
    } as any;
    jest.spyOn(Build, 'query').mockReturnValue({
      insertAndFetch: jest.fn().mockResolvedValue(sandboxBuild),
    } as any);
    const findById = jest.fn(() => Promise.resolve(undefined));
    jest.spyOn(Deployable, 'query').mockReturnValue({
      insertAndFetch: jest.fn().mockResolvedValue({ id: 301, name: 'frontend' }),
      findById,
    } as any);
    jest.spyOn(Deploy, 'query').mockReturnValue({
      insertAndFetch: jest.fn().mockResolvedValue({ id: 401, uuid: 'frontend-sandbox' }),
    } as any);
    (service as any).buildService.generateAndApplyManifests = jest.fn();
    (service as any).buildService.deleteBuild = jest.fn();

    await expect(service.launch(createLaunchOptions({ services: ['frontend'] }))).rejects.toThrow(
      'Sandbox deployable disappeared for frontend'
    );
    expect(findById).toHaveBeenCalledWith(301);
    expect((service as any).buildService.generateAndApplyManifests).not.toHaveBeenCalled();
    expect((service as any).buildService.deleteBuild).not.toHaveBeenCalled();
    expect(AgentSessionService.createSession).not.toHaveBeenCalled();
  });

  it('clones the selected service dependency closure and resets deploy state before opening a session', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const frontendDeployable = {
      id: 101,
      name: 'frontend',
      type: DeployTypes.GITHUB,
      buildId: 100,
      buildUUID: 'base-build-1',
      active: true,
      dependsOnDeployableId: 102,
      ipWhitelist: ['10.0.0.0/8', 'a"b\\c'],
      $toJson: jest.fn(() => ({
        id: 101,
        name: 'frontend',
        type: DeployTypes.GITHUB,
        buildId: 100,
        buildUUID: 'base-build-1',
        active: true,
        dependsOnDeployableId: 102,
        ipWhitelist: ['10.0.0.0/8', 'a"b\\c'],
        repository: { fullName: 'org/frontend' },
        environment: { name: 'base' },
        serviceDisks: [{ id: 1 }],
        createdAt: 'old-created-at',
        updatedAt: 'old-updated-at',
        deletedAt: null,
      })),
    } as any;
    const apiDeployable = {
      id: 102,
      name: 'api',
      type: DeployTypes.GITHUB,
      buildId: 100,
      buildUUID: 'base-build-1',
      active: true,
      dependsOnDeployableId: 104,
      ipWhitelist: [],
      $toJson: jest.fn(() => ({
        id: 102,
        name: 'api',
        type: DeployTypes.GITHUB,
        buildId: 100,
        buildUUID: 'base-build-1',
        active: true,
        dependsOnDeployableId: 104,
        ipWhitelist: [],
        repository: { fullName: 'org/api' },
      })),
    } as any;
    const frontendDeploy = {
      id: 10,
      uuid: 'frontend-base',
      buildId: 100,
      deployableId: 101,
      active: true,
      status: DeployStatus.READY,
      branchName: 'main',
      sha: 'frontend-sha',
      repository: { fullName: 'org/frontend', githubRepositoryId: 101 },
      deployable: frontendDeployable,
      $toJson: jest.fn(() => ({
        id: 10,
        uuid: 'frontend-base',
        buildId: 100,
        deployableId: 101,
        active: true,
        status: DeployStatus.READY,
        branchName: 'main',
        sha: 'frontend-sha',
        publicUrl: 'https://old-frontend.example.test',
        buildLogs: 'old build logs',
        containerLogs: 'old container logs',
        manifest: 'old manifest',
        buildPipelineId: 'old-build-pipeline',
        buildOutput: 'old build output',
        buildJobName: 'old-build-job',
        deployPipelineId: 'old-deploy-pipeline',
        deployOutput: 'old deploy output',
        devMode: true,
        devModeSessionId: 'old-session',
        service: { id: 1 },
        build: { id: 100 },
        deployable: frontendDeployable,
        repository: { fullName: 'org/frontend' },
        agentSession: { id: 1 },
      })),
    } as any;
    const apiDeploy = {
      id: 20,
      uuid: 'api-base',
      buildId: 100,
      deployableId: 102,
      active: true,
      status: DeployStatus.READY,
      branchName: 'main',
      sha: 'api-sha',
      repository: { fullName: 'org/api', githubRepositoryId: 102 },
      deployable: apiDeployable,
      $toJson: jest.fn(() => ({
        id: 20,
        uuid: 'api-base',
        buildId: 100,
        deployableId: 102,
        active: true,
        status: DeployStatus.READY,
        branchName: 'main',
        sha: 'api-sha',
        buildLogs: 'old api logs',
        deployable: apiDeployable,
        repository: { fullName: 'org/api' },
      })),
    } as any;
    const cacheDeployable = {
      id: 103,
      name: 'cache',
      type: DeployTypes.GITHUB,
      buildId: 100,
      buildUUID: 'base-build-1',
      active: true,
      dependsOnDeployableId: 0,
      ipWhitelist: [],
      $toJson: jest.fn(() => ({
        id: 103,
        name: 'cache',
        type: DeployTypes.GITHUB,
        buildId: 100,
        buildUUID: 'base-build-1',
        active: true,
        dependsOnDeployableId: 0,
        ipWhitelist: [],
      })),
    } as any;
    const cacheDeploy = {
      id: 30,
      uuid: 'cache-base',
      buildId: 100,
      deployableId: 103,
      active: true,
      status: DeployStatus.READY,
      branchName: 'main',
      sha: 'cache-sha',
      repository: { fullName: 'org/cache', githubRepositoryId: 103 },
      deployable: cacheDeployable,
      $toJson: jest.fn(() => ({
        id: 30,
        uuid: 'cache-base',
        buildId: 100,
        deployableId: 103,
        active: true,
        status: DeployStatus.READY,
        branchName: 'main',
        sha: 'cache-sha',
      })),
    } as any;
    const detachedDeployable = {
      id: 104,
      name: 'metrics',
    } as any;
    const detachedDeploy = {
      id: 40,
      uuid: 'metrics-base',
      active: true,
      status: DeployStatus.READY,
      branchName: 'main',
      repository: { fullName: 'org/metrics', githubRepositoryId: 104 },
      deployable: detachedDeployable,
    } as any;
    const baseBuild = {
      id: 100,
      uuid: 'base-build-1',
      namespace: 'base-namespace',
      kind: BuildKind.ENVIRONMENT,
      status: BuildStatus.DEPLOYED,
      deploys: [frontendDeploy, apiDeploy, cacheDeploy, detachedDeploy],
      pullRequest: null,
      $toJson: jest.fn(() => ({
        id: 100,
        uuid: 'base-build-1',
        namespace: 'base-namespace',
        kind: BuildKind.ENVIRONMENT,
        status: BuildStatus.DEPLOYED,
        branchName: 'main',
        deploys: [frontendDeploy, apiDeploy, cacheDeploy, detachedDeploy],
        services: [{ id: 1 }],
        buildServiceOverrides: [{ id: 1 }],
        pullRequest: null,
        environment: { id: 1 },
        deployables: [frontendDeployable, apiDeployable, cacheDeployable, detachedDeployable],
        baseBuild: { id: 99 },
        createdAt: 'old-created-at',
        updatedAt: 'old-updated-at',
        deletedAt: null,
      })),
    } as any;
    const frontendYamlService = {
      ...createSandboxableYamlService(),
      requires: [
        { name: 'api', repository: 'org/api', branch: 'main' },
        { name: 'cache', repository: 'org/cache', branch: 'main' },
      ],
    };
    const apiYamlService = {
      ...createSandboxableYamlService(),
      name: 'api',
      requires: [{ name: 'frontend', repository: 'org/frontend', branch: 'main' }],
    };
    const cacheYamlService = {
      ...createSandboxableYamlService(),
      name: 'cache',
      requires: [],
    };
    const selectedService = {
      name: 'frontend',
      devConfig: frontendYamlService.dev,
      baseDeploy: frontendDeploy,
      serviceRepo: 'org/frontend',
      serviceBranch: 'main',
      serviceConfigRef: 'main',
      serviceGithubRepositoryId: 101,
      yamlService: frontendYamlService,
    } as any;
    jest.spyOn(service as any, 'loadBaseBuildAndCandidates').mockResolvedValue({
      baseBuild,
      environmentSource: {
        repo: 'org/environment',
        branch: 'main',
        configRef: 'main',
        githubRepositoryId: 50,
      },
      lifecycleConfig: { environment: {} },
      candidates: [selectedService],
      resolvedCandidates: [selectedService],
    });
    (fetchLifecycleConfig as jest.Mock).mockImplementation(async (repo) => ({ repo }));
    (getDeployingServicesByName as jest.Mock).mockImplementation((_config, name) => {
      if (name === 'api') {
        return apiYamlService;
      }
      if (name === 'cache') {
        return cacheYamlService;
      }
      return frontendYamlService;
    });

    const transaction = { id: 'sandbox-transaction' };
    jest.spyOn(Build, 'transaction').mockImplementation(async (callback: any) => callback(transaction));
    const patchSandboxBuild = jest.fn().mockResolvedValue(undefined);
    const fetchSandboxBuildGraph = jest.fn().mockResolvedValue(undefined);
    let sandboxBuild: any;
    const insertBuild = jest.fn().mockImplementation(async (attributes) => {
      sandboxBuild = {
        ...attributes,
        id: 200,
        pullRequest: null,
        $query: jest.fn(() => ({ patch: patchSandboxBuild })),
        $fetchGraph: fetchSandboxBuildGraph,
      };
      return sandboxBuild;
    });
    jest.spyOn(Build, 'query').mockReturnValue({ insertAndFetch: insertBuild } as any);

    const clonedDeployables = new Map<number, any>();
    const deployablePatches = new Map<number, jest.Mock>();
    let nextDeployableId = 301;
    const insertDeployable = jest.fn().mockImplementation(async (attributes) => {
      const clonedDeployable = { ...attributes, id: nextDeployableId++ };
      clonedDeployables.set(clonedDeployable.id, clonedDeployable);
      return clonedDeployable;
    });
    const findDeployableById = jest.fn().mockImplementation((id: number) => {
      const clonedDeployable = clonedDeployables.get(id);
      const patch = jest.fn().mockImplementation(async (attributes) => {
        Object.assign(clonedDeployable, attributes);
      });
      deployablePatches.set(id, patch);
      return Object.assign(Promise.resolve(clonedDeployable), { patch });
    });
    jest.spyOn(Deployable, 'query').mockReturnValue({
      insertAndFetch: insertDeployable,
      findById: findDeployableById,
    } as any);

    const clonedDeploys: any[] = [];
    const insertDeploy = jest.fn().mockImplementation(async (attributes) => {
      const patch = jest.fn().mockResolvedValue(undefined);
      const clonedDeploy = {
        ...attributes,
        id: 401 + clonedDeploys.length,
        $query: jest.fn(() => ({ patch })),
      };
      clonedDeploys.push(clonedDeploy);
      return clonedDeploy;
    });
    jest.spyOn(Deploy, 'query').mockReturnValue({ insertAndFetch: insertDeploy } as any);
    (service as any).deployService.hostForDeployableDeploy = jest
      .fn()
      .mockImplementation((deploy, deployable) => `https://${deployable.name}-${deploy.id}.example.test`);
    jest.spyOn(BuildEnvironmentVariables.prototype, 'resolve').mockResolvedValue(undefined);
    (service as any).buildService.updateStatusAndComment = jest.fn().mockResolvedValue(undefined);
    (service as any).buildService.generateAndApplyManifests = jest.fn().mockResolvedValue(true);
    (service as any).buildService.deleteBuild = jest.fn().mockResolvedValue(undefined);
    (AgentSessionService.createSession as jest.Mock).mockResolvedValue({ uuid: 'session-1' });

    const result = await service.launch(createLaunchOptions({ services: ['frontend'] }));

    expect(result).toEqual({
      status: 'created',
      service: 'frontend',
      buildUuid: sandboxBuild.uuid,
      namespace: sandboxBuild.namespace,
      session: { uuid: 'session-1' },
      services: ['frontend'],
    });
    expect(Build.transaction).toHaveBeenCalledTimes(1);
    expect(insertBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: BuildKind.SANDBOX,
        baseBuildId: 100,
        namespace: expect.stringMatching(/^sbx-/),
        status: BuildStatus.QUEUED,
        githubDeployments: false,
        isStatic: false,
      })
    );
    const insertedBuild = insertBuild.mock.calls[0][0];
    expect(insertedBuild).not.toHaveProperty('id');
    expect(insertedBuild).not.toHaveProperty('deploys');
    expect(insertedBuild).not.toHaveProperty('environment');
    expect(insertDeployable).toHaveBeenCalledTimes(3);
    expect(insertDeployable).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        buildId: 200,
        buildUUID: sandboxBuild.uuid,
        active: true,
        ipWhitelist: '{"10.0.0.0/8","a\\"b\\\\c"}',
      })
    );
    expect(insertDeployable).toHaveBeenNthCalledWith(2, expect.objectContaining({ ipWhitelist: '{}' }));
    expect(insertDeployable).toHaveBeenNthCalledWith(3, expect.objectContaining({ ipWhitelist: '{}' }));
    expect(insertDeploy).toHaveBeenCalledTimes(3);
    expect(insertDeploy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        buildId: 200,
        deployableId: 301,
        active: true,
        status: DeployStatus.PENDING,
        statusMessage: '',
        buildLogs: '',
        containerLogs: '',
        manifest: '',
        devMode: false,
        devModeSessionId: null,
      })
    );
    expect(deployablePatches.get(301)).toHaveBeenCalledWith({ dependsOnDeployableId: 302 });
    expect(fetchSandboxBuildGraph).toHaveBeenCalledWith(
      '[pullRequest.[repository], environment, deploys.[deployable, repository]]'
    );
    expect((service as any).deployService.hostForDeployableDeploy).toHaveBeenCalledTimes(3);
    expect(fetchLifecycleConfig).toHaveBeenCalledTimes(3);
    expect(fetchLifecycleConfig).toHaveBeenCalledWith('org/api', 'main');
    expect(fetchLifecycleConfig).toHaveBeenCalledWith('org/cache', 'main');
    expect(fetchLifecycleConfig).toHaveBeenCalledWith('org/frontend', 'main');
    expect(AgentSessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        services: [
          expect.objectContaining({
            name: 'frontend',
            deployId: 401,
            repo: 'org/frontend',
            branch: 'main',
            revision: 'frontend-sha',
          }),
        ],
      })
    );
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
      devConfig: {
        agentSession: {
          readiness: { timeoutMs: 90000, pollMs: 500 },
        },
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
        readiness: { timeoutMs: 90000, pollMs: 500 },
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'created',
        buildUuid: 'sandbox-build-1',
      })
    );
  });

  it('marks a failed manifest deployment as an error and preserves the original failure when cleanup also fails', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const selectedService = {
      name: 'frontend',
      devConfig: { image: 'node:20', command: 'pnpm dev' },
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
    const patchSandboxBuild = jest.fn().mockResolvedValue(undefined);
    const sandboxBuild = {
      id: 200,
      uuid: 'sandbox-build-failed',
      namespace: 'sandbox-namespace',
      pullRequest: null,
      $query: jest.fn(() => ({ patch: patchSandboxBuild })),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    } as any;
    jest.spyOn(service as any, 'loadBaseBuildAndCandidates').mockResolvedValue({
      baseBuild: { pullRequest: null },
      environmentSource: { repo: 'example-org/environment', branch: 'main' },
      lifecycleConfig: { environment: {} },
      candidates: [selectedService],
      resolvedCandidates: [selectedService],
    });
    jest.spyOn(service as any, 'createSandboxBuild').mockResolvedValue({
      build: sandboxBuild,
      sandboxDeploysByBaseDeployId: new Map(),
    });
    jest.spyOn(BuildEnvironmentVariables.prototype, 'resolve').mockResolvedValue(undefined);
    const updateStatusAndComment = jest.fn().mockResolvedValue(undefined);
    const generateAndApplyManifests = jest.fn().mockResolvedValue(false);
    const cleanupError = new Error('cleanup unavailable');
    const deleteBuild = jest.fn().mockRejectedValue(cleanupError);
    (service as any).buildService.updateStatusAndComment = updateStatusAndComment;
    (service as any).buildService.generateAndApplyManifests = generateAndApplyManifests;
    (service as any).buildService.deleteBuild = deleteBuild;
    const warn = jest.fn();
    (getLogger as jest.Mock).mockReturnValue({ info: jest.fn(), warn, error: jest.fn() });

    await expect(service.launch(createLaunchOptions({ services: ['frontend'] }))).rejects.toThrow(
      'Sandbox deployment failed for sandbox-build-failed'
    );
    expect(updateStatusAndComment).toHaveBeenNthCalledWith(
      2,
      sandboxBuild,
      BuildStatus.ERROR,
      expect.any(String),
      false,
      false
    );
    expect(deleteBuild).toHaveBeenCalledWith(sandboxBuild);
    expect(warn).toHaveBeenCalledWith(
      { error: cleanupError, buildUuid: sandboxBuild.uuid },
      'Sandbox: cleanup failed action=launch_rollback buildUuid=sandbox-build-failed'
    );
    expect(AgentSessionService.createSession).not.toHaveBeenCalled();
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

  it('preserves an already-serialized ip allowlist while cloning through the public launch flow', async () => {
    const serializedIpWhitelist = '{"10.0.0.0/8","192.168.0.0/16"}';
    const baseDeployable = {
      id: 101,
      name: 'frontend',
      type: DeployTypes.GITHUB,
      buildId: 100,
      buildUUID: 'api-base-build',
      active: true,
      ipWhitelist: serializedIpWhitelist,
      $toJson: jest.fn(() => ({
        id: 101,
        name: 'frontend',
        type: DeployTypes.GITHUB,
        buildId: 100,
        buildUUID: 'api-base-build',
        active: true,
        ipWhitelist: serializedIpWhitelist,
      })),
    } as any;
    const configSha = '0123456789abcdef0123456789abcdef01234567';
    const baseDeploy = {
      id: 10,
      uuid: 'frontend-api-base-build',
      buildId: 100,
      deployableId: 101,
      active: true,
      status: DeployStatus.READY,
      branchName: configSha,
      sha: configSha,
      githubRepositoryId: 84,
      repository: { fullName: 'example-org/api-repo', githubRepositoryId: 84 },
      deployable: baseDeployable,
      $toJson: jest.fn(() => ({
        id: 10,
        uuid: 'frontend-api-base-build',
        buildId: 100,
        deployableId: 101,
        active: true,
        status: DeployStatus.READY,
        branchName: configSha,
        sha: configSha,
        githubRepositoryId: 84,
      })),
    } as any;
    const baseBuild = {
      id: 100,
      uuid: 'api-base-build',
      namespace: 'api-base-namespace',
      kind: BuildKind.ENVIRONMENT,
      status: BuildStatus.DEPLOYED,
      triggerType: 'api',
      githubRepositoryId: 84,
      branchName: 'feature/api-environment',
      configSha,
      pullRequest: null,
      deploys: [baseDeploy],
      $toJson: jest.fn(() => ({
        id: 100,
        uuid: 'api-base-build',
        namespace: 'api-base-namespace',
        kind: BuildKind.ENVIRONMENT,
        status: BuildStatus.DEPLOYED,
        triggerType: 'api',
        githubRepositoryId: 84,
        branchName: 'feature/api-environment',
        configSha,
        pullRequest: null,
        deploys: [baseDeploy],
      })),
    } as any;
    const loadBuildQuery = {
      findOne: jest.fn(() => ({
        whereNull: jest.fn(() => ({
          withGraphFetched: jest.fn().mockResolvedValue(baseBuild),
        })),
      })),
    };
    const patchSandboxBuild = jest.fn().mockResolvedValue(undefined);
    const sandboxBuild = {
      id: 200,
      uuid: 'sandbox-build-1',
      namespace: 'sbx-sandbox-build-1',
      pullRequest: null,
      deploys: [],
      $query: jest.fn(() => ({ patch: patchSandboxBuild })),
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    } as any;
    const insertBuild = jest.fn().mockResolvedValue(sandboxBuild);
    jest
      .spyOn(Build, 'query')
      .mockReturnValueOnce(loadBuildQuery as any)
      .mockReturnValue({ insertAndFetch: insertBuild } as any);
    mockLiveRepositoryLookup({
      fullName: 'example-org/api-repo',
      githubRepositoryId: 84,
      deletedAt: null,
    });
    const lifecycleConfig = createSandboxableLifecycleConfig();
    (fetchLifecycleConfig as jest.Mock).mockResolvedValue(lifecycleConfig);
    (getDeployingServicesByName as jest.Mock).mockReturnValue(createSandboxableYamlService());

    const transaction = { id: 'sandbox-transaction' };
    jest.spyOn(Build, 'transaction').mockImplementation(async (callback: any) => callback(transaction));
    const clonedDeployable = { id: 301, name: 'frontend' };
    const insertDeployable = jest.fn().mockResolvedValue(clonedDeployable);
    const findDeployableById = jest.fn().mockResolvedValue(clonedDeployable);
    jest.spyOn(Deployable, 'query').mockReturnValue({
      insertAndFetch: insertDeployable,
      findById: findDeployableById,
    } as any);
    const patchSandboxDeploy = jest.fn().mockResolvedValue(undefined);
    const sandboxDeploy = {
      id: 401,
      uuid: 'frontend-sandbox-build-1',
      $query: jest.fn(() => ({ patch: patchSandboxDeploy })),
    };
    const insertDeploy = jest.fn().mockResolvedValue(sandboxDeploy);
    jest.spyOn(Deploy, 'query').mockReturnValue({ insertAndFetch: insertDeploy } as any);

    const updateStatusAndComment = jest.fn().mockResolvedValue(undefined);
    const generateAndApplyManifests = jest.fn().mockResolvedValue(true);
    const deleteBuild = jest.fn().mockResolvedValue(undefined);
    const MockBuildService = jest.requireMock('../build').default as jest.Mock;
    MockBuildService.mockImplementationOnce(() => ({
      updateStatusAndComment,
      generateAndApplyManifests,
      deleteBuild,
    }));
    const hostForDeployableDeploy = jest.fn().mockReturnValue('frontend.sandbox.example.test');
    const MockDeployService = jest.requireMock('../deploy').default as jest.Mock;
    MockDeployService.mockImplementationOnce(() => ({ hostForDeployableDeploy }));
    jest.spyOn(BuildEnvironmentVariables.prototype, 'resolve').mockResolvedValue(undefined);
    (AgentSessionService.createSession as jest.Mock).mockResolvedValue({ uuid: 'session-1' });
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);

    await expect(
      service.launch(createLaunchOptions({ baseBuildUuid: baseBuild.uuid, services: ['frontend'] }))
    ).resolves.toEqual({
      status: 'created',
      service: 'frontend',
      buildUuid: sandboxBuild.uuid,
      namespace: sandboxBuild.namespace,
      session: { uuid: 'session-1' },
      services: ['frontend'],
    });

    expect(insertDeployable).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: sandboxBuild.id,
        buildUUID: sandboxBuild.uuid,
        ipWhitelist: serializedIpWhitelist,
      })
    );
    expect(hostForDeployableDeploy).toHaveBeenCalledWith(sandboxDeploy, clonedDeployable);
    expect(generateAndApplyManifests).toHaveBeenCalledTimes(1);
    expect(AgentSessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        buildUuid: sandboxBuild.uuid,
        services: [expect.objectContaining({ name: 'frontend', deployId: sandboxDeploy.id })],
      })
    );
    expect(deleteBuild).not.toHaveBeenCalled();
  });
});
