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

const mockShellPromise = jest.fn();
const mockCodefreshDestroy = jest.fn();
const mockDeleteDeploy = jest.fn();
const mockMetricsIncrement = jest.fn().mockReturnThis();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: {
    getConnection: jest.fn(),
  },
}));

jest.mock('shared/config', () => ({
  QUEUE_NAMES: {
    DEPLOY_CLEANUP: 'deploy_cleanup_test',
  },
}));

jest.mock('server/lib/shell', () => ({
  shellPromise: (...args: any[]) => mockShellPromise(...args),
}));

jest.mock('server/lib/cli', () => ({
  codefreshDestroy: (...args: any[]) => mockCodefreshDestroy(...args),
  deleteDeploy: (...args: any[]) => mockDeleteDeploy(...args),
}));

jest.mock('server/lib/metrics', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    increment: mockMetricsIncrement,
  })),
  Metrics: jest.fn().mockImplementation(() => ({
    increment: mockMetricsIncrement,
  })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
}));

import DeployCleanupService from '../deployCleanup';
import { DeployStatus, DeployTypes } from 'shared/constants';

describe('DeployCleanupService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShellPromise.mockResolvedValue('');
    mockCodefreshDestroy.mockResolvedValue('codefresh-build-id');
    mockDeleteDeploy.mockResolvedValue('');
  });

  function createQueueManager(queueAdd = jest.fn()) {
    return {
      registerQueue: jest.fn(() => ({
        add: queueAdd,
      })),
    };
  }

  function createService(db: any = {}, queueAdd = jest.fn()) {
    return new DeployCleanupService(db, {} as any, {} as any, createQueueManager(queueAdd) as any);
  }

  function createDeploy(overrides: any = {}) {
    const patch = jest.fn().mockResolvedValue(undefined);
    return {
      id: 77,
      uuid: 'old-api-build-1',
      deployableId: 9,
      build: {
        uuid: 'build-1',
        namespace: 'env-build-1',
      },
      deployable: {
        name: 'old-api',
        type: DeployTypes.HELM,
        serviceDisksYaml: JSON.stringify([{ name: 'data' }]),
      },
      service: null,
      env: {
        API_TOKEN: '{{aws:/service/api:token}}',
      },
      initEnv: {},
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      $query: jest.fn(() => ({ patch })),
      patch,
      ...overrides,
    } as any;
  }

  test('uses deploy-targeted Kubernetes and Helm cleanup only', async () => {
    const deploy = createDeploy();
    const service = createService();

    await service.cleanupDeploy(deploy, { mode: 'service' });

    const commands = mockShellPromise.mock.calls.map(([command]) => command as string);
    const joinedCommands = commands.join('\n');

    expect(commands).toContain(
      "kubectl delete deployment 'old-api-build-1' --namespace 'env-build-1' --ignore-not-found"
    );
    expect(commands).toContain(
      "kubectl delete service 'old-api-build-1' 'internal-lb-old-api-build-1' --namespace 'env-build-1' --ignore-not-found"
    );
    expect(commands).toContain(
      "kubectl delete ingress 'ingress-old-api-build-1' --namespace 'env-build-1' --ignore-not-found"
    );
    expect(commands).toContain(
      "kubectl delete pvc 'old-api-build-1-data-claim' --namespace 'env-build-1' --ignore-not-found"
    );
    expect(commands).toContain("helm uninstall 'old-api-build-1' --namespace 'env-build-1'");
    expect(joinedCommands).toContain('deploy_uuid=old-api-build-1');
    expect(joinedCommands).toContain('deploy-id=77');
    expect(joinedCommands).toContain('deployable-id=9');
    expect(joinedCommands).not.toContain('service=old-api');
    expect(joinedCommands).toContain(
      "kubectl delete externalsecret 'old-api-aws-secrets' --namespace 'env-build-1' --ignore-not-found"
    );
    expect(joinedCommands).toContain(
      "kubectl delete secret 'old-api-aws-secrets' --namespace 'env-build-1' --ignore-not-found"
    );

    expect(joinedCommands).not.toContain('delete namespace');
    expect(joinedCommands).not.toContain('delete all,pvc');
    expect(joinedCommands).not.toContain('lc_uuid=build-1');
    expect(mockCodefreshDestroy).not.toHaveBeenCalled();
    expect(mockDeleteDeploy).not.toHaveBeenCalled();
  });

  test('runs the existing codefresh destroy for stale codefresh deploys', async () => {
    const deploy = createDeploy({
      deployable: {
        name: 'old-codefresh',
        type: DeployTypes.CODEFRESH,
        serviceDisksYaml: null,
      },
      env: {},
    });
    const service = createService();

    await service.cleanupDeploy(deploy, { mode: 'service' });

    expect(mockCodefreshDestroy).toHaveBeenCalledWith(deploy);
    expect(mockDeleteDeploy).not.toHaveBeenCalled();
  });

  test('service mode continues after a targeted teardown failure', async () => {
    mockShellPromise.mockImplementation((command: string) => {
      if (command.includes('kubectl delete deployment')) {
        return Promise.reject(new Error('deployment delete failed'));
      }
      return Promise.resolve('');
    });
    const deploy = createDeploy();
    const service = createService();

    await expect(service.cleanupDeploy(deploy, { mode: 'service' })).resolves.toBe(false);

    const commands = mockShellPromise.mock.calls.map(([command]) => command as string);
    expect(commands).toContain("helm uninstall 'old-api-build-1' --namespace 'env-build-1'");
    expect(mockMetricsIncrement).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ result: 'error', resourceType: 'deployment' })
    );
    expect(deploy.patch).not.toHaveBeenCalled();
  });

  test('infra queue job marks deploy torn_down when cleanup succeeds', async () => {
    const deploy = createDeploy();
    const query = {
      findById: jest.fn(() => query),
      withGraphFetched: jest.fn().mockResolvedValue(deploy),
    };
    const service = createService({
      models: {
        Deploy: {
          query: jest.fn(() => query),
        },
      },
    });

    await service.processCleanupQueue({
      data: {
        deployId: 77,
        mode: 'infra',
      },
    } as any);

    expect(query.findById).toHaveBeenCalledWith(77);
    expect(deploy.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DeployStatus.TORN_DOWN,
      })
    );
  });

  test('infra partial failure leaves deploy status unchanged', async () => {
    mockShellPromise.mockImplementation((command: string) => {
      if (command.includes('kubectl delete deployment')) {
        return Promise.reject(new Error('deployment delete failed'));
      }
      return Promise.resolve('');
    });
    const deploy = createDeploy();
    const service = createService();

    await expect(service.cleanupDeploy(deploy, { mode: 'infra' })).resolves.toBe(false);

    expect(deploy.patch).not.toHaveBeenCalled();
  });

  test('missing Kubernetes resource types are skipped without failing infra cleanup', async () => {
    mockShellPromise.mockImplementation((command: string) => {
      if (command.includes('kubectl delete mapping')) {
        return Promise.reject(new Error('error: the server doesn\'t have a resource type "mapping"'));
      }
      return Promise.resolve('');
    });
    const deploy = createDeploy();
    const service = createService();

    await expect(service.cleanupDeploy(deploy, { mode: 'infra' })).resolves.toBe(true);

    expect(mockMetricsIncrement).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ result: 'skipped_missing_resource_type', resourceType: 'mapping' })
    );
    expect(deploy.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DeployStatus.TORN_DOWN,
      })
    );
  });

  test('enqueueCleanup queues infra cleanup jobs', async () => {
    const queueAdd = jest.fn().mockResolvedValue(undefined);
    const service = createService({}, queueAdd);

    await service.enqueueCleanup({ deployId: 77, mode: 'infra' });

    expect(queueAdd).toHaveBeenCalledWith(
      'cleanup',
      expect.objectContaining({
        deployId: 77,
        mode: 'infra',
      })
    );
  });

  test('deleteServiceRows deletes matching deploys before deployables in one transaction', async () => {
    const trx = { id: 'trx-1' };
    const deployDelete = jest.fn().mockResolvedValue(2);
    const deployableDelete = jest.fn().mockResolvedValue(2);
    const deployQuery = {
      where: jest.fn(() => deployQuery),
      whereIn: jest.fn(() => deployQuery),
      delete: deployDelete,
    };
    const deployableQuery = {
      whereIn: jest.fn(() => deployableQuery),
      delete: deployableDelete,
    };
    const transact = jest.fn(async (callback) => callback(trx));
    const db = {
      models: {
        Deploy: {
          query: jest.fn(() => deployQuery),
        },
        Deployable: {
          query: jest.fn(() => deployableQuery),
          transact,
        },
      },
    };
    const service = createService(db);

    await service.deleteServiceRows({ buildId: 10, deployableIds: [1, 1, 2] });

    expect(transact).toHaveBeenCalledTimes(1);
    expect(db.models.Deploy.query).toHaveBeenCalledWith(trx);
    expect(deployQuery.where).toHaveBeenCalledWith({ buildId: 10 });
    expect(deployQuery.whereIn).toHaveBeenCalledWith('deployableId', [1, 2]);
    expect(deployDelete).toHaveBeenCalled();
    expect(db.models.Deployable.query).toHaveBeenCalledWith(trx);
    expect(deployableQuery.whereIn).toHaveBeenCalledWith('id', [1, 2]);
    expect(deployableDelete).toHaveBeenCalled();
  });

  test('deleteServiceRows skips empty deployable id input', async () => {
    const transact = jest.fn();
    const service = createService({
      models: {
        Deployable: {
          transact,
        },
      },
    });

    await service.deleteServiceRows({ buildId: 10, deployableIds: [] });

    expect(transact).not.toHaveBeenCalled();
  });
});
