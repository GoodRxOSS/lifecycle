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

import type { PartialModelObject } from 'objection';
import type { UIMessageChunk } from 'ai';
import 'server/lib/dependencies';
import AgentRun from 'server/models/AgentRun';
import AgentThread from 'server/models/AgentThread';
import type AgentSession from 'server/models/AgentSession';
import type { AgentApprovalPolicy, AgentRunStatus, AgentRunUsageSummary } from './types';
import { sanitizeAgentRunStreamChunks, sanitizeAgentRunStreamState } from './streamState';

const activeRunControllers = new Map<string, AbortController>();
const RUN_NOT_FOUND_ERROR = 'Agent run not found';
const TERMINAL_RUN_STATUSES: AgentRunStatus[] = ['completed', 'failed', 'cancelled'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cloneChunk<T>(chunk: T): T {
  return JSON.parse(JSON.stringify(chunk)) as T;
}

function serializeRunError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const typedError = error as Error & {
      code?: unknown;
      details?: unknown;
    };
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

export default class AgentRunService {
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
    const now = new Date().toISOString();
    const record: PartialModelObject<AgentRun> = {
      threadId: thread.id,
      sessionId: session.id,
      status: 'running',
      provider,
      model,
      queuedAt: now,
      startedAt: now,
      usageSummary: {},
      policySnapshot: policy as unknown as Record<string, unknown>,
      streamState: {},
      error: null,
    };

    const run = await AgentRun.query().insertAndFetch(record);
    await AgentThread.query().patchAndFetchById(thread.id, {
      lastRunAt: now,
      metadata: {
        ...(thread.metadata || {}),
        latestRunId: run.uuid,
      },
    } as Partial<AgentThread>);

    return run;
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
    activeRunControllers.get(runUuid)?.abort();

    await AgentRun.query().patchAndFetchById(run.id, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    } as Partial<AgentRun>);

    this.clearAbortController(runUuid);
    return this.getOwnedRun(runUuid, userId);
  }

  static isTerminalStatus(status: AgentRunStatus): boolean {
    return TERMINAL_RUN_STATUSES.includes(status);
  }

  static async patchRun(runUuid: string, patch: Partial<AgentRun>): Promise<AgentRun> {
    const run = await AgentRun.query().findOne({ uuid: runUuid });
    if (!run) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    const nextPatch = { ...patch } as Partial<AgentRun>;
    if (patch.streamState) {
      nextPatch.streamState = {
        ...(run.streamState || {}),
        ...(patch.streamState as Record<string, unknown>),
      };
    }

    return AgentRun.query().patchAndFetchById(run.id, nextPatch);
  }

  static async patchStatus(runUuid: string, status: AgentRunStatus, patch?: Partial<AgentRun>): Promise<AgentRun> {
    return this.patchRun(runUuid, {
      status,
      ...patch,
    } as Partial<AgentRun>);
  }

  static async markWaitingForApproval(runUuid: string): Promise<AgentRun> {
    return this.patchStatus(runUuid, 'waiting_for_approval');
  }

  static async markCompleted(
    runUuid: string,
    usageSummary?: AgentRunUsageSummary,
    streamState?: Record<string, unknown>
  ): Promise<AgentRun> {
    this.clearAbortController(runUuid);
    return this.patchStatus(runUuid, 'completed', {
      completedAt: new Date().toISOString(),
      usageSummary: (usageSummary || {}) as Record<string, unknown>,
      streamState: streamState || {},
    });
  }

  static async markFailed(
    runUuid: string,
    error: unknown,
    usageSummary?: AgentRunUsageSummary,
    streamState?: Record<string, unknown>
  ): Promise<AgentRun> {
    this.clearAbortController(runUuid);
    return this.patchStatus(runUuid, 'failed', {
      completedAt: new Date().toISOString(),
      usageSummary: (usageSummary || {}) as Record<string, unknown>,
      streamState: streamState || {},
      error: serializeRunError(error),
    });
  }

  static async appendStreamChunks(runUuid: string, chunks: UIMessageChunk[]): Promise<AgentRun> {
    const run = await AgentRun.query().findOne({ uuid: runUuid });
    if (!run) {
      throw new Error(RUN_NOT_FOUND_ERROR);
    }

    if (chunks.length === 0) {
      return run;
    }

    const existingChunks = Array.isArray(run.streamState?.chunks) ? (run.streamState.chunks as UIMessageChunk[]) : [];
    const nextChunks = sanitizeAgentRunStreamChunks([...existingChunks, ...chunks.map((chunk) => cloneChunk(chunk))]);

    return this.patchRun(runUuid, {
      streamState: {
        chunks: nextChunks,
      },
    } as Partial<AgentRun>);
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
      provider: run.provider,
      model: run.model,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      cancelledAt: run.cancelledAt,
      usageSummary: run.usageSummary || {},
      policySnapshot: run.policySnapshot || {},
      streamState: sanitizeAgentRunStreamState(run.streamState || {}),
      error: run.error,
      createdAt: run.createdAt || null,
      updatedAt: run.updatedAt || null,
    };
  }

  static isRunNotFoundError(error: unknown): boolean {
    return error instanceof Error && error.message === RUN_NOT_FOUND_ERROR;
  }
}
