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

var mockFindOne: jest.Mock;
var mockWhereNull: jest.Mock;
var mockGetK8sJobStatusAndPod: jest.Mock;
var mockGetAllConfigs: jest.Mock;
var mockGetArchivedLogs: jest.Mock;
var mockLogger: { info: jest.Mock; warn: jest.Mock };

jest.mock('server/services/build', () => {
  mockFindOne = jest.fn();
  mockWhereNull = jest.fn();
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      db: { models: { Build: { query: () => ({ findOne: mockFindOne }) } } },
    })),
  };
});

jest.mock('server/lib/logStreamingHelper', () => {
  mockGetK8sJobStatusAndPod = jest.fn();
  return { getK8sJobStatusAndPod: (...args: unknown[]) => mockGetK8sJobStatusAndPod(...args) };
});

jest.mock('server/services/globalConfig', () => {
  mockGetAllConfigs = jest.fn();
  return {
    __esModule: true,
    default: { getInstance: () => ({ getAllConfigs: mockGetAllConfigs }) },
  };
});

jest.mock('server/services/logArchival', () => {
  mockGetArchivedLogs = jest.fn();
  return { getLogArchivalService: () => ({ getArchivedLogs: mockGetArchivedLogs }) };
});

jest.mock('server/lib/logger', () => {
  mockLogger = { info: jest.fn(), warn: jest.fn() };
  return { getLogger: () => mockLogger };
});

import { LogStreamingService } from './logStreaming';

function podInfo(
  status: 'Running' | 'Pending' | 'Succeeded' | 'Failed' | 'Unknown',
  overrides: Record<string, unknown> = {}
) {
  return {
    podName: 'pod-1',
    namespace: 'env-build-1',
    status,
    containers: [{ name: 'worker', state: 'running' }],
    ...overrides,
  };
}

describe('LogStreamingService', () => {
  beforeEach(() => {
    mockFindOne.mockReset();
    mockWhereNull.mockReset();
    mockGetK8sJobStatusAndPod.mockReset();
    mockGetAllConfigs.mockReset();
    mockGetArchivedLogs.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();

    mockFindOne.mockReturnValue({ whereNull: mockWhereNull });
    mockWhereNull.mockResolvedValue({ id: 17, uuid: 'build-1' });
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: false } });
  });

  it('rejects an unknown or deleted build before querying Kubernetes', async () => {
    mockWhereNull.mockResolvedValue(null);

    await expect(new LogStreamingService().getLogStreamInfo('build-1', 'job-1')).rejects.toThrow('Build not found');
    expect(mockFindOne).toHaveBeenCalledWith({ uuid: 'build-1' });
    expect(mockWhereNull).toHaveBeenCalledWith('deletedAt');
    expect(mockGetK8sJobStatusAndPod).not.toHaveBeenCalled();
  });

  it('binds an expected build row and exposes an active pod over the websocket contract', async () => {
    mockGetK8sJobStatusAndPod.mockResolvedValue(podInfo('Running'));

    await expect(
      new LogStreamingService().getLogStreamInfo('build-1', 'service-buildkit-123', 'api', undefined, 17)
    ).resolves.toEqual({
      status: 'Active',
      streamingRequired: true,
      podName: 'pod-1',
      websocket: {
        endpoint: '/api/logs/stream',
        parameters: {
          podName: 'pod-1',
          namespace: 'env-build-1',
          follow: true,
          timestamps: true,
        },
      },
      containers: [{ name: 'worker', state: 'running' }],
    });
    expect(mockFindOne).toHaveBeenCalledWith({ uuid: 'build-1', id: 17 });
    expect(mockGetK8sJobStatusAndPod).toHaveBeenCalledWith('service-buildkit-123', 'env-build-1');
  });

  it.each([
    ['Pending', 'Pending', true],
    ['Unknown', 'Pending', true],
  ] as const)('maps %s pods to a followable %s stream', async (podStatus, status, follow) => {
    mockGetK8sJobStatusAndPod.mockResolvedValue(podInfo(podStatus, { containers: [] }));

    await expect(new LogStreamingService().getLogStreamInfo('build-1', 'job-1')).resolves.toEqual({
      status,
      streamingRequired: true,
      podName: 'pod-1',
      websocket: {
        endpoint: '/api/logs/stream',
        parameters: {
          podName: 'pod-1',
          namespace: 'env-build-1',
          follow,
          timestamps: true,
        },
      },
    });
  });

  it('keeps completed logs readable without following and adds a completion message', async () => {
    mockGetK8sJobStatusAndPod.mockResolvedValue(podInfo('Succeeded'));

    await expect(new LogStreamingService().getLogStreamInfo('build-1', 'job-1')).resolves.toMatchObject({
      status: 'Complete',
      streamingRequired: true,
      websocket: { parameters: { follow: false } },
      message: 'Job pod pod-1 has status: Completed. Streaming not active.',
    });
  });

  it('uses a generic failure message for builds and preserves a Kubernetes failure for deploys', async () => {
    mockGetK8sJobStatusAndPod
      .mockResolvedValueOnce(podInfo('Failed'))
      .mockResolvedValueOnce(podInfo('Failed', { message: 'release timed out' }));
    const service = new LogStreamingService();

    await expect(service.getLogStreamInfo('build-1', 'image-kaniko-1')).resolves.toMatchObject({
      status: 'Failed',
      streamingRequired: true,
      message: 'Job pod pod-1 has status: Failed. Streaming not active.',
    });
    await expect(service.getLogStreamInfo('build-1', 'release-helm-1')).resolves.toMatchObject({
      status: 'Failed',
      streamingRequired: true,
      message: 'release timed out',
      error: 'release timed out',
    });
  });

  it.each([
    ['service-buildkit-1', 'build'],
    ['service-kaniko-1', 'build'],
    ['hook-webhook-1', 'build'],
    ['hook-wh-1', 'build'],
    ['ordinary-job', 'build'],
    ['release-helm-1', 'deploy'],
  ] as const)('uses the detected type for archived %s logs', async (jobName, expectedJobType) => {
    mockGetK8sJobStatusAndPod.mockResolvedValue(null);
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
    mockGetArchivedLogs.mockResolvedValue('archived output');

    await expect(new LogStreamingService().getLogStreamInfo('build-1', jobName, 'api')).resolves.toEqual({
      status: 'Archived',
      streamingRequired: false,
      archivedLogs: 'archived output',
      message: 'Logs retrieved from archive',
    });
    expect(mockGetArchivedLogs).toHaveBeenCalledWith('env-build-1', expectedJobType, 'api', jobName);
  });

  it('honors an explicit deploy type and treats an empty archived object as available logs', async () => {
    mockGetK8sJobStatusAndPod.mockResolvedValue({
      podName: null,
      namespace: 'env-build-1',
      status: 'Succeeded',
      containers: [],
    });
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
    mockGetArchivedLogs.mockResolvedValue('');

    await expect(new LogStreamingService().getLogStreamInfo('build-1', 'custom-job', 'api', 'deploy')).resolves.toEqual(
      {
        status: 'Archived',
        streamingRequired: false,
        archivedLogs: '',
        message: 'Logs retrieved from archive',
      }
    );
    expect(mockGetArchivedLogs).toHaveBeenCalledWith('env-build-1', 'deploy', 'api', 'custom-job');
  });

  it.each([
    [undefined, 'ordinary-job', undefined, { status: 'NotFound', streamingRequired: false, message: 'Job not found' }],
    [
      { status: 'NotFound', message: 'cleaned up' },
      'release-helm-1',
      'api',
      { status: 'NotFound', streamingRequired: false, error: 'cleaned up' },
    ],
    [
      { status: 'NotFound' },
      'release-helm-1',
      'api',
      { status: 'NotFound', streamingRequired: false, error: 'Job not found' },
    ],
    [undefined, 'release-helm-1', 'api', { status: 'NotFound', streamingRequired: false, error: 'Job not found' }],
  ] as const)(
    'returns a type-specific not-found response when no archive is usable',
    async (info, jobName, serviceName, expected) => {
      mockGetK8sJobStatusAndPod.mockResolvedValue(info);
      mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
      mockGetArchivedLogs.mockResolvedValue(null);

      await expect(new LogStreamingService().getLogStreamInfo('build-1', jobName, serviceName)).resolves.toEqual(
        expected
      );
      if (!serviceName) expect(mockGetArchivedLogs).not.toHaveBeenCalled();
    }
  );

  it('falls back to live not-found semantics when archival is disabled', async () => {
    mockGetK8sJobStatusAndPod.mockResolvedValue({
      podName: null,
      namespace: 'env-build-1',
      status: 'NotFound',
      containers: [],
      message: 'pod expired',
    });

    mockGetAllConfigs.mockResolvedValue({});

    await expect(new LogStreamingService().getLogStreamInfo('build-1', 'job-1', 'api')).resolves.toEqual({
      status: 'NotFound',
      streamingRequired: false,
      message: 'pod expired',
    });
    expect(mockGetArchivedLogs).not.toHaveBeenCalled();
  });

  it('contains archive storage failures and returns the Kubernetes result', async () => {
    const archiveFailure = new Error('object store unavailable');
    mockGetK8sJobStatusAndPod.mockResolvedValue(null);
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
    mockGetArchivedLogs.mockRejectedValue(archiveFailure);

    await expect(new LogStreamingService().getLogStreamInfo('build-1', 'job-1', 'api')).resolves.toEqual({
      status: 'NotFound',
      streamingRequired: false,
      message: 'Job not found',
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { error: archiveFailure },
      'LogArchival: failed to fetch archived logs jobName=job-1'
    );
  });
});
