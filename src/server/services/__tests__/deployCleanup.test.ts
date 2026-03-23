/**
 * Copyright 2025 GoodRx, Inc.
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

import DeployService from '../deploy';
import DeployableService from '../deployable';
import { DeployStatus, DeployTypes } from 'shared/constants';

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  LogStage: {},
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getOrgChartName: jest.fn().mockResolvedValue('org-chart'),
      getAllConfigs: jest.fn().mockResolvedValue({}),
    })),
  },
}));

jest.mock('server/lib/nativeHelm/utils', () => ({
  uninstallHelmRelease: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('server/lib/shell', () => ({
  shellPromise: jest.fn().mockResolvedValue(''),
}));

jest.mock('server/lib/nativeHelm', () => ({
  ...jest.requireActual('server/lib/nativeHelm'),
  determineChartType: jest.fn().mockResolvedValue('PUBLIC'),
}));

const { uninstallHelmRelease } = require('server/lib/nativeHelm/utils');
const { shellPromise } = require('server/lib/shell');

function makeQueueManager() {
  const mockQueue = {
    add: jest.fn().mockResolvedValue(undefined),
    process: jest.fn(),
    on: jest.fn(),
  };
  return {
    registerQueue: jest.fn().mockReturnValue(mockQueue),
    _queue: mockQueue,
  };
}

describe('DeployService - processDeployCleanupQueue', () => {
  let deployService: DeployService;
  let mockDb: any;
  let mockQueueManager: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueueManager = makeQueueManager();

    mockDb = {
      models: {},
      services: {
        GithubService: {
          githubDeploymentQueue: { add: jest.fn().mockResolvedValue(undefined) },
        },
        BuildService: {
          updateStatusAndComment: jest.fn().mockResolvedValue(undefined),
        },
      },
    };

    deployService = new DeployService(mockDb, {} as any, {} as any, mockQueueManager);
  });

  const makeJob = (data: any) => ({ data });

  const makeDeploy = (overrides: any = {}) => ({
    id: 1,
    uuid: 'svc-a-build-uuid',
    active: true,
    status: DeployStatus.READY,
    deployable: {
      type: DeployTypes.DOCKER,
      $query: jest.fn().mockReturnThis(),
      patch: jest.fn().mockResolvedValue(undefined),
    },
    service: null,
    build: { status: 'deployed', runUUID: 'run-1', githubDeployments: false },
    $query: jest.fn().mockReturnThis(),
    patch: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  test('skips processing when deploy is already TORN_DOWN', async () => {
    const deploy = makeDeploy({ status: DeployStatus.TORN_DOWN });
    jest.spyOn(require('server/models').Deploy, 'query').mockReturnValue({
      findById: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(deploy),
    });

    await deployService.processDeployCleanupQueue(makeJob({ deployId: 1, namespace: 'env-test' }) as any);

    expect(uninstallHelmRelease).not.toHaveBeenCalled();
    expect(shellPromise).not.toHaveBeenCalled();
  });

  test('skips processing when deploy is inactive', async () => {
    const deploy = makeDeploy({ active: false });
    jest.spyOn(require('server/models').Deploy, 'query').mockReturnValue({
      findById: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(deploy),
    });

    await deployService.processDeployCleanupQueue(makeJob({ deployId: 1, namespace: 'env-test' }) as any);

    expect(uninstallHelmRelease).not.toHaveBeenCalled();
    expect(shellPromise).not.toHaveBeenCalled();
  });

  test('calls helm uninstall for HELM type deploy', async () => {
    const deploy = makeDeploy({
      deployable: {
        type: DeployTypes.HELM,
        $query: jest.fn().mockReturnThis(),
        patch: jest.fn().mockResolvedValue(undefined),
      },
    });
    jest.spyOn(require('server/models').Deploy, 'query').mockReturnValue({
      findById: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(deploy),
    });

    await deployService.processDeployCleanupQueue(makeJob({ deployId: 1, namespace: 'env-test' }) as any);

    expect(uninstallHelmRelease).toHaveBeenCalledWith('svc-a-build-uuid', 'env-test');
    expect(shellPromise).not.toHaveBeenCalled();
  });

  test('calls kubectl delete for GITHUB type deploy', async () => {
    const deploy = makeDeploy({
      deployable: {
        type: DeployTypes.GITHUB,
        $query: jest.fn().mockReturnThis(),
        patch: jest.fn().mockResolvedValue(undefined),
      },
    });
    jest.spyOn(require('server/models').Deploy, 'query').mockReturnValue({
      findById: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(deploy),
    });

    await deployService.processDeployCleanupQueue(makeJob({ deployId: 1, namespace: 'env-test' }) as any);

    expect(shellPromise).toHaveBeenCalledWith(
      expect.stringContaining('kubectl delete all,pvc -l deploy_uuid=svc-a-build-uuid --namespace env-test')
    );
    expect(uninstallHelmRelease).not.toHaveBeenCalled();
  });

  test('calls kubectl delete for DOCKER type deploy', async () => {
    const deploy = makeDeploy();
    jest.spyOn(require('server/models').Deploy, 'query').mockReturnValue({
      findById: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(deploy),
    });

    await deployService.processDeployCleanupQueue(makeJob({ deployId: 1, namespace: 'env-test' }) as any);

    expect(shellPromise).toHaveBeenCalledWith(
      expect.stringContaining('kubectl delete all,pvc -l deploy_uuid=svc-a-build-uuid --namespace env-test')
    );
  });

  test('patches deploy status to TORN_DOWN after cleanup', async () => {
    const deploy = makeDeploy();
    jest.spyOn(require('server/models').Deploy, 'query').mockReturnValue({
      findById: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(deploy),
    });

    await deployService.processDeployCleanupQueue(makeJob({ deployId: 1, namespace: 'env-test' }) as any);

    expect(deploy.patch).toHaveBeenCalledWith({ status: DeployStatus.TORN_DOWN, active: false });
  });

  test('refreshes PR comment after cleanup', async () => {
    const deploy = makeDeploy({ build: { status: 'deployed', runUUID: 'run-1', githubDeployments: false } });
    jest.spyOn(require('server/models').Deploy, 'query').mockReturnValue({
      findById: jest.fn().mockReturnThis(),
      withGraphFetched: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(deploy),
    });

    await deployService.processDeployCleanupQueue(makeJob({ deployId: 1, namespace: 'env-test' }) as any);

    expect(mockDb.services.BuildService.updateStatusAndComment).toHaveBeenCalledWith(
      deploy.build,
      'deployed',
      'run-1',
      true,
      true
    );
  });
});

describe('DeployableService - cleanupOrphanedDeploys', () => {
  let deployableService: DeployableService;
  let mockDb: any;
  let mockQueueManager: any;
  let mockEnqueueCleanup: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnqueueCleanup = jest.fn().mockResolvedValue(undefined);
    mockQueueManager = makeQueueManager();

    mockDb = {
      models: {
        Deployable: {
          query: jest.fn(),
        },
        Deploy: {
          query: jest.fn(),
        },
      },
      services: {
        Deploy: {
          enqueueDeployCleanup: mockEnqueueCleanup,
        },
      },
    };

    deployableService = new DeployableService(mockDb, {} as any, {} as any, mockQueueManager);
  });

  const makeDeployable = (id: number, name: string, active = true) => ({ id, name, active });
  const makeDeploy = (id: number, deployableId: number) => ({ id, deployableId });

  test('enqueues cleanup for orphaned deploy when a service is removed', async () => {
    const currentDeployables: any[] = [makeDeployable(1, 'service-a'), makeDeployable(2, 'service-b')];
    const existingDeployables = [...currentDeployables, makeDeployable(3, 'service-c')];
    const orphanDeploy = makeDeploy(10, 3);
    const build: any = { id: 42, namespace: 'env-test-abc', enableFullYaml: true };

    mockDb.models.Deployable.query.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(existingDeployables),
    });

    mockDb.models.Deploy.query.mockReturnValue({
      whereIn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue([orphanDeploy]),
    });

    await deployableService['cleanupOrphanedDeploys'](42, 'build-uuid-1', currentDeployables, build);

    expect(mockEnqueueCleanup).toHaveBeenCalledWith([orphanDeploy], 'env-test-abc');
  });

  test('does not enqueue cleanup when all services are still present', async () => {
    const currentDeployables: any[] = [makeDeployable(1, 'service-a'), makeDeployable(2, 'service-b')];
    const build: any = { id: 42, namespace: 'env-test-abc', enableFullYaml: true };

    mockDb.models.Deployable.query.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(currentDeployables),
    });

    await deployableService['cleanupOrphanedDeploys'](42, 'build-uuid-1', currentDeployables, build);

    expect(mockEnqueueCleanup).not.toHaveBeenCalled();
  });

  test('does not enqueue cleanup for already-inactive orphaned deployable', async () => {
    const currentDeployables: any[] = [makeDeployable(1, 'service-a')];
    const existingDeployables = [...currentDeployables, makeDeployable(2, 'service-b', false)];
    const build: any = { id: 42, namespace: 'env-test-abc', enableFullYaml: true };

    mockDb.models.Deployable.query.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(existingDeployables),
    });

    mockDb.models.Deploy.query.mockReturnValue({
      whereIn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue([]),
    });

    await deployableService['cleanupOrphanedDeploys'](42, 'build-uuid-1', currentDeployables, build);

    expect(mockEnqueueCleanup).not.toHaveBeenCalled();
  });

  test('enqueues cleanup for multiple orphaned services', async () => {
    const currentDeployables: any[] = [makeDeployable(1, 'service-a')];
    const existingDeployables = [
      ...currentDeployables,
      makeDeployable(2, 'old-service-b'),
      makeDeployable(3, 'old-service-c'),
    ];
    const orphanDeploys = [makeDeploy(10, 2), makeDeploy(11, 3)];
    const build: any = { id: 42, namespace: 'env-test-abc', enableFullYaml: true };

    mockDb.models.Deployable.query.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(existingDeployables),
    });

    mockDb.models.Deploy.query.mockReturnValue({
      whereIn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      catch: jest.fn().mockResolvedValue(orphanDeploys),
    });

    await deployableService['cleanupOrphanedDeploys'](42, 'build-uuid-1', currentDeployables, build);

    expect(mockEnqueueCleanup).toHaveBeenCalledWith(orphanDeploys, 'env-test-abc');
  });
});
