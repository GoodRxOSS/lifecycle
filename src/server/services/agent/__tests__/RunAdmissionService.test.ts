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

jest.mock('server/models/AgentRun', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    transaction: jest.fn(),
  },
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

jest.mock('server/services/agent/MessageStore', () => ({
  __esModule: true,
  default: {
    findCanonicalMessageByClientMessageId: jest.fn(),
    insertUserMessageForRun: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunEventService', () => ({
  __esModule: true,
  default: {
    appendStatusEvent: jest.fn(),
  },
}));

jest.mock('server/lib/dependencies', () => ({}));

import AgentRun from 'server/models/AgentRun';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import AgentMessageStore from '../MessageStore';
import AgentRunAdmissionService from '../RunAdmissionService';
import AgentRunEventService from '../RunEventService';
import AgentRunService from '../RunService';

const mockRunQuery = AgentRun.query as jest.Mock;
const mockRunTransaction = AgentRun.transaction as jest.Mock;
const mockSessionQuery = AgentSession.query as jest.Mock;
const mockThreadQuery = AgentThread.query as jest.Mock;
const mockFindCanonicalMessageByClientMessageId = AgentMessageStore.findCanonicalMessageByClientMessageId as jest.Mock;
const mockInsertUserMessageForRun = AgentMessageStore.insertUserMessageForRun as jest.Mock;
const mockAppendStatusEvent = AgentRunEventService.appendStatusEvent as jest.Mock;

const runPlanSnapshot = {
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
    repoFullName: 'example-org/example-repo',
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
} as const;

const customRunPlanSnapshot = {
  ...runPlanSnapshot,
  agent: {
    id: 'custom.sample-agent',
    label: 'Sample custom agent',
    ownerKind: 'user',
    version: 3,
    sourceKind: 'freeform_chat',
    resourcePolicy: {
      sourceKinds: ['freeform_chat'],
      workspaceRequired: false,
      sandboxRequired: false,
    },
    modelPreference: {
      provider: 'anthropic',
      model: 'claude-sonnet-4.6',
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
} as const;

const resolvedInstructionRunPlanSnapshot = {
  ...runPlanSnapshot,
  prompt: {
    ...runPlanSnapshot.prompt,
    instructionRefs: ['system:freeform'],
    resolvedInstructions: [
      {
        ref: 'system:freeform',
        source: 'default',
        version: 1,
        hash: 'freeform-template-hash',
        renderedText: 'Use the admitted sample Free-form instructions.',
      },
    ],
    renderedHash: 'sha256:resolved-instruction-prompt',
  },
} as const;

function buildActiveRunQuery(activeRun: unknown = null) {
  const query = {
    where: jest.fn(),
    whereNotIn: jest.fn(),
    orderBy: jest.fn(),
    first: jest.fn().mockResolvedValue(activeRun),
  };
  query.where.mockReturnValue(query);
  query.whereNotIn.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return query;
}

describe('AgentRunAdmissionService', () => {
  let supersedeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    supersedeSpy = jest.spyOn(AgentRunService, 'supersedeRecoveryPausedRunForSession').mockResolvedValue(undefined);
    mockRunTransaction.mockImplementation(async (callback) => callback({ trx: true }));
    mockSessionQuery.mockReturnValue({
      findById: jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue({}),
      }),
    });
    mockThreadQuery.mockReturnValue({
      patchAndFetchById: jest.fn().mockResolvedValue({}),
    });
    mockFindCanonicalMessageByClientMessageId.mockResolvedValue(undefined);
    mockInsertUserMessageForRun.mockResolvedValue({ id: 31, uuid: 'message-1' });
    mockAppendStatusEvent.mockResolvedValue(undefined);
  });

  it('supersedes a recovery-paused run before the active-run admission guard evaluates', async () => {
    const activeRunQuery = buildActiveRunQuery();
    const insertRunQuery = {
      insertAndFetch: jest.fn().mockResolvedValue({ id: 23, uuid: 'run-1', status: 'queued' }),
    };
    mockRunQuery.mockReturnValueOnce(activeRunQuery).mockReturnValueOnce(insertRunQuery);
    const callOrder: string[] = [];
    supersedeSpy.mockImplementation(async () => {
      callOrder.push('supersede');
    });
    mockRunTransaction.mockImplementation(async (callback) => {
      callOrder.push('transaction');
      return callback({ trx: true });
    });

    await AgentRunAdmissionService.createQueuedRunWithMessage({
      thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['thread'],
      session: { id: 17, uuid: 'session-1', userId: 'sample-user' } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['session'],
      policy: { defaultMode: 'require_approval', rules: {} } as any,
      message: { parts: [{ type: 'text', text: 'Hi' }] },
      resolvedHarness: 'lifecycle_ai_sdk',
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.4',
      runPlanSnapshot,
    });

    expect(supersedeSpy).toHaveBeenCalledWith(17, 'sample-user');
    expect(callOrder).toEqual(['supersede', 'transaction']);
  });

  it('persists submitted message and queued run in the same transaction', async () => {
    const queuedRun = {
      id: 23,
      uuid: 'run-1',
      status: 'queued',
    };
    const activeRunQuery = buildActiveRunQuery();
    const insertRunQuery = {
      insertAndFetch: jest.fn().mockResolvedValue(queuedRun),
    };
    mockRunQuery.mockReturnValueOnce(activeRunQuery).mockReturnValueOnce(insertRunQuery);

    const admission = await AgentRunAdmissionService.createQueuedRunWithMessage({
      thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['thread'],
      session: { id: 17, uuid: 'session-1' } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['session'],
      policy: { defaultMode: 'require_approval', rules: {} } as any,
      message: { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
      resolvedHarness: 'lifecycle_ai_sdk',
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.4',
      runtimeOptions: { maxIterations: 12 },
      runPlanSnapshot,
    });

    expect(admission).toEqual({
      run: queuedRun,
      message: { id: 31, uuid: 'message-1' },
      created: true,
    });
    expect(mockInsertUserMessageForRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, uuid: 'thread-1' }),
      queuedRun,
      { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
      { trx: true }
    );
    expect(insertRunQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 7,
        sessionId: 17,
        status: 'queued',
        resolvedHarness: 'lifecycle_ai_sdk',
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.4',
        policySnapshot: expect.objectContaining({
          runtimeOptions: { maxIterations: 12 },
        }),
        runPlanSnapshot,
      })
    );
    expect(mockAppendStatusEvent).toHaveBeenCalledWith('run-1', 'run.queued', {
      threadId: 'thread-1',
      sessionId: 'session-1',
    });
  });

  it('persists resolved instruction snapshots without recomputing prompt text', async () => {
    const queuedRun = {
      id: 23,
      uuid: 'run-1',
      status: 'queued',
    };
    const activeRunQuery = buildActiveRunQuery();
    const insertRunQuery = {
      insertAndFetch: jest.fn().mockResolvedValue(queuedRun),
    };
    mockRunQuery.mockReturnValueOnce(activeRunQuery).mockReturnValueOnce(insertRunQuery);

    await AgentRunAdmissionService.createQueuedRunWithMessage({
      thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['thread'],
      session: { id: 17, uuid: 'session-1' } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['session'],
      policy: { defaultMode: 'require_approval', rules: {} } as any,
      message: { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
      resolvedHarness: 'lifecycle_ai_sdk',
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.4',
      runPlanSnapshot: resolvedInstructionRunPlanSnapshot,
    });

    expect(insertRunQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        runPlanSnapshot: resolvedInstructionRunPlanSnapshot,
      })
    );
  });

  it('accepts historical snapshots that do not have resolved instruction text', async () => {
    const queuedRun = {
      id: 23,
      uuid: 'run-1',
      status: 'queued',
    };
    const activeRunQuery = buildActiveRunQuery();
    const insertRunQuery = {
      insertAndFetch: jest.fn().mockResolvedValue(queuedRun),
    };
    mockRunQuery.mockReturnValueOnce(activeRunQuery).mockReturnValueOnce(insertRunQuery);

    await expect(
      AgentRunAdmissionService.createQueuedRunWithMessage({
        thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
          typeof AgentRunAdmissionService.createQueuedRunWithMessage
        >[0]['thread'],
        session: { id: 17, uuid: 'session-1' } as Parameters<
          typeof AgentRunAdmissionService.createQueuedRunWithMessage
        >[0]['session'],
        policy: { defaultMode: 'require_approval', rules: {} } as any,
        message: { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
        resolvedHarness: 'lifecycle_ai_sdk',
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.4',
        runPlanSnapshot,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        run: queuedRun,
        created: true,
      })
    );
  });

  it('does not persist messages when another run is active', async () => {
    const activeRunQuery = buildActiveRunQuery({ id: 99, uuid: 'run-active' });
    mockRunQuery.mockReturnValueOnce(activeRunQuery);

    await expect(
      AgentRunAdmissionService.createQueuedRunWithMessage({
        thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
          typeof AgentRunAdmissionService.createQueuedRunWithMessage
        >[0]['thread'],
        session: { id: 17, uuid: 'session-1' } as Parameters<
          typeof AgentRunAdmissionService.createQueuedRunWithMessage
        >[0]['session'],
        policy: { defaultMode: 'require_approval', rules: {} } as any,
        message: { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
        resolvedHarness: 'lifecycle_ai_sdk',
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.4',
        runPlanSnapshot,
      })
    ).rejects.toThrow('Wait for the current agent run to finish before starting another run.');

    expect(mockInsertUserMessageForRun).not.toHaveBeenCalled();
    expect(mockAppendStatusEvent).not.toHaveBeenCalled();
  });

  it('returns the existing run for duplicate client message ids', async () => {
    const existingMessage = {
      id: 31,
      uuid: 'message-1',
      runId: 23,
    };
    const existingRun = {
      id: 23,
      uuid: 'run-1',
      status: 'queued',
    };
    const findRunQuery = {
      findById: jest.fn().mockResolvedValue(existingRun),
    };
    mockFindCanonicalMessageByClientMessageId.mockResolvedValueOnce(existingMessage);
    mockRunQuery.mockReturnValueOnce(findRunQuery);

    const admission = await AgentRunAdmissionService.createQueuedRunWithMessage({
      thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['thread'],
      session: { id: 17, uuid: 'session-1' } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['session'],
      policy: { defaultMode: 'require_approval', rules: {} } as any,
      message: { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
      resolvedHarness: 'lifecycle_ai_sdk',
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.4',
      runPlanSnapshot: null as any,
    });

    expect(admission).toEqual({
      run: existingRun,
      message: existingMessage,
      created: false,
    });
    expect(mockInsertUserMessageForRun).not.toHaveBeenCalled();
    expect(mockAppendStatusEvent).not.toHaveBeenCalled();
  });

  it('persists custom-agent resolver fields without recomputing the snapshot', async () => {
    const queuedRun = {
      id: 23,
      uuid: 'run-1',
      status: 'queued',
    };
    const activeRunQuery = buildActiveRunQuery();
    const insertRunQuery = {
      insertAndFetch: jest.fn().mockResolvedValue(queuedRun),
    };
    mockRunQuery.mockReturnValueOnce(activeRunQuery).mockReturnValueOnce(insertRunQuery);

    await AgentRunAdmissionService.createQueuedRunWithMessage({
      thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['thread'],
      session: { id: 17, uuid: 'session-1' } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['session'],
      policy: customRunPlanSnapshot.runtime.approvalPolicy as any,
      message: { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
      requestedHarness: customRunPlanSnapshot.runtime.requestedHarness,
      requestedProvider: customRunPlanSnapshot.model.requestedProvider,
      requestedModel: customRunPlanSnapshot.model.requestedModel,
      resolvedHarness: customRunPlanSnapshot.runtime.resolvedHarness,
      resolvedProvider: customRunPlanSnapshot.model.resolvedProvider,
      resolvedModel: customRunPlanSnapshot.model.resolvedModel,
      sandboxRequirement: customRunPlanSnapshot.runtime.sandboxRequirement,
      runtimeOptions: customRunPlanSnapshot.runtime.runtimeOptions,
      runPlanSnapshot: customRunPlanSnapshot,
    });

    expect(insertRunQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedProvider: 'anthropic',
        requestedModel: 'claude-sonnet-4.6',
        resolvedProvider: 'anthropic',
        resolvedModel: 'claude-sonnet-4.6',
        sandboxRequirement: { filesystem: 'persistent' },
        policySnapshot: {
          defaultMode: 'require_approval',
          rules: { read: 'allow' },
          runtimeOptions: { maxIterations: 9 },
        },
        runPlanSnapshot: customRunPlanSnapshot,
      })
    );
  });

  it('rejects missing run plan snapshots before insert', async () => {
    const activeRunQuery = buildActiveRunQuery();
    mockRunQuery.mockReturnValueOnce(activeRunQuery);

    await expect(
      AgentRunAdmissionService.createQueuedRunWithMessage({
        thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
          typeof AgentRunAdmissionService.createQueuedRunWithMessage
        >[0]['thread'],
        session: { id: 17, uuid: 'session-1' } as Parameters<
          typeof AgentRunAdmissionService.createQueuedRunWithMessage
        >[0]['session'],
        policy: { defaultMode: 'require_approval', rules: {} } as any,
        message: { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
        resolvedHarness: 'lifecycle_ai_sdk',
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.4',
        runPlanSnapshot: null as any,
      })
    ).rejects.toThrow('Agent run plan snapshot is required.');

    expect(mockInsertUserMessageForRun).not.toHaveBeenCalled();
    expect(mockAppendStatusEvent).not.toHaveBeenCalled();
  });
});
