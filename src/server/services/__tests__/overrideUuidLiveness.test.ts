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

jest.mock('server/lib/logger', () => ({
  extractContextForQueue: jest.fn(() => ({})),
  getLogger: jest.fn(() => ({ debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() })),
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
    enqueueResolveAndDeployBuild: jest.fn(),
  })),
}));

import OverrideService from '../override';

describe('OverrideService.validateUuid soft-delete semantics', () => {
  function makeService(existing: unknown) {
    const whereNull = jest.fn().mockResolvedValue(existing);
    const findOne = jest.fn(() => ({ whereNull }));
    const query = jest.fn(() => ({ findOne }));
    const service = new OverrideService({ models: { Build: { query } } } as any, {} as any, {} as any, {} as any);
    return { service, findOne, whereNull };
  }

  it('treats a uuid held only by soft-deleted builds as available', async () => {
    const { service, findOne, whereNull } = makeService(undefined);

    await expect(service.validateUuid('reused-name-123456', 42)).resolves.toEqual({ valid: true });
    expect(findOne).toHaveBeenCalledWith({ uuid: 'reused-name-123456' });
    expect(whereNull).toHaveBeenCalledWith('deletedAt');
  });

  it('still rejects a uuid held by a live build', async () => {
    const { service } = makeService({ id: 7 });

    await expect(service.validateUuid('taken-name-123456', 42)).resolves.toEqual({
      valid: false,
      error: 'UUID is not available',
    });
  });

  it('allows the current build to keep its own uuid', async () => {
    const { service } = makeService({ id: 42 });

    await expect(service.validateUuid('same-name-123456', 42)).resolves.toEqual({ valid: true });
  });
});
