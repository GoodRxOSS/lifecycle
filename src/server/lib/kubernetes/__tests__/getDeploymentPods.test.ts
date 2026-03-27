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
var mockListNamespacedPod: jest.Mock;

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  mockListNamespacedDeployment = jest.fn();
  mockListNamespacedStatefulSet = jest.fn();
  mockListNamespacedPod = jest.fn();

  const appsClient = {
    listNamespacedDeployment: mockListNamespacedDeployment,
    listNamespacedStatefulSet: mockListNamespacedStatefulSet,
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

describe('getDeploymentPods', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
