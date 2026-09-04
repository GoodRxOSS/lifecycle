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
const mockUpdatePullRequestActivityStream = jest.fn().mockResolvedValue(undefined);

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
  })),
}));

jest.mock('../build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    enqueueResolveAndDeployBuild: mockFallbackEnqueueResolveAndDeployBuild,
  })),
}));

jest.mock('../activityStream', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    updatePullRequestActivityStream: mockUpdatePullRequestActivityStream,
  })),
}));

import OverrideService, {
  ApplyBuildOverridesArgs,
  BuildConfigPatchInput,
  BuildOverrideInput,
  BuildUuidValidationError,
  ServiceOverrideNotFoundError,
  isBranchOrExternalUrlEditable,
} from '../override';
import { DeployTypes } from 'shared/constants';
import * as k8s from 'server/lib/kubernetes';

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
    });
  });

  it('leaves trackDefaultBranches untouched when the comment has no option line', async () => {
    const { service } = createService();
    const args = createFullYamlArgs({ redeployOnPush: undefined });

    await service.applyBuildOverrides(args);

    const patchArg = (args.build.$query().patch as jest.Mock).mock.calls[0][0];
    expect(patchArg).not.toHaveProperty('trackDefaultBranches');
  });

  it('persists an unchecked option line as false', async () => {
    const { service } = createService();
    const args = createFullYamlArgs({ redeployOnPush: false });

    await service.applyBuildOverrides(args);

    expect(args.build.$query().patch).toHaveBeenCalledWith(expect.objectContaining({ trackDefaultBranches: false }));
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

  it('refreshes the mission control comment when service overrides change but deploy is disabled', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();
    args.pullRequest = { deployOnUpdate: false } as any;

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

    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
    expect(result.queued).toBe(false);
    expect(mockUpdatePullRequestActivityStream).toHaveBeenCalledWith(
      args.build,
      [],
      args.pullRequest,
      null,
      true,
      true,
      null,
      true
    );
  });

  it('does not duplicate the comment refresh when service overrides already queue a redeploy', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();

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

    expect(enqueueResolveAndDeployBuild).toHaveBeenCalled();
    expect(mockUpdatePullRequestActivityStream).not.toHaveBeenCalled();
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
    };
    args.deploys.push(dockerDeploy as any);

    await expect(service.getServiceOverrideStates(args.deploys)).resolves.toEqual([
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
    expect(mockUpdatePullRequestActivityStream).toHaveBeenCalledWith(
      args.build,
      [],
      args.pullRequest,
      null,
      true,
      true,
      null,
      true
    );
  });

  it('does not duplicate the comment refresh when the config change already queues a redeploy', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createBuildConfigPatchArgs({
      isStatic: true,
    });

    await service.applyBuildConfigPatch(args);

    expect(enqueueResolveAndDeployBuild).toHaveBeenCalled();
    expect(mockUpdatePullRequestActivityStream).not.toHaveBeenCalled();
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
    });
  });
});

describe('OverrideService boundary behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (k8s.deleteNamespace as jest.Mock).mockResolvedValue(undefined);
  });

  it('reports deployment-type editability through the exported contract', () => {
    expect(isBranchOrExternalUrlEditable()).toBe(false);
    expect(isBranchOrExternalUrlEditable(DeployTypes.GITHUB)).toBe(true);
    expect(isBranchOrExternalUrlEditable(DeployTypes.HELM)).toBe(true);
    expect(isBranchOrExternalUrlEditable(DeployTypes.EXTERNAL_HTTP)).toBe(true);
    expect(isBranchOrExternalUrlEditable(DeployTypes.DOCKER)).toBe(false);
  });

  it('renders supported service override display values and filters unsupported deploy types', async () => {
    const { service } = createService();
    const deploy = (name: string, type: DeployTypes, values: Record<string, any> = {}) => {
      const { deployable: deployableValues, ...deployValues } = values;
      return {
        active: true,
        status: 'deployed',
        updatedAt: '2026-08-01T00:00:00.000Z',
        deployable: { name, type, active: true, buildId: 42, buildUUID: 'build-1', ...deployableValues },
        ...deployValues,
      };
    };

    const states = await service.getServiceOverrideStates([
      deploy('helm', DeployTypes.HELM, { branchName: '1.2.3' }),
      deploy('codefresh', DeployTypes.CODEFRESH, { branchName: null }),
      deploy('configuration', DeployTypes.CONFIGURATION, { branchName: 'config-branch' }),
      deploy('external', DeployTypes.EXTERNAL_HTTP, {
        publicUrl: null,
        deployable: { defaultPublicUrl: 'https://external.example.test' },
      }),
      deploy('docker-pinned', DeployTypes.DOCKER, {
        deployable: { dockerImage: 'registry.test/app', defaultTag: 'sha-123' },
      }),
      deploy('docker-tag', DeployTypes.DOCKER, { deployable: { defaultTag: 'latest' } }),
      deploy('unsupported', 'unsupported' as DeployTypes),
    ] as any);

    expect(states.map(({ name, branchOrExternalUrl }) => [name, branchOrExternalUrl])).toEqual([
      ['codefresh', null],
      ['configuration', 'config-branch'],
      ['docker-pinned', 'registry.test/app@sha-123'],
      ['docker-tag', 'latest'],
      ['external', 'https://external.example.test'],
      ['helm', '1.2.3'],
    ]);
  });

  it('ignores comment overrides when the build has no persisted id', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs();
    args.build.id = undefined as any;

    await service.applyBuildOverrides(args);

    expect(args.build.$query().patch).not.toHaveBeenCalled();
    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('rejects API config and service patches when the build has no persisted id', async () => {
    const { service } = createService();
    const configArgs = createBuildConfigPatchArgs({ isStatic: true });
    configArgs.build.id = undefined as any;
    await expect(service.applyBuildConfigPatch(configArgs)).rejects.toThrow('Build id is required');

    await expect(
      service.applyServiceOverrides({
        build: { id: undefined, uuid: 'build-1' } as any,
        deploys: [],
        serviceOverrides: [{ name: 'api', active: true }],
        runUuid: 'run-1',
      })
    ).rejects.toThrow('Build id is required');
  });

  it('rejects empty service override requests and requests with no mutable field', async () => {
    const { service } = createService();
    const build = { id: 42, uuid: 'build-1' } as any;

    await expect(
      service.applyServiceOverrides({ build, deploys: [], serviceOverrides: [], runUuid: 'run-1' })
    ).rejects.toThrow('serviceOverrides is required');
    await expect(service.validateServiceOverrides(build, [], [])).rejects.toThrow('serviceOverrides is required');
    await expect(service.validateServiceOverrides(build, [], [{ name: 'api' }])).rejects.toThrow(
      'active or branchOrExternalUrl is required'
    );
  });

  it('returns success without patching when a non-editable display value is unchanged', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const deploy = {
      active: true,
      deployable: {
        name: 'image',
        type: DeployTypes.DOCKER,
        active: true,
        dockerImage: 'registry.test/app',
        defaultTag: 'sha-123',
      },
      $query: jest.fn(() => ({ patch: jest.fn() })),
    } as any;

    await expect(
      service.applyServiceOverrides({
        build: { id: 42, uuid: 'build-1' } as any,
        deploys: [deploy],
        serviceOverrides: [{ name: 'image', branchOrExternalUrl: 'registry.test/app@sha-123' }],
        runUuid: 'run-1',
      })
    ).resolves.toEqual({ buildUuid: 'build-1', queued: false, status: 'success' });

    expect(deploy.$query().patch).not.toHaveBeenCalled();
    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('rejects a present service that has no supported override state', async () => {
    const { service } = createService();
    const deploy = {
      deployable: { name: 'unsupported', type: 'unsupported', active: true },
    } as any;

    await expect(
      service.validateServiceOverrides(
        { id: 42 } as any,
        [deploy],
        [{ name: 'unsupported', branchOrExternalUrl: 'main' }]
      )
    ).rejects.toBeInstanceOf(ServiceOverrideNotFoundError);
  });

  it('keeps a stale comment service name best-effort while applying the rest of the build override', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const args = createFullYamlArgs({
      serviceOverrides: [{ active: true, serviceName: 'removed-service', branchOrExternalUrl: 'main' }],
    });

    await service.applyBuildOverrides(args);

    expect(args.build.$query().patch).toHaveBeenCalled();
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith('Deploy: not found service=removed-service');
  });

  it('returns a safe validation failure when the UUID uniqueness query fails', async () => {
    const whereNull = jest.fn().mockRejectedValue(new Error('database unavailable'));
    const service = new OverrideService(
      {
        models: {
          Build: { query: jest.fn(() => ({ findOne: jest.fn(() => ({ whereNull })) })) },
        },
      } as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.validateUuid('available-name-123456', 42)).resolves.toEqual({
      valid: false,
      error: 'Unable to validate UUID',
    });
  });
});

describe('OverrideService.updateBuildUuid', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (k8s.deleteNamespace as jest.Mock).mockResolvedValue(undefined);
  });

  function updateHarness() {
    const trx = { name: 'transaction' };
    const buildPatch = jest.fn().mockResolvedValue(1);
    const deployablePatch = jest.fn().mockResolvedValue(2);
    const namedDeployPatch = jest.fn().mockResolvedValue(1);
    const unnamedDeployPatch = jest.fn();
    const namedDeploy = {
      id: 51,
      uuid: 'api-old-build',
      deployable: { name: 'api' },
      $query: jest.fn(() => ({ patch: namedDeployPatch })),
    };
    const unnamedDeploy = {
      id: 52,
      uuid: 'unnamed-old-build',
      deployable: {},
      $query: jest.fn(() => ({ patch: unnamedDeployPatch })),
    };
    const updatedBuild = { id: 42, uuid: 'new-build', namespace: 'env-new-build' };
    const deployQuery = {
      where: jest.fn(),
      withGraphFetched: jest.fn().mockResolvedValue([namedDeploy, unnamedDeploy]),
    };
    deployQuery.where.mockReturnValue(deployQuery);
    const deployableQuery = { where: jest.fn(), patch: deployablePatch };
    deployableQuery.where.mockReturnValue(deployableQuery);
    const buildQuery = { findById: jest.fn().mockResolvedValue(updatedBuild) };
    const transact = jest.fn(async (callback) => callback(trx));
    const db = {
      models: {
        Build: { transact, query: jest.fn(() => buildQuery) },
        Deployable: { query: jest.fn(() => deployableQuery) },
        Deploy: { query: jest.fn(() => deployQuery) },
      },
    };
    const build = {
      id: 42,
      uuid: 'old-build',
      namespace: 'env-old-build',
      $query: jest.fn(() => ({ patch: buildPatch })),
    } as any;
    const service = new OverrideService(db as any, {} as any, {} as any, {} as any);
    jest.spyOn(service, 'validateUuid').mockResolvedValue({ valid: true });
    return {
      service,
      db,
      build,
      trx,
      transact,
      buildPatch,
      deployablePatch,
      namedDeploy,
      namedDeployPatch,
      unnamedDeployPatch,
      updatedBuild,
    };
  }

  it('atomically updates the build, deployable and named deploy records, then retires the old namespace', async () => {
    const harness = updateHarness();

    await expect(harness.service.updateBuildUuid(harness.build, 'new-build')).resolves.toEqual({
      build: harness.updatedBuild,
      deploysUpdated: 2,
    });

    expect(harness.buildPatch).toHaveBeenCalledWith({ uuid: 'new-build', namespace: 'env-new-build' });
    expect(harness.db.models.Deployable.query).toHaveBeenCalledWith(harness.trx);
    expect(harness.deployablePatch).toHaveBeenCalledWith({ buildUUID: 'new-build' });
    expect(harness.namedDeploy.uuid).toBe('api-new-build');
    expect(harness.namedDeployPatch).toHaveBeenCalledWith({
      uuid: 'api-new-build',
      internalHostname: 'api-new-build',
      publicUrl: 'deployable-host',
    });
    expect(harness.unnamedDeployPatch).not.toHaveBeenCalled();
    expect(k8s.deleteNamespace).toHaveBeenCalledWith('env-old-build');
  });

  it('keeps a successful UUID transaction when old namespace cleanup fails asynchronously', async () => {
    const harness = updateHarness();
    (k8s.deleteNamespace as jest.Mock).mockRejectedValue(new Error('Kubernetes unavailable'));

    await expect(harness.service.updateBuildUuid(harness.build, 'new-build')).resolves.toEqual(
      expect.objectContaining({ deploysUpdated: 2 })
    );
    await Promise.resolve();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Namespace: delete failed name=env-old-build'
    );
  });

  it('rejects an unavailable UUID before opening a transaction', async () => {
    const harness = updateHarness();
    jest.spyOn(harness.service, 'validateUuid').mockResolvedValue({ valid: false, error: 'UUID is not available' });

    await expect(harness.service.updateBuildUuid(harness.build, 'new-build')).rejects.toBeInstanceOf(
      BuildUuidValidationError
    );

    expect(harness.transact).not.toHaveBeenCalled();
  });

  it('logs and propagates a transaction failure', async () => {
    const harness = updateHarness();
    harness.transact.mockRejectedValue(new Error('transaction failed'));

    await expect(harness.service.updateBuildUuid(harness.build, 'new-build')).rejects.toThrow('transaction failed');

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'UUID: update failed newUuid=new-build'
    );
  });
});
