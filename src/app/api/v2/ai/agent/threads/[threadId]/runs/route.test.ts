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
  },
}));

import { POST } from './route';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { resolveRequestGitHubToken } from 'server/lib/agentSession/githubToken';
import AgentRunAdmissionService from 'server/services/agent/RunAdmissionService';
import AgentRunPlanResolver, { AgentRunPlanAgentUnavailableError } from 'server/services/agent/RunPlanResolver';
import AgentRunQueueService from 'server/services/agent/RunQueueService';
import AgentRunService from 'server/services/agent/RunService';
import AgentSourceService from 'server/services/agent/SourceService';
import AgentThreadService from 'server/services/agent/ThreadService';
import AgentSessionReadService from 'server/services/agent/SessionReadService';
import AgentSessionService from 'server/services/agentSession';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockResolveRequestGitHubToken = resolveRequestGitHubToken as jest.Mock;
const mockCreateQueuedRunWithMessage = AgentRunAdmissionService.createQueuedRunWithMessage as jest.Mock;
const mockResolveForRunAdmission = AgentRunPlanResolver.resolveForRunAdmission as jest.Mock;
const mockEnqueueRun = AgentRunQueueService.enqueueRun as jest.Mock;
const mockMarkQueuedRunDispatchFailed = AgentRunService.markQueuedRunDispatchFailed as jest.Mock;
const mockHasPriorCompletedDebugIntentRun = AgentRunService.hasPriorCompletedDebugIntentRun as jest.Mock;
const mockGetSessionSource = AgentSourceService.getSessionSource as jest.Mock;
const mockGetOwnedThreadWithSession = AgentThreadService.getOwnedThreadWithSession as jest.Mock;
const mockGetOwnedSessionRecord = AgentSessionReadService.getOwnedSessionRecord as jest.Mock;
const mockCanAcceptMessages = AgentSessionService.canAcceptMessages as jest.Mock;
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
          id: 'system.freeform',
          label: 'Free-form',
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
      { params: { threadId: 'thread-1' } }
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
      { params: { threadId: 'thread-1' } }
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
      { params: { threadId: 'thread-1' } }
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
      { params: { threadId: 'thread-1' } }
    );

    expect(response.status).toBe(201);
    expect(mockResolveForRunAdmission).toHaveBeenCalled();
    expect(mockCreateQueuedRunWithMessage).toHaveBeenCalled();
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'submit', { githubToken: 'sample-gh-token' });
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
    expect(mockResolveForRunAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ id: 7, uuid: 'thread-1' }),
        session: expect.objectContaining({ id: 17, uuid: 'session-1' }),
        source: expect.objectContaining({ uuid: 'source-1', status: 'ready' }),
        userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' },
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
          agent: expect.objectContaining({ id: 'system.freeform' }),
        }),
      })
    );
    expect(mockResolveForRunAdmission.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateQueuedRunWithMessage.mock.invocationCallOrder[0]
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

  it('forwards normalized Debug intent to run-plan admission', async () => {
    const response = await POST(
      makeRequest({
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Please investigate more' }],
        },
        debugIntent: ' investigate ',
      }),
      { params: { threadId: 'thread-1' } }
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
      { params: { threadId: 'thread-1' } }
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
      { params: { threadId: 'thread-1' } }
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
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'submit', { githubToken: 'sample-gh-token' });
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
      { params: { threadId: 'thread-1' } }
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
        agent: { id: 'system.freeform' },
      }),
      { params: { threadId: 'thread-1' } }
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
        agentId: 'system.freeform',
      }),
      { params: { threadId: 'thread-1' } }
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
      { params: { threadId: 'thread-1' } }
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
