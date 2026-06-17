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

const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};
const mockFallbackEnqueueResolveAndDeployBuild = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
}));

jest.mock('server/lib/logger', () => ({
  extractContextForQueue: jest.fn(() => ({
    correlationId: 'test-correlation',
  })),
  getLogger: jest.fn(() => mockLogger),
  updateLogContext: jest.fn(),
}));

jest.mock('server/lib/kubernetes', () => ({
  deleteNamespace: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    hostForDeployableDeploy: jest.fn(() => 'deployable-host'),
    hostForServiceDeploy: jest.fn(() => 'service-host'),
  })),
}));

jest.mock('../build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    enqueueResolveAndDeployBuild: mockFallbackEnqueueResolveAndDeployBuild,
  })),
}));

import OverrideService, { ApplyBuildOverridesArgs, BuildConfigPatchInput, BuildOverrideInput } from '../override';
import { DeployTypes } from 'shared/constants';

const createPatchable = () => {
  const patch = jest.fn().mockResolvedValue(undefined);
  return {
    patch,
    model: {
      $query: jest.fn(() => ({
        patch,
      })),
    },
  };
};

function createService() {
  const enqueueResolveAndDeployBuild = jest.fn().mockResolvedValue(undefined);
  const db = {
    services: {
      BuildService: {
        enqueueResolveAndDeployBuild,
      },
      Deploy: {
        hostForDeployableDeploy: jest.fn(() => 'api-public-url'),
        hostForServiceDeploy: jest.fn(() => 'classic-public-url'),
      },
    },
  };

  return {
    db,
    enqueueResolveAndDeployBuild,
    service: new OverrideService(db as any, {} as any, {} as any, {} as any),
  };
}

function createFullYamlArgs(overrides: Partial<BuildOverrideInput> = {}): ApplyBuildOverridesArgs {
  const buildPatchable = createPatchable();
  const deployPatchable = createPatchable();
  const deployablePatchable = createPatchable();
  const dependentPatchable = createPatchable();

  const build = {
    id: 42,
    uuid: 'current-build',
    enableFullYaml: true,
    $query: buildPatchable.model.$query,
  };
  const deployable = {
    name: 'api',
    buildUUID: 'current-build',
    buildId: 42,
    active: true,
    type: DeployTypes.GITHUB,
    $query: deployablePatchable.model.$query,
  };
  const deploy = {
    active: true,
    branchName: 'main',
    publicUrl: 'api-public-url',
    deployable,
    service: {
      id: 7,
      name: 'api',
      type: DeployTypes.GITHUB,
    },
    $query: deployPatchable.model.$query,
  };
  const dependentDeploy = {
    active: true,
    deployable: {
      name: 'api-worker',
      dependsOnDeployableName: 'api',
      dependsOnServiceId: 7,
      buildUUID: 'current-build',
      buildId: 42,
      active: true,
      type: DeployTypes.GITHUB,
    },
    service: {
      id: 8,
      name: 'api-worker',
      type: DeployTypes.GITHUB,
    },
    $query: dependentPatchable.model.$query,
  };

  return {
    build: build as any,
    deploys: [deploy, dependentDeploy] as any,
    pullRequest: {
      deployOnUpdate: true,
    } as any,
    runUuid: 'run-uuid',
    overrides: {
      serviceOverrides: [
        {
          active: true,
          serviceName: 'api',
          branchOrExternalUrl: 'feature/api',
        },
      ],
      vanityUrl: null,
      envOverrides: {
        FEATURE_ENABLED: 'true',
      },
      redeployOnPush: true,
      ...overrides,
    },
  };
}

function createClassicArgs(overrides: Partial<BuildOverrideInput> = {}): ApplyBuildOverridesArgs {
  const buildPatchable = createPatchable();
  const deployPatchable = createPatchable();
  const deployablePatchable = createPatchable();
  const dependentPatchable = createPatchable();

  const build = {
    id: 42,
    uuid: 'current-build',
    enableFullYaml: false,
    environment: {
      defaultServices: [
        {
          id: 7,
        },
      ],
      optionalServices: [],
    },
    $query: buildPatchable.model.$query,
  };
  const deployable = {
    name: 'api',
    buildUUID: 'current-build',
    buildId: 42,
    type: DeployTypes.GITHUB,
    $query: deployablePatchable.model.$query,
  };
  const deploy = {
    serviceId: 7,
    active: true,
    branchName: 'main',
    publicUrl: 'classic-public-url',
    deployable,
    service: {
      id: 7,
      name: 'api',
      type: DeployTypes.GITHUB,
    },
    $query: deployPatchable.model.$query,
  };
  const dependentDeploy = {
    serviceId: 8,
    active: true,
    deployable: {
      name: 'api-worker',
      buildUUID: 'current-build',
      buildId: 42,
      type: DeployTypes.GITHUB,
    },
    service: {
      id: 8,
      name: 'api-worker',
      dependsOnServiceId: 7,
      type: DeployTypes.GITHUB,
    },
    $query: dependentPatchable.model.$query,
  };

  return {
    build: build as any,
    deploys: [deploy, dependentDeploy] as any,
    pullRequest: {
      deployOnUpdate: true,
    } as any,
    runUuid: 'run-uuid',
    overrides: {
      serviceOverrides: [
        {
          active: true,
          serviceName: 'api',
          branchOrExternalUrl: 'feature/api',
        },
      ],
      vanityUrl: null,
      envOverrides: {
        FEATURE_ENABLED: 'true',
      },
      redeployOnPush: true,
      ...overrides,
    },
  };
}

function createBuildConfigPatchArgs(patch: BuildConfigPatchInput = {}) {
  const buildPatchable = createPatchable();

  return {
    build: {
      id: 42,
      uuid: 'current-build',
      $query: buildPatchable.model.$query,
    } as any,
    pullRequest: {
      deployOnUpdate: true,
    } as any,
    patch,
    runUuid: 'run-uuid',
  };
}

describe('OverrideService.applyBuildOverrides', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('patches branch overrides on deploys and deployables', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();

    await service.applyBuildOverrides(args);

    expect(args.build.$query().patch).toHaveBeenCalledWith({
      commentInitEnv: {
        FEATURE_ENABLED: 'true',
      },
      commentRuntimeEnv: {
        FEATURE_ENABLED: 'true',
      },
      trackDefaultBranches: true,
    });
    expect(args.deploys[0]!.deployable!.$query().patch).toHaveBeenCalledWith({
      commentBranchName: 'feature/api',
    });
    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      branchName: 'feature/api',
      publicUrl: 'api-public-url',
      active: true,
    });
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith({
      buildId: 42,
      runUUID: 'run-uuid',
      triggerRef: 'run-uuid',
      correlationId: 'test-correlation',
    });
  });

  it('patches unchecked services as inactive while preserving branch override behavior', async () => {
    const { service } = createService();
    const args = createFullYamlArgs({
      serviceOverrides: [
        {
          active: false,
          serviceName: 'api',
          branchOrExternalUrl: 'feature/api',
        },
      ],
    });

    await service.applyBuildOverrides(args);

    expect(args.deploys[0]!.deployable!.$query().patch).toHaveBeenCalledWith({
      commentBranchName: 'feature/api',
    });
    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      branchName: 'feature/api',
      publicUrl: 'api-public-url',
      active: false,
    });
  });

  it('patches external URL overrides without updating commentBranchName', async () => {
    const { service } = createService();
    const args = createFullYamlArgs({
      serviceOverrides: [
        {
          active: true,
          serviceName: 'api',
          branchOrExternalUrl: 'api.example.com',
        },
      ],
    });

    await service.applyBuildOverrides(args);

    expect(args.deploys[0]!.deployable!.$query().patch).not.toHaveBeenCalled();
    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      publicUrl: 'api.example.com',
      branchName: null,
      dockerImage: null,
      active: true,
    });
  });

  it('cascades only active state to dependent deploys', async () => {
    const { service } = createService();
    const args = createFullYamlArgs({
      serviceOverrides: [
        {
          active: false,
          serviceName: 'api',
          branchOrExternalUrl: 'feature/api',
        },
      ],
    });

    await service.applyBuildOverrides(args);

    expect(args.deploys[1]!.$query().patch).toHaveBeenCalledWith({
      active: false,
    });
  });

  it('rejects invalid vanity UUIDs before applying other overrides', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs({
      vanityUrl: 'existing-build',
    });
    jest.spyOn(service, 'validateUuid').mockResolvedValueOnce({
      valid: false,
      error: 'UUID is not available',
    });
    const updateBuildUuid = jest.spyOn(service, 'updateBuildUuid');

    await service.applyBuildOverrides(args);

    expect(args.build.$query().patch).not.toHaveBeenCalled();
    expect(args.deploys[0]!.$query().patch).not.toHaveBeenCalled();
    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
    expect(updateBuildUuid).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'UUID: comment override rejected newUuid=existing-build error=UUID is not available'
    );
  });

  it('delegates valid vanity UUID updates to updateBuildUuid', async () => {
    const { service } = createService();
    const args = createFullYamlArgs({
      vanityUrl: 'new-build',
    });
    jest.spyOn(service, 'validateUuid').mockResolvedValueOnce({
      valid: true,
    });
    const updateBuildUuid = jest.spyOn(service, 'updateBuildUuid').mockResolvedValueOnce({
      build: {
        id: 42,
        uuid: 'new-build',
      } as any,
      deploysUpdated: 2,
    });

    await service.applyBuildOverrides(args);

    expect(updateBuildUuid).toHaveBeenCalledWith(args.build, 'new-build');
  });

  it('does not queue redeploy when deployOnUpdate is false', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();
    args.pullRequest = {
      deployOnUpdate: false,
    } as any;

    await service.applyBuildOverrides(args);

    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('keeps comment service patch failures best-effort and still queues redeploys', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();
    const patchError = new Error('comment branch patch failed');
    (args.deploys[0]!.deployable!.$query().patch as jest.Mock).mockRejectedValueOnce(patchError);

    await service.applyBuildOverrides(args);

    expect(mockLogger.error).toHaveBeenCalledWith(
      { error: patchError },
      'Deployable: patch failed service=api field=branch'
    );
    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      branchName: 'feature/api',
      publicUrl: 'api-public-url',
      active: true,
    });
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith({
      buildId: 42,
      runUUID: 'run-uuid',
      triggerRef: 'run-uuid',
      correlationId: 'test-correlation',
    });
  });

  it('applies active-only service overrides for UI selection changes', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();

    const result = await service.applyServiceOverrides({
      build: args.build,
      deploys: args.deploys,
      pullRequest: args.pullRequest,
      serviceOverrides: [
        {
          name: 'api',
          active: false,
        },
      ],
      runUuid: 'run-uuid',
    });

    expect(args.deploys[0]!.deployable!.$query().patch).not.toHaveBeenCalled();
    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      active: false,
    });
    expect(args.deploys[1]!.$query().patch).toHaveBeenCalledWith({
      active: false,
    });
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith({
      buildId: 42,
      runUUID: 'run-uuid',
      triggerRef: 'run-uuid',
      correlationId: 'test-correlation',
    });
    expect(result).toEqual({
      buildUuid: 'current-build',
      queued: true,
      status: 'success',
    });
  });

  it('applies service overrides without queueing when the build has no pull request', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();

    const result = await service.applyServiceOverrides({
      build: args.build,
      deploys: args.deploys,
      pullRequest: undefined,
      serviceOverrides: [
        {
          name: 'api',
          active: false,
        },
      ],
      runUuid: 'run-uuid',
    });

    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      active: false,
    });
    expect(args.deploys[1]!.$query().patch).toHaveBeenCalledWith({
      active: false,
    });
    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
    expect(result).toEqual({
      buildUuid: 'current-build',
      queued: false,
      status: 'success',
    });
  });

  it('applies branch-only service overrides without changing dependents', async () => {
    const { service } = createService();
    const args = createFullYamlArgs();

    await service.applyServiceOverrides({
      build: args.build,
      deploys: args.deploys,
      pullRequest: args.pullRequest,
      serviceOverrides: [
        {
          name: 'api',
          branchOrExternalUrl: 'feature/api',
        },
      ],
      runUuid: 'run-uuid',
    });

    expect(args.deploys[0]!.deployable!.$query().patch).toHaveBeenCalledWith({
      commentBranchName: 'feature/api',
    });
    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      branchName: 'feature/api',
      publicUrl: 'api-public-url',
    });
    expect(args.deploys[1]!.$query().patch).not.toHaveBeenCalled();
  });

  it('applies external URL service overrides without updating deployable branch state', async () => {
    const { service } = createService();
    const args = createFullYamlArgs();

    await service.applyServiceOverrides({
      build: args.build,
      deploys: args.deploys,
      pullRequest: args.pullRequest,
      serviceOverrides: [
        {
          name: 'api',
          active: false,
          branchOrExternalUrl: 'api.example.com',
        },
      ],
      runUuid: 'run-uuid',
    });

    expect(args.deploys[0]!.deployable!.$query().patch).not.toHaveBeenCalled();
    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      publicUrl: 'api.example.com',
      branchName: null,
      dockerImage: null,
      active: false,
    });
    expect(args.deploys[1]!.$query().patch).toHaveBeenCalledWith({
      active: false,
    });
  });

  it('cascades active state through service dependencies for non-full-yaml builds', async () => {
    const { service } = createService();
    const args = createClassicArgs();

    await service.applyServiceOverrides({
      build: args.build,
      deploys: args.deploys,
      pullRequest: args.pullRequest,
      serviceOverrides: [
        {
          name: 'api',
          active: false,
        },
      ],
      runUuid: 'run-uuid',
    });

    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      active: false,
    });
    expect(args.deploys[1]!.$query().patch).toHaveBeenCalledWith({
      active: false,
    });
  });

  it('applies multiple service overrides and queues only once', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();
    const webDeployPatchable = createPatchable();
    const webDeployablePatchable = createPatchable();
    const webDeploy = {
      deployable: {
        name: 'web',
        buildUUID: 'current-build',
        buildId: 42,
        active: true,
        type: DeployTypes.GITHUB,
        $query: webDeployablePatchable.model.$query,
      },
      service: {
        id: 9,
        name: 'web',
        type: DeployTypes.GITHUB,
      },
      active: true,
      branchName: 'main',
      publicUrl: 'web-public-url',
      $query: webDeployPatchable.model.$query,
    };
    args.deploys.push(webDeploy as any);

    const result = await service.applyServiceOverrides({
      build: args.build,
      deploys: args.deploys,
      pullRequest: args.pullRequest,
      serviceOverrides: [
        {
          name: 'api',
          active: false,
        },
        {
          name: 'web',
          branchOrExternalUrl: 'feature/web',
        },
      ],
      runUuid: 'run-uuid',
    });

    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      active: false,
    });
    expect(webDeploy.deployable.$query().patch).toHaveBeenCalledWith({
      commentBranchName: 'feature/web',
    });
    expect(webDeploy.$query().patch).toHaveBeenCalledWith({
      branchName: 'feature/web',
      publicUrl: 'api-public-url',
    });
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      buildUuid: 'current-build',
      queued: true,
      status: 'success',
    });
  });

  it('rejects missing services before applying batch overrides', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();

    await expect(
      service.applyServiceOverrides({
        build: args.build,
        deploys: args.deploys,
        pullRequest: args.pullRequest,
        serviceOverrides: [
          {
            name: 'api',
            active: false,
          },
          {
            name: 'missing-service',
            active: true,
          },
        ],
        runUuid: 'run-uuid',
      })
    ).rejects.toThrow('Service missing-service not found in build');

    expect(args.deploys[0]!.$query().patch).not.toHaveBeenCalled();
    expect(args.deploys[1]!.$query().patch).not.toHaveBeenCalled();
    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('rejects patch failures before queueing API service override redeploys', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();
    const patchError = new Error('deploy patch failed');
    (args.deploys[0]!.$query().patch as jest.Mock).mockRejectedValueOnce(patchError);

    await expect(
      service.applyServiceOverrides({
        build: args.build,
        deploys: args.deploys,
        pullRequest: args.pullRequest,
        serviceOverrides: [
          {
            name: 'api',
            active: false,
          },
        ],
        runUuid: 'run-uuid',
      })
    ).rejects.toThrow('deploy patch failed');

    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('rejects deployable patch failures before queueing API service override redeploys', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();
    const patchError = new Error('deployable patch failed');
    (args.deploys[0]!.deployable!.$query().patch as jest.Mock).mockRejectedValueOnce(patchError);

    await expect(
      service.applyServiceOverrides({
        build: args.build,
        deploys: args.deploys,
        pullRequest: args.pullRequest,
        serviceOverrides: [
          {
            name: 'api',
            branchOrExternalUrl: 'feature/api',
          },
        ],
        runUuid: 'run-uuid',
      })
    ).rejects.toThrow('deployable patch failed');

    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('falls back to a DeployService instance when deploy URL helpers are not wired', async () => {
    const enqueueResolveAndDeployBuild = jest.fn().mockResolvedValue(undefined);
    const db = {
      services: {
        BuildService: {
          enqueueResolveAndDeployBuild,
        },
      },
    };
    const service = new OverrideService(db as any, {} as any, {} as any, {} as any);
    const args = createFullYamlArgs();

    await service.applyServiceOverrides({
      build: args.build,
      deploys: args.deploys,
      pullRequest: args.pullRequest,
      serviceOverrides: [
        {
          name: 'api',
          branchOrExternalUrl: 'feature/api',
        },
      ],
      runUuid: 'run-uuid',
    });

    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      branchName: 'feature/api',
      publicUrl: 'deployable-host',
    });
  });

  it('returns full-yaml service override edit state and excludes internal dependencies', async () => {
    const { service } = createService();
    const args = createFullYamlArgs();
    const dockerDeploy = {
      active: false,
      status: 'built',
      statusMessage: 'Ready',
      updatedAt: '2026-05-08T12:00:00.000Z',
      deployable: {
        name: 'worker',
        active: false,
        type: DeployTypes.DOCKER,
        dockerImage: 'repo/worker',
        defaultTag: 'latest',
      },
      service: {
        id: 9,
        name: 'worker',
        type: DeployTypes.DOCKER,
      },
    };
    args.deploys.push(dockerDeploy as any);

    await expect(service.getServiceOverrideStates(args.build, args.deploys)).resolves.toEqual([
      expect.objectContaining({
        name: 'api',
        active: true,
        branchOrExternalUrl: 'main',
        group: 'default',
        editable: true,
      }),
      expect.objectContaining({
        name: 'worker',
        active: false,
        branchOrExternalUrl: 'repo/worker@latest',
        status: 'built',
        statusMessage: 'Ready',
        updatedAt: '2026-05-08T12:00:00.000Z',
        group: 'optional',
        editable: false,
      }),
    ]);
  });

  it('returns classic service override edit state grouped by environment membership', async () => {
    const { service } = createService();
    const args = createClassicArgs();
    const optionalDeploy = {
      serviceId: 9,
      active: false,
      branchName: 'feature/worker',
      publicUrl: 'worker-public-url',
      deployable: {
        name: 'worker',
        type: DeployTypes.HELM,
      },
      service: {
        id: 9,
        name: 'worker',
        type: DeployTypes.HELM,
      },
    };
    (args.build.environment!.optionalServices as any[]).push({ id: 9 });
    args.deploys.push(optionalDeploy as any);

    await expect(service.getServiceOverrideStates(args.build, args.deploys)).resolves.toEqual([
      expect.objectContaining({
        name: 'api',
        branchOrExternalUrl: 'main',
        group: 'default',
        editable: true,
      }),
      expect.objectContaining({
        name: 'worker',
        branchOrExternalUrl: 'feature/worker',
        group: 'optional',
        editable: true,
      }),
    ]);
  });

  it('ignores unchanged display-only branch values while applying active changes', async () => {
    const { service } = createService();
    const args = createFullYamlArgs();
    args.deploys[0]!.deployable!.type = DeployTypes.DOCKER;
    args.deploys[0]!.deployable!.dockerImage = 'repo/api';
    args.deploys[0]!.deployable!.defaultTag = 'latest';

    await service.applyServiceOverrides({
      build: args.build,
      deploys: args.deploys,
      pullRequest: args.pullRequest,
      serviceOverrides: [
        {
          name: 'api',
          active: false,
          branchOrExternalUrl: 'repo/api@latest',
        },
      ],
      runUuid: 'run-uuid',
    });

    expect(args.deploys[0]!.deployable!.$query().patch).not.toHaveBeenCalled();
    expect(args.deploys[0]!.$query().patch).toHaveBeenCalledWith({
      active: false,
    });
  });

  it('rejects changed display-only branch values before patching', async () => {
    const { service } = createService();
    const args = createFullYamlArgs();
    args.deploys[0]!.deployable!.type = DeployTypes.DOCKER;
    args.deploys[0]!.deployable!.dockerImage = 'repo/api';
    args.deploys[0]!.deployable!.defaultTag = 'latest';

    await expect(
      service.applyServiceOverrides({
        build: args.build,
        deploys: args.deploys,
        pullRequest: args.pullRequest,
        serviceOverrides: [
          {
            name: 'api',
            active: false,
            branchOrExternalUrl: 'repo/api@changed',
          },
        ],
        runUuid: 'run-uuid',
      })
    ).rejects.toThrow('Service api branchOrExternalUrl is not editable');

    expect(args.deploys[0]!.$query().patch).not.toHaveBeenCalled();
  });
});

describe('OverrideService.validateUuid', () => {
  it('rejects uppercase UUIDs before checking uniqueness', async () => {
    const findOne = jest.fn();
    const query = jest.fn(() => ({
      findOne,
    }));
    const service = new OverrideService(
      {
        models: {
          Build: {
            query,
          },
        },
      } as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.validateUuid('New-Build', 42)).resolves.toEqual({
      valid: false,
      error: 'UUID can only contain lowercase letters, numbers, and hyphens',
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('OverrideService.applyBuildConfigPatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('patches static mode by itself and queues redeploy', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createBuildConfigPatchArgs({
      isStatic: true,
    });

    const result = await service.applyBuildConfigPatch(args);

    expect(args.build.$query().patch).toHaveBeenCalledWith({
      isStatic: true,
    });
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith({
      buildId: 42,
      runUUID: 'run-uuid',
      triggerRef: 'run-uuid',
      correlationId: 'test-correlation',
    });
    expect(result).toMatchObject({
      uuid: 'current-build',
      isStatic: true,
    });
  });

  it('patches only provided build config fields and queues redeploy once', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createBuildConfigPatchArgs({
      isStatic: true,
      trackDefaultBranches: false,
      commentRuntimeEnv: {},
      commentInitEnv: {
        BOOT: 'enabled',
      },
    });

    const result = await service.applyBuildConfigPatch(args);

    expect(args.build.$query().patch).toHaveBeenCalledWith({
      isStatic: true,
      trackDefaultBranches: false,
      commentRuntimeEnv: {},
      commentInitEnv: {
        BOOT: 'enabled',
      },
    });
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith({
      buildId: 42,
      runUUID: 'run-uuid',
      triggerRef: 'run-uuid',
      correlationId: 'test-correlation',
    });
    expect(result).toMatchObject({
      uuid: 'current-build',
      isStatic: true,
      trackDefaultBranches: false,
      commentRuntimeEnv: {},
      commentInitEnv: {
        BOOT: 'enabled',
      },
    });
  });

  it('validates UUID before applying build config changes', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createBuildConfigPatchArgs({
      uuid: 'existing-build',
      isStatic: true,
      commentRuntimeEnv: {},
    });
    jest.spyOn(service, 'validateUuid').mockResolvedValueOnce({
      valid: false,
      error: 'UUID is not available',
    });
    const updateBuildUuid = jest.spyOn(service, 'updateBuildUuid');

    await expect(service.applyBuildConfigPatch(args)).rejects.toThrow('UUID is not available');

    expect(args.build.$query().patch).not.toHaveBeenCalled();
    expect(updateBuildUuid).not.toHaveBeenCalled();
    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('rejects no-op UUID changes before applying build config changes', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createBuildConfigPatchArgs({
      uuid: 'current-build',
      isStatic: true,
    });
    const validateUuid = jest.spyOn(service, 'validateUuid');

    await expect(service.applyBuildConfigPatch(args)).rejects.toThrow('UUID must be different');

    expect(validateUuid).not.toHaveBeenCalled();
    expect(args.build.$query().patch).not.toHaveBeenCalled();
    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('delegates valid UUID changes to updateBuildUuid after config patches', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createBuildConfigPatchArgs({
      uuid: 'new-build',
      isStatic: true,
    });
    jest.spyOn(service, 'validateUuid').mockResolvedValueOnce({
      valid: true,
    });
    const updateBuildUuid = jest.spyOn(service, 'updateBuildUuid').mockResolvedValueOnce({
      build: {
        id: 42,
        uuid: 'new-build',
        isStatic: true,
      } as any,
      deploysUpdated: 2,
    });

    const result = await service.applyBuildConfigPatch(args);

    expect(args.build.$query().patch).toHaveBeenCalledWith({
      isStatic: true,
    });
    expect(updateBuildUuid).toHaveBeenCalledWith(args.build, 'new-build');
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      id: 42,
      uuid: 'new-build',
      isStatic: true,
    });
  });

  it('supports UUID-only build config patches', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createBuildConfigPatchArgs({
      uuid: 'new-build',
    });
    jest.spyOn(service, 'validateUuid').mockResolvedValueOnce({
      valid: true,
    });
    const updateBuildUuid = jest.spyOn(service, 'updateBuildUuid').mockResolvedValueOnce({
      build: {
        id: 42,
        uuid: 'new-build',
      } as any,
      deploysUpdated: 2,
    });

    const result = await service.applyBuildConfigPatch(args);

    expect(args.build.$query().patch).not.toHaveBeenCalled();
    expect(updateBuildUuid).toHaveBeenCalledWith(args.build, 'new-build');
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith({
      buildId: 42,
      runUUID: 'run-uuid',
      triggerRef: 'run-uuid',
      correlationId: 'test-correlation',
    });
    expect(result).toMatchObject({
      id: 42,
      uuid: 'new-build',
    });
  });

  it('does not queue redeploy when deployOnUpdate is false', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createBuildConfigPatchArgs({
      isStatic: true,
    });
    args.pullRequest.deployOnUpdate = false;

    await service.applyBuildConfigPatch(args);

    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('patches build config without queueing when the build has no pull request', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createBuildConfigPatchArgs({
      isStatic: true,
    });
    args.pullRequest = undefined;

    const result = await service.applyBuildConfigPatch(args);

    expect(args.build.$query().patch).toHaveBeenCalledWith({
      isStatic: true,
    });
    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      uuid: 'current-build',
      isStatic: true,
    });
  });

  it('falls back to a BuildService instance when the service registry is not wired', async () => {
    const db = {
      services: {},
    };
    const service = new OverrideService(db as any, {} as any, {} as any, {} as any);
    const args = createBuildConfigPatchArgs({
      isStatic: true,
    });

    await service.applyBuildConfigPatch(args);

    expect(mockFallbackEnqueueResolveAndDeployBuild).toHaveBeenCalledWith({
      buildId: 42,
      runUUID: 'run-uuid',
      triggerRef: 'run-uuid',
      correlationId: 'test-correlation',
    });
  });
});
