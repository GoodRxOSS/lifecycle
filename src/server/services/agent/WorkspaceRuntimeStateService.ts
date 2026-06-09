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

import type { PartialModelObject, Transaction } from 'objection';
import {
  DEFAULT_AGENT_SESSION_STARTING_TIMEOUT_MS,
  type ResolvedAgentSessionWorkspaceStorageIntent,
} from 'server/lib/agentSession/runtimeConfig';
import type { WorkspaceRuntimeFailure } from 'server/lib/agentSession/startupFailureState';
import type { WorkspaceRuntimePlanMetadata } from 'server/lib/agentSession/workspaceRuntimePlan';
import type AgentSandbox from 'server/models/AgentSandbox';
import AgentRun from 'server/models/AgentRun';
import AgentSession from 'server/models/AgentSession';
import { ConflictError } from 'server/lib/appError';
import AgentSandboxService, { type AgentSandboxRuntimeLifecycleMetadata } from './SandboxService';
import { TERMINAL_RUN_STATUSES } from './RunService';

export type WorkspaceRuntimeAction = 'provision' | 'resume' | 'suspend' | 'end' | 'cleanup' | 'retry';
export type WorkspaceActionBlockedReason = 'active_run' | 'action_in_progress';

export class WorkspaceActionBlockedError extends ConflictError {
  readonly reason: WorkspaceActionBlockedReason;
  constructor(reason: WorkspaceActionBlockedReason, message: string, extra: Record<string, unknown> = {}) {
    super(message, 'workspace_action_blocked', { reason, ...extra });
    this.name = 'WorkspaceActionBlockedError';
    this.reason = reason;
  }
}

interface WorkspaceRuntimeStateWrite {
  sessionPatch: PartialModelObject<AgentSession>;
  sandboxStatus?: AgentSandbox['status'];
  runtimeLifecycle?: AgentSandboxRuntimeLifecycleMetadata | null;
  workspaceStorage?: ResolvedAgentSessionWorkspaceStorageIntent;
  runtimePlanMetadata?: WorkspaceRuntimePlanMetadata;
  runtimeProvider?: string;
  providerState?: Record<string, unknown>;
  capabilitySnapshot?: Record<string, unknown>;
}

interface WorkspaceRuntimeFailureWrite extends WorkspaceRuntimeStateWrite {
  failure: WorkspaceRuntimeFailure;
}

interface ClaimWorkspaceActionOptions extends WorkspaceRuntimeStateWrite {
  action: WorkspaceRuntimeAction;
  claimedAt?: string;
  activeActionTimeoutMs?: number;
  allowedActiveRunUuid?: string | null;
}

interface TransactionOptions {
  trx?: Transaction;
  expectedLifecycle?: {
    action: WorkspaceRuntimeAction;
    claimedAt?: string;
  };
}

interface WorkspaceRuntimeStateResult {
  session: AgentSession;
  sandbox: AgentSandbox | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRuntimeLifecycle(metadata: unknown): AgentSandboxRuntimeLifecycleMetadata | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.runtimeLifecycle)) {
    return undefined;
  }

  const currentAction = readString(metadata.runtimeLifecycle.currentAction);
  if (!currentAction) {
    return undefined;
  }

  const claimedAt = readString(metadata.runtimeLifecycle.claimedAt);
  return {
    currentAction,
    ...(claimedAt ? { claimedAt } : {}),
  };
}

function isActiveLifecycleClaim(
  lifecycle: AgentSandboxRuntimeLifecycleMetadata | undefined,
  timeoutMs = DEFAULT_AGENT_SESSION_STARTING_TIMEOUT_MS,
  now = Date.now()
): boolean {
  if (!lifecycle?.currentAction || !lifecycle.claimedAt) {
    return false;
  }

  const claimedAtMs = Date.parse(lifecycle.claimedAt);
  if (!Number.isFinite(claimedAtMs)) {
    return false;
  }

  return now - claimedAtMs < timeoutMs;
}

async function withTransaction<T>(
  trx: Transaction | undefined,
  callback: (transaction: Transaction) => Promise<T>
): Promise<T> {
  if (trx) {
    return callback(trx);
  }

  return AgentSession.transaction(callback);
}

export class WorkspaceRuntimeStateService {
  static async claimWorkspaceAction(
    sessionId: number,
    options: ClaimWorkspaceActionOptions
  ): Promise<WorkspaceRuntimeStateResult> {
    return AgentSession.transaction(async (trx) => {
      const { action, claimedAt, activeActionTimeoutMs, allowedActiveRunUuid, ...stateOptions } = options;
      const session = await AgentSession.query(trx).findById(sessionId).forUpdate();
      if (!session) {
        throw new Error('Agent session not found');
      }
      if (session.status === 'archived') {
        throw new WorkspaceActionBlockedError('action_in_progress', 'The workspace action was superseded by cleanup.', {
          currentAction: 'archived',
        });
      }

      const activeRunQuery = AgentRun.query(trx)
        .where({ sessionId: session.id })
        .whereNotIn('status', TERMINAL_RUN_STATUSES)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc');
      if (allowedActiveRunUuid) {
        activeRunQuery.whereNot('uuid', allowedActiveRunUuid);
      }
      const activeRun = await activeRunQuery.first();
      if (activeRun) {
        throw new WorkspaceActionBlockedError(
          'active_run',
          'Wait for the current agent run to finish before changing the workspace.',
          {
            runUuid: activeRun.uuid,
            status: activeRun.status,
          }
        );
      }

      const latestSandbox = await AgentSandboxService.getLatestSandboxForSession(session.id, { trx });
      const lifecycle = readRuntimeLifecycle(latestSandbox?.metadata);
      if (isActiveLifecycleClaim(lifecycle, activeActionTimeoutMs)) {
        throw new WorkspaceActionBlockedError(
          'action_in_progress',
          'Wait for the current workspace action to finish before starting another action.',
          {
            currentAction: lifecycle?.currentAction,
          }
        );
      }

      return this.recordWorkspaceState(
        session.id,
        {
          ...stateOptions,
          runtimeLifecycle: {
            currentAction: action,
            claimedAt: claimedAt ?? new Date().toISOString(),
          },
        },
        { trx }
      );
    });
  }

  static async assertNoActiveWorkspaceAction(
    sessionId: number,
    options: { activeActionTimeoutMs?: number; trx?: Transaction } = {}
  ): Promise<void> {
    return withTransaction(options.trx, async (trx) => {
      const session = await AgentSession.query(trx).findById(sessionId).forUpdate();
      if (!session) {
        throw new Error('Agent session not found');
      }

      const latestSandbox = await AgentSandboxService.getLatestSandboxForSession(session.id, { trx });
      const lifecycle = readRuntimeLifecycle(latestSandbox?.metadata);
      if (!isActiveLifecycleClaim(lifecycle, options.activeActionTimeoutMs)) {
        return;
      }

      throw new WorkspaceActionBlockedError(
        'action_in_progress',
        'Wait for the current workspace action to finish before starting another action.',
        {
          currentAction: lifecycle?.currentAction,
        }
      );
    });
  }

  static async recordWorkspaceState(
    sessionId: number,
    state: WorkspaceRuntimeStateWrite,
    options: TransactionOptions = {}
  ): Promise<WorkspaceRuntimeStateResult> {
    return withTransaction(options.trx, async (trx) => {
      if (options.expectedLifecycle) {
        await this.assertExpectedLifecycle(sessionId, options.expectedLifecycle, trx);
      }
      return this.patchSessionAndSandbox(sessionId, state, trx);
    });
  }

  static async recordWorkspaceFailure(
    sessionId: number,
    state: WorkspaceRuntimeFailureWrite,
    options: TransactionOptions = {}
  ): Promise<WorkspaceRuntimeStateResult> {
    return withTransaction(options.trx, async (trx) => {
      if (options.expectedLifecycle) {
        await this.assertExpectedLifecycle(sessionId, options.expectedLifecycle, trx);
      }
      return this.patchSessionAndSandbox(
        sessionId,
        {
          ...state,
          sandboxStatus: state.sandboxStatus ?? 'failed',
          runtimeLifecycle: state.runtimeLifecycle === undefined ? null : state.runtimeLifecycle,
        },
        trx,
        state.failure
      );
    });
  }

  private static async assertExpectedLifecycle(
    sessionId: number,
    expectedLifecycle: { action: WorkspaceRuntimeAction; claimedAt?: string },
    trx: Transaction
  ): Promise<void> {
    const session = await AgentSession.query(trx).findById(sessionId).forUpdate();
    if (!session) {
      throw new Error('Agent session not found');
    }
    if (session.status === 'archived') {
      throw new WorkspaceActionBlockedError('action_in_progress', 'The workspace action was superseded by cleanup.', {
        currentAction: 'archived',
      });
    }

    const latestSandbox = await AgentSandboxService.getLatestSandboxForSession(session.id, { trx });
    const lifecycle = readRuntimeLifecycle(latestSandbox?.metadata);
    const matchesAction = lifecycle?.currentAction === expectedLifecycle.action;
    const matchesClaim = !expectedLifecycle.claimedAt || lifecycle?.claimedAt === expectedLifecycle.claimedAt;
    if (matchesAction && matchesClaim) {
      return;
    }

    throw new WorkspaceActionBlockedError('action_in_progress', 'The workspace action is no longer current.', {
      currentAction: lifecycle?.currentAction ?? 'none',
    });
  }

  private static async patchSessionAndSandbox(
    sessionId: number,
    state: WorkspaceRuntimeStateWrite,
    trx: Transaction,
    failure?: WorkspaceRuntimeFailure
  ): Promise<WorkspaceRuntimeStateResult> {
    const session = await AgentSession.query(trx).patchAndFetchById(sessionId, state.sessionPatch);
    if (!session) {
      throw new Error('Agent session not found');
    }

    const sandbox = await AgentSandboxService.recordSessionSandboxState(session, {
      trx,
      ...(state.workspaceStorage ? { workspaceStorage: state.workspaceStorage } : {}),
      ...(failure ? { failure } : {}),
      ...(state.runtimePlanMetadata ? { runtimePlanMetadata: state.runtimePlanMetadata } : {}),
      ...(state.sandboxStatus ? { sandboxStatus: state.sandboxStatus } : {}),
      ...(state.runtimeLifecycle !== undefined ? { runtimeLifecycle: state.runtimeLifecycle } : {}),
      ...(state.runtimeProvider ? { runtimeProvider: state.runtimeProvider } : {}),
      ...(state.providerState ? { providerState: state.providerState } : {}),
      ...(state.capabilitySnapshot ? { capabilitySnapshot: state.capabilitySnapshot } : {}),
    });

    return { session, sandbox };
  }
}

export default WorkspaceRuntimeStateService;
