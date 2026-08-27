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

var mockListNamespacedJob: jest.Mock;
var mockListNamespacedPod: jest.Mock;
var mockGetAllConfigs: jest.Mock;
var mockListArchivedJobs: jest.Mock;
var mockWarn: jest.Mock;
var mockError: jest.Mock;

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  mockListNamespacedJob = jest.fn();
  mockListNamespacedPod = jest.fn();
  const batchApi = { listNamespacedJob: (...args: unknown[]) => mockListNamespacedJob(...args) };
  const coreApi = { listNamespacedPod: (...args: unknown[]) => mockListNamespacedPod(...args) };

  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn((client: unknown) => {
        if (client === actual.BatchV1Api) return batchApi;
        if (client === actual.CoreV1Api) return coreApi;
        return {};
      }),
    })),
  };
});

jest.mock('server/services/globalConfig', () => {
  mockGetAllConfigs = jest.fn();
  return {
    __esModule: true,
    default: { getInstance: () => ({ getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args) }) },
  };
});

jest.mock('server/services/logArchival', () => {
  mockListArchivedJobs = jest.fn();
  return { getLogArchivalService: () => ({ listArchivedJobs: (...args: unknown[]) => mockListArchivedJobs(...args) }) };
});

jest.mock('server/lib/logger', () => {
  mockWarn = jest.fn();
  mockError = jest.fn();
  return { getLogger: () => ({ warn: mockWarn, error: mockError }) };
});

import { getDeploymentJobs } from '../getDeploymentJobs';

function job({
  name,
  labels,
  annotations,
  status,
  selector,
}: {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  status?: Record<string, unknown>;
  selector?: Record<string, string>;
}) {
  return {
    metadata: { name, labels, annotations },
    status,
    spec: selector ? { selector: { matchLabels: selector } } : undefined,
  };
}

describe('getDeploymentJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: false } });
    mockListArchivedJobs.mockResolvedValue([]);
  });

  it('filters jobs for the service and maps status, duration, type, pod, and newest-first order', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-27T12:00:00.000Z').getTime());
    mockListNamespacedJob
      .mockResolvedValueOnce({
        body: {
          items: [
            job({
              name: 'helm-service-deploy-j1-aaaaaaa',
              labels: { 'app.kubernetes.io/name': 'native-helm' },
              status: {
                succeeded: 1,
                startTime: '2026-08-27T10:00:00.100Z',
                completionTime: '2026-08-27T10:01:05.900Z',
              },
              selector: { 'controller-uid': 'helm-uid' },
            }),
            job({
              name: 'failed-service-deploy-j2-bbbbbbb',
              labels: { 'app.kubernetes.io/name': 'native-helm' },
              status: {
                failed: 1,
                startTime: '2026-08-27T11:58:00.000Z',
                conditions: [
                  { type: 'Complete', status: 'False' },
                  { type: 'Failed', status: 'True' },
                ],
              },
            }),
          ],
        },
      })
      .mockResolvedValueOnce({
        body: {
          items: [
            job({
              name: 'github-service-deploy-j3-ccccccc',
              annotations: { 'lifecycle/service-name': 'catalog' },
              status: { active: 1, startTime: '2026-08-27T11:59:00.000Z' },
              selector: { 'batch.kubernetes.io/controller-uid': 'github-uid' },
            }),
            job({
              name: 'label-service-deploy-j4-ddddddd',
              labels: { service: 'catalog' },
              status: { active: 1, startTime: '2026-08-27T11:57:00.000Z' },
              selector: { job: 'label-job' },
            }),
            job({
              name: 'other-service-deploy-j5-eeeeeee',
              annotations: { 'lifecycle/service-name': 'other' },
              status: { succeeded: 1 },
            }),
          ],
        },
      });
    mockListNamespacedPod
      .mockResolvedValueOnce({ body: { items: [{ metadata: { name: 'helm-pod' }, status: { phase: 'Succeeded' } }] } })
      .mockResolvedValueOnce({ body: { items: [{ metadata: { name: 'github-pod' }, status: { phase: 'Pending' } }] } })
      .mockResolvedValueOnce({ body: { items: [{ metadata: { name: 'label-pod' } }] } });

    const result = await getDeploymentJobs('catalog', 'env-build');

    expect(mockListNamespacedJob).toHaveBeenNthCalledWith(
      1,
      'env-build',
      undefined,
      undefined,
      undefined,
      undefined,
      'app.kubernetes.io/name=native-helm,service=catalog'
    );
    expect(mockListNamespacedJob).toHaveBeenNthCalledWith(
      2,
      'env-build',
      undefined,
      undefined,
      undefined,
      undefined,
      'app=lifecycle-deploy,type=kubernetes-apply'
    );
    expect(mockListNamespacedPod.mock.calls.map((call) => call[5])).toEqual([
      'controller-uid=helm-uid',
      'batch.kubernetes.io/controller-uid=github-uid',
      'job=label-job',
    ]);
    expect(result).toEqual([
      expect.objectContaining({
        jobName: 'github-service-deploy-j3-ccccccc',
        deployUuid: 'github-service',
        sha: 'ccccccc',
        status: 'Pending',
        duration: 60,
        podName: 'github-pod',
        deploymentType: 'github',
        source: 'live',
      }),
      expect.objectContaining({
        jobName: 'failed-service-deploy-j2-bbbbbbb',
        status: 'Failed',
        error: 'Job failed',
        deploymentType: 'helm',
      }),
      expect.objectContaining({
        jobName: 'label-service-deploy-j4-ddddddd',
        status: 'Active',
        duration: 180,
        podName: 'label-pod',
        deploymentType: 'github',
      }),
      expect.objectContaining({
        jobName: 'helm-service-deploy-j1-aaaaaaa',
        status: 'Complete',
        startedAt: '2026-08-27T10:00:00.100Z',
        completedAt: '2026-08-27T10:01:05.900Z',
        duration: 65,
        podName: 'helm-pod',
      }),
    ]);
    now.mockRestore();
  });

  it('merges an archive into a podless live job, adds archive-only jobs, and preserves live timing', async () => {
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
    mockListNamespacedJob
      .mockResolvedValueOnce({
        body: {
          items: [
            job({
              name: 'live-service-deploy-j1-aaaaaaa',
              labels: { 'app.kubernetes.io/name': 'native-helm' },
              status: { succeeded: 1, startTime: '2026-08-27T10:00:00.000Z' },
            }),
          ],
        },
      })
      .mockResolvedValueOnce({ body: { items: [] } });
    mockListArchivedJobs.mockResolvedValue([
      {
        jobName: 'live-service-deploy-j1-aaaaaaa',
        jobType: 'deploy',
        serviceName: 'catalog',
        namespace: 'env-build',
        status: 'Complete',
        sha: 'aaaaaaa',
        deployUuid: 'live-service',
        startedAt: '2026-08-27T09:00:00.000Z',
        completedAt: '2026-08-27T10:02:00.000Z',
        duration: 120,
        deploymentType: 'github',
        archivedAt: '2026-08-27T10:03:00.000Z',
      },
      {
        jobName: 'archived-service-deploy-j0-zzzzzzz',
        jobType: 'deploy',
        serviceName: 'catalog',
        namespace: 'env-build',
        status: 'Failed',
        sha: 'zzzzzzz',
        startedAt: '2026-08-27T11:00:00.000Z',
        completedAt: '2026-08-27T11:01:00.000Z',
        duration: 60,
        archivedAt: '2026-08-27T11:02:00.000Z',
      },
    ]);

    const result = await getDeploymentJobs('catalog', 'env-build');

    expect(mockListArchivedJobs).toHaveBeenCalledWith('env-build', 'deploy', 'catalog');
    expect(result).toEqual([
      {
        jobName: 'archived-service-deploy-j0-zzzzzzz',
        deployUuid: '',
        sha: 'zzzzzzz',
        status: 'Failed',
        startedAt: '2026-08-27T11:00:00.000Z',
        completedAt: '2026-08-27T11:01:00.000Z',
        duration: 60,
        deploymentType: 'helm',
        source: 'archived',
      },
      {
        jobName: 'live-service-deploy-j1-aaaaaaa',
        deployUuid: 'live-service',
        sha: 'aaaaaaa',
        status: 'Complete',
        startedAt: '2026-08-27T10:00:00.000Z',
        completedAt: '2026-08-27T10:02:00.000Z',
        duration: 120,
        error: undefined,
        podName: undefined,
        deploymentType: 'helm',
        source: 'archived',
      },
    ]);
  });

  it('backfills only missing timing fields when matching live deploy jobs to archives', async () => {
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
    mockListNamespacedJob
      .mockResolvedValueOnce({
        body: {
          items: [
            job({
              name: 'missing-start-deploy-j1-aaaaaaa',
              labels: { 'app.kubernetes.io/name': 'native-helm' },
              status: { succeeded: 1, completionTime: '2026-08-27T10:05:00.000Z' },
            }),
            job({
              name: 'complete-live-deploy-j2-bbbbbbb',
              labels: { 'app.kubernetes.io/name': 'native-helm' },
              status: {
                succeeded: 1,
                startTime: '2026-08-27T09:00:00.000Z',
                completionTime: '2026-08-27T09:01:00.000Z',
              },
            }),
          ],
        },
      })
      .mockResolvedValueOnce({ body: { items: [] } });
    mockListArchivedJobs.mockResolvedValue([
      {
        jobName: 'missing-start-deploy-j1-aaaaaaa',
        jobType: 'deploy',
        serviceName: 'catalog',
        namespace: 'env-build',
        status: 'Complete',
        sha: 'aaaaaaa',
        startedAt: '2026-08-27T10:00:00.000Z',
        completedAt: '2026-08-27T10:04:00.000Z',
        duration: 300,
        archivedAt: '2026-08-27T10:06:00.000Z',
      },
      {
        jobName: 'complete-live-deploy-j2-bbbbbbb',
        jobType: 'deploy',
        serviceName: 'catalog',
        namespace: 'env-build',
        status: 'Complete',
        sha: 'bbbbbbb',
        startedAt: '2026-08-27T08:00:00.000Z',
        completedAt: '2026-08-27T08:02:00.000Z',
        duration: 120,
        archivedAt: '2026-08-27T09:02:00.000Z',
      },
    ]);

    const result = await getDeploymentJobs('catalog', 'env-build');

    expect(
      result.map(({ jobName, startedAt, completedAt, duration, source }) => ({
        jobName,
        startedAt,
        completedAt,
        duration,
        source,
      }))
    ).toEqual([
      {
        jobName: 'missing-start-deploy-j1-aaaaaaa',
        startedAt: '2026-08-27T10:00:00.000Z',
        completedAt: '2026-08-27T10:05:00.000Z',
        duration: 300,
        source: 'archived',
      },
      {
        jobName: 'complete-live-deploy-j2-bbbbbbb',
        startedAt: '2026-08-27T09:00:00.000Z',
        completedAt: '2026-08-27T09:01:00.000Z',
        duration: 60,
        source: 'archived',
      },
    ]);
  });

  it('keeps newly admitted jobs pending when status and pod-list items are not populated yet', async () => {
    mockGetAllConfigs.mockResolvedValue({});
    mockListNamespacedJob
      .mockResolvedValueOnce({
        body: {
          items: [
            job({
              name: 'pending-service-deploy-j1-aaaaaaa',
              labels: { 'app.kubernetes.io/name': 'native-helm' },
              selector: { job: 'pending-job' },
            }),
            job({
              name: 'failed-service-deploy-j2-bbbbbbb',
              labels: { 'app.kubernetes.io/name': 'native-helm' },
              status: { failed: 1 },
            }),
          ],
        },
      })
      .mockResolvedValueOnce({ body: {} });
    mockListNamespacedPod.mockResolvedValue({ body: {} });

    await expect(getDeploymentJobs('catalog', 'env-build')).resolves.toEqual([
      expect.objectContaining({
        jobName: 'pending-service-deploy-j1-aaaaaaa',
        status: 'Pending',
        startedAt: undefined,
        completedAt: undefined,
        podName: undefined,
      }),
      expect.objectContaining({
        jobName: 'failed-service-deploy-j2-bbbbbbb',
        status: 'Failed',
        error: 'Job failed',
      }),
    ]);
    expect(mockListArchivedJobs).not.toHaveBeenCalled();
  });

  it('returns an empty list when Kubernetes omits both job item arrays', async () => {
    mockGetAllConfigs.mockResolvedValue({});
    mockListNamespacedJob.mockResolvedValue({ body: {} });

    await expect(getDeploymentJobs('catalog', 'env-build')).resolves.toEqual([]);
    expect(mockListArchivedJobs).not.toHaveBeenCalled();
  });

  it('keeps pod and archive lookup failures best-effort', async () => {
    const podFailure = new Error('pod access forbidden');
    const archiveFailure = new Error('archive unavailable');
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
    mockListNamespacedJob
      .mockResolvedValueOnce({
        body: {
          items: [
            job({
              name: 'service-deploy-j1-aaaaaaa',
              labels: { 'app.kubernetes.io/name': 'native-helm' },
              status: { active: 1 },
              selector: { job: 'service-job' },
            }),
          ],
        },
      })
      .mockResolvedValueOnce({ body: { items: [] } });
    mockListNamespacedPod.mockRejectedValue(podFailure);
    mockListArchivedJobs.mockRejectedValue(archiveFailure);

    await expect(getDeploymentJobs('catalog', 'env-build')).resolves.toEqual([
      expect.objectContaining({ jobName: 'service-deploy-j1-aaaaaaa', status: 'Active', source: 'live' }),
    ]);
    expect(mockWarn).toHaveBeenCalledWith(
      { error: podFailure },
      'K8s: failed to get pods jobName=service-deploy-j1-aaaaaaa'
    );
    expect(mockWarn).toHaveBeenCalledWith(
      { error: archiveFailure },
      'LogArchival: failed to list archived deploy jobs service=catalog'
    );
  });

  it('logs and rethrows a Kubernetes list failure', async () => {
    const failure = new Error('cluster unavailable');
    mockListNamespacedJob.mockRejectedValue(failure);

    await expect(getDeploymentJobs('catalog', 'env-build')).rejects.toBe(failure);
    expect(mockError).toHaveBeenCalledWith({ error: failure }, 'K8s: failed to list deployment jobs service=catalog');
  });
});
