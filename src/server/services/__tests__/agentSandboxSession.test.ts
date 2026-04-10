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
import { BuildStatus, BuildKind } from 'shared/constants';

describe('agentSandboxSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps repository identity when resolving duplicate dependency names', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = {
      uuid: 'base-build',
      deploys: [
        {
          id: 1,
          active: true,
          deployable: { name: 'frontend' },
          repository: { fullName: 'org/frontend' },
        },
        {
          id: 2,
          active: true,
          deployable: { name: 'shared-api' },
          repository: { fullName: 'org/api-a' },
        },
        {
          id: 3,
          active: true,
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
          branchName: 'main',
          deployable: { name: 'frontend' },
          repository: { fullName: 'org/frontend' },
        },
        {
          id: 2,
          active: true,
          branchName: 'main',
          deployable: { name: 'shared-api' },
          repository: { fullName: 'org/api' },
        },
        {
          id: 3,
          active: true,
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
});
