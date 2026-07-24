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

jest.mock('server/models/AgentSession');
jest.mock('server/models/AgentSandbox', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => ({
      where: jest.fn(() => ({ whereIn: jest.fn().mockResolvedValue([]) })),
    })),
  },
}));
jest.mock('server/services/agent/SandboxService', () => ({
  __esModule: true,
  default: {
    getLatestSandboxForSession: jest.fn().mockResolvedValue(null),
  },
}));
const mockResolveRemoteProvider = jest.fn();
jest.mock('server/services/workspaceRuntime/registry', () => {
  const actual = jest.requireActual('server/services/workspaceRuntime/registry');
  return {
    __esModule: true,
    ...actual,
    resolveRemoteRuntimeProviderForSandbox: (...args: unknown[]) => mockResolveRemoteProvider(...args),
  };
});
jest.mock('server/services/agentSession', () => {
  return {
    __esModule: true,
    default: {
      archiveSession: jest.fn(),
      releaseWorkspace: jest.fn(),
      suspendChatRuntime: jest.fn(),
    },
  };
});
jest.mock('server/services/agent/WorkspaceRuntimeStateService', () => {
  class WorkspaceActionBlockedError extends Error {
    constructor(
      public readonly reason: 'active_run' | 'action_in_progress',
      message: string,
      public readonly details: Record<string, unknown> = {}
    ) {
      super(message);
      this.name = 'WorkspaceActionBlockedError';
    }
  }

  return {
    __esModule: true,
    WorkspaceActionBlockedError,
    WorkspaceRuntimeStateService: {
      recordWorkspaceFailure: jest.fn(),
      claimWorkspaceAction: jest.fn().mockResolvedValue(undefined),
      recordWorkspaceState: jest.fn().mockResolvedValue({ session: {} }),
    },
  };
});
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
  })),
}));
jest.mock('server/lib/agentSession/runtimeConfig', () => {
  const actual = jest.requireActual('server/lib/agentSession/runtimeConfig');
  return {
    __esModule: true,
    ...actual,
    resolveAgentSessionCleanupConfig: jest.fn().mockResolvedValue({
      activeIdleSuspendMs: 30 * 60 * 1000,
      startingTimeoutMs: 15 * 60 * 1000,
      hibernatedRetentionMs: 24 * 60 * 60 * 1000,
      idleArchiveMs: 30 * 24 * 60 * 60 * 1000,
      intervalMs: 5 * 60 * 1000,
      redisTtlSeconds: 7200,
    }),
  };
});

import AgentSandbox from 'server/models/AgentSandbox';
import AgentSession from 'server/models/AgentSession';
import AgentSessionService from 'server/services/agentSession';
import { getLogger } from 'server/lib/logger';
import { processAgentSessionCleanup } from '../agentSessionCleanup';
import {
  WorkspaceActionBlockedError,
  WorkspaceRuntimeStateService,
} from 'server/services/agent/WorkspaceRuntimeStateService';
import { WorkspaceRuntimeGoneError } from 'server/services/workspaceRuntime/types';

const mockRecordWorkspaceFailure = WorkspaceRuntimeStateService.recordWorkspaceFailure as jest.Mock;
const mockClaimWorkspaceAction = WorkspaceRuntimeStateService.claimWorkspaceAction as jest.Mock;
const mockRecordWorkspaceState = WorkspaceRuntimeStateService.recordWorkspaceState as jest.Mock;

// idle-active cohort: 3 chained .where (status, lastActivity, callback) resolving on the 3rd.
function buildIdleActiveQuery(result: unknown[]) {
  const orWhereNotIn = jest.fn();
  const whereNot = jest.fn().mockReturnValue({ orWhereNotIn });
  const query = { where: jest.fn(), whereNot, orWhereNotIn };
  query.where
    .mockImplementationOnce(() => query)
    .mockImplementationOnce(() => query)
    .mockImplementationOnce((callback: (b: unknown) => void) => {
      callback({ whereNot });
      return Promise.resolve(result);
    });
  return query;
}

// workspace-startup-timeout cohort: 4 chained .where (status, sessionKind, workspaceStatus, updatedAt).
function buildFourWhereQuery(result: unknown[]) {
  const query = { where: jest.fn() };
  query.where
    .mockImplementationOnce(() => query)
    .mockImplementationOnce(() => query)
    .mockImplementationOnce(() => query)
    .mockImplementationOnce(() => Promise.resolve(result));
  return query;
}

// stale-starting cohort: 2 chained .where (status, updatedAt).
function buildTwoWhereQuery(result: unknown[]) {
  const query = { where: jest.fn() };
  query.where.mockImplementationOnce(() => query).mockImplementationOnce(() => Promise.resolve(result));
  return query;
}

// hibernated-expiry cohort: 5 chained .where (status, sessionKind, workspaceStatus, keepWorkspace, updatedAt).
function buildFiveWhereQuery(result: unknown[]) {
  const query = { where: jest.fn() };
  query.where
    .mockImplementationOnce(() => query)
    .mockImplementationOnce(() => query)
    .mockImplementationOnce(() => query)
    .mockImplementationOnce(() => query)
    .mockImplementationOnce(() => Promise.resolve(result));
  return query;
}

// idle-archive cohort: .whereIn(status), .where(keepWorkspace), .where(lastActivity) resolving.
function buildIdleArchiveQuery(result: unknown[]) {
  const query = { whereIn: jest.fn(), where: jest.fn() };
  query.whereIn.mockImplementationOnce(() => query);
  query.where.mockImplementationOnce(() => query).mockImplementationOnce(() => Promise.resolve(result));
  return query;
}

// kept-workspace renewal pass: .where({keepWorkspace, status}).select('id') resolving sessions.
function buildKeptSessionsQuery(result: Array<{ id: number }>) {
  const select = jest.fn().mockResolvedValue(result);
  const query = { where: jest.fn(() => ({ select })) };
  return { query, select };
}

/**
 * Wires AgentSession.query in source-call order:
 *   1) idle-active, 2) workspace-startup-timeout, 3) stale-starting, 4) hibernated-expiry,
 *   5) idle-archive, 6) kept-workspace renewal (remote maintenance pass).
 */
function mockCleanupQueries(opts: {
  idleActive?: unknown[];
  workspaceStartupTimeout?: unknown[];
  staleStarting?: unknown[];
  hibernatedExpiry?: unknown[];
  idleArchive?: unknown[];
  keptSessions?: Array<{ id: number }>;
}) {
  const idleActiveQuery = buildIdleActiveQuery(opts.idleActive ?? []);
  const idleArchiveQuery = buildIdleArchiveQuery(opts.idleArchive ?? []);
  const hibernatedExpiryQuery = buildFiveWhereQuery(opts.hibernatedExpiry ?? []);
  const keptSessionsQuery = buildKeptSessionsQuery(opts.keptSessions ?? []);
  (AgentSession.query as jest.Mock) = jest
    .fn()
    .mockReturnValueOnce(idleActiveQuery)
    .mockReturnValueOnce(buildFourWhereQuery(opts.workspaceStartupTimeout ?? []))
    .mockReturnValueOnce(buildTwoWhereQuery(opts.staleStarting ?? []))
    .mockReturnValueOnce(hibernatedExpiryQuery)
    .mockReturnValueOnce(idleArchiveQuery)
    .mockReturnValueOnce(keptSessionsQuery.query);
  return { idleActiveQuery, idleArchiveQuery, hibernatedExpiryQuery, keptSessionsQuery };
}

describe('agentSessionCleanup', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getLogger as jest.Mock).mockReturnValue(mockLogger);
    jest.useFakeTimers().setSystemTime(new Date('2026-03-23T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('archives both idle active environment sessions and stale starting sessions', async () => {
    const activeSessions = [
      {
        id: 1,
        uuid: 'active-session',
        status: 'active',
        sessionKind: 'environment',
        workspaceStatus: 'ready',
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:00:00.000Z',
      },
    ];
    const startingSessions = [
      {
        id: 2,
        uuid: 'starting-session',
        status: 'starting',
        lastActivity: '2026-03-23T11:50:00.000Z',
        updatedAt: '2026-03-23T11:40:00.000Z',
      },
    ];

    const { idleActiveQuery } = mockCleanupQueries({ idleActive: activeSessions, staleStarting: startingSessions });
    (AgentSessionService.archiveSession as jest.Mock).mockResolvedValue(undefined);

    await processAgentSessionCleanup();

    expect(AgentSession.query).toHaveBeenCalledTimes(6);
    // Idle chats with nothing to reclaim are excluded from the idle-active cohort in SQL.
    expect(idleActiveQuery.whereNot).toHaveBeenCalledWith('sessionKind', 'chat');
    expect(idleActiveQuery.orWhereNotIn).toHaveBeenCalledWith('workspaceStatus', ['hibernated', 'none']);
    expect(AgentSessionService.archiveSession).toHaveBeenCalledTimes(2);
    expect(AgentSessionService.archiveSession).toHaveBeenNthCalledWith(1, 'active-session');
    expect(AgentSessionService.archiveSession).toHaveBeenNthCalledWith(2, 'starting-session');
    expect(AgentSessionService.releaseWorkspace).not.toHaveBeenCalled();
  });

  it('suspends idle chat runtimes before terminal cleanup', async () => {
    const activeSessions = [
      {
        id: 1,
        uuid: 'chat-session',
        userId: 'sample-user',
        sessionKind: 'chat',
        workspaceStatus: 'ready',
        status: 'active',
        namespace: 'sample-namespace',
        podName: 'sample-pod',
        pvcName: 'sample-pvc',
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:00:00.000Z',
      },
    ];

    mockCleanupQueries({ idleActive: activeSessions });
    (AgentSessionService.suspendChatRuntime as jest.Mock).mockResolvedValue(undefined);

    await processAgentSessionCleanup();

    expect(AgentSessionService.suspendChatRuntime).toHaveBeenCalledWith({
      sessionId: 'chat-session',
      userId: 'sample-user',
    });
    expect(AgentSessionService.archiveSession).not.toHaveBeenCalled();
    expect(AgentSessionService.releaseWorkspace).not.toHaveBeenCalled();
  });

  it('releases workspaces of idle chat sessions when no ready runtime can be suspended', async () => {
    const activeSessions = [
      {
        id: 2,
        uuid: 'failed-chat-session',
        userId: 'sample-user',
        sessionKind: 'chat',
        workspaceStatus: 'failed',
        status: 'active',
        namespace: 'sample-namespace',
        pvcName: 'sample-pvc',
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:00:00.000Z',
      },
      {
        id: 3,
        uuid: 'missing-pod-chat-session',
        userId: 'sample-user',
        sessionKind: 'chat',
        workspaceStatus: 'ready',
        status: 'active',
        namespace: 'sample-namespace',
        podName: null,
        pvcName: 'sample-pvc',
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:00:00.000Z',
      },
    ];

    mockCleanupQueries({ idleActive: activeSessions });
    (AgentSessionService.releaseWorkspace as jest.Mock).mockResolvedValue(undefined);

    await processAgentSessionCleanup();

    expect(AgentSessionService.suspendChatRuntime).not.toHaveBeenCalled();
    expect(AgentSessionService.releaseWorkspace).toHaveBeenCalledTimes(2);
    expect(AgentSessionService.releaseWorkspace).toHaveBeenNthCalledWith(1, 'failed-chat-session');
    expect(AgentSessionService.releaseWorkspace).toHaveBeenNthCalledWith(2, 'missing-pod-chat-session');
    expect(AgentSessionService.archiveSession).not.toHaveBeenCalled();
  });

  it('skips idle cleanup when releaseWorkspace reports an active run', async () => {
    const activeSessions = [
      {
        id: 1,
        uuid: 'failed-chat-session',
        userId: 'sample-user',
        sessionKind: 'chat',
        workspaceStatus: 'failed',
        status: 'active',
        namespace: null,
        pvcName: null,
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:00:00.000Z',
      },
    ];

    mockCleanupQueries({ idleActive: activeSessions });
    (AgentSessionService.releaseWorkspace as jest.Mock).mockRejectedValue(
      new WorkspaceActionBlockedError('active_run', 'Active run')
    );

    await processAgentSessionCleanup();

    expect(AgentSessionService.suspendChatRuntime).not.toHaveBeenCalled();
    expect(AgentSessionService.releaseWorkspace).toHaveBeenCalledWith('failed-chat-session');
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Session: cleanup skipped sessionId=failed-chat-session reason=active_run'
    );
  });

  it('skips idle cleanup when releaseWorkspace reports a lifecycle action in progress', async () => {
    const activeSessions = [
      {
        id: 1,
        uuid: 'failed-chat-session',
        userId: 'sample-user',
        sessionKind: 'chat',
        workspaceStatus: 'failed',
        status: 'active',
        namespace: null,
        pvcName: null,
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:00:00.000Z',
      },
    ];

    mockCleanupQueries({ idleActive: activeSessions });
    (AgentSessionService.releaseWorkspace as jest.Mock).mockRejectedValue(
      new WorkspaceActionBlockedError('action_in_progress', 'Action in progress', {
        currentAction: 'resume',
      })
    );

    await processAgentSessionCleanup();

    expect(AgentSessionService.suspendChatRuntime).not.toHaveBeenCalled();
    expect(AgentSessionService.releaseWorkspace).toHaveBeenCalledWith('failed-chat-session');
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Session: cleanup skipped sessionId=failed-chat-session reason=action_in_progress'
    );
  });

  it('does not touch an idle chat session while runtime provisioning is still fresh', async () => {
    const activeSessions = [
      {
        id: 1,
        uuid: 'provisioning-chat-session',
        userId: 'sample-user',
        sessionKind: 'chat',
        workspaceStatus: 'provisioning',
        status: 'active',
        namespace: 'sample-namespace',
        pvcName: 'sample-pvc',
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:50:00.000Z',
      },
    ];

    mockCleanupQueries({ idleActive: activeSessions });

    await processAgentSessionCleanup();

    expect(AgentSessionService.suspendChatRuntime).not.toHaveBeenCalled();
    expect(AgentSessionService.archiveSession).not.toHaveBeenCalled();
    expect(AgentSessionService.releaseWorkspace).not.toHaveBeenCalled();
    expect(mockRecordWorkspaceFailure).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Session: cleanup skipped sessionId=provisioning-chat-session reason=runtime_provisioning'
    );
  });

  it('transitions a stale workspace-starting chat session to a retryable failure instead of archiving it', async () => {
    // Stale workspace startup (updatedAt past the 15-min starting cutoff) lands in the startup-timeout cohort.
    const timedOutSession = {
      id: 1,
      uuid: 'stale-workspace-starting-chat-session',
      userId: 'sample-user',
      sessionKind: 'chat',
      workspaceStatus: 'provisioning',
      status: 'active',
      namespace: 'sample-namespace',
      pvcName: 'sample-pvc',
      lastActivity: '2026-03-23T11:00:00.000Z',
      updatedAt: '2026-03-23T11:40:00.000Z',
    };

    mockCleanupQueries({ workspaceStartupTimeout: [timedOutSession] });
    mockRecordWorkspaceFailure.mockResolvedValue(undefined);

    await processAgentSessionCleanup();

    // Recovered to retryable FAILED, never archived/released and never suspended.
    expect(AgentSessionService.archiveSession).not.toHaveBeenCalled();
    expect(AgentSessionService.releaseWorkspace).not.toHaveBeenCalled();
    expect(AgentSessionService.suspendChatRuntime).not.toHaveBeenCalled();
    expect(mockRecordWorkspaceFailure).toHaveBeenCalledTimes(1);

    const [sessionIdArg, stateArg] = mockRecordWorkspaceFailure.mock.calls[0];
    expect(sessionIdArg).toBe(1);
    expect(stateArg.sessionPatch).toEqual(
      expect.objectContaining({
        status: 'active',
        workspaceStatus: 'failed',
      })
    );
    // Lifecycle claim released so the FAILED -> retry path is unblocked.
    expect(stateArg.runtimeLifecycle).toBeNull();
    expect(stateArg.failure).toEqual(
      expect.objectContaining({
        code: 'workspace_startup_timeout',
        retryable: true,
        stage: 'connect_runtime',
        origin: 'chat_runtime',
      })
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Session: cleanup workspace startup timed out sessionId=stale-workspace-starting-chat-session'
      )
    );
  });

  it('skips idle chat suspension when a run is still active', async () => {
    const activeSessions = [
      {
        id: 1,
        uuid: 'chat-session',
        userId: 'sample-user',
        sessionKind: 'chat',
        workspaceStatus: 'ready',
        status: 'active',
        namespace: 'sample-namespace',
        podName: 'sample-pod',
        pvcName: 'sample-pvc',
        lastActivity: '2026-03-23T11:00:00.000Z',
        updatedAt: '2026-03-23T11:00:00.000Z',
      },
    ];

    mockCleanupQueries({ idleActive: activeSessions });
    (AgentSessionService.suspendChatRuntime as jest.Mock).mockRejectedValue(
      new WorkspaceActionBlockedError('active_run', 'Active run')
    );

    await processAgentSessionCleanup();

    expect(AgentSessionService.suspendChatRuntime).toHaveBeenCalledWith({
      sessionId: 'chat-session',
      userId: 'sample-user',
    });
    expect(AgentSessionService.archiveSession).not.toHaveBeenCalled();
    expect(AgentSessionService.releaseWorkspace).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('Session: cleanup skipped sessionId=chat-session reason=active_run');
  });

  it('logs but does not archive the session when the workspace-startup-timeout failure write fails', async () => {
    const timedOutSession = {
      id: 7,
      uuid: 'reaper-error-chat-session',
      userId: 'sample-user',
      sessionKind: 'chat',
      workspaceStatus: 'provisioning',
      status: 'active',
      namespace: 'sample-namespace',
      pvcName: 'sample-pvc',
      lastActivity: '2026-03-23T11:00:00.000Z',
      updatedAt: '2026-03-23T11:40:00.000Z',
    };

    mockCleanupQueries({ workspaceStartupTimeout: [timedOutSession] });
    mockRecordWorkspaceFailure.mockRejectedValue(new Error('db write failed'));

    await processAgentSessionCleanup();

    expect(mockRecordWorkspaceFailure).toHaveBeenCalledTimes(1);
    // A failed failure-write must never fall back to destroying the recoverable session.
    expect(AgentSessionService.archiveSession).not.toHaveBeenCalled();
    expect(AgentSessionService.releaseWorkspace).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'reaper-error-chat-session' }),
      expect.stringContaining('Session: cleanup workspace-startup-timeout failed')
    );
  });

  it('releases expired hibernated chat workspaces instead of archiving the session', async () => {
    const hibernatedSession = {
      id: 5,
      uuid: 'hibernated-chat-session',
      userId: 'sample-user',
      sessionKind: 'chat',
      workspaceStatus: 'hibernated',
      status: 'active',
      lastActivity: '2026-03-21T12:00:00.000Z',
      updatedAt: '2026-03-21T12:00:00.000Z',
    };

    mockCleanupQueries({ hibernatedExpiry: [hibernatedSession] });
    (AgentSessionService.releaseWorkspace as jest.Mock).mockResolvedValue(undefined);

    await processAgentSessionCleanup();

    expect(AgentSessionService.releaseWorkspace).toHaveBeenCalledWith('hibernated-chat-session');
    expect(AgentSessionService.archiveSession).not.toHaveBeenCalled();
    expect(AgentSessionService.suspendChatRuntime).not.toHaveBeenCalled();
  });

  it('archives long-idle active and errored sessions in the idle-archive pass', async () => {
    const idleArchiveSessions = [
      {
        id: 6,
        uuid: 'dormant-chat-session',
        userId: 'sample-user',
        sessionKind: 'chat',
        workspaceStatus: 'none',
        status: 'active',
        lastActivity: '2026-02-01T12:00:00.000Z',
        updatedAt: '2026-02-01T12:00:00.000Z',
      },
      {
        id: 7,
        uuid: 'dormant-error-session',
        userId: 'sample-user',
        sessionKind: 'environment',
        workspaceStatus: 'failed',
        status: 'error',
        lastActivity: '2026-02-01T12:00:00.000Z',
        updatedAt: '2026-02-01T12:00:00.000Z',
      },
    ];

    const { idleArchiveQuery } = mockCleanupQueries({ idleArchive: idleArchiveSessions });
    (AgentSessionService.archiveSession as jest.Mock).mockResolvedValue(undefined);

    await processAgentSessionCleanup();

    expect(idleArchiveQuery.whereIn).toHaveBeenCalledWith('status', ['active', 'error']);
    expect(idleArchiveQuery.where).toHaveBeenCalledWith('lastActivity', '<', new Date('2026-02-21T12:00:00.000Z'));
    expect(AgentSessionService.archiveSession).toHaveBeenCalledTimes(2);
    expect(AgentSessionService.archiveSession).toHaveBeenNthCalledWith(1, 'dormant-chat-session');
    expect(AgentSessionService.archiveSession).toHaveBeenNthCalledWith(2, 'dormant-error-session');
    expect(AgentSessionService.releaseWorkspace).not.toHaveBeenCalled();
  });

  it('never reclaims a kept workspace: filters pinned sessions out of expiry and idle-archive in SQL', async () => {
    const { hibernatedExpiryQuery, idleArchiveQuery } = mockCleanupQueries({});

    await processAgentSessionCleanup();

    expect(hibernatedExpiryQuery.where).toHaveBeenCalledWith('keepWorkspace', false);
    expect(idleArchiveQuery.where).toHaveBeenCalledWith('keepWorkspace', false);
  });

  it('skips releasing an idle unsuspendable chat workspace when the session is kept', async () => {
    const keptSession = {
      id: 11,
      uuid: 'kept-chat-session',
      userId: 'sample-user',
      sessionKind: 'chat',
      workspaceStatus: 'failed',
      status: 'active',
      keepWorkspace: true,
      lastActivity: '2026-03-23T11:00:00.000Z',
      updatedAt: '2026-03-23T11:00:00.000Z',
    };

    mockCleanupQueries({ idleActive: [keptSession] });

    await processAgentSessionCleanup();

    expect(AgentSessionService.releaseWorkspace).not.toHaveBeenCalled();
    expect(AgentSessionService.archiveSession).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Session: cleanup skipped sessionId=kept-chat-session reason=keep_workspace'
    );
  });

  it('renews the provider lease of kept suspended remote sandboxes so the pin outlives the TTL', async () => {
    mockCleanupQueries({ keptSessions: [{ id: 42 }] });
    const suspendedSandbox = {
      id: 13,
      sessionId: 42,
      provider: 'opensandbox',
      status: 'suspended',
      providerState: { sandboxId: 'sb-kept' },
    };
    const keptWhereIn2 = jest.fn().mockResolvedValue([suspendedSandbox]);
    const keptWhereIn1 = jest.fn(() => ({ whereIn: keptWhereIn2 }));
    (AgentSandbox.query as jest.Mock)
      .mockImplementationOnce(() => ({ where: jest.fn(() => ({ whereIn: keptWhereIn1 })) }))
      .mockImplementationOnce(() => ({
        where: jest.fn(() => ({ whereIn: jest.fn().mockResolvedValue([]) })),
      }));
    const renewLease = jest.fn().mockResolvedValue(undefined);
    mockResolveRemoteProvider.mockResolvedValue({ renewLease });

    await processAgentSessionCleanup();

    expect(keptWhereIn2).toHaveBeenCalledWith('sessionId', [42]);
    expect(renewLease).toHaveBeenCalledWith({ sandboxId: 'sb-kept' });
  });

  describe('modal 24h-wall checkpointing', () => {
    // mockImplementationOnce queues survive clearMocks; reset so unconsumed impls never leak across tests.
    beforeEach(() => {
      (AgentSandbox.query as jest.Mock).mockReset();
      (AgentSandbox.query as jest.Mock).mockImplementation(() => ({
        where: jest.fn(() => ({ whereIn: jest.fn().mockResolvedValue([]) })),
      }));
    });

    function buildModalRow(createdAtMsAgo: number, overrides: Record<string, unknown> = {}) {
      return {
        id: 9,
        sessionId: 321,
        provider: 'modal',
        status: 'ready',
        providerState: {
          appName: 'lifecycle-workspaces',
          sandboxId: 'sb-1',
          snapshotImageId: 'im-prev',
          createdAt: new Date(Date.now() - createdAtMsAgo).toISOString(),
          timeoutMs: 24 * 60 * 60 * 1000,
        },
        ...overrides,
      };
    }

    // Wires AgentSandbox.query for: 1) list (.where().whereIn()), 2) re-fetch (.findById()),
    // 3) conditional merge persist (.patch().where().where()).
    function mockSandboxQueries(row: Record<string, unknown>, current = row, patchCount = 1) {
      const whereIn = jest.fn().mockResolvedValue([row]);
      const findById = jest.fn().mockResolvedValue(current);
      const persistWhere2 = jest.fn().mockResolvedValue(patchCount);
      const persistWhere1 = jest.fn(() => ({ where: persistWhere2 }));
      const patch = jest.fn(() => ({ where: persistWhere1 }));
      (AgentSandbox.query as jest.Mock)
        .mockImplementationOnce(() => ({ where: jest.fn(() => ({ whereIn })) }))
        .mockImplementationOnce(() => ({ findById }))
        .mockImplementationOnce(() => ({ patch }));
      return { whereIn, findById, patch, persistWhere1, persistWhere2 };
    }

    it('filters the sandbox scan to remote providers in SQL (pure-K8s installs read no remote rows)', async () => {
      mockCleanupQueries({});
      const whereIn = jest.fn().mockResolvedValue([]);
      const where = jest.fn(() => ({ whereIn }));
      (AgentSandbox.query as jest.Mock).mockImplementationOnce(() => ({ where }));
      mockResolveRemoteProvider.mockResolvedValue(null);

      await processAgentSessionCleanup();

      expect(where).toHaveBeenCalledWith({ status: 'ready' });
      expect(whereIn).toHaveBeenCalledWith(
        'provider',
        expect.arrayContaining(['opensandbox', 'e2b', 'modal', 'daytona'])
      );
      expect(whereIn.mock.calls[0][1]).not.toContain('lifecycle_kubernetes');
    });

    it('checkpoints wall-adjacent modal sandboxes and persists a MERGED state via a status-guarded patch', async () => {
      mockCleanupQueries({});
      // 23h50m old with a 24h wall: inside the max(2×cadence, 10min) margin.
      const row = buildModalRow(24 * 60 * 60 * 1000 - 5 * 60 * 1000);
      const { findById, patch, persistWhere1, persistWhere2 } = mockSandboxQueries(row);
      const checkpoint = jest.fn().mockResolvedValue({
        providerState: { ...(row.providerState as Record<string, unknown>), snapshotImageId: 'im-ckpt' },
        capabilitySnapshot: {},
      });
      mockResolveRemoteProvider.mockResolvedValue({ checkpoint });

      await processAgentSessionCleanup();

      expect(findById).toHaveBeenCalledWith(9);
      expect(checkpoint).toHaveBeenCalledWith(row.providerState);
      // Merge (not full-replace): the prior snapshot/appName survive alongside the new snapshot id.
      expect(patch).toHaveBeenCalledWith({
        providerState: expect.objectContaining({ appName: 'lifecycle-workspaces', snapshotImageId: 'im-ckpt' }),
      });
      // Conditional on the row still being 'ready' so a concurrent suspend wins the race.
      expect(persistWhere1).toHaveBeenCalledWith('id', 9);
      expect(persistWhere2).toHaveBeenCalledWith('status', 'ready');
    });

    it('skips the checkpoint persist when the row was superseded (no longer ready) between read and re-fetch', async () => {
      mockCleanupQueries({});
      const row = buildModalRow(24 * 60 * 60 * 1000 - 5 * 60 * 1000);
      const { patch } = mockSandboxQueries(row, { ...row, status: 'suspending' });
      const checkpoint = jest.fn();
      mockResolveRemoteProvider.mockResolvedValue({ checkpoint });

      await processAgentSessionCleanup();

      expect(checkpoint).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
    });

    it('does not checkpoint modal sandboxes far from the wall', async () => {
      mockCleanupQueries({});
      const row = buildModalRow(60 * 60 * 1000);
      (AgentSandbox.query as jest.Mock).mockImplementationOnce(() => ({
        where: jest.fn(() => ({ whereIn: jest.fn().mockResolvedValue([row]) })),
      }));
      const checkpoint = jest.fn();
      const renewLease = jest.fn().mockResolvedValue(undefined);
      mockResolveRemoteProvider.mockResolvedValue({ checkpoint, renewLease });

      await processAgentSessionCleanup();

      expect(renewLease).toHaveBeenCalledWith(row.providerState);
      expect(checkpoint).not.toHaveBeenCalled();
    });

    it('hibernates a wall-killed (gone) modal sandbox from its last checkpoint instead of spamming', async () => {
      mockCleanupQueries({});
      const row = buildModalRow(24 * 60 * 60 * 1000 - 5 * 60 * 1000);
      mockSandboxQueries(row);
      (AgentSession.query as jest.Mock).mockReturnValueOnce({
        findById: jest.fn().mockResolvedValue({ id: 321, status: 'active', workspaceStatus: 'ready' }),
      });
      mockResolveRemoteProvider.mockResolvedValue({
        checkpoint: jest.fn().mockRejectedValue(new WorkspaceRuntimeGoneError('gone')),
      });

      await expect(processAgentSessionCleanup()).resolves.toBeUndefined();

      expect(mockClaimWorkspaceAction).toHaveBeenCalledWith(321, expect.objectContaining({ action: 'cleanup' }));
      expect(mockRecordWorkspaceState).toHaveBeenCalledWith(
        321,
        expect.objectContaining({
          sandboxStatus: 'suspended',
          providerState: { sandboxId: null, gatewayUrl: null },
        }),
        expect.objectContaining({ expectedLifecycle: expect.objectContaining({ action: 'cleanup' }) })
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('keeps the pass non-fatal when checkpointing fails', async () => {
      mockCleanupQueries({});
      const row = buildModalRow(24 * 60 * 60 * 1000 - 5 * 60 * 1000);
      mockSandboxQueries(row);
      mockResolveRemoteProvider.mockResolvedValue({
        checkpoint: jest.fn().mockRejectedValue(new Error('snapshot failed')),
      });

      await expect(processAgentSessionCleanup()).resolves.toBeUndefined();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});
