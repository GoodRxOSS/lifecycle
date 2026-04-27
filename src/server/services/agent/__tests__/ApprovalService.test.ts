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

jest.mock('ai', () => ({
  __esModule: true,
  getToolName: jest.fn(() => 'tool'),
  isToolUIPart: jest.fn((part) => !!part && typeof part === 'object' && 'state' in part),
}));

jest.mock('server/models/AgentPendingAction', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    transaction: jest.fn((callback) => callback({ trx: true })),
  },
}));

jest.mock('server/models/AgentRun', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('../ThreadService', () => ({
  __esModule: true,
  default: {
    getOwnedThread: jest.fn(),
  },
}));

const mockGetRunByUuid = jest.fn();
const mockPatchStatus = jest.fn();

jest.mock('../RunService', () => ({
  __esModule: true,
  default: {
    getRunByUuid: (...args: unknown[]) => mockGetRunByUuid(...args),
    patchStatus: (...args: unknown[]) => mockPatchStatus(...args),
  },
}));

const mockAppendStatusEvent = jest.fn();
const mockAppendStatusEventForRunInTransaction = jest.fn();
const mockNotifyRunEventsInserted = jest.fn();

jest.mock('../RunEventService', () => ({
  __esModule: true,
  default: {
    appendStatusEvent: (...args: unknown[]) => mockAppendStatusEvent(...args),
    appendStatusEventForRunInTransaction: (...args: unknown[]) => mockAppendStatusEventForRunInTransaction(...args),
    notifyRunEventsInserted: (...args: unknown[]) => mockNotifyRunEventsInserted(...args),
  },
}));

const mockEnqueueRun = jest.fn();

jest.mock('../RunQueueService', () => ({
  __esModule: true,
  default: {
    enqueueRun: (...args: unknown[]) => mockEnqueueRun(...args),
  },
}));

import AgentPendingAction from 'server/models/AgentPendingAction';
import AgentRun from 'server/models/AgentRun';
import ApprovalService from '../ApprovalService';
import AgentThreadService from '../ThreadService';
import { getToolName } from 'ai';

const mockPendingActionQuery = AgentPendingAction.query as jest.Mock;
const mockPendingActionTransaction = AgentPendingAction.transaction as jest.Mock;
const mockRunQuery = AgentRun.query as jest.Mock;
const mockGetOwnedThread = AgentThreadService.getOwnedThread as jest.Mock;
const mockGetToolName = getToolName as jest.Mock;

function makeTransactionalPendingActionQuery(...firstResults: unknown[]) {
  const query: any = {};
  query.alias = jest.fn().mockReturnValue(query);
  query.joinRelated = jest.fn().mockReturnValue(query);
  query.where = jest.fn().mockReturnValue(query);
  query.select = jest.fn().mockReturnValue(query);
  query.forUpdate = jest.fn().mockReturnValue(query);
  query.first = jest.fn();
  for (const result of firstResults) {
    query.first.mockResolvedValueOnce(result);
  }
  query.patchAndFetchById = jest
    .fn()
    .mockImplementation((_id, patch) => Promise.resolve({ ...firstResults[0], ...patch }));
  return query;
}

function makeTransactionalRunQuery(run: unknown, queuedRun?: unknown) {
  const query: any = {};
  query.findById = jest.fn().mockReturnValue({
    forUpdate: jest.fn().mockResolvedValue(run),
  });
  query.patchAndFetchById = jest.fn().mockResolvedValue(queuedRun || run);
  return query;
}

describe('ApprovalService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPendingActionTransaction.mockImplementation((callback) => callback({ trx: true }));
    mockAppendStatusEventForRunInTransaction.mockResolvedValue(7);
  });

  it('normalizes canonical pending action response bodies', () => {
    expect(
      ApprovalService.normalizePendingActionResponseBody({
        approved: true,
        reason: 'looks fine',
      })
    ).toEqual({
      approved: true,
      reason: 'looks fine',
    });

    expect(ApprovalService.normalizePendingActionResponseBody({ approved: false })).toEqual({
      approved: false,
      reason: null,
    });
    expect(ApprovalService.normalizePendingActionResponseBody({})).toEqual(new Error('approved must be a boolean'));
    expect(ApprovalService.normalizePendingActionResponseBody(null)).toEqual(
      new Error('Request body must be a JSON object')
    );
    expect(ApprovalService.normalizePendingActionResponseBody({ approved: true, rawApproval: true })).toEqual(
      new Error('Unsupported pending action response fields: rawApproval')
    );
  });

  it('serializes display-ready pending action fields without exposing raw payload state', () => {
    const serialized = ApprovalService.serializePendingAction({
      uuid: 'action-1',
      threadId: 3,
      runId: 4,
      kind: 'tool_approval',
      status: 'pending',
      capabilityKey: 'workspace_write',
      title: 'Approve tool',
      description: 'Tool requires approval',
      payload: {
        approvalId: 'approval-1',
        toolCallId: 'tool-call-1',
        toolName: 'mcp__sandbox__workspace_edit_file',
        input: {
          path: 'sample-file.txt',
          oldText: 'before',
          newText: 'after',
        },
        fileChanges: [
          {
            path: '/workspace/sample-file.txt',
            displayPath: 'sample-file.txt',
            kind: 'edited',
            summary: 'Updated sample-file.txt',
            additions: 1,
            deletions: 1,
            truncated: false,
          },
        ],
      },
      resolution: null,
      expiresAt: '2026-04-12T00:00:00.000Z',
      resolvedAt: null,
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    } as any);

    expect(serialized).toEqual({
      id: 'action-1',
      kind: 'tool_approval',
      status: 'pending',
      threadId: '3',
      runId: '4',
      title: 'Approve tool',
      description: 'Tool requires approval',
      requestedAt: '2026-04-11T00:00:00.000Z',
      expiresAt: '2026-04-12T00:00:00.000Z',
      toolName: 'mcp__sandbox__workspace_edit_file',
      argumentsSummary: [
        {
          name: 'path',
          value: 'sample-file.txt',
        },
      ],
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
    });
  });

  it('lists only pending actions for the owned thread', async () => {
    const query: any = {};
    query.alias = jest.fn().mockReturnValue(query);
    query.leftJoinRelated = jest.fn().mockReturnValue(query);
    query.where = jest.fn().mockReturnValue(query);
    query.select = jest.fn().mockReturnValue(query);
    query.orderBy = jest.fn().mockResolvedValue([{ uuid: 'action-1' }]);

    mockGetOwnedThread.mockResolvedValue({ id: 7 });
    mockPendingActionQuery.mockReturnValue(query);

    await expect(ApprovalService.listPendingActions('thread-1', 'sample-user')).resolves.toEqual([
      { uuid: 'action-1' },
    ]);

    expect(mockGetOwnedThread).toHaveBeenCalledWith('thread-1', 'sample-user');
    expect(query.where).toHaveBeenCalledWith('action.threadId', 7);
    expect(query.where).toHaveBeenCalledWith('action.status', 'pending');
    expect(query.orderBy).toHaveBeenCalledWith('action.createdAt', 'asc');
  });

  it('classifies session workspace approval requests by their workspace capability', async () => {
    mockGetToolName.mockReturnValue('mcp__sandbox__workspace_edit_file');

    const existingLookupQuery: any = {};
    existingLookupQuery.where = jest.fn().mockReturnValue(existingLookupQuery);
    existingLookupQuery.whereRaw = jest.fn().mockReturnValue(existingLookupQuery);
    existingLookupQuery.first = jest.fn().mockResolvedValue(null);

    const insertQuery = {
      insertAndFetch: jest.fn().mockResolvedValue({ id: 1 }),
    };

    mockPendingActionQuery.mockImplementationOnce(() => existingLookupQuery).mockImplementationOnce(() => insertQuery);

    await ApprovalService.upsertApprovalRequest({
      thread: { id: 7 } as any,
      run: { id: 11 } as any,
      message: { parts: [] } as any,
      toolPart: {
        approval: { id: 'approval-1' },
        input: {
          path: 'approval-check.txt',
          oldText: 'original',
          newText: 'updated',
        },
        state: 'approval-requested',
        toolCallId: 'tool-call-1',
      } as any,
      capabilityKey: 'external_mcp_write',
    });

    expect(insertQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'workspace_write',
        payload: expect.objectContaining({
          toolName: 'mcp__sandbox__workspace_edit_file',
        }),
      })
    );
  });

  it('does not persist approval requests when the current policy allows the tool', async () => {
    mockGetToolName.mockReturnValue('mcp__sandbox__workspace_write_file');

    await ApprovalService.syncApprovalRequestsFromMessages({
      thread: { id: 7 } as any,
      run: { id: 11 } as any,
      messages: [
        {
          role: 'assistant',
          parts: [
            {
              approval: { id: 'approval-1' },
              input: {
                path: 'approval-check.txt',
                content: 'hello',
              },
              state: 'approval-requested',
              toolCallId: 'tool-call-1',
            },
          ],
        } as any,
      ],
      approvalPolicy: {
        defaultMode: 'allow',
        rules: {
          workspace_write: 'allow',
        },
      } as any,
      toolRules: [],
    });

    expect(mockPendingActionQuery).not.toHaveBeenCalled();
  });

  it('persists approval requests when a tool rule requires approval', async () => {
    mockGetToolName.mockReturnValue('mcp__sandbox__workspace_write_file');

    const existingLookupQuery: any = {};
    existingLookupQuery.where = jest.fn().mockReturnValue(existingLookupQuery);
    existingLookupQuery.whereRaw = jest.fn().mockReturnValue(existingLookupQuery);
    existingLookupQuery.first = jest.fn().mockResolvedValue(null);

    const insertQuery = {
      insertAndFetch: jest.fn().mockResolvedValue({ id: 1 }),
    };

    mockPendingActionQuery.mockImplementationOnce(() => existingLookupQuery).mockImplementationOnce(() => insertQuery);

    await ApprovalService.syncApprovalRequestsFromMessages({
      thread: { id: 7 } as any,
      run: { id: 11 } as any,
      messages: [
        {
          role: 'assistant',
          parts: [
            {
              approval: { id: 'approval-1' },
              input: {
                path: 'approval-check.txt',
                content: 'hello',
              },
              state: 'approval-requested',
              toolCallId: 'tool-call-1',
            },
          ],
        } as any,
      ],
      approvalPolicy: {
        defaultMode: 'allow',
        rules: {
          workspace_write: 'allow',
        },
      } as any,
      toolRules: [
        {
          toolKey: 'mcp__sandbox__workspace_write_file',
          mode: 'require_approval',
        },
      ],
    });

    expect(insertQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'workspace_write',
        payload: expect.objectContaining({
          toolName: 'mcp__sandbox__workspace_write_file',
        }),
      })
    );
  });

  it('persists stream approval requests before message finalization', async () => {
    const existingLookupQuery: any = {};
    existingLookupQuery.where = jest.fn().mockReturnValue(existingLookupQuery);
    existingLookupQuery.whereRaw = jest.fn().mockReturnValue(existingLookupQuery);
    existingLookupQuery.first = jest.fn().mockResolvedValue(null);

    const insertQuery = {
      insertAndFetch: jest.fn().mockResolvedValue({ id: 1 }),
    };

    mockPendingActionQuery.mockImplementationOnce(() => existingLookupQuery).mockImplementationOnce(() => insertQuery);

    await ApprovalService.upsertApprovalRequestFromStream({
      thread: { id: 7 } as any,
      run: { id: 11 } as any,
      approvalId: 'approval-1',
      toolCallId: 'tool-call-1',
      toolName: 'mcp__sandbox__workspace_write_file',
      input: {
        path: 'sample-file.txt',
        content: 'hello',
      },
      fileChanges: [
        {
          id: 'change-1',
          toolCallId: 'tool-call-1',
          sourceTool: 'workspace.write_file',
          path: 'sample-file.txt',
          displayPath: 'sample-file.txt',
          kind: 'write',
          stage: 'awaiting-approval',
        } as any,
      ],
      approvalPolicy: {
        defaultMode: 'allow',
        rules: {
          workspace_write: 'require_approval',
        },
      } as any,
      toolRules: [],
    });

    expect(insertQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'workspace_write',
        payload: expect.objectContaining({
          approvalId: 'approval-1',
          toolCallId: 'tool-call-1',
          toolName: 'mcp__sandbox__workspace_write_file',
          fileChanges: expect.arrayContaining([
            expect.objectContaining({
              id: 'change-1',
              path: 'sample-file.txt',
            }),
          ]),
        }),
      })
    );
  });

  it('does not reset resolved approval requests during final message sync', async () => {
    mockGetToolName.mockReturnValue('mcp__sandbox__workspace_write_file');

    const existingLookupQuery: any = {};
    existingLookupQuery.where = jest.fn().mockReturnValue(existingLookupQuery);
    existingLookupQuery.whereRaw = jest.fn().mockReturnValue(existingLookupQuery);
    existingLookupQuery.first = jest.fn().mockResolvedValue({
      id: 1,
      status: 'approved',
      resolution: { approved: true },
      resolvedAt: '2026-04-12T00:00:00.000Z',
    });
    existingLookupQuery.patchAndFetchById = jest.fn();

    mockPendingActionQuery.mockReturnValueOnce(existingLookupQuery);

    await expect(
      ApprovalService.syncApprovalRequestStateFromMessages({
        thread: { id: 7 } as any,
        run: { id: 11 } as any,
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                approval: { id: 'approval-1' },
                input: {
                  path: 'approval-check.txt',
                  content: 'hello',
                },
                state: 'approval-requested',
                toolCallId: 'tool-call-1',
              },
            ],
          } as any,
        ],
        approvalPolicy: {
          defaultMode: 'allow',
          rules: {
            workspace_write: 'require_approval',
          },
        } as any,
        toolRules: [],
      })
    ).resolves.toEqual({
      pendingActions: [],
      resolvedActionCount: 1,
    });

    expect(existingLookupQuery.patchAndFetchById).not.toHaveBeenCalled();
  });

  it('classifies chat HTTP publish approvals as deploy mutations', async () => {
    mockGetToolName.mockReturnValue('mcp__lifecycle__publish_http');

    const existingLookupQuery: any = {};
    existingLookupQuery.where = jest.fn().mockReturnValue(existingLookupQuery);
    existingLookupQuery.whereRaw = jest.fn().mockReturnValue(existingLookupQuery);
    existingLookupQuery.first = jest.fn().mockResolvedValue(null);

    const insertQuery = {
      insertAndFetch: jest.fn().mockResolvedValue({ id: 1 }),
    };

    mockPendingActionQuery.mockImplementationOnce(() => existingLookupQuery).mockImplementationOnce(() => insertQuery);

    await ApprovalService.upsertApprovalRequest({
      thread: { id: 7 } as any,
      run: { id: 11 } as any,
      message: { parts: [] } as any,
      toolPart: {
        approval: { id: 'approval-1' },
        input: {
          port: 8000,
        },
        state: 'approval-requested',
        toolCallId: 'tool-call-1',
      } as any,
      capabilityKey: 'external_mcp_write',
    });

    expect(insertQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'deploy_k8s_mutation',
        payload: expect.objectContaining({
          toolName: 'mcp__lifecycle__publish_http',
        }),
      })
    );
  });

  it('does not resume a waiting run while another pending action remains unresolved', async () => {
    const action = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'pending',
      payload: { approvalId: 'approval-1' },
      runUuid: 'run-uuid',
    };
    const updatedAction = {
      ...action,
      status: 'approved',
    };
    const pendingQuery = makeTransactionalPendingActionQuery(action, action, { id: 100 }, updatedAction);
    const runQuery = makeTransactionalRunQuery({
      id: 11,
      uuid: 'run-uuid',
      status: 'waiting_for_approval',
      usageSummary: {},
      error: null,
    });

    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await ApprovalService.resolvePendingAction('action-1', 'sample-user', 'approved', {
      approved: true,
    });

    expect(pendingQuery.where).toHaveBeenCalledWith({ runId: 11, status: 'pending' });
    expect(pendingQuery.patchAndFetchById).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        status: 'approved',
        resolvedAt: expect.any(String),
      })
    );
    expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'run-uuid' }),
      'approval.resolved',
      {
        actionId: 'action-1',
        approvalId: 'approval-1',
        toolCallId: null,
        approved: true,
        reason: null,
      },
      { trx: true }
    );
    expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'run-uuid' }),
      'approval.responded',
      {
        actionId: 'action-1',
        approvalId: 'approval-1',
        toolCallId: null,
        approved: true,
        reason: null,
      },
      { trx: true }
    );
    expect(mockPatchStatus).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('resumes a waiting run after the last pending action is resolved', async () => {
    const action = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'pending',
      payload: { approvalId: 'approval-1' },
      runUuid: 'run-uuid',
    };
    const updatedAction = {
      ...action,
      status: 'approved',
    };
    const pendingQuery = makeTransactionalPendingActionQuery(action, action, null, updatedAction);
    const queuedRun = {
      id: 11,
      uuid: 'run-uuid',
      status: 'queued',
      usageSummary: {},
      error: null,
    };
    const runQuery = makeTransactionalRunQuery(
      {
        id: 11,
        uuid: 'run-uuid',
        status: 'waiting_for_approval',
        usageSummary: {},
        error: null,
      },
      queuedRun
    );

    mockEnqueueRun.mockResolvedValue(undefined);
    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await ApprovalService.resolvePendingAction(
      'action-1',
      'sample-user',
      'approved',
      {
        approved: true,
      },
      { githubToken: 'sample-gh-token' }
    );

    expect(pendingQuery.where).toHaveBeenCalledWith({ runId: 11, status: 'pending' });
    expect(runQuery.patchAndFetchById).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        status: 'queued',
        queuedAt: expect.any(String),
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      })
    );
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-uuid', 'approval_resolved', {
      githubToken: 'sample-gh-token',
    });
    expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
      queuedRun,
      'run.queued',
      expect.objectContaining({
        status: 'queued',
      }),
      { trx: true }
    );
  });

  it('emits the denial reason before requeueing the waiting run', async () => {
    const action = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'pending',
      payload: { approvalId: 'approval-1' },
      runUuid: 'run-uuid',
    };
    const updatedAction = {
      ...action,
      status: 'denied',
      resolution: {
        approved: false,
        reason: 'not needed',
      },
    };
    const queuedRun = {
      id: 11,
      uuid: 'run-uuid',
      status: 'queued',
      usageSummary: {},
      error: null,
    };
    const pendingQuery = makeTransactionalPendingActionQuery(action, action, null, updatedAction);
    const runQuery = makeTransactionalRunQuery(
      {
        id: 11,
        uuid: 'run-uuid',
        status: 'waiting_for_approval',
        usageSummary: {},
        error: null,
      },
      queuedRun
    );

    mockEnqueueRun.mockResolvedValue(undefined);
    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await ApprovalService.resolvePendingAction('action-1', 'sample-user', 'denied', {
      approved: false,
      reason: 'not needed',
    });

    expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'run-uuid' }),
      'approval.resolved',
      {
        actionId: 'action-1',
        approvalId: 'approval-1',
        toolCallId: null,
        approved: false,
        reason: 'not needed',
      },
      { trx: true }
    );
    expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'run-uuid' }),
      'approval.responded',
      {
        actionId: 'action-1',
        approvalId: 'approval-1',
        toolCallId: null,
        approved: false,
        reason: 'not needed',
      },
      { trx: true }
    );
    expect(runQuery.patchAndFetchById).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        status: 'queued',
      })
    );
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-uuid', 'approval_resolved', {
      githubToken: undefined,
    });
  });

  it('resumes a waiting run from an already resolved action without duplicate approval side effects', async () => {
    const action = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'approved',
      payload: { approvalId: 'approval-1' },
      runUuid: 'run-uuid',
      resolution: {
        approved: true,
      },
    };
    const queuedRun = {
      id: 11,
      uuid: 'run-uuid',
      status: 'queued',
      usageSummary: {},
      error: null,
    };
    const pendingQuery = makeTransactionalPendingActionQuery(action, action, null);
    const runQuery = makeTransactionalRunQuery(
      {
        id: 11,
        uuid: 'run-uuid',
        status: 'waiting_for_approval',
        usageSummary: {},
        error: null,
      },
      queuedRun
    );
    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await expect(
      ApprovalService.resolvePendingAction('action-1', 'sample-user', 'denied', {
        approved: false,
      })
    ).resolves.toBe(action);

    expect(pendingQuery.patchAndFetchById).not.toHaveBeenCalled();
    expect(runQuery.patchAndFetchById).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        status: 'queued',
        queuedAt: expect.any(String),
      })
    );
    expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
      queuedRun,
      'run.queued',
      expect.objectContaining({
        status: 'queued',
      }),
      { trx: true }
    );
    expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalledWith(
      expect.anything(),
      'approval.resolved',
      expect.anything(),
      expect.anything()
    );
    expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalledWith(
      expect.anything(),
      'approval.responded',
      expect.anything(),
      expect.anything()
    );
    expect(mockPatchStatus).not.toHaveBeenCalled();
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-uuid', 'approval_resolved', {
      githubToken: undefined,
    });
  });

  it('requeues an already queued run from an already resolved action', async () => {
    const resolvedAction = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'approved',
      payload: { approvalId: 'approval-1' },
      runUuid: 'run-uuid',
      resolution: {
        approved: true,
      },
    };
    const pendingQuery = makeTransactionalPendingActionQuery(resolvedAction, resolvedAction, null);
    const runQuery = makeTransactionalRunQuery({
      id: 11,
      uuid: 'run-uuid',
      status: 'queued',
      usageSummary: {},
      error: null,
    });
    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await expect(
      ApprovalService.resolvePendingAction('action-1', 'sample-user', 'approved', {
        approved: true,
      })
    ).resolves.toBe(resolvedAction);

    expect(pendingQuery.patchAndFetchById).not.toHaveBeenCalled();
    expect(runQuery.patchAndFetchById).not.toHaveBeenCalled();
    expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalled();
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-uuid', 'approval_resolved', {
      githubToken: undefined,
    });
  });

  it('does not emit approval side effects when the locked action is already resolved', async () => {
    const resolvedAction = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'denied',
      payload: { approvalId: 'approval-1' },
      runUuid: 'run-uuid',
      resolution: {
        approved: false,
      },
    };
    const pendingQuery = makeTransactionalPendingActionQuery(resolvedAction, resolvedAction);
    const runQuery = makeTransactionalRunQuery({
      id: 11,
      uuid: 'run-uuid',
      status: 'completed',
      usageSummary: {},
      error: null,
    });
    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await expect(
      ApprovalService.resolvePendingAction('action-1', 'sample-user', 'approved', {
        approved: true,
      })
    ).resolves.toBe(resolvedAction);

    expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalled();
    expect(mockPatchStatus).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });
});
