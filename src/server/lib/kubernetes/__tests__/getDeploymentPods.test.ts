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

var mockListNamespacedDeployment: jest.Mock;
var mockListNamespacedStatefulSet: jest.Mock;
var mockListNamespacedJob: jest.Mock;
var mockListNamespacedCronJob: jest.Mock;
var mockListNamespacedPod: jest.Mock;
var mockBuildFindOne: jest.Mock;
var mockLoadFromCluster: jest.Mock;
var mockLoadFromDefault: jest.Mock;
var mockMakeApiClient: jest.Mock;
var mockLoggerError: jest.Mock;

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  mockListNamespacedDeployment = jest.fn();
  mockListNamespacedStatefulSet = jest.fn();
  mockListNamespacedJob = jest.fn();
  mockListNamespacedCronJob = jest.fn();
  mockListNamespacedPod = jest.fn();
  mockLoadFromCluster = jest.fn();
  mockLoadFromDefault = jest.fn();

  const appsClient = {
    listNamespacedDeployment: mockListNamespacedDeployment,
    listNamespacedStatefulSet: mockListNamespacedStatefulSet,
  };
  const batchClient = {
    listNamespacedJob: mockListNamespacedJob,
    listNamespacedCronJob: mockListNamespacedCronJob,
  };
  const coreClient = {
    listNamespacedPod: mockListNamespacedPod,
  };

  mockMakeApiClient = jest.fn().mockImplementation((client: unknown) => {
    if (client === actual.AppsV1Api) {
      return appsClient;
    }

    if (client === actual.BatchV1Api) {
      return batchClient;
    }

    if (client === actual.CoreV1Api) {
      return coreClient;
    }

    return {};
  });

  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromCluster: mockLoadFromCluster,
      loadFromDefault: mockLoadFromDefault,
      makeApiClient: mockMakeApiClient,
    })),
  };
});

jest.mock('server/lib/logger', () => {
  mockLoggerError = jest.fn();
  return {
    getLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: mockLoggerError,
    }),
  };
});

jest.mock('server/models/Build', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => ({
      findOne: (...args: unknown[]) => mockBuildFindOne(...args),
    })),
  },
}));

import type { V1ContainerStatus, V1Pod } from '@kubernetes/client-node';
import {
  extractContainers,
  formatAge,
  getDeploymentPods,
  loadKubeConfig,
  podAgeSeconds,
  podReady,
  podRestarts,
  podStatus,
} from '../getDeploymentPods';

function containerStatus(overrides: Partial<V1ContainerStatus> & Pick<V1ContainerStatus, 'name'>): V1ContainerStatus {
  return {
    image: 'sample-image',
    imageID: 'sample-image-id',
    lastState: {},
    ready: false,
    restartCount: 0,
    state: {},
    ...overrides,
  };
}

function asPod(value: Partial<V1Pod>): V1Pod {
  return value as V1Pod;
}

function buildPod({
  name,
  createdAt,
  phase = 'Running',
  deletionTimestamp,
  containerStatuses = [
    {
      name: 'app',
      ready: true,
      restartCount: 0,
      state: { running: {} },
    },
  ],
}: {
  name: string;
  createdAt: string;
  phase?: string;
  deletionTimestamp?: string;
  containerStatuses?: Array<Record<string, unknown>>;
}) {
  return {
    metadata: {
      name,
      creationTimestamp: createdAt,
      deletionTimestamp,
    },
    spec: {
      containers: [
        {
          name: 'app',
          image: 'sample-image',
        },
      ],
    },
    status: {
      phase,
      containerStatuses,
    },
  };
}

function buildJob({
  name,
  matchLabels = { 'batch.kubernetes.io/controller-uid': `${name}-uid` },
  ownerReferences,
}: {
  name: string;
  matchLabels?: Record<string, string>;
  ownerReferences?: Array<Record<string, unknown>>;
}) {
  return {
    metadata: {
      name,
      ownerReferences,
    },
    spec: {
      selector: {
        matchLabels,
      },
    },
  };
}

describe('Kubernetes pod formatting helpers', () => {
  it('loads in-cluster configuration without consulting the default kubeconfig', () => {
    const config = loadKubeConfig();

    expect(config).toEqual(
      expect.objectContaining({
        loadFromCluster: mockLoadFromCluster,
        loadFromDefault: mockLoadFromDefault,
      })
    );
    expect(mockLoadFromCluster).toHaveBeenCalledTimes(1);
    expect(mockLoadFromDefault).not.toHaveBeenCalled();
  });

  it('falls back to the default kubeconfig when in-cluster loading fails', () => {
    mockLoadFromCluster.mockImplementationOnce(() => {
      throw new Error('not running in a cluster');
    });

    expect(() => loadKubeConfig()).not.toThrow();

    expect(mockLoadFromDefault).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, '0s'],
    [59, '59s'],
    [60, '1m'],
    [3_599, '59m'],
    [3_600, '1h'],
    [172_799, '47h'],
    [172_800, '2d'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatAge(seconds)).toBe(expected);
  });

  it('prefers waiting reasons and only reports termination reasons outside the Running phase', () => {
    const waiting = asPod({
      status: {
        phase: 'Failed',
        containerStatuses: [
          containerStatus({ name: 'app', state: { waiting: { reason: 'CrashLoopBackOff' } } }),
          containerStatus({ name: 'worker', state: { terminated: { reason: 'Error' } } }),
        ],
      },
    });
    const terminated = asPod({
      status: {
        phase: 'Failed',
        containerStatuses: [containerStatus({ name: 'app', state: { terminated: { reason: 'Error' } } })],
      },
    });
    const restarted = asPod({
      status: {
        phase: 'Running',
        containerStatuses: [containerStatus({ name: 'app', state: { terminated: { reason: 'Completed' } } })],
      },
    });

    expect(podStatus(waiting)).toBe('CrashLoopBackOff');
    expect(podStatus(terminated)).toBe('Error');
    expect(podStatus(restarted)).toBe('Running');
    expect(podStatus(asPod({ status: { phase: 'Pending', containerStatuses: [] } }))).toBe('Pending');
    expect(podStatus(asPod({}))).toBe('Unknown');
  });

  it('ignores state entries without reasons when calculating pod status', () => {
    const pod = asPod({
      status: {
        phase: 'Pending',
        containerStatuses: [
          containerStatus({ name: 'waiting', state: { waiting: {} } }),
          containerStatus({ name: 'terminated', state: { terminated: {} } }),
        ],
      },
    });

    expect(podStatus(pod)).toBe('Pending');
  });

  it('summarizes restarts and readiness across application containers', () => {
    const pod = asPod({
      status: {
        containerStatuses: [
          containerStatus({ name: 'ready', ready: true, restartCount: 2 }),
          containerStatus({ name: 'not-ready', ready: false, restartCount: 3 }),
        ],
      },
    });

    expect(podRestarts(pod)).toBe(5);
    expect(podReady(pod)).toBe('1/2');
    expect(podRestarts(asPod({}))).toBe(0);
    expect(podReady(asPod({}))).toBe('0/0');
  });

  it('floors pod age and clamps future creation times to zero', () => {
    const now = Date.parse('2026-08-27T12:00:00.900Z');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

    expect(podAgeSeconds(asPod({ metadata: { creationTimestamp: new Date('2026-08-27T11:59:00.100Z') } }))).toBe(60);
    expect(podAgeSeconds(asPod({ metadata: { creationTimestamp: new Date('2026-08-27T12:01:00.000Z') } }))).toBe(0);
    expect(podAgeSeconds(asPod({ metadata: {} }))).toBe(0);
    expect(podAgeSeconds(asPod({}))).toBe(0);

    nowSpy.mockRestore();
  });

  it('extracts init and application containers with their current states', () => {
    const pod = asPod({
      spec: {
        initContainers: [
          { name: 'setup', image: 'setup-image' },
          { name: 'unstarted-init', image: 'init-image' },
        ],
        containers: [
          { name: 'web', image: 'web-image' },
          { name: 'worker', image: 'worker-image' },
          { name: 'waiting-without-reason', image: 'sidecar-image' },
          { name: 'unknown', image: 'unknown-image' },
          { name: 'unstarted', image: 'unstarted-image' },
        ],
      },
      status: {
        initContainerStatuses: [
          containerStatus({ name: 'setup', ready: true, restartCount: 1, state: { running: {} } }),
        ],
        containerStatuses: [
          containerStatus({ name: 'web', state: { waiting: { reason: 'ImagePullBackOff' } } }),
          containerStatus({ name: 'worker', state: { terminated: { reason: 'Completed' } } }),
          containerStatus({ name: 'waiting-without-reason', state: { waiting: {} } }),
          containerStatus({ name: 'unknown', state: {} }),
        ],
      },
    });

    expect(extractContainers(pod)).toEqual([
      {
        name: 'setup',
        image: 'setup-image',
        ready: true,
        restarts: 1,
        state: 'Running',
        reason: undefined,
        isInit: true,
      },
      {
        name: 'unstarted-init',
        image: 'init-image',
        ready: false,
        restarts: 0,
        state: 'Unknown',
        reason: undefined,
        isInit: true,
      },
      {
        name: 'web',
        image: 'web-image',
        ready: false,
        restarts: 0,
        state: 'Waiting',
        reason: 'ImagePullBackOff',
        isInit: false,
      },
      {
        name: 'worker',
        image: 'worker-image',
        ready: false,
        restarts: 0,
        state: 'Terminated',
        reason: 'Completed',
        isInit: false,
      },
      {
        name: 'waiting-without-reason',
        image: 'sidecar-image',
        ready: false,
        restarts: 0,
        state: 'Waiting',
        reason: undefined,
        isInit: false,
      },
      {
        name: 'unknown',
        image: 'unknown-image',
        ready: false,
        restarts: 0,
        state: 'Unknown',
        reason: undefined,
        isInit: false,
      },
      {
        name: 'unstarted',
        image: 'unstarted-image',
        ready: false,
        restarts: 0,
        state: 'Unknown',
        reason: undefined,
        isInit: false,
      },
    ]);
  });

  it('returns no containers for a pod before its spec is populated', () => {
    expect(extractContainers(asPod({}))).toEqual([]);
  });
});

describe('getDeploymentPods', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildFindOne = jest.fn().mockReturnValue({
      select: jest.fn().mockResolvedValue({
        namespace: 'env-sample-env',
      }),
    });
    mockListNamespacedDeployment.mockResolvedValue({
      body: {
        items: [
          {
            spec: {
              selector: {
                matchLabels: {
                  app: 'sample-service',
                },
              },
            },
          },
        ],
      },
    });
    mockListNamespacedStatefulSet.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedJob.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedCronJob.mockResolvedValue({
      body: { items: [] },
    });
  });

  it('filters terminated pods and keeps newest active pods first', async () => {
    mockListNamespacedPod.mockResolvedValue({
      body: {
        items: [
          buildPod({
            name: 'active-new',
            createdAt: '2026-03-27T19:00:00.000Z',
          }),
          buildPod({
            name: 'active-old',
            createdAt: '2026-03-27T18:00:00.000Z',
          }),
          {
            metadata: {
              name: 'status-pending',
              creationTimestamp: '2026-03-27T18:30:00.000Z',
            },
            spec: { containers: [{ name: 'app', image: 'sample-image' }] },
          },
          buildPod({
            name: 'state-pending',
            createdAt: '2026-03-27T18:15:00.000Z',
            phase: 'Pending',
            containerStatuses: [
              {
                name: 'app',
                ready: false,
                restartCount: 0,
              },
            ],
          }),
          buildPod({
            name: 'failed-phase',
            createdAt: '2026-03-27T17:00:00.000Z',
            phase: 'Failed',
            containerStatuses: [
              {
                name: 'app',
                ready: false,
                restartCount: 1,
                state: { terminated: { reason: 'Error' } },
              },
            ],
          }),
          buildPod({
            name: 'deleting',
            createdAt: '2026-03-27T16:00:00.000Z',
            deletionTimestamp: '2026-03-27T19:01:00.000Z',
          }),
          buildPod({
            name: 'all-terminated',
            createdAt: '2026-03-27T15:00:00.000Z',
            containerStatuses: [
              {
                name: 'app',
                ready: false,
                restartCount: 0,
                state: { terminated: { reason: 'Completed' } },
              },
            ],
          }),
        ],
      },
    });

    const pods = await getDeploymentPods('sample-service', 'sample-env');

    expect(pods.map((pod) => pod.podName)).toEqual(['active-new', 'status-pending', 'state-pending', 'active-old']);
    expect(pods[0]?.ready).toBe('1/1');
    expect(pods[1]).toMatchObject({ status: 'Unknown', ready: '0/0' });
    expect(pods[2]?.containers[0]).toMatchObject({ state: 'Unknown' });
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'app=sample-service'
    );
    expect(mockListNamespacedStatefulSet).not.toHaveBeenCalled();
    expect(mockListNamespacedJob).not.toHaveBeenCalled();
    expect(mockListNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('uses the build namespace for sandbox builds', async () => {
    mockBuildFindOne.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        namespace: 'sbx-sample-env',
      }),
    });
    mockListNamespacedPod.mockResolvedValue({
      body: {
        items: [
          buildPod({
            name: 'sandbox-active',
            createdAt: '2026-03-27T19:00:00.000Z',
          }),
        ],
      },
    });

    await getDeploymentPods('sample-service', 'sample-env');

    expect(mockListNamespacedDeployment).toHaveBeenCalledWith(
      'sbx-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'app.kubernetes.io/instance=sample-service-sample-env'
    );
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'sbx-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'app=sample-service'
    );
  });

  it('falls back to the UUID namespace when the build namespace lookup fails', async () => {
    mockBuildFindOne.mockReturnValue({
      select: jest.fn().mockRejectedValue(new Error('database unavailable')),
    });
    mockListNamespacedPod.mockResolvedValue({ body: { items: [] } });

    await expect(getDeploymentPods('sample-service', 'fallback-env')).resolves.toEqual([]);

    expect(mockBuildFindOne).toHaveBeenCalledWith({ uuid: 'fallback-env' });
    expect(mockListNamespacedDeployment).toHaveBeenCalledWith(
      'env-fallback-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'app.kubernetes.io/instance=sample-service-fallback-env'
    );
  });

  it('returns an empty list when every pod is terminal', async () => {
    mockListNamespacedPod.mockResolvedValue({
      body: {
        items: [
          buildPod({
            name: 'terminated',
            createdAt: '2026-03-27T17:00:00.000Z',
            phase: 'Succeeded',
            containerStatuses: [
              {
                name: 'app',
                ready: false,
                restartCount: 0,
                state: { terminated: { reason: 'Completed' } },
              },
            ],
          }),
        ],
      },
    });

    await expect(getDeploymentPods('sample-service', 'sample-env')).resolves.toEqual([]);
  });

  it('uses a StatefulSet selector when no Deployment exists', async () => {
    mockListNamespacedDeployment.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedStatefulSet.mockResolvedValue({
      body: {
        items: [
          {
            spec: {
              selector: {
                matchLabels: {
                  app: 'sample-stateful-service',
                },
              },
            },
          },
        ],
      },
    });
    mockListNamespacedPod.mockResolvedValue({
      body: {
        items: [
          buildPod({
            name: 'stateful-active',
            createdAt: '2026-03-27T19:00:00.000Z',
          }),
        ],
      },
    });

    const pods = await getDeploymentPods('sample-service', 'sample-env');

    expect(pods.map((pod) => pod.podName)).toEqual(['stateful-active']);
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'app=sample-stateful-service'
    );
    expect(mockListNamespacedJob).not.toHaveBeenCalled();
  });

  it('falls back to Jobs when a matching Deployment has no pod selector labels', async () => {
    mockListNamespacedDeployment.mockResolvedValue({
      body: {
        items: [{ spec: { selector: { matchLabels: {} } } }],
      },
    });
    mockListNamespacedJob.mockResolvedValue({
      body: { items: [buildJob({ name: 'fallback-job' })] },
    });
    mockListNamespacedPod.mockResolvedValue({ body: { items: [] } });

    await expect(getDeploymentPods('sample-service', 'sample-env')).resolves.toEqual([]);

    expect(mockListNamespacedStatefulSet).not.toHaveBeenCalled();
    expect(mockListNamespacedJob).toHaveBeenCalledTimes(1);
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'batch.kubernetes.io/controller-uid=fallback-job-uid'
    );
  });

  it('falls back to Jobs when a matching StatefulSet has no pod selector labels', async () => {
    mockListNamespacedDeployment.mockResolvedValue({ body: { items: [] } });
    mockListNamespacedStatefulSet.mockResolvedValue({
      body: {
        items: [{ spec: { selector: {} } }],
      },
    });
    mockListNamespacedJob.mockResolvedValue({
      body: { items: [buildJob({ name: 'fallback-job' })] },
    });
    mockListNamespacedPod.mockResolvedValue({ body: { items: [] } });

    await expect(getDeploymentPods('sample-service', 'sample-env')).resolves.toEqual([]);

    expect(mockListNamespacedJob).toHaveBeenCalledTimes(1);
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'batch.kubernetes.io/controller-uid=fallback-job-uid'
    );
  });

  it('falls back to Job pods and includes terminal job pods', async () => {
    mockListNamespacedDeployment.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedStatefulSet.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedJob.mockResolvedValue({
      body: {
        items: [buildJob({ name: 'sample-service-job' })],
      },
    });
    mockListNamespacedPod.mockResolvedValue({
      body: {
        items: [
          buildPod({
            name: 'job-succeeded',
            createdAt: '2026-03-27T19:00:00.000Z',
            phase: 'Succeeded',
            containerStatuses: [
              {
                name: 'app',
                ready: false,
                restartCount: 0,
                state: { terminated: { reason: 'Completed' } },
              },
            ],
          }),
          buildPod({
            name: 'job-failed',
            createdAt: '2026-03-27T18:00:00.000Z',
            phase: 'Failed',
            containerStatuses: [
              {
                name: 'app',
                ready: false,
                restartCount: 1,
                state: { terminated: { reason: 'Error' } },
              },
            ],
          }),
          buildPod({
            name: 'job-deleting',
            createdAt: '2026-03-27T17:00:00.000Z',
            deletionTimestamp: '2026-03-27T19:01:00.000Z',
          }),
        ],
      },
    });

    const pods = await getDeploymentPods('sample-service', 'sample-env');

    expect(pods.map((pod) => pod.podName)).toEqual(['job-succeeded', 'job-failed']);
    expect(pods.map((pod) => pod.status)).toEqual(['Completed', 'Error']);
    expect(mockListNamespacedJob).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'app.kubernetes.io/instance=sample-service-sample-env'
    );
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'batch.kubernetes.io/controller-uid=sample-service-job-uid'
    );
    expect(mockListNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('falls back to job-name when a Job selector is unavailable', async () => {
    mockListNamespacedDeployment.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedStatefulSet.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedJob.mockResolvedValue({
      body: {
        items: [
          {
            metadata: {
              name: 'sample-service-job',
            },
            spec: {
              template: {
                spec: {
                  containers: [{ name: 'job', image: 'sample-image' }],
                  restartPolicy: 'Never',
                },
              },
            },
          },
        ],
      },
    });
    mockListNamespacedPod.mockResolvedValue({
      body: {
        items: [
          buildPod({
            name: 'job-active',
            createdAt: '2026-03-27T19:00:00.000Z',
          }),
        ],
      },
    });

    await getDeploymentPods('sample-service', 'sample-env');

    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'job-name=sample-service-job'
    );
  });

  it('deduplicates pods returned by multiple Job selectors and ignores nameless pods', async () => {
    mockListNamespacedDeployment.mockResolvedValue({ body: { items: [] } });
    mockListNamespacedStatefulSet.mockResolvedValue({ body: { items: [] } });
    mockListNamespacedJob.mockResolvedValue({
      body: {
        items: [buildJob({ name: 'job-one' }), buildJob({ name: 'job-two' })],
      },
    });
    mockListNamespacedPod
      .mockResolvedValueOnce({
        body: {
          items: [
            buildPod({ name: 'shared', createdAt: '2026-03-27T17:00:00.000Z' }),
            { metadata: {}, status: { phase: 'Running' } },
          ],
        },
      })
      .mockResolvedValueOnce({
        body: {
          items: [
            buildPod({ name: 'shared', createdAt: '2026-03-27T19:00:00.000Z' }),
            buildPod({ name: 'second', createdAt: '2026-03-27T18:00:00.000Z' }),
          ],
        },
      });

    const pods = await getDeploymentPods('sample-service', 'sample-env');

    expect(pods.map((pod) => pod.podName)).toEqual(['shared', 'second']);
    expect(mockListNamespacedPod).toHaveBeenCalledTimes(2);
    expect(mockListNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('returns CronJob child Job pods when no direct workload exists', async () => {
    mockListNamespacedDeployment.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedStatefulSet.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedCronJob.mockResolvedValue({
      body: {
        items: [
          {
            metadata: {
              name: 'sample-service-cron',
              uid: 'cron-uid',
            },
          },
        ],
      },
    });
    mockListNamespacedJob
      .mockResolvedValueOnce({
        body: { items: [] },
      })
      .mockResolvedValueOnce({
        body: {
          items: [
            buildJob({
              name: 'sample-service-cron-123',
              ownerReferences: [
                {
                  kind: 'CronJob',
                  name: 'sample-service-cron',
                  uid: 'cron-uid',
                },
              ],
            }),
            buildJob({
              name: 'unrelated-job',
              ownerReferences: [
                {
                  kind: 'CronJob',
                  name: 'unrelated-cron',
                  uid: 'unrelated-uid',
                },
              ],
            }),
          ],
        },
      });
    mockListNamespacedPod.mockResolvedValue({
      body: {
        items: [
          buildPod({
            name: 'cronjob-succeeded',
            createdAt: '2026-03-27T19:00:00.000Z',
            phase: 'Succeeded',
            containerStatuses: [
              {
                name: 'app',
                ready: false,
                restartCount: 0,
                state: { terminated: { reason: 'Completed' } },
              },
            ],
          }),
        ],
      },
    });

    const pods = await getDeploymentPods('sample-service', 'sample-env');

    expect(pods.map((pod) => pod.podName)).toEqual(['cronjob-succeeded']);
    expect(mockListNamespacedCronJob).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'app.kubernetes.io/instance=sample-service-sample-env'
    );
    expect(mockListNamespacedJob).toHaveBeenLastCalledWith('env-sample-env');
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'batch.kubernetes.io/controller-uid=sample-service-cron-123-uid'
    );
  });

  it('matches CronJob child Jobs by owner name when the CronJob UID is absent', async () => {
    mockListNamespacedDeployment.mockResolvedValue({ body: { items: [] } });
    mockListNamespacedStatefulSet.mockResolvedValue({ body: { items: [] } });
    mockListNamespacedCronJob.mockResolvedValue({
      body: {
        items: [{ metadata: { name: 'sample-service-cron' } }],
      },
    });
    mockListNamespacedJob.mockResolvedValueOnce({ body: { items: [] } }).mockResolvedValueOnce({
      body: {
        items: [
          buildJob({
            name: 'sample-service-cron-123',
            ownerReferences: [{ kind: 'CronJob', name: 'sample-service-cron', uid: 'generated-job-owner-uid' }],
          }),
        ],
      },
    });
    mockListNamespacedPod.mockResolvedValue({
      body: { items: [buildPod({ name: 'cron-pod', createdAt: '2026-03-27T19:00:00.000Z' })] },
    });

    const pods = await getDeploymentPods('sample-service', 'sample-env');

    expect(pods.map((pod) => pod.podName)).toEqual(['cron-pod']);
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'batch.kubernetes.io/controller-uid=sample-service-cron-123-uid'
    );
  });

  it('returns no pods when a CronJob has no owned Jobs', async () => {
    mockListNamespacedDeployment.mockResolvedValue({ body: { items: [] } });
    mockListNamespacedStatefulSet.mockResolvedValue({ body: { items: [] } });
    mockListNamespacedCronJob.mockResolvedValue({
      body: {
        items: [{ metadata: { name: 'sample-service-cron', uid: 'cron-uid' } }],
      },
    });
    mockListNamespacedJob.mockResolvedValueOnce({ body: { items: [] } }).mockResolvedValueOnce({
      body: {
        items: [
          buildJob({ name: 'standalone-job', ownerReferences: undefined }),
          buildJob({
            name: 'unrelated-job',
            ownerReferences: [{ kind: 'Job', name: 'not-a-cronjob', uid: 'other-uid' }],
          }),
        ],
      },
    });

    await expect(getDeploymentPods('sample-service', 'sample-env')).resolves.toEqual([]);

    expect(mockListNamespacedPod).not.toHaveBeenCalled();
  });

  it('returns an empty list when no supported workload exists', async () => {
    mockListNamespacedDeployment.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedStatefulSet.mockResolvedValue({
      body: { items: [] },
    });

    await expect(getDeploymentPods('sample-service', 'sample-env')).resolves.toEqual([]);
  });

  it('logs and rethrows Kubernetes discovery failures without querying later workload types', async () => {
    const error = new Error('Kubernetes API unavailable');
    mockListNamespacedDeployment.mockRejectedValue(error);

    await expect(getDeploymentPods('sample-service', 'sample-env')).rejects.toBe(error);

    expect(mockLoggerError).toHaveBeenCalledWith({ error }, 'K8s: failed to list workload pods service=sample-service');
    expect(mockListNamespacedStatefulSet).not.toHaveBeenCalled();
    expect(mockListNamespacedJob).not.toHaveBeenCalled();
    expect(mockListNamespacedCronJob).not.toHaveBeenCalled();
    expect(mockListNamespacedPod).not.toHaveBeenCalled();
  });
});
