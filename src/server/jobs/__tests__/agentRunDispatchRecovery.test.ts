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
import { getLogger } from 'server/lib/logger';
import { processAgentRunDispatchRecovery } from '../agentRunDispatchRecovery';

const mockListRunsNeedingDispatch = AgentRunService.listRunsNeedingDispatch as jest.Mock;
const mockEnqueueRun = AgentRunQueueService.enqueueRun as jest.Mock;
const mockLogger = getLogger() as {
  info: jest.Mock;
  warn: jest.Mock;
};

describe('agentRunDispatchRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      failed: [],
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', dispatchAttemptId: 'attempt-1' }),
      'AgentExec: recovery enqueued runId=run-1 reason=resume dispatchAttemptId=attempt-1'
    );
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
      failed: [{ runId: 'run-1' }],
    });
  });
});
