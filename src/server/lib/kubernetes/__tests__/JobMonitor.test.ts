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

var mockShellPromise: jest.Mock;
var mockDebug: jest.Mock;
var mockInfo: jest.Mock;
var mockWarn: jest.Mock;
var mockError: jest.Mock;

jest.mock('../../shell', () => {
  mockShellPromise = jest.fn();
  return { shellPromise: (...args: unknown[]) => mockShellPromise(...args) };
});

jest.mock('../../logger', () => {
  mockDebug = jest.fn();
  mockInfo = jest.fn();
  mockWarn = jest.fn();
  mockError = jest.fn();
  return {
    getLogger: () => ({
      debug: mockDebug,
      info: mockInfo,
      warn: mockWarn,
      error: mockError,
    }),
  };
});

import { JobMonitor } from '../JobMonitor';

describe('JobMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('waits through transient pod and container states, then returns complete filtered logs and timing', async () => {
    jest.useFakeTimers();
    const attempts = new Map<string, number>();
    const nextAttempt = (key: string) => {
      const attempt = (attempts.get(key) || 0) + 1;
      attempts.set(key, attempt);
      return attempt;
    };

    mockShellPromise.mockImplementation(async (command: string) => {
      if (command.includes('get pods')) {
        if (nextAttempt('pod') === 1) throw new Error('pod not admitted yet');
        return 'apply-pod\n';
      }
      if (command.includes('initContainerStatuses')) {
        return nextAttempt('init') === 1
          ? JSON.stringify([{ name: 'setup', ready: false, state: { running: {} } }])
          : JSON.stringify([{ name: 'setup', ready: false, state: { terminated: { exitCode: 0 } } }]);
      }
      if (command.includes('spec.initContainers')) return 'setup optional';
      if (command.includes('containerStatuses')) {
        const attempt = nextAttempt('main');
        if (attempt === 1) throw new Error('container status unavailable');
        return attempt === 2
          ? JSON.stringify([
              {
                name: 'kubectl-apply',
                state: { waiting: { reason: 'ContainerCreating' } },
              },
            ])
          : JSON.stringify([{ name: 'kubectl-apply', state: { running: { startedAt: 'now' } } }]);
      }
      if (command.includes("jsonpath='{.status.conditions}'")) {
        const attempt = nextAttempt('completion');
        if (attempt === 1) throw { stderr: 'temporary apiserver failure' };
        if (attempt === 2) throw {};
        return attempt === 3 ? '[]' : JSON.stringify([{ type: 'Complete', status: 'True' }]);
      }
      if (command.includes('spec.containers')) return 'kubectl-apply sidecar';
      if (command.includes('-c setup')) return 'setup complete';
      if (command.includes('-c optional')) throw {};
      if (command.includes('-c kubectl-apply')) return 'resources applied';
      if (command.endsWith('-o json')) {
        return JSON.stringify({
          status: {
            startTime: '2026-08-27T18:00:00.100Z',
            completionTime: '2026-08-27T18:00:05.900Z',
            conditions: [{ type: 'Complete', status: 'True' }],
          },
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const resultPromise = new JobMonitor('apply-job', 'env-build').waitForCompletion({
      timeoutSeconds: 30,
      containerFilters: ['kubectl-apply'],
    });
    await (jest as typeof jest & { runAllTimersAsync(): Promise<void> }).runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      logs:
        '\n=== Init Container Logs (setup) ===\nsetup complete\n' +
        '\n=== Container Logs (kubectl-apply) ===\nresources applied\n',
      success: true,
      status: 'succeeded',
      startedAt: '2026-08-27T18:00:00.100Z',
      completedAt: '2026-08-27T18:00:05.900Z',
      duration: 5,
    });
    expect(mockShellPromise).not.toHaveBeenCalledWith(expect.stringContaining('-c sidecar'), expect.anything());
    expect(mockInfo).toHaveBeenCalledWith(
      'Container: waiting name=kubectl-apply reason=ContainerCreating message=no message'
    );
    expect(mockDebug).toHaveBeenCalledWith('K8s: init container logs failed container=optional error=Unknown error');
    expect(mockDebug).toHaveBeenCalledWith(
      'Job status check failed for apply-job, will retry: temporary apiserver failure'
    );
    expect(mockDebug).toHaveBeenCalledWith('Job status check failed for apply-job, will retry: Unknown error');
  });

  it('treats a failed job annotated as superseded as a successful supersession', async () => {
    mockShellPromise.mockImplementation(async (command: string) => {
      if (command.includes('get pods')) return 'retry-pod';
      if (command.includes('initContainerStatuses')) return '[]';
      if (command.includes('spec.initContainers')) return '';
      if (command.includes('containerStatuses')) {
        return JSON.stringify([{ name: 'runner', state: { terminated: { exitCode: 1 } } }]);
      }
      if (command.includes("jsonpath='{.status.conditions}'")) {
        return JSON.stringify([{ type: 'Failed', status: 'True' }]);
      }
      if (command.includes('spec.containers')) return 'runner';
      if (command.includes('kubectl logs')) return 'cancelled by retry';
      if (command.endsWith('-o json')) {
        return JSON.stringify({ status: { conditions: [{ type: 'Failed', status: 'True' }] } });
      }
      if (command.includes('@.type=="Failed")].status')) return 'True';
      if (command.includes('@.type=="Failed")].reason')) return 'BackoffLimitExceeded';
      if (command.includes('@.type=="Failed")].message')) return 'container exited';
      if (command.includes('termination-reason')) return 'superseded-by-retry';
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(new JobMonitor('retry-job', 'env-build').waitForCompletion()).resolves.toEqual({
      logs: '\n=== Container Logs (runner) ===\ncancelled by retry\n',
      success: true,
      status: 'superseded',
      startedAt: undefined,
      completedAt: undefined,
      duration: undefined,
    });
    expect(mockInfo).toHaveBeenCalledWith('K8s: job superseded name=retry-job');
  });

  it('returns failed status and preserves a container log retrieval error', async () => {
    mockShellPromise.mockImplementation(async (command: string) => {
      if (command.includes('get pods')) return 'failed-pod';
      if (command.includes('initContainerStatuses')) return '[]';
      if (command.includes('spec.initContainers')) throw {};
      if (command.includes('containerStatuses')) {
        return JSON.stringify([{ name: 'runner', state: { terminated: { exitCode: 2 } } }]);
      }
      if (command.includes("jsonpath='{.status.conditions}'")) {
        return JSON.stringify([{ type: 'Failed', status: 'True' }]);
      }
      if (command.includes('spec.containers')) return 'runner';
      if (command.includes('kubectl logs')) throw new Error('log stream gone');
      if (command.endsWith('-o json')) {
        return JSON.stringify({ status: { conditions: [{ type: 'Failed', status: 'True' }] } });
      }
      if (command.includes('@.type=="Failed")].status')) return 'True';
      if (command.includes('@.type=="Failed")].reason')) return '';
      if (command.includes('@.type=="Failed")].message')) return '';
      if (command.includes('termination-reason')) throw {};
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await new JobMonitor('failed-job', 'env-build').waitForCompletion();

    expect(result).toMatchObject({
      success: false,
      status: 'failed',
      logs: '\n=== Container Logs (runner) ===\nError retrieving logs: log stream gone\n',
    });
    expect(mockError).toHaveBeenCalledWith('Job: failed name=failed-job reason=Unknown message=No message');
    expect(mockDebug).toHaveBeenCalledWith(
      'K8s: supersession annotation check failed job=failed-job error=Unknown error'
    );
    expect(mockDebug).toHaveBeenCalledWith('K8s: no init containers found pod=failed-pod error=Unknown error');
  });

  it('does not invent success when the final Job payload has no status', async () => {
    mockShellPromise.mockImplementation(async (command: string) => {
      if (command.includes('get pods')) return 'statusless-pod';
      if (command.includes('initContainerStatuses')) return '[]';
      if (command.includes('spec.initContainers')) return '';
      if (command.includes('containerStatuses')) {
        return JSON.stringify([{ name: 'runner', state: { terminated: { exitCode: 0 } } }]);
      }
      if (command.includes("jsonpath='{.status.conditions}'")) {
        return JSON.stringify([{ type: 'Complete', status: 'True' }]);
      }
      if (command.includes('spec.containers')) return '';
      if (command.endsWith('-o json')) return '{}';
      if (command.includes('@.type=="Failed")].status')) return '';
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(new JobMonitor('statusless-job', 'env-build').waitForCompletion()).resolves.toEqual({
      logs: '',
      success: false,
      status: 'failed',
      startedAt: undefined,
      completedAt: undefined,
      duration: undefined,
    });
  });

  it('stops waiting when the job is deleted externally and reports the unavailable final status', async () => {
    mockShellPromise.mockImplementation(async (command: string) => {
      if (command.includes('get pods')) return 'deleted-job-pod';
      if (command.includes('initContainerStatuses')) return '[]';
      if (command.includes('spec.initContainers')) return '';
      if (command.includes('containerStatuses')) {
        return JSON.stringify([{ name: 'runner', state: { running: {} } }]);
      }
      if (command.includes("jsonpath='{.status.conditions}'")) throw 'Error from server (NotFound): jobs not found';
      if (command.includes('spec.containers')) throw new Error('pod spec already deleted');
      if (command.endsWith('-o json')) throw new Error('job already deleted');
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await new JobMonitor('deleted-job', 'env-build').waitForCompletion();

    expect(result).toEqual({
      logs: '',
      success: false,
      status: 'failed',
      startedAt: undefined,
      completedAt: undefined,
      duration: undefined,
    });
    expect(mockInfo).toHaveBeenCalledWith('Job deleted externally, treating as completed: deleted-job');
    expect(mockWarn).toHaveBeenCalledWith({ error: expect.any(Error) }, 'Container: names fetch failed');
    expect(mockError).toHaveBeenCalledWith({ error: expect.any(Error) }, 'Job: status check failed name=deleted-job');
  });

  it('returns a deterministic failure when no pod is created before the timeout', async () => {
    jest.useFakeTimers();
    mockShellPromise.mockResolvedValue('');

    const resultPromise = new JobMonitor('missing-job', 'env-build').waitForCompletion({ timeoutSeconds: 2 });
    await (jest as typeof jest & { runAllTimersAsync(): Promise<void> }).runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      logs: 'Job monitoring failed: Pod for job missing-job was not created within timeout',
      success: false,
      status: 'failed',
    });
    expect(mockError).toHaveBeenCalledWith({ error: expect.any(Error) }, 'Job: monitor failed name=missing-job');
  });

  it('keeps the static compatibility API for numeric timeouts, prefixes, and container filters', async () => {
    const waitForCompletion = jest.spyOn(JobMonitor.prototype, 'waitForCompletion').mockResolvedValue({
      logs: 'done',
      success: true,
      status: 'succeeded',
      startedAt: '2026-08-27T18:00:00.000Z',
      completedAt: '2026-08-27T18:00:01.000Z',
      duration: 1,
    });

    await expect(JobMonitor.waitForJobAndGetLogs('job-a', 'env-a', 25, ['apply'])).resolves.toMatchObject({
      logs: 'done',
      success: true,
      duration: 1,
    });
    await expect(JobMonitor.waitForJobAndGetLogs('job-b', 'env-b', 'Deploy')).resolves.toMatchObject({
      status: 'succeeded',
    });

    expect(waitForCompletion).toHaveBeenNthCalledWith(1, {
      timeoutSeconds: 25,
      containerFilters: ['apply'],
    });
    expect(waitForCompletion).toHaveBeenNthCalledWith(2, { logPrefix: 'Deploy' });
  });
});
