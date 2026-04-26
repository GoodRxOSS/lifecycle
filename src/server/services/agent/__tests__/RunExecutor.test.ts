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

var mockToolLoopAgent: jest.Mock;
var mockStepCountIs: jest.Mock;

jest.mock('ai', () => ({
  __esModule: true,
  ToolLoopAgent: (mockToolLoopAgent = jest.fn().mockImplementation((config) => ({ config }))),
  stepCountIs: (mockStepCountIs = jest.fn(() => 'stop-condition')),
}));

const mockResolveSelection = jest.fn().mockResolvedValue({ provider: 'openai', modelId: 'gpt-5.4' });
const mockCreateLanguageModel = jest.fn().mockResolvedValue({ id: 'model-instance' });

jest.mock('server/services/agent/ProviderRegistry', () => ({
  __esModule: true,
  default: {
    resolveSelection: (...args: unknown[]) => mockResolveSelection(...args),
    createLanguageModel: (...args: unknown[]) => mockCreateLanguageModel(...args),
  },
}));

const mockResolveSessionContext = jest.fn().mockResolvedValue({
  repoFullName: 'example-org/example-repo',
  approvalPolicy: 'on-request',
  binding: null,
});
const mockBuildToolSet = jest.fn().mockResolvedValue({});

jest.mock('server/services/agent/CapabilityService', () => ({
  __esModule: true,
  default: {
    resolveSessionContext: (...args: unknown[]) => mockResolveSessionContext(...args),
    buildToolSet: (...args: unknown[]) => mockBuildToolSet(...args),
  },
}));

const mockCreateQueuedRun = jest.fn().mockResolvedValue({ id: 11, uuid: 'run-1', status: 'queued' });
const mockClaimQueuedRunForExecution = jest
  .fn()
  .mockResolvedValue({ id: 11, uuid: 'run-1', status: 'starting', executionOwner: 'worker-1' });
const mockRegisterAbortController = jest.fn();
const mockClearAbortController = jest.fn();
const mockPatchProgressForExecutionOwner = jest.fn().mockResolvedValue(undefined);
const mockHeartbeatRunExecution = jest.fn().mockResolvedValue(undefined);
const mockGetRunByUuid = jest.fn();
const mockMarkFailed = jest.fn();
const mockMarkFailedForExecutionOwner = jest.fn();
const mockStartRunForExecutionOwner = jest.fn();
let mockLastFinalizeResult: unknown;
const mockFinalizeRunForExecutionOwner = jest.fn(async (_runId, _owner, finalize) => {
  mockLastFinalizeResult = await finalize({
    run: { id: 11, uuid: 'run-1', status: 'running', executionOwner: 'worker-1' },
    trx: { trx: true },
  });
  return { id: 11, uuid: 'run-1', status: (mockLastFinalizeResult as { status: string }).status };
});

jest.mock('server/services/agent/RunService', () => ({
  __esModule: true,
  default: {
    createQueuedRun: (...args: unknown[]) => mockCreateQueuedRun(...args),
    claimQueuedRunForExecution: (...args: unknown[]) => mockClaimQueuedRunForExecution(...args),
    registerAbortController: (...args: unknown[]) => mockRegisterAbortController(...args),
    clearAbortController: (...args: unknown[]) => mockClearAbortController(...args),
    patchProgressForExecutionOwner: (...args: unknown[]) => mockPatchProgressForExecutionOwner(...args),
    heartbeatRunExecution: (...args: unknown[]) => mockHeartbeatRunExecution(...args),
    getRunByUuid: (...args: unknown[]) => mockGetRunByUuid(...args),
    markFailed: (...args: unknown[]) => mockMarkFailed(...args),
    markFailedForExecutionOwner: (...args: unknown[]) => mockMarkFailedForExecutionOwner(...args),
    startRunForExecutionOwner: (...args: unknown[]) => mockStartRunForExecutionOwner(...args),
    finalizeRunForExecutionOwner: (...args: unknown[]) => mockFinalizeRunForExecutionOwner(...args),
  },
}));

const mockGetSessionAppendSystemPrompt = jest.fn().mockResolvedValue('Append prompt');
const mockTouchActivity = jest.fn().mockResolvedValue(undefined);
const mockGetEffectiveSessionConfig = jest.fn().mockResolvedValue({
  systemPrompt: 'DB prompt as stored',
  appendSystemPrompt: undefined,
  maxIterations: 8,
  workspaceToolDiscoveryTimeoutMs: 3000,
  workspaceToolExecutionTimeoutMs: 15000,
  toolRules: [],
});

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    getSessionAppendSystemPrompt: (...args: unknown[]) => mockGetSessionAppendSystemPrompt(...args),
    touchActivity: (...args: unknown[]) => mockTouchActivity(...args),
    markSessionRuntimeFailure: jest.fn(),
  },
}));

jest.mock('server/services/agentSessionConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getEffectiveConfig: (...args: unknown[]) => mockGetEffectiveSessionConfig(...args),
    })),
  },
}));

jest.mock('server/services/agent/ApprovalService', () => ({
  __esModule: true,
  default: {
    syncApprovalRequestsFromMessages: jest.fn(),
    syncApprovalRequestStateFromMessages: jest.fn(),
  },
}));

const mockEnqueueRun = jest.fn();

jest.mock('server/services/agent/RunQueueService', () => ({
  __esModule: true,
  default: {
    enqueueRun: (...args: unknown[]) => mockEnqueueRun(...args),
  },
}));

jest.mock('server/services/agent/MessageStore', () => ({
  __esModule: true,
  default: {
    syncCanonicalMessagesFromUiMessages: jest.fn(),
    upsertCanonicalUiMessagesForThread: jest.fn(),
  },
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  const actual = jest.requireActual('server/lib/agentSession/runtimeConfig');
  return {
    __esModule: true,
    ...actual,
    resolveAgentSessionDurabilityConfig: jest.fn().mockResolvedValue({
      runExecutionLeaseMs: 30 * 60 * 1000,
      queuedRunDispatchStaleMs: 30 * 1000,
      dispatchRecoveryLimit: 50,
      maxDurablePayloadBytes: 64 * 1024,
      payloadPreviewBytes: 16 * 1024,
      fileChangePreviewChars: 4000,
    }),
  };
});

const mockToolExecutionInsert = jest.fn();
const mockToolExecutionFirst = jest.fn();
const mockToolExecutionPatchAndFetchById = jest.fn();

jest.mock('server/models/AgentToolExecution', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => {
      const query = {
        insert: mockToolExecutionInsert,
        where: jest.fn(() => query),
        orderBy: jest.fn(() => query),
        first: mockToolExecutionFirst,
        patchAndFetchById: mockToolExecutionPatchAndFetchById,
      };

      return query;
    }),
  },
}));

const mockPendingActionFirst = jest.fn();

jest.mock('server/models/AgentPendingAction', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => {
      const query = {
        where: jest.fn(() => query),
        whereRaw: jest.fn(() => query),
        orderBy: jest.fn(() => query),
        first: mockPendingActionFirst,
      };

      return query;
    }),
  },
}));

import AgentRunExecutor from 'server/services/agent/RunExecutor';
import ApprovalService from 'server/services/agent/ApprovalService';
import AgentMessageStore from 'server/services/agent/MessageStore';
import AgentSessionService from 'server/services/agentSession';
import { SessionWorkspaceGatewayUnavailableError } from 'server/services/agent/errors';

const mockSyncApprovalRequests = ApprovalService.syncApprovalRequestsFromMessages as jest.Mock;
const mockSyncApprovalRequestState = ApprovalService.syncApprovalRequestStateFromMessages as jest.Mock;
const mockSyncCanonicalMessagesFromUiMessages = AgentMessageStore.syncCanonicalMessagesFromUiMessages as jest.Mock;
const mockUpsertCanonicalUiMessagesForThread = AgentMessageStore.upsertCanonicalUiMessagesForThread as jest.Mock;
const mockMarkSessionRuntimeFailure = AgentSessionService.markSessionRuntimeFailure as jest.Mock;

describe('AgentRunExecutor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveSelection.mockResolvedValue({ provider: 'openai', modelId: 'gpt-5.4' });
    mockCreateLanguageModel.mockResolvedValue({ id: 'model-instance' });
    mockResolveSessionContext.mockResolvedValue({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: 'on-request',
      binding: null,
    });
    mockBuildToolSet.mockResolvedValue({});
    mockCreateQueuedRun.mockResolvedValue({ id: 11, uuid: 'run-1', status: 'queued' });
    mockClaimQueuedRunForExecution.mockResolvedValue({
      id: 11,
      uuid: 'run-1',
      status: 'starting',
      executionOwner: 'worker-1',
    });
    mockPatchProgressForExecutionOwner.mockResolvedValue(undefined);
    mockHeartbeatRunExecution.mockResolvedValue(undefined);
    mockGetRunByUuid.mockResolvedValue({ id: 11, uuid: 'run-1', status: 'running' });
    mockMarkFailed.mockResolvedValue(undefined);
    mockMarkFailedForExecutionOwner.mockResolvedValue(undefined);
    mockStartRunForExecutionOwner.mockImplementation(async (runId, owner) => ({
      id: 11,
      uuid: runId,
      status: 'running',
      executionOwner: owner,
    }));
    mockLastFinalizeResult = null;
    mockFinalizeRunForExecutionOwner.mockImplementation(async (_runId, _owner, finalize) => {
      mockLastFinalizeResult = await finalize({
        run: { id: 11, uuid: 'run-1', status: 'running', executionOwner: 'worker-1' },
        trx: { trx: true },
      });
      return { id: 11, uuid: 'run-1', status: (mockLastFinalizeResult as { status: string }).status };
    });
    mockGetSessionAppendSystemPrompt.mockResolvedValue('Append prompt');
    mockTouchActivity.mockResolvedValue(undefined);
    mockMarkSessionRuntimeFailure.mockResolvedValue(undefined);
    mockGetEffectiveSessionConfig.mockResolvedValue({
      systemPrompt: 'DB prompt as stored',
      appendSystemPrompt: undefined,
      maxIterations: 8,
      workspaceToolDiscoveryTimeoutMs: 3000,
      workspaceToolExecutionTimeoutMs: 15000,
      toolRules: [],
    });
    mockPendingActionFirst.mockResolvedValue(null);
    mockToolExecutionFirst.mockResolvedValue(undefined);
    mockSyncCanonicalMessagesFromUiMessages.mockImplementation(async (_threadId, _userId, messages) => messages);
    mockUpsertCanonicalUiMessagesForThread.mockResolvedValue(undefined);
    mockSyncApprovalRequests.mockResolvedValue([]);
    mockSyncApprovalRequestState.mockResolvedValue({
      pendingActions: [],
      resolvedActionCount: 0,
    });
    mockEnqueueRun.mockResolvedValue(undefined);
  });

  it('builds agent instructions from the control-plane and session prompts', async () => {
    await AgentRunExecutor.execute({
      session: { uuid: 'sess-1' } as any,
      thread: { id: 7, uuid: 'thread-1' } as any,
      userIdentity: { userId: 'sample-user' } as any,
      messages: [],
    });

    expect(mockToolLoopAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: 'DB prompt as stored\n\nAppend prompt',
      })
    );
    expect(mockStepCountIs).toHaveBeenCalledWith(8);
  });

  it('correlates tool execution audit rows by toolCallId and touches session activity on step progress', async () => {
    await AgentRunExecutor.execute({
      session: { uuid: 'sess-1' } as any,
      thread: { id: 7, uuid: 'thread-1' } as any,
      userIdentity: { userId: 'sample-user' } as any,
      messages: [],
    });

    const toolSetArgs = mockBuildToolSet.mock.calls[0]?.[0];
    expect(toolSetArgs?.hooks).toBeDefined();
    expect(toolSetArgs).toEqual(
      expect.objectContaining({
        workspaceToolDiscoveryTimeoutMs: 3000,
        workspaceToolExecutionTimeoutMs: 15000,
      })
    );

    mockPendingActionFirst.mockResolvedValue({
      id: 55,
      status: 'approved',
    });

    await toolSetArgs.hooks.onToolStarted({
      source: 'mcp',
      serverSlug: 'sandbox',
      toolName: 'workspace.read_file',
      toolCallId: 'tool-call-1',
      args: { path: 'sample-file.ts' },
      capabilityKey: 'read',
    });

    expect(mockToolExecutionInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tool-call-1',
        pendingActionId: 55,
        approved: true,
      })
    );

    mockToolExecutionFirst.mockResolvedValue({
      id: 99,
      startedAt: '2026-04-08T00:00:00.000Z',
    });

    await toolSetArgs.hooks.onToolFinished({
      source: 'mcp',
      serverSlug: 'sandbox',
      toolName: 'workspace.read_file',
      toolCallId: 'tool-call-1',
      args: { path: 'sample-file.ts' },
      capabilityKey: 'read',
      result: { ok: true },
      status: 'completed',
    });

    expect(mockToolExecutionPatchAndFetchById).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        status: 'completed',
        durationMs: expect.any(Number),
      })
    );

    const agentConfig = mockToolLoopAgent.mock.calls[0]?.[0];
    await agentConfig.onStepFinish({
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      stepNumber: 1,
      toolCalls: [],
    });

    expect(mockTouchActivity).toHaveBeenCalledWith('sess-1');
  });

  it('uses configured max iterations and workspace tool timeouts', async () => {
    mockGetEffectiveSessionConfig.mockResolvedValue({
      systemPrompt: 'DB prompt as stored',
      appendSystemPrompt: undefined,
      maxIterations: 14,
      workspaceToolDiscoveryTimeoutMs: 4500,
      workspaceToolExecutionTimeoutMs: 22000,
      toolRules: [],
    });

    await AgentRunExecutor.execute({
      session: { uuid: 'sess-1' } as any,
      thread: { id: 7, uuid: 'thread-1' } as any,
      userIdentity: { userId: 'sample-user' } as any,
      messages: [],
    });

    expect(mockStepCountIs).toHaveBeenCalledWith(14);
    expect(mockBuildToolSet).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceToolDiscoveryTimeoutMs: 4500,
        workspaceToolExecutionTimeoutMs: 22000,
      })
    );
  });

  it('does not create a run when tool setup fails before execution starts', async () => {
    mockBuildToolSet.mockRejectedValueOnce(new Error('tool setup failed'));

    await expect(
      AgentRunExecutor.execute({
        session: { uuid: 'sess-1' } as any,
        thread: { id: 7, uuid: 'thread-1' } as any,
        userIdentity: { userId: 'sample-user' } as any,
        messages: [],
      })
    ).rejects.toThrow('tool setup failed');

    expect(mockCreateQueuedRun).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('marks an existing queued run failed when setup fails before execution starts', async () => {
    mockBuildToolSet.mockRejectedValueOnce(new Error('tool setup failed'));

    await expect(
      AgentRunExecutor.execute({
        session: { uuid: 'sess-1' } as any,
        thread: { id: 7, uuid: 'thread-1' } as any,
        userIdentity: { userId: 'sample-user' } as any,
        messages: [],
        existingRun: { id: 11, uuid: 'queued-run-1', status: 'queued', executionOwner: 'worker-1' } as any,
      })
    ).rejects.toThrow('tool setup failed');

    expect(mockCreateQueuedRun).not.toHaveBeenCalled();
    expect(mockMarkFailedForExecutionOwner).toHaveBeenCalledWith(
      'queued-run-1',
      'worker-1',
      expect.objectContaining({ message: 'tool setup failed' }),
      expect.any(Object),
      { dispatchAttemptId: undefined }
    );
  });

  it('records a runtime session failure when the workspace gateway is unavailable', async () => {
    mockBuildToolSet.mockRejectedValueOnce(
      new SessionWorkspaceGatewayUnavailableError({
        sessionId: 'sess-1',
        cause: new Error('sandbox unavailable'),
      })
    );

    await expect(
      AgentRunExecutor.execute({
        session: { uuid: 'sess-1' } as any,
        thread: { id: 7, uuid: 'thread-1' } as any,
        userIdentity: { userId: 'sample-user' } as any,
        messages: [],
      })
    ).rejects.toThrow('Session workspace gateway unavailable: sandbox unavailable');

    expect(mockMarkSessionRuntimeFailure).toHaveBeenCalledWith(
      'sess-1',
      expect.any(SessionWorkspaceGatewayUnavailableError)
    );
    expect(mockCreateQueuedRun).not.toHaveBeenCalled();
  });

  it('marks the run failed if agent construction throws after the run is created', async () => {
    mockToolLoopAgent.mockImplementationOnce(() => {
      throw new Error('agent init failed');
    });

    await expect(
      AgentRunExecutor.execute({
        session: { uuid: 'sess-1' } as any,
        thread: { id: 7, uuid: 'thread-1' } as any,
        userIdentity: { userId: 'sample-user' } as any,
        messages: [],
      })
    ).rejects.toThrow('agent init failed');

    expect(mockCreateQueuedRun).toHaveBeenCalled();
    expect(mockClaimQueuedRunForExecution).toHaveBeenCalledWith('run-1', expect.stringMatching(/^direct:/));
    expect(mockMarkFailedForExecutionOwner).toHaveBeenCalledWith(
      'run-1',
      expect.stringMatching(/^direct:/),
      expect.objectContaining({ message: 'agent init failed' }),
      expect.any(Object),
      { dispatchAttemptId: undefined }
    );
  });

  it('marks loop-cap terminal tool-calls as a failed run with structured details', async () => {
    const execution = await AgentRunExecutor.execute({
      session: { uuid: 'sess-1', id: 17 } as any,
      thread: { id: 7, uuid: 'thread-1' } as any,
      userIdentity: { userId: 'sample-user' } as any,
      messages: [],
    });

    await execution.onStreamFinish({
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Still working' }],
          metadata: { runId: 'run-1' },
        } as any,
      ],
      finishReason: 'tool-calls',
      isAborted: false,
    });

    expect(mockLastFinalizeResult).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({
          code: 'max_iterations_exceeded',
          details: expect.objectContaining({
            finishReason: 'tool-calls',
            maxIterations: 8,
          }),
        }),
      })
    );
    expect(mockMarkFailedForExecutionOwner).not.toHaveBeenCalled();
  });

  it('marks the run waiting when finalization syncs pending approvals', async () => {
    mockSyncApprovalRequestState.mockResolvedValueOnce({
      pendingActions: [{ id: 99 }],
      resolvedActionCount: 0,
    });

    const execution = await AgentRunExecutor.execute({
      session: { uuid: 'sess-1', id: 17 } as any,
      thread: { id: 7, uuid: 'thread-1' } as any,
      userIdentity: { userId: 'sample-user' } as any,
      messages: [],
    });

    await execution.onStreamFinish({
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [],
          metadata: { runId: 'run-1' },
        } as any,
      ],
      finishReason: 'tool-calls',
      isAborted: false,
    });

    expect(mockLastFinalizeResult).toEqual(
      expect.objectContaining({
        status: 'waiting_for_approval',
      })
    );
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('keeps the owner heartbeat active until stream finalization or dispose', async () => {
    jest.useFakeTimers();

    try {
      const execution = await AgentRunExecutor.execute({
        session: { uuid: 'sess-1', id: 17 } as any,
        thread: { id: 7, uuid: 'thread-1' } as any,
        userIdentity: { userId: 'sample-user' } as any,
        messages: [],
      });

      expect(mockHeartbeatRunExecution).not.toHaveBeenCalled();

      jest.advanceTimersByTime(60_000);
      await Promise.resolve();

      expect(mockHeartbeatRunExecution).toHaveBeenCalledWith('run-1', expect.stringMatching(/^direct:/));

      mockHeartbeatRunExecution.mockClear();
      execution.dispose();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();

      expect(mockHeartbeatRunExecution).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('requeues the run when finalization finds already resolved approvals', async () => {
    mockSyncApprovalRequestState.mockResolvedValueOnce({
      pendingActions: [],
      resolvedActionCount: 1,
    });

    const execution = await AgentRunExecutor.execute({
      session: { uuid: 'sess-1', id: 17 } as any,
      thread: { id: 7, uuid: 'thread-1' } as any,
      userIdentity: { userId: 'sample-user' } as any,
      messages: [],
      requestGitHubToken: 'sample-gh-token',
    });

    await execution.onStreamFinish({
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [],
          metadata: { runId: 'run-1' },
        } as any,
      ],
      finishReason: 'tool-calls',
      isAborted: false,
    });

    expect(mockLastFinalizeResult).toEqual(
      expect.objectContaining({
        status: 'queued',
        patch: expect.objectContaining({
          queuedAt: expect.any(String),
        }),
      })
    );
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'approval_resolved', {
      githubToken: 'sample-gh-token',
    });
  });

  it('marks the run failed if stream finalization persistence throws', async () => {
    mockUpsertCanonicalUiMessagesForThread.mockRejectedValueOnce(new Error('message sync failed'));

    const execution = await AgentRunExecutor.execute({
      session: { uuid: 'sess-1', id: 17 } as any,
      thread: { id: 7, uuid: 'thread-1' } as any,
      userIdentity: { userId: 'sample-user' } as any,
      messages: [],
    });

    await expect(
      execution.onStreamFinish({
        messages: [],
        finishReason: 'stop',
        isAborted: false,
      })
    ).rejects.toThrow('message sync failed');

    expect(mockMarkFailedForExecutionOwner).toHaveBeenCalledWith(
      'run-1',
      expect.stringMatching(/^direct:/),
      expect.objectContaining({ message: 'message sync failed' }),
      expect.any(Object),
      { dispatchAttemptId: undefined }
    );
  });
});
