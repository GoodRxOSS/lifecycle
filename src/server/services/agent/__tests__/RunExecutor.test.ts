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

jest.mock('ai', () => ({
  __esModule: true,
  ToolLoopAgent: (mockToolLoopAgent = jest.fn().mockImplementation((config) => ({ config }))),
  stepCountIs: jest.fn(() => 'stop-condition'),
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

const mockCreateRun = jest.fn().mockResolvedValue({ id: 11, uuid: 'run-1', status: 'running' });
const mockRegisterAbortController = jest.fn();
const mockPatchRun = jest.fn().mockResolvedValue(undefined);

jest.mock('server/services/agent/RunService', () => ({
  __esModule: true,
  default: {
    createRun: (...args: unknown[]) => mockCreateRun(...args),
    registerAbortController: (...args: unknown[]) => mockRegisterAbortController(...args),
    patchRun: (...args: unknown[]) => mockPatchRun(...args),
    getRunByUuid: jest.fn(),
    patchStatus: jest.fn(),
    markFailed: jest.fn(),
    markCompleted: jest.fn(),
  },
}));

const mockGetSessionAppendSystemPrompt = jest.fn().mockResolvedValue('Append prompt');
const mockTouchActivity = jest.fn().mockResolvedValue(undefined);
const mockGetEffectiveSessionConfig = jest.fn().mockResolvedValue({
  systemPrompt: 'DB prompt as stored',
  appendSystemPrompt: undefined,
  toolRules: [],
});

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    getSessionAppendSystemPrompt: (...args: unknown[]) => mockGetSessionAppendSystemPrompt(...args),
    touchActivity: (...args: unknown[]) => mockTouchActivity(...args),
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
  },
}));

jest.mock('server/services/agent/MessageStore', () => ({
  __esModule: true,
  default: {
    syncMessages: jest.fn(),
  },
}));

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
    mockCreateRun.mockResolvedValue({ id: 11, uuid: 'run-1', status: 'running' });
    mockPatchRun.mockResolvedValue(undefined);
    mockGetSessionAppendSystemPrompt.mockResolvedValue('Append prompt');
    mockTouchActivity.mockResolvedValue(undefined);
    mockGetEffectiveSessionConfig.mockResolvedValue({
      systemPrompt: 'DB prompt as stored',
      appendSystemPrompt: undefined,
      toolRules: [],
    });
    mockPendingActionFirst.mockResolvedValue(null);
    mockToolExecutionFirst.mockResolvedValue(undefined);
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
});
