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

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: jest.fn(),
}));

jest.mock('server/lib/agentSession/githubToken', () => ({
  resolveRequestGitHubToken: jest.fn(),
}));

jest.mock('server/services/agent/CapabilityService', () => ({
  __esModule: true,
  default: {
    resolveSessionContext: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunAdmissionService', () => ({
  __esModule: true,
  default: {
    createQueuedRunWithMessage: jest.fn(),
  },
}));

jest.mock('server/services/agent/MessageStore', () => ({
  __esModule: true,
  default: {
    serializeCanonicalMessage: jest.fn((message) => ({
      id: message.uuid,
      clientMessageId: message.clientMessageId || null,
      threadId: 'thread-1',
      runId: 'run-1',
      role: message.role,
      parts: message.parts,
      createdAt: message.createdAt || null,
    })),
  },
}));

jest.mock('server/services/agent/ProviderRegistry', () => ({
  __esModule: true,
  default: {
    resolveSelection: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunQueueService', () => ({
  __esModule: true,
  default: {
    enqueueRun: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunService', () => ({
  __esModule: true,
  default: {
    isActiveRunConflictError: jest.fn(),
    markFailed: jest.fn(),
    markQueuedRunDispatchFailed: jest.fn(),
    serializeRun: jest.fn((run) => ({ id: run.uuid, status: run.status })),
  },
  InvalidAgentRunDefaultsError: class InvalidAgentRunDefaultsError extends Error {},
}));

jest.mock('server/services/agent/SourceService', () => ({
  __esModule: true,
  default: {
    getSessionSource: jest.fn(),
  },
}));

jest.mock('server/services/agent/ThreadService', () => ({
  __esModule: true,
  default: {
    getOwnedThreadWithSession: jest.fn(),
  },
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    canAcceptMessages: jest.fn(),
    getMessageBlockReason: jest.fn(),
    touchActivity: jest.fn(),
  },
}));

import { POST } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { resolveRequestGitHubToken } from 'server/lib/agentSession/githubToken';
import AgentCapabilityService from 'server/services/agent/CapabilityService';
import AgentProviderRegistry from 'server/services/agent/ProviderRegistry';
import AgentRunAdmissionService from 'server/services/agent/RunAdmissionService';
import AgentRunQueueService from 'server/services/agent/RunQueueService';
import AgentRunService from 'server/services/agent/RunService';
import AgentSourceService from 'server/services/agent/SourceService';
import AgentThreadService from 'server/services/agent/ThreadService';
import AgentSessionService from 'server/services/agentSession';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockResolveRequestGitHubToken = resolveRequestGitHubToken as jest.Mock;
const mockResolveSessionContext = AgentCapabilityService.resolveSessionContext as jest.Mock;
const mockResolveSelection = AgentProviderRegistry.resolveSelection as jest.Mock;
const mockCreateQueuedRunWithMessage = AgentRunAdmissionService.createQueuedRunWithMessage as jest.Mock;
const mockEnqueueRun = AgentRunQueueService.enqueueRun as jest.Mock;
const mockMarkQueuedRunDispatchFailed = AgentRunService.markQueuedRunDispatchFailed as jest.Mock;
const mockGetSessionSource = AgentSourceService.getSessionSource as jest.Mock;
const mockGetOwnedThreadWithSession = AgentThreadService.getOwnedThreadWithSession as jest.Mock;
const mockCanAcceptMessages = AgentSessionService.canAcceptMessages as jest.Mock;
const mockTouchActivity = AgentSessionService.touchActivity as jest.Mock;

function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/threads/thread-1/runs'),
  } as unknown as NextRequest;
}

describe('POST /api/v2/ai/agent/threads/[threadId]/runs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockResolveRequestGitHubToken.mockResolvedValue('sample-gh-token');
    mockGetOwnedThreadWithSession.mockResolvedValue({
      thread: { id: 7, uuid: 'thread-1' },
      session: {
        id: 17,
        uuid: 'session-1',
        defaultHarness: 'lifecycle_ai_sdk',
        defaultModel: 'gpt-5.4',
      },
    });
    mockCanAcceptMessages.mockReturnValue(true);
    mockGetSessionSource.mockResolvedValue({
      status: 'ready',
      sandboxRequirements: { filesystem: 'persistent' },
    });
    mockResolveSessionContext.mockResolvedValue({
      repoFullName: 'example-org/example-repo',
      approvalPolicy: 'on-request',
    });
    mockResolveSelection.mockResolvedValue({
      provider: 'openai',
      modelId: 'gpt-5.4',
    });
    mockCreateQueuedRunWithMessage.mockResolvedValue({
      run: {
        uuid: 'run-1',
        status: 'queued',
      },
      message: {
        uuid: 'message-1',
        clientMessageId: 'client-message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
      },
      created: true,
    });
    mockTouchActivity.mockResolvedValue(undefined);
    mockEnqueueRun.mockResolvedValue(undefined);
  });

  it('rejects run admission when no explicit or session model exists', async () => {
    mockGetOwnedThreadWithSession.mockResolvedValueOnce({
      thread: { id: 7, uuid: 'thread-1' },
      session: {
        id: 17,
        uuid: 'session-1',
        defaultHarness: 'lifecycle_ai_sdk',
        defaultModel: null,
      },
    });

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      }),
      { params: { threadId: 'thread-1' } }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Agent run model is required');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('resolves explicit-or-default values before queueing', async () => {
    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
        runtimeOptions: { maxIterations: 12 },
      }),
      { params: { threadId: 'thread-1' } }
    );

    expect(response.status).toBe(201);
    expect(mockResolveSelection).toHaveBeenCalledWith({
      repoFullName: 'example-org/example-repo',
      requestedProvider: undefined,
      requestedModelId: 'gpt-5.4',
    });
    expect(mockCreateQueuedRunWithMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
        requestedHarness: null,
        requestedProvider: null,
        requestedModel: null,
        resolvedHarness: 'lifecycle_ai_sdk',
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.4',
        runtimeOptions: { maxIterations: 12 },
      })
    );
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'submit', { githubToken: 'sample-gh-token' });
    const body = await response.json();
    expect(body.data).toEqual(
      expect.objectContaining({
        run: expect.objectContaining({ id: 'run-1', threadId: 'thread-1', sessionId: 'session-1' }),
        message: expect.objectContaining({ id: 'message-1', clientMessageId: 'client-message-1' }),
        links: {
          events: '/api/v2/ai/agent/runs/run-1/events',
          eventStream: '/api/v2/ai/agent/runs/run-1/events/stream',
          pendingActions: '/api/v2/ai/agent/threads/thread-1/pending-actions',
        },
      })
    );
  });

  it('rejects tool or UI payload parts in canonical input messages', async () => {
    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [
            {
              type: 'dynamic-tool',
              toolCallId: 'tool-call-1',
              state: 'output-available',
            },
          ],
        },
      }),
      { params: { threadId: 'thread-1' } }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('message must contain supported canonical parts and no role or metadata fields');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('rejects extra canonical part fields instead of stripping them', async () => {
    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [
            {
              type: 'text',
              text: 'Hi',
              providerMetadata: { traceId: 'trace-1' },
            },
          ],
        },
      }),
      { params: { threadId: 'thread-1' } }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('message must contain supported canonical parts and no role or metadata fields');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('rejects public message roles', async () => {
    const response = await POST(
      makeRequest({
        message: {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Nope' }],
        },
      }),
      { params: { threadId: 'thread-1' } }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('message must contain supported canonical parts and no role or metadata fields');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('rejects public message metadata', async () => {
    const response = await POST(
      makeRequest({
        message: {
          metadata: { runId: 'run-1' },
          parts: [{ type: 'text', text: 'Nope' }],
        },
      }),
      { params: { threadId: 'thread-1' } }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('message must contain supported canonical parts and no role or metadata fields');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('rejects unsupported runtime options', async () => {
    const response = await POST(
      makeRequest({
        message: {
          parts: [{ type: 'text', text: 'Hi' }],
        },
        runtimeOptions: { temperature: 0.7 },
      }),
      { params: { threadId: 'thread-1' } }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('runtimeOptions contains unsupported or invalid fields');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('rejects invalid model field types', async () => {
    const response = await POST(
      makeRequest({
        message: {
          parts: [{ type: 'text', text: 'Hi' }],
        },
        model: { id: 123 },
      }),
      { params: { threadId: 'thread-1' } }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('model must contain only provider and id fields');
    expect(mockResolveSelection).not.toHaveBeenCalled();
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('rejects public harness selection', async () => {
    const response = await POST(
      makeRequest({
        message: {
          parts: [{ type: 'text', text: 'Hi' }],
        },
        harness: { kind: 'lifecycle_ai_sdk' },
      }),
      { params: { threadId: 'thread-1' } }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Unsupported run request fields: harness');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('returns an idempotent response and emits a fresh dispatch signal for a queued run', async () => {
    mockCreateQueuedRunWithMessage.mockResolvedValueOnce({
      run: {
        uuid: 'run-1',
        status: 'queued',
      },
      message: {
        uuid: 'message-1',
        clientMessageId: 'client-message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
      },
      created: false,
    });

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      }),
      { params: { threadId: 'thread-1' } }
    );

    expect(response.status).toBe(200);
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'submit', { githubToken: 'sample-gh-token' });
  });

  it('marks a newly admitted queued run failed when activity touch fails before dispatch', async () => {
    mockTouchActivity.mockRejectedValueOnce(new Error('touch failed'));

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      }),
      { params: { threadId: 'thread-1' } }
    );

    expect(response.status).toBe(500);
    expect(mockMarkQueuedRunDispatchFailed).toHaveBeenCalledWith('run-1', expect.any(Error));
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('does not mark an existing queued run failed when idempotent retry activity touch fails', async () => {
    mockCreateQueuedRunWithMessage.mockResolvedValueOnce({
      run: {
        uuid: 'run-1',
        status: 'queued',
      },
      message: {
        uuid: 'message-1',
        clientMessageId: 'client-message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
      },
      created: false,
    });
    mockTouchActivity.mockRejectedValueOnce(new Error('touch failed'));

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      }),
      { params: { threadId: 'thread-1' } }
    );

    expect(response.status).toBe(500);
    expect(mockMarkQueuedRunDispatchFailed).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('maps missing threads to 404', async () => {
    mockGetOwnedThreadWithSession.mockRejectedValueOnce(new Error('Agent thread not found'));

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      }),
      { params: { threadId: 'missing-thread' } }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent thread not found');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('maps missing thread sessions to 404', async () => {
    mockGetOwnedThreadWithSession.mockRejectedValueOnce(new Error('Agent session not found'));

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      }),
      { params: { threadId: 'thread-1' } }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent session not found');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });
});
