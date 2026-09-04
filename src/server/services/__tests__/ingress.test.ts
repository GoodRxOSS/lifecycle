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

const mockGetRedisConnection = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();
const mockGetAllConfigs = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: (...args: unknown[]) => mockGetRedisConnection(...args) },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  })),
  withLogContext: jest.fn((_context, action) => action()),
  LogStage: {
    INGRESS_PROCESSING: 'ingress-processing',
    INGRESS_COMPLETE: 'ingress-complete',
    INGRESS_FAILED: 'ingress-failed',
  },
}));

jest.mock('server/lib/shell', () => ({ shellPromise: jest.fn() }));

jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    __esModule: true,
    ...actualFs,
    default: {
      ...actualFs,
      promises: {
        ...actualFs.promises,
        mkdir: (...args: unknown[]) => mockMkdir(...args),
        writeFile: (...args: unknown[]) => mockWriteFile(...args),
      },
    },
  };
});

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
    })),
  },
}));

import yaml from 'js-yaml';
import { withLogContext } from 'server/lib/logger';
import { shellPromise } from 'server/lib/shell';
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

describe('IngressService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRedisConnection.mockReturnValue({ connection: 'redis' });
    mockGetAllConfigs.mockResolvedValue({
      lifecycleDefaults: {},
      domainDefaults: { altHttp: [] },
    });
    (shellPromise as jest.Mock).mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  test('registers the manifest and cleanup queues with bounded retention', () => {
    const connection = { connection: 'redis' };
    mockGetRedisConnection.mockReturnValue(connection);

    new IngressService({} as any, {} as any, {} as any, queueManager as any);

    expect(queueManager.registerQueue).toHaveBeenNthCalledWith(
      1,
      'ingress_manifest_default',
      expect.objectContaining({
        connection,
        defaultJobOptions: { attempts: 5, removeOnComplete: 100, removeOnFail: 100 },
      })
    );
    expect(queueManager.registerQueue).toHaveBeenNthCalledWith(
      2,
      'ingress_cleanup_default',
      expect.objectContaining({
        connection,
        defaultJobOptions: { attempts: 5, removeOnComplete: 100, removeOnFail: 100 },
      })
    );
  });

  test('keeps the legacy manifest update hook as a successful no-op', async () => {
    const service = new IngressService({} as any, {} as any, {} as any, queueManager as any);

    await expect(service.updateIngressManifest()).resolves.toBe(true);
    expect(shellPromise).not.toHaveBeenCalled();
  });

  test('cleans up every service ingress and tolerates an already-missing ingress', async () => {
    const configurationsForBuildId = jest
      .fn()
      .mockResolvedValue([{ deployUUID: 'web-build-1' }, { deployUUID: 'api-build-1' }]);
    const getNamespace = jest.fn().mockResolvedValue('env-build-1');
    const db = {
      services: { BuildService: { configurationsForBuildId, getNamespace } },
    };
    const service = new IngressService(db as any, {} as any, {} as any, queueManager as any);
    (shellPromise as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('api ingress not found'));

    await expect(
      service.ingressCleanupForBuild({
        data: {
          buildId: 7,
          buildUuid: 'build-1',
          sender: 'cleanup-test',
          correlationId: 'corr-1',
          _ddTraceContext: { traceId: 'trace-1' },
        },
      })
    ).resolves.toBeUndefined();

    expect(withLogContext).toHaveBeenCalledWith(
      {
        correlationId: 'corr-1',
        buildUuid: 'build-1',
        sender: 'cleanup-test',
        _ddTraceContext: { traceId: 'trace-1' },
      },
      expect.any(Function)
    );
    expect(configurationsForBuildId).toHaveBeenCalledWith(7, true);
    expect(getNamespace).toHaveBeenCalledWith({ id: 7 });
    expect(shellPromise).toHaveBeenCalledWith('kubectl delete ingress ingress-web-build-1 --namespace env-build-1');
    expect(shellPromise).toHaveBeenCalledWith('kubectl delete ingress ingress-api-build-1 --namespace env-build-1');
    expect(mockLoggerWarn).toHaveBeenCalledWith('Error: api ingress not found');
    expect(mockLoggerInfo).toHaveBeenCalledWith('Ingress: cleaned up');
  });

  test('reports a synchronous cleanup command failure without rejecting the job', async () => {
    const db = {
      services: {
        BuildService: {
          configurationsForBuildId: jest.fn().mockResolvedValue([{ deployUUID: 'web-build-1' }]),
          getNamespace: jest.fn().mockResolvedValue('env-build-1'),
        },
      },
    };
    const service = new IngressService(db as any, {} as any, {} as any, queueManager as any);
    const error = new Error('shell unavailable');
    (shellPromise as jest.Mock).mockImplementationOnce(() => {
      throw error;
    });

    await expect(service.ingressCleanupForBuild({ data: { buildId: 7 } })).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith({ error }, 'Ingress: cleanup failed');
    expect(mockLoggerInfo).not.toHaveBeenCalledWith('Ingress: cleaned up');
  });

  test('writes and applies an ingress manifest with alternate hosts, paths, labels, and a whitelist', async () => {
    const configuration = {
      deployUUID: 'web-build-1',
      host: 'web.example.test',
      pathPortMapping: { '/': 8080, '/health': 8081 },
      serviceHost: 'service-web',
      ingressAnnotations: { 'example.test/owner': 'platform' },
      ipWhitelist: ['10.0.0.0/8', '192.168.0.0/16'],
    };
    const db = {
      models: { Build: { query: jest.fn() } },
      services: {
        BuildService: {
          configurationsForBuildId: jest.fn().mockResolvedValue([configuration]),
          getNamespace: jest.fn().mockResolvedValue('env-build-1'),
        },
      },
    };
    mockGetAllConfigs.mockResolvedValueOnce({
      lifecycleDefaults: { ingressClassName: 'internal-nginx' },
      domainDefaults: { altHttp: ['alt.example.test', 'preview.example.test'] },
    });
    const service = new IngressService(db as any, {} as any, {} as any, queueManager as any);

    await service.createOrUpdateIngressForBuild({
      data: {
        buildId: 7,
        buildUuid: 'build-1',
        sender: 'manifest-test',
        correlationId: 'corr-2',
      },
    });

    expect(db.models.Build.query).not.toHaveBeenCalled();
    expect(db.services.BuildService.configurationsForBuildId).toHaveBeenCalledWith(7, false);
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('/ingress/global-ingress/'), {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('/global-ingress/7-0-nginx-ingress.yaml'),
      expect.any(String),
      'utf8'
    );
    const manifest = yaml.load(mockWriteFile.mock.calls[0][1] as string) as any;
    expect(manifest).toMatchObject({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: 'ingress-web-build-1',
        annotations: {
          'example.test/owner': 'platform',
          'nginx.ingress.kubernetes.io/whitelist-source-range': '10.0.0.0/8, 192.168.0.0/16',
        },
      },
      spec: { ingressClassName: 'internal-nginx' },
    });
    expect(manifest.spec.rules).toHaveLength(6);
    expect(manifest.spec.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: 'web.example.test' }),
        expect.objectContaining({ host: 'web-build-1.alt.example.test' }),
        expect.objectContaining({ host: 'web-build-1.preview.example.test' }),
      ])
    );
    expect(shellPromise).toHaveBeenCalledWith(
      expect.stringMatching(/^kubectl apply -f .*7-0-nginx-ingress\.yaml --namespace env-build-1$/),
      { timeout: 90_000 }
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith('Ingress: created');
  });

  test('skips all manifest work when the queued run has already been superseded', async () => {
    const authority = authorityQuery(null);
    const configurationsForBuildId = jest.fn();
    const db = {
      models: { Build: { query: jest.fn(() => authority) } },
      services: {
        BuildService: {
          configurationsForBuildId,
          getNamespace: jest.fn(),
        },
      },
    };
    const service = new IngressService(db as any, {} as any, {} as any, queueManager as any);

    await service.createOrUpdateIngressForBuild({
      data: { buildId: 7, runUUID: 'old-run', expectedGeneration: 4 },
    });

    expect(authority.findOne).toHaveBeenCalledWith({ id: 7, runUUID: 'old-run' });
    expect(authority.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(authority.where).toHaveBeenCalledWith('desiredGeneration', 4);
    expect(configurationsForBuildId).not.toHaveBeenCalled();
    expect(mockGetAllConfigs).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith('Ingress: skipped reason=superseded');
  });

  test('records an apply failure on the current build and still completes the ingress job', async () => {
    const read = authorityQuery({ id: 7, statusMessage: undefined });
    const patch: any = {
      patch: jest.fn(() => patch),
      where: jest.fn(() => patch),
      then: (resolve: (value: number) => void, reject: (reason: unknown) => void) =>
        Promise.resolve(1).then(resolve, reject),
    };
    const db = {
      models: { Build: { query: jest.fn().mockReturnValueOnce(read).mockReturnValueOnce(patch) } },
      services: {
        BuildService: {
          configurationsForBuildId: jest.fn().mockResolvedValue([
            {
              deployUUID: 'web-build-1',
              host: 'web.example.test',
              pathPortMapping: { '/': 8080 },
              serviceHost: 'service-web',
              ingressAnnotations: {},
              ipWhitelist: [],
            },
          ]),
          getNamespace: jest.fn().mockResolvedValue('env-build-1'),
        },
      },
    };
    const error = new Error('route rejected');
    (shellPromise as jest.Mock).mockRejectedValueOnce(error);
    const service = new IngressService(db as any, {} as any, {} as any, queueManager as any);

    await expect(service.createOrUpdateIngressForBuild({ data: { buildId: 7 } })).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith({ error }, 'Ingress: manifest apply failed');
    expect(patch.patch).toHaveBeenCalledWith({ statusMessage: 'Ingress apply failed: route rejected' });
    expect(patch.where).toHaveBeenCalledWith({ id: 7 });
    expect(mockLoggerInfo).toHaveBeenCalledWith('Ingress: created');
  });

  test('keeps the ingress job successful when recording an apply failure also fails', async () => {
    const configuration = {
      deployUUID: 'web-build-1',
      host: 'web.example.test',
      pathPortMapping: { '/': 8080 },
      serviceHost: 'service-web',
      ingressAnnotations: {},
      ipWhitelist: [],
    };
    const db = {
      models: { Build: { query: jest.fn() } },
      services: {
        BuildService: {
          configurationsForBuildId: jest.fn().mockResolvedValue([configuration]),
          getNamespace: jest.fn().mockResolvedValue('env-build-1'),
        },
      },
    };
    mockGetAllConfigs.mockResolvedValueOnce({});
    const applyError = new Error('route rejected');
    (shellPromise as jest.Mock).mockRejectedValueOnce(applyError);
    const service = new IngressService(db as any, {} as any, {} as any, queueManager as any);
    const recordFailure = jest
      .spyOn(service as any, 'recordIngressFailureOnBuild')
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.createOrUpdateIngressForBuild({ data: { buildId: 7 } })).resolves.toBeUndefined();

    expect(recordFailure).toHaveBeenCalledWith(7, applyError, undefined, undefined);
    const manifest = yaml.load(mockWriteFile.mock.calls[0][1] as string) as any;
    expect(manifest.spec).toMatchObject({
      ingressClassName: 'nginx',
      rules: [expect.objectContaining({ host: 'web.example.test' })],
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith('Ingress: created');
  });

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

  test.each([
    ['the build is no longer current', null, 'route\nrejected'],
    ['the build is no longer current after an undefined rejection', null, undefined],
    [
      'the same failure is already recorded',
      { id: 7, statusMessage: 'deployed | Ingress apply failed: bad route' },
      new Error('bad route'),
    ],
  ])('does not patch a failure note when %s', async (_name, build, error) => {
    const query = authorityQuery(build);
    const queryFactory = jest.fn().mockReturnValue(query);
    const db = {
      models: { Build: { query: queryFactory } },
      services: {},
    };
    const service = new IngressService(db as any, {} as any, {} as any, queueManager as any);

    await (service as any).recordIngressFailureOnBuild(7, error);

    expect(queryFactory).toHaveBeenCalledTimes(1);
    expect(query.findById).toHaveBeenCalledWith(7);
  });
});
