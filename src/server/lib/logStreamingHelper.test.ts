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

var mockBatchApi: { readNamespacedJob: jest.Mock };
var mockCoreApi: { listNamespacedPod: jest.Mock; readNamespacedPod: jest.Mock };
var mockLoadFromDefault: jest.Mock;
var mockMakeApiClient: jest.Mock;
var mockLogger: { debug: jest.Mock; warn: jest.Mock; error: jest.Mock };

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  mockBatchApi = { readNamespacedJob: jest.fn() };
  mockCoreApi = { listNamespacedPod: jest.fn(), readNamespacedPod: jest.fn() };
  mockLoadFromDefault = jest.fn();
  mockMakeApiClient = jest.fn((client) => {
    if (client === actual.BatchV1Api) return mockBatchApi;
    if (client === actual.CoreV1Api) return mockCoreApi;
    throw new Error('Unexpected Kubernetes client');
  });

  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: mockLoadFromDefault,
      makeApiClient: mockMakeApiClient,
    })),
  };
});

jest.mock('server/lib/logger', () => {
  mockLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: () => mockLogger };
});

import { HttpError } from '@kubernetes/client-node';
import { getK8sJobStatusAndPod, getK8sPodContainers, getLogStreamingInfoForJob } from './logStreamingHelper';

function jobWithSelector(status: Record<string, unknown> = {}) {
  return {
    spec: { selector: { matchLabels: { 'job-name': 'job-1', component: 'builder' } } },
    status,
  };
}

function pod({
  name = 'pod-1',
  createdAt = '2026-01-01T00:00:00.000Z',
  phase = 'Running',
  initContainerStatuses = [],
  containerStatuses = [],
  initContainers = [],
  containers = [],
}: {
  name?: string;
  createdAt?: string;
  phase?: string;
  initContainerStatuses?: Array<Record<string, unknown>>;
  containerStatuses?: Array<Record<string, unknown>>;
  initContainers?: Array<Record<string, unknown>>;
  containers?: Array<Record<string, unknown>>;
} = {}) {
  return {
    metadata: { name, creationTimestamp: new Date(createdAt) },
    status: { phase, initContainerStatuses, containerStatuses },
    spec: { initContainers, containers },
  };
}

function notFoundHttpError() {
  return new HttpError({ statusCode: 404 } as any, {}, 404);
}

describe('log streaming Kubernetes discovery', () => {
  beforeEach(() => {
    mockBatchApi.readNamespacedJob.mockReset();
    mockCoreApi.listNamespacedPod.mockReset();
    mockCoreApi.readNamespacedPod.mockReset();
    mockLoadFromDefault.mockReset();
    mockMakeApiClient.mockClear();
    mockMakeApiClient.mockImplementation((client) => {
      const { BatchV1Api, CoreV1Api } = jest.requireActual('@kubernetes/client-node');
      if (client === BatchV1Api) return mockBatchApi;
      if (client === CoreV1Api) return mockCoreApi;
      throw new Error('Unexpected Kubernetes client');
    });
  });

  describe('getLogStreamingInfoForJob', () => {
    it('reports an unavailable source when no job name is provided', async () => {
      await expect(getLogStreamingInfoForJob(null, 'env-1')).resolves.toEqual({
        status: 'Unavailable',
        streamingRequired: false,
        message: 'Job name not found.',
      });
      expect(mockBatchApi.readNamespacedJob).not.toHaveBeenCalled();
    });

    it.each(['Running', 'Pending'] as const)(
      'returns stream coordinates and containers for a %s pod',
      async (phase) => {
        mockBatchApi.readNamespacedJob.mockResolvedValue({ body: jobWithSelector() });
        mockCoreApi.listNamespacedPod.mockResolvedValue({
          body: {
            items: [
              pod({
                phase,
                containerStatuses: [{ name: 'builder', state: { running: {} } }],
              }),
            ],
          },
        });

        await expect(getLogStreamingInfoForJob('job-1', 'env-1')).resolves.toEqual({
          status: phase,
          streamingRequired: true,
          websocket: {
            endpoint: '/api/logs/stream',
            parameters: {
              podName: 'pod-1',
              namespace: 'env-1',
              follow: true,
              tailLines: 200,
              timestamps: true,
            },
          },
          containers: [{ name: 'builder', state: 'running' }],
        });
      }
    );

    it.each([
      ['Succeeded', 'Completed', 'Job pod pod-1 has status: Completed. Streaming not active.'],
      ['Failed', 'Failed', 'Job pod pod-1 has status: Failed. Streaming not active.'],
      ['Unknown', 'Unknown', 'Job pod pod-1 is in an unexpected state: Unknown.'],
    ] as const)('maps a %s pod to a non-streaming %s response', async (phase, status, message) => {
      mockBatchApi.readNamespacedJob.mockResolvedValue({ body: jobWithSelector() });
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        body: { items: [pod({ phase, containers: [{ name: 'worker' }] })] },
      });

      await expect(getLogStreamingInfoForJob('job-1', 'env-1')).resolves.toEqual({
        status,
        streamingRequired: false,
        podName: 'pod-1',
        containers: [{ name: 'worker', state: 'pending' }],
        message,
      });
    });

    it('distinguishes a missing job from an unexpected empty result', async () => {
      mockBatchApi.readNamespacedJob
        .mockRejectedValueOnce(notFoundHttpError())
        .mockResolvedValueOnce({ body: undefined });

      await expect(getLogStreamingInfoForJob('missing', 'env-1')).resolves.toEqual({
        status: 'NotFound',
        streamingRequired: false,
        podName: null,
        containers: [],
        message: 'Job pod for missing not found. It might be completed and cleaned up.',
      });
      await expect(getLogStreamingInfoForJob('odd', 'env-1')).resolves.toEqual({
        status: 'Unknown',
        streamingRequired: false,
        podName: null,
        containers: [],
        message: 'Job pod odd is in an unexpected state: Unknown.',
      });
    });

    it('reports a not-found source when Kubernetes discovery returns no usable pod information', async () => {
      mockBatchApi.readNamespacedJob.mockRejectedValue(new Error('connection reset'));

      await expect(getLogStreamingInfoForJob('job-1', 'env-1')).resolves.toEqual({
        status: 'NotFound',
        streamingRequired: false,
        podName: null,
        containers: undefined,
        message: 'Job pod for job-1 not found. It might be completed and cleaned up.',
      });
    });

    it.each([
      [new Error('Kubernetes configuration unavailable'), 'Failed to communicate with Kubernetes.'],
      [{ statusCode: 502 }, 'Failed to communicate with Kubernetes.'],
      [new Error('bad local configuration'), 'Error fetching status from Kubernetes: bad local configuration'],
    ])('converts discovery failures into a stable status response', async (error, message) => {
      mockMakeApiClient.mockImplementationOnce(() => {
        throw error;
      });

      await expect(getLogStreamingInfoForJob('job-1', 'env-1')).resolves.toEqual({
        status: 'Unknown',
        streamingRequired: false,
        message,
      });
    });
  });

  describe('getK8sJobStatusAndPod', () => {
    it.each([
      [{ succeeded: 1 }, { status: 'Succeeded', message: undefined }],
      [
        { failed: 1, conditions: [{ type: 'Failed', status: 'True', message: 'image pull failed' }] },
        { status: 'Failed', message: 'image pull failed' },
      ],
      [{ failed: 1 }, { status: 'Failed', message: 'Job failed' }],
      [{ active: 1 }, { status: 'Unknown', message: undefined }],
    ])('uses terminal job status when the selector is absent', async (status, expected) => {
      mockBatchApi.readNamespacedJob.mockResolvedValue({ body: { status } });

      await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toEqual({
        podName: null,
        namespace: 'env-1',
        status: expected.status,
        containers: [],
        ...(expected.message ? { message: expected.message } : {}),
      });
      expect(mockCoreApi.listNamespacedPod).not.toHaveBeenCalled();
    });

    it.each([
      [{ succeeded: 1 }, { status: 'Succeeded', message: undefined }],
      [
        {
          failed: 1,
          conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'gave up' }],
        },
        { status: 'Failed', message: 'gave up' },
      ],
      [{ failed: 1 }, { status: 'Failed', message: 'Job failed' }],
      [{ active: 1 }, { status: 'NotFound', message: undefined }],
    ])('falls back to job status when no selected pod remains', async (status, expected) => {
      mockBatchApi.readNamespacedJob.mockResolvedValue({ body: jobWithSelector(status) });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [] } });

      await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toEqual({
        podName: null,
        namespace: 'env-1',
        status: expected.status,
        containers: [],
        ...(expected.message ? { message: expected.message } : {}),
      });
      expect(mockCoreApi.listNamespacedPod).toHaveBeenCalledWith(
        'env-1',
        undefined,
        undefined,
        undefined,
        undefined,
        'job-name=job-1,component=builder'
      );
    });

    it('treats a selector with no pods and no job status as not found', async () => {
      mockBatchApi.readNamespacedJob.mockResolvedValue({
        body: { spec: { selector: { matchLabels: { 'job-name': 'job-1' } } } },
      });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [] } });

      await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toMatchObject({
        podName: null,
        status: 'NotFound',
      });
    });

    it.each([
      [
        [
          pod({ name: 'dated', createdAt: '2026-01-02T00:00:00.000Z' }),
          { metadata: { name: 'undated' }, status: { phase: 'Running' } },
        ],
      ],
      [
        [
          { metadata: { name: 'undated' }, status: { phase: 'Running' } },
          pod({ name: 'dated', createdAt: '2026-01-02T00:00:00.000Z' }),
        ],
      ],
    ])('treats a pod without a creation timestamp as older than a dated pod', async (items) => {
      mockBatchApi.readNamespacedJob.mockResolvedValue({ body: jobWithSelector() });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items } });

      await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toMatchObject({
        podName: 'dated',
      });
    });

    it('selects the newest pod and preserves init/container states and a job failure message', async () => {
      mockBatchApi.readNamespacedJob.mockResolvedValue({
        body: jobWithSelector({
          conditions: [{ type: 'Failed', status: 'True', message: 'deadline exceeded' }],
        }),
      });
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        body: {
          items: [
            pod({ name: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
            pod({
              name: 'new',
              createdAt: '2026-01-02T00:00:00.000Z',
              phase: 'Failed',
              initContainerStatuses: [
                { name: 'setup', state: { terminated: { reason: 'Completed' } } },
                { name: 'cleanup', state: { terminated: {} } },
              ],
              containerStatuses: [
                { name: 'app', state: { waiting: { reason: 'CrashLoopBackOff' } } },
                { name: 'queued', state: { waiting: {} } },
                { name: 'sidecar', state: {} },
                { name: 'no-state' },
              ],
            }),
          ],
        },
      });

      await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toEqual({
        podName: 'new',
        namespace: 'env-1',
        status: 'Failed',
        containers: [
          { name: '[init] setup', state: 'completed' },
          { name: '[init] cleanup', state: 'terminated' },
          { name: 'app', state: 'crashloopbackoff' },
          { name: 'queued', state: 'waiting' },
          { name: 'sidecar', state: 'waiting' },
          { name: 'no-state', state: 'waiting' },
        ],
        message: 'deadline exceeded',
      });
    });

    it('uses pod specs as pending container fallbacks when statuses have not arrived', async () => {
      mockBatchApi.readNamespacedJob.mockResolvedValue({ body: jobWithSelector() });
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        body: {
          items: [pod({ phase: 'Pending', initContainers: [{ name: 'setup' }], containers: [{ name: 'app' }] })],
        },
      });

      await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toEqual({
        podName: 'pod-1',
        namespace: 'env-1',
        status: 'Pending',
        containers: [
          { name: '[init] setup', state: 'pending' },
          { name: 'app', state: 'pending' },
        ],
      });
    });

    it('accepts an otherwise valid pod when status and spec container arrays are absent', async () => {
      mockBatchApi.readNamespacedJob.mockResolvedValue({ body: jobWithSelector() });
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        body: { items: [{ metadata: { name: 'pod-1' }, status: { phase: 'Pending' }, spec: {} }] },
      });

      await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toEqual({
        podName: 'pod-1',
        namespace: 'env-1',
        status: 'Pending',
        containers: [],
      });
    });

    it.each([[undefined], [{ conditions: [{ type: 'Complete', status: 'True' }] }]])(
      'does not invent a failure message when a failed pod has no matching job condition',
      async (status) => {
        mockBatchApi.readNamespacedJob.mockResolvedValue({
          body: {
            ...jobWithSelector(),
            status,
          },
        });
        mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [pod({ phase: 'Failed' })] } });

        await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toEqual({
          podName: 'pod-1',
          namespace: 'env-1',
          status: 'Failed',
          containers: [],
        });
      }
    );

    it.each([[{ metadata: {}, status: {} }], [{ status: { phase: 'Running' } }], [{ metadata: { name: 'pod-1' } }]])(
      'returns null for a malformed selected pod',
      async (selectedPod) => {
        mockBatchApi.readNamespacedJob.mockResolvedValue({ body: jobWithSelector() });
        mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [selectedPod] } });

        await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toBeNull();
      }
    );

    it('returns null for unexpected Kubernetes failures, including an HttpError without a response', async () => {
      const responseLessHttpError = new HttpError(undefined as any, {}, 500);
      mockBatchApi.readNamespacedJob
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockRejectedValueOnce(responseLessHttpError);

      await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toBeNull();
      await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toBeNull();
    });

    it('returns a descriptive not-found result for a deleted job', async () => {
      mockBatchApi.readNamespacedJob.mockRejectedValue(notFoundHttpError());

      await expect(getK8sJobStatusAndPod('job-1', 'env-1')).resolves.toEqual({
        podName: null,
        namespace: 'env-1',
        status: 'NotFound',
        containers: [],
        message: 'Job no longer exists. Logs have been cleaned up after 24 hours.',
      });
    });
  });

  describe('getK8sPodContainers', () => {
    it.each([
      ['Pending', 'Pending'],
      ['Running', 'Running'],
      ['Succeeded', 'Succeeded'],
      ['Failed', 'Failed'],
      ['Evicted', 'Unknown'],
    ] as const)('maps Kubernetes phase %s to %s', async (phase, status) => {
      mockCoreApi.readNamespacedPod.mockResolvedValue({
        body: pod({ phase, containerStatuses: [{ name: 'app', state: { running: {} } }] }),
      });

      await expect(getK8sPodContainers('pod-1', 'env-1')).resolves.toEqual({
        podName: 'pod-1',
        namespace: 'env-1',
        status,
        containers: [{ name: 'app', state: 'running' }],
      });
    });

    it('reports normalized init and application container states', async () => {
      mockCoreApi.readNamespacedPod.mockResolvedValue({
        body: pod({
          initContainerStatuses: [{ name: 'setup', state: { terminated: {} } }],
          containerStatuses: [
            { name: 'waiting', state: { waiting: {} } },
            { name: 'unknown', state: {} },
            { name: 'no-state' },
            { name: '', state: { running: {} } },
          ],
        }),
      });

      await expect(getK8sPodContainers('pod-1')).resolves.toMatchObject({
        namespace: 'lifecycle-app',
        containers: [
          { name: '[init] setup', state: 'terminated' },
          { name: 'waiting', state: 'waiting' },
          { name: 'unknown', state: 'waiting' },
          { name: 'no-state', state: 'waiting' },
        ],
      });
    });

    it('uses spec names when statuses are absent and a main fallback when the pod has no containers', async () => {
      mockCoreApi.readNamespacedPod
        .mockResolvedValueOnce({
          body: pod({ initContainers: [{ name: 'setup' }], containers: [{ name: 'app' }] }),
        })
        .mockResolvedValueOnce({ body: {} })
        .mockResolvedValueOnce({ body: { status: { phase: 'Running' }, spec: {} } });

      await expect(getK8sPodContainers('pod-1', 'env-1')).resolves.toMatchObject({
        containers: [
          { name: '[init] setup', state: 'unknown' },
          { name: 'app', state: 'unknown' },
        ],
      });
      await expect(getK8sPodContainers('empty', 'env-1')).resolves.toMatchObject({
        status: 'Unknown',
        containers: [{ name: 'main', state: 'unknown' }],
      });
      await expect(getK8sPodContainers('empty-spec', 'env-1')).resolves.toMatchObject({
        status: 'Running',
        containers: [{ name: 'main', state: 'unknown' }],
      });
    });

    it('returns a not-found result for a deleted pod and rethrows other client failures', async () => {
      const failure = new Error('TLS failure');
      const responseLessHttpError = new HttpError(undefined as any, {}, 500);
      mockCoreApi.readNamespacedPod
        .mockRejectedValueOnce(notFoundHttpError())
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(responseLessHttpError);

      await expect(getK8sPodContainers('missing', 'env-1')).resolves.toEqual({
        podName: null,
        namespace: 'env-1',
        status: 'NotFound',
        containers: [],
        message: "Pod 'missing' not found in namespace 'env-1'",
      });
      await expect(getK8sPodContainers('broken', 'env-1')).rejects.toBe(failure);
      await expect(getK8sPodContainers('http-broken', 'env-1')).rejects.toBe(responseLessHttpError);
    });
  });
});
