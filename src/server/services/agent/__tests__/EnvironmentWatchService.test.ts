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

jest.mock('server/lib/queueManager', () => {
  const mockState = {
    queue: {
      add: jest.fn(),
    },
  };
  (global as any).__envWatchQueueState = mockState;
  const manager = {
    registerQueue: jest.fn(() => mockState.queue),
  };
  return {
    __esModule: true,
    default: {
      getInstance: jest.fn(() => manager),
    },
  };
});

jest.mock('server/lib/redisClient', () => {
  const redis = {
    set: jest.fn(),
    del: jest.fn(),
    duplicate: jest.fn(),
  };
  (global as any).__envWatchRedisState = redis;
  return {
    __esModule: true,
    default: {
      getInstance: jest.fn(() => ({
        getConnection: jest.fn(() => redis),
      })),
    },
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  })),
  extractContextForQueue: jest.fn(() => ({ correlationId: 'corr-1' })),
}));

jest.mock('server/models/Build');
jest.mock('server/models/AgentSession');
jest.mock('server/models/AgentThread');

jest.mock('../EnvironmentStateService', () => ({
  __esModule: true,
  default: {
    postWatchStateEvent: jest.fn(),
  },
}));

import Build from 'server/models/Build';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import { BuildStatus } from 'shared/constants';
import EnvironmentStateService from '../EnvironmentStateService';
import EnvironmentWatchService, {
  buildEnvironmentWatchHeadline,
  classifyEnvironmentWatchOutcome,
  environmentWatchDedupeKey,
  type AgentEnvironmentWatchJob,
} from '../EnvironmentWatchService';

const queueState = (global as any).__envWatchQueueState as { queue: { add: jest.Mock } };
const redis = (global as any).__envWatchRedisState as { set: jest.Mock; del: jest.Mock };
const mockQueueAdd = queueState.queue.add;
const mockPostStateEvent = EnvironmentStateService.postWatchStateEvent as jest.Mock;

function mockBuildLoad(build: unknown) {
  (Build.query as jest.Mock).mockReturnValue({
    findOne: jest.fn().mockReturnValue({
      withGraphFetched: jest.fn().mockResolvedValue(build),
    }),
  });
}

function watchJob(overrides: Partial<AgentEnvironmentWatchJob> = {}) {
  const data: AgentEnvironmentWatchJob = {
    watchId: 'watch-1',
    buildUuid: 'build-1',
    threadUuid: 'thread-1',
    sessionUuid: 'sess-1',
    reason: 'repair_commit',
    baselineStatus: null,
    baselineFingerprint: null,
    sawActivity: false,
    pollCount: 0,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
  return { id: `env-watch:${data.watchId}:${data.pollCount}`, data } as any;
}

describe('classifyEnvironmentWatchOutcome', () => {
  it('keeps polling while the build is in progress', () => {
    expect(classifyEnvironmentWatchOutcome({ status: BuildStatus.BUILDING, sawActivity: true })).toBe('pending');
  });

  it('reports success on deployed after rebuild activity', () => {
    expect(classifyEnvironmentWatchOutcome({ status: BuildStatus.DEPLOYED, sawActivity: true })).toBe('success');
  });

  it('reports failure on terminal error after rebuild activity', () => {
    expect(classifyEnvironmentWatchOutcome({ status: BuildStatus.ERROR, sawActivity: true })).toBe('failure');
    expect(classifyEnvironmentWatchOutcome({ status: BuildStatus.CONFIG_ERROR, sawActivity: true })).toBe('failure');
  });

  it('withholds a terminal status until activity was observed', () => {
    expect(classifyEnvironmentWatchOutcome({ status: BuildStatus.DEPLOYED, sawActivity: false })).toBe('pending');
    expect(classifyEnvironmentWatchOutcome({ status: BuildStatus.ERROR, sawActivity: false })).toBe('pending');
  });

  it('reports the current terminal status when the deadline forces a verdict', () => {
    expect(
      classifyEnvironmentWatchOutcome({ status: BuildStatus.DEPLOYED, sawActivity: false, forceTerminal: true })
    ).toBe('success');
    expect(
      classifyEnvironmentWatchOutcome({ status: BuildStatus.CONFIG_ERROR, sawActivity: false, forceTerminal: true })
    ).toBe('failure');
  });
});

describe('buildEnvironmentWatchHeadline', () => {
  it('names the trigger and the outcome', () => {
    expect(buildEnvironmentWatchHeadline('started', 'repair_commit')).toBe('Rebuild started after the repair commit.');
    expect(buildEnvironmentWatchHeadline('success', 'repair_commit')).toBe(
      'Rebuild after the repair commit finished: environment deployed.'
    );
    expect(buildEnvironmentWatchHeadline('failure', 'trigger_redeploy')).toBe(
      'Rebuild after the redeploy trigger finished with a failure.'
    );
    expect(buildEnvironmentWatchHeadline('timeout', 'repair_commit')).toBe(
      'Rebuild after the repair commit has not reached a terminal state after 30 minutes.'
    );
  });
});

describe('scheduleEnvironmentWatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
  });

  it('schedules a delayed watch job with a deterministic dedupe marker', async () => {
    const result = await EnvironmentWatchService.scheduleEnvironmentWatch({
      buildUuid: 'build-1',
      threadUuid: 'thread-1',
      sessionUuid: 'sess-1',
      reason: 'repair_commit',
      commitUrl: 'https://github.com/example-org/example-repo/commit/0123456789abcdef0123456789abcdef01234567',
    });

    expect(result).toEqual({ scheduled: true, threadUuid: 'thread-1' });
    expect(redis.set).toHaveBeenCalledWith('env-watch:build-1:thread-1', expect.any(String), 'EX', 35 * 60, 'NX');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [jobName, payload, opts] = mockQueueAdd.mock.calls[0];
    expect(jobName).toBe('environment-watch');
    expect(payload).toMatchObject({
      buildUuid: 'build-1',
      threadUuid: 'thread-1',
      sessionUuid: 'sess-1',
      reason: 'repair_commit',
      pollCount: 0,
      sawActivity: false,
      commitUrl: 'https://github.com/example-org/example-repo/commit/0123456789abcdef0123456789abcdef01234567',
      correlationId: 'corr-1',
    });
    expect(payload.watchId).toEqual(expect.any(String));
    expect(opts).toEqual({ jobId: `env-watch:${payload.watchId}:0`, delay: 15_000 });
  });

  it('keeps the watch buildUuid when ambient queue context carries its own (possibly empty) buildUuid', async () => {
    const { extractContextForQueue } = jest.requireMock('server/lib/logger');
    extractContextForQueue.mockReturnValueOnce({ correlationId: 'corr-1', buildUuid: undefined });

    await EnvironmentWatchService.scheduleEnvironmentWatch({
      buildUuid: 'build-1',
      threadUuid: 'thread-1',
      reason: 'trigger_redeploy',
    });

    expect(mockQueueAdd.mock.calls[0][1].buildUuid).toBe('build-1');
  });

  it('skips scheduling when a watch is already active for the build and thread', async () => {
    redis.set.mockResolvedValue(null);

    const result = await EnvironmentWatchService.scheduleEnvironmentWatch({
      buildUuid: 'build-1',
      threadUuid: 'thread-1',
      reason: 'trigger_redeploy',
    });

    expect(result).toEqual({ scheduled: false, reason: 'duplicate', threadUuid: 'thread-1' });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('resolves the thread from the most recent session when only the build is known', async () => {
    (AgentSession.query as jest.Mock).mockReturnValue({
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 7, uuid: 'sess-7', defaultThreadId: 42 }),
    });
    (AgentThread.query as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue({ id: 42, uuid: 'thread-42' }),
    });

    const result = await EnvironmentWatchService.scheduleEnvironmentWatch({
      buildUuid: 'build-1',
      reason: 'trigger_redeploy',
      baselineStatus: 'error',
    });

    expect(result).toEqual({ scheduled: true, threadUuid: 'thread-42' });
    expect(redis.set).toHaveBeenCalledWith('env-watch:build-1:thread-42', expect.any(String), 'EX', 35 * 60, 'NX');
    expect(mockQueueAdd.mock.calls[0][1]).toMatchObject({
      threadUuid: 'thread-42',
      sessionUuid: 'sess-7',
      baselineStatus: 'error',
    });
  });

  it('returns unscheduled when no session exists for the build', async () => {
    (AgentSession.query as jest.Mock).mockReturnValue({
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(undefined),
    });

    const result = await EnvironmentWatchService.scheduleEnvironmentWatch({
      buildUuid: 'build-1',
      reason: 'trigger_redeploy',
    });

    expect(result).toEqual({ scheduled: false, reason: 'thread_unresolved' });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('never throws when redis is unavailable', async () => {
    redis.set.mockRejectedValue(new Error('redis down'));

    const result = await EnvironmentWatchService.scheduleEnvironmentWatch({
      buildUuid: 'build-1',
      threadUuid: 'thread-1',
      reason: 'repair_commit',
    });

    expect(result).toEqual({ scheduled: false, reason: 'error' });
  });
});

describe('processWatchJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    (AgentThread.query as jest.Mock).mockReturnValue({
      findOne: jest.fn().mockResolvedValue({ id: 5, uuid: 'thread-1', sessionId: 9 }),
    });
    (AgentSession.query as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue({ id: 9, uuid: 'sess-1', namespace: 'env-1', buildUuid: 'build-1' }),
    });
    mockPostStateEvent.mockResolvedValue(undefined);
  });

  it('stops silently and releases the marker when the build was deleted', async () => {
    mockBuildLoad(null);

    await EnvironmentWatchService.processWatchJob(watchJob());

    expect(redis.del).toHaveBeenCalledWith(environmentWatchDedupeKey('build-1', 'thread-1'));
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPostStateEvent).not.toHaveBeenCalled();
  });

  it('posts a rebuild-started state event once and keeps polling while in progress', async () => {
    mockBuildLoad({ status: BuildStatus.BUILDING, statusMessage: null, updatedAt: 't1', deploys: [] });

    await EnvironmentWatchService.processWatchJob(watchJob());

    expect(mockPostStateEvent).toHaveBeenCalledTimes(1);
    expect(mockPostStateEvent.mock.calls[0][0]).toMatchObject({
      uuidSeed: 'watch-1:activity',
      headline: 'Rebuild started after the repair commit.',
      includeTriage: false,
    });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, payload, opts] = mockQueueAdd.mock.calls[0];
    expect(payload).toMatchObject({ pollCount: 1, sawActivity: true, activityEventPosted: true });
    expect(payload.baselineFingerprint).toEqual(expect.any(String));
    expect(opts).toEqual({ jobId: 'env-watch:watch-1:1', delay: 15_000 });
  });

  it('does not repost the rebuild-started event on later polls', async () => {
    mockBuildLoad({ status: BuildStatus.BUILDING, statusMessage: null, updatedAt: 't1', deploys: [] });

    await EnvironmentWatchService.processWatchJob(
      watchJob({ sawActivity: true, activityEventPosted: true, pollCount: 2 })
    );

    expect(mockPostStateEvent).not.toHaveBeenCalled();
    expect(mockQueueAdd.mock.calls[0][1]).toMatchObject({ pollCount: 3, activityEventPosted: true });
  });

  it('does not report a terminal status equal to the baseline before any activity', async () => {
    mockBuildLoad({ status: BuildStatus.ERROR, statusMessage: 'old failure', updatedAt: 't1', deploys: [] });

    await EnvironmentWatchService.processWatchJob(watchJob({ baselineStatus: BuildStatus.ERROR }));

    expect(mockPostStateEvent).not.toHaveBeenCalled();
    expect(mockQueueAdd.mock.calls[0][1]).toMatchObject({ pollCount: 1, sawActivity: false });
  });

  it('posts a success state event and releases the marker once deployed', async () => {
    mockBuildLoad({ status: BuildStatus.DEPLOYED, statusMessage: null, updatedAt: 't2', deploys: [] });

    await EnvironmentWatchService.processWatchJob(
      watchJob({ sawActivity: true, activityEventPosted: true, pollCount: 3, commitUrl: 'https://example.test/c' })
    );

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPostStateEvent).toHaveBeenCalledTimes(1);
    const call = mockPostStateEvent.mock.calls[0][0];
    expect(call).toMatchObject({
      uuidSeed: 'watch-1:final',
      headline: 'Rebuild after the repair commit finished: environment deployed.',
      includeTriage: false,
      commitUrl: 'https://example.test/c',
    });
    expect(call.session).toMatchObject({ id: 9 });
    expect(call.thread).toMatchObject({ id: 5 });
    expect(redis.del).toHaveBeenCalledWith('env-watch:build-1:thread-1');
  });

  it('posts a failure state event with fresh triage', async () => {
    mockBuildLoad({ status: BuildStatus.ERROR, statusMessage: 'Deployment failed', updatedAt: 't2', deploys: [] });

    await EnvironmentWatchService.processWatchJob(watchJob({ sawActivity: true, activityEventPosted: true }));

    expect(mockPostStateEvent).toHaveBeenCalledTimes(1);
    expect(mockPostStateEvent.mock.calls[0][0]).toMatchObject({
      uuidSeed: 'watch-1:final',
      headline: 'Rebuild after the repair commit finished with a failure.',
      includeTriage: true,
    });
  });

  it('reports a timeout when the deadline passes without a terminal status', async () => {
    mockBuildLoad({ status: BuildStatus.BUILDING, statusMessage: null, updatedAt: 't3', deploys: [] });

    await EnvironmentWatchService.processWatchJob(
      watchJob({ deadlineAt: new Date(Date.now() - 1000).toISOString(), pollCount: 9 })
    );

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPostStateEvent.mock.calls[0][0]).toMatchObject({
      uuidSeed: 'watch-1:final',
      headline: 'Rebuild after the repair commit has not reached a terminal state after 30 minutes.',
      includeTriage: false,
    });
    expect(redis.del).toHaveBeenCalled();
  });

  it('reports the gated terminal outcome instead of a timeout when the deadline forces a verdict', async () => {
    mockBuildLoad({ status: BuildStatus.ERROR, statusMessage: 'still broken', updatedAt: 't1', deploys: [] });

    await EnvironmentWatchService.processWatchJob(
      watchJob({ baselineStatus: BuildStatus.ERROR, deadlineAt: new Date(Date.now() - 1000).toISOString() })
    );

    expect(mockPostStateEvent.mock.calls[0][0]).toMatchObject({
      headline: 'Rebuild after the repair commit finished with a failure.',
      includeTriage: true,
    });
  });

  it('tolerates a deleted thread without throwing', async () => {
    mockBuildLoad({ status: BuildStatus.DEPLOYED, statusMessage: null, updatedAt: 't2', deploys: [] });
    (AgentThread.query as jest.Mock).mockReturnValue({
      findOne: jest.fn().mockResolvedValue(undefined),
    });

    await EnvironmentWatchService.processWatchJob(watchJob({ sawActivity: true }));

    expect(mockPostStateEvent).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalled();
  });

  it('re-enqueues after a transient polling error within budget', async () => {
    (Build.query as jest.Mock).mockImplementation(() => {
      throw new Error('db down');
    });

    await EnvironmentWatchService.processWatchJob(watchJob({ pollCount: 2 }));

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0][1]).toMatchObject({ pollCount: 3 });
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('gives up and releases the marker when an error occurs past the deadline', async () => {
    (Build.query as jest.Mock).mockImplementation(() => {
      throw new Error('db down');
    });

    await EnvironmentWatchService.processWatchJob(watchJob({ deadlineAt: new Date(Date.now() - 1000).toISOString() }));

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalled();
  });
});
