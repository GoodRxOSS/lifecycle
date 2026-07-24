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

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  mockListNamespacedDeployment = jest.fn();
  mockListNamespacedStatefulSet = jest.fn();
  mockListNamespacedJob = jest.fn();
  mockListNamespacedCronJob = jest.fn();
  mockListNamespacedPod = jest.fn();

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

  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromCluster: jest.fn(),
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockImplementation((client: unknown) => {
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
      }),
    })),
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('server/models/Build', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => ({
      findOne: (...args: unknown[]) => mockBuildFindOne(...args),
    })),
  },
}));

import { getDeploymentPods } from '../getDeploymentPods';

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

    expect(pods.map((pod) => pod.podName)).toEqual(['active-new', 'active-old']);
    expect(pods[0]?.ready).toBe('1/1');
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'env-sample-env',
      undefined,
      undefined,
      undefined,
      undefined,
      'app=sample-service'
    );
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

  it('returns an empty list when no supported workload exists', async () => {
    mockListNamespacedDeployment.mockResolvedValue({
      body: { items: [] },
    });
    mockListNamespacedStatefulSet.mockResolvedValue({
      body: { items: [] },
    });

    await expect(getDeploymentPods('sample-service', 'sample-env')).resolves.toEqual([]);
  });
});
