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

const mockGetNativeBuildJobs = jest.fn();
const mockGetDeploymentJobs = jest.fn();
const mockGetArchivedLogsTail = jest.fn();

jest.mock('../getNativeBuildJobs', () => ({
  getNativeBuildJobs: (...args: unknown[]) => mockGetNativeBuildJobs(...args),
}));
jest.mock('../getDeploymentJobs', () => ({
  getDeploymentJobs: (...args: unknown[]) => mockGetDeploymentJobs(...args),
}));
jest.mock('server/services/logArchival', () => ({
  getLogArchivalService: () => ({ getArchivedLogsTail: mockGetArchivedLogsTail }),
}));

import {
  createDiagnosticJobLogDependencies,
  deriveDiagnosticTarget,
  DiagnosticReadError,
  readDiagnosticEvents,
  readDiagnosticJobLog,
  readNamespaceEventsBounded,
  readDiagnosticPods,
  readDiagnosticRuntimeLog,
  resolveDiagnosticService,
  type DiagnosticCoreApi,
  type DiagnosticJobLogDependencies,
} from '../diagnosticReaders';

const target = deriveDiagnosticTarget(
  {
    uuid: 'cute-mouse-123456',
    namespace: 'trusted-namespace',
  },
  [
    {
      name: 'api',
      deployUuid: 'api-cute-mouse-123456',
      provider: 'kubernetes',
    },
    {
      name: 'worker',
      deployUuid: 'worker-cute-mouse-123456',
      provider: 'kubernetes',
    },
    {
      name: 'pipeline',
      deployUuid: 'pipeline-cute-mouse-123456',
      provider: 'codefresh',
    },
  ]
);

function coreApi(overrides: Partial<DiagnosticCoreApi> = {}): DiagnosticCoreApi {
  return {
    listNamespacedPod: jest.fn().mockResolvedValue({ body: { items: [] } }),
    listNamespacedEvent: jest.fn().mockResolvedValue({ body: { items: [] } }),
    readNamespacedPodLog: jest.fn().mockResolvedValue({ body: '' }),
    ...overrides,
  };
}

describe('diagnosticReaders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses only the server-derived namespace and deploy selector', async () => {
    const api = coreApi();
    const service = resolveDiagnosticService(target, 'api');

    await readDiagnosticPods(target, api, service);

    expect(api.listNamespacedPod).toHaveBeenCalledWith(
      'trusted-namespace',
      undefined,
      undefined,
      undefined,
      undefined,
      'deploy_uuid=api-cute-mouse-123456'
    );
  });

  it('normalizes the namespace from the authorized build row', () => {
    expect(deriveDiagnosticTarget({ uuid: 'build-1', namespace: '  env-build-1  ' }, []).namespace).toBe('env-build-1');
    expect(deriveDiagnosticTarget({ uuid: 'build-2', namespace: '   ' }, []).namespace).toBeNull();
    expect(deriveDiagnosticTarget({ uuid: 'build-3' }, []).namespace).toBeNull();
  });

  it('fails before provider access when the authorized build has no namespace', async () => {
    const api = coreApi();
    const unprovisionedTarget = deriveDiagnosticTarget({ uuid: 'build-1', namespace: null }, []);

    await expect(readDiagnosticPods(unprovisionedTarget, api)).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: 'Kubernetes diagnostics are unavailable because this build has no namespace.',
    });
    expect(api.listNamespacedPod).not.toHaveBeenCalled();
  });

  it('resolves only services from the authorized server-derived target', () => {
    expect(resolveDiagnosticService(target, 'worker')).toMatchObject({ name: 'worker' });
    expect(() => resolveDiagnosticService(target, 'missing')).toThrow('No service named missing exists');

    try {
      resolveDiagnosticService(target, 'missing');
    } catch (error) {
      expect(error).toBeInstanceOf(DiagnosticReadError);
      expect(error).toMatchObject({
        name: 'DiagnosticReadError',
        code: 'service_not_found',
        details: { validServices: ['api', 'pipeline', 'worker'] },
      });
    }
  });

  it('bounds and sanitizes pod diagnostics returned by Kubernetes', async () => {
    const firstContainers = Array.from({ length: 21 }, (_, index) => ({
      name: index === 0 ? 'API_KEY=supersecretvalue123' : `container-${index}`,
      image: 'example/image',
    }));
    const firstStatuses = firstContainers.map((container, index) => ({
      name: container.name,
      ready: index === 0,
      restartCount: index === 0 ? -2 : 0,
      state: index === 0 ? { waiting: { reason: 'CrashLoopBackOff' } } : { running: {} },
    }));
    const items = Array.from({ length: 101 }, (_, index) => ({
      metadata: {
        name: index === 0 ? 'API_KEY=supersecretvalue123' : `api-${index}`,
        labels: { 'app.kubernetes.io/name': 'api' },
        creationTimestamp: new Date(Date.now() + 1_000),
      },
      spec: { containers: index === 0 ? firstContainers : [{ name: 'app', image: 'example/image' }] },
      status: {
        phase: 'Running',
        containerStatuses:
          index === 0 ? firstStatuses : [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }],
      },
    }));
    const api = coreApi({ listNamespacedPod: jest.fn().mockResolvedValue({ body: { items } }) });

    const result = await readDiagnosticPods(target, api);

    expect(result.pods).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.pods[0]).toMatchObject({
      service: 'api',
      status: 'CrashLoopBackOff',
      ready: '1/21',
      restarts: 0,
      ageSeconds: 0,
    });
    expect(result.pods[0].containers).toHaveLength(20);
    expect(result.pods[0].containers[0]).toMatchObject({
      state: 'waiting',
      reason: 'CrashLoopBackOff',
      restarts: 0,
    });
    expect(JSON.stringify(result.pods[0])).not.toContain('supersecretvalue123');
  });

  it('orders warning events first, bounds them, and redacts secret canaries', async () => {
    const api = coreApi({
      listNamespacedEvent: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              type: 'Normal',
              reason: 'Started',
              message: 'normal',
              involvedObject: { kind: 'Pod', name: 'api-1' },
            },
            ...Array.from({ length: 70 }, (_, index) => ({
              type: 'Warning',
              reason: `Warn${index}`,
              message: 'API_KEY=supersecretvalue123',
              involvedObject: { kind: 'Pod', name: `api-${index}` },
            })),
          ],
        },
      }),
    });

    const result = await readDiagnosticEvents(target, api);

    expect(result.events).toHaveLength(51);
    expect(result.events[0].type).toBe('Warning');
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('supersecretvalue123');
  });

  it('limits service events to application pods selected from the authorized deploy', async () => {
    const api = coreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            { metadata: { name: 'api-1', labels: { 'app.kubernetes.io/name': 'api' } } },
            { metadata: { name: 'builder', labels: { 'app.kubernetes.io/name': 'native-build' } } },
            { metadata: { labels: { 'app.kubernetes.io/name': 'api' } } },
          ],
        },
      }),
      listNamespacedEvent: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              type: 'Warning',
              reason: 'BackOff',
              message: 'retrying',
              count: -3,
              involvedObject: { kind: 'Pod', name: 'api-1' },
              eventTime: '2026-08-27T12:00:00.000Z',
            },
            { type: 'Warning', involvedObject: { kind: 'Pod', name: 'builder' } },
            { type: 'Normal', involvedObject: { kind: 'Pod', name: 'other-service-1' } },
          ],
        },
      }),
    });
    const service = resolveDiagnosticService(target, 'api');

    const result = await readDiagnosticEvents(target, api, service);

    expect(api.listNamespacedPod).toHaveBeenCalledWith(
      'trusted-namespace',
      undefined,
      undefined,
      undefined,
      undefined,
      'deploy_uuid=api-cute-mouse-123456'
    );
    expect(result).toEqual({
      events: [
        {
          type: 'Warning',
          reason: 'BackOff',
          object: 'Pod/api-1',
          message: 'retrying',
          count: 0,
          lastSeen: '2026-08-27T12:00:00.000Z',
        },
      ],
      truncated: false,
    });
  });

  it('supports warning-only source-tail reads with explicit bounds', async () => {
    const api = coreApi({
      listNamespacedEvent: jest.fn().mockResolvedValue({
        body: {
          items: [
            { type: 'Warning', reason: 'First', involvedObject: { name: 'api-1' } },
            { type: 'Normal', reason: 'Ignored', involvedObject: { name: 'api-1' } },
            { type: 'Warning', reason: 'Last', involvedObject: { name: 'api-1' } },
            { type: 'Warning', reason: 'Other', involvedObject: { name: 'other-1' } },
          ],
        },
      }),
    });

    const result = await readNamespaceEventsBounded('trusted-namespace', api, {
      allowedObjectNames: new Set(['api-1']),
      warningsOnly: true,
      sourceTail: true,
      maxWarnings: 1.9,
      maxNormal: -10,
    });

    expect(result.events).toEqual([
      {
        type: 'Warning',
        reason: 'Last',
        object: 'object/api-1',
        message: '',
        count: 0,
      },
    ]);
    expect(result.truncated).toBe(true);
  });

  it('sorts same-severity events newest first and supplies safe fallback fields', async () => {
    const api = coreApi({
      listNamespacedEvent: jest.fn().mockResolvedValue({
        body: {
          items: [
            { type: 'Normal', reason: 'Older', lastTimestamp: '2026-08-26T12:00:00.000Z' },
            { eventTime: '2026-08-27T12:00:00.000Z' },
          ],
        },
      }),
    });

    const result = await readNamespaceEventsBounded('trusted-namespace', api);

    expect(result.events[0]).toEqual({
      type: 'Unknown',
      reason: 'Unknown',
      object: 'object/unknown',
      message: '',
      count: 0,
      lastSeen: '2026-08-27T12:00:00.000Z',
    });
    expect(result.events[1].reason).toBe('Older');
  });

  it('reports a bounded upstream timeout', async () => {
    jest.useFakeTimers();
    try {
      const api = coreApi({
        listNamespacedEvent: jest.fn(() => new Promise(() => undefined)),
      });
      const pending = readNamespaceEventsBounded('trusted-namespace', api, { timeoutMs: 0 });

      jest.advanceTimersByTime(1);

      await expect(pending).rejects.toMatchObject({
        code: 'upstream_unavailable',
        message: 'The diagnostics provider timed out.',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('validates container and previous-log choices against the selected current pod', async () => {
    const api = coreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: {
                name: 'api-pod',
                creationTimestamp: '2026-07-25T00:00:00.000Z',
                labels: { 'app.kubernetes.io/name': 'api' },
              },
              spec: { containers: [{ name: 'app' }] },
              status: {
                containerStatuses: [{ name: 'app', restartCount: 1, lastState: { terminated: { reason: 'Error' } } }],
              },
            },
          ],
        },
      }),
      readNamespacedPodLog: jest.fn().mockResolvedValue({
        body: `API_KEY=supersecretvalue123\n${'x'.repeat(100_000)}`,
      }),
    });
    const service = resolveDiagnosticService(target, 'api');

    await expect(readDiagnosticRuntimeLog(target, service, api, { container: 'sidecar' })).rejects.toThrow(
      'Choose a container'
    );
    const result = await readDiagnosticRuntimeLog(target, service, api, {
      container: 'app',
      previous: true,
    });

    expect(api.readNamespacedPodLog).toHaveBeenCalledWith(
      'api-pod',
      'trusted-namespace',
      'app',
      undefined,
      undefined,
      64 * 1024,
      undefined,
      true,
      undefined,
      200
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(30 * 1024);
    expect(result.content).not.toContain('supersecretvalue123');
  });

  it('defaults an omitted container to the app container, not an init container', async () => {
    const api = coreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: {
                name: 'api-pod',
                creationTimestamp: '2026-07-25T00:00:00.000Z',
                labels: { 'app.kubernetes.io/name': 'api' },
              },
              spec: { initContainers: [{ name: 'wait-for-db' }], containers: [{ name: 'app' }] },
              status: {},
            },
          ],
        },
      }),
      readNamespacedPodLog: jest.fn().mockResolvedValue({ body: 'ready\n' }),
    });
    const service = resolveDiagnosticService(target, 'api');

    const result = await readDiagnosticRuntimeLog(target, service, api, {});

    expect(result.container).toBe('app');
    expect(api.readNamespacedPodLog).toHaveBeenCalledWith(
      'api-pod',
      'trusted-namespace',
      'app',
      undefined,
      undefined,
      64 * 1024,
      undefined,
      false,
      undefined,
      200
    );

    const initResult = await readDiagnosticRuntimeLog(target, service, api, { container: 'wait-for-db' });
    expect(initResult.container).toBe('wait-for-db');
  });

  it('rejects runtime reads for unsupported providers and missing pods', async () => {
    const pipeline = resolveDiagnosticService(target, 'pipeline');
    const api = coreApi();

    await expect(readDiagnosticRuntimeLog(target, pipeline, api)).rejects.toMatchObject({
      code: 'unsupported_log_source',
    });
    expect(api.listNamespacedPod).not.toHaveBeenCalled();

    const service = resolveDiagnosticService(target, 'api');
    await expect(readDiagnosticRuntimeLog(target, service, api)).rejects.toMatchObject({ code: 'logs_not_found' });
  });

  it('uses the newest application pod and excludes newer internal pods', async () => {
    const api = coreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: {
                name: 'older-api',
                creationTimestamp: '2026-08-25T00:00:00.000Z',
                labels: { 'app.kubernetes.io/name': 'api' },
              },
              spec: { containers: [{ name: 'app' }] },
            },
            {
              metadata: {
                name: 'newer-api',
                creationTimestamp: '2026-08-26T00:00:00.000Z',
                labels: { 'app.kubernetes.io/name': 'api' },
              },
              spec: { containers: [{ name: 'app' }] },
            },
            {
              metadata: {
                name: 'newest-builder',
                creationTimestamp: '2026-08-27T00:00:00.000Z',
                labels: { 'app.kubernetes.io/name': 'native-build' },
              },
              spec: { containers: [{ name: 'builder' }] },
            },
          ],
        },
      }),
      readNamespacedPodLog: jest.fn().mockResolvedValue({ body: 'ready\r\nstill ready\r' }),
    });
    const service = resolveDiagnosticService(target, 'api');

    const result = await readDiagnosticRuntimeLog(target, service, api, { tailLines: 0 });

    expect(result).toMatchObject({
      podName: 'newer-api',
      container: 'app',
      content: 'ready\nstill ready',
      totalLines: 2,
      truncated: true,
      previous: false,
    });
    expect(api.readNamespacedPodLog).toHaveBeenCalledWith(
      'newer-api',
      'trusted-namespace',
      'app',
      undefined,
      undefined,
      64 * 1024,
      undefined,
      false,
      undefined,
      1
    );
  });

  it('rejects previous logs unless the selected container has a terminated prior instance', async () => {
    const pod = {
      metadata: {
        name: 'api-pod',
        creationTimestamp: '2026-08-27T00:00:00.000Z',
        labels: { 'app.kubernetes.io/name': 'api' },
      },
      spec: { containers: [{ name: 'app' }] },
      status: { containerStatuses: [{ name: 'app', restartCount: 0 }] },
    };
    const api = coreApi({ listNamespacedPod: jest.fn().mockResolvedValue({ body: { items: [pod] } }) });
    const service = resolveDiagnosticService(target, 'api');

    await expect(readDiagnosticRuntimeLog(target, service, api, { previous: true })).rejects.toMatchObject({
      code: 'logs_not_found',
      message: 'No previous crashed container instance is available for this service.',
    });
    expect(api.readNamespacedPodLog).not.toHaveBeenCalled();
  });

  it('reports an empty container choice set and never requests a log', async () => {
    const api = coreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: {
                name: 'api-pod',
                creationTimestamp: '2026-08-27T00:00:00.000Z',
                labels: { 'app.kubernetes.io/name': 'api' },
              },
              spec: { containers: [{}, ...Array.from({ length: 25 }, () => ({ name: undefined }))] },
            },
          ],
        },
      }),
    });
    const service = resolveDiagnosticService(target, 'api');

    await expect(readDiagnosticRuntimeLog(target, service, api)).rejects.toMatchObject({
      code: 'invalid_body',
      details: { issues: [{ path: '/source/container', message: 'Choose one of: <none>' }] },
    });
    expect(api.readNamespacedPodLog).not.toHaveBeenCalled();
  });

  it('caps requested runtime log tails at the provider maximum', async () => {
    const api = coreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: {
                name: 'api-pod',
                creationTimestamp: '2026-08-27T00:00:00.000Z',
                labels: { 'app.kubernetes.io/name': 'api' },
              },
              spec: { containers: [{ name: 'app' }] },
            },
          ],
        },
      }),
      readNamespacedPodLog: jest.fn().mockResolvedValue({ body: '' }),
    });
    const service = resolveDiagnosticService(target, 'api');

    const result = await readDiagnosticRuntimeLog(target, service, api, { tailLines: 9_000.9 });

    expect(result).toMatchObject({ content: '', totalLines: 0, truncated: false });
    expect(api.readNamespacedPodLog).toHaveBeenCalledWith(
      'api-pod',
      'trusted-namespace',
      'app',
      undefined,
      undefined,
      64 * 1024,
      undefined,
      false,
      undefined,
      2_000
    );
  });

  it('marks a clamped overlong log line as truncated', async () => {
    const api = coreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: {
                name: 'api-pod',
                creationTimestamp: '2026-08-27T00:00:00.000Z',
                labels: { 'app.kubernetes.io/name': 'api' },
              },
              spec: { containers: [{ name: 'app' }] },
            },
          ],
        },
      }),
      readNamespacedPodLog: jest.fn().mockResolvedValue({ body: 'x'.repeat(3_000) }),
    });
    const service = resolveDiagnosticService(target, 'api');

    const result = await readDiagnosticRuntimeLog(target, service, api);

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content.length).toBeLessThanOrEqual(2_000);
    expect(result.totalLines).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('marks a live job log that fills the provider line cap as truncated', async () => {
    const dependencies: DiagnosticJobLogDependencies = {
      listJobs: jest
        .fn()
        .mockResolvedValue([{ jobName: 'build-api-1', status: 'Complete', podName: 'trusted-pod', source: 'live' }]),
      readLiveLog: jest.fn().mockResolvedValue(Array.from({ length: 2_000 }, (_, index) => `l${index}`).join('\n')),
      readArchivedLog: jest.fn(),
    };
    const service = resolveDiagnosticService(target, 'api');

    const result = await readDiagnosticJobLog(target, service, 'build', undefined, dependencies);

    expect(result.logSource).toBe('live');
    expect(result.totalLines).toBe(2_000);
    expect(result.truncated).toBe(true);
  });

  it('counts fetched lines without the trailing newline and trusts an under-cap fetch', async () => {
    const dependencies: DiagnosticJobLogDependencies = {
      listJobs: jest
        .fn()
        .mockResolvedValue([{ jobName: 'build-api-1', status: 'Complete', podName: 'trusted-pod', source: 'live' }]),
      readLiveLog: jest.fn().mockResolvedValue('one\ntwo\nthree'),
      readArchivedLog: jest.fn(),
    };
    const service = resolveDiagnosticService(target, 'api');

    const result = await readDiagnosticJobLog(target, service, 'build', undefined, dependencies);

    expect(result.totalLines).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('falls back from a missing live pod log to a byte-bounded archive', async () => {
    const dependencies: DiagnosticJobLogDependencies = {
      listJobs: jest
        .fn()
        .mockResolvedValue([{ jobName: 'build-api-1', status: 'Failed', podName: 'trusted-pod', source: 'live' }]),
      readLiveLog: jest.fn().mockResolvedValue(null),
      readArchivedLog: jest.fn().mockResolvedValue({
        logs: `failure\n${'z'.repeat(100_000)}`,
        truncated: true,
      }),
    };
    const service = resolveDiagnosticService(target, 'api');

    const result = await readDiagnosticJobLog(target, service, 'build', 'build-api-1', dependencies);

    expect(dependencies.readLiveLog).toHaveBeenCalledWith('trusted-pod', 'trusted-namespace', {
      limitBytes: 64 * 1024,
      tailLines: 2_000,
    });
    expect(dependencies.readArchivedLog).toHaveBeenCalledWith(
      'build',
      'api',
      'build-api-1',
      'trusted-namespace',
      64 * 1024
    );
    expect(result.logSource).toBe('archived');
    expect(result.truncated).toBe(true);
  });

  it('also falls back when the live log provider fails partially', async () => {
    const dependencies: DiagnosticJobLogDependencies = {
      listJobs: jest.fn().mockResolvedValue([
        {
          jobName: 'deploy-api-1',
          status: 'Complete',
          podName: 'trusted-pod',
          source: 'live',
        },
      ]),
      readLiveLog: jest.fn().mockRejectedValue(new Error('pod disappeared')),
      readArchivedLog: jest.fn().mockResolvedValue({ logs: 'archived deploy output', truncated: false }),
    };
    const service = resolveDiagnosticService(target, 'api');

    await expect(readDiagnosticJobLog(target, service, 'deploy', undefined, dependencies)).resolves.toMatchObject({
      logSource: 'archived',
      content: 'archived deploy output',
    });
  });

  it('creates job-log dependencies for build, deploy, live, and archived sources', async () => {
    mockGetNativeBuildJobs.mockResolvedValue([{ jobName: 'build-api-1', status: 'Complete' }]);
    mockGetDeploymentJobs.mockResolvedValue([{ jobName: 'deploy-api-1', status: 'Active' }]);
    mockGetArchivedLogsTail.mockResolvedValue({ logs: 'archive', truncated: false });
    const api = coreApi({ readNamespacedPodLog: jest.fn().mockResolvedValue({ body: '  live output  ' }) });
    const dependencies = createDiagnosticJobLogDependencies(api);

    await expect(dependencies.listJobs('build', 'api', 'trusted-namespace')).resolves.toEqual([
      { jobName: 'build-api-1', status: 'Complete' },
    ]);
    expect(mockGetNativeBuildJobs).toHaveBeenCalledWith('api', 'trusted-namespace');

    await expect(dependencies.listJobs('deploy', 'api', 'trusted-namespace')).resolves.toEqual([
      { jobName: 'deploy-api-1', status: 'Active' },
    ]);
    expect(mockGetDeploymentJobs).toHaveBeenCalledWith('api', 'trusted-namespace');

    await expect(
      dependencies.readLiveLog('pod-1', 'trusted-namespace', { limitBytes: 123, tailLines: 45 })
    ).resolves.toBe('live output');
    expect(api.readNamespacedPodLog).toHaveBeenCalledWith(
      'pod-1',
      'trusted-namespace',
      undefined,
      undefined,
      undefined,
      123,
      undefined,
      undefined,
      undefined,
      45
    );

    await expect(
      dependencies.readArchivedLog('deploy', 'api', 'deploy-api-1', 'trusted-namespace', 456)
    ).resolves.toEqual({ logs: 'archive', truncated: false });
    expect(mockGetArchivedLogsTail).toHaveBeenCalledWith('trusted-namespace', 'deploy', 'api', 'deploy-api-1', 456);

    (api.readNamespacedPodLog as jest.Mock).mockResolvedValueOnce({ body: '   ' });
    await expect(
      dependencies.readLiveLog('pod-1', 'trusted-namespace', { limitBytes: 123, tailLines: 45 })
    ).resolves.toBeNull();
  });

  it('reports missing job collections and requested jobs with bounded choices', async () => {
    const service = resolveDiagnosticService(target, 'api');
    const noJobs: DiagnosticJobLogDependencies = {
      listJobs: jest.fn().mockResolvedValue([]),
      readLiveLog: jest.fn(),
      readArchivedLog: jest.fn(),
    };
    await expect(readDiagnosticJobLog(target, service, 'build', undefined, noJobs)).rejects.toMatchObject({
      code: 'logs_not_found',
      message: 'No build logs are available for this service.',
    });

    const jobs = Array.from({ length: 101 }, (_, index) => ({
      jobName: `build-api-${index}`,
      status: 'Complete' as const,
    }));
    const boundedJobs: DiagnosticJobLogDependencies = {
      listJobs: jest.fn().mockResolvedValue(jobs),
      readLiveLog: jest.fn(),
      readArchivedLog: jest.fn(),
    };
    await expect(readDiagnosticJobLog(target, service, 'build', 'build-api-100', boundedJobs)).rejects.toMatchObject({
      code: 'job_not_found',
      details: { availableJobs: jobs.slice(0, 100).map((job) => job.jobName) },
    });
  });

  it('reports when neither a live pod nor an archive has logs', async () => {
    const service = resolveDiagnosticService(target, 'api');
    const dependencies: DiagnosticJobLogDependencies = {
      listJobs: jest.fn().mockResolvedValue([{ jobName: 'build-api-1', status: 'Pending' }]),
      readLiveLog: jest.fn(),
      readArchivedLog: jest.fn().mockResolvedValue(null),
    };

    await expect(readDiagnosticJobLog(target, service, 'build', undefined, dependencies)).rejects.toMatchObject({
      code: 'logs_not_found',
      message: 'No build logs are available for the selected job.',
    });
    expect(dependencies.readLiveLog).not.toHaveBeenCalled();
    expect(dependencies.readArchivedLog).toHaveBeenCalled();
  });

  it('retains truncation detected while bounding an archive', async () => {
    const service = resolveDiagnosticService(target, 'api');
    const dependencies: DiagnosticJobLogDependencies = {
      listJobs: jest.fn().mockResolvedValue([{ jobName: 'build-api-1', status: 'Complete' }]),
      readLiveLog: jest.fn(),
      readArchivedLog: jest.fn().mockResolvedValue({ logs: 'x'.repeat(40_000), truncated: false }),
    };

    const result = await readDiagnosticJobLog(target, service, 'build', undefined, dependencies);

    expect(result.logSource).toBe('archived');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(30 * 1024);
  });

  it('represents Codefresh limitations explicitly without provider calls', async () => {
    const dependencies: DiagnosticJobLogDependencies = {
      listJobs: jest.fn(),
      readLiveLog: jest.fn(),
      readArchivedLog: jest.fn(),
    };
    const service = resolveDiagnosticService(target, 'pipeline');

    await expect(readDiagnosticJobLog(target, service, 'build', undefined, dependencies)).rejects.toMatchObject({
      code: 'unsupported_log_source',
    });
    expect(dependencies.listJobs).not.toHaveBeenCalled();
  });
});
