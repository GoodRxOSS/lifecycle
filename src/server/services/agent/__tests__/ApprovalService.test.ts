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

const mockStoreApprovalGitHubAuthHandoff = jest.fn();
const mockGetApprovalGitHubAuthHandoffByAction = jest.fn();
const mockClearApprovalGitHubAuthHandoff = jest.fn();

jest.mock('../ApprovalGitHubAuthHandoffService', () => ({
  __esModule: true,
  default: {
    store: (...args: unknown[]) => mockStoreApprovalGitHubAuthHandoff(...args),
    getByAction: (...args: unknown[]) => mockGetApprovalGitHubAuthHandoffByAction(...args),
    clearAction: (...args: unknown[]) => mockClearApprovalGitHubAuthHandoff(...args),
  },
}));

const mockFetchGitHubAuthenticatedUser = jest.fn();
const mockFetchGitHubRepositoryWritePermission = jest.fn();

jest.mock('server/lib/agentSession/githubToken', () => ({
  fetchGitHubAuthenticatedUser: (...args: unknown[]) => mockFetchGitHubAuthenticatedUser(...args),
  fetchGitHubRepositoryWritePermission: (...args: unknown[]) => mockFetchGitHubRepositoryWritePermission(...args),
}));

import AgentPendingAction from 'server/models/AgentPendingAction';
import AgentRun from 'server/models/AgentRun';
import ApprovalService from '../ApprovalService';
import AgentThreadService from '../ThreadService';

const mockPendingActionQuery = AgentPendingAction.query as jest.Mock;
const mockPendingActionTransaction = AgentPendingAction.transaction as jest.Mock;
const mockRunQuery = AgentRun.query as jest.Mock;
const mockGetOwnedThread = AgentThreadService.getOwnedThread as jest.Mock;

function toolPart(toolName: string, part: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'dynamic-tool',
    toolName,
    ...part,
  };
}

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
  query.patchAndFetchById = jest.fn().mockImplementation((_id, patch) => {
    const firstResult = firstResults[0];
    const base =
      firstResult && typeof firstResult === 'object' && !Array.isArray(firstResult)
        ? (firstResult as Record<string, unknown>)
        : {};
    return Promise.resolve({ ...base, ...patch });
  });
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
    mockEnqueueRun.mockResolvedValue(undefined);
    mockGetApprovalGitHubAuthHandoffByAction.mockResolvedValue(null);
    mockClearApprovalGitHubAuthHandoff.mockResolvedValue(undefined);
    mockFetchGitHubAuthenticatedUser.mockResolvedValue({
      ok: true,
      id: 12_345,
      login: 'octocat',
      status: 200,
      scopes: [],
      rateLimitRemaining: '42',
    });
    mockFetchGitHubRepositoryWritePermission.mockResolvedValue({
      ok: true,
      repository: 'example-org/example-repo',
      status: 200,
      permission: 'granted',
      permissions: { admin: false, maintain: false, push: true },
      scopes: [],
      rateLimitRemaining: '42',
    });
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
        toolName: 'mcp__workspace_core__edit_file',
        input: {
          path: 'sample-file.txt',
          old_text: 'before',
          new_text: 'after',
        },
        fileChanges: [
          {
            id: 'tool-call-1:/workspace/sample-file.txt',
            toolCallId: 'tool-call-1',
            sourceTool: 'edit_file',
            path: '/workspace/sample-file.txt',
            displayPath: 'sample-file.txt',
            kind: 'edited',
            stage: 'awaiting-approval',
            summary: 'Updated sample-file.txt',
            additions: 1,
            deletions: 1,
            truncated: false,
            unifiedDiff: 'diff --git a/sample-file.txt b/sample-file.txt',
            beforeTextPreview: 'before',
            afterTextPreview: 'after',
            encoding: 'utf-8',
            oldSizeBytes: 6,
            newSizeBytes: 5,
            oldSha256: 'old-hash',
            newSha256: 'new-hash',
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
      toolName: 'mcp__workspace_core__edit_file',
      argumentsSummary: [
        {
          name: 'path',
          value: 'sample-file.txt',
        },
      ],
      commandPreview: null,
      fileChangePreview: [
        {
          id: 'tool-call-1:/workspace/sample-file.txt',
          toolCallId: 'tool-call-1',
          sourceTool: 'edit_file',
          path: '/workspace/sample-file.txt',
          displayPath: 'sample-file.txt',
          kind: 'edited',
          stage: 'awaiting-approval',
          summary: 'Updated sample-file.txt',
          additions: 1,
          deletions: 1,
          truncated: false,
          unifiedDiff: 'diff --git a/sample-file.txt b/sample-file.txt',
          beforeTextPreview: 'before',
          afterTextPreview: 'after',
          encoding: 'utf-8',
          oldSizeBytes: 6,
          newSizeBytes: 5,
          oldSha256: 'old-hash',
          newSha256: 'new-hash',
        },
      ],
      riskLabels: ['Workspace write'],
    });
  });

  it('serializes Lifecycle fix approval data without exposing raw file content as an argument', () => {
    const serialized = ApprovalService.serializePendingAction({
      uuid: 'action-update-file',
      threadId: 3,
      runId: 4,
      kind: 'tool_approval',
      status: 'pending',
      capabilityKey: 'git_write',
      title: 'Approve update_file',
      description: 'update_file requires approval before it can run.',
      payload: {
        approvalId: 'approval-update-file',
        toolCallId: 'tool-update-file',
        toolName: 'mcp__lifecycle__update_file',
        input: {
          repository_owner: 'example-org',
          repository_name: 'example-repo',
          branch: 'feature/sample',
          file_path: 'lifecycle.yaml',
          new_content: 'services:\n  sample-service:\n    branch: feature/sample',
          commit_message: 'Update sample service config',
        },
        fileChanges: [
          {
            id: 'tool-update-file:lifecycle.yaml',
            toolCallId: 'tool-update-file',
            sourceTool: 'update_file',
            path: 'lifecycle.yaml',
            displayPath: 'lifecycle.yaml',
            kind: 'edited',
            stage: 'awaiting-approval',
            summary: 'Proposed update to lifecycle.yaml',
            additions: 3,
            deletions: 0,
            truncated: false,
            unifiedDiff: 'diff --git a/lifecycle.yaml b/lifecycle.yaml',
            beforeTextPreview: 'services:\n  sample-service:\n    branch: main',
            afterTextPreview: 'services:\n  sample-service:\n    branch: feature/sample',
            encoding: 'utf-8',
            oldSizeBytes: 43,
            newSizeBytes: 54,
            oldSha256: 'old-lifecycle-hash',
            newSha256: 'new-lifecycle-hash',
          },
        ],
      },
      resolution: null,
      resolvedAt: null,
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    } as any);

    expect(serialized.argumentsSummary).toEqual(
      expect.arrayContaining([
        { name: 'repository_owner', value: 'example-org' },
        { name: 'repository_name', value: 'example-repo' },
        { name: 'branch', value: 'feature/sample' },
        { name: 'file_path', value: 'lifecycle.yaml' },
      ])
    );
    expect(serialized.argumentsSummary).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'new_content' })])
    );
    expect(serialized.fileChangePreview).toEqual([
      {
        id: 'tool-update-file:lifecycle.yaml',
        toolCallId: 'tool-update-file',
        sourceTool: 'update_file',
        path: 'lifecycle.yaml',
        displayPath: 'lifecycle.yaml',
        kind: 'edited',
        stage: 'awaiting-approval',
        summary: 'Proposed update to lifecycle.yaml',
        additions: 3,
        deletions: 0,
        truncated: false,
        unifiedDiff: 'diff --git a/lifecycle.yaml b/lifecycle.yaml',
        beforeTextPreview: 'services:\n  sample-service:\n    branch: main',
        afterTextPreview: 'services:\n  sample-service:\n    branch: feature/sample',
        encoding: 'utf-8',
        oldSizeBytes: 43,
        newSizeBytes: 54,
        oldSha256: 'old-lifecycle-hash',
        newSha256: 'new-lifecycle-hash',
      },
    ]);
    expect(serialized.riskLabels).toEqual(['Git write']);
  });

  it('serializes Lifecycle Kubernetes fix approvals with deployment risk labeling', () => {
    const serialized = ApprovalService.serializePendingAction({
      uuid: 'action-k8s',
      threadId: 3,
      runId: 4,
      kind: 'tool_approval',
      status: 'pending',
      capabilityKey: 'deploy_k8s_mutation',
      title: 'Approve patch_k8s_resource',
      description: 'patch_k8s_resource requires approval before it can run.',
      payload: {
        approvalId: 'approval-k8s',
        toolCallId: 'tool-k8s',
        toolName: 'mcp__lifecycle__patch_k8s_resource',
        input: {
          namespace: 'env-sample',
          resource_type: 'deployment',
          name: 'sample-service',
          operation: 'restart',
        },
      },
      resolution: null,
      resolvedAt: null,
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    } as any);

    expect(serialized.argumentsSummary).toEqual(
      expect.arrayContaining([
        { name: 'namespace', value: 'env-sample' },
        { name: 'resource_type', value: 'deployment' },
        { name: 'operation', value: 'restart' },
      ])
    );
    expect(serialized.fileChangePreview).toEqual([]);
    expect(serialized.riskLabels).toEqual(['Deployment change']);
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
      toolPart: toolPart('mcp__workspace_core__edit_file', {
        approval: { id: 'approval-1' },
        input: {
          path: 'approval-check.txt',
          old_text: 'original',
          new_text: 'updated',
        },
        state: 'approval-requested',
        toolCallId: 'tool-call-1',
      }) as any,
      capabilityKey: 'external_mcp_write',
    });

    expect(insertQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'workspace_write',
        payload: expect.objectContaining({
          toolName: 'mcp__workspace_core__edit_file',
        }),
      })
    );
  });

  it('persists runtime-requested approvals even when the current policy allows the tool', async () => {
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
            toolPart('mcp__workspace_core__write_file', {
              approval: { id: 'approval-1' },
              input: {
                path: 'approval-check.txt',
                content: 'hello',
              },
              state: 'approval-requested',
              toolCallId: 'tool-call-1',
            }),
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

    expect(insertQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'workspace_write',
        payload: expect.objectContaining({
          approvalId: 'approval-1',
          toolCallId: 'tool-call-1',
          toolName: 'mcp__workspace_core__write_file',
        }),
      })
    );
  });

  it('does not persist approval requests when the current policy denies the tool', async () => {
    await ApprovalService.syncApprovalRequestsFromMessages({
      thread: { id: 7 } as any,
      run: { id: 11 } as any,
      messages: [
        {
          role: 'assistant',
          parts: [
            toolPart('mcp__workspace_core__write_file', {
              approval: { id: 'approval-1' },
              input: {
                path: 'approval-check.txt',
                content: 'hello',
              },
              state: 'approval-requested',
              toolCallId: 'tool-call-1',
            }),
          ],
        } as any,
      ],
      approvalPolicy: {
        defaultMode: 'allow',
        rules: {
          workspace_write: 'deny',
        },
      } as any,
      toolRules: [],
    });

    expect(mockPendingActionQuery).not.toHaveBeenCalled();
  });

  it('persists forced Lifecycle fix approval requests even when the policy allows the capability', async () => {
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
            toolPart('mcp__lifecycle__update_file', {
              approval: { id: 'approval-1' },
              input: {
                repository_owner: 'example-org',
                repository_name: 'example-repo',
                branch: 'feature/sample',
                file_path: 'lifecycle.yaml',
                new_content: 'services: []',
              },
              state: 'approval-requested',
              toolCallId: 'tool-call-1',
            }),
          ],
        } as any,
      ],
      approvalPolicy: {
        defaultMode: 'allow',
        rules: {
          git_write: 'allow',
          external_mcp_write: 'allow',
        },
      } as any,
      toolRules: [],
    });

    expect(insertQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'git_write',
        payload: expect.objectContaining({
          approvalId: 'approval-1',
          toolCallId: 'tool-call-1',
          toolName: 'mcp__lifecycle__update_file',
        }),
      })
    );
  });

  it('persists Lifecycle trigger-redeploy approvals as deployment mutations', async () => {
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
      approvalId: 'approval-redeploy',
      toolCallId: 'tool-call-redeploy',
      toolName: 'mcp__lifecycle__trigger_redeploy',
      input: {
        reason: 'Retry the failed deployment.',
      },
      approvalPolicy: {
        defaultMode: 'allow',
        rules: {
          deploy_k8s_mutation: 'allow',
          external_mcp_write: 'allow',
        },
      } as any,
      toolRules: [],
    });

    expect(insertQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'deploy_k8s_mutation',
        payload: expect.objectContaining({
          approvalId: 'approval-redeploy',
          toolCallId: 'tool-call-redeploy',
          toolName: 'mcp__lifecycle__trigger_redeploy',
        }),
      })
    );
  });

  it('persists approval requests when a tool rule requires approval', async () => {
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
            toolPart('mcp__workspace_core__write_file', {
              approval: { id: 'approval-1' },
              input: {
                path: 'approval-check.txt',
                content: 'hello',
              },
              state: 'approval-requested',
              toolCallId: 'tool-call-1',
            }),
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
          toolKey: 'mcp__workspace_core__write_file',
          mode: 'require_approval',
        },
      ],
    });

    expect(insertQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'workspace_write',
        payload: expect.objectContaining({
          toolName: 'mcp__workspace_core__write_file',
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
      toolName: 'mcp__workspace_core__write_file',
      input: {
        path: 'sample-file.txt',
        content: 'hello',
      },
      fileChanges: [
        {
          id: 'change-1',
          toolCallId: 'tool-call-1',
          sourceTool: 'write_file',
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
          toolName: 'mcp__workspace_core__write_file',
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

  it('persists stream approval requests even when the current policy allows the tool', async () => {
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
      toolName: 'mcp__workspace_core__write_file',
      input: {
        path: 'sample-file.txt',
        content: 'hello',
      },
      approvalPolicy: {
        defaultMode: 'allow',
        rules: {
          workspace_write: 'allow',
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
          toolName: 'mcp__workspace_core__write_file',
        }),
      })
    );
  });

  it('does not reset resolved approval requests during final message sync', async () => {
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
              toolPart('mcp__workspace_core__write_file', {
                approval: { id: 'approval-1' },
                input: {
                  path: 'approval-check.txt',
                  content: 'hello',
                },
                state: 'approval-requested',
                toolCallId: 'tool-call-1',
              }),
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
      toolPart: toolPart('mcp__workspace_core__publish_http', {
        approval: { id: 'approval-1' },
        input: {
          port: 8000,
        },
        state: 'approval-requested',
        toolCallId: 'tool-call-1',
      }) as any,
      capabilityKey: 'external_mcp_write',
    });

    expect(insertQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: 'deploy_k8s_mutation',
        payload: expect.objectContaining({
          toolName: 'mcp__workspace_core__publish_http',
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
      githubAuth: expect.objectContaining({
        githubToken: 'sample-gh-token',
        source: 'user',
        writeAuthorized: false,
      }),
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

  it('stores approver GitHub auth before approving a git_write action', async () => {
    const action = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'pending',
      capabilityKey: 'git_write',
      payload: {
        approvalId: 'approval-1',
        toolCallId: 'tool-1',
        input: {
          repository_owner: 'example-org',
          repository_name: 'example-repo',
        },
      },
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

    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await ApprovalService.resolvePendingAction(
      'action-1',
      'sample-user',
      'approved',
      { approved: true },
      {
        githubAuth: {
          githubToken: 'user-token',
          source: 'user',
          githubUsername: 'octocat',
        },
      }
    );

    expect(mockFetchGitHubAuthenticatedUser).toHaveBeenCalledWith('user-token');
    expect(mockFetchGitHubRepositoryWritePermission).toHaveBeenCalledWith('user-token', 'example-org', 'example-repo');
    expect(mockStoreApprovalGitHubAuthHandoff).toHaveBeenCalledWith({
      runUuid: 'run-uuid',
      actionUuid: 'action-1',
      toolCallId: 'tool-1',
      approvedByUserId: 'sample-user',
      auth: expect.objectContaining({
        githubToken: 'user-token',
        source: 'user',
        githubUsername: 'octocat',
        writeAuthorized: true,
      }),
    });
    expect(pendingQuery.patchAndFetchById).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        status: 'approved',
      })
    );
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-uuid', 'approval_resolved', {
      githubAuth: expect.objectContaining({
        githubToken: 'user-token',
        source: 'user',
        githubUsername: 'octocat',
        writeAuthorized: true,
      }),
    });
  });

  it('rejects git_write approvals without a user GitHub token before mutating the action', async () => {
    const action = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'pending',
      capabilityKey: 'git_write',
      payload: { approvalId: 'approval-1', toolCallId: 'tool-1' },
      runUuid: 'run-uuid',
    };
    const pendingQuery = makeTransactionalPendingActionQuery(action, action);
    const runQuery = makeTransactionalRunQuery({
      id: 11,
      uuid: 'run-uuid',
      status: 'waiting_for_approval',
      usageSummary: {},
      error: null,
    });

    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await expect(
      ApprovalService.resolvePendingAction(
        'action-1',
        'sample-user',
        'approved',
        { approved: true },
        {
          githubAuth: {
            githubToken: 'app-token',
            source: 'app',
          },
        }
      )
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: 'GITHUB_USER_AUTH_REQUIRED',
    });

    expect(mockStoreApprovalGitHubAuthHandoff).not.toHaveBeenCalled();
    expect(pendingQuery.patchAndFetchById).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
    expect(mockFetchGitHubAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('rejects git_write approvals when the user token cannot write the target repository', async () => {
    const action = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'pending',
      capabilityKey: 'git_write',
      payload: {
        approvalId: 'approval-1',
        toolCallId: 'tool-1',
        input: {
          repository_owner: 'example-org',
          repository_name: 'example-repo',
        },
      },
      runUuid: 'run-uuid',
    };
    const pendingQuery = makeTransactionalPendingActionQuery(action, action);
    const runQuery = makeTransactionalRunQuery({
      id: 11,
      uuid: 'run-uuid',
      status: 'waiting_for_approval',
      usageSummary: {},
      error: null,
    });

    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);
    mockFetchGitHubRepositoryWritePermission.mockResolvedValueOnce({
      ok: true,
      repository: 'example-org/example-repo',
      status: 200,
      permission: 'denied',
      permissions: { admin: false, maintain: false, push: false },
      scopes: [],
      rateLimitRemaining: '42',
    });

    await expect(
      ApprovalService.resolvePendingAction(
        'action-1',
        'sample-user',
        'approved',
        { approved: true },
        {
          githubAuth: {
            githubToken: 'user-token',
            source: 'user',
            githubUsername: 'octocat',
          },
        }
      )
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: 'GITHUB_USER_AUTH_REQUIRED',
      details: {
        repository: 'example-org/example-repo',
        requiredPermission: 'repository_write',
        permission: 'denied',
      },
    });

    expect(mockFetchGitHubAuthenticatedUser).toHaveBeenCalledWith('user-token');
    expect(mockFetchGitHubRepositoryWritePermission).toHaveBeenCalledWith('user-token', 'example-org', 'example-repo');
    expect(mockStoreApprovalGitHubAuthHandoff).not.toHaveBeenCalled();
    expect(pendingQuery.patchAndFetchById).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the GitHub token probe is unusable',
      () =>
        mockFetchGitHubAuthenticatedUser.mockResolvedValueOnce({
          ok: false,
          id: null,
          login: null,
          status: 401,
          scopes: ['repo'],
          rateLimitRemaining: null,
        }),
    ],
    [
      'the GitHub token probe fails',
      () => mockFetchGitHubAuthenticatedUser.mockRejectedValueOnce(new Error('GitHub unavailable')),
    ],
  ])('rejects git_write approvals when %s', async (_name, arrangeProbe) => {
    const action = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'pending',
      capabilityKey: 'git_write',
      payload: { approvalId: 'approval-1', toolCallId: 'tool-1' },
      runUuid: 'run-uuid',
    };
    const pendingQuery = makeTransactionalPendingActionQuery(action, action);
    const runQuery = makeTransactionalRunQuery({
      id: 11,
      uuid: 'run-uuid',
      status: 'waiting_for_approval',
      usageSummary: {},
      error: null,
    });

    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);
    arrangeProbe();

    await expect(
      ApprovalService.resolvePendingAction(
        'action-1',
        'sample-user',
        'approved',
        { approved: true },
        {
          githubAuth: {
            githubToken: 'user-token',
            source: 'user',
            githubUsername: 'octocat',
          },
        }
      )
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: 'GITHUB_USER_AUTH_REQUIRED',
    });

    expect(mockFetchGitHubAuthenticatedUser).toHaveBeenCalledWith('user-token');
    expect(mockStoreApprovalGitHubAuthHandoff).not.toHaveBeenCalled();
    expect(pendingQuery.patchAndFetchById).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('reuses an existing handoff when an already-approved git_write action is requeued', async () => {
    const resolvedAction = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'approved',
      capabilityKey: 'git_write',
      payload: { approvalId: 'approval-1', toolCallId: 'tool-1' },
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
    mockGetApprovalGitHubAuthHandoffByAction.mockResolvedValueOnce({
      githubToken: 'handoff-token',
      source: 'user',
      githubUsername: 'approver',
      writeAuthorized: true,
    });
    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await ApprovalService.resolvePendingAction('action-1', 'sample-user', 'approved', {
      approved: true,
    });

    expect(mockFetchGitHubAuthenticatedUser).toHaveBeenCalledWith('handoff-token');
    expect(mockStoreApprovalGitHubAuthHandoff).not.toHaveBeenCalled();
    expect(mockEnqueueRun).toHaveBeenCalledWith('run-uuid', 'approval_resolved', {
      githubAuth: {
        githubToken: 'handoff-token',
        source: 'user',
        githubUsername: 'approver',
        writeAuthorized: true,
      },
    });
  });

  it('rejects an existing git_write handoff when its token cannot write the target repository', async () => {
    const resolvedAction = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'approved',
      capabilityKey: 'git_write',
      payload: {
        approvalId: 'approval-1',
        toolCallId: 'tool-1',
        input: {
          repository_owner: 'example-org',
          repository_name: 'example-repo',
        },
      },
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
    mockGetApprovalGitHubAuthHandoffByAction.mockResolvedValueOnce({
      githubToken: 'handoff-token',
      source: 'user',
      githubUsername: 'approver',
      writeAuthorized: true,
    });
    mockFetchGitHubRepositoryWritePermission.mockResolvedValueOnce({
      ok: true,
      repository: 'example-org/example-repo',
      status: 200,
      permission: 'denied',
      permissions: { admin: false, maintain: false, push: false },
      scopes: [],
      rateLimitRemaining: '42',
    });
    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await expect(
      ApprovalService.resolvePendingAction('action-1', 'sample-user', 'approved', {
        approved: true,
      })
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: 'GITHUB_USER_AUTH_REQUIRED',
    });

    expect(mockFetchGitHubAuthenticatedUser).toHaveBeenCalledWith('handoff-token');
    expect(mockFetchGitHubRepositoryWritePermission).toHaveBeenCalledWith(
      'handoff-token',
      'example-org',
      'example-repo'
    );
    expect(mockStoreApprovalGitHubAuthHandoff).not.toHaveBeenCalled();
    expect(pendingQuery.patchAndFetchById).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('cleans up a freshly stored git_write handoff if approval persistence fails', async () => {
    const action = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'pending',
      capabilityKey: 'git_write',
      payload: { approvalId: 'approval-1', toolCallId: 'tool-1' },
      runUuid: 'run-uuid',
    };
    const pendingQuery = makeTransactionalPendingActionQuery(action, action);
    pendingQuery.patchAndFetchById.mockRejectedValueOnce(new Error('db write failed'));
    const runQuery = makeTransactionalRunQuery({
      id: 11,
      uuid: 'run-uuid',
      status: 'waiting_for_approval',
      usageSummary: {},
      error: null,
    });
    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await expect(
      ApprovalService.resolvePendingAction(
        'action-1',
        'sample-user',
        'approved',
        { approved: true },
        {
          githubAuth: {
            githubToken: 'user-token',
            source: 'user',
            githubUsername: 'octocat',
          },
        }
      )
    ).rejects.toThrow('db write failed');

    expect(mockStoreApprovalGitHubAuthHandoff).toHaveBeenCalled();
    expect(mockClearApprovalGitHubAuthHandoff).toHaveBeenCalledWith('run-uuid', 'action-1', 'tool-1');
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('emits the denial reason before requeueing the waiting run', async () => {
    const action = {
      id: 99,
      uuid: 'action-1',
      threadId: 7,
      runId: 11,
      status: 'pending',
      capabilityKey: 'git_write',
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
      githubAuth: expect.objectContaining({
        githubToken: null,
        source: 'none',
        writeAuthorized: false,
      }),
    });
    expect(mockFetchGitHubAuthenticatedUser).not.toHaveBeenCalled();
    expect(mockStoreApprovalGitHubAuthHandoff).not.toHaveBeenCalled();
  });

  it('completes denied Debug repair approvals instead of immediately resuming repair', async () => {
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
        reason: 'not now',
      },
    };
    const completedRun = {
      id: 11,
      uuid: 'run-uuid',
      status: 'completed',
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
        runPlanSnapshot: {
          version: 1,
          debug: {
            resolvedIntent: 'repair',
          },
        },
      },
      completedRun
    );

    mockEnqueueRun.mockResolvedValue(undefined);
    mockPendingActionQuery.mockReturnValue(pendingQuery);
    mockRunQuery.mockReturnValue(runQuery);

    await ApprovalService.resolvePendingAction('action-1', 'sample-user', 'denied', {
      approved: false,
      reason: 'not now',
    });

    expect(runQuery.patchAndFetchById).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        status: 'completed',
        completedAt: expect.any(String),
        executionOwner: null,
      })
    );
    expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
      completedRun,
      'run.completed',
      expect.objectContaining({
        status: 'completed',
      }),
      { trx: true }
    );
    expect(mockEnqueueRun).not.toHaveBeenCalled();
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
      githubAuth: expect.objectContaining({
        githubToken: null,
        source: 'none',
        writeAuthorized: false,
      }),
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
      githubAuth: expect.objectContaining({
        githubToken: null,
        source: 'none',
        writeAuthorized: false,
      }),
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
