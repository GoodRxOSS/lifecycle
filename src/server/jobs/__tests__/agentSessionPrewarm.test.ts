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

import type { Job } from 'bullmq';
import AgentPrewarmService, { type AgentPrewarmQueueJob } from 'server/services/agentPrewarm';

const mockPrepareBuildPrewarm = jest.fn();
const mockError = jest.fn();

jest.mock('server/services/agentPrewarm', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    prepareBuildPrewarm: mockPrepareBuildPrewarm,
  })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ error: mockError })),
}));

import { processAgentSessionPrewarm } from '../agentSessionPrewarm';

function buildJob(buildUuid: string): Job<AgentPrewarmQueueJob> {
  return { data: { buildUuid } } as Job<AgentPrewarmQueueJob>;
}

describe('processAgentSessionPrewarm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates the queued build to the prewarm service without logging an error', async () => {
    mockPrepareBuildPrewarm.mockResolvedValue(undefined);

    await expect(processAgentSessionPrewarm(buildJob('build-success'))).resolves.toBeUndefined();

    expect(AgentPrewarmService).toHaveBeenCalledTimes(1);
    expect(mockPrepareBuildPrewarm).toHaveBeenCalledWith('build-success');
    expect(mockError).not.toHaveBeenCalled();
  });

  it('logs provider failure context and rethrows the original error', async () => {
    const failure = new Error('workspace provider unavailable');
    mockPrepareBuildPrewarm.mockRejectedValue(failure);

    await expect(processAgentSessionPrewarm(buildJob('build-failed'))).rejects.toBe(failure);

    expect(mockPrepareBuildPrewarm).toHaveBeenCalledWith('build-failed');
    expect(mockError).toHaveBeenCalledWith(
      { error: failure, buildUuid: 'build-failed' },
      'Prewarm: job failed buildUuid=build-failed'
    );
  });
});
