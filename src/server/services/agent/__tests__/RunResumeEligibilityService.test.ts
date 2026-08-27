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

const mockResolveDurabilityConfig = jest.fn();
const mockPendingActionQuery = jest.fn();
const mockWhere = jest.fn();
const mockWhereIn = jest.fn();
const mockSelect = jest.fn();
const pendingActionQuery = {
  where: mockWhere,
  whereIn: mockWhereIn,
  select: mockSelect,
};

jest.mock('server/models/AgentPendingAction', () => ({
  __esModule: true,
  default: { query: () => mockPendingActionQuery() },
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  const actual = jest.requireActual('server/lib/agentSession/runtimeConfig');
  return {
    ...actual,
    resolveAgentSessionDurabilityConfig: (...args: unknown[]) => mockResolveDurabilityConfig(...args),
  };
});

import AgentRunResumeEligibilityService from '../RunResumeEligibilityService';

const now = new Date('2026-05-08T12:00:00.000Z');
const expiredLease = '2026-05-08T11:59:00.000Z';
const activeLease = '2026-05-08T12:01:00.000Z';

const readOnlyRunPlan = {
  version: 1,
  capturedAt: '2026-05-08T11:00:00.000Z',
  agent: {
    id: 'system.debug',
    label: 'Debug',
    sourceKind: 'build_context_chat',
  },
  source: {
    freshness: {
      capturedAt: '2026-05-08T11:00:00.000Z',
      freshnessSource: 'source',
    },
  },
  model: {
    resolvedProvider: 'openai',
    resolvedModel: 'gpt-5.4',
  },
  runtime: {
    resolvedHarness: 'lifecycle_ai_sdk',
    sandboxRequirement: {},
    runtimeOptions: {},
    approvalPolicy: {
      defaultMode: 'require_approval',
      rules: {},
    },
  },
  prompt: {
    instructionRefs: [],
    renderedSummary: 'Sample prompt summary',
    renderedHash: 'sha256:sample',
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
      {
        capabilityId: 'workspace_files',
        availability: 'admin_only',
        allowed: false,
        runtimeCapabilityKey: 'workspace_write',
        approvalMode: 'require_approval',
      },
    ],
  },
  debug: {
    requestedIntent: null,
    resolvedIntent: 'diagnose',
    decisionSource: 'default',
    reasonCode: 'default_debug_diagnosis',
  },
  warnings: [],
} as const;

function evaluate(overrides: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return AgentRunResumeEligibilityService.evaluate({
    now,
    pendingActions: {
      pending: 0,
      denied: 0,
    },
    run: {
      status: 'running',
      executionOwner: 'worker-1',
      leaseExpiresAt: expiredLease,
      runPlanSnapshot: readOnlyRunPlan,
      ...overrides,
    } as any,
    ...options,
  });
}

function persistedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    status: 'queued',
    executionOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    startedAt: null,
    runPlanSnapshot: readOnlyRunPlan,
    ...overrides,
  } as any;
}

describe('AgentRunResumeEligibilityService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveDurabilityConfig.mockResolvedValue({ runExecutionLeaseMs: 180_000 });
    mockPendingActionQuery.mockReturnValue(pendingActionQuery);
    mockWhere.mockReturnValue(pendingActionQuery);
    mockWhereIn.mockReturnValue(pendingActionQuery);
    mockSelect.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('classifies terminal runs at the current clock without consulting approvals or run plans', () => {
    jest.useFakeTimers().setSystemTime(now);

    expect(
      AgentRunResumeEligibilityService.evaluate({
        run: {
          status: 'completed',
          executionOwner: '',
          leaseExpiresAt: null,
          heartbeatAt: null,
          startedAt: null,
          runPlanSnapshot: null,
        } as any,
      })
    ).toEqual({
      decision: 'replay_only',
      reason: 'terminal_run',
      previousStatus: 'completed',
      previousOwner: null,
      leaseExpiresAt: null,
      evaluatedAt: now.toISOString(),
    });
  });

  it('keeps input-waiting runs replay-only', () => {
    expect(evaluate({ status: 'waiting_for_input' })).toEqual(
      expect.objectContaining({
        decision: 'replay_only',
        reason: 'waiting_for_input',
      })
    );
  });

  it('requires manual recovery when approval state is unavailable', () => {
    expect(evaluate({}, { pendingActions: null })).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'approval_state_unknown',
      })
    );
  });

  it('allows stale queued dispatch retries without requiring a read-only run plan', () => {
    const result = evaluate({
      status: 'queued',
      executionOwner: null,
      leaseExpiresAt: null,
      runPlanSnapshot: {
        ...readOnlyRunPlan,
        capabilities: {
          ...readOnlyRunPlan.capabilities,
          resolvedCapabilityAccess: [
            {
              capabilityId: 'workspace_files',
              availability: 'all_users',
              allowed: true,
              runtimeCapabilityKey: 'workspace_write',
              approvalMode: 'require_approval',
            },
          ],
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        decision: 'auto_resume_allowed',
        reason: 'queued_dispatch_retry',
        previousStatus: 'queued',
      })
    );
  });

  it('allows expired read-only Debug diagnosis runs', () => {
    expect(evaluate()).toEqual(
      expect.objectContaining({
        decision: 'auto_resume_allowed',
        reason: 'read_only_expired_lease',
        previousOwner: 'worker-1',
        leaseExpiresAt: expiredLease,
      })
    );
  });

  it('keeps active leases replay-only', () => {
    expect(evaluate({ leaseExpiresAt: activeLease })).toEqual(
      expect.objectContaining({
        decision: 'replay_only',
        reason: 'lease_active',
      })
    );
  });

  it('keeps active leases replay-only when the heartbeat is fresh', () => {
    // Fresh heartbeat (30s ago) within the 3-minute staleness window => still lease_active.
    expect(
      evaluate(
        { leaseExpiresAt: activeLease, heartbeatAt: '2026-05-08T11:59:30.000Z' },
        { heartbeatStaleMs: 3 * 60 * 1000 }
      )
    ).toEqual(
      expect.objectContaining({
        decision: 'replay_only',
        reason: 'lease_active',
      })
    );
  });

  it('does not treat a heartbeat-stale run as lease_active even when the lease is active', () => {
    // Stale heartbeat (5m ago) past the 3-min window: orphaned read-only run is auto-resume-eligible, not lease_active.
    expect(
      evaluate(
        { leaseExpiresAt: activeLease, heartbeatAt: '2026-05-08T11:55:00.000Z' },
        { heartbeatStaleMs: 3 * 60 * 1000 }
      )
    ).toEqual(
      expect.objectContaining({
        decision: 'auto_resume_allowed',
        reason: 'read_only_expired_lease',
      })
    );
  });

  it('falls back to startedAt when a run never heartbeated', () => {
    // No heartbeat; stale startedAt (5m) marks the run orphaned despite the active lease.
    expect(
      evaluate(
        { leaseExpiresAt: activeLease, heartbeatAt: null, startedAt: '2026-05-08T11:55:00.000Z' },
        { heartbeatStaleMs: 3 * 60 * 1000 }
      )
    ).toEqual(
      expect.objectContaining({
        decision: 'auto_resume_allowed',
        reason: 'read_only_expired_lease',
      })
    );
  });

  it('keeps approval-waiting runs out of stale recovery', () => {
    expect(evaluate({ status: 'waiting_for_approval' })).toEqual(
      expect.objectContaining({
        decision: 'replay_only',
        reason: 'waiting_for_approval',
      })
    );
  });

  it('requires manual recovery when pending approvals exist', () => {
    expect(
      evaluate(
        {},
        {
          pendingActions: {
            pending: 1,
            denied: 0,
          },
        }
      )
    ).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'pending_approval',
      })
    );
  });

  it('requires manual recovery when denied approvals exist', () => {
    expect(
      evaluate(
        {},
        {
          pendingActions: {
            pending: 0,
            denied: 1,
          },
        }
      )
    ).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'denied_approval',
      })
    );
  });

  it('requires manual recovery for Debug repair continuations', () => {
    expect(
      evaluate({
        runPlanSnapshot: {
          ...readOnlyRunPlan,
          debug: {
            ...readOnlyRunPlan.debug,
            resolvedIntent: 'repair',
          },
        },
      })
    ).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'debug_repair',
      })
    );
  });

  it('requires manual recovery for write-capable active continuations', () => {
    expect(
      evaluate({
        runPlanSnapshot: {
          ...readOnlyRunPlan,
          capabilities: {
            ...readOnlyRunPlan.capabilities,
            resolvedCapabilityAccess: [
              {
                capabilityId: 'workspace_shell',
                availability: 'all_users',
                allowed: true,
                runtimeCapabilityKey: 'shell_exec',
                approvalMode: 'require_approval',
              },
            ],
          },
        },
      })
    ).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'write_capability',
        detail: {
          capabilityId: 'workspace_shell',
          capabilityKey: 'shell_exec',
        },
      })
    );
  });

  it('requires manual recovery when an allowed capability has no runtime classification', () => {
    expect(
      evaluate({
        runPlanSnapshot: {
          ...readOnlyRunPlan,
          capabilities: {
            ...readOnlyRunPlan.capabilities,
            resolvedCapabilityAccess: [
              {
                capabilityId: 'unclassified_capability',
                availability: 'all_users',
                allowed: true,
                approvalMode: 'allow',
              },
            ],
          },
        },
      })
    ).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'unknown_capability',
        detail: {
          capabilityId: 'unclassified_capability',
          capabilityKey: null,
        },
      })
    );
  });

  it('allows expired runs whose only allowed capability is external MCP read', () => {
    expect(
      evaluate({
        runPlanSnapshot: {
          ...readOnlyRunPlan,
          capabilities: {
            ...readOnlyRunPlan.capabilities,
            resolvedCapabilityAccess: [
              {
                capabilityId: 'external_mcp',
                availability: 'all_users',
                allowed: true,
                runtimeCapabilityKey: 'external_mcp_read',
                approvalMode: 'allow',
              },
            ],
          },
        },
      })
    ).toEqual(
      expect.objectContaining({
        decision: 'auto_resume_allowed',
        reason: 'read_only_expired_lease',
      })
    );
  });

  it('does not apply the Debug repair guard outside build-context chat', () => {
    expect(
      evaluate({
        runPlanSnapshot: {
          ...readOnlyRunPlan,
          agent: { ...readOnlyRunPlan.agent, sourceKind: 'workspace_session' },
          debug: { ...readOnlyRunPlan.debug, resolvedIntent: 'repair' },
        },
      })
    ).toEqual(
      expect.objectContaining({
        decision: 'auto_resume_allowed',
        reason: 'read_only_expired_lease',
      })
    );
  });

  it('allows a safe non-Debug run plan with no debug metadata', () => {
    expect(
      evaluate({
        runPlanSnapshot: {
          ...readOnlyRunPlan,
          debug: undefined,
        },
      })
    ).toEqual(
      expect.objectContaining({
        decision: 'auto_resume_allowed',
        reason: 'read_only_expired_lease',
      })
    );
  });

  it('requires manual recovery for invalid run plans', () => {
    expect(evaluate({ runPlanSnapshot: null })).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'invalid_run_plan',
      })
    );
  });

  it('requires manual recovery for a versioned run plan with invalid capability access', () => {
    expect(
      evaluate({
        runPlanSnapshot: {
          ...readOnlyRunPlan,
          capabilities: {
            ...readOnlyRunPlan.capabilities,
            resolvedCapabilityAccess: null,
          },
        },
      })
    ).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'invalid_run_plan',
      })
    );
  });

  it('requires manual recovery for invalid saved state and exhausted event history', () => {
    expect(evaluate({}, { savedStateInvalid: true })).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'saved_state_invalid',
      })
    );
    expect(evaluate({}, { eventHistoryExhausted: true })).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'event_history_exhausted',
      })
    );
  });

  it('requires manual recovery when ownership is ambiguous', () => {
    expect(evaluate({ executionOwner: null })).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'ambiguous_ownership',
      })
    );
  });

  it('requires manual recovery when an owner has no lease expiry', () => {
    expect(evaluate({ leaseExpiresAt: null })).toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'ambiguous_ownership',
      })
    );
  });

  it('treats a lease expiring exactly at evaluation time as expired', () => {
    expect(evaluate({ leaseExpiresAt: now.toISOString() })).toEqual(
      expect.objectContaining({
        decision: 'auto_resume_allowed',
        reason: 'read_only_expired_lease',
      })
    );
  });

  it('evaluates an id-less run without querying approvals or resolving durability config when staleness is supplied', async () => {
    const run = persistedRun({
      id: undefined,
      status: 'running',
      executionOwner: 'worker-1',
      leaseExpiresAt: expiredLease,
    });

    await expect(AgentRunResumeEligibilityService.evaluateRun(run, { now, heartbeatStaleMs: 30_000 })).resolves.toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'approval_state_unknown',
      })
    );
    expect(mockResolveDurabilityConfig).not.toHaveBeenCalled();
    expect(mockPendingActionQuery).not.toHaveBeenCalled();
  });

  it('derives heartbeat staleness, queries only unresolved approvals, and retries a queued run with no rows', async () => {
    jest.useFakeTimers().setSystemTime(now);
    mockResolveDurabilityConfig.mockResolvedValue({ runExecutionLeaseMs: 90_000 });

    await expect(AgentRunResumeEligibilityService.evaluateRun(persistedRun())).resolves.toEqual(
      expect.objectContaining({
        decision: 'auto_resume_allowed',
        reason: 'queued_dispatch_retry',
        evaluatedAt: now.toISOString(),
      })
    );

    expect(mockResolveDurabilityConfig).toHaveBeenCalledTimes(1);
    expect(mockWhere).toHaveBeenCalledWith({ runId: 7 });
    expect(mockWhereIn).toHaveBeenCalledWith('status', ['pending', 'denied']);
    expect(mockSelect).toHaveBeenCalledWith('status');
  });

  it('counts pending approvals and gives them precedence over denied rows', async () => {
    mockSelect.mockResolvedValue([{ status: 'pending' }, { status: 'denied' }, { status: 'pending' }]);

    await expect(
      AgentRunResumeEligibilityService.evaluateRun(
        persistedRun({ status: 'running', executionOwner: 'worker-1', leaseExpiresAt: expiredLease }),
        { now }
      )
    ).resolves.toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'pending_approval',
        detail: { pendingActions: 2 },
      })
    );
  });

  it('counts denied approvals when no pending approval remains', async () => {
    mockSelect.mockResolvedValue([{ status: 'denied' }, { status: 'denied' }]);

    await expect(
      AgentRunResumeEligibilityService.evaluateRun(
        persistedRun({ status: 'running', executionOwner: 'worker-1', leaseExpiresAt: expiredLease }),
        { now }
      )
    ).resolves.toEqual(
      expect.objectContaining({
        decision: 'manual_recovery_required',
        reason: 'denied_approval',
        detail: { deniedActions: 2 },
      })
    );
  });

  it('uses the durability-derived heartbeat boundary to recover an orphaned run with an active lease', async () => {
    mockResolveDurabilityConfig.mockResolvedValue({ runExecutionLeaseMs: 30_000 });

    await expect(
      AgentRunResumeEligibilityService.evaluateRun(
        persistedRun({
          status: 'running',
          executionOwner: 'worker-1',
          leaseExpiresAt: activeLease,
          heartbeatAt: '2026-05-08T11:59:29.000Z',
        }),
        { now }
      )
    ).resolves.toEqual(
      expect.objectContaining({
        decision: 'auto_resume_allowed',
        reason: 'read_only_expired_lease',
      })
    );
  });

  it('propagates durability configuration failures before querying approvals', async () => {
    const configError = new Error('durability config unavailable');
    mockResolveDurabilityConfig.mockRejectedValue(configError);

    await expect(AgentRunResumeEligibilityService.evaluateRun(persistedRun(), { now })).rejects.toBe(configError);
    expect(mockPendingActionQuery).not.toHaveBeenCalled();
  });

  it('propagates approval query failures after durability resolution', async () => {
    const queryError = new Error('approval query failed');
    mockSelect.mockRejectedValue(queryError);

    await expect(AgentRunResumeEligibilityService.evaluateRun(persistedRun(), { now })).rejects.toBe(queryError);
    expect(mockResolveDurabilityConfig).toHaveBeenCalledTimes(1);
  });
});
