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
  },
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../SandboxService', () => ({
  __esModule: true,
  default: {
    getLatestSandboxForSession: jest.fn(),
    recordSessionSandboxState: jest.fn(),
  },
}));

jest.mock('server/lib/dependencies', () => ({}));

import AgentRun from 'server/models/AgentRun';
import AgentSession from 'server/models/AgentSession';
import { AgentWorkspaceStatus } from 'shared/constants';
import AgentSandboxService from '../SandboxService';
import { TERMINAL_RUN_STATUSES } from '../RunService';
import WorkspaceRuntimeStateService from '../WorkspaceRuntimeStateService';

const mockRunQuery = AgentRun.query as jest.Mock;
const mockSessionQuery = AgentSession.query as jest.Mock;
const mockSessionTransaction = AgentSession.transaction as jest.Mock;
const mockGetLatestSandboxForSession = AgentSandboxService.getLatestSandboxForSession as jest.Mock;
const mockRecordSessionSandboxState = AgentSandboxService.recordSessionSandboxState as jest.Mock;

const trx = { trx: true };

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    uuid: 'session-1',
    status: 'active',
    chatStatus: 'ready',
    workspaceStatus: 'ready',
    namespace: 'sample-namespace',
    podName: 'sample-pod',
    pvcName: 'sample-pvc',
    sessionKind: 'chat',
    buildUuid: null,
    buildKind: null,
    selectedServices: [],
    updatedAt: '2026-05-09T00:00:00.000Z',
    endedAt: null,
    ...overrides,
  } as any;
}

function mockSessionLock(session = buildSession()) {
  const forUpdate = jest.fn().mockResolvedValue(session);
  const findById = jest.fn().mockReturnValue({ forUpdate });
  mockSessionQuery.mockReturnValueOnce({ findById });
  return { findById, forUpdate };
}

function mockSessionPatch(session = buildSession()) {
  const patchAndFetchById = jest.fn().mockResolvedValue(session);
  mockSessionQuery.mockReturnValueOnce({ patchAndFetchById });
  return patchAndFetchById;
}

function mockActiveRun(activeRun: unknown = null) {
  const query = {
    where: jest.fn(),
    whereNotIn: jest.fn(),
    whereNot: jest.fn(),
    orderBy: jest.fn(),
    first: jest.fn().mockResolvedValue(activeRun),
  };
  query.where.mockReturnValue(query);
  query.whereNotIn.mockReturnValue(query);
  query.whereNot.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  mockRunQuery.mockReturnValueOnce(query);
  return query;
}

describe('WorkspaceRuntimeStateService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSessionTransaction.mockImplementation(async (callback) => callback(trx));
    mockGetLatestSandboxForSession.mockResolvedValue(null);
    mockRecordSessionSandboxState.mockResolvedValue({ id: 9, status: 'ready' });
  });

  it.each(['queued', 'starting', 'running', 'waiting_for_approval', 'waiting_for_input'])(
    'locks the session row and blocks workspace claims while a %s agent run is active',
    async (status) => {
      const { findById, forUpdate } = mockSessionLock();
      const activeRunQuery = mockActiveRun({ id: 33, uuid: 'run-1', status });

      await expect(
        WorkspaceRuntimeStateService.claimWorkspaceAction(17, {
          action: 'suspend',
          claimedAt: '2026-05-09T00:10:00.000Z',
          sessionPatch: {
            workspaceStatus: AgentWorkspaceStatus.READY,
          },
          sandboxStatus: 'suspending',
        })
      ).rejects.toMatchObject({
        name: 'WorkspaceActionBlockedError',
        reason: 'active_run',
      });

      expect(findById).toHaveBeenCalledWith(17);
      expect(forUpdate).toHaveBeenCalled();
      expect(activeRunQuery.whereNotIn).toHaveBeenCalledWith('status', TERMINAL_RUN_STATUSES);
      expect(activeRunQuery.whereNot).not.toHaveBeenCalled();
      expect(mockRecordSessionSandboxState).not.toHaveBeenCalled();
    }
  );

  it('allows workspace claims when the only active run is explicitly allowed', async () => {
    const patchedSession = buildSession({
      workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
    });
    mockSessionLock();
    const activeRunQuery = mockActiveRun(null);
    mockGetLatestSandboxForSession.mockResolvedValue({ id: 9, metadata: {} });
    const patchAndFetchById = mockSessionPatch(patchedSession);
    mockRecordSessionSandboxState.mockResolvedValue({ id: 9, status: 'provisioning' });

    await WorkspaceRuntimeStateService.claimWorkspaceAction(17, {
      action: 'provision',
      claimedAt: '2026-05-09T00:10:00.000Z',
      allowedActiveRunUuid: 'run-current',
      sessionPatch: {
        workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
      },
      sandboxStatus: 'provisioning',
    });

    expect(activeRunQuery.whereNot).toHaveBeenCalledWith('uuid', 'run-current');
    expect(patchAndFetchById).toHaveBeenCalledWith(17, {
      workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
    });
    expect(mockRecordSessionSandboxState).toHaveBeenCalled();
  });

  it('still blocks workspace claims when another active run exists', async () => {
    mockSessionLock();
    const activeRunQuery = mockActiveRun({ id: 34, uuid: 'run-other', status: 'running' });

    await expect(
      WorkspaceRuntimeStateService.claimWorkspaceAction(17, {
        action: 'provision',
        claimedAt: '2026-05-09T00:10:00.000Z',
        allowedActiveRunUuid: 'run-current',
        sessionPatch: {
          workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
        },
        sandboxStatus: 'provisioning',
      })
    ).rejects.toMatchObject({
      name: 'WorkspaceActionBlockedError',
      reason: 'active_run',
      details: {
        runUuid: 'run-other',
      },
    });

    expect(activeRunQuery.whereNot).toHaveBeenCalledWith('uuid', 'run-current');
    expect(mockRecordSessionSandboxState).not.toHaveBeenCalled();
  });

  it('blocks workspace claims when the locked session row is already ended', async () => {
    mockSessionLock(
      buildSession({
        status: 'ended',
        workspaceStatus: AgentWorkspaceStatus.ENDED,
      })
    );
    mockActiveRun();

    await expect(
      WorkspaceRuntimeStateService.claimWorkspaceAction(17, {
        action: 'provision',
        claimedAt: '2026-05-09T00:10:00.000Z',
        sessionPatch: {
          workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
        },
        sandboxStatus: 'provisioning',
      })
    ).rejects.toMatchObject({
      reason: 'action_in_progress',
      details: {
        currentAction: 'ended',
      },
    });

    expect(mockRecordSessionSandboxState).not.toHaveBeenCalled();
  });

  it('blocks workspace claims while another lifecycle action is in progress', async () => {
    const activeClaimedAt = new Date(Date.now() - 60_000).toISOString();
    mockSessionLock();
    mockActiveRun();
    mockGetLatestSandboxForSession.mockResolvedValue({
      id: 9,
      metadata: {
        runtimeLifecycle: {
          currentAction: 'cleanup',
          claimedAt: activeClaimedAt,
        },
      },
    });

    await expect(
      WorkspaceRuntimeStateService.claimWorkspaceAction(17, {
        action: 'resume',
        claimedAt: '2026-05-09T00:10:00.000Z',
        activeActionTimeoutMs: 24 * 60 * 60 * 1000,
        sessionPatch: {
          workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
        },
        sandboxStatus: 'resuming',
      })
    ).rejects.toMatchObject({
      reason: 'action_in_progress',
    });

    expect(mockRecordSessionSandboxState).not.toHaveBeenCalled();
  });

  it('checks active workspace actions using a caller-provided transaction', async () => {
    const callerTrx = { caller: true };
    const activeClaimedAt = new Date(Date.now() - 60_000).toISOString();
    mockSessionLock();
    mockGetLatestSandboxForSession.mockResolvedValue({
      id: 9,
      metadata: {
        runtimeLifecycle: {
          currentAction: 'resume',
          claimedAt: activeClaimedAt,
        },
      },
    });

    await expect(
      WorkspaceRuntimeStateService.assertNoActiveWorkspaceAction(17, {
        trx: callerTrx as any,
        activeActionTimeoutMs: 24 * 60 * 60 * 1000,
      })
    ).rejects.toMatchObject({
      reason: 'action_in_progress',
      details: {
        currentAction: 'resume',
      },
    });

    expect(mockSessionTransaction).not.toHaveBeenCalled();
    expect(mockSessionQuery).toHaveBeenCalledWith(callerTrx);
    expect(mockGetLatestSandboxForSession).toHaveBeenCalledWith(17, { trx: callerTrx });
  });

  it('allows stale lifecycle action claims to be replaced', async () => {
    const patchedSession = buildSession({
      workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
    });
    mockSessionLock();
    mockActiveRun();
    mockGetLatestSandboxForSession.mockResolvedValue({
      id: 9,
      metadata: {
        runtimeLifecycle: {
          currentAction: 'provision',
          claimedAt: '2020-01-01T00:00:00.000Z',
        },
      },
    });
    const patchAndFetchById = mockSessionPatch(patchedSession);

    await WorkspaceRuntimeStateService.claimWorkspaceAction(17, {
      action: 'cleanup',
      claimedAt: '2026-05-09T00:10:00.000Z',
      sessionPatch: {
        workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
      },
      sandboxStatus: 'provisioning',
    });

    expect(patchAndFetchById).toHaveBeenCalledWith(17, {
      workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
    });
    expect(mockRecordSessionSandboxState).toHaveBeenCalledWith(
      patchedSession,
      expect.objectContaining({
        runtimeLifecycle: {
          currentAction: 'cleanup',
          claimedAt: '2026-05-09T00:10:00.000Z',
        },
      })
    );
  });

  it('claims allowed workspace actions by patching session and sandbox state in one transaction', async () => {
    const patchedSession = buildSession({
      workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
    });
    mockSessionLock();
    mockActiveRun();
    mockGetLatestSandboxForSession.mockResolvedValue({ id: 9, metadata: {} });
    const patchAndFetchById = mockSessionPatch(patchedSession);
    mockRecordSessionSandboxState.mockResolvedValue({ id: 9, status: 'provisioning' });

    const result = await WorkspaceRuntimeStateService.claimWorkspaceAction(17, {
      action: 'provision',
      claimedAt: '2026-05-09T00:10:00.000Z',
      sessionPatch: {
        workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
      },
      sandboxStatus: 'provisioning',
    });

    expect(patchAndFetchById).toHaveBeenCalledWith(17, {
      workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
    });
    expect(mockRecordSessionSandboxState).toHaveBeenCalledWith(patchedSession, {
      trx,
      sandboxStatus: 'provisioning',
      runtimeLifecycle: {
        currentAction: 'provision',
        claimedAt: '2026-05-09T00:10:00.000Z',
      },
    });
    expect(result).toEqual({
      session: patchedSession,
      sandbox: { id: 9, status: 'provisioning' },
    });
  });

  it('records workspace state with paired session and sandbox writes and can clear the action marker', async () => {
    const patchedSession = buildSession({
      workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
    });
    const patchAndFetchById = mockSessionPatch(patchedSession);
    mockRecordSessionSandboxState.mockResolvedValue({ id: 9, status: 'suspended' });

    const result = await WorkspaceRuntimeStateService.recordWorkspaceState(17, {
      sessionPatch: {
        workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
      },
      sandboxStatus: 'suspended',
      runtimeLifecycle: null,
    });

    expect(mockSessionTransaction).toHaveBeenCalled();
    expect(patchAndFetchById).toHaveBeenCalledWith(17, {
      workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
    });
    expect(mockRecordSessionSandboxState).toHaveBeenCalledWith(patchedSession, {
      trx,
      sandboxStatus: 'suspended',
      runtimeLifecycle: null,
    });
    expect(result.sandbox).toEqual({ id: 9, status: 'suspended' });
  });

  it('records workspace state using a caller-provided transaction', async () => {
    const callerTrx = { caller: true };
    const patchedSession = buildSession({
      workspaceStatus: AgentWorkspaceStatus.READY,
    });
    const patchAndFetchById = mockSessionPatch(patchedSession);
    mockRecordSessionSandboxState.mockResolvedValue({ id: 9, status: 'ready' });

    await WorkspaceRuntimeStateService.recordWorkspaceState(
      17,
      {
        sessionPatch: {
          workspaceStatus: AgentWorkspaceStatus.READY,
        },
        sandboxStatus: 'ready',
        runtimeLifecycle: null,
      },
      { trx: callerTrx as any }
    );

    expect(mockSessionTransaction).not.toHaveBeenCalled();
    expect(mockSessionQuery).toHaveBeenCalledWith(callerTrx);
    expect(patchAndFetchById).toHaveBeenCalledWith(17, {
      workspaceStatus: AgentWorkspaceStatus.READY,
    });
    expect(mockRecordSessionSandboxState).toHaveBeenCalledWith(patchedSession, {
      trx: callerTrx,
      sandboxStatus: 'ready',
      runtimeLifecycle: null,
    });
  });

  it('records workspace state only when the expected lifecycle claim is still current', async () => {
    const patchedSession = buildSession({
      workspaceStatus: AgentWorkspaceStatus.READY,
    });
    mockSessionLock();
    mockGetLatestSandboxForSession.mockResolvedValue({
      id: 9,
      metadata: {
        runtimeLifecycle: {
          currentAction: 'provision',
          claimedAt: '2026-05-09T00:10:00.000Z',
        },
      },
    });
    const patchAndFetchById = mockSessionPatch(patchedSession);

    await WorkspaceRuntimeStateService.recordWorkspaceState(
      17,
      {
        sessionPatch: {
          workspaceStatus: AgentWorkspaceStatus.READY,
        },
        sandboxStatus: 'ready',
        runtimeLifecycle: null,
      },
      {
        expectedLifecycle: {
          action: 'provision',
          claimedAt: '2026-05-09T00:10:00.000Z',
        },
      }
    );

    expect(patchAndFetchById).toHaveBeenCalledWith(17, {
      workspaceStatus: AgentWorkspaceStatus.READY,
    });
  });

  it('rejects workspace state writes when the expected lifecycle claim was superseded', async () => {
    mockSessionLock();
    mockGetLatestSandboxForSession.mockResolvedValue({
      id: 9,
      metadata: {
        runtimeLifecycle: {
          currentAction: 'cleanup',
          claimedAt: '2026-05-09T00:15:00.000Z',
        },
      },
    });

    await expect(
      WorkspaceRuntimeStateService.recordWorkspaceState(
        17,
        {
          sessionPatch: {
            workspaceStatus: AgentWorkspaceStatus.READY,
          },
          sandboxStatus: 'ready',
          runtimeLifecycle: null,
        },
        {
          expectedLifecycle: {
            action: 'provision',
            claimedAt: '2026-05-09T00:10:00.000Z',
          },
        }
      )
    ).rejects.toMatchObject({
      reason: 'action_in_progress',
    });

    expect(mockRecordSessionSandboxState).not.toHaveBeenCalled();
  });

  it('records workspace failures using a caller-provided transaction', async () => {
    const callerTrx = { caller: true };
    const failure = {
      stage: 'cleanup',
      title: 'Workspace cleanup failed',
      message: 'Lifecycle could not clean up the workspace.',
      recordedAt: '2026-05-09T00:12:00.000Z',
      retryable: false,
      origin: 'cleanup',
    } as const;
    const patchedSession = buildSession({
      workspaceStatus: AgentWorkspaceStatus.FAILED,
      status: 'error',
    });
    const patchAndFetchById = mockSessionPatch(patchedSession);
    mockRecordSessionSandboxState.mockResolvedValue({ id: 9, status: 'failed' });

    await WorkspaceRuntimeStateService.recordWorkspaceFailure(
      17,
      {
        sessionPatch: {
          status: 'error',
          workspaceStatus: AgentWorkspaceStatus.FAILED,
        },
        failure,
        runtimeLifecycle: null,
      },
      { trx: callerTrx as any }
    );

    expect(mockSessionTransaction).not.toHaveBeenCalled();
    expect(mockSessionQuery).toHaveBeenCalledWith(callerTrx);
    expect(patchAndFetchById).toHaveBeenCalledWith(17, {
      status: 'error',
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    expect(mockRecordSessionSandboxState).toHaveBeenCalledWith(patchedSession, {
      trx: callerTrx,
      failure,
      sandboxStatus: 'failed',
      runtimeLifecycle: null,
    });
  });
});
