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

jest.mock('server/services/agent/RunService', () => ({
  __esModule: true,
  default: {
    listRunsNeedingDispatch: jest.fn(),
    markWaitingForInputForRecovery: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunResumeEligibilityService', () => ({
  __esModule: true,
  default: {
    evaluateRun: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunQueueService', () => ({
  __esModule: true,
  default: {
    enqueueRun: jest.fn(),
  },
}));

jest.mock('server/lib/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
  };

  return {
    getLogger: jest.fn(() => logger),
  };
});

import AgentRunService from 'server/services/agent/RunService';
import AgentRunQueueService from 'server/services/agent/RunQueueService';
import AgentRunResumeEligibilityService from 'server/services/agent/RunResumeEligibilityService';
import { getLogger } from 'server/lib/logger';
import { processAgentRunDispatchRecovery } from '../agentRunDispatchRecovery';

const mockListRunsNeedingDispatch = AgentRunService.listRunsNeedingDispatch as jest.Mock;
const mockMarkWaitingForInputForRecovery = AgentRunService.markWaitingForInputForRecovery as jest.Mock;
const mockEnqueueRun = AgentRunQueueService.enqueueRun as jest.Mock;
const mockEvaluateRun = AgentRunResumeEligibilityService.evaluateRun as jest.Mock;
const mockLogger = getLogger() as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
};

describe('agentRunDispatchRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEvaluateRun.mockImplementation(async (run) => ({
      decision: 'auto_resume_allowed',
      reason: 'queued_dispatch_retry',
      previousStatus: run.status || 'queued',
      previousOwner: run.executionOwner || null,
      leaseExpiresAt: run.leaseExpiresAt || null,
      evaluatedAt: '2026-05-08T12:00:00.000Z',
    }));
  });

  it('re-enqueues stale queued and expired-lease runs', async () => {
    mockListRunsNeedingDispatch.mockResolvedValue([{ uuid: 'run-1' }, { uuid: 'run-2' }]);
    mockEnqueueRun
      .mockResolvedValueOnce({ dispatchAttemptId: 'attempt-1' })
      .mockResolvedValueOnce({ dispatchAttemptId: 'attempt-2' });

    const result = await processAgentRunDispatchRecovery();

    expect(mockListRunsNeedingDispatch).toHaveBeenCalledTimes(1);
    expect(mockEnqueueRun).toHaveBeenNthCalledWith(1, 'run-1', 'resume');
    expect(mockEnqueueRun).toHaveBeenNthCalledWith(2, 'run-2', 'resume');
    expect(result).toEqual({
      runs: 2,
      enqueued: [
        { runId: 'run-1', dispatchAttemptId: 'attempt-1' },
        { runId: 'run-2', dispatchAttemptId: 'attempt-2' },
      ],
      skipped: [],
      paused: [],
      failed: [],
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', dispatchAttemptId: 'attempt-1' }),
      expect.stringContaining('AgentExec: recovery enqueued runId=run-1 reason=resume')
    );
  });

  it('pauses manual recovery runs instead of enqueueing them', async () => {
    const run = {
      uuid: 'run-1',
      status: 'running',
      executionOwner: 'worker-1',
      leaseExpiresAt: '2026-05-08T11:59:00.000Z',
    };
    const eligibility = {
      decision: 'manual_recovery_required',
      reason: 'write_capability',
      previousStatus: 'running',
      previousOwner: 'worker-1',
      leaseExpiresAt: '2026-05-08T11:59:00.000Z',
      evaluatedAt: '2026-05-08T12:00:00.000Z',
    };
    mockListRunsNeedingDispatch.mockResolvedValue([run]);
    mockEvaluateRun.mockResolvedValue(eligibility);
    mockMarkWaitingForInputForRecovery.mockResolvedValue({ ...run, status: 'waiting_for_input' });

    const result = await processAgentRunDispatchRecovery();

    expect(mockEnqueueRun).not.toHaveBeenCalled();
    expect(mockMarkWaitingForInputForRecovery).toHaveBeenCalledWith(
      'run-1',
      eligibility,
      expect.objectContaining({
        expectedExecutionOwner: 'worker-1',
        resumeAttemptId: expect.any(String),
      })
    );
    expect(result).toEqual({
      runs: 1,
      enqueued: [],
      skipped: [],
      paused: [{ runId: 'run-1', reason: 'write_capability' }],
      failed: [],
    });
  });

  it('skips replay-only runs without enqueueing or pausing', async () => {
    mockListRunsNeedingDispatch.mockResolvedValue([{ uuid: 'run-1' }]);
    mockEvaluateRun.mockResolvedValue({
      decision: 'replay_only',
      reason: 'lease_active',
      previousStatus: 'running',
      previousOwner: 'worker-1',
      leaseExpiresAt: '2026-05-08T12:01:00.000Z',
      evaluatedAt: '2026-05-08T12:00:00.000Z',
    });

    const result = await processAgentRunDispatchRecovery();

    expect(mockEnqueueRun).not.toHaveBeenCalled();
    expect(mockMarkWaitingForInputForRecovery).not.toHaveBeenCalled();
    expect(result).toEqual({
      runs: 1,
      enqueued: [],
      skipped: [{ runId: 'run-1', decision: 'replay_only', reason: 'lease_active' }],
      paused: [],
      failed: [],
    });
  });

  it('continues re-enqueueing remaining runs after one enqueue fails', async () => {
    mockListRunsNeedingDispatch.mockResolvedValue([{ uuid: 'run-1' }, { uuid: 'run-2' }]);
    mockEnqueueRun
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValueOnce({ dispatchAttemptId: 'attempt-2' });

    const result = await processAgentRunDispatchRecovery();

    expect(mockEnqueueRun).toHaveBeenNthCalledWith(1, 'run-1', 'resume');
    expect(mockEnqueueRun).toHaveBeenNthCalledWith(2, 'run-2', 'resume');
    expect(result).toEqual({
      runs: 2,
      enqueued: [{ runId: 'run-2', dispatchAttemptId: 'attempt-2' }],
      skipped: [],
      paused: [],
      failed: [{ runId: 'run-1' }],
    });
  });
});
