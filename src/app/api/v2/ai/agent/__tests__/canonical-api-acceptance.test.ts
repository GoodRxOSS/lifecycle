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

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  AgentSessionRuntimeConfigError: class AgentSessionRuntimeConfigError extends Error {},
  AgentSessionWorkspaceStorageConfigError: class AgentSessionWorkspaceStorageConfigError extends Error {},
  resolveAgentSessionRuntimeConfig: jest.fn().mockResolvedValue({
    workspaceStorage: {
      defaultSize: '10Gi',
      allowedSizes: ['10Gi'],
      allowClientOverride: false,
      accessMode: 'ReadWriteOnce',
    },
  }),
  resolveAgentSessionWorkspaceStorageIntent: jest.fn(() => ({
    requestedSize: null,
    storageSize: '10Gi',
    accessMode: 'ReadWriteOnce',
  })),
}));

jest.mock('server/services/agent/ChatSessionService', () => ({
  __esModule: true,
  default: {
    createChatSession: jest.fn(),
  },
}));

jest.mock('server/services/agent/SessionReadService', () => ({
  __esModule: true,
  DEFAULT_AGENT_SESSION_LIST_LIMIT: 25,
  MAX_AGENT_SESSION_LIST_LIMIT: 100,
  default: {
    listOwnedSessionRecords: jest.fn(),
    serializeSessionRecord: jest.fn(),
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
  ActiveEnvironmentSessionError: class ActiveEnvironmentSessionError extends Error {},
}));

jest.mock('server/services/agent/SourceService', () => ({
  __esModule: true,
  default: {
    getSessionSource: jest.fn(),
  },
}));

jest.mock('server/services/agent/CapabilityService', () => ({
  __esModule: true,
  default: {
    resolveSessionContext: jest.fn(),
  },
}));

jest.mock('server/services/agent/ProviderRegistry', () => ({
  __esModule: true,
  MissingAgentProviderApiKeyError: class MissingAgentProviderApiKeyError extends Error {},
  default: {
    resolveSelection: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunAdmissionService', () => ({
  __esModule: true,
  default: {
    createQueuedRunWithMessage: jest.fn(),
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
  InvalidAgentRunDefaultsError: class InvalidAgentRunDefaultsError extends Error {},
  default: {
    getOwnedRun: jest.fn(),
    isActiveRunConflictError: jest.fn(),
    isRunNotFoundError: jest.fn(),
    markFailed: jest.fn(),
    markQueuedRunDispatchFailed: jest.fn(),
    serializeRun: jest.fn(),
  },
}));

jest.mock('server/services/agent/MessageStore', () => ({
  __esModule: true,
  DEFAULT_AGENT_MESSAGE_PAGE_LIMIT: 50,
  MAX_AGENT_MESSAGE_PAGE_LIMIT: 100,
  default: {
    listCanonicalMessages: jest.fn(),
    serializeCanonicalMessage: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunEventService', () => ({
  __esModule: true,
  DEFAULT_RUN_EVENT_PAGE_LIMIT: 100,
  MAX_RUN_EVENT_PAGE_LIMIT: 500,
  default: {
    createCanonicalRunEventStream: jest.fn(),
    listRunEventsPageForRun: jest.fn(),
    serializeRunEvent: jest.fn(),
  },
}));

jest.mock('server/services/agent/ApprovalService', () => ({
  __esModule: true,
  default: {
    listPendingActions: jest.fn(),
    normalizePendingActionResponseBody: jest.fn((body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return new Error('Request body must be a JSON object');
      }
      const response = body as Record<string, unknown>;
      if (typeof response.approved !== 'boolean') {
        return new Error('approved must be a boolean');
      }

      return {
        approved: response.approved,
        reason: typeof response.reason === 'string' ? response.reason : null,
      };
    }),
    resolvePendingAction: jest.fn(),
    serializePendingAction: jest.fn(),
  },
}));

import { getRequestUserIdentity } from 'server/lib/get-user';
import { resolveRequestGitHubToken } from 'server/lib/agentSession/githubToken';
import AgentChatSessionService from 'server/services/agent/ChatSessionService';
import AgentSessionReadService from 'server/services/agent/SessionReadService';
import AgentThreadService from 'server/services/agent/ThreadService';
import AgentSessionService from 'server/services/agentSession';
import AgentSourceService from 'server/services/agent/SourceService';
import AgentCapabilityService from 'server/services/agent/CapabilityService';
import AgentProviderRegistry from 'server/services/agent/ProviderRegistry';
import AgentRunAdmissionService from 'server/services/agent/RunAdmissionService';
import AgentRunQueueService from 'server/services/agent/RunQueueService';
import AgentRunService from 'server/services/agent/RunService';
import AgentMessageStore from 'server/services/agent/MessageStore';
import AgentRunEventService from 'server/services/agent/RunEventService';
import ApprovalService from 'server/services/agent/ApprovalService';
import { POST as createSession } from '../sessions/route';
import { POST as createRun } from '../threads/[threadId]/runs/route';
import { GET as getMessages } from '../threads/[threadId]/messages/route';
import { GET as getRunEvents } from '../runs/[runId]/events/route';
import { GET as streamRunEvents } from '../runs/[runId]/events/stream/route';
import { GET as getPendingActions } from '../threads/[threadId]/pending-actions/route';
import { POST as respondToPendingAction } from '../pending-actions/[actionId]/respond/route';

const mockGetRequestUserIdentity = getRequestUserIdentity as jest.Mock;
const mockResolveRequestGitHubToken = resolveRequestGitHubToken as jest.Mock;
const mockCreateChatSession = AgentChatSessionService.createChatSession as jest.Mock;
const mockSerializeSessionRecord = AgentSessionReadService.serializeSessionRecord as jest.Mock;
const mockGetOwnedThreadWithSession = AgentThreadService.getOwnedThreadWithSession as jest.Mock;
const mockCanAcceptMessages = AgentSessionService.canAcceptMessages as jest.Mock;
const mockTouchActivity = AgentSessionService.touchActivity as jest.Mock;
const mockGetSessionSource = AgentSourceService.getSessionSource as jest.Mock;
const mockResolveSessionContext = AgentCapabilityService.resolveSessionContext as jest.Mock;
const mockResolveSelection = AgentProviderRegistry.resolveSelection as jest.Mock;
const mockCreateQueuedRunWithMessage = AgentRunAdmissionService.createQueuedRunWithMessage as jest.Mock;
const mockEnqueueRun = AgentRunQueueService.enqueueRun as jest.Mock;
const mockGetOwnedRun = AgentRunService.getOwnedRun as jest.Mock;
const mockSerializeRun = AgentRunService.serializeRun as jest.Mock;
const mockListCanonicalMessages = AgentMessageStore.listCanonicalMessages as jest.Mock;
const mockSerializeCanonicalMessage = AgentMessageStore.serializeCanonicalMessage as jest.Mock;
const mockListRunEventsPageForRun = AgentRunEventService.listRunEventsPageForRun as jest.Mock;
const mockCreateCanonicalRunEventStream = AgentRunEventService.createCanonicalRunEventStream as jest.Mock;
const mockSerializeRunEvent = AgentRunEventService.serializeRunEvent as jest.Mock;
const mockListPendingActions = ApprovalService.listPendingActions as jest.Mock;
const mockResolvePendingAction = ApprovalService.resolvePendingAction as jest.Mock;
const mockSerializePendingAction = ApprovalService.serializePendingAction as jest.Mock;

type CanonicalMessage = {
  id: string;
  clientMessageId: string | null;
  threadId: string;
  runId: string | null;
  role: 'user' | 'assistant';
  parts: Array<Record<string, unknown>>;
  createdAt: string;
};

type RunEvent = {
  uuid: string;
  runUuid: string;
  threadUuid: string;
  sessionUuid: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type PendingAction = {
  id: string;
  kind: string;
  status: 'pending' | 'approved' | 'denied';
  threadId: string;
  runId: string;
  title: string;
  description: string;
  requestedAt: string;
  expiresAt: string | null;
  toolName: string;
  argumentsSummary: Array<{ name: string; value: string }>;
  commandPreview: string | null;
  fileChangePreview: Array<Record<string, unknown>>;
  riskLabels: string[];
};

const sampleUser = {
  userId: 'sample-user',
  githubUsername: 'sample-user',
};

const state = {
  session: {
    id: 17,
    uuid: 'session-1',
    defaultHarness: 'lifecycle_ai_sdk',
    defaultModel: 'gpt-5.4',
  },
  thread: {
    id: 7,
    uuid: 'thread-1',
  },
  run: {
    id: 31,
    uuid: 'run-1',
    status: 'queued',
  },
  messages: [] as CanonicalMessage[],
  events: [] as RunEvent[],
  pendingAction: null as PendingAction | null,
};

function makeRequest(url: string, body?: unknown, headers: [string, string][] = []): NextRequest {
  return {
    ...(body !== undefined ? { json: jest.fn().mockResolvedValue(body) } : {}),
    headers: new Headers([['x-request-id', 'req-test'], ...headers]),
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

function serializeEvent(event: RunEvent) {
  return {
    id: event.uuid,
    runId: event.runUuid,
    threadId: event.threadUuid,
    sessionId: event.sessionUuid,
    sequence: event.sequence,
    eventType: event.eventType,
    version: 1,
    payload: event.payload,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function appendEvent(eventType: string, payload: Record<string, unknown>) {
  const sequence = state.events.length + 1;
  state.events.push({
    uuid: `event-${sequence}`,
    runUuid: state.run.uuid,
    threadUuid: state.thread.uuid,
    sessionUuid: state.session.uuid,
    sequence,
    eventType,
    payload,
    createdAt: '2026-04-25T00:00:00.000Z',
    updatedAt: '2026-04-25T00:00:00.000Z',
  });
}

function buildSseStream(runId: string, afterSequence: number): ReadableStream<Uint8Array> {
  const events = state.events
    .filter((event) => event.runUuid === runId && event.sequence > afterSequence)
    .map(serializeEvent);

  const body = events
    .map((event) =>
      [`id: ${event.sequence}`, `event: ${event.eventType}`, `data: ${JSON.stringify(event)}`, ''].join('\n')
    )
    .join('\n');

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body ? `${body}\n` : ''));
      controller.close();
    },
  });
}

function serializeMessage(
  message: {
    uuid: string;
    clientMessageId?: string | null;
    role: 'user' | 'assistant';
    parts: Array<Record<string, unknown>>;
    createdAt?: string | null;
  },
  runUuid?: string | null
): CanonicalMessage {
  return {
    id: message.uuid,
    clientMessageId: message.clientMessageId || null,
    threadId: state.thread.uuid,
    runId: runUuid || null,
    role: message.role,
    parts: message.parts,
    createdAt: message.createdAt || '2026-04-25T00:00:00.000Z',
  };
}

function simulateApprovalRequest() {
  state.run.status = 'waiting_for_approval';
  state.pendingAction = {
    id: 'action-1',
    kind: 'tool_approval',
    status: 'pending',
    threadId: state.thread.uuid,
    runId: state.run.uuid,
    title: 'Approve workspace edit',
    description: 'A workspace edit requires approval.',
    requestedAt: '2026-04-25T00:00:00.000Z',
    expiresAt: null,
    toolName: 'mcp__sandbox__workspace_edit_file',
    argumentsSummary: [{ name: 'path', value: 'sample-file.txt' }],
    commandPreview: null,
    fileChangePreview: [
      {
        path: 'sample-file.txt',
        action: 'edited',
        summary: 'Updated sample-file.txt',
        additions: 1,
        deletions: 1,
        truncated: false,
      },
    ],
    riskLabels: ['Workspace write'],
  };
  appendEvent('approval.requested', {
    actionId: state.pendingAction.id,
    approvalId: 'approval-1',
    toolCallId: 'tool-call-1',
  });
  appendEvent('run.waiting_for_approval', {
    status: 'waiting_for_approval',
  });
}

function simulateTerminalCompletion(approved: boolean, reason: string | null) {
  if (!state.pendingAction) {
    throw new Error('Expected a pending action before completion');
  }

  state.pendingAction = {
    ...state.pendingAction,
    status: approved ? 'approved' : 'denied',
  };
  appendEvent('approval.resolved', {
    actionId: state.pendingAction.id,
    approvalId: 'approval-1',
    toolCallId: 'tool-call-1',
    approved,
    reason,
  });
  appendEvent('approval.responded', {
    actionId: state.pendingAction.id,
    approvalId: 'approval-1',
    toolCallId: 'tool-call-1',
    approved,
    reason,
  });
  state.run.status = 'completed';
  appendEvent('run.completed', {
    status: 'completed',
  });
  state.messages.push({
    id: 'message-2',
    clientMessageId: null,
    threadId: state.thread.uuid,
    runId: state.run.uuid,
    role: 'assistant',
    parts: [{ type: 'text', text: 'The workspace edit is complete.' }],
    createdAt: '2026-04-25T00:00:05.000Z',
  });
}

describe('canonical agent session API acceptance flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.run.status = 'queued';
    state.messages = [];
    state.events = [];
    state.pendingAction = null;

    mockGetRequestUserIdentity.mockReturnValue(sampleUser);
    mockResolveRequestGitHubToken.mockResolvedValue('sample-gh-token');
    mockCreateChatSession.mockResolvedValue(state.session);
    mockSerializeSessionRecord.mockResolvedValue({
      id: state.session.uuid,
      status: 'ready',
      model: 'gpt-5.4',
      harness: 'lifecycle_ai_sdk',
      userId: sampleUser.userId,
      defaultThreadId: state.thread.uuid,
      sessionKind: 'chat',
      workspaceStatus: 'ready',
      chatStatus: 'ready',
      source: { adapter: 'blank_workspace', status: 'ready' },
      sandbox: { status: 'ready' },
      canonical: { id: state.session.uuid },
    });
    mockGetOwnedThreadWithSession.mockResolvedValue({
      thread: state.thread,
      session: state.session,
    });
    mockCanAcceptMessages.mockReturnValue(true);
    mockGetSessionSource.mockResolvedValue({
      status: 'ready',
      sandboxRequirements: { filesystem: 'persistent' },
    });
    mockResolveSessionContext.mockResolvedValue({
      approvalPolicy: { defaultMode: 'require_approval', rules: {} },
      repoFullName: 'example-org/example-repo',
    });
    mockResolveSelection.mockResolvedValue({
      provider: 'openai',
      modelId: 'gpt-5.4',
    });
    mockCreateQueuedRunWithMessage.mockImplementation(async ({ message }) => {
      const storedMessage = {
        uuid: 'message-1',
        clientMessageId: message.clientMessageId || null,
        role: 'user' as const,
        parts: message.parts,
        createdAt: '2026-04-25T00:00:00.000Z',
      };
      state.messages = [serializeMessage(storedMessage, state.run.uuid)];
      appendEvent('run.queued', { status: 'queued' });

      return {
        run: state.run,
        message: storedMessage,
        created: true,
      };
    });
    mockTouchActivity.mockResolvedValue(undefined);
    mockEnqueueRun.mockResolvedValue(undefined);
    mockSerializeRun.mockImplementation((run) => ({
      id: run.uuid,
      status: run.status,
    }));
    mockSerializeCanonicalMessage.mockImplementation((message, _threadUuid, runUuid) =>
      serializeMessage(message, runUuid)
    );
    mockListCanonicalMessages.mockImplementation(async () => ({
      thread: {
        id: state.thread.uuid,
        sessionId: state.session.uuid,
        title: null,
        isDefault: true,
        archivedAt: null,
        lastRunAt: null,
        metadata: {},
        createdAt: null,
        updatedAt: null,
      },
      messages: state.messages,
      pagination: {
        hasMore: false,
        nextBeforeMessageId: null,
      },
    }));
    mockGetOwnedRun.mockImplementation(async (runId) => {
      if (runId !== state.run.uuid) {
        throw new Error('Agent run not found');
      }

      return state.run;
    });
    (AgentRunService.isRunNotFoundError as jest.Mock).mockImplementation((error) => {
      return error instanceof Error && error.message === 'Agent run not found';
    });
    (AgentRunService.isActiveRunConflictError as jest.Mock).mockReturnValue(false);
    mockListRunEventsPageForRun.mockImplementation(async (_run, { afterSequence, limit }) => {
      const events = state.events.filter((event) => event.sequence > afterSequence).slice(0, limit);
      const nextSequence = events.length > 0 ? events[events.length - 1].sequence : afterSequence;

      return {
        events,
        nextSequence,
        hasMore: state.events.some((event) => event.sequence > nextSequence),
        run: {
          id: state.run.uuid,
          status: state.run.status,
        },
        limit,
        maxLimit: 500,
      };
    });
    mockSerializeRunEvent.mockImplementation(serializeEvent);
    mockCreateCanonicalRunEventStream.mockImplementation(buildSseStream);
    mockListPendingActions.mockImplementation(async () => (state.pendingAction ? [state.pendingAction] : []));
    mockResolvePendingAction.mockImplementation(async (_actionId, _userId, _status, resolution) => {
      simulateTerminalCompletion(
        resolution.approved === true,
        typeof resolution.reason === 'string' ? resolution.reason : null
      );
      return state.pendingAction;
    });
    mockSerializePendingAction.mockImplementation((action) => action);
  });

  it('exercises the canonical non-UI chat client contract end to end', async () => {
    const sessionResponse = await createSession(
      makeRequest('http://localhost/api/v2/ai/agent/sessions', {
        source: { adapter: 'blank_workspace' },
        defaults: { model: 'gpt-5.4' },
      })
    );
    const sessionBody = await sessionResponse.json();
    const threadId = sessionBody.data.defaultThreadId;

    expect(sessionResponse.status).toBe(201);
    expect(threadId).toBe('thread-1');
    expect(mockCreateChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sample-user',
        model: 'gpt-5.4',
      })
    );

    const runResponse = await createRun(
      makeRequest(`http://localhost/api/v2/ai/agent/threads/${threadId}/runs`, {
        message: {
          clientMessageId: 'client-message-1',
          parts: [{ type: 'text', text: 'Inspect the workspace and summarize the main entrypoints.' }],
        },
      }),
      { params: { threadId } }
    );
    const runBody = await runResponse.json();
    const runId = runBody.data.run.id;

    expect(runResponse.status).toBe(201);
    expect(runBody.data).toEqual(
      expect.objectContaining({
        run: {
          id: 'run-1',
          status: 'queued',
          threadId: 'thread-1',
          sessionId: 'session-1',
        },
        message: {
          id: 'message-1',
          clientMessageId: 'client-message-1',
          threadId: 'thread-1',
          runId: 'run-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Inspect the workspace and summarize the main entrypoints.' }],
          createdAt: '2026-04-25T00:00:00.000Z',
        },
        links: {
          events: '/api/v2/ai/agent/runs/run-1/events',
          eventStream: '/api/v2/ai/agent/runs/run-1/events/stream',
          pendingActions: '/api/v2/ai/agent/threads/thread-1/pending-actions',
        },
      })
    );
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-1', 'submit', { githubToken: 'sample-gh-token' });

    const initialMessagesResponse = await getMessages(
      makeRequest(`http://localhost/api/v2/ai/agent/threads/${threadId}/messages`),
      { params: { threadId } }
    );
    const initialMessagesBody = await initialMessagesResponse.json();

    expect(initialMessagesResponse.status).toBe(200);
    expect(initialMessagesBody.data.messages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        clientMessageId: 'client-message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Inspect the workspace and summarize the main entrypoints.' }],
      }),
    ]);

    simulateApprovalRequest();

    const eventsResponse = await getRunEvents(
      makeRequest(`http://localhost/api/v2/ai/agent/runs/${runId}/events?afterSequence=0&limit=100`),
      { params: { runId } }
    );
    const eventsBody = await eventsResponse.json();

    expect(eventsResponse.status).toBe(200);
    expect(eventsBody.data.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sequence: 1, eventType: 'run.queued' }),
        expect.objectContaining({
          sequence: 2,
          eventType: 'approval.requested',
          payload: expect.objectContaining({ actionId: 'action-1' }),
        }),
        expect.objectContaining({ sequence: 3, eventType: 'run.waiting_for_approval' }),
      ])
    );

    const streamResponse = await streamRunEvents(
      makeRequest(`http://localhost/api/v2/ai/agent/runs/${runId}/events/stream?afterSequence=0`, undefined, [
        ['last-event-id', '1'],
      ]),
      { params: { runId } }
    );
    const streamBody = await streamResponse.text();

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toBe('text/event-stream');
    expect(mockCreateCanonicalRunEventStream).toHaveBeenCalledWith('run-1', 1);
    expect(streamBody).not.toContain('id: 1');
    expect(streamBody).toContain('id: 2');
    expect(streamBody).toContain('event: approval.requested');
    expect(streamBody).toContain('"actionId":"action-1"');

    const pendingActionsResponse = await getPendingActions(
      makeRequest(`http://localhost/api/v2/ai/agent/threads/${threadId}/pending-actions`),
      { params: { threadId } }
    );
    const pendingActionsBody = await pendingActionsResponse.json();

    expect(pendingActionsResponse.status).toBe(200);
    expect(pendingActionsBody.data.pendingActions).toEqual([
      expect.objectContaining({
        id: 'action-1',
        kind: 'tool_approval',
        status: 'pending',
        threadId: 'thread-1',
        runId: 'run-1',
        title: 'Approve workspace edit',
        argumentsSummary: [{ name: 'path', value: 'sample-file.txt' }],
        riskLabels: ['Workspace write'],
      }),
    ]);

    const approvalResponse = await respondToPendingAction(
      makeRequest('http://localhost/api/v2/ai/agent/pending-actions/action-1/respond', {
        approved: true,
        reason: 'approved for acceptance flow',
      }),
      { params: { actionId: 'action-1' } }
    );
    const approvalBody = await approvalResponse.json();

    expect(approvalResponse.status).toBe(200);
    expect(mockResolvePendingAction).toHaveBeenCalledWith(
      'action-1',
      'sample-user',
      'approved',
      {
        approved: true,
        reason: 'approved for acceptance flow',
        source: 'endpoint',
      },
      { githubToken: 'sample-gh-token' }
    );
    expect(approvalBody.data).toEqual(
      expect.objectContaining({
        id: 'action-1',
        status: 'approved',
      })
    );

    const terminalEventsResponse = await getRunEvents(
      makeRequest(`http://localhost/api/v2/ai/agent/runs/${runId}/events?afterSequence=0&limit=100`),
      { params: { runId } }
    );
    const terminalEventsBody = await terminalEventsResponse.json();

    expect(terminalEventsResponse.status).toBe(200);
    expect(terminalEventsBody.data.run).toEqual({
      id: 'run-1',
      status: 'completed',
    });
    expect(terminalEventsBody.data.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'approval.resolved' }),
        expect.objectContaining({ eventType: 'approval.responded' }),
        expect.objectContaining({ eventType: 'run.completed' }),
      ])
    );

    const finalMessagesResponse = await getMessages(
      makeRequest(`http://localhost/api/v2/ai/agent/threads/${threadId}/messages`),
      { params: { threadId } }
    );
    const finalMessagesBody = await finalMessagesResponse.json();

    expect(finalMessagesResponse.status).toBe(200);
    expect(finalMessagesBody.data.messages).toEqual([
      expect.objectContaining({ id: 'message-1', role: 'user' }),
      {
        id: 'message-2',
        clientMessageId: null,
        threadId: 'thread-1',
        runId: 'run-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'The workspace edit is complete.' }],
        createdAt: '2026-04-25T00:00:05.000Z',
      },
    ]);
  });
});
