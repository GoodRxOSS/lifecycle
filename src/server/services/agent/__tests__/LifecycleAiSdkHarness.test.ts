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

var mockCreateAgentUIStream = jest.fn();
var mockCreateUIMessageStream = jest.fn();
var mockSafeValidateUIMessages = jest.fn();
var mockReadUIMessageStream = jest.fn();

jest.mock('ai', () => ({
  __esModule: true,
  createAgentUIStream: mockCreateAgentUIStream,
  createUIMessageStream: mockCreateUIMessageStream,
  readUIMessageStream: mockReadUIMessageStream,
  safeValidateUIMessages: mockSafeValidateUIMessages,
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  __esModule: true,
  DEFAULT_AGENT_SESSION_FILE_CHANGE_PREVIEW_CHARS: 4000,
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('../MessageStore', () => ({
  __esModule: true,
  default: {
    listMessages: jest.fn(),
  },
}));

jest.mock('../RunExecutor', () => ({
  __esModule: true,
  default: {
    execute: jest.fn(),
  },
}));

jest.mock('../RunService', () => ({
  __esModule: true,
  default: {
    appendStreamChunksForExecutionOwner: jest.fn(),
  },
}));

jest.mock('../RunEventService', () => ({
  __esModule: true,
  RUN_ATTEMPT_RESTARTED_EVENT_TYPE: 'attempt.restarted',
  default: {
    listRunEventsPage: jest.fn(),
    projectUiChunksFromEvents: jest.fn(),
    appendStatusEvent: jest.fn(),
  },
}));

jest.mock('../ApprovalService', () => ({
  __esModule: true,
  default: {
    upsertApprovalRequestFromStream: jest.fn(),
  },
}));

import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import AgentMessageStore from '../MessageStore';
import AgentRunExecutor from '../RunExecutor';
import AgentRunEventService from '../RunEventService';
import AgentRunService from '../RunService';
import ApprovalService from '../ApprovalService';
import type { AgentUIMessage } from '../types';
import LifecycleAiSdkHarness from '../LifecycleAiSdkHarness';
import {
  applyApprovalResponsesToToolParts,
  normalizeUnavailableToolPartsForAgentInput,
  rebuildAssistantMessageFromEvents,
} from '../LifecycleAiSdkHarness';

const mockSessionQuery = AgentSession.query as jest.Mock;
const mockThreadQuery = AgentThread.query as jest.Mock;
const mockListMessages = AgentMessageStore.listMessages as jest.Mock;
const mockListRunEventsPage = AgentRunEventService.listRunEventsPage as jest.Mock;
const mockProjectUiChunksFromEvents = AgentRunEventService.projectUiChunksFromEvents as jest.Mock;
const mockExecuteRun = AgentRunExecutor.execute as jest.Mock;
const mockAppendStreamChunksForExecutionOwner = AgentRunService.appendStreamChunksForExecutionOwner as jest.Mock;
const mockUpsertApprovalRequestFromStream = ApprovalService.upsertApprovalRequestFromStream as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockReadUIMessageStream.mockImplementation(async function* () {});
});

describe('LifecycleAiSdkHarness.executeRun', () => {
  it('flushes stream chunks before finalizing a waiting approval run', async () => {
    const operations: string[] = [];
    const userMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Create a simple web app.' }],
    } as AgentUIMessage;
    const finalMessages = [
      userMessage,
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Done.' }],
      },
    ] as AgentUIMessage[];
    const onStreamFinish = jest.fn(async () => {
      operations.push('finalize');
    });

    mockSessionQuery.mockReturnValue({
      findById: jest.fn().mockResolvedValue({
        id: 13,
        uuid: 'session-1',
        userId: 'sample-user',
        ownerGithubUsername: null,
      }),
    });
    mockThreadQuery.mockReturnValue({
      findById: jest.fn().mockResolvedValue({
        id: 17,
        uuid: 'thread-1',
      }),
    });
    mockListMessages.mockResolvedValue([userMessage]);
    mockSafeValidateUIMessages.mockResolvedValue({
      success: true,
      data: [userMessage],
    });
    mockCreateAgentUIStream.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      })
    );
    mockCreateUIMessageStream.mockImplementation(({ onEnd }) => {
      return new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Done.' });
          await onEnd({ messages: finalMessages });
          controller.close();
        },
      });
    });
    mockExecuteRun.mockResolvedValue({
      run: {
        id: 19,
        uuid: 'run-1',
        executionOwner: 'owner-1',
      },
      agent: {
        tools: {},
      },
      abortSignal: new AbortController().signal,
      selection: {
        provider: 'openai',
        modelId: 'gpt-5.4',
      },
      approvalPolicy: {
        rules: {},
        defaultMode: 'require_approval',
      },
      toolRules: [],
      onStreamFinish,
      dispose: jest.fn(),
    });
    mockAppendStreamChunksForExecutionOwner.mockImplementation(async () => {
      operations.push('append');
      return { id: 19, uuid: 'run-1' };
    });

    await LifecycleAiSdkHarness.executeRun({
      id: 19,
      uuid: 'run-1',
      threadId: 17,
      sessionId: 13,
      startedAt: null,
    } as any);

    expect(operations).toEqual(['append', 'finalize']);
    expect(onStreamFinish).toHaveBeenCalledWith({
      messages: finalMessages,
      finishReason: undefined,
      isAborted: false,
    });
  });

  it('persists approval-request chunks before appending them', async () => {
    const appendedChunks: Array<Record<string, unknown>> = [];
    const userMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Repair the deployment.' }],
    } as AgentUIMessage;
    const onStreamFinish = jest.fn();

    mockSessionQuery.mockReturnValue({
      findById: jest.fn().mockResolvedValue({
        id: 13,
        uuid: 'session-1',
        userId: 'sample-user',
        ownerGithubUsername: null,
      }),
    });
    mockThreadQuery.mockReturnValue({
      findById: jest.fn().mockResolvedValue({
        id: 17,
        uuid: 'thread-1',
      }),
    });
    mockListMessages.mockResolvedValue([userMessage]);
    mockSafeValidateUIMessages.mockResolvedValue({
      success: true,
      data: [userMessage],
    });
    mockCreateAgentUIStream.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      })
    );
    mockCreateUIMessageStream.mockImplementation(({ onEnd }) => {
      return new ReadableStream({
        async start(controller) {
          controller.enqueue({
            type: 'tool-input-available',
            toolCallId: 'tool-call-redeploy',
            toolName: 'mcp__lifecycle__trigger_redeploy',
            input: { reason: 'Retry failed deployment.' },
          });
          controller.enqueue({
            type: 'tool-approval-request',
            toolCallId: 'tool-call-redeploy',
            approvalId: 'approval-redeploy',
          });
          await onEnd({ messages: [userMessage] });
          controller.close();
        },
      });
    });
    mockExecuteRun.mockResolvedValue({
      run: {
        id: 19,
        uuid: 'run-1',
        executionOwner: 'owner-1',
      },
      agent: {
        tools: {},
      },
      abortSignal: new AbortController().signal,
      selection: {
        provider: 'openai',
        modelId: 'gpt-5.4',
      },
      approvalPolicy: {
        rules: {},
        defaultMode: 'allow',
      },
      toolRules: [],
      onStreamFinish,
      dispose: jest.fn(),
    });
    mockUpsertApprovalRequestFromStream.mockResolvedValue({
      uuid: 'pending-action-1',
    });
    mockAppendStreamChunksForExecutionOwner.mockImplementation(async (_runUuid, _owner, chunks, options) => {
      await options.beforeAppendChunks({
        trx: { trx: true },
        run: { id: 19, uuid: 'run-1' },
      });
      appendedChunks.push(...chunks);
      return { id: 19, uuid: 'run-1' };
    });

    await LifecycleAiSdkHarness.executeRun({
      id: 19,
      uuid: 'run-1',
      threadId: 17,
      sessionId: 13,
      startedAt: null,
    } as any);

    expect(mockUpsertApprovalRequestFromStream).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'approval-redeploy',
        toolCallId: 'tool-call-redeploy',
        toolName: 'mcp__lifecycle__trigger_redeploy',
        input: { reason: 'Retry failed deployment.' },
      })
    );
    expect(appendedChunks).toContainEqual(
      expect.objectContaining({
        type: 'tool-approval-request',
        approvalId: 'approval-redeploy',
        actionId: 'pending-action-1',
      })
    );
  });

  it('preserves signed continuation reasoning in model input while stripping unsigned reasoning', async () => {
    const userMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Write the file.' }],
    } as AgentUIMessage;
    const storedUnsignedAssistant = {
      id: 'assistant-old',
      role: 'assistant',
      metadata: { runId: 'run-old' },
      parts: [
        { type: 'reasoning', text: 'Old thoughts.' },
        { type: 'text', text: 'Earlier answer.' },
      ],
    } as AgentUIMessage;
    const continuationMessage = {
      id: 'assistant-continuation',
      role: 'assistant',
      metadata: { runId: 'run-approved' },
      parts: [
        {
          type: 'reasoning',
          text: 'Deciding to call the tool.',
          providerMetadata: { anthropic: { signature: 'sig-abc' } },
        },
        { type: 'reasoning', text: 'Unsigned filler.' },
        {
          type: 'dynamic-tool',
          toolName: 'mcp__workspace_core__write_file',
          toolCallId: 'tool-1',
          state: 'approval-requested',
          input: { path: 'app.py' },
          approval: { id: 'approval-1' },
        },
      ],
    } as unknown as AgentUIMessage;
    const onStreamFinish = jest.fn();
    let modelInputMessages: AgentUIMessage[] | null = null;

    mockSessionQuery.mockReturnValue({
      findById: jest.fn().mockResolvedValue({
        id: 13,
        uuid: 'session-1',
        userId: 'sample-user',
        ownerGithubUsername: null,
      }),
    });
    mockThreadQuery.mockReturnValue({
      findById: jest.fn().mockResolvedValue({
        id: 17,
        uuid: 'thread-1',
      }),
    });
    mockListMessages.mockResolvedValue([userMessage, storedUnsignedAssistant]);
    mockListRunEventsPage.mockResolvedValue({
      events: [
        {
          eventType: 'approval.responded',
          payload: { approvalId: 'approval-1', approved: true },
        },
      ],
      nextSequence: 1,
      hasMore: false,
    });
    mockProjectUiChunksFromEvents.mockReturnValue([]);
    mockReadUIMessageStream.mockImplementation(async function* () {
      yield continuationMessage;
    });
    mockSafeValidateUIMessages.mockImplementation(async ({ messages }) => {
      return {
        success: true,
        data: messages,
      };
    });
    mockCreateAgentUIStream.mockImplementation(async (options) => {
      modelInputMessages = options.uiMessages;
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    });
    mockCreateUIMessageStream.mockImplementation(({ originalMessages, onEnd }) => {
      return new ReadableStream({
        async start(controller) {
          await onEnd({ messages: originalMessages });
          controller.close();
        },
      });
    });
    mockExecuteRun.mockResolvedValue({
      run: {
        id: 19,
        uuid: 'run-approved',
        executionOwner: 'owner-1',
      },
      agent: {
        tools: {},
      },
      abortSignal: new AbortController().signal,
      selection: {
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
      approvalPolicy: {
        rules: {},
        defaultMode: 'allow',
      },
      toolRules: [],
      onStreamFinish,
      dispose: jest.fn(),
    });

    await LifecycleAiSdkHarness.executeRun({
      id: 19,
      uuid: 'run-approved',
      threadId: 17,
      sessionId: 13,
      startedAt: '2026-07-02T00:00:00.000Z',
      runPlanSnapshot: null,
    } as any);

    const messages = (modelInputMessages || []) as AgentUIMessage[];
    const continuationInput = messages.find((message) => message.id === 'assistant-continuation');
    expect(continuationInput?.parts).toEqual([
      expect.objectContaining({
        type: 'reasoning',
        providerMetadata: { anthropic: { signature: 'sig-abc' } },
      }),
      expect.objectContaining({ type: 'dynamic-tool', toolCallId: 'tool-1' }),
    ]);
    const storedInput = messages.find((message) => message.id === 'assistant-old');
    expect(storedInput?.parts).toEqual([expect.objectContaining({ type: 'text', text: 'Earlier answer.' })]);
  });
});

describe('rebuildAssistantMessageFromEvents', () => {
  it('folds only events after the newest attempt.restarted marker so restarts do not stutter', async () => {
    mockListRunEventsPage.mockResolvedValue({
      events: [
        { eventType: 'message.delta', payload: { partType: 'text', partId: 't1', delta: 'old attempt' }, sequence: 1 },
        { eventType: 'attempt.restarted', payload: {}, sequence: 2 },
        { eventType: 'message.delta', payload: { partType: 'text', partId: 't2', delta: 'new attempt' }, sequence: 3 },
      ],
      nextSequence: 3,
      hasMore: false,
    });
    mockProjectUiChunksFromEvents.mockReturnValue([]);

    await rebuildAssistantMessageFromEvents('run-1');

    const foldedEvents = mockProjectUiChunksFromEvents.mock.calls[0][0] as Array<{ sequence: number }>;
    expect(foldedEvents.map((event) => event.sequence)).toEqual([3]);
  });

  it('returns null when approval responses are required but absent (restart lane)', async () => {
    mockListRunEventsPage.mockResolvedValue({
      events: [
        { eventType: 'message.delta', payload: { partType: 'text', partId: 't1', delta: 'partial' }, sequence: 1 },
      ],
      nextSequence: 1,
      hasMore: false,
    });

    const result = await rebuildAssistantMessageFromEvents('run-1', { requireApprovalResponses: true });

    expect(result).toBeNull();
    expect(mockProjectUiChunksFromEvents).not.toHaveBeenCalled();
  });
});

describe('applyApprovalResponsesToToolParts', () => {
  it('hydrates approved output tool parts so continuation messages validate', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'mcp__workspace_core__write_file',
          toolCallId: 'call-1',
          state: 'output-error',
          input: {
            path: 'sample.txt',
            content: 'hello',
          },
          errorText: 'Session workspace gateway unavailable.',
          approval: {
            id: 'approval-1',
          },
        },
      ],
    } as AgentUIMessage;

    const result = applyApprovalResponsesToToolParts(
      message,
      new Map([
        [
          'approval-1',
          {
            approved: true,
            reason: 'Looks fine',
          },
        ],
      ])
    );

    expect(result.parts[0]).toEqual(
      expect.objectContaining({
        state: 'output-error',
        approval: {
          id: 'approval-1',
          approved: true,
          reason: 'Looks fine',
        },
      })
    );
  });

  it('marks pending approval parts as responded for resumed runs', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-mcp__workspace_core__write_file',
          toolCallId: 'call-1',
          state: 'approval-requested',
          input: {
            path: 'sample.txt',
            content: 'hello',
          },
          approval: {
            id: 'approval-1',
          },
        },
      ],
    } as AgentUIMessage;

    const result = applyApprovalResponsesToToolParts(
      message,
      new Map([
        [
          'approval-1',
          {
            approved: false,
            reason: 'Not needed',
          },
        ],
      ])
    );

    expect(result.parts[0]).toEqual(
      expect.objectContaining({
        state: 'approval-responded',
        approval: {
          id: 'approval-1',
          approved: false,
          reason: 'Not needed',
        },
      })
    );
  });

  it('stamps a truthful default reason on denials without user feedback so the model does not confabulate a cause', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-mcp__lifecycle__update_file',
          toolCallId: 'call-1',
          state: 'approval-requested',
          input: { file_path: 'lifecycle.yaml' },
          approval: { id: 'approval-1' },
        },
      ],
    } as AgentUIMessage;

    const result = applyApprovalResponsesToToolParts(message, new Map([['approval-1', { approved: false }]]));

    const approval = (result.parts[0] as { approval: { approved: boolean; reason?: string } }).approval;
    expect(approval.approved).toBe(false);
    expect(approval.reason).toContain('user declined');
    expect(approval.reason).toContain('ask the user');
  });

  it('does not invent a reason for approvals without feedback', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-mcp__lifecycle__update_file',
          toolCallId: 'call-1',
          state: 'approval-requested',
          input: { file_path: 'lifecycle.yaml' },
          approval: { id: 'approval-1' },
        },
      ],
    } as AgentUIMessage;

    const result = applyApprovalResponsesToToolParts(message, new Map([['approval-1', { approved: true }]]));

    const approval = (result.parts[0] as { approval: { approved: boolean; reason?: string } }).approval;
    expect(approval.approved).toBe(true);
    expect(approval.reason).toBeUndefined();
  });
});

describe('normalizeUnavailableToolPartsForAgentInput', () => {
  it('converts unavailable static tool parts to dynamic tool parts for continuation', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-mcp__workspace_core__missing_tool',
          toolCallId: 'call-1',
          state: 'output-error',
          errorText: 'Model tried to call unavailable tool.',
        },
      ],
    } as unknown as AgentUIMessage;

    const [result] = normalizeUnavailableToolPartsForAgentInput([message], {
      mcp__workspace_core__publish_http: {} as never,
    });

    expect(result.parts[0]).toEqual(
      expect.objectContaining({
        type: 'dynamic-tool',
        toolName: 'mcp__workspace_core__missing_tool',
        toolCallId: 'call-1',
        state: 'output-error',
        input: undefined,
      })
    );
  });

  it('fills the missing approved decision on a resolved auto-approved tool part so resume can re-validate', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'mcp__workspace_core__write_file',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { path: 'server.js' },
          output: { content: [] },
          approval: { id: 'aitxt-abc' },
        },
        {
          type: 'dynamic-tool',
          toolName: 'mcp__workspace_core__exec',
          toolCallId: 'call-2',
          state: 'output-denied',
          input: { command: 'rm -rf /' },
          approval: { id: 'aitxt-def' },
        },
        {
          type: 'dynamic-tool',
          toolName: 'mcp__workspace_core__list_files',
          toolCallId: 'call-3',
          state: 'output-available',
          input: {},
          output: { content: [] },
          approval: { id: 'aitxt-ghi', approved: true },
        },
      ],
    } as unknown as AgentUIMessage;

    const [result] = normalizeUnavailableToolPartsForAgentInput([message], {});

    // Resolved call with a bare `{ id }` approval is stamped approved: true (it ran, so it was approved).
    expect((result.parts[0] as { approval: unknown }).approval).toEqual({ id: 'aitxt-abc', approved: true });
    // Denied call is stamped approved: false.
    expect((result.parts[1] as { approval: unknown }).approval).toEqual({ id: 'aitxt-def', approved: false });
    // An already-well-formed approval is left untouched (same object reference).
    expect(result.parts[2]).toBe(message.parts[2]);
  });
});
