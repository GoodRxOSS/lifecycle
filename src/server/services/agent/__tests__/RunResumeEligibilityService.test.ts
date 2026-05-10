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

describe('AgentRunResumeEligibilityService', () => {
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

  it('requires manual recovery for invalid run plans', () => {
    expect(evaluate({ runPlanSnapshot: null })).toEqual(
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
});
