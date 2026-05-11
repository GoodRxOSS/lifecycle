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

import AgentPendingAction from 'server/models/AgentPendingAction';
import type AgentRun from 'server/models/AgentRun';
import { isAgentRunPlanSnapshotV1, type AgentRunPlanResolvedCapabilityAccess } from './runPlanTypes';
import type { AgentCapabilityKey, AgentRunStatus } from './types';

export type AgentRunResumeDecision = 'auto_resume_allowed' | 'replay_only' | 'manual_recovery_required';

export type AgentRunResumeReason =
  | 'queued_dispatch_retry'
  | 'read_only_expired_lease'
  | 'terminal_run'
  | 'waiting_for_approval'
  | 'waiting_for_input'
  | 'lease_active'
  | 'approval_state_unknown'
  | 'pending_approval'
  | 'denied_approval'
  | 'invalid_run_plan'
  | 'ambiguous_ownership'
  | 'event_history_exhausted'
  | 'saved_state_invalid'
  | 'debug_repair'
  | 'write_capability'
  | 'unknown_capability'
  | 'unsupported_status';

export interface AgentRunResumeEligibility {
  decision: AgentRunResumeDecision;
  reason: AgentRunResumeReason;
  previousStatus: AgentRunStatus;
  previousOwner: string | null;
  leaseExpiresAt: string | null;
  evaluatedAt: string;
  detail?: Record<string, unknown>;
}

export interface AgentRunPendingActionSummary {
  pending: number;
  denied: number;
}

export interface EvaluateRunResumeEligibilityInput {
  run: Pick<AgentRun, 'status' | 'executionOwner' | 'leaseExpiresAt' | 'runPlanSnapshot'> & {
    id?: number;
  };
  pendingActions?: AgentRunPendingActionSummary | null;
  now?: Date;
  eventHistoryExhausted?: boolean;
  savedStateInvalid?: boolean;
}

const TERMINAL_STATUSES = new Set<AgentRunStatus>(['completed', 'failed', 'cancelled']);
const AUTO_RESUME_SAFE_CAPABILITY_KEYS = new Set<AgentCapabilityKey>(['read', 'external_mcp_read']);

function decision(
  input: EvaluateRunResumeEligibilityInput,
  nextDecision: AgentRunResumeDecision,
  reason: AgentRunResumeReason,
  detail?: Record<string, unknown>
): AgentRunResumeEligibility {
  const now = input.now || new Date();

  return {
    decision: nextDecision,
    reason,
    previousStatus: input.run.status,
    previousOwner: input.run.executionOwner || null,
    leaseExpiresAt: input.run.leaseExpiresAt || null,
    evaluatedAt: now.toISOString(),
    ...(detail ? { detail } : {}),
  };
}

function isLeaseExpired(leaseExpiresAt: string | null | undefined, now: Date): boolean {
  return Boolean(leaseExpiresAt) && new Date(leaseExpiresAt as string).getTime() <= now.getTime();
}

function unsafeCapability(access: AgentRunPlanResolvedCapabilityAccess): {
  reason: Extract<AgentRunResumeReason, 'unknown_capability' | 'write_capability'>;
  capabilityId: string;
  capabilityKey: string | null;
} | null {
  if (!access.allowed) {
    return null;
  }

  if (!access.runtimeCapabilityKey) {
    return {
      reason: 'unknown_capability',
      capabilityId: access.capabilityId,
      capabilityKey: null,
    };
  }

  if (AUTO_RESUME_SAFE_CAPABILITY_KEYS.has(access.runtimeCapabilityKey)) {
    return null;
  }

  return {
    reason: 'write_capability',
    capabilityId: access.capabilityId,
    capabilityKey: access.runtimeCapabilityKey,
  };
}

function listResolvedCapabilityAccess(value: unknown): AgentRunPlanResolvedCapabilityAccess[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const capabilities = (value as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return null;
  }

  const access = (capabilities as { resolvedCapabilityAccess?: unknown }).resolvedCapabilityAccess;
  return Array.isArray(access) ? (access as AgentRunPlanResolvedCapabilityAccess[]) : null;
}

export default class AgentRunResumeEligibilityService {
  static evaluate(input: EvaluateRunResumeEligibilityInput): AgentRunResumeEligibility {
    const now = input.now || new Date();
    const pendingActions = input.pendingActions;

    if (TERMINAL_STATUSES.has(input.run.status)) {
      return decision(input, 'replay_only', 'terminal_run');
    }

    if (input.run.status === 'waiting_for_approval') {
      return decision(input, 'replay_only', 'waiting_for_approval');
    }

    if (input.run.status === 'waiting_for_input') {
      return decision(input, 'replay_only', 'waiting_for_input');
    }

    if (!pendingActions) {
      return decision(input, 'manual_recovery_required', 'approval_state_unknown');
    }

    if (pendingActions.pending > 0) {
      return decision(input, 'manual_recovery_required', 'pending_approval', {
        pendingActions: pendingActions.pending,
      });
    }

    if (pendingActions.denied > 0) {
      return decision(input, 'manual_recovery_required', 'denied_approval', {
        deniedActions: pendingActions.denied,
      });
    }

    if (!isAgentRunPlanSnapshotV1(input.run.runPlanSnapshot)) {
      return decision(input, 'manual_recovery_required', 'invalid_run_plan');
    }

    if (input.savedStateInvalid) {
      return decision(input, 'manual_recovery_required', 'saved_state_invalid');
    }

    if (input.eventHistoryExhausted) {
      return decision(input, 'manual_recovery_required', 'event_history_exhausted');
    }

    if (input.run.status === 'queued') {
      return decision(input, 'auto_resume_allowed', 'queued_dispatch_retry');
    }

    if (input.run.status !== 'starting' && input.run.status !== 'running') {
      return decision(input, 'manual_recovery_required', 'unsupported_status');
    }

    if (!input.run.executionOwner || !input.run.leaseExpiresAt) {
      return decision(input, 'manual_recovery_required', 'ambiguous_ownership');
    }

    if (!isLeaseExpired(input.run.leaseExpiresAt, now)) {
      return decision(input, 'replay_only', 'lease_active');
    }

    const runPlan = input.run.runPlanSnapshot;
    const capabilityAccess = listResolvedCapabilityAccess(runPlan);
    if (!capabilityAccess) {
      return decision(input, 'manual_recovery_required', 'invalid_run_plan');
    }

    if (runPlan.agent?.id === 'system.debug' && runPlan.debug?.resolvedIntent === 'repair') {
      return decision(input, 'manual_recovery_required', 'debug_repair');
    }

    for (const access of capabilityAccess) {
      const unsafe = unsafeCapability(access);
      if (unsafe) {
        return decision(input, 'manual_recovery_required', unsafe.reason, {
          capabilityId: unsafe.capabilityId,
          capabilityKey: unsafe.capabilityKey,
        });
      }
    }

    return decision(input, 'auto_resume_allowed', 'read_only_expired_lease');
  }

  static async evaluateRun(
    run: AgentRun & { id?: number },
    options: Omit<EvaluateRunResumeEligibilityInput, 'run' | 'pendingActions'> = {}
  ): Promise<AgentRunResumeEligibility> {
    if (!Number.isInteger(run.id)) {
      return this.evaluate({
        run,
        pendingActions: null,
        ...options,
      });
    }

    const approvalRows = await AgentPendingAction.query()
      .where({ runId: run.id })
      .whereIn('status', ['pending', 'denied'])
      .select('status');

    const pendingActions = approvalRows.reduce<AgentRunPendingActionSummary>(
      (summary, action) => {
        if (action.status === 'pending') {
          summary.pending += 1;
        } else if (action.status === 'denied') {
          summary.denied += 1;
        }

        return summary;
      },
      { pending: 0, denied: 0 }
    );

    return this.evaluate({
      run,
      pendingActions,
      ...options,
    });
  }
}
