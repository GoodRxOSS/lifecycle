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

jest.mock('server/services/agent/LifecycleAiSdkHarness', () => ({
  __esModule: true,
  default: {
    executeRun: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunService', () => ({
  __esModule: true,
  default: {
    claimQueuedRunForExecution: jest.fn(),
    getRunByUuid: jest.fn(),
    isTerminalStatus: jest.fn(),
    markFailedForExecutionOwner: jest.fn(),
    markWaitingForInputForRecovery: jest.fn(),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
  })),
}));

jest.mock('server/lib/logger/context', () => ({
  withLogContext: jest.fn((_context, fn) => fn()),
}));

jest.mock('server/lib/encryption', () => ({
  decrypt: jest.fn((value: string) => `decrypted:${value}`),
}));

import LifecycleAiSdkHarness from 'server/services/agent/LifecycleAiSdkHarness';
import AgentRunService from 'server/services/agent/RunService';
import { AgentRunOwnershipLostError } from 'server/services/agent/AgentRunOwnershipLostError';
import { AgentRunTerminalFailure } from 'server/services/agent/errors';
import { processAgentRunExecute } from '../agentRunExecute';

const mockClaimQueuedRunForExecution = AgentRunService.claimQueuedRunForExecution as jest.Mock;
const mockGetRunByUuid = AgentRunService.getRunByUuid as jest.Mock;
const mockExecuteRun = LifecycleAiSdkHarness.executeRun as jest.Mock;
const mockIsTerminalStatus = AgentRunService.isTerminalStatus as jest.Mock;
const mockMarkFailedForExecutionOwner = AgentRunService.markFailedForExecutionOwner as jest.Mock;
const mockMarkWaitingForInputForRecovery = AgentRunService.markWaitingForInputForRecovery as jest.Mock;

describe('agentRunExecute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips duplicate jobs once the run is no longer queued', async () => {
    mockClaimQueuedRunForExecution.mockResolvedValue(null);

    await processAgentRunExecute({
      data: {
        runId: 'run-1',
        dispatchAttemptId: 'attempt-1',
        reason: 'submit',
      },
    } as any);

    expect(mockClaimQueuedRunForExecution).toHaveBeenCalledWith('run-1', expect.stringMatching(/^bull:unknown:/));
    expect(mockExecuteRun).not.toHaveBeenCalled();
    expect(mockMarkFailedForExecutionOwner).not.toHaveBeenCalled();
  });

  it('rejects jobs missing a dispatch attempt id before claiming the run', async () => {
    await expect(
      processAgentRunExecute({
        data: {
          runId: 'run-1',
          reason: 'submit',
        },
      } as any)
    ).rejects.toThrow('Invalid agent run execute job payload: dispatchAttemptId is required');

    expect(mockClaimQueuedRunForExecution).not.toHaveBeenCalled();
    expect(mockExecuteRun).not.toHaveBeenCalled();
  });

  it('decrypts the queued GitHub token before executing the run', async () => {
    const run = { uuid: 'run-1', status: 'starting' };
    mockClaimQueuedRunForExecution.mockResolvedValue(run);
    mockExecuteRun.mockResolvedValue({ run });

    await processAgentRunExecute({
      data: {
        runId: 'run-1',
        dispatchAttemptId: 'attempt-1',
        reason: 'submit',
        encryptedGithubToken: 'encrypted-token',
        githubTokenSource: 'user',
        githubUsername: 'sample-github-user',
        githubTokenWriteAuthorized: true,
      },
    } as any);

    expect(mockExecuteRun).toHaveBeenCalledWith(run, {
      requestGitHubToken: 'decrypted:encrypted-token',
      requestGitHubAuth: {
        githubToken: 'decrypted:encrypted-token',
        source: 'user',
        githubUsername: 'sample-github-user',
        writeAuthorized: true,
      },
      dispatchAttemptId: 'attempt-1',
    });
  });

  it('treats legacy encrypted-token jobs without source metadata as read-only none-source auth', async () => {
    const run = { uuid: 'run-1', status: 'starting' };
    mockClaimQueuedRunForExecution.mockResolvedValue(run);
    mockExecuteRun.mockResolvedValue({ run });

    await processAgentRunExecute({
      data: {
        runId: 'run-1',
        dispatchAttemptId: 'attempt-1',
        reason: 'submit',
        encryptedGithubToken: 'encrypted-token',
      },
    } as any);

    expect(mockExecuteRun).toHaveBeenCalledWith(run, {
      requestGitHubToken: 'decrypted:encrypted-token',
      requestGitHubAuth: {
        githubToken: 'decrypted:encrypted-token',
        source: 'none',
        githubUsername: null,
        writeAuthorized: false,
      },
      dispatchAttemptId: 'attempt-1',
    });
  });

  it('marks a queued run failed when harness setup throws before terminal status is recorded', async () => {
    const run = { uuid: 'run-1', status: 'starting' };
    mockClaimQueuedRunForExecution.mockResolvedValue(run);
    mockGetRunByUuid.mockResolvedValue(run);
    mockExecuteRun.mockRejectedValue(new Error('setup failed'));
    mockIsTerminalStatus.mockReturnValue(false);
    mockMarkFailedForExecutionOwner.mockResolvedValue(undefined);

    await expect(
      processAgentRunExecute({
        data: {
          runId: 'run-1',
          dispatchAttemptId: 'attempt-1',
          reason: 'submit',
        },
      } as any)
    ).rejects.toThrow('setup failed');

    expect(mockMarkFailedForExecutionOwner).toHaveBeenCalledWith(
      'run-1',
      expect.stringMatching(/^bull:unknown:/),
      expect.objectContaining({ message: 'setup failed' }),
      undefined,
      { dispatchAttemptId: 'attempt-1' }
    );
  });

  it('pauses resume jobs when saved UI message validation fails', async () => {
    const run = {
      uuid: 'run-1',
      status: 'starting',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    mockClaimQueuedRunForExecution.mockResolvedValue(run);
    mockExecuteRun.mockRejectedValue(
      new AgentRunTerminalFailure({
        code: 'run_resume_state_invalid',
        message: 'Saved state is invalid.',
        details: {
          reason: 'ui_message_validation',
        },
      })
    );
    mockMarkWaitingForInputForRecovery.mockResolvedValue({
      ...run,
      status: 'waiting_for_input',
    });

    await expect(
      processAgentRunExecute({
        data: {
          runId: 'run-1',
          dispatchAttemptId: 'attempt-1',
          reason: 'resume',
        },
      } as any)
    ).resolves.toBeUndefined();

    expect(mockMarkWaitingForInputForRecovery).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'saved_state_invalid',
        previousOwner: expect.stringMatching(/^bull:unknown:/),
      }),
      expect.objectContaining({
        expectedExecutionOwner: expect.stringMatching(/^bull:unknown:/),
        allowActiveLease: true,
        errorCode: 'run_resume_state_invalid',
        message: 'Saved state is invalid.',
        dispatchAttemptId: 'attempt-1',
        detail: {
          reason: 'ui_message_validation',
        },
      })
    );
    expect(mockMarkFailedForExecutionOwner).not.toHaveBeenCalled();
  });

  it('keeps submit jobs on the normal failure path when saved UI message validation fails', async () => {
    const run = { uuid: 'run-1', status: 'starting' };
    mockClaimQueuedRunForExecution.mockResolvedValue(run);
    mockGetRunByUuid.mockResolvedValue(run);
    mockExecuteRun.mockRejectedValue(
      new AgentRunTerminalFailure({
        code: 'run_resume_state_invalid',
        message: 'Saved state is invalid.',
      })
    );
    mockIsTerminalStatus.mockReturnValue(false);
    mockMarkFailedForExecutionOwner.mockResolvedValue(undefined);

    await expect(
      processAgentRunExecute({
        data: {
          runId: 'run-1',
          dispatchAttemptId: 'attempt-1',
          reason: 'submit',
        },
      } as any)
    ).rejects.toThrow('Saved state is invalid.');

    expect(mockMarkWaitingForInputForRecovery).not.toHaveBeenCalled();
    expect(mockMarkFailedForExecutionOwner).toHaveBeenCalled();
  });

  it('does not overwrite a run failure already recorded by the executor', async () => {
    const run = { uuid: 'run-1', status: 'starting' };
    const failedRun = { uuid: 'run-1', status: 'failed' };
    mockClaimQueuedRunForExecution.mockResolvedValue(run);
    mockGetRunByUuid.mockResolvedValue(failedRun);
    mockExecuteRun.mockRejectedValue(new Error('setup failed'));
    mockIsTerminalStatus.mockReturnValue(true);

    await expect(
      processAgentRunExecute({
        data: {
          runId: 'run-1',
          dispatchAttemptId: 'attempt-1',
          reason: 'submit',
        },
      } as any)
    ).rejects.toThrow('setup failed');

    expect(mockMarkFailedForExecutionOwner).not.toHaveBeenCalled();
  });

  it('treats ownership loss from execution as a clean stale-worker exit', async () => {
    const run = { uuid: 'run-1', status: 'starting' };
    mockClaimQueuedRunForExecution.mockResolvedValue(run);
    mockExecuteRun.mockRejectedValue(
      new AgentRunOwnershipLostError({
        runUuid: 'run-1',
        expectedExecutionOwner: 'worker-1',
        currentStatus: 'running',
        currentExecutionOwner: 'worker-2',
      })
    );

    await expect(
      processAgentRunExecute({
        data: {
          runId: 'run-1',
          dispatchAttemptId: 'attempt-1',
          reason: 'resume',
        },
      } as any)
    ).resolves.toBeUndefined();

    expect(mockMarkFailedForExecutionOwner).not.toHaveBeenCalled();
  });
});
