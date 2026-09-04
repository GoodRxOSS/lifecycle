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

var mockBatchApi: { listNamespacedJob: jest.Mock };
var mockCoreApi: {
  listNamespacedPod: jest.Mock;
  readNamespacedPodLog: jest.Mock;
  readNamespacedPod: jest.Mock;
};
var mockLogger: { error: jest.Mock };

jest.mock('@kubernetes/client-node', () => {
  const BatchV1Api = jest.fn();
  const CoreV1Api = jest.fn();
  mockBatchApi = { listNamespacedJob: jest.fn() };
  mockCoreApi = {
    listNamespacedPod: jest.fn(),
    readNamespacedPodLog: jest.fn(),
    readNamespacedPod: jest.fn(),
  };

  return {
    BatchV1Api,
    CoreV1Api,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn((client) => (client === BatchV1Api ? mockBatchApi : mockCoreApi)),
    })),
  };
});

jest.mock('server/lib/logger', () => {
  mockLogger = { error: jest.fn() };
  return { getLogger: () => mockLogger };
});

import { Deploy } from 'server/models';
import { getKubernetesApplyLogs, streamKubernetesApplyLogs } from './logs';

function deploy(namespace: string | null = 'env-1'): Deploy {
  return { uuid: 'deploy-1', build: namespace ? { namespace } : undefined } as Deploy;
}

function job(name: string | undefined, creationTimestamp = '2026-01-01T00:00:00.000Z') {
  return { metadata: { name, creationTimestamp } };
}

function pod(name: string | undefined) {
  return { metadata: { name } };
}

async function advancePollingTime(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 2000) {
    jest.advanceTimersByTime(Math.min(2000, milliseconds - elapsed));
    for (let pending = 0; pending < 5; pending += 1) await Promise.resolve();
  }
}

describe('Kubernetes apply logs', () => {
  beforeEach(() => {
    jest.useRealTimers();
    mockBatchApi.listNamespacedJob.mockReset();
    mockCoreApi.listNamespacedPod.mockReset();
    mockCoreApi.readNamespacedPodLog.mockReset();
    mockCoreApi.readNamespacedPod.mockReset();
    mockLogger.error.mockReset();
  });

  describe('getKubernetesApplyLogs', () => {
    it('does not query Kubernetes when the deploy has no build namespace', async () => {
      await expect(getKubernetesApplyLogs(deploy(null))).resolves.toBe('No namespace found for deploy');
      expect(mockBatchApi.listNamespacedJob).not.toHaveBeenCalled();
    });

    it('uses the deploy label selector and reports an absent deployment job', async () => {
      mockBatchApi.listNamespacedJob.mockResolvedValue({ body: { items: [] } });

      await expect(getKubernetesApplyLogs(deploy())).resolves.toBe('No deployment job found');
      expect(mockBatchApi.listNamespacedJob).toHaveBeenCalledWith(
        'env-1',
        undefined,
        undefined,
        undefined,
        undefined,
        'app=lifecycle-deploy,type=kubernetes-apply,deploy_uuid=deploy-1'
      );
    });

    it('selects the most recent named job and reports when it has no pods', async () => {
      mockBatchApi.listNamespacedJob.mockResolvedValue({
        body: {
          items: [job('old-job', '2026-01-01T00:00:00.000Z'), job('new-job', '2026-01-02T00:00:00.000Z')],
        },
      });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [] } });

      await expect(getKubernetesApplyLogs(deploy())).resolves.toBe('No pods found for deployment job');
      expect(mockCoreApi.listNamespacedPod).toHaveBeenCalledWith(
        'env-1',
        undefined,
        undefined,
        undefined,
        undefined,
        'job-name=new-job'
      );
    });

    it.each([
      [[{}, job('dated-job', '2026-01-02T00:00:00.000Z')]],
      [[job('dated-job', '2026-01-02T00:00:00.000Z'), {}]],
    ])('treats a job without creation metadata as older than a dated job', async (items) => {
      mockBatchApi.listNamespacedJob.mockResolvedValue({ body: { items } });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [] } });

      await expect(getKubernetesApplyLogs(deploy())).resolves.toBe('No pods found for deployment job');
      expect(mockCoreApi.listNamespacedPod).toHaveBeenCalledWith(
        'env-1',
        undefined,
        undefined,
        undefined,
        undefined,
        'job-name=dated-job'
      );
    });

    it('reports a selected job without a name', async () => {
      mockBatchApi.listNamespacedJob.mockResolvedValue({ body: { items: [{}] } });

      await expect(getKubernetesApplyLogs(deploy())).resolves.toBe('Job found but has no name');
      expect(mockCoreApi.listNamespacedPod).not.toHaveBeenCalled();
    });

    it('combines available pod logs, skips unnamed pods, and contains per-pod failures', async () => {
      const podFailure = new Error('container is waiting');
      mockBatchApi.listNamespacedJob.mockResolvedValue({ body: { items: [job('apply-job')] } });
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        body: { items: [pod('pod-a'), {}, pod('pod-b'), pod('pod-c'), pod('pod-empty')] },
      });
      mockCoreApi.readNamespacedPodLog
        .mockResolvedValueOnce({ body: 'created service' })
        .mockRejectedValueOnce(podFailure)
        .mockRejectedValueOnce('unknown failure')
        .mockResolvedValueOnce({ body: '' });

      await expect(getKubernetesApplyLogs(deploy(), 40)).resolves.toBe(
        '=== Logs from pod pod-a ===\ncreated service\n\n=== Error fetching logs from pod pod-b ===\ncontainer is waiting\n\n=== Error fetching logs from pod pod-c ===\nunknown failure'
      );
      expect(mockCoreApi.readNamespacedPodLog).toHaveBeenNthCalledWith(
        1,
        'pod-a',
        'env-1',
        'kubectl-apply',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        40,
        undefined
      );
      expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledTimes(4);
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Pod: log fetch failed'));
    });

    it('returns a stable empty message when named pods have no log body', async () => {
      mockBatchApi.listNamespacedJob.mockResolvedValue({ body: { items: [job('apply-job')] } });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [pod('pod-a')] } });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue({ body: undefined });

      await expect(getKubernetesApplyLogs(deploy())).resolves.toBe('No logs available');
    });

    it.each([
      [new Error('API unavailable'), 'Failed to fetch logs: API unavailable'],
      ['bad response', 'Failed to fetch logs: bad response'],
    ] as const)('contains job-discovery failures', async (failure, expected) => {
      mockBatchApi.listNamespacedJob.mockRejectedValue(failure);
      await expect(getKubernetesApplyLogs(deploy())).resolves.toBe(expected);
    });
  });

  describe('streamKubernetesApplyLogs', () => {
    function handlers() {
      return { onData: jest.fn(), onError: jest.fn(), onClose: jest.fn() };
    }

    it('closes with an error when the namespace is absent', async () => {
      const listener = handlers();
      const stop = await streamKubernetesApplyLogs(deploy(null), listener.onData, listener.onError, listener.onClose);

      expect(listener.onError).toHaveBeenCalledWith(new Error('No namespace found'));
      expect(listener.onClose).toHaveBeenCalledTimes(1);
      expect(() => stop()).not.toThrow();
    });

    it.each([
      [{ jobs: [] }, 'No deployment job found'],
      [{ jobs: [{}] }, 'Job found but has no name'],
      [{ jobs: [job('apply-job')], pods: [] }, 'No pods found for deployment job'],
      [{ jobs: [job('apply-job')], pods: [{}] }, 'Pod has no name'],
    ])('reports incomplete Kubernetes discovery and does not start polling', async (setup, expectedMessage) => {
      const listener = handlers();
      mockBatchApi.listNamespacedJob.mockResolvedValue({ body: { items: setup.jobs } });
      if ('pods' in setup) {
        mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: setup.pods } });
      }

      const stop = await streamKubernetesApplyLogs(deploy(), listener.onData, listener.onError, listener.onClose);

      expect(listener.onError).toHaveBeenCalledWith(new Error(expectedMessage));
      expect(listener.onClose).toHaveBeenCalledTimes(1);
      expect(mockCoreApi.readNamespacedPodLog).not.toHaveBeenCalled();
      expect(() => stop()).not.toThrow();
    });

    it.each([
      [[{}, job('dated-job', '2026-01-02T00:00:00.000Z')]],
      [[job('dated-job', '2026-01-02T00:00:00.000Z'), {}]],
    ])('streams from the dated job when another job has no creation metadata', async (items) => {
      const listener = handlers();
      mockBatchApi.listNamespacedJob.mockResolvedValue({ body: { items } });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [] } });

      await streamKubernetesApplyLogs(deploy(), listener.onData, listener.onError, listener.onClose);

      expect(mockCoreApi.listNamespacedPod).toHaveBeenCalledWith(
        'env-1',
        undefined,
        undefined,
        undefined,
        undefined,
        'job-name=dated-job'
      );
      expect(listener.onError).toHaveBeenCalledWith(new Error('No pods found for deployment job'));
    });

    it.each(['Succeeded', 'Failed'] as const)(
      'emits only appended text and closes when the pod reaches %s',
      async (terminalPhase) => {
        jest.useFakeTimers();
        const listener = handlers();
        mockBatchApi.listNamespacedJob.mockResolvedValue({
          body: { items: [job('old-job', '2026-01-01'), job('new-job', '2026-01-02')] },
        });
        mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [pod('pod-1')] } });
        mockCoreApi.readNamespacedPodLog
          .mockResolvedValueOnce({ body: 'line one\n' })
          .mockResolvedValueOnce({ body: 'line one\n' })
          .mockResolvedValueOnce({ body: 'line one\nline two\n' });
        mockCoreApi.readNamespacedPod
          .mockResolvedValueOnce({ body: {} })
          .mockResolvedValueOnce({ body: { status: { phase: 'Running' } } })
          .mockResolvedValueOnce({ body: { status: { phase: terminalPhase } } });

        await streamKubernetesApplyLogs(deploy(), listener.onData, listener.onError, listener.onClose);
        await advancePollingTime(6000);

        expect(listener.onData.mock.calls.map(([data]) => data)).toEqual(['line one\n', 'line two\n']);
        expect(listener.onClose).toHaveBeenCalledTimes(1);
        expect(listener.onError).not.toHaveBeenCalled();
        expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledTimes(3);
        expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledWith(
          'pod-1',
          'env-1',
          'kubectl-apply',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          100,
          true
        );
        await advancePollingTime(4000);
        expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledTimes(3);
      }
    );

    it('keeps polling after a transient failure, then closes quietly when the pod disappears', async () => {
      jest.useFakeTimers();
      const listener = handlers();
      const transientFailure = new Error('temporary API failure');
      const notFoundFailure = { response: { statusCode: 404 } };
      mockBatchApi.listNamespacedJob.mockResolvedValue({ body: { items: [job('apply-job')] } });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [pod('pod-1')] } });
      mockCoreApi.readNamespacedPodLog.mockRejectedValueOnce(transientFailure).mockRejectedValueOnce(notFoundFailure);

      await streamKubernetesApplyLogs(deploy(), listener.onData, listener.onError, listener.onClose);
      await advancePollingTime(2000);
      expect(listener.onError).toHaveBeenCalledWith(transientFailure);
      expect(listener.onClose).not.toHaveBeenCalled();

      await advancePollingTime(2000);
      expect(listener.onClose).toHaveBeenCalledTimes(1);
      expect(listener.onError).toHaveBeenCalledTimes(1);
      await advancePollingTime(4000);
      expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledTimes(2);
    });

    it('the returned stop function prevents later polls and callbacks', async () => {
      jest.useFakeTimers();
      const listener = handlers();
      mockBatchApi.listNamespacedJob.mockResolvedValue({ body: { items: [job('apply-job')] } });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [pod('pod-1')] } });

      const stop = await streamKubernetesApplyLogs(deploy(), listener.onData, listener.onError, listener.onClose);
      stop();
      await advancePollingTime(6000);

      expect(mockCoreApi.readNamespacedPodLog).not.toHaveBeenCalled();
      expect(listener.onData).not.toHaveBeenCalled();
      expect(listener.onClose).not.toHaveBeenCalled();
    });

    it('a poll callback already queued before stop exits without reading logs', async () => {
      const listener = handlers();
      let queuedPoll!: () => Promise<void>;
      const interval = jest.spyOn(global, 'setInterval').mockImplementation(((callback: () => Promise<void>) => {
        queuedPoll = callback;
        return 123 as any;
      }) as typeof setInterval);
      const clear = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
      mockBatchApi.listNamespacedJob.mockResolvedValue({ body: { items: [job('apply-job')] } });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: [pod('pod-1')] } });

      const stop = await streamKubernetesApplyLogs(deploy(), listener.onData, listener.onError, listener.onClose);
      stop();
      await queuedPoll();

      expect(mockCoreApi.readNamespacedPodLog).not.toHaveBeenCalled();
      expect(clear).toHaveBeenCalledTimes(2);
      interval.mockRestore();
      clear.mockRestore();
    });

    it('contains failures that occur while starting the stream', async () => {
      const listener = handlers();
      const failure = new Error('job list denied');
      mockBatchApi.listNamespacedJob.mockRejectedValue(failure);

      const stop = await streamKubernetesApplyLogs(deploy(), listener.onData, listener.onError, listener.onClose);

      expect(listener.onError).toHaveBeenCalledWith(failure);
      expect(listener.onClose).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Logs: stream start failed'));
      expect(() => stop()).not.toThrow();
    });
  });
});
