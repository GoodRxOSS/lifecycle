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

var mockCreateAgentUIStream: jest.Mock;
var mockCreateUIMessageStream: jest.Mock;
var mockSafeValidateUIMessages: jest.Mock;
var mockReadUIMessageStream: jest.Mock;

jest.mock('ai', () => ({
  __esModule: true,
  createAgentUIStream: (mockCreateAgentUIStream = jest.fn()),
  createUIMessageStream: (mockCreateUIMessageStream = jest.fn()),
  readUIMessageStream: (mockReadUIMessageStream = jest.fn()),
  safeValidateUIMessages: (mockSafeValidateUIMessages = jest.fn()),
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
import AgentRunService from '../RunService';
import type { AgentUIMessage } from '../types';
import LifecycleAiSdkHarness from '../LifecycleAiSdkHarness';
import {
  applyApprovalResponsesToToolParts,
  normalizeUnavailableToolPartsForAgentInput,
} from '../LifecycleAiSdkHarness';

const mockSessionQuery = AgentSession.query as jest.Mock;
const mockThreadQuery = AgentThread.query as jest.Mock;
const mockListMessages = AgentMessageStore.listMessages as jest.Mock;
const mockExecuteRun = AgentRunExecutor.execute as jest.Mock;
const mockAppendStreamChunksForExecutionOwner = AgentRunService.appendStreamChunksForExecutionOwner as jest.Mock;

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
    mockCreateUIMessageStream.mockImplementation(({ onFinish }) => {
      return new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Done.' });
          await onFinish({ messages: finalMessages });
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
});

describe('applyApprovalResponsesToToolParts', () => {
  it('hydrates approved output tool parts so continuation messages validate', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'mcp__sandbox__workspace_write_file',
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
          type: 'tool-mcp__sandbox__workspace_write_file',
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
          type: 'tool-mcp__sandbox__lifecycle__publish_http',
          toolCallId: 'call-1',
          state: 'output-error',
          errorText: 'Model tried to call unavailable tool.',
        },
      ],
    } as unknown as AgentUIMessage;

    const [result] = normalizeUnavailableToolPartsForAgentInput([message], {
      mcp__lifecycle__publish_http: {} as never,
    });

    expect(result.parts[0]).toEqual(
      expect.objectContaining({
        type: 'dynamic-tool',
        toolName: 'mcp__sandbox__lifecycle__publish_http',
        toolCallId: 'call-1',
        state: 'output-error',
        input: undefined,
      })
    );
  });
});
