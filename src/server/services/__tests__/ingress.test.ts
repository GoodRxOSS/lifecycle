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

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: jest.fn() },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  withLogContext: jest.fn((_context, action) => action()),
  LogStage: {},
}));

jest.mock('server/lib/shell', () => ({ shellPromise: jest.fn() }));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: jest.fn().mockResolvedValue({
        lifecycleDefaults: {},
        domainDefaults: { altHttp: [] },
      }),
    })),
  },
}));

import IngressService from '../ingress';

const queueManager = {
  registerQueue: jest.fn(() => ({ add: jest.fn() })),
};

function authorityQuery(result: any) {
  const query: any = {
    findOne: jest.fn(() => query),
    findById: jest.fn(() => query),
    whereNull: jest.fn(() => query),
    where: jest.fn(() => query),
    then: (resolve: (value: any) => void, reject: (reason: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

describe('IngressService generation fencing', () => {
  test('applies ingress through the shared native promotion gate', async () => {
    const configuration = {
      deployUUID: 'deploy-a',
      host: 'a.example.test',
      pathPortMapping: { '/': 8080 },
      serviceHost: 'service-a',
      ingressAnnotations: {},
      ipWhitelist: [],
    };
    const gate = jest.fn(async (_buildId, isCurrent, action) => {
      expect(await isCurrent()).toBe(true);
      return { admitted: true, value: await action() };
    });
    const db = {
      models: { Build: { query: jest.fn(() => authorityQuery({ id: 7 })) } },
      services: {
        BuildService: {
          configurationsForBuildId: jest.fn().mockResolvedValue([configuration]),
          getNamespace: jest.fn().mockResolvedValue('env-test'),
          withCurrentBuildPromotionLock: gate,
        },
      },
    };
    const service = new IngressService(db as any, {} as any, {} as any, queueManager as any);
    const apply = jest.spyOn(service as any, 'applyManifests').mockResolvedValue(undefined);

    await service.createOrUpdateIngressForBuild({
      data: { buildId: 7, runUUID: 'run-c', expectedGeneration: 3 },
    });

    expect(gate).toHaveBeenCalledWith(7, expect.any(Function), expect.any(Function));
    expect(apply).toHaveBeenCalledWith(expect.any(String), '7-0-nginx', 'env-test', 7, 'run-c', 3);
  });

  test('does not apply when authority is lost before promotion admission', async () => {
    const gate = jest.fn().mockResolvedValue({ admitted: false });
    const db = {
      models: { Build: { query: jest.fn(() => authorityQuery({ id: 7 })) } },
      services: {
        BuildService: {
          configurationsForBuildId: jest.fn().mockResolvedValue([
            {
              deployUUID: 'deploy-a',
              host: 'a.example.test',
              pathPortMapping: { '/': 8080 },
              serviceHost: 'service-a',
              ingressAnnotations: {},
              ipWhitelist: [],
            },
          ]),
          getNamespace: jest.fn().mockResolvedValue('env-test'),
          withCurrentBuildPromotionLock: gate,
        },
      },
    };
    const service = new IngressService(db as any, {} as any, {} as any, queueManager as any);
    const apply = jest.spyOn(service as any, 'applyManifests');

    await service.createOrUpdateIngressForBuild({
      data: { buildId: 7, runUUID: 'run-a', expectedGeneration: 1 },
    });

    expect(apply).not.toHaveBeenCalled();
  });

  test('fences a late ingress failure note by run token and generation', async () => {
    const read = authorityQuery({ id: 7, statusMessage: 'deployed' });
    const patch: any = {
      patch: jest.fn(() => patch),
      where: jest.fn(() => patch),
      then: (resolve: (value: number) => void, reject: (reason: unknown) => void) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const db = {
      models: { Build: { query: jest.fn().mockReturnValueOnce(read).mockReturnValueOnce(patch) } },
      services: {},
    };
    const service = new IngressService(db as any, {} as any, {} as any, queueManager as any);

    await (service as any).recordIngressFailureOnBuild(7, new Error('bad route'), 'run-c', 3);

    expect(read.where).toHaveBeenCalledWith('runUUID', 'run-c');
    expect(read.where).toHaveBeenCalledWith('desiredGeneration', 3);
    expect(patch.patch).toHaveBeenCalledWith({ statusMessage: 'deployed | Ingress apply failed: bad route' });
    expect(patch.where).toHaveBeenCalledWith({ id: 7 });
    expect(patch.where).toHaveBeenCalledWith('runUUID', 'run-c');
    expect(patch.where).toHaveBeenCalledWith('desiredGeneration', 3);
  });
});
