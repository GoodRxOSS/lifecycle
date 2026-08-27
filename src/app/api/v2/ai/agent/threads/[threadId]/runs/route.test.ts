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

jest.mock('server/lib/get-user', () => {
  const getRequestUserIdentity = jest.fn();
  return {
    getRequestUserIdentity,
    // requireRequestUserIdentity mirrors getRequestUserIdentity; throws 401 when unauthenticated.
    requireRequestUserIdentity: (...args: unknown[]) => {
      const id = getRequestUserIdentity(...args);
      if (!id) throw new (jest.requireActual('server/lib/appError').UnauthorizedError)();
      return id;
    },
  };
});

jest.mock('server/lib/agentSession/githubToken', () => ({
  resolveRequestGitHubToken: jest.fn(),
  resolveRequestGitHubAuth: jest.fn(),
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

jest.mock('server/services/agent/RunPlanResolver', () => ({
  __esModule: true,
  AgentRunPlanAgentUnavailableError: class AgentRunPlanAgentUnavailableError extends Error {
    constructor(
      public readonly agentId: string,
      public readonly reason: string,
      public readonly details?: Record<string, unknown>
    ) {
      super(`Agent "${agentId}" is unavailable: ${reason}.`);
      this.name = 'AgentRunPlanAgentUnavailableError';
    }
  },
  default: {
    resolveForRunAdmission: jest.fn(),
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
    hasPriorCompletedDebugIntentRun: jest.fn(),
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

jest.mock('server/services/agent/SessionReadService', () => ({
  __esModule: true,
  default: {
    getOwnedSessionRecord: jest.fn(),
  },
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    canAcceptMessages: jest.fn(),
    getMessageBlockReason: jest.fn(),
    touchActivity: jest.fn(),
    ensureSessionActive: jest.fn(),
  },
}));

import { POST } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { resolveRequestGitHubAuth } from 'server/lib/agentSession/githubToken';
import AgentRunAdmissionService from 'server/services/agent/RunAdmissionService';
import AgentRunPlanResolver, { AgentRunPlanAgentUnavailableError } from 'server/services/agent/RunPlanResolver';
import AgentRunQueueService from 'server/services/agent/RunQueueService';
import AgentRunService, { InvalidAgentRunDefaultsError } from 'server/services/agent/RunService';
import AgentSourceService from 'server/services/agent/SourceService';
import AgentThreadService from 'server/services/agent/ThreadService';
import AgentSessionReadService from 'server/services/agent/SessionReadService';
import AgentSessionService from 'server/services/agentSession';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockResolveRequestGitHubAuth = resolveRequestGitHubAuth as jest.Mock;
const mockCreateQueuedRunWithMessage = AgentRunAdmissionService.createQueuedRunWithMessage as jest.Mock;
const mockResolveForRunAdmission = AgentRunPlanResolver.resolveForRunAdmission as jest.Mock;
const mockEnqueueRun = AgentRunQueueService.enqueueRun as jest.Mock;
const mockIsActiveRunConflictError = AgentRunService.isActiveRunConflictError as jest.Mock;
const mockMarkQueuedRunDispatchFailed = AgentRunService.markQueuedRunDispatchFailed as jest.Mock;
const mockHasPriorCompletedDebugIntentRun = AgentRunService.hasPriorCompletedDebugIntentRun as jest.Mock;
const mockGetSessionSource = AgentSourceService.getSessionSource as jest.Mock;
const mockGetOwnedThreadWithSession = AgentThreadService.getOwnedThreadWithSession as jest.Mock;
const mockGetOwnedSessionRecord = AgentSessionReadService.getOwnedSessionRecord as jest.Mock;
const mockCanAcceptMessages = AgentSessionService.canAcceptMessages as jest.Mock;
const mockGetMessageBlockReason = AgentSessionService.getMessageBlockReason as jest.Mock;
const mockEnsureSessionActive = AgentSessionService.ensureSessionActive as jest.Mock;
const mockTouchActivity = AgentSessionService.touchActivity as jest.Mock;

const customAgentRunPlanSnapshot = {
  version: 1,
  capturedAt: '2026-05-01T00:00:00.000Z',
  agent: {
    id: 'custom.sample-agent',
    label: 'Sample custom agent',
    ownerKind: 'user',
    version: 3,
    sourceKind: 'freeform_chat',
    modelPreference: {
      provider: 'anthropic',
      model: 'claude-sonnet-4.6',
    },
  },
  source: {
    id: 'source-1',
    adapter: 'blank_workspace',
    status: 'ready',
    sessionKind: 'chat',
    freshness: {
      capturedAt: '2026-05-01T00:00:00.000Z',
      freshnessSource: 'source',
    },
  },
  model: {
    requestedProvider: 'anthropic',
    requestedModel: 'claude-sonnet-4.6',
    resolvedProvider: 'anthropic',
    resolvedModel: 'claude-sonnet-4.6',
  },
  runtime: {
    requestedHarness: null,
    resolvedHarness: 'lifecycle_ai_sdk',
    sandboxRequirement: { filesystem: 'persistent' },
    runtimeOptions: { maxIterations: 9 },
    approvalPolicy: {
      defaultMode: 'require_approval',
      rules: { read: 'allow' },
    },
  },
  prompt: {
    instructionRefs: [],
    instructionAddendum: 'Use the sample custom instructions.',
    renderedSummary: 'Sample custom agent description',
    renderedHash: 'sha256:sample-custom-agent-prompt',
  },
  capabilities: {
    provisionalCapabilityIds: ['read_context'],
    resolvedCapabilityAccess: [
      {
        capabilityId: 'read_context',
        availability: 'all_users',
        allowed: true,
        runtimeCapabilityKey: 'read',
        approvalMode: 'allow',
      },
    ],
  },
  warnings: [],
} as const;

function makeRequest(body: unknown, jsonError?: unknown): NextRequest {
  return {
    json: jsonError === undefined ? jest.fn().mockResolvedValue(body) : jest.fn().mockRejectedValue(jsonError),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/threads/thread-1/runs'),
  } as unknown as NextRequest;
}

function makeValidRunBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: {
      clientMessageId: 'client-message-1',
      parts: [{ type: 'text', text: 'Hi' }],
    },
    ...overrides,
  };
}

function makeRouteContext(threadId = 'thread-1') {
  return { params: Promise.resolve({ threadId }) };
}

describe('POST /api/v2/ai/agent/threads/[threadId]/runs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      roles: ['user'],
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockResolveRequestGitHubAuth.mockResolvedValue({
      githubToken: 'sample-gh-token',
      source: 'user',
      githubUsername: 'sample-user',
    });
    mockGetOwnedThreadWithSession.mockResolvedValue({
      thread: { id: 7, uuid: 'thread-1' },
      session: {
        id: 17,
        uuid: 'session-1',
        defaultHarness: 'lifecycle_ai_sdk',
        defaultModel: 'gpt-5.4',
      },
    });
    mockEnsureSessionActive.mockImplementation(async (session) => session);
    mockCanAcceptMessages.mockReturnValue(true);
    mockGetMessageBlockReason.mockReturnValue('Session cannot accept messages');
    mockIsActiveRunConflictError.mockReturnValue(false);
    mockGetSessionSource.mockResolvedValue({
      uuid: 'source-1',
      adapter: 'blank_workspace',
      status: 'ready',
      sandboxRequirements: { filesystem: 'persistent' },
    });
    mockResolveForRunAdmission.mockResolvedValue({
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      requestedHarness: null,
      requestedProvider: null,
      requestedModel: null,
      resolvedHarness: 'lifecycle_ai_sdk',
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.4',
      sandboxRequirement: { filesystem: 'persistent' },
      runtimeOptions: { maxIterations: 12 },
      runPlanSnapshot: {
        version: 1,
        capturedAt: '2026-05-01T00:00:00.000Z',
        agent: {
          id: 'system.agent',
          label: 'Lifecycle Agent',
          ownerKind: 'system',
          version: 1,
          sourceKind: 'freeform_chat',
          resourcePolicy: {
            sourceKinds: ['build_context_chat', 'workspace_session', 'freeform_chat'],
            workspaceRequired: false,
            sandboxRequired: false,
          },
          modelPreference: null,
        },
        source: {
          id: 'source-1',
          adapter: 'blank_workspace',
          status: 'ready',
          sessionKind: 'chat',
          freshness: {
            capturedAt: '2026-05-01T00:00:00.000Z',
            freshnessSource: 'source',
          },
        },
        model: {
          requestedProvider: null,
          requestedModel: null,
          resolvedProvider: 'openai',
          resolvedModel: 'gpt-5.4',
        },
        runtime: {
          requestedHarness: null,
          resolvedHarness: 'lifecycle_ai_sdk',
          sandboxRequirement: { filesystem: 'persistent' },
          runtimeOptions: { maxIterations: 12 },
          approvalPolicy: { defaultMode: 'require_approval', rules: {} },
        },
        prompt: {
          instructionRefs: [],
          renderedSummary: 'Sample prompt summary',
          renderedHash: 'sha256:sample-rendered-prompt',
        },
        capabilities: {
          provisionalCapabilityIds: [],
          resolvedCapabilityAccess: [],
        },
        warnings: [],
      },
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
    mockResolveForRunAdmission.mockRejectedValueOnce(new Error('Agent run model is required'));
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Agent run model is required');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('rejects run admission policy failures without queueing a run', async () => {
    mockResolveForRunAdmission.mockRejectedValueOnce(
      new Error('Agent capability "read_context" is unavailable: creator_capability_reserved.')
    );

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Agent capability "read_context" is unavailable: creator_capability_reserved.');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('maps workspace_required admission failures to 409 and does not queue a run', async () => {
    const workspaceFailure = {
      stage: 'connect_runtime',
      title: 'Workspace did not start',
      message: 'workspace pod failed',
      recordedAt: '2026-05-09T16:00:00.000Z',
      retryable: true,
      origin: 'chat_runtime',
    };
    mockResolveForRunAdmission.mockRejectedValueOnce(
      new AgentRunPlanAgentUnavailableError('system.develop', 'workspace_required', {
        sourceKind: 'freeform_chat',
      })
    );
    mockGetOwnedSessionRecord.mockResolvedValueOnce({
      session: { id: 'session-1' },
      sandbox: {
        status: 'failed',
        error: workspaceFailure,
      },
    });

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Update the sample file in the workspace' }],
        },
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Agent "system.develop" is unavailable: workspace_required.');
    expect(body.data).toEqual({
      sessionId: 'session-1',
      sessionUrl: '/api/v2/ai/agent/sessions/session-1',
      workspaceFailure,
    });
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
    expect(mockGetOwnedSessionRecord).toHaveBeenCalledWith('session-1', 'sample-user');
  });

  it('allows non-workspace runs when a chat workspaceStatus is failed', async () => {
    mockGetOwnedThreadWithSession.mockResolvedValueOnce({
      thread: { id: 7, uuid: 'thread-1' },
      session: {
        id: 17,
        uuid: 'session-1',
        defaultHarness: 'lifecycle_ai_sdk',
        defaultModel: 'gpt-5.4',
        workspaceStatus: 'failed',
      },
    });

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Summarize the sample thread' }],
        },
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );

    expect(response.status).toBe(201);
    expect(mockResolveForRunAdmission).toHaveBeenCalled();
    expect(mockCreateQueuedRunWithMessage).toHaveBeenCalled();
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'submit', {
      githubAuth: expect.objectContaining({
        githubToken: 'sample-gh-token',
        source: 'user',
        githubUsername: 'sample-user',
        writeAuthorized: false,
      }),
    });
  });

  it('queues submit runs with no GitHub auth when broker token resolution times out', async () => {
    mockResolveRequestGitHubAuth.mockImplementationOnce(() => new Promise(() => {}));

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Summarize the sample thread' }],
        },
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );

    expect(response.status).toBe(201);
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'submit', {
      githubAuth: {
        githubToken: null,
        source: 'none',
        githubUsername: null,
        writeAuthorized: false,
      },
    });
  }, 10_000);

  it('resolves explicit-or-default values before queueing', async () => {
    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
        runtimeOptions: { maxIterations: 12 },
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );

    expect(response.status).toBe(201);
    expect(mockResolveForRunAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ id: 7, uuid: 'thread-1' }),
        session: expect.objectContaining({ id: 17, uuid: 'session-1' }),
        source: expect.objectContaining({ uuid: 'source-1', status: 'ready' }),
        userIdentity: { userId: 'sample-user', githubUsername: 'sample-user', roles: ['user'] },
        requestedProvider: null,
        requestedModel: null,
        runtimeOptions: { maxIterations: 12 },
        messageText: 'Hi',
        requestedDebugIntent: null,
        findPriorCompletedDebugIntentRun: mockHasPriorCompletedDebugIntentRun,
      })
    );
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
        runPlanSnapshot: expect.objectContaining({
          version: 1,
          agent: expect.objectContaining({ id: 'system.agent' }),
        }),
      })
    );
    expect(mockResolveForRunAdmission.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateQueuedRunWithMessage.mock.invocationCallOrder[0]
    );
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'submit', {
      githubAuth: expect.objectContaining({
        githubToken: 'sample-gh-token',
        source: 'user',
        githubUsername: 'sample-user',
        writeAuthorized: false,
      }),
    });
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

  it('accepts high configured per-run max iterations', async () => {
    const response = await POST(
      makeRequest({
        message: {
          parts: [{ type: 'text', text: 'Hi' }],
        },
        runtimeOptions: { maxIterations: 250 },
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );

    expect(response.status).toBe(201);
    expect(mockResolveForRunAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOptions: { maxIterations: 250 },
      })
    );
  });

  it('forwards normalized Debug intent to run-plan admission', async () => {
    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Please investigate more' }],
        },
        debugIntent: ' investigate ',
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );

    expect(response.status).toBe(201);
    expect(mockResolveForRunAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        messageText: 'Please investigate more',
        requestedDebugIntent: 'investigate',
        findPriorCompletedDebugIntentRun: mockHasPriorCompletedDebugIntentRun,
      })
    );
  });

  it('rejects unsupported Debug intent values', async () => {
    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Please repair this' }],
        },
        debugIntent: 'fix',
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('debugIntent must be one of diagnose, investigate, or repair');
    expect(mockResolveForRunAdmission).not.toHaveBeenCalled();
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('passes a custom-agent runPlanSnapshot through queued run admission and response links', async () => {
    mockResolveForRunAdmission.mockResolvedValueOnce({
      approvalPolicy: customAgentRunPlanSnapshot.runtime.approvalPolicy,
      requestedHarness: null,
      requestedProvider: 'anthropic',
      requestedModel: 'claude-sonnet-4.6',
      resolvedHarness: 'lifecycle_ai_sdk',
      resolvedProvider: 'anthropic',
      resolvedModel: 'claude-sonnet-4.6',
      sandboxRequirement: { filesystem: 'persistent' },
      runtimeOptions: { maxIterations: 9 },
      runPlanSnapshot: customAgentRunPlanSnapshot,
    });

    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockCreateQueuedRunWithMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: customAgentRunPlanSnapshot.runtime.approvalPolicy,
        requestedProvider: 'anthropic',
        requestedModel: 'claude-sonnet-4.6',
        resolvedProvider: 'anthropic',
        resolvedModel: 'claude-sonnet-4.6',
        runtimeOptions: { maxIterations: 9 },
        runPlanSnapshot: customAgentRunPlanSnapshot,
      })
    );
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'submit', {
      githubAuth: expect.objectContaining({
        githubToken: 'sample-gh-token',
        source: 'user',
        githubUsername: 'sample-user',
        writeAuthorized: false,
      }),
    });
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('model must contain only provider and id fields');
    expect(mockResolveForRunAdmission).not.toHaveBeenCalled();
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Unsupported run request fields: harness');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('rejects public agent selection', async () => {
    const response = await POST(
      makeRequest({
        message: {
          parts: [{ type: 'text', text: 'Hi' }],
        },
        agent: { id: 'system.agent' },
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Unsupported run request fields: agent');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('rejects public agentId selection', async () => {
    const response = await POST(
      makeRequest({
        message: {
          parts: [{ type: 'text', text: 'Hi' }],
        },
        agentId: 'system.agent',
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Unsupported run request fields: agentId');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('rejects public run plan snapshots', async () => {
    const response = await POST(
      makeRequest({
        message: {
          parts: [{ type: 'text', text: 'Hi' }],
        },
        runPlanSnapshot: customAgentRunPlanSnapshot,
      }),
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Unsupported run request fields: runPlanSnapshot');
    expect(mockResolveForRunAdmission).not.toHaveBeenCalled();
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );

    expect(response.status).toBe(200);
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'submit', {
      githubAuth: expect.objectContaining({
        githubToken: 'sample-gh-token',
        source: 'user',
        githubUsername: 'sample-user',
        writeAuthorized: false,
      }),
    });
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
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
      { params: Promise.resolve({ threadId: 'missing-thread' }) }
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
      { params: Promise.resolve({ threadId: 'thread-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Agent session not found');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('requires an authenticated session before reading the request body', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);
    const request = makeRequest(makeValidRunBody());

    const response = await POST(request, makeRouteContext());

    expect(response.status).toBe(401);
    expect(request.json).not.toHaveBeenCalled();
    expect(mockGetOwnedThreadWithSession).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'null', body: null },
    { label: 'a primitive', body: 'message' },
    { label: 'an array', body: [] },
  ])('rejects a top-level body that is $label', async ({ body }) => {
    const response = await POST(makeRequest(body), makeRouteContext());
    const responseBody = await response.json();

    expect(response.status).toBe(400);
    expect(responseBody.error.message).toBe('Request body must be an object');
    expect(mockGetOwnedThreadWithSession).not.toHaveBeenCalled();
  });

  it('treats malformed JSON as an empty request and returns the canonical-message validation error', async () => {
    const response = await POST(makeRequest(undefined, new SyntaxError('invalid JSON')), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('message must contain supported canonical parts and no role or metadata fields');
    expect(mockGetOwnedThreadWithSession).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'omitted message', message: undefined },
    { label: 'null message', message: null },
    { label: 'primitive message', message: 'Hi' },
    { label: 'array message', message: [] },
    { label: 'unknown message field', message: { parts: [{ type: 'text', text: 'Hi' }], id: 'message-1' } },
    { label: 'non-string client id', message: { clientMessageId: 7, parts: [{ type: 'text', text: 'Hi' }] } },
    { label: 'non-array parts', message: { parts: { type: 'text', text: 'Hi' } } },
    { label: 'empty parts', message: { parts: [] } },
    { label: 'null part', message: { parts: [null] } },
    { label: 'primitive part', message: { parts: [7] } },
    { label: 'array part', message: { parts: [[]] } },
    { label: 'unknown part type', message: { parts: [{ type: 'tool_call' }] } },
    { label: 'empty text part', message: { parts: [{ type: 'text', text: '   ' }] } },
    { label: 'empty file reference', message: { parts: [{ type: 'file_ref' }] } },
    { label: 'empty source reference', message: { parts: [{ type: 'source_ref' }] } },
  ])('rejects a canonical message with $label', async ({ message }) => {
    const response = await POST(makeRequest({ message }), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('message must contain supported canonical parts and no role or metadata fields');
    expect(mockResolveForRunAdmission).not.toHaveBeenCalled();
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('normalizes all supported canonical input part types and omits a blank client id', async () => {
    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: '   ',
          parts: [
            { type: 'reasoning', text: 'Think carefully' },
            {
              type: 'file_ref',
              path: ' /workspace/sample.ts ',
              url: ' ',
              mediaType: ' text/typescript ',
              title: ' Sample ',
            },
            {
              type: 'source_ref',
              url: ' https://example.test/source ',
              title: ' Source ',
              sourceType: ' docs ',
            },
          ],
        },
      }),
      makeRouteContext()
    );

    expect(response.status).toBe(201);
    expect(mockCreateQueuedRunWithMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          parts: [
            { type: 'reasoning', text: 'Think carefully' },
            {
              type: 'file_ref',
              path: ' /workspace/sample.ts ',
              url: null,
              mediaType: ' text/typescript ',
              title: ' Sample ',
            },
            {
              type: 'source_ref',
              url: ' https://example.test/source ',
              title: ' Source ',
              sourceType: ' docs ',
              sourceId: null,
              mediaType: null,
            },
          ],
        },
      })
    );
  });

  it.each([
    { label: 'null', model: null },
    { label: 'a primitive', model: 'gpt-5.4' },
    { label: 'an array', model: [] },
    { label: 'an unknown field', model: { temperature: 0.2 } },
    { label: 'a non-string provider', model: { provider: 42 } },
  ])('rejects a model selection containing $label', async ({ model }) => {
    const response = await POST(makeRequest(makeValidRunBody({ model })), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('model must contain only provider and id fields');
    expect(mockResolveForRunAdmission).not.toHaveBeenCalled();
  });

  it('trims model selections and treats blank values as unspecified', async () => {
    const response = await POST(
      makeRequest(makeValidRunBody({ model: { provider: ' openai ', id: '   ' } })),
      makeRouteContext()
    );

    expect(response.status).toBe(201);
    expect(mockResolveForRunAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ requestedProvider: 'openai', requestedModel: null })
    );
  });

  it.each([
    { label: 'null', runtimeOptions: null },
    { label: 'a primitive', runtimeOptions: 'default' },
    { label: 'an array', runtimeOptions: [] },
    { label: 'a non-number iteration limit', runtimeOptions: { maxIterations: '12' } },
    { label: 'a fractional iteration limit', runtimeOptions: { maxIterations: 1.5 } },
    { label: 'a non-positive iteration limit', runtimeOptions: { maxIterations: 0 } },
  ])('rejects runtime options containing $label', async ({ runtimeOptions }) => {
    const response = await POST(makeRequest(makeValidRunBody({ runtimeOptions })), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('runtimeOptions contains unsupported or invalid fields');
    expect(mockResolveForRunAdmission).not.toHaveBeenCalled();
  });

  it('rejects a non-string Debug intent', async () => {
    const response = await POST(makeRequest(makeValidRunBody({ debugIntent: 7 })), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('debugIntent must be one of diagnose, investigate, or repair');
    expect(mockGetOwnedThreadWithSession).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a generic error', error: new Error('thread lookup failed') },
    { label: 'a non-Error rejection', error: 'thread lookup failed' },
  ])('returns 500 when owned-thread lookup rejects with $label', async ({ error }) => {
    mockGetOwnedThreadWithSession.mockRejectedValueOnce(error);

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());

    expect(response.status).toBe(500);
    expect(mockEnsureSessionActive).not.toHaveBeenCalled();
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('returns the session block reason when the active session cannot accept messages', async () => {
    mockCanAcceptMessages.mockReturnValueOnce(false);
    mockGetMessageBlockReason.mockReturnValueOnce('Session is stopping');

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Session is stopping');
    expect(mockGetSessionSource).not.toHaveBeenCalled();
    expect(mockResolveForRunAdmission).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing', source: null },
    { label: 'not ready', source: { uuid: 'source-1', status: 'pending' } },
  ])('rejects a session source that is $label', async ({ source }) => {
    mockGetSessionSource.mockResolvedValueOnce(source);

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Session source is not ready yet.');
    expect(mockResolveForRunAdmission).not.toHaveBeenCalled();
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('maps non-workspace agent unavailability to a 400 response', async () => {
    mockResolveForRunAdmission.mockRejectedValueOnce(
      new AgentRunPlanAgentUnavailableError('system.agent', 'source_kind_unsupported')
    );

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Agent "system.agent" is unavailable: source_kind_unsupported.');
    expect(mockGetOwnedSessionRecord).not.toHaveBeenCalled();
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('normalizes a non-Error run-plan rejection to the public invalid-model error', async () => {
    mockResolveForRunAdmission.mockRejectedValueOnce({ reason: 'bad model' });

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Invalid agent run model');
    expect(mockCreateQueuedRunWithMessage).not.toHaveBeenCalled();
  });

  it('maps an active-run admission conflict to 409 without touching or dispatching the run', async () => {
    const conflict = new Error('An active run already exists');
    mockCreateQueuedRunWithMessage.mockRejectedValueOnce(conflict);
    mockIsActiveRunConflictError.mockImplementationOnce((error) => error === conflict);

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('An active run already exists');
    expect(mockTouchActivity).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('maps invalid persisted run defaults to 400 without dispatching a run', async () => {
    mockCreateQueuedRunWithMessage.mockRejectedValueOnce(new InvalidAgentRunDefaultsError('Invalid defaults'));

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Invalid defaults');
    expect(mockTouchActivity).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('returns 500 when run admission fails unexpectedly', async () => {
    mockCreateQueuedRunWithMessage.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());

    expect(response.status).toBe(500);
    expect(mockTouchActivity).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('preserves the activity-touch failure when marking the queued run also fails', async () => {
    mockTouchActivity.mockRejectedValueOnce(new Error('touch failed'));
    mockMarkQueuedRunDispatchFailed.mockRejectedValueOnce(new Error('mark failed'));

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());

    expect(response.status).toBe(500);
    expect(mockMarkQueuedRunDispatchFailed).toHaveBeenCalledWith('run-1', expect.any(Error));
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('returns an existing non-queued run without dispatching it again', async () => {
    mockCreateQueuedRunWithMessage.mockResolvedValueOnce({
      run: { uuid: 'run-1', status: 'running' },
      message: {
        uuid: 'message-1',
        clientMessageId: 'client-message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
      },
      created: false,
    });

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.run).toEqual(expect.objectContaining({ id: 'run-1', status: 'running' }));
    expect(mockResolveRequestGitHubAuth).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('returns 500 when dispatch authentication fails', async () => {
    mockResolveRequestGitHubAuth.mockRejectedValueOnce(new Error('credential broker unavailable'));

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());

    expect(response.status).toBe(500);
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('returns 500 when the queue rejects the dispatch request', async () => {
    mockEnqueueRun.mockRejectedValueOnce(new Error('queue unavailable'));

    const response = await POST(makeRequest(makeValidRunBody()), makeRouteContext());

    expect(response.status).toBe(500);
    expect(mockEnqueueRun).toHaveBeenCalledTimes(1);
  });
});
