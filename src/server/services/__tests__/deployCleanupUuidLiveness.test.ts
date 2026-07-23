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
  redisClient: { getConnection: jest.fn() },
}));

jest.mock('shared/config', () => ({
  QUEUE_NAMES: { DEPLOY_CLEANUP: 'deploy_cleanup_test' },
}));

jest.mock('server/lib/shell', () => ({ shellPromise: jest.fn() }));
jest.mock('server/lib/cli', () => ({ codefreshDestroy: jest.fn(), deleteDeploy: jest.fn() }));
jest.mock('server/lib/metrics', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ increment: jest.fn().mockReturnThis() })),
  Metrics: jest.fn().mockImplementation(() => ({ increment: jest.fn().mockReturnThis() })),
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
}));

import DeployCleanupService from '../deployCleanup';

describe('DeployCleanupService.destroyServiceDeployment uuid liveness', () => {
  function createService(db: any, queueAdd = jest.fn()) {
    const queueManager = { registerQueue: jest.fn(() => ({ add: queueAdd })) };
    return new DeployCleanupService(db, {} as any, {} as any, queueManager as any);
  }

  const liveBuild = {
    uuid: 'x',
    deletedAt: null,
    deploys: [{ id: 88, status: 'deployed', deployable: { name: 'api' } }],
  };
  it('selects the exact authorized live row when a tombstone shares the UUID', async () => {
    const liveChain: any = {
      findOne: jest.fn(() => liveChain),
      whereNull: jest.fn(() => liveChain),
      withGraphFetched: jest.fn().mockResolvedValue(liveBuild),
    };
    const query = jest.fn().mockReturnValue(liveChain);
    const queueAdd = jest.fn().mockResolvedValue(undefined);
    const service = createService({ models: { Build: { query } } }, queueAdd);

    const result = await service.destroyServiceDeployment('x', 'api', 41);

    expect(liveChain.findOne).toHaveBeenCalledWith({ uuid: 'x', id: 41 });
    expect(liveChain.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(queueAdd).toHaveBeenCalledWith('cleanup', expect.objectContaining({ deployId: 88, mode: 'infra' }));
    expect(result).toMatchObject({ status: 'success' });
  });

  it('not_founds a uuid held only by tombstones', async () => {
    const emptyChain: any = {
      findOne: jest.fn(() => emptyChain),
      whereNull: jest.fn(() => emptyChain),
      withGraphFetched: jest.fn().mockResolvedValue(undefined),
    };
    const query = jest.fn().mockReturnValue(emptyChain);
    const queueAdd = jest.fn();
    const service = createService({ models: { Build: { query } } }, queueAdd);

    const result = await service.destroyServiceDeployment('x', 'api');

    expect(result).toMatchObject({ status: 'not_found' });
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
