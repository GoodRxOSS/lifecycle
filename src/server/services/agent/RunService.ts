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

import { raw, type PartialModelObject, type Transaction } from 'objection';
import 'server/lib/dependencies';
import { getLogger } from 'server/lib/logger';
import AgentRun from 'server/models/AgentRun';
import AgentThread from 'server/models/AgentThread';
import AgentSession from 'server/models/AgentSession';
import type { AgentApprovalPolicy, AgentRunStatus, AgentRunUsageSummary } from './types';
import type { AgentUiMessageChunk } from './streamChunks';
import AgentRunEventService from './RunEventService';
import { isAgentRunPlanSnapshotV1, type AgentDebugRunIntent, type AgentRunPlanSnapshotV1 } from './runPlanTypes';
import { serializeRunPlanSummary } from './runPlanSummary';
import { AgentRunOwnershipLostError } from './AgentRunOwnershipLostError';
import { ConflictError, BadRequestError } from 'server/lib/appError';
import { classifyThrownRunError } from './runErrorClassification';
import type { AgentRunResumeEligibility } from './RunResumeEligibilityService';
import { resolveAgentSessionDurabilityConfig } from 'server/lib/agentSession/runtimeConfig';

const activeRunControllers = new Map<string, AbortController>();
const RUN_NOT_FOUND_ERROR = 'Agent run not found';
export const TERMINAL_RUN_STATUSES: AgentRunStatus[] = ['completed', 'failed', 'cancelled'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Best-effort fast cross-process abort; the ownership fence still stops a missed worker.
const RUN_CANCEL_NOTIFY_CHANNEL = 'agent_run_cancel';

type PgListenConnection = {
  on(event: 'notification', listener: (notification: { channel?: string; payload?: string }) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  query(sql: string): Promise<unknown>;
};

let cancelNotificationConnection: PgListenConnection | null = null;
let cancelNotificationListenPromise: Promise<void> | null = null;

function clearCancelNotificationConnection(): void {
  cancelNotificationConnection = null;
  cancelNotificationListenPromise = null;
}

function parseCancelNotification(payload: string | undefined): string | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const runId = typeof parsed.runId === 'string' ? parsed.runId : null;
    return runId && isUuid(runId) ? runId : null;
  } catch (error) {
    getLogger().warn({ error }, 'AgentExec: ignored invalid run-cancel notification');
    return null;
  }
}

function handleCancelNotification(notification: { channel?: string; payload?: string }): void {
  if (notification.channel !== RUN_CANCEL_NOTIFY_CHANNEL) {
    return;
  }

  const runUuid = parseCancelNotification(notification.payload);
  if (runUuid) {
    activeRunControllers.get(runUuid)?.abort();
  }
}

function handleCancelNotificationError(error: unknown): void {
  getLogger().warn({ error }, 'AgentExec: run-cancel notification listener failed');
  clearCancelNotificationConnection();
}

export class ActiveAgentRunError extends ConflictError {
  constructor() {
    super('Wait for the current agent run to finish before starting another run.', 'run_already_running');
    this.name = 'ActiveAgentRunError';
  }
}

export class InvalidAgentRunDefaultsError extends BadRequestError {
  constructor(message: string) {
    super(message, 'run_defaults_invalid');
    this.name = 'InvalidAgentRunDefaultsError';
  }
}

function serializeRunError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const typedError = error as Error & {
      code?: unknown;
      details?: unknown;
    };
    if (error.name === 'AI_TypeValidationError' || error.message.startsWith('Type validation failed')) {
      return {
        name: error.name || 'Error',
        code: 'run_resume_state_invalid',
        message:
          'Lifecycle could not resume this response because the saved run state is invalid. Send a new message to continue from the last saved chat state.',
        details: {
          reason: 'ui_message_validation',
        },
      };
    }

    // Give provider/SDK/OAuth/ownership failures a stable code + recovery action so they aren't persisted as uncoded prose.
    const classified = classifyThrownRunError(error);
    if (classified) {
      return {
        name: classified.name || 'AgentRunTerminalFailure',
        code: classified.code,
        message: classified.message,
        ...(classified.details ? { details: classified.details } : {}),
        ...(classified.retryable !== undefined ? { retryable: classified.retryable } : {}),
        ...(classified.nextAction ? { nextAction: classified.nextAction } : {}),
      };
    }

    const serialized: Record<string, unknown> = {
      message: error.message,
      stack: error.stack || null,
    };

    if (error.name) {
      serialized.name = error.name;
    }

    if (typedError.code !== undefined) {
      serialized.code = typedError.code;
    }

    if (typedError.details !== undefined) {
      serialized.details = typedError.details;
    }

    return serialized;
  }

  if (error && typeof error === 'object') {
    const record = { ...(error as Record<string, unknown>) };
    const message = typeof record.message === 'string' ? record.message.trim() : '';

    return {
      ...record,
      message: message || 'Agent run failed.',
    };
  }

  return {
    message: String(error),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRunRecovery(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error) || !isRecord(error.details) || !isRecord(error.details.recovery)) {
    return null;
  }

  const recovery = error.details.recovery;
  const decision = typeof recovery.decision === 'string' && recovery.decision.trim() ? recovery.decision : null;
  const reason = typeof recovery.reason === 'string' && recovery.reason.trim() ? recovery.reason : null;

  if (!decision || !reason) {
    return null;
  }

  return recovery;
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isLeaseExpired(leaseExpiresAt: string | null | undefined, now: Date): boolean {
  if (!leaseExpiresAt) {
    return false;
  }

  return new Date(leaseExpiresAt).getTime() <= now.getTime();
}

function resolveHeartbeatStaleMs(runExecutionLeaseMs: number): number {
  // 3x the heartbeat interval, never exceeding the lease.
  const intervalMs = Math.min(Math.max(Math.floor(runExecutionLeaseMs / 3), 10_000), 60_000);
  return Math.min(runExecutionLeaseMs, intervalMs * 3);
}

function isHeartbeatStale(
  run: Pick<AgentRun, 'heartbeatAt' | 'startedAt'>,
  now: Date,
  heartbeatStaleMs: number
): boolean {
  const reference = run.heartbeatAt || run.startedAt; // fall back to startedAt if never heartbeated
  if (!reference) {
    return false;
  }
  return new Date(reference).getTime() <= now.getTime() - heartbeatStaleMs;
}

function shouldReleaseExecution(status: AgentRunStatus): boolean {
  return (
    status === 'queued' ||
    status === 'waiting_for_approval' ||
    status === 'waiting_for_input' ||
    TERMINAL_RUN_STATUSES.includes(status)
  );
}

function statusEventType(status: AgentRunStatus): string {
  return status === 'waiting_for_approval'
    ? 'run.waiting_for_approval'
    : status === 'queued'
    ? 'run.queued'
    : status === 'completed'
    ? 'run.completed'
    : status === 'failed'
    ? 'run.failed'
    : status === 'cancelled'
    ? 'run.cancelled'
    : status === 'running' || status === 'starting'
    ? 'run.started'
    : 'run.updated';
}

function runOwnershipLost(runUuid: string, expectedExecutionOwner: string, run?: AgentRun | null) {
  return new AgentRunOwnershipLostError({
    runUuid,
    expectedExecutionOwner,
    currentStatus: run?.status,
    currentExecutionOwner: run?.executionOwner,
  });
}

type OwnerTransactionContext = {
  run: AgentRun;
  trx: Transaction;
};

type FinalizeRunForOwnerResult = {
  status: AgentRunStatus;
  patch?: Partial<AgentRun>;
  error?: unknown;
};

type OwnerStatusEventContext = {
  dispatchAttemptId?: string;
};

type RecoveryPauseOptions = {
  now?: Date;
  expectedExecutionOwner?: string | null;
  allowActiveLease?: boolean;
  errorCode?: string;
  message?: string;
  dispatchAttemptId?: string;
  resumeAttemptId?: string;
  detail?: Record<string, unknown>;
};

export default class AgentRunService {
  static async createQueuedRun({
    thread,
    session,
    policy,
    requestedHarness,
    requestedProvider,
    requestedModel,
    resolvedHarness,
    resolvedProvider,
    resolvedModel,
    sandboxRequirement,
    runPlanSnapshot,
  }: {
    thread: AgentThread;
    session: AgentSession;
    policy: AgentApprovalPolicy;
    requestedHarness?: string | null;
    requestedProvider?: string | null;
    requestedModel?: string | null;
    resolvedHarness: string;
    resolvedProvider: string;
    resolvedModel: string;
    sandboxRequirement?: Record<string, unknown>;
    runPlanSnapshot: AgentRunPlanSnapshotV1;
  }): Promise<AgentRun> {
    if (!resolvedHarness?.trim()) {
      throw new InvalidAgentRunDefaultsError('Agent run harness is required.');
    }
    if (!resolvedProvider?.trim()) {
      throw new InvalidAgentRunDefaultsError('Agent run provider is required.');
    }
    if (!resolvedModel?.trim()) {
      throw new InvalidAgentRunDefaultsError('Agent run model is required.');
    }
    if (!isAgentRunPlanSnapshotV1(runPlanSnapshot)) {
      throw new InvalidAgentRunDefaultsError('Agent run plan snapshot is required.');
    }

    const now = new Date().toISOString();
    const record: PartialModelObject<AgentRun> = {
      threadId: thread.id,
      sessionId: session.id,
      status: 'queued',
      provider: resolvedProvider,
      model: resolvedModel,
      requestedHarness: requestedHarness || null,
      resolvedHarness,
      requestedProvider: requestedProvider || null,
      requestedModel: requestedModel || null,
      resolvedProvider,
      resolvedModel,
      sandboxRequirement: sandboxRequirement || {},
      sandboxGeneration: null,
      queuedAt: now,
      startedAt: null,
      usageSummary: {},
      policySnapshot: policy as unknown as Record<string, unknown>,
      runPlanSnapshot: runPlanSnapshot as unknown as Record<string, unknown>,
      error: null,
    };

    const run = await AgentRun.transaction(async (trx) => {
      await AgentSession.query(trx).findById(session.id).forUpdate();

      const activeRun = await AgentRun.query(trx)
        .where({ sessionId: session.id })
        .whereNotIn('status', TERMINAL_RUN_STATUSES)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .first();
      if (activeRun) {
        throw new ActiveAgentRunError();
      }

      const queuedRun = await AgentRun.query(trx).insertAndFetch(record);
      await AgentThread.query(trx).patchAndFetchById(thread.id, {
        lastRunAt: now,
        metadata: {
          ...(thread.metadata || {}),
          latestRunId: queuedRun.uuid,
        },
      } as Partial<AgentThread>);

      return queuedRun;
    });

    await AgentRunEventService.appendStatusEvent(run.uuid, 'run.queued', {
      threadId: thread.uuid,
      sessionId: session.uuid,
    });

    return run;
  }

  static registerAbortController(runUuid: string, controller: AbortController): void {
    activeRunControllers.set(runUuid, controller);
    // Lazily start the cross-process cancel listener once this worker owns a controller.
    void this.ensureCancelNotificationListener().catch(() => {});
  }

  static clearAbortController(runUuid: string): void {
    activeRunControllers.delete(runUuid);
  }

  // Single shared LISTEN connection per process; a connection drop clears the cache so the next caller re-listens.
  private static async ensureCancelNotificationListener(): Promise<void> {
    if (cancelNotificationConnection) {
      return;
    }

    if (cancelNotificationListenPromise) {
      return cancelNotificationListenPromise;
    }

    cancelNotificationListenPromise = (async () => {
      const knex = AgentRun.knex() as unknown as {
        client: {
          acquireConnection(): Promise<PgListenConnection>;
          releaseConnection(connection: PgListenConnection): Promise<void>;
        };
      };
      const connection = await knex.client.acquireConnection();

      try {
        connection.on('notification', handleCancelNotification);
        connection.on('error', handleCancelNotificationError);
        await connection.query(`LISTEN ${RUN_CANCEL_NOTIFY_CHANNEL}`);
        cancelNotificationConnection = connection;
      } catch (error) {
        await knex.client.releaseConnection(connection);
        throw error;
      }
    })()
      .catch((error) => {
        clearCancelNotificationConnection();
        getLogger().warn({ error }, 'AgentExec: run-cancel notification listener unavailable');
        throw error;
      })
      .finally(() => {
        cancelNotificationListenPromise = null;
      });

    return cancelNotificationListenPromise;
  }

  // Best-effort broadcast so workers on other replicas abort their local controller.
  private static async notifyRunCancelled(runUuid: string): Promise<void> {
    try {
      await AgentRun.knex().raw('select pg_notify(?, ?)', [
        RUN_CANCEL_NOTIFY_CHANNEL,
        JSON.stringify({ runId: runUuid }),
      ]);
    } catch (error) {
      getLogger().warn({ error, runUuid }, `AgentExec: run-cancel notify failed runId=${runUuid}`);
    }
  }

  static async getRunByUuid(runUuid: string): Promise<AgentRun | undefined> {
    if (!isUuid(runUuid)) {
      return undefined;
    }

    const run = await AgentRun.query().findOne({ uuid: runUuid });
    return run || undefined;
  }

  static async hasPriorCompletedDebugIntentRun({
    threadId,
    intents,
  }: {
    threadId: number;
    intents: AgentDebugRunIntent[];
  }): Promise<boolean> {
    if (!Number.isInteger(threadId) || threadId <= 0 || intents.length === 0) {
      return false;
    }

    const run = await AgentRun.query()
      .where({ threadId, status: 'completed' })
      .whereRaw(`"runPlanSnapshot"->'agent'->>'id' = ?`, ['system.debug'])
      .whereIn(raw(`"runPlanSnapshot"->'debug'->>'resolvedIntent'`), intents)
      .first();

    return Boolean(run);
  }

  static async hasActiveRun(threadId: number, trx?: Transaction): Promise<boolean> {
    const activeRun = await AgentRun.query(trx).where({ threadId }).whereNotIn('status', TERMINAL_RUN_STATUSES).first();

    return Boolean(activeRun);
  }

  static async listRunsNeedingDispatch({
    limit,
    now = new Date(),
    queuedStaleMs,
  }: {
    limit?: number;
    now?: Date;
    queuedStaleMs?: number;
  } = {}): Promise<AgentRun[]> {
    // Always resolve durability: the lease is required to derive the heartbeat-staleness cutoff.
    const durability = await resolveAgentSessionDurabilityConfig();
    const effectiveLimit = limit ?? durability.dispatchRecoveryLimit;
    const effectiveQueuedStaleMs = queuedStaleMs ?? durability.queuedRunDispatchStaleMs;
    const heartbeatStaleMs = resolveHeartbeatStaleMs(durability.runExecutionLeaseMs);
    const nowIso = now.toISOString();
    const queuedCutoff = new Date(now.getTime() - effectiveQueuedStaleMs).toISOString();
    const heartbeatCutoff = new Date(now.getTime() - heartbeatStaleMs).toISOString();

    return AgentRun.query()
      .where((builder) => {
        builder.where('status', 'queued').where('queuedAt', '<', queuedCutoff);
      })
      .orWhere((builder) => {
        builder
          .whereIn('status', ['starting', 'running'])
          .whereNotNull('leaseExpiresAt')
          .where('leaseExpiresAt', '<=', nowIso);
      })
      .orWhere((builder) => {
        builder.whereIn('status', ['starting', 'running']).where((heartbeatBuilder) => {
          heartbeatBuilder.where('heartbeatAt', '<=', heartbeatCutoff).orWhere((fallbackBuilder) => {
            fallbackBuilder.whereNull('heartbeatAt').where('startedAt', '<=', heartbeatCutoff);
          });
        });
      })
      .orderBy('updatedAt', 'asc')
      .limit(Math.max(1, Math.floor(effectiveLimit)));
  }

  static async claimQueuedRunForExecution(
    runUuid: string,
    executionOwner: string,
    leaseMs?: number
  ): Promise<AgentRun | null> {
    if (!isUuid(runUuid)) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const effectiveLeaseMs = leaseMs ?? (await resolveAgentSessionDurabilityConfig()).runExecutionLeaseMs;
    const leaseExpiresAt = new Date(now.getTime() + effectiveLeaseMs).toISOString();
    const heartbeatStaleMs = resolveHeartbeatStaleMs(effectiveLeaseMs);

    return AgentRun.transaction(async (trx) => {
      const run = await AgentRun.query(trx).findOne({ uuid: runUuid }).forUpdate();
      if (!run) {
        throw new Error(RUN_NOT_FOUND_ERROR);
      }

      const staleClaim =
        (run.status === 'starting' || run.status === 'running') &&
        (isLeaseExpired(run.leaseExpiresAt, now) || isHeartbeatStale(run, now, heartbeatStaleMs));
      if (run.status !== 'queued' && !staleClaim) {
        return null;
      }

      await AgentSession.query(trx).findById(run.sessionId).forUpdate();

      return AgentRun.query(trx).patchAndFetchById(run.id, {
        status: 'starting',
        executionOwner,
        leaseExpiresAt,
        heartbeatAt: nowIso,
      } as Partial<AgentRun>);
    });
  }

  static async heartbeatRunExecution(runUuid: string, executionOwner: string): Promise<void> {
    const now = new Date();
    const { runExecutionLeaseMs } = await resolveAgentSessionDurabilityConfig();
    const updatedCount = await AgentRun.query()
      .where({
        uuid: runUuid,
        executionOwner,
      })
      .whereNotIn('status', TERMINAL_RUN_STATUSES)
      .patch({
        heartbeatAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + runExecutionLeaseMs).toISOString(),
      } as Partial<AgentRun>);

    if (updatedCount === 0) {
      const currentRun = await this.getRunByUuid(runUuid);
      if (!currentRun) {
        throw new Error(RUN_NOT_FOUND_ERROR);
      }
      throw runOwnershipLost(runUuid, executionOwner, currentRun);
    }
  }

  static async getLatestOwnedThreadRun(threadUuid: string, userId: string): Promise<AgentRun | undefined> {
    if (!isUuid(threadUuid)) {
      return undefined;
    }

    const run = await AgentRun.query()
      .alias('run')
      .joinRelated('thread.session')
      .where('thread.uuid', threadUuid)
      .where('thread:session.userId', userId)
      .select('run.*', 'thread.uuid as threadUuid', 'thread:session.uuid as sessionUuid')
      .orderBy('run.createdAt', 'desc')
      .orderBy('run.id', 'desc')
      .first();

    return run || undefined;
  }

  static async getLatestOwnedSessionRun(sessionUuid: string, userId: string): Promise<AgentRun | undefined> {
    if (!isUuid(sessionUuid)) {
      return undefined;
    }

    const run = await AgentRun.query()
      .alias('run')
      .joinRelated('session')
      .where('session.uuid', sessionUuid)
      .where('session.userId', userId)
      .select('run.*', 'session.uuid as sessionUuid')
      .orderBy('run.createdAt', 'desc')
      .orderBy('run.id', 'desc')
      .first();

    return run || undefined;
  }

  static async getOwnedRun(runUuid: string, userId: string): Promise<AgentRun> {
    if (!isUuid(runUuid)) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    const run = await AgentRun.query()
      .alias('run')
      .joinRelated('thread.session')
      .where('run.uuid', runUuid)
      .where('thread:session.userId', userId)
      .select('run.*', 'thread.uuid as threadUuid', 'thread:session.uuid as sessionUuid')
      .first();

    if (!run) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    return run;
  }

  static async cancelRun(runUuid: string, userId: string): Promise<AgentRun> {
    const run = await this.getOwnedRun(runUuid, userId);
    activeRunControllers.get(run.uuid)?.abort();

    const now = new Date().toISOString();
    // Status patch and run.cancelled event MUST be atomic: a terminal status with no terminal event hangs every SSE stream forever.
    let latestSequence: number | null = null;
    await AgentRun.transaction(async (trx) => {
      const lockedRun = await AgentRun.query(trx).findById(run.id).forUpdate();
      if (!lockedRun) {
        throw new Error(RUN_NOT_FOUND_ERROR);
      }

      if (TERMINAL_RUN_STATUSES.includes(lockedRun.status)) {
        return;
      }

      const cancelledRun = await AgentRun.query(trx).patchAndFetchById(lockedRun.id, {
        status: 'cancelled',
        cancelledAt: now,
        completedAt: now,
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      } as Partial<AgentRun>);

      latestSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
        cancelledRun,
        statusEventType('cancelled'),
        this.buildStatusEventPayload('cancelled', cancelledRun),
        trx
      );
    });

    if (latestSequence) {
      await AgentRunEventService.notifyRunEventsInserted(run.uuid, latestSequence);
      // Fast cross-process abort for a worker executing this run on another replica.
      await this.notifyRunCancelled(run.uuid);
    }

    this.clearAbortController(run.uuid);
    return this.getOwnedRun(run.uuid, userId);
  }

  static isTerminalStatus(status: AgentRunStatus): boolean {
    return TERMINAL_RUN_STATUSES.includes(status);
  }

  static async assertRunExecutionOwner(runUuid: string, executionOwner: string): Promise<AgentRun> {
    if (!isUuid(runUuid)) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    const run = await AgentRun.query().findOne({ uuid: runUuid });
    if (!run) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    this.requireRunExecutionOwner(runUuid, executionOwner, run);
    return run;
  }

  static async patchRunForExecutionOwner(
    runUuid: string,
    executionOwner: string,
    patch: Partial<AgentRun>
  ): Promise<AgentRun> {
    if (!isUuid(runUuid)) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    return AgentRun.transaction((trx) =>
      this.patchRunForExecutionOwnerInTransaction(runUuid, executionOwner, patch, trx)
    );
  }

  static async patchStatusForExecutionOwner(
    runUuid: string,
    executionOwner: string,
    status: AgentRunStatus,
    patch?: Partial<AgentRun>,
    eventContext: OwnerStatusEventContext = {}
  ): Promise<AgentRun> {
    const releaseExecution = shouldReleaseExecution(status);
    let latestSequence: number | null = null;
    const updatedRun = await AgentRun.transaction(async (trx) => {
      const run = await AgentRun.query(trx).findOne({ uuid: runUuid }).forUpdate();
      if (!run) {
        throw new Error(RUN_NOT_FOUND_ERROR);
      }

      this.requireRunExecutionOwner(runUuid, executionOwner, run);

      const nextRun = await AgentRun.query(trx).patchAndFetchById(run.id, {
        status,
        ...patch,
        ...(releaseExecution
          ? {
              executionOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
            }
          : {}),
      } as Partial<AgentRun>);

      latestSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
        nextRun,
        statusEventType(status),
        this.buildStatusEventPayload(status, nextRun, executionOwner, eventContext),
        trx
      );

      return nextRun;
    });

    if (latestSequence) {
      await AgentRunEventService.notifyRunEventsInserted(updatedRun.uuid, latestSequence);
    }
    return updatedRun;
  }

  static async startRunForExecutionOwner(
    runUuid: string,
    executionOwner: string,
    resolved: {
      resolvedHarness: string;
      provider: string;
      model: string;
      sandboxGeneration?: number | null;
    },
    eventContext: OwnerStatusEventContext = {}
  ): Promise<AgentRun> {
    // This worker is starting generation; ensure it can hear a cross-process cancel.
    void this.ensureCancelNotificationListener().catch(() => {});
    const now = new Date().toISOString();
    return this.patchStatusForExecutionOwner(
      runUuid,
      executionOwner,
      'running',
      {
        startedAt: now,
        completedAt: null,
        cancelledAt: null,
        error: null,
        resolvedHarness: resolved.resolvedHarness,
        resolvedProvider: resolved.provider,
        resolvedModel: resolved.model,
        provider: resolved.provider,
        model: resolved.model,
        sandboxGeneration: resolved.sandboxGeneration ?? null,
      } as Partial<AgentRun>,
      eventContext
    );
  }

  static async markWaitingForApprovalForExecutionOwner(
    runUuid: string,
    executionOwner: string,
    usageSummary?: AgentRunUsageSummary,
    eventContext: OwnerStatusEventContext = {}
  ): Promise<AgentRun> {
    return this.patchStatusForExecutionOwner(
      runUuid,
      executionOwner,
      'waiting_for_approval',
      usageSummary
        ? {
            usageSummary: usageSummary as Record<string, unknown>,
          }
        : undefined,
      eventContext
    );
  }

  static async markCompletedForExecutionOwner(
    runUuid: string,
    executionOwner: string,
    usageSummary?: AgentRunUsageSummary,
    eventContext: OwnerStatusEventContext = {}
  ): Promise<AgentRun> {
    const completedRun = await this.patchStatusForExecutionOwner(
      runUuid,
      executionOwner,
      'completed',
      {
        completedAt: new Date().toISOString(),
        usageSummary: (usageSummary || {}) as Record<string, unknown>,
      },
      eventContext
    );
    this.clearAbortController(runUuid);
    return completedRun;
  }

  static async markFailedForExecutionOwner(
    runUuid: string,
    executionOwner: string,
    error: unknown,
    usageSummary?: AgentRunUsageSummary,
    eventContext: OwnerStatusEventContext = {}
  ): Promise<AgentRun> {
    const failedRun = await this.patchStatusForExecutionOwner(
      runUuid,
      executionOwner,
      'failed',
      {
        completedAt: new Date().toISOString(),
        usageSummary: (usageSummary || {}) as Record<string, unknown>,
        error: serializeRunError(error),
      },
      eventContext
    );
    this.clearAbortController(runUuid);
    return failedRun;
  }

  static async patchProgressForExecutionOwner(
    runUuid: string,
    executionOwner: string,
    patch: Partial<AgentRun>
  ): Promise<AgentRun> {
    const now = new Date();
    const { runExecutionLeaseMs } = await resolveAgentSessionDurabilityConfig();
    return this.patchRunForExecutionOwner(runUuid, executionOwner, {
      ...patch,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + runExecutionLeaseMs).toISOString(),
    } as Partial<AgentRun>);
  }

  static async appendStreamChunksForExecutionOwner(
    runUuid: string,
    executionOwner: string,
    chunks: AgentUiMessageChunk[],
    options: {
      beforeAppendChunks?: (context: OwnerTransactionContext) => Promise<void>;
    } = {}
  ): Promise<AgentRun> {
    if (!isUuid(runUuid)) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    let latestSequence: number | null = null;
    const run = await AgentRun.transaction(async (trx) => {
      const lockedRun = await AgentRun.query(trx).findOne({ uuid: runUuid }).forUpdate();
      if (!lockedRun) {
        throw new Error(RUN_NOT_FOUND_ERROR);
      }

      this.requireRunExecutionOwner(runUuid, executionOwner, lockedRun);

      if (chunks.length > 0) {
        await options.beforeAppendChunks?.({ run: lockedRun, trx });
        latestSequence = await AgentRunEventService.appendChunkEventsForRunInTransaction(lockedRun, chunks, trx);
      }

      return lockedRun;
    });

    if (latestSequence) {
      await AgentRunEventService.notifyRunEventsInserted(run.uuid, latestSequence);
    }

    return run;
  }

  static async finalizeRunForExecutionOwner(
    runUuid: string,
    executionOwner: string,
    finalize: (context: OwnerTransactionContext) => Promise<FinalizeRunForOwnerResult>,
    eventContext: OwnerStatusEventContext = {}
  ): Promise<AgentRun> {
    if (!isUuid(runUuid)) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    let latestSequence: number | null = null;
    const updatedRun = await AgentRun.transaction(async (trx) => {
      const run = await AgentRun.query(trx).findOne({ uuid: runUuid }).forUpdate();
      if (!run) {
        throw new Error(RUN_NOT_FOUND_ERROR);
      }

      this.requireRunExecutionOwner(runUuid, executionOwner, run);

      const result = await finalize({ run, trx });
      const releaseExecution = shouldReleaseExecution(result.status);
      const nextRun = await AgentRun.query(trx).patchAndFetchById(run.id, {
        status: result.status,
        ...(result.patch || {}),
        ...(result.status === 'failed' && result.error !== undefined ? { error: serializeRunError(result.error) } : {}),
        ...(releaseExecution
          ? {
              executionOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
            }
          : {}),
      } as Partial<AgentRun>);

      latestSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
        nextRun,
        statusEventType(result.status),
        this.buildStatusEventPayload(result.status, nextRun, executionOwner, eventContext),
        trx
      );

      return nextRun;
    });

    if (latestSequence) {
      await AgentRunEventService.notifyRunEventsInserted(updatedRun.uuid, latestSequence);
    }

    if (TERMINAL_RUN_STATUSES.includes(updatedRun.status)) {
      this.clearAbortController(runUuid);
    }

    return updatedRun;
  }

  private static buildStatusEventPayload(
    status: AgentRunStatus,
    updatedRun: AgentRun,
    executionOwner?: string,
    eventContext: OwnerStatusEventContext = {}
  ): Record<string, unknown> {
    return {
      status,
      error: updatedRun.error || null,
      usageSummary: updatedRun.usageSummary || {},
      ...(executionOwner ? { executionOwner } : {}),
      ...(eventContext.dispatchAttemptId ? { dispatchAttemptId: eventContext.dispatchAttemptId } : {}),
    };
  }

  private static async patchRunForExecutionOwnerInTransaction(
    runUuid: string,
    executionOwner: string,
    patch: Partial<AgentRun>,
    trx: Transaction
  ): Promise<AgentRun> {
    const run = await AgentRun.query(trx).findOne({ uuid: runUuid }).forUpdate();
    if (!run) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    this.requireRunExecutionOwner(runUuid, executionOwner, run);

    return AgentRun.query(trx).patchAndFetchById(run.id, patch);
  }

  private static requireRunExecutionOwner(runUuid: string, executionOwner: string, run: AgentRun): void {
    if (run.executionOwner !== executionOwner || TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw runOwnershipLost(runUuid, executionOwner, run);
    }
  }

  static async markQueuedRunDispatchFailed(runUuid: string, error: unknown): Promise<AgentRun> {
    let latestSequence: number | null = null;
    const failedRun = await AgentRun.transaction(async (trx) => {
      const run = await AgentRun.query(trx).findOne({ uuid: runUuid }).forUpdate();
      if (!run) {
        throw new Error(RUN_NOT_FOUND_ERROR);
      }

      if (run.status !== 'queued' || run.executionOwner) {
        return run;
      }

      const nextRun = await AgentRun.query(trx).patchAndFetchById(run.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        error: serializeRunError(error),
      } as Partial<AgentRun>);

      latestSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
        nextRun,
        'run.failed',
        this.buildStatusEventPayload('failed', nextRun),
        trx
      );

      return nextRun;
    });

    if (latestSequence) {
      await AgentRunEventService.notifyRunEventsInserted(failedRun.uuid, latestSequence);
    }

    return failedRun;
  }

  static async markWaitingForInputForRecovery(
    runUuid: string,
    eligibility: AgentRunResumeEligibility,
    options: RecoveryPauseOptions = {}
  ): Promise<AgentRun | null> {
    if (!isUuid(runUuid)) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    const now = options.now || new Date();
    const { runExecutionLeaseMs } = await resolveAgentSessionDurabilityConfig();
    const heartbeatStaleMs = resolveHeartbeatStaleMs(runExecutionLeaseMs);
    let latestSequence: number | null = null;
    const pausedRun = await AgentRun.transaction(async (trx) => {
      const run = await AgentRun.query(trx).findOne({ uuid: runUuid }).forUpdate();
      if (!run) {
        throw new Error(RUN_NOT_FOUND_ERROR);
      }

      if (run.status !== 'starting' && run.status !== 'running') {
        return null;
      }

      if (Object.prototype.hasOwnProperty.call(options, 'expectedExecutionOwner')) {
        if (run.executionOwner !== options.expectedExecutionOwner) {
          return null;
        }
      }

      if (
        !options.allowActiveLease &&
        !isLeaseExpired(run.leaseExpiresAt, now) &&
        !isHeartbeatStale(run, now, heartbeatStaleMs)
      ) {
        return null;
      }

      const recovery = {
        ...eligibility,
        decision: 'manual_recovery_required',
        previousStatus: run.status,
        previousOwner: run.executionOwner || null,
        leaseExpiresAt: run.leaseExpiresAt || null,
        evaluatedAt: eligibility.evaluatedAt || now.toISOString(),
        ...(options.resumeAttemptId ? { resumeAttemptId: options.resumeAttemptId } : {}),
        ...(options.dispatchAttemptId ? { dispatchAttemptId: options.dispatchAttemptId } : {}),
        ...(options.detail ? { detail: { ...(eligibility.detail || {}), ...options.detail } } : {}),
      };
      const nextRun = await AgentRun.query(trx).patchAndFetchById(run.id, {
        status: 'waiting_for_input',
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        error: {
          name: 'AgentRunManualRecoveryRequired',
          code: options.errorCode || 'run_auto_resume_ineligible',
          message:
            options.message ||
            'Lifecycle paused this run because automatic recovery is not safe. Review the run and continue manually.',
          details: {
            recovery,
          },
        },
      } as Partial<AgentRun>);

      latestSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
        nextRun,
        statusEventType('waiting_for_input'),
        this.buildStatusEventPayload('waiting_for_input', nextRun, undefined, {
          dispatchAttemptId: options.dispatchAttemptId,
        }),
        trx
      );

      return nextRun;
    });

    if (pausedRun && latestSequence) {
      await AgentRunEventService.notifyRunEventsInserted(pausedRun.uuid, latestSequence);
    }

    return pausedRun;
  }

  static async appendStreamChunks(runUuid: string, chunks: AgentUiMessageChunk[]): Promise<AgentRun> {
    const run = await AgentRun.query().findOne({ uuid: runUuid });
    if (!run) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    if (chunks.length === 0) {
      return run;
    }

    await AgentRunEventService.appendEventsForChunks(runUuid, chunks);
    return run;
  }

  static serializeRun(run: AgentRun) {
    const enrichedRun = run as AgentRun & {
      threadUuid?: string;
      sessionUuid?: string;
    };

    return {
      id: run.uuid,
      threadId: enrichedRun.threadUuid || String(run.threadId),
      sessionId: enrichedRun.sessionUuid || String(run.sessionId),
      status: run.status,
      requestedHarness: run.requestedHarness || null,
      resolvedHarness: run.resolvedHarness || null,
      requestedProvider: run.requestedProvider || null,
      requestedModel: run.requestedModel || null,
      resolvedProvider: run.resolvedProvider || run.provider,
      resolvedModel: run.resolvedModel || run.model,
      provider: run.provider,
      model: run.model,
      sandboxRequirement: run.sandboxRequirement || {},
      sandboxGeneration: run.sandboxGeneration,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      cancelledAt: run.cancelledAt,
      usageSummary: run.usageSummary || {},
      policySnapshot: run.policySnapshot || {},
      runPlan: serializeRunPlanSummary(run.runPlanSnapshot),
      recovery: readRunRecovery(run.error),
      error: run.error,
      createdAt: run.createdAt || null,
      updatedAt: run.updatedAt || null,
    };
  }

  static isRunNotFoundError(error: unknown): boolean {
    return error instanceof Error && error.message === RUN_NOT_FOUND_ERROR;
  }

  static isActiveRunConflictError(error: unknown): error is ActiveAgentRunError {
    return error instanceof ActiveAgentRunError;
  }
}
