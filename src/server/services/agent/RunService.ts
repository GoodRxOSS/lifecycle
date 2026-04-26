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
import 'server/lib/dependencies';
import AgentRun from 'server/models/AgentRun';
import AgentThread from 'server/models/AgentThread';
import AgentSession from 'server/models/AgentSession';
import type { AgentApprovalPolicy, AgentRunStatus, AgentRunUsageSummary } from './types';
import type { AgentUiMessageChunk } from './streamChunks';
import AgentRunEventService from './RunEventService';
import { AgentRunOwnershipLostError } from './AgentRunOwnershipLostError';
import {
  DEFAULT_AGENT_SESSION_DISPATCH_RECOVERY_LIMIT,
  DEFAULT_AGENT_SESSION_QUEUED_RUN_DISPATCH_STALE_MS,
  DEFAULT_AGENT_SESSION_RUN_EXECUTION_LEASE_MS,
  resolveAgentSessionDurabilityConfig,
} from 'server/lib/agentSession/runtimeConfig';

const activeRunControllers = new Map<string, AbortController>();
const RUN_NOT_FOUND_ERROR = 'Agent run not found';
export const TERMINAL_RUN_STATUSES: AgentRunStatus[] = ['completed', 'failed', 'cancelled'];
export const DEFAULT_RUN_EXECUTION_LEASE_MS = DEFAULT_AGENT_SESSION_RUN_EXECUTION_LEASE_MS;
export const DEFAULT_RUN_DISPATCH_RECOVERY_LIMIT = DEFAULT_AGENT_SESSION_DISPATCH_RECOVERY_LIMIT;
export const DEFAULT_QUEUED_RUN_DISPATCH_STALE_MS = DEFAULT_AGENT_SESSION_QUEUED_RUN_DISPATCH_STALE_MS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ActiveAgentRunError extends Error {
  constructor() {
    super('Wait for the current agent run to finish before starting another run.');
    this.name = 'ActiveAgentRunError';
  }
}

export class InvalidAgentRunDefaultsError extends Error {
  constructor(message: string) {
    super(message);
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

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isLeaseExpired(leaseExpiresAt: string | null | undefined, now: Date): boolean {
  if (!leaseExpiresAt) {
    return false;
  }

  return new Date(leaseExpiresAt).getTime() <= now.getTime();
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

  static async createRun({
    thread,
    session,
    provider,
    model,
    policy,
  }: {
    thread: AgentThread;
    session: AgentSession;
    provider: string;
    model: string;
    policy: AgentApprovalPolicy;
  }): Promise<AgentRun> {
    const run = await this.createQueuedRun({
      thread,
      session,
      policy,
      requestedHarness: session.defaultHarness,
      requestedProvider: provider,
      requestedModel: model,
      resolvedHarness: session.defaultHarness || 'lifecycle_ai_sdk',
      resolvedProvider: provider,
      resolvedModel: model,
    });

    return this.startRun(run.uuid, {
      resolvedHarness: session.defaultHarness || 'lifecycle_ai_sdk',
      provider,
      model,
    });
  }

  static registerAbortController(runUuid: string, controller: AbortController): void {
    activeRunControllers.set(runUuid, controller);
  }

  static clearAbortController(runUuid: string): void {
    activeRunControllers.delete(runUuid);
  }

  static async getRunByUuid(runUuid: string): Promise<AgentRun | undefined> {
    if (!isUuid(runUuid)) {
      return undefined;
    }

    const run = await AgentRun.query().findOne({ uuid: runUuid });
    return run || undefined;
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
    const durability =
      limit === undefined || queuedStaleMs === undefined ? await resolveAgentSessionDurabilityConfig() : null;
    const effectiveLimit = limit ?? durability!.dispatchRecoveryLimit;
    const effectiveQueuedStaleMs = queuedStaleMs ?? durability!.queuedRunDispatchStaleMs;
    const nowIso = now.toISOString();
    const queuedCutoff = new Date(now.getTime() - effectiveQueuedStaleMs).toISOString();

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

    return AgentRun.transaction(async (trx) => {
      const run = await AgentRun.query(trx).findOne({ uuid: runUuid }).forUpdate();
      if (!run) {
        throw new Error(RUN_NOT_FOUND_ERROR);
      }

      const staleClaim =
        (run.status === 'starting' || run.status === 'running') && isLeaseExpired(run.leaseExpiresAt, now);
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

    await this.patchStatus(run.uuid, 'cancelled', {
      cancelledAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    } as Partial<AgentRun>);

    this.clearAbortController(run.uuid);
    return this.getOwnedRun(run.uuid, userId);
  }

  static isTerminalStatus(status: AgentRunStatus): boolean {
    return TERMINAL_RUN_STATUSES.includes(status);
  }

  // Compatibility path for owner-independent control actions. Executor writes should use owner-aware helpers.
  static async patchRun(runUuid: string, patch: Partial<AgentRun>): Promise<AgentRun> {
    const run = await AgentRun.query().findOne({ uuid: runUuid });
    if (!run) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    return AgentRun.query().patchAndFetchById(run.id, patch);
  }

  static async patchStatus(runUuid: string, status: AgentRunStatus, patch?: Partial<AgentRun>): Promise<AgentRun> {
    const releaseExecution = shouldReleaseExecution(status);
    const updatedRun = await this.patchRun(runUuid, {
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

    await this.appendRunStatusEvent(runUuid, statusEventType(status), status, updatedRun);

    return updatedRun;
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

  private static async appendRunStatusEvent(
    runUuid: string,
    eventType: string,
    status: AgentRunStatus,
    updatedRun: AgentRun
  ): Promise<void> {
    await AgentRunEventService.appendStatusEvent(runUuid, eventType, this.buildStatusEventPayload(status, updatedRun));
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

  static async startRun(
    runUuid: string,
    resolved: {
      resolvedHarness: string;
      provider: string;
      model: string;
      sandboxGeneration?: number | null;
    }
  ): Promise<AgentRun> {
    const now = new Date().toISOString();
    return this.patchStatus(runUuid, 'running', {
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
    } as Partial<AgentRun>);
  }

  static async markWaitingForApproval(runUuid: string): Promise<AgentRun> {
    return this.patchStatus(runUuid, 'waiting_for_approval');
  }

  static async markCompleted(runUuid: string, usageSummary?: AgentRunUsageSummary): Promise<AgentRun> {
    this.clearAbortController(runUuid);
    return this.patchStatus(runUuid, 'completed', {
      completedAt: new Date().toISOString(),
      usageSummary: (usageSummary || {}) as Record<string, unknown>,
    });
  }

  static async markFailed(runUuid: string, error: unknown, usageSummary?: AgentRunUsageSummary): Promise<AgentRun> {
    this.clearAbortController(runUuid);
    return this.patchStatus(runUuid, 'failed', {
      completedAt: new Date().toISOString(),
      usageSummary: (usageSummary || {}) as Record<string, unknown>,
      error: serializeRunError(error),
    });
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
