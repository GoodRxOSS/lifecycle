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

import { getNativeBuildJobs } from '../getNativeBuildJobs';

function job({
  name,
  labels,
  status,
  selector,
}: {
  name: string;
  labels?: Record<string, string>;
  status?: Record<string, unknown>;
  selector?: Record<string, string>;
}) {
  return {
    metadata: { name, labels },
    status,
    spec: selector ? { selector: { matchLabels: selector } } : undefined,
  };
}

describe('getNativeBuildJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: false } });
    mockListArchivedJobs.mockResolvedValue([]);
  });

  it('maps build metadata, status, duration, pods, and newest-first order', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-27T12:00:00.000Z').getTime());
    mockListNamespacedJob.mockResolvedValue({
      body: {
        items: [
          job({
            name: 'complete-build',
            labels: {
              'lc-deploy-uuid': 'build-complete',
              'git-sha': 'aaaaaaa',
              'builder-engine': 'buildkit',
            },
            status: {
              succeeded: 1,
              startTime: '2026-08-27T10:00:00.100Z',
              completionTime: '2026-08-27T10:01:05.900Z',
            },
            selector: { 'controller-uid': 'complete-uid' },
          }),
          job({
            name: 'failed-build',
            labels: { 'lc-deploy-uuid': 'build-failed', 'git-sha': 'bbbbbbb', 'builder-engine': 'kaniko' },
            status: {
              failed: 1,
              startTime: '2026-08-27T11:58:00.000Z',
              conditions: [{ type: 'Failed', status: 'True', message: 'image push denied' }],
            },
          }),
          job({
            name: 'active-build',
            labels: { 'lc-deploy-uuid': 'build-active', 'git-sha': 'ccccccc' },
            status: { active: 1, startTime: '2026-08-27T11:59:00.000Z' },
            selector: { 'batch.kubernetes.io/controller-uid': 'active-uid' },
          }),
          job({ name: 'not-started-build' }),
        ],
      },
    });
    mockListNamespacedPod
      .mockResolvedValueOnce({
        body: { items: [{ metadata: { name: 'complete-pod' }, status: { phase: 'Succeeded' } }] },
      })
      .mockResolvedValueOnce({
        body: { items: [{ metadata: { name: 'active-pod' }, status: { phase: 'Pending' } }] },
      });

    const result = await getNativeBuildJobs('catalog', 'env-build');

    expect(mockListNamespacedJob).toHaveBeenCalledWith(
      'env-build',
      undefined,
      undefined,
      undefined,
      undefined,
      'lc-service=catalog,app.kubernetes.io/component=build'
    );
    expect(mockListNamespacedPod.mock.calls.map((call) => call[5])).toEqual([
      'controller-uid=complete-uid',
      'batch.kubernetes.io/controller-uid=active-uid',
    ]);
    expect(result).toEqual([
      expect.objectContaining({
        jobName: 'active-build',
        buildUuid: 'build-active',
        sha: 'ccccccc',
        status: 'Pending',
        duration: 60,
        engine: 'unknown',
        podName: 'active-pod',
        source: 'live',
      }),
      expect.objectContaining({
        jobName: 'failed-build',
        status: 'Failed',
        error: 'image push denied',
        engine: 'kaniko',
      }),
      expect.objectContaining({
        jobName: 'complete-build',
        status: 'Complete',
        startedAt: '2026-08-27T10:00:00.100Z',
        completedAt: '2026-08-27T10:01:05.900Z',
        duration: 65,
        engine: 'buildkit',
        podName: 'complete-pod',
      }),
      expect.objectContaining({
        jobName: 'not-started-build',
        buildUuid: '',
        sha: '',
        status: 'Pending',
        engine: 'unknown',
      }),
    ]);
    now.mockRestore();
  });

  it('merges an archive into a podless live build and adds archive-only builds with engine fallbacks', async () => {
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
    mockListNamespacedJob.mockResolvedValue({
      body: {
        items: [
          job({
            name: 'live-build',
            labels: { 'lc-deploy-uuid': 'live-uuid', 'git-sha': 'aaaaaaa', 'builder-engine': 'buildkit' },
            status: { succeeded: 1, startTime: '2026-08-27T10:00:00.000Z' },
          }),
        ],
      },
    });
    mockListArchivedJobs.mockResolvedValue([
      {
        jobName: 'live-build',
        jobType: 'build',
        serviceName: 'catalog',
        namespace: 'env-build',
        status: 'Complete',
        sha: 'aaaaaaa',
        buildUuid: 'live-uuid',
        engine: 'kaniko',
        startedAt: '2026-08-27T09:00:00.000Z',
        completedAt: '2026-08-27T10:02:00.000Z',
        duration: 120,
        archivedAt: '2026-08-27T10:03:00.000Z',
      },
      {
        jobName: 'archived-build',
        jobType: 'build',
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

    const result = await getNativeBuildJobs('catalog', 'env-build');

    expect(mockListArchivedJobs).toHaveBeenCalledWith('env-build', 'build', 'catalog');
    expect(result).toEqual([
      {
        jobName: 'archived-build',
        buildUuid: '',
        sha: 'zzzzzzz',
        status: 'Failed',
        startedAt: '2026-08-27T11:00:00.000Z',
        completedAt: '2026-08-27T11:01:00.000Z',
        duration: 60,
        engine: 'unknown',
        source: 'archived',
      },
      {
        jobName: 'live-build',
        buildUuid: 'live-uuid',
        sha: 'aaaaaaa',
        status: 'Complete',
        startedAt: '2026-08-27T10:00:00.000Z',
        completedAt: '2026-08-27T10:02:00.000Z',
        duration: 120,
        engine: 'buildkit',
        error: undefined,
        podName: undefined,
        source: 'archived',
      },
    ]);
  });

  it('backfills only missing timing fields when matching live builds to archives', async () => {
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
    mockListNamespacedJob.mockResolvedValue({
      body: {
        items: [
          job({
            name: 'missing-start-build',
            labels: { 'lc-deploy-uuid': 'missing-start', 'git-sha': 'aaaaaaa' },
            status: { succeeded: 1, completionTime: '2026-08-27T10:05:00.000Z' },
          }),
          job({
            name: 'complete-live-build',
            labels: { 'lc-deploy-uuid': 'complete-live', 'git-sha': 'bbbbbbb' },
            status: {
              succeeded: 1,
              startTime: '2026-08-27T09:00:00.000Z',
              completionTime: '2026-08-27T09:01:00.000Z',
            },
          }),
        ],
      },
    });
    mockListArchivedJobs.mockResolvedValue([
      {
        jobName: 'missing-start-build',
        jobType: 'build',
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
        jobName: 'complete-live-build',
        jobType: 'build',
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

    const result = await getNativeBuildJobs('catalog', 'env-build');

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
        jobName: 'missing-start-build',
        startedAt: '2026-08-27T10:00:00.000Z',
        completedAt: '2026-08-27T10:05:00.000Z',
        duration: 300,
        source: 'archived',
      },
      {
        jobName: 'complete-live-build',
        startedAt: '2026-08-27T09:00:00.000Z',
        completedAt: '2026-08-27T09:01:00.000Z',
        duration: 60,
        source: 'archived',
      },
    ]);
  });

  it('keeps newly admitted builds pending when status and pod-list items are not populated yet', async () => {
    mockGetAllConfigs.mockResolvedValue({});
    mockListNamespacedJob.mockResolvedValue({
      body: {
        items: [
          job({
            name: 'pending-build',
            labels: { 'lc-deploy-uuid': 'pending-uuid', 'git-sha': 'aaaaaaa' },
            selector: { job: 'pending-build' },
          }),
          job({
            name: 'failed-build',
            labels: { 'lc-deploy-uuid': 'failed-uuid', 'git-sha': 'bbbbbbb' },
            status: { failed: 1 },
          }),
          job({
            name: 'active-build',
            labels: { 'lc-deploy-uuid': 'active-uuid', 'git-sha': 'ccccccc' },
            status: { active: 1 },
            selector: { job: 'active-build' },
          }),
        ],
      },
    });
    mockListNamespacedPod
      .mockResolvedValueOnce({ body: {} })
      .mockResolvedValueOnce({ body: { items: [{ metadata: { name: 'active-pod' } }] } });

    await expect(getNativeBuildJobs('catalog', 'env-build')).resolves.toEqual([
      expect.objectContaining({
        jobName: 'pending-build',
        status: 'Pending',
        startedAt: undefined,
        completedAt: undefined,
        podName: undefined,
      }),
      expect.objectContaining({
        jobName: 'failed-build',
        status: 'Failed',
        error: 'Job failed',
      }),
      expect.objectContaining({
        jobName: 'active-build',
        status: 'Active',
        podName: 'active-pod',
      }),
    ]);
    expect(mockListArchivedJobs).not.toHaveBeenCalled();
  });

  it('returns an empty list when Kubernetes omits the job item array', async () => {
    mockGetAllConfigs.mockResolvedValue({});
    mockListNamespacedJob.mockResolvedValue({ body: {} });

    await expect(getNativeBuildJobs('catalog', 'env-build')).resolves.toEqual([]);
    expect(mockListArchivedJobs).not.toHaveBeenCalled();
  });

  it('keeps pod and archive lookup failures best-effort', async () => {
    const podFailure = new Error('pod access forbidden');
    const archiveFailure = new Error('archive unavailable');
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
    mockListNamespacedJob.mockResolvedValue({
      body: {
        items: [
          job({
            name: 'active-build',
            status: { active: 1 },
            selector: { job: 'active-build' },
          }),
        ],
      },
    });
    mockListNamespacedPod.mockRejectedValue(podFailure);
    mockListArchivedJobs.mockRejectedValue(archiveFailure);

    await expect(getNativeBuildJobs('catalog', 'env-build')).resolves.toEqual([
      expect.objectContaining({ jobName: 'active-build', status: 'Active', source: 'live' }),
    ]);
    expect(mockWarn).toHaveBeenCalledWith({ error: podFailure }, 'K8s: failed to get pods jobName=active-build');
    expect(mockWarn).toHaveBeenCalledWith(
      { error: archiveFailure },
      'LogArchival: failed to list archived build jobs service=catalog'
    );
  });

  it('logs and rethrows a Kubernetes list failure', async () => {
    const failure = new Error('cluster unavailable');
    mockListNamespacedJob.mockRejectedValue(failure);

    await expect(getNativeBuildJobs('catalog', 'env-build')).rejects.toBe(failure);
    expect(mockError).toHaveBeenCalledWith({ error: failure }, 'K8s: failed to list build jobs service=catalog');
  });
});
