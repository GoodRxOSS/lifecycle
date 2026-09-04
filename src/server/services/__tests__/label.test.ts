/**
 * Copyright 2026 Lifecycle contributors
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

const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};
const mockWithLogContext = jest.fn((_context, callback) => callback());
const mockUpdateLogContext = jest.fn();
const mockWaitForColumnValue = jest.fn();
const mockUpdatePullRequestLabels = jest.fn();
const mockGetDeployLabel = jest.fn();
const mockRegisterQueue = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: { getConnection: jest.fn(() => 'redis-connection') },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
  withLogContext: (context: unknown, callback: () => unknown) => mockWithLogContext(context, callback),
  updateLogContext: (context: unknown) => mockUpdateLogContext(context),
  LogStage: {
    LABEL_PROCESSING: 'label_processing',
    LABEL_COMPLETE: 'label_complete',
    LABEL_FAILED: 'label_failed',
  },
}));

jest.mock('shared/utils', () => ({
  waitForColumnValue: (model: unknown, column: string, attempts: number, interval: number) =>
    mockWaitForColumnValue(model, column, attempts, interval),
}));

jest.mock('server/lib/github', () => ({
  updatePullRequestLabels: (input: unknown) => mockUpdatePullRequestLabels(input),
}));

jest.mock('server/lib/utils', () => ({
  getDeployLabel: () => mockGetDeployLabel(),
}));

jest.mock('shared/config', () => ({
  QUEUE_NAMES: { LABEL: 'label' },
}));

import LabelService from '../label';

function pullRequestRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 8,
    pullRequestNumber: 17,
    fullName: 'goodrx/lifecycle',
    commentId: 101,
    repository: { githubInstallationId: 22 },
    build: { uuid: 'build-uuid' },
    ...overrides,
  };
}

function createService({
  pullRequest = pullRequestRecord(),
  labelsConfig = { deploy: ['deploy', 'deploy-stg'] },
} = {}) {
  const withGraphFetched = jest.fn().mockResolvedValue(pullRequest);
  const findById = jest.fn().mockReturnValue({ withGraphFetched });
  const query = jest.fn().mockReturnValue({ findById });
  const getLabels = jest.fn().mockResolvedValue(labelsConfig);
  mockRegisterQueue.mockReturnValue({ add: jest.fn() });
  const db = {
    models: { PullRequest: { query } },
    services: { GlobalConfig: { getLabels } },
  };
  const service = new LabelService(
    db as any,
    {} as any,
    {} as any,
    {
      registerQueue: mockRegisterQueue,
    } as any
  );
  return { service, query, findById, withGraphFetched, getLabels };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      pullRequestId: 8,
      action: 'enable',
      waitForComment: false,
      labels: ['existing'],
      sender: 'user-1',
      correlationId: 'corr-1',
      _ddTraceContext: { traceparent: 'trace-1' },
      ...overrides,
    },
  };
}

describe('LabelService.processLabelQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDeployLabel.mockResolvedValue('deploy');
    mockWaitForColumnValue.mockResolvedValue({ commentId: 101 });
    mockUpdatePullRequestLabels.mockResolvedValue(undefined);
  });

  it('adds the deploy label and propagates the queued logging context', async () => {
    const { service, findById, withGraphFetched } = createService();

    await service.processLabelQueue(job() as any);

    expect(mockWithLogContext).toHaveBeenCalledWith(
      { correlationId: 'corr-1', sender: 'user-1', _ddTraceContext: { traceparent: 'trace-1' } },
      expect.any(Function)
    );
    expect(findById).toHaveBeenCalledWith(8);
    expect(withGraphFetched).toHaveBeenCalledWith('[repository, build]');
    expect(mockUpdateLogContext).toHaveBeenCalledWith({ buildUuid: 'build-uuid' });
    expect(mockUpdatePullRequestLabels).toHaveBeenCalledWith({
      installationId: 22,
      pullRequestNumber: 17,
      fullName: 'goodrx/lifecycle',
      labels: ['existing', 'deploy'],
    });
    expect(mockLogger.info).toHaveBeenCalledWith('Label: added label=deploy');
  });

  it('skips GitHub when the enable label is already present', async () => {
    const { service } = createService();

    await service.processLabelQueue(job({ labels: ['existing', 'deploy'] }) as any);

    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith('Deploy label "deploy" already exists on PR, skipping update');
  });

  it('removes every configured deploy label while preserving unrelated labels', async () => {
    const { service, getLabels } = createService();

    await service.processLabelQueue(
      job({ action: 'disable', labels: ['deploy', 'keep', 'deploy-stg', 'also-keep'] }) as any
    );

    expect(getLabels).toHaveBeenCalledTimes(1);
    expect(mockUpdatePullRequestLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['keep', 'also-keep'] })
    );
    expect(mockLogger.info).toHaveBeenCalledWith('Label: removed label=deploy');
  });

  it('leaves labels unchanged when no deploy labels are configured', async () => {
    const { service } = createService({ labelsConfig: { deploy: undefined } as any });

    await service.processLabelQueue(job({ action: 'disable', labels: ['keep'] }) as any);

    expect(mockUpdatePullRequestLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['keep'] }));
  });

  it('waits for a Mission Control comment before updating labels when requested', async () => {
    const pullRequest = pullRequestRecord({ commentId: null });
    const { service } = createService({ pullRequest });

    await service.processLabelQueue(job({ waitForComment: true }) as any);

    expect(mockWaitForColumnValue).toHaveBeenCalledWith(pullRequest, 'commentId', 60, 5000);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestLabels).toHaveBeenCalledTimes(1);
  });

  it('continues the label update but records a timeout when the comment never appears', async () => {
    const pullRequest = pullRequestRecord({ commentId: null });
    mockWaitForColumnValue.mockResolvedValue(null);
    const { service } = createService({ pullRequest });

    await service.processLabelQueue(job({ waitForComment: true }) as any);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Timeout waiting for comment_id while updating labels after 5 minutes'
    );
    expect(mockUpdatePullRequestLabels).toHaveBeenCalledTimes(1);
  });

  it('does not wait when the comment is already persisted', async () => {
    const { service } = createService();

    await service.processLabelQueue(job({ waitForComment: true }) as any);

    expect(mockWaitForColumnValue).not.toHaveBeenCalled();
  });

  it('rejects a job whose pull request no longer exists', async () => {
    const { service } = createService({ pullRequest: null as any });

    await expect(service.processLabelQueue(job() as any)).rejects.toThrow('Pull request with id 8 not found');
    expect(mockUpdatePullRequestLabels).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Object), 'Failed to process label job for PR 8');
  });

  it('rejects a pull request without its repository and marks the build context unknown', async () => {
    const { service } = createService({ pullRequest: pullRequestRecord({ repository: null, build: null }) });

    await expect(service.processLabelQueue(job() as any)).rejects.toThrow('Repository not found for pull request 8');
    expect(mockUpdateLogContext).toHaveBeenCalledWith({ buildUuid: 'unknown' });
  });

  it('propagates GitHub update failures after recording the failed job', async () => {
    const failure = new Error('github unavailable');
    mockUpdatePullRequestLabels.mockRejectedValue(failure);
    const { service } = createService();

    await expect(service.processLabelQueue(job() as any)).rejects.toBe(failure);
    expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'Failed to process label job for PR 8');
  });
});
