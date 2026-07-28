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

import {
  deriveDiagnosticTarget,
  readDiagnosticEvents,
  readDiagnosticJobLog,
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

  it('resolves only services from the authorized server-derived target', () => {
    expect(resolveDiagnosticService(target, 'worker')).toMatchObject({ name: 'worker' });
    expect(() => resolveDiagnosticService(target, 'missing')).toThrow('No service named missing exists');
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
