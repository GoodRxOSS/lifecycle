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

import { NextRequest } from 'next/server';

const mockValidateUIMessages = jest.fn();
const mockCreateAgentUIStream = jest.fn();
const mockCreateUIMessageStream = jest.fn();
const mockCreateUIMessageStreamResponse = jest.fn();

jest.mock('ai', () => ({
  validateUIMessages: (...args: unknown[]) => mockValidateUIMessages(...args),
  createAgentUIStream: (...args: unknown[]) => mockCreateAgentUIStream(...args),
  createUIMessageStream: (...args: unknown[]) => mockCreateUIMessageStream(...args),
  createUIMessageStreamResponse: (...args: unknown[]) => mockCreateUIMessageStreamResponse(...args),
}));

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: jest.fn(),
}));

jest.mock('server/services/agent/ThreadService', () => ({
  __esModule: true,
  default: {
    getOwnedThreadWithSession: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunService', () => ({
  __esModule: true,
  default: {
    getLatestOwnedThreadRun: jest.fn(),
    isTerminalStatus: jest.fn(),
  },
}));

jest.mock('server/services/agent/ApprovalService', () => ({
  __esModule: true,
  default: {
    syncApprovalResponsesFromMessages: jest.fn(),
  },
}));

jest.mock('server/services/agent/MessageStore', () => ({
  __esModule: true,
  default: {
    syncMessages: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunExecutor', () => ({
  __esModule: true,
  default: {
    execute: jest.fn(),
  },
}));

jest.mock('server/services/agent/StreamBroker', () => ({
  __esModule: true,
  default: {
    attach: jest.fn(),
  },
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    touchActivity: jest.fn(),
  },
}));

import { POST } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentThreadService from 'server/services/agent/ThreadService';
import AgentRunService from 'server/services/agent/RunService';
import ApprovalService from 'server/services/agent/ApprovalService';
import AgentMessageStore from 'server/services/agent/MessageStore';
import AgentRunExecutor from 'server/services/agent/RunExecutor';
import AgentStreamBroker from 'server/services/agent/StreamBroker';
import AgentSessionService from 'server/services/agentSession';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockGetOwnedThreadWithSession = AgentThreadService.getOwnedThreadWithSession as jest.Mock;
const mockGetLatestOwnedThreadRun = AgentRunService.getLatestOwnedThreadRun as jest.Mock;
const mockIsTerminalStatus = AgentRunService.isTerminalStatus as jest.Mock;
const mockSyncApprovalResponses = ApprovalService.syncApprovalResponsesFromMessages as jest.Mock;
const mockSyncMessages = AgentMessageStore.syncMessages as jest.Mock;
const mockExecute = AgentRunExecutor.execute as jest.Mock;
const mockAttachStream = AgentStreamBroker.attach as jest.Mock;
const mockTouchActivity = AgentSessionService.touchActivity as jest.Mock;

function makeRequest(body: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    json: async () => body,
  } as unknown as NextRequest;
}

describe('POST /api/v2/ai/agent/threads/[threadId]/messages', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
    });
    mockGetOwnedThreadWithSession.mockResolvedValue({
      thread: {
        id: 10,
        uuid: '7a972d88-3c05-4b80-93b9-7c420fb4d67d',
      },
      session: {
        id: 20,
        uuid: '8fcaebb5-9392-4a81-a2ea-6dd367afd9f7',
        status: 'active',
      },
    });
    mockValidateUIMessages.mockImplementation(async ({ messages }) => messages);
    mockIsTerminalStatus.mockImplementation(
      (status) => status === 'completed' || status === 'failed' || status === 'cancelled'
    );
    mockSyncApprovalResponses.mockResolvedValue(undefined);
    mockSyncMessages.mockImplementation(async (_threadId, _userId, messages) => messages);
    mockCreateAgentUIStream.mockResolvedValue(new ReadableStream());
    mockCreateUIMessageStream.mockReturnValue(new ReadableStream());
    mockCreateUIMessageStreamResponse.mockReturnValue(new Response('ok', { status: 200 }));
    mockExecute.mockResolvedValue({
      agent: { tools: {} },
      abortSignal: new AbortController().signal,
      onStreamFinish: jest.fn(),
      selection: {
        provider: 'openai',
        modelId: 'gpt-5.4',
      },
      run: {
        uuid: 'b2e0f5e1-3342-4c83-a2f2-37d3104fc8e4',
      },
    });
  });

  it('rejects a new user turn when the thread already has an active run', async () => {
    mockGetLatestOwnedThreadRun.mockResolvedValue({
      status: 'running',
    });

    const response = await POST(
      makeRequest({
        messages: [
          {
            id: 'user-1',
            role: 'user',
            parts: [{ type: 'text', text: 'Inspect the workspace.' }],
          },
        ],
      }),
      {
        params: { threadId: '7a972d88-3c05-4b80-93b9-7c420fb4d67d' },
      }
    );

    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Wait for the current agent run to finish before sending another message.');
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockCreateAgentUIStream).not.toHaveBeenCalled();
  });

  it('rejects new messages while the session is still starting', async () => {
    mockGetOwnedThreadWithSession.mockResolvedValue({
      thread: {
        id: 10,
        uuid: '7a972d88-3c05-4b80-93b9-7c420fb4d67d',
      },
      session: {
        id: 20,
        uuid: '8fcaebb5-9392-4a81-a2ea-6dd367afd9f7',
        status: 'starting',
      },
    });

    const response = await POST(
      makeRequest({
        messages: [
          {
            id: 'user-1',
            role: 'user',
            parts: [{ type: 'text', text: 'Inspect the workspace.' }],
          },
        ],
      }),
      {
        params: { threadId: '7a972d88-3c05-4b80-93b9-7c420fb4d67d' },
      }
    );

    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Wait for the session to finish starting before sending a message.');
    expect(mockSyncApprovalResponses).not.toHaveBeenCalled();
    expect(mockSyncMessages).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockCreateAgentUIStream).not.toHaveBeenCalled();
  });

  it('allows assistant approval continuations to reuse the waiting run', async () => {
    mockGetLatestOwnedThreadRun.mockResolvedValue({
      status: 'waiting_for_approval',
    });

    const response = await POST(
      makeRequest({
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            metadata: {
              runId: 'b2e0f5e1-3342-4c83-a2f2-37d3104fc8e4',
            },
            parts: [
              {
                type: 'tool-workspace_exec_mutation',
                toolCallId: 'tool-1',
                state: 'approval-responded',
                approval: {
                  id: 'approval-1',
                  approved: true,
                },
              },
            ],
          },
        ],
      }),
      {
        params: { threadId: '7a972d88-3c05-4b80-93b9-7c420fb4d67d' },
      }
    );

    expect(response.status).toBe(200);
    expect(mockSyncApprovalResponses).toHaveBeenCalled();
    expect(mockSyncMessages).toHaveBeenCalled();
    expect(mockTouchActivity).toHaveBeenCalledWith('8fcaebb5-9392-4a81-a2ea-6dd367afd9f7');
    expect(mockExecute).toHaveBeenCalled();
    expect(mockCreateAgentUIStream).toHaveBeenCalledWith(
      expect.objectContaining({
        generateMessageId: expect.any(Function),
      })
    );
    expect(mockCreateUIMessageStream).toHaveBeenCalledWith(
      expect.objectContaining({
        execute: expect.any(Function),
      })
    );
    expect(mockAttachStream).toHaveBeenCalledWith('b2e0f5e1-3342-4c83-a2f2-37d3104fc8e4', expect.any(ReadableStream));
  });
});
