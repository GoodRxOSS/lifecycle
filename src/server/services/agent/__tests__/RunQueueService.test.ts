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
    registerCalls: [] as unknown[][],
  };
  (global as any).__runQueueServiceMockState = mockState;

  const queue = {
    add: mockState.queue.add,
  };
  const manager = {
    registerQueue: jest.fn((...args: unknown[]) => {
      mockState.registerCalls.push(args);
      return queue;
    }),
  };
  return {
    __esModule: true,
    default: {
      getInstance: jest.fn(() => manager),
    },
  };
});

jest.mock('server/lib/redisClient', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getConnection: jest.fn(() => ({
        duplicate: jest.fn(),
      })),
    })),
  },
}));

jest.mock('server/lib/encryption', () => ({
  encrypt: jest.fn((value: string) => `encrypted:${value}`),
}));

jest.mock('server/lib/logger', () => ({
  extractContextForQueue: jest.fn(() => ({
    correlationId: 'correlation-1',
    sender: 'sample-user',
  })),
}));

import { encrypt } from 'server/lib/encryption';
import { extractContextForQueue } from 'server/lib/logger';
import AgentRunQueueService from '../RunQueueService';

const mockState = (global as any).__runQueueServiceMockState as {
  queue: {
    add: jest.Mock;
  };
  registerCalls: unknown[][];
};
const mockQueueAdd = mockState.queue.add;
const mockEncrypt = encrypt as jest.Mock;
const mockExtractContextForQueue = extractContextForQueue as jest.Mock;

describe('AgentRunQueueService', () => {
  beforeEach(() => {
    mockQueueAdd.mockClear();
    mockEncrypt.mockClear();
    mockExtractContextForQueue.mockClear();
  });

  it('registers the execute queue with bounded failed-job retention', () => {
    expect(mockState.registerCalls).toEqual(
      expect.arrayContaining([
        [
          'agent_run_execute',
          expect.objectContaining({
            defaultJobOptions: expect.objectContaining({
              attempts: 1,
              removeOnComplete: true,
              removeOnFail: 100,
            }),
          }),
        ],
      ])
    );
  });

  it('enqueues a dispatch attempt id in the job payload and return value', async () => {
    mockQueueAdd.mockResolvedValue(undefined);

    const result = await AgentRunQueueService.enqueueRun('run-1', 'submit', {
      githubToken: ' token-1 ',
    });

    expect(result.dispatchAttemptId).toEqual(expect.any(String));
    expect(result.dispatchAttemptId).not.toHaveLength(0);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'execute-run',
      expect.objectContaining({
        runId: 'run-1',
        reason: 'submit',
        dispatchAttemptId: result.dispatchAttemptId,
        encryptedGithubToken: 'encrypted:token-1',
        correlationId: 'correlation-1',
        sender: 'sample-user',
      }),
      expect.objectContaining({
        jobId: `agent-run:run-1:${result.dispatchAttemptId}`,
      })
    );
  });

  it('uses a distinct BullMQ job id for each dispatch attempt and keeps reason out of the uniqueness boundary', async () => {
    mockQueueAdd.mockResolvedValue(undefined);

    const first = await AgentRunQueueService.enqueueRun('run-1', 'resume');
    const second = await AgentRunQueueService.enqueueRun('run-1', 'resume');

    const firstOptions = mockQueueAdd.mock.calls[0][2];
    const secondOptions = mockQueueAdd.mock.calls[1][2];

    expect(first.dispatchAttemptId).not.toEqual(second.dispatchAttemptId);
    expect(firstOptions.jobId).toBe(`agent-run:run-1:${first.dispatchAttemptId}`);
    expect(secondOptions.jobId).toBe(`agent-run:run-1:${second.dispatchAttemptId}`);
    expect(firstOptions.jobId).not.toEqual(secondOptions.jobId);
    expect(firstOptions.jobId).not.toContain(':resume');
    expect(secondOptions.jobId).not.toContain(':resume');
    expect(mockQueueAdd.mock.calls[0][1]).toEqual(expect.objectContaining({ reason: 'resume' }));
    expect(mockQueueAdd.mock.calls[1][1]).toEqual(expect.objectContaining({ reason: 'resume' }));
  });
});
