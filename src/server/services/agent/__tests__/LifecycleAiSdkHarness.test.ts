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
  default: {
    listRunEventsPage: jest.fn(),
    projectUiChunksFromEvents: jest.fn(),
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

  it('adds a non-persisted workspace continuation instruction and starts a fresh assistant message', async () => {
    const userMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Create a tiny web app.' }],
    } as AgentUIMessage;
    const sourceAssistantMessage = {
      id: 'assistant-source',
      role: 'assistant',
      metadata: { runId: 'run-source' },
      parts: [{ type: 'text', text: 'The workspace is ready.' }],
    } as AgentUIMessage;
    const newAssistantMessage = {
      id: 'assistant-continuation',
      role: 'assistant',
      metadata: { runId: 'run-continuation' },
      parts: [{ type: 'text', text: 'Inspecting files now.' }],
    } as AgentUIMessage;
    const onStreamFinish = jest.fn();
    let agentStreamOptions: { uiMessages?: AgentUIMessage[]; originalMessages?: AgentUIMessage[] } | null = null;
    let outerOriginalMessages: AgentUIMessage[] | null = null;

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
    mockListMessages.mockResolvedValue([userMessage, sourceAssistantMessage]);
    mockSafeValidateUIMessages.mockImplementation(async ({ messages }) => ({
      success: true,
      data: messages,
    }));
    mockCreateAgentUIStream.mockImplementation(async (options) => {
      agentStreamOptions = options;
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    });
    mockCreateUIMessageStream.mockImplementation(({ originalMessages, onEnd }) => {
      outerOriginalMessages = originalMessages;
      return new ReadableStream({
        async start(controller) {
          await onEnd({
            messages: [...originalMessages, newAssistantMessage],
          });
          controller.close();
        },
      });
    });
    mockExecuteRun.mockResolvedValue({
      run: {
        id: 19,
        uuid: 'run-continuation',
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

    await LifecycleAiSdkHarness.executeRun({
      id: 19,
      uuid: 'run-continuation',
      threadId: 17,
      sessionId: 13,
      startedAt: null,
      runPlanSnapshot: {
        version: 1,
        continuation: {
          kind: 'workspace_escalation',
          sourceRunId: 'run-source',
          sourceToolCallId: 'tool-provision',
          reason: 'Create a tiny web app.',
        },
      },
    } as any);

    const internalModelMessage = agentStreamOptions?.uiMessages?.at(-1);
    expect(internalModelMessage).toMatchObject({
      role: 'user',
      metadata: {
        kind: 'workspace_continuation_instruction',
        hidden: true,
        runId: 'run-continuation',
      },
    });
    expect(String((internalModelMessage?.parts?.[0] as { text?: unknown } | undefined)?.text)).toContain(
      'Do not stop after describing the next step'
    );
    expect(agentStreamOptions?.originalMessages?.at(-1)).toBe(internalModelMessage);
    expect(outerOriginalMessages?.at(-1)).toBe(internalModelMessage);
    expect(onStreamFinish).toHaveBeenCalledWith({
      messages: [userMessage, sourceAssistantMessage, newAssistantMessage],
      finishReason: undefined,
      isAborted: false,
    });
  });

  it('drops reasoning-only source assistant turns from continuation model input', async () => {
    const userMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Create a tiny web app.' }],
    } as AgentUIMessage;
    const reasoningOnlySourceAssistant = {
      id: 'assistant-source',
      role: 'assistant',
      metadata: { runId: 'run-source' },
      parts: [{ type: 'reasoning', text: 'Need to provision a workspace.' }],
    } as AgentUIMessage;
    const newAssistantMessage = {
      id: 'assistant-continuation',
      role: 'assistant',
      metadata: { runId: 'run-continuation' },
      parts: [{ type: 'text', text: 'Creating files now.' }],
    } as AgentUIMessage;
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
    mockListMessages.mockResolvedValue([userMessage, reasoningOnlySourceAssistant]);
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
          await onEnd({
            messages: [...originalMessages, newAssistantMessage],
          });
          controller.close();
        },
      });
    });
    mockExecuteRun.mockResolvedValue({
      run: {
        id: 19,
        uuid: 'run-continuation',
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

    await LifecycleAiSdkHarness.executeRun({
      id: 19,
      uuid: 'run-continuation',
      threadId: 17,
      sessionId: 13,
      startedAt: null,
      runPlanSnapshot: {
        version: 1,
        continuation: {
          kind: 'workspace_escalation',
          sourceRunId: 'run-source',
          sourceToolCallId: 'tool-provision',
          reason: 'Create a tiny web app.',
        },
      },
    } as any);

    // Reasoning-only prior turns are stripped from model input (chain-of-thought is dead weight),
    expect(modelInputMessages?.map((message) => message.id)).toEqual([
      'user-1',
      'workspace-continuation:run-continuation',
    ]);
    // but preserved in the persisted transcript so the UI keeps the reasoning it already stored.
    expect(onStreamFinish).toHaveBeenCalledWith({
      messages: [userMessage, reasoningOnlySourceAssistant, newAssistantMessage],
      finishReason: undefined,
      isAborted: false,
    });
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
});
