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
var mockEnsureRunStartStateEvent = jest.fn();
var mockLoggerError = jest.fn();
var mockLoggerInfo = jest.fn();
var mockLoggerWarn = jest.fn();

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

jest.mock('server/lib/logger', () => ({
  __esModule: true,
  getLogger: () => ({
    error: mockLoggerError,
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
  }),
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
    markFailedForExecutionOwner: jest.fn(),
  },
}));

jest.mock('../EnvironmentStateService', () => ({
  __esModule: true,
  default: {
    ensureRunStartStateEvent: (...args: unknown[]) => mockEnsureRunStartStateEvent(...args),
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
import { AgentRunOwnershipLostError } from '../AgentRunOwnershipLostError';
import { AgentRunTerminalFailure } from '../errors';
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
const mockMarkFailedForExecutionOwner = AgentRunService.markFailedForExecutionOwner as jest.Mock;
const mockUpsertApprovalRequestFromStream = ApprovalService.upsertApprovalRequestFromStream as jest.Mock;
const mockAppendStatusEvent = AgentRunEventService.appendStatusEvent as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockReadUIMessageStream.mockImplementation(async function* () {});
  mockEnsureRunStartStateEvent.mockResolvedValue(undefined);
  mockAppendStatusEvent.mockResolvedValue(undefined);
  mockMarkFailedForExecutionOwner.mockResolvedValue(undefined);
});

function closedChunkStream(chunks: Array<Record<string, unknown>> = []): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function arrangeExecutableRun({
  messages,
  session,
  thread,
  execution,
}: {
  messages?: AgentUIMessage[];
  session?: Record<string, unknown>;
  thread?: Record<string, unknown>;
  execution?: Record<string, unknown>;
} = {}) {
  const userMessage = {
    id: 'user-default',
    role: 'user',
    parts: [{ type: 'text', text: 'Continue.' }],
  } as AgentUIMessage;
  const storedMessages = messages || [userMessage];
  const dispose = jest.fn();
  const onStreamFinish = jest.fn();
  const executionResult = {
    run: { id: 19, uuid: 'run-1', executionOwner: 'owner-1' },
    agent: { tools: {} },
    abortSignal: new AbortController().signal,
    selection: { provider: 'openai', modelId: 'gpt-5.4' },
    approvalPolicy: { rules: {}, defaultMode: 'allow' },
    toolRules: [],
    toolMetadata: {},
    onStreamFinish,
    dispose,
    ...execution,
  };

  mockSessionQuery.mockReturnValue({
    findById: jest.fn().mockResolvedValue({
      id: 13,
      uuid: 'session-1',
      userId: 'sample-user',
      ownerGithubUsername: null,
      ...session,
    }),
  });
  mockThreadQuery.mockReturnValue({
    findById: jest.fn().mockResolvedValue({ id: 17, uuid: 'thread-1', ...thread }),
  });
  mockListMessages.mockResolvedValue(storedMessages);
  mockSafeValidateUIMessages.mockImplementation(async ({ messages: candidateMessages }) => ({
    success: true,
    data: candidateMessages,
  }));
  mockCreateAgentUIStream.mockImplementation(async ({ onEnd }) => {
    await onEnd({ finishReason: 'stop', isAborted: false });
    return closedChunkStream();
  });
  mockCreateUIMessageStream.mockImplementation(({ originalMessages, onEnd }) => {
    return new ReadableStream({
      async start(controller) {
        await onEnd({ messages: originalMessages });
        controller.close();
      },
    });
  });
  mockExecuteRun.mockResolvedValue(executionResult);
  mockAppendStreamChunksForExecutionOwner.mockResolvedValue(executionResult.run);

  return { dispose, executionResult, onStreamFinish, storedMessages, userMessage };
}

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
            type: 'data-file-change',
            id: 'change-1',
            data: {
              id: 'change-1',
              toolCallId: 'tool-call-redeploy',
              sourceTool: 'mcp__workspace_core__write_file',
              displayPath: 'lifecycle.yaml',
              stage: 'updated',
            },
          });
          controller.enqueue({
            type: 'tool-input-start',
            toolCallId: 'tool-call-redeploy',
            toolName: 'mcp__lifecycle__trigger_redeploy',
          });
          controller.enqueue({
            type: 'tool-input-available',
            toolCallId: 'tool-call-redeploy',
            toolName: 'mcp__lifecycle__trigger_redeploy',
            input: { reason: 'Retry failed deployment.' },
          });
          controller.enqueue({
            type: 'tool-output-available',
            toolCallId: 'tool-call-redeploy',
            output: { queued: true },
          });
          controller.enqueue({
            type: 'tool-approval-request',
            toolCallId: 'tool-call-redeploy',
            approvalId: 'approval-automatic',
            isAutomatic: true,
          });
          controller.enqueue({
            type: 'tool-approval-request',
            toolCallId: 'tool-call-redeploy',
            approvalId: 'approval-redeploy',
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
        fileChanges: [expect.objectContaining({ id: 'change-1', displayPath: 'lifecycle.yaml' })],
      })
    );
    expect(mockUpsertApprovalRequestFromStream).toHaveBeenCalledTimes(1);
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
    const storedReasoningOnlyAssistant = {
      id: 'assistant-reasoning-only',
      role: 'assistant',
      metadata: { runId: 'run-old-2' },
      parts: [{ type: 'reasoning', text: 'No load-bearing provider metadata.' }],
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
        {
          type: 'reasoning',
          text: 'Redacted provider reasoning.',
          providerMetadata: { anthropic: { redactedData: 'redacted-abc' } },
        },
        {
          type: 'reasoning',
          text: 'OpenAI reasoning reference.',
          providerMetadata: { openai: { itemId: 'reasoning-item-1' } },
        },
        {
          type: 'reasoning',
          text: 'OpenAI encrypted reasoning.',
          providerMetadata: { openai: { reasoningEncryptedContent: 'encrypted-abc' } },
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
    mockListMessages.mockResolvedValue([userMessage, storedUnsignedAssistant, storedReasoningOnlyAssistant]);
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
      expect.objectContaining({
        type: 'reasoning',
        providerMetadata: { anthropic: { redactedData: 'redacted-abc' } },
      }),
      expect.objectContaining({
        type: 'reasoning',
        providerMetadata: { openai: { itemId: 'reasoning-item-1' } },
      }),
      expect.objectContaining({
        type: 'reasoning',
        providerMetadata: { openai: { reasoningEncryptedContent: 'encrypted-abc' } },
      }),
      expect.objectContaining({ type: 'dynamic-tool', toolCallId: 'tool-1' }),
    ]);
    const storedInput = messages.find((message) => message.id === 'assistant-old');
    expect(storedInput?.parts).toEqual([expect.objectContaining({ type: 'text', text: 'Earlier answer.' })]);
    expect(messages.find((message) => message.id === 'assistant-reasoning-only')).toBeUndefined();
  });

  it.each([
    ['thread', null, { id: 13, uuid: 'session-1', userId: 'sample-user' }],
    ['session', { id: 17, uuid: 'thread-1' }, null],
  ])('rejects before starting execution when the %s context no longer exists', async (_missing, thread, session) => {
    mockThreadQuery.mockReturnValue({ findById: jest.fn().mockResolvedValue(thread) });
    mockSessionQuery.mockReturnValue({ findById: jest.fn().mockResolvedValue(session) });

    await expect(
      LifecycleAiSdkHarness.executeRun({ id: 19, uuid: 'run-1', threadId: 17, sessionId: 13 } as any)
    ).rejects.toThrow('Agent run context not found');

    expect(mockEnsureRunStartStateEvent).not.toHaveBeenCalled();
    expect(mockExecuteRun).not.toHaveBeenCalled();
    expect(mockAppendStreamChunksForExecutionOwner).not.toHaveBeenCalled();
  });

  it('forwards run identity and options, merges model and file-change streams, and finalizes with SDK metadata', async () => {
    const { dispose, executionResult, onStreamFinish, storedMessages } = arrangeExecutableRun({
      session: { ownerGithubUsername: 'octocat' },
      execution: {
        selection: {
          provider: 'openai',
          modelId: 'gpt-5.4',
          inputCostPerMillion: 2,
          outputCostPerMillion: 4,
        },
      },
    });
    const fileChange = {
      id: 'change-1',
      toolCallId: 'tool-call-1',
      sourceTool: 'mcp__workspace_core__write_file',
      displayPath: 'src/index.ts',
      stage: 'updated',
    };
    let startMetadata: Record<string, unknown> | undefined;
    let finishMetadata: Record<string, unknown> | undefined;
    let legacyFinishMetadata: Record<string, unknown> | undefined;
    let finishWithoutUsage: Record<string, unknown> | undefined;
    let nonLifecycleMetadata: unknown;
    let streamErrorText: string | undefined;
    const generatedIds: string[] = [];
    const appendedChunks: Array<Record<string, unknown>> = [];

    mockExecuteRun.mockImplementation(async (options) => {
      await options.onFileChange(fileChange);
      return executionResult;
    });
    mockCreateAgentUIStream.mockImplementation(async (options) => {
      generatedIds.push(options.generateMessageId());
      startMetadata = options.messageMetadata({ part: { type: 'start' } });
      finishMetadata = options.messageMetadata({
        part: {
          type: 'finish',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            inputTokenDetails: { cacheReadTokens: 2 },
            outputTokenDetails: { reasoningTokens: 1, textTokens: 4 },
          },
          finishReason: 'stop',
          rawFinishReason: 'end_turn',
        },
      });
      legacyFinishMetadata = options.messageMetadata({
        part: {
          type: 'finish',
          totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      });
      finishWithoutUsage = options.messageMetadata({ part: { type: 'finish' } });
      nonLifecycleMetadata = options.messageMetadata({ part: { type: 'text-delta' } });
      streamErrorText = options.onError(Object.assign(new Error('Invalid API key'), { statusCode: 401 }));
      await options.onEnd({ finishReason: 'stop', isAborted: false });
      return closedChunkStream([{ type: 'text-delta', id: 'text-1', delta: 'Done.' }]);
    });
    mockCreateUIMessageStream.mockImplementation(({ execute, generateId, onEnd, originalMessages }) => {
      generatedIds.push(generateId());
      return new ReadableStream({
        async start(controller) {
          const mergedStreams: Array<ReadableStream<any>> = [];
          execute({
            writer: {
              merge(stream: ReadableStream<any>) {
                mergedStreams.push(stream);
              },
            },
          });
          for (const stream of mergedStreams) {
            const reader = stream.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            reader.releaseLock();
          }
          await onEnd({
            messages: [
              ...originalMessages,
              { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
            ],
          });
          controller.close();
        },
      });
    });
    mockAppendStreamChunksForExecutionOwner.mockImplementation(async (_runUuid, _owner, chunks, options) => {
      await options.beforeAppendChunks({ run: executionResult.run });
      appendedChunks.push(...chunks);
      return executionResult.run;
    });

    await LifecycleAiSdkHarness.executeRun(
      {
        id: 19,
        uuid: 'run-1',
        threadId: 17,
        sessionId: 13,
        startedAt: null,
        resolvedProvider: 'openai',
        requestedProvider: 'anthropic',
        resolvedModel: 'gpt-5.4',
        requestedModel: 'claude-sonnet-4-5',
      } as any,
      {
        requestGitHubToken: 'token-1',
        requestGitHubAuth: { token: 'token-1' } as any,
        dispatchAttemptId: 'attempt-1',
        dispatchReason: 'submit',
      }
    );

    expect(mockEnsureRunStartStateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ runUuid: 'run-1', runId: 19, dispatchReason: 'submit' })
    );
    expect(mockExecuteRun).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedProvider: 'openai',
        requestedModelId: 'gpt-5.4',
        requestGitHubToken: 'token-1',
        dispatchAttemptId: 'attempt-1',
        dispatchReason: 'submit',
        userIdentity: expect.objectContaining({
          userId: 'sample-user',
          githubUsername: 'octocat',
          displayName: 'octocat',
          gitUserName: 'octocat',
          gitUserEmail: 'octocat@users.noreply.github.com',
        }),
      })
    );
    expect(appendedChunks).toEqual([
      { type: 'text-delta', id: 'text-1', delta: 'Done.' },
      { type: 'data-file-change', id: 'change-1', data: fileChange },
    ]);
    expect(onStreamFinish).toHaveBeenCalledWith({
      messages: [...storedMessages, { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] }],
      finishReason: 'stop',
      isAborted: false,
    });
    expect(startMetadata).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        threadId: 'thread-1',
        runId: 'run-1',
        provider: 'openai',
        model: 'gpt-5.4',
        createdAt: expect.any(String),
      })
    );
    expect(finishMetadata).toEqual(
      expect.objectContaining({
        completedAt: expect.any(String),
        finishReason: 'stop',
        rawFinishReason: 'end_turn',
        usage: expect.objectContaining({
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 2,
          reasoningTokens: 1,
          estimatedCostUsd: 0.00004,
        }),
      })
    );
    expect(legacyFinishMetadata).toEqual(
      expect.objectContaining({ usage: expect.objectContaining({ totalTokens: 5 }) })
    );
    expect(finishWithoutUsage).toEqual(
      expect.objectContaining({ sessionId: 'session-1', completedAt: expect.any(String) })
    );
    expect(finishWithoutUsage).not.toHaveProperty('usage');
    expect(nonLifecycleMetadata).toBeUndefined();
    expect(streamErrorText).toContain('rejected the API key');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', provider: 'openai', model: 'gpt-5.4' }),
      expect.stringContaining('model stream error')
    );
    expect(generatedIds).toHaveLength(2);
    expect(generatedIds.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh replay attempt when a resumed run has no persisted approval response', async () => {
    const { storedMessages } = arrangeExecutableRun();
    mockListRunEventsPage.mockResolvedValue({
      events: [{ eventType: 'message.delta', payload: { delta: 'partial' }, sequence: 1 }],
      nextSequence: 1,
      hasMore: false,
    });

    await LifecycleAiSdkHarness.executeRun({
      id: 19,
      uuid: 'run-1',
      threadId: 17,
      sessionId: 13,
      startedAt: '2026-07-02T00:00:00.000Z',
    } as any);

    expect(mockAppendStatusEvent).toHaveBeenCalledWith('run-1', 'attempt.restarted', {});
    expect(mockCreateUIMessageStream).toHaveBeenCalledWith(
      expect.objectContaining({ originalMessages: storedMessages })
    );
    expect(mockProjectUiChunksFromEvents).not.toHaveBeenCalled();
  });

  it('quarantines a validator-fatal saved part and continues with the remaining valid message content', async () => {
    const messages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Continue.' }] },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Saved answer.' },
          { type: 'file', filename: 'missing-required-fields.txt' },
        ],
      },
    ] as unknown as AgentUIMessage[];
    arrangeExecutableRun({ messages });
    let modelInput: AgentUIMessage[] = [];
    mockSafeValidateUIMessages.mockImplementation(async ({ messages: candidateMessages }) => {
      const success = candidateMessages.every((message: AgentUIMessage) =>
        message.parts.every((part) => part.type !== 'file')
      );
      return success ? { success: true, data: candidateMessages } : { success: false, error: new Error('bad file') };
    });
    mockCreateAgentUIStream.mockImplementation(async (options) => {
      modelInput = options.uiMessages;
      await options.onEnd({ finishReason: 'stop', isAborted: false });
      return closedChunkStream();
    });

    await LifecycleAiSdkHarness.executeRun({
      id: 19,
      uuid: 'run-1',
      threadId: 17,
      sessionId: 13,
      startedAt: null,
    } as any);

    expect(modelInput).toEqual([messages[0], { ...messages[1], parts: [{ type: 'text', text: 'Saved answer.' }] }]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', keptMessages: 2, ofMessages: 2 }),
      expect.stringContaining('quarantined invalid saved message parts')
    );
  });

  it('fails terminally before opening a model stream when saved messages cannot be made valid', async () => {
    const { onStreamFinish } = arrangeExecutableRun();
    mockSafeValidateUIMessages.mockResolvedValue({ success: false, error: new Error('invalid saved state') });

    const promise = LifecycleAiSdkHarness.executeRun({
      id: 19,
      uuid: 'run-1',
      threadId: 17,
      sessionId: 13,
      startedAt: null,
    } as any);

    await expect(promise).rejects.toMatchObject<AgentRunTerminalFailure>({
      name: 'AgentRunTerminalFailure',
      code: 'run_resume_state_invalid',
      details: { reason: 'ui_message_validation' },
    });
    expect(mockCreateAgentUIStream).not.toHaveBeenCalled();
    expect(mockAppendStreamChunksForExecutionOwner).not.toHaveBeenCalled();
    expect(mockMarkFailedForExecutionOwner).not.toHaveBeenCalled();
    expect(onStreamFinish).not.toHaveBeenCalled();
  });

  it('rejects before opening the SDK stream when the executor does not provide an ownership lease', async () => {
    arrangeExecutableRun({
      execution: { run: { id: 19, uuid: 'run-1', executionOwner: null } },
    });

    await expect(
      LifecycleAiSdkHarness.executeRun({
        id: 19,
        uuid: 'run-1',
        threadId: 17,
        sessionId: 13,
        startedAt: null,
      } as any)
    ).rejects.toThrow('Agent run execution owner is required');

    expect(mockCreateAgentUIStream).not.toHaveBeenCalled();
    expect(mockCreateUIMessageStream).not.toHaveBeenCalled();
    expect(mockAppendStreamChunksForExecutionOwner).not.toHaveBeenCalled();
  });

  it.each([
    ['the SDK validation error name', Object.assign(new Error('invalid replay'), { name: 'AI_TypeValidationError' })],
    ['the SDK validation error prefix', new Error('Type validation failed: invalid tool result')],
  ])('converts %s into the stable invalid-resume terminal contract', async (_case, validationError) => {
    arrangeExecutableRun();
    mockCreateAgentUIStream.mockRejectedValue(validationError);

    await expect(
      LifecycleAiSdkHarness.executeRun({
        id: 19,
        uuid: 'run-1',
        threadId: 17,
        sessionId: 13,
        startedAt: null,
      } as any)
    ).rejects.toMatchObject({
      name: 'AgentRunTerminalFailure',
      code: 'run_resume_state_invalid',
      details: { reason: 'ui_message_validation' },
    });

    expect(mockCreateUIMessageStream).not.toHaveBeenCalled();
    expect(mockAppendStreamChunksForExecutionOwner).not.toHaveBeenCalled();
    expect(mockMarkFailedForExecutionOwner).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: validationError, runId: 'run-1' }),
      expect.stringContaining('stream validation failed')
    );
  });

  it('preserves an unexpected SDK startup error without recording a stream-consumption failure', async () => {
    const startupError = new Error('provider adapter crashed');
    arrangeExecutableRun();
    mockCreateAgentUIStream.mockRejectedValue(startupError);

    await expect(
      LifecycleAiSdkHarness.executeRun({
        id: 19,
        uuid: 'run-1',
        threadId: 17,
        sessionId: 13,
        startedAt: null,
      } as any)
    ).rejects.toBe(startupError);

    expect(mockCreateUIMessageStream).not.toHaveBeenCalled();
    expect(mockMarkFailedForExecutionOwner).not.toHaveBeenCalled();
  });

  it('does not create a pending action when approval synchronization returns no action', async () => {
    const { executionResult, onStreamFinish } = arrangeExecutableRun({ execution: { dispose: undefined } });
    const approvalChunk = {
      type: 'tool-approval-request',
      toolCallId: 'tool-call-1',
      approvalId: 'approval-1',
    };
    mockCreateUIMessageStream.mockImplementation(
      ({ onEnd, originalMessages }) =>
        new ReadableStream({
          async start(controller) {
            controller.enqueue({
              type: 'tool-input-error',
              toolCallId: 'tool-call-1',
              toolName: 'mcp__workspace_core__exec',
            });
            controller.enqueue(approvalChunk);
            await onEnd({ messages: originalMessages });
            controller.close();
          },
        })
    );
    mockUpsertApprovalRequestFromStream.mockResolvedValue(null);
    mockAppendStreamChunksForExecutionOwner.mockImplementation(async (_runUuid, _owner, _chunks, options) => {
      await options.beforeAppendChunks({ run: executionResult.run });
      return executionResult.run;
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
        approvalId: 'approval-1',
        toolCallId: 'tool-call-1',
        toolName: 'mcp__workspace_core__exec',
      })
    );
    expect(approvalChunk).not.toHaveProperty('actionId');
    expect(onStreamFinish).toHaveBeenCalledTimes(1);
  });

  it('fails the run and does not append an approval chunk when pending-action persistence fails', async () => {
    const approvalError = new Error('approval row insert failed');
    const { dispose, executionResult, onStreamFinish } = arrangeExecutableRun();
    mockCreateUIMessageStream.mockImplementation(
      ({ onEnd, originalMessages }) =>
        new ReadableStream({
          async start(controller) {
            controller.enqueue({
              type: 'tool-input-available',
              toolCallId: 'tool-call-1',
              toolName: 'mcp__workspace_core__exec',
              input: { command: 'pnpm test' },
            });
            controller.enqueue({
              type: 'tool-approval-request',
              toolCallId: 'tool-call-1',
              approvalId: 'approval-1',
            });
            await onEnd({ messages: originalMessages });
            controller.close();
          },
        })
    );
    mockUpsertApprovalRequestFromStream.mockRejectedValue(approvalError);
    mockAppendStreamChunksForExecutionOwner.mockImplementation(async (_runUuid, _owner, _chunks, options) => {
      await options.beforeAppendChunks({ run: executionResult.run });
      return executionResult.run;
    });

    await expect(
      LifecycleAiSdkHarness.executeRun({ id: 19, uuid: 'run-1', threadId: 17, sessionId: 13, startedAt: null } as any, {
        dispatchAttemptId: 'attempt-1',
      })
    ).rejects.toBe(approvalError);

    expect(mockAppendStreamChunksForExecutionOwner).toHaveBeenCalledTimes(1);
    expect(mockMarkFailedForExecutionOwner).toHaveBeenCalledWith('run-1', 'owner-1', approvalError, undefined, {
      dispatchAttemptId: 'attempt-1',
    });
    expect(onStreamFinish).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: approvalError, approvalId: 'approval-1', toolCallId: 'tool-call-1' }),
      expect.stringContaining('approval request persistence failed')
    );
  });

  it.each([
    ['known replacement state', 'running', 'owner-2'],
    ['unavailable replacement state', undefined, undefined],
  ])(
    'rethrows ownership loss with %s without overwriting the state selected by the new owner',
    async (_case, currentStatus, currentExecutionOwner) => {
      const ownershipError = new AgentRunOwnershipLostError({
        runUuid: 'run-1',
        expectedExecutionOwner: 'owner-1',
        currentStatus: currentStatus as any,
        currentExecutionOwner,
      });
      const { dispose, onStreamFinish } = arrangeExecutableRun();
      mockCreateUIMessageStream.mockImplementation(
        ({ onEnd, originalMessages }) =>
          new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'partial' });
              await onEnd({ messages: originalMessages });
              controller.close();
            },
          })
      );
      mockAppendStreamChunksForExecutionOwner.mockRejectedValue(ownershipError);

      await expect(
        LifecycleAiSdkHarness.executeRun({
          id: 19,
          uuid: 'run-1',
          threadId: 17,
          sessionId: 13,
          startedAt: null,
        } as any)
      ).rejects.toBe(ownershipError);

      expect(mockMarkFailedForExecutionOwner).not.toHaveBeenCalled();
      expect(onStreamFinish).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          owner: 'owner-1',
          currentStatus: currentStatus || null,
          currentOwner: currentExecutionOwner || null,
        }),
        expect.stringContaining('ownership lost')
      );
    }
  );

  it('marks the run failed when the UI stream closes without publishing final message state', async () => {
    const { dispose, onStreamFinish } = arrangeExecutableRun();
    mockCreateUIMessageStream.mockReturnValue(closedChunkStream());

    await expect(
      LifecycleAiSdkHarness.executeRun({
        id: 19,
        uuid: 'run-1',
        threadId: 17,
        sessionId: 13,
        startedAt: null,
      } as any)
    ).rejects.toThrow('Agent run stream finished without final message state');

    expect(mockMarkFailedForExecutionOwner).toHaveBeenCalledWith(
      'run-1',
      'owner-1',
      expect.objectContaining({ message: 'Agent run stream finished without final message state.' }),
      undefined,
      { dispatchAttemptId: undefined }
    );
    expect(onStreamFinish).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('records a finalization failure and still disposes executor resources', async () => {
    const finalizationError = new Error('final message transaction failed');
    const { dispose, onStreamFinish } = arrangeExecutableRun();
    onStreamFinish.mockRejectedValue(finalizationError);

    await expect(
      LifecycleAiSdkHarness.executeRun({
        id: 19,
        uuid: 'run-1',
        threadId: 17,
        sessionId: 13,
        startedAt: null,
      } as any)
    ).rejects.toBe(finalizationError);

    expect(mockMarkFailedForExecutionOwner).toHaveBeenCalledWith('run-1', 'owner-1', finalizationError, undefined, {
      dispatchAttemptId: undefined,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('persists long output in bounded batches while preserving chunk order', async () => {
    const { executionResult, onStreamFinish } = arrangeExecutableRun();
    const chunks = Array.from({ length: 11 }, (_, index) => ({
      type: 'text-delta',
      id: 'text-1',
      delta: String(index),
    }));
    const persistedBatches: Array<Array<Record<string, unknown>>> = [];
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    mockCreateUIMessageStream.mockImplementation(
      ({ onEnd, originalMessages }) =>
        new ReadableStream({
          async start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            await onEnd({ messages: originalMessages });
            controller.close();
          },
        })
    );
    mockAppendStreamChunksForExecutionOwner.mockImplementation(async (_runUuid, _owner, batch) => {
      persistedBatches.push(batch);
      return executionResult.run;
    });

    try {
      await LifecycleAiSdkHarness.executeRun({
        id: 19,
        uuid: 'run-1',
        threadId: 17,
        sessionId: 13,
        startedAt: null,
      } as any);
    } finally {
      dateNow.mockRestore();
    }

    expect(persistedBatches.flat()).toEqual(chunks);
    expect(persistedBatches.every((batch) => batch.length <= 10)).toBe(true);
    expect(persistedBatches.length).toBeGreaterThan(1);
    expect(onStreamFinish).toHaveBeenCalledTimes(1);
  });

  it('idle-flushes a partial burst before the upstream stream finishes', async () => {
    jest.useFakeTimers();
    const { executionResult, onStreamFinish } = arrangeExecutableRun();
    let finishStream!: () => Promise<void>;
    mockCreateUIMessageStream.mockImplementation(
      ({ onEnd, originalMessages }) =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'partial' });
            finishStream = async () => {
              await onEnd({ messages: originalMessages });
              controller.close();
            };
          },
        })
    );
    mockAppendStreamChunksForExecutionOwner.mockResolvedValue(executionResult.run);

    try {
      const executePromise = LifecycleAiSdkHarness.executeRun({
        id: 19,
        uuid: 'run-1',
        threadId: 17,
        sessionId: 13,
        startedAt: null,
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(50);

      expect(mockAppendStreamChunksForExecutionOwner).toHaveBeenCalledWith(
        'run-1',
        'owner-1',
        [{ type: 'text-delta', id: 'text-1', delta: 'partial' }],
        expect.any(Object)
      );
      expect(onStreamFinish).not.toHaveBeenCalled();

      await finishStream();
      await executePromise;
      expect(onStreamFinish).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops emitting file changes after the merged file-change stream is cancelled', async () => {
    const { dispose, executionResult, onStreamFinish } = arrangeExecutableRun();
    let emitFileChange!: (change: Record<string, unknown>) => Promise<void>;
    let finishAgentStream!: () => Promise<void>;
    mockExecuteRun.mockImplementation(async (options) => {
      emitFileChange = options.onFileChange;
      return executionResult;
    });
    mockCreateAgentUIStream.mockImplementation(async (options) => {
      finishAgentStream = () => options.onEnd({ finishReason: 'stop', isAborted: false });
      return closedChunkStream();
    });
    mockCreateUIMessageStream.mockImplementation(
      ({ execute, onEnd, originalMessages }) =>
        new ReadableStream({
          async start(controller) {
            const mergedStreams: Array<ReadableStream<any>> = [];
            execute({ writer: { merge: (stream: ReadableStream<any>) => mergedStreams.push(stream) } });
            expect(mergedStreams).toHaveLength(2);
            await mergedStreams[1].cancel('downstream stopped listening');
            await emitFileChange({
              id: 'change-after-cancel',
              toolCallId: 'tool-1',
              sourceTool: 'mcp__workspace_core__write_file',
              displayPath: 'ignored.txt',
              stage: 'updated',
            });
            await finishAgentStream();
            await onEnd({ messages: originalMessages });
            controller.close();
          },
        })
    );

    await LifecycleAiSdkHarness.executeRun({
      id: 19,
      uuid: 'run-1',
      threadId: 17,
      sessionId: 13,
      startedAt: null,
    } as any);

    expect(mockAppendStreamChunksForExecutionOwner).not.toHaveBeenCalled();
    expect(onStreamFinish).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
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

  it('pages the complete attempt, replays projected chunks, collapses duplicated text, and applies approval responses', async () => {
    const firstPageEvents = [
      { eventType: 'message.delta', payload: { delta: 'first' }, sequence: 1 },
      {
        eventType: 'approval.responded',
        payload: { approvalId: 'approval-ignored', approved: 'yes' },
        sequence: 2,
      },
    ];
    const secondPageEvents = [
      {
        eventType: 'approval.responded',
        payload: { approvalId: 'approval-1', approved: false, reason: 'Not during this run.' },
        sequence: 3,
      },
    ];
    const projectedChunks = [{ type: 'text-delta', id: 'text-1', delta: 'projected' }];
    const half = `${'A'.repeat(100)}B`;
    const replayedChunks: unknown[] = [];
    mockListRunEventsPage
      .mockResolvedValueOnce({ events: firstPageEvents, nextSequence: 2, hasMore: true })
      .mockResolvedValueOnce({ events: secondPageEvents, nextSequence: 3, hasMore: false });
    mockProjectUiChunksFromEvents.mockReturnValue(projectedChunks);
    mockReadUIMessageStream.mockImplementation(async function* ({ stream, onError }) {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        replayedChunks.push(value);
      }
      reader.releaseLock();
      onError(new Error('one persisted chunk was unreadable'));
      yield { id: 'empty', role: 'assistant', parts: [] };
      yield {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: half + half },
          { type: 'text', text: 'A normal answer.' },
          {
            type: 'dynamic-tool',
            toolName: 'mcp__workspace_core__exec',
            toolCallId: 'call-1',
            state: 'output-denied',
            input: { command: 'dangerous command' },
            approval: { id: 'approval-1' },
          },
        ],
      };
    });

    const result = await rebuildAssistantMessageFromEvents('run-1', { requireApprovalResponses: true });

    expect(mockListRunEventsPage).toHaveBeenNthCalledWith(1, 'run-1', { afterSequence: 0, limit: 500 });
    expect(mockListRunEventsPage).toHaveBeenNthCalledWith(2, 'run-1', { afterSequence: 2, limit: 500 });
    expect(mockProjectUiChunksFromEvents).toHaveBeenCalledWith([...firstPageEvents, ...secondPageEvents]);
    expect(replayedChunks).toEqual(projectedChunks);
    expect(result?.parts).toEqual([
      { type: 'text', text: half },
      { type: 'text', text: 'A normal answer.' },
      expect.objectContaining({
        type: 'dynamic-tool',
        state: 'output-denied',
        approval: expect.objectContaining({
          id: 'approval-1',
          approved: false,
          reason: 'Not during this run.',
        }),
      }),
    ]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', error: expect.any(Error) }),
      expect.stringContaining('continuation replay skipped chunk')
    );
  });

  it('returns no continuation when the event history disappears during lookup', async () => {
    mockListRunEventsPage.mockResolvedValue(null);

    const result = await rebuildAssistantMessageFromEvents('run-missing');

    expect(result).toBeNull();
    expect(mockProjectUiChunksFromEvents).toHaveBeenCalledWith([]);
    expect(mockReadUIMessageStream).toHaveBeenCalledTimes(1);
  });

  it('fails with a bounded terminal error before replaying oversized continuation history', async () => {
    const oversizedPayload = { delta: 'x'.repeat(64 * 1024 * 1024) };
    mockListRunEventsPage.mockResolvedValue({
      events: [{ eventType: 'message.delta', payload: oversizedPayload, sequence: 1 }],
      nextSequence: 1,
      hasMore: false,
    });

    await expect(rebuildAssistantMessageFromEvents('run-too-large')).rejects.toMatchObject({
      name: 'AgentRunTerminalFailure',
      code: 'run_event_history_exhausted',
      details: expect.objectContaining({ eventCount: 1 }),
    });
    expect(mockProjectUiChunksFromEvents).not.toHaveBeenCalled();
    expect(mockReadUIMessageStream).not.toHaveBeenCalled();
  });
});

describe('applyApprovalResponsesToToolParts', () => {
  it('returns the original message when there are no persisted responses', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'No tool response.' }],
    } as AgentUIMessage;

    expect(applyApprovalResponsesToToolParts(message, new Map())).toBe(message);
  });

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

  it('updates only the terminal tool state that agrees with the persisted decision', () => {
    const plainTextPart = { type: 'text', text: 'Tool outcomes:' };
    const missingApprovalPart = {
      type: 'dynamic-tool',
      toolName: 'mcp__workspace_core__exec',
      toolCallId: 'call-missing',
      state: 'output-error',
    };
    const approvedDenialPart = {
      type: 'dynamic-tool',
      toolName: 'mcp__workspace_core__exec',
      toolCallId: 'call-approved-denial',
      state: 'output-denied',
      approval: { id: 'approval-approved' },
    };
    const deniedErrorPart = {
      type: 'dynamic-tool',
      toolName: 'mcp__workspace_core__exec',
      toolCallId: 'call-denied-error',
      state: 'output-error',
      approval: { id: 'approval-denied' },
    };
    const deniedPart = {
      type: 'dynamic-tool',
      toolName: 'mcp__workspace_core__exec',
      toolCallId: 'call-denied',
      state: 'output-denied',
      approval: { id: 'approval-denied' },
    };
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [plainTextPart, missingApprovalPart, approvedDenialPart, deniedErrorPart, deniedPart],
    } as unknown as AgentUIMessage;

    const result = applyApprovalResponsesToToolParts(
      message,
      new Map([
        ['approval-approved', { approved: true }],
        ['approval-denied', { approved: false, reason: 'No destructive command.' }],
      ])
    );

    expect(result.parts[0]).toBe(plainTextPart);
    expect(result.parts[1]).toBe(missingApprovalPart);
    expect(result.parts[2]).toBe(approvedDenialPart);
    expect(result.parts[3]).toBe(deniedErrorPart);
    expect(result.parts[4]).toEqual(
      expect.objectContaining({
        approval: { id: 'approval-denied', approved: false, reason: 'No destructive command.' },
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
