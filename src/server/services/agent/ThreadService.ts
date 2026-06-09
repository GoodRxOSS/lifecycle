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

import AgentSession from 'server/models/AgentSession';
import { getOwnedSession } from 'server/services/agent/sessionOwnership';
import AgentMessage from 'server/models/AgentMessage';
import AgentPendingAction from 'server/models/AgentPendingAction';
import AgentRun from 'server/models/AgentRun';
import AgentThread from 'server/models/AgentThread';
import type { Transaction } from 'objection';
import { NotFoundError, ConflictError } from 'server/lib/appError';
import { canSessionAcceptMessages, getSessionMessageBlockReason } from './sessionReadiness';
import AgentRunService, { TERMINAL_RUN_STATUSES } from './RunService';
import WorkspaceRuntimeStateService from './WorkspaceRuntimeStateService';
import type { AgentUsageAggregate, AgentUsageRunRecord } from './AgentUsageService';

export const AGENT_THREAD_SELECTED_AGENT_DEFINITION_METADATA_KEY = 'selectedAgentDefinitionId';
export const AGENT_THREAD_RUNTIME_CONTROL_CHOICES_METADATA_KEY = 'runtimeControlChoices';
export const AGENT_THREAD_TOOL_APPROVAL_ALLOWLIST_METADATA_KEY = 'toolApprovalAllowlist';

export type AgentThreadRuntimeControlChoicesMetadata = {
  version: 1;
  toolChoiceIds: string[];
  mcpChoiceIds: string[];
};

export type AgentThreadToolApprovalAllowlistMetadata = {
  version: 1;
  toolKeys: string[];
};

export type CreateAgentThreadInput = {
  title?: string | null;
  sourceThreadId?: string | null;
};

export type AgentThreadLatestRunSummary = {
  id: string;
  status: AgentRun['status'];
  requestedProvider: string | null;
  requestedModel: string | null;
  resolvedProvider: string | null;
  resolvedModel: string | null;
  provider: string;
  model: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  usageSummary: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AgentThreadHistorySummary = {
  messageCount: number;
  runCount: number;
  pendingActionsCount: number;
  latestRun: AgentThreadLatestRunSummary | null;
  lastActivityAt: string | null;
  usage: AgentUsageAggregate;
};

export type SerializedAgentThread = {
  id: string;
  sessionId?: string;
  title: string | null;
  isDefault: boolean;
  archivedAt: string | null;
  lastRunAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AgentThreadHistoryEntry = SerializedAgentThread & {
  summary: AgentThreadHistorySummary;
};

export type AgentThreadCreateNotFoundCode = 'session_not_found' | 'source_thread_not_found';
export type AgentThreadCreateConflictCode =
  | 'inactive_session'
  | 'session_starting'
  | 'session_unavailable'
  | 'active_run'
  | 'pending_approval';

export class AgentThreadCreateNotFoundError extends NotFoundError {
  readonly reason: AgentThreadCreateNotFoundCode;
  constructor(reason: AgentThreadCreateNotFoundCode, message: string) {
    super(message, 'thread_target_not_found', { reason });
    this.name = 'AgentThreadCreateNotFoundError';
    this.reason = reason;
  }
}

export class AgentThreadCreateConflictError extends ConflictError {
  readonly reason: AgentThreadCreateConflictCode;
  constructor(reason: AgentThreadCreateConflictCode, message: string) {
    super(message, reason, { reason });
    this.name = 'AgentThreadCreateConflictError';
    this.reason = reason;
  }
}

function normalizeTitle(title?: string | null): string | null {
  const trimmed = title?.trim();
  return trimmed ? trimmed : null;
}

function normalizeCreateThreadInput(input?: string | CreateAgentThreadInput | null): CreateAgentThreadInput {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return {
      title: input.title ?? null,
      sourceThreadId: input.sourceThreadId ?? null,
    };
  }

  return {
    title: typeof input === 'string' ? input : null,
    sourceThreadId: null,
  };
}

function normalizeSourceThreadId(sourceThreadId?: string | null): string | null {
  const trimmed = sourceThreadId?.trim();
  return trimmed ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function getSelectedAgentDefinitionId(thread: AgentThread): string | null {
  const metadata = readRecord(thread.metadata);
  const selectedDefinitionId = metadata[AGENT_THREAD_SELECTED_AGENT_DEFINITION_METADATA_KEY];
  if (typeof selectedDefinitionId === 'string' && selectedDefinitionId.trim()) {
    return selectedDefinitionId.trim();
  }

  return null;
}

export function buildSelectedAgentDefinitionMetadataPatch(agentId: string): Record<string, unknown> {
  return {
    [AGENT_THREAD_SELECTED_AGENT_DEFINITION_METADATA_KEY]: agentId,
  };
}

function normalizeChoiceIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return Array.from(
    new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()))
  ).filter(Boolean);
}

export function getRuntimeControlChoices(thread: AgentThread): AgentThreadRuntimeControlChoicesMetadata | null {
  const metadata = readRecord(thread.metadata)[AGENT_THREAD_RUNTIME_CONTROL_CHOICES_METADATA_KEY];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const toolChoiceIds = normalizeChoiceIds(record.toolChoiceIds);
  const mcpChoiceIds = normalizeChoiceIds(record.mcpChoiceIds);
  if (record.version !== 1 || !toolChoiceIds || !mcpChoiceIds) {
    return null;
  }

  return {
    version: 1,
    toolChoiceIds,
    mcpChoiceIds,
  };
}

export function buildRuntimeControlChoicesMetadataPatch(
  choices: AgentThreadRuntimeControlChoicesMetadata
): Record<string, unknown> {
  return {
    [AGENT_THREAD_RUNTIME_CONTROL_CHOICES_METADATA_KEY]: {
      version: 1,
      toolChoiceIds: [...choices.toolChoiceIds],
      mcpChoiceIds: [...choices.mcpChoiceIds],
    },
  };
}

export function getToolApprovalAllowlist(thread: AgentThread): string[] {
  const metadata = readRecord(thread.metadata)[AGENT_THREAD_TOOL_APPROVAL_ALLOWLIST_METADATA_KEY];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [];
  }

  const record = metadata as Record<string, unknown>;
  const toolKeys = normalizeChoiceIds(record.toolKeys);
  if (record.version !== 1 || !toolKeys) {
    return [];
  }

  return toolKeys;
}

export function buildToolApprovalAllowlistMetadataPatch(toolKeys: string[]): Record<string, unknown> {
  return {
    [AGENT_THREAD_TOOL_APPROVAL_ALLOWLIST_METADATA_KEY]: {
      version: 1,
      toolKeys: Array.from(new Set(toolKeys.map((key) => key.trim()).filter(Boolean))),
    },
  };
}

function buildFreshThreadMetadata(session: AgentSession, sourceThread: AgentThread | null): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    sessionUuid: session.uuid,
  };

  if (!sourceThread) {
    return metadata;
  }

  const selectedAgentDefinitionId = getSelectedAgentDefinitionId(sourceThread);
  if (selectedAgentDefinitionId) {
    metadata[AGENT_THREAD_SELECTED_AGENT_DEFINITION_METADATA_KEY] = selectedAgentDefinitionId;
  }

  const runtimeControlChoices = getRuntimeControlChoices(sourceThread);
  if (runtimeControlChoices) {
    metadata[AGENT_THREAD_RUNTIME_CONTROL_CHOICES_METADATA_KEY] = {
      version: 1,
      toolChoiceIds: [...runtimeControlChoices.toolChoiceIds],
      mcpChoiceIds: [...runtimeControlChoices.mcpChoiceIds],
    };
  }

  return metadata;
}

function incrementThreadCount(counts: Map<number, number>, threadId: number): void {
  counts.set(threadId, (counts.get(threadId) || 0) + 1);
}

function groupRunsByThreadId(runs: AgentRun[]): Map<number, AgentRun[]> {
  const runsByThreadId = new Map<number, AgentRun[]>();
  for (const run of runs) {
    const existing = runsByThreadId.get(run.threadId) || [];
    existing.push(run);
    runsByThreadId.set(run.threadId, existing);
  }
  return runsByThreadId;
}

function pickLatestRun(runs: AgentRun[]): AgentRun | null {
  return runs[0] || null;
}

function serializeLatestRunSummary(run: AgentRun | null): AgentThreadLatestRunSummary | null {
  if (!run) {
    return null;
  }

  return {
    id: run.uuid,
    status: run.status,
    requestedProvider: run.requestedProvider || null,
    requestedModel: run.requestedModel || null,
    resolvedProvider: run.resolvedProvider || run.provider,
    resolvedModel: run.resolvedModel || run.model,
    provider: run.provider,
    model: run.model,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    cancelledAt: run.cancelledAt,
    usageSummary: run.usageSummary || {},
    createdAt: run.createdAt || null,
    updatedAt: run.updatedAt || null,
  };
}

function readTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestTimestamp(values: unknown[]): string | null {
  let latestValue: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    const timestamp = readTimestamp(value);
    if (timestamp === null || timestamp < latestTime || typeof value !== 'string') {
      continue;
    }

    latestValue = value;
    latestTime = timestamp;
  }

  return latestValue;
}

function resolveLastActivityAt(thread: AgentThread, latestRun: AgentRun | null): string | null {
  return latestTimestamp([
    latestRun?.updatedAt,
    latestRun?.completedAt,
    latestRun?.cancelledAt,
    latestRun?.startedAt,
    latestRun?.queuedAt,
    latestRun?.createdAt,
    thread.lastRunAt,
    thread.updatedAt,
    thread.createdAt,
  ]);
}

export default class AgentThreadService {
  static getSelectedAgentDefinitionId = getSelectedAgentDefinitionId;
  static buildSelectedAgentDefinitionMetadataPatch = buildSelectedAgentDefinitionMetadataPatch;
  static getRuntimeControlChoices = getRuntimeControlChoices;
  static buildRuntimeControlChoicesMetadataPatch = buildRuntimeControlChoicesMetadataPatch;

  static getOwnedSession = getOwnedSession;

  static async getOwnedThread(threadUuid: string, userId: string): Promise<AgentThread> {
    const thread = await AgentThread.query()
      .alias('thread')
      .joinRelated('session')
      .where('thread.uuid', threadUuid)
      .where('session.userId', userId)
      .select('thread.*')
      .first();

    if (!thread) {
      throw new Error('Agent thread not found');
    }

    return thread;
  }

  static async getOwnedThreadWithSession(
    threadUuid: string,
    userId: string
  ): Promise<{ thread: AgentThread; session: AgentSession }> {
    const thread = await AgentThread.query()
      .alias('thread')
      .joinRelated('session')
      .where('thread.uuid', threadUuid)
      .where('session.userId', userId)
      .select('thread.*', 'session.uuid as sessionUuid')
      .first();

    if (!thread) {
      throw new Error('Agent thread not found');
    }

    const session = await AgentSession.query().findById(thread.sessionId);
    if (!session || session.userId !== userId) {
      throw new Error('Agent session not found');
    }

    return { thread, session };
  }

  static async getDefaultThreadForSession(sessionUuid: string, userId: string): Promise<AgentThread> {
    const session = await this.getOwnedSession(sessionUuid, userId);
    if (session.defaultThreadId) {
      const currentThread = await AgentThread.query().findOne({
        id: session.defaultThreadId,
        sessionId: session.id,
        archivedAt: null,
      });
      if (currentThread) {
        return currentThread;
      }
    }

    const existing = await AgentThread.query().findOne({
      sessionId: session.id,
      isDefault: true,
      archivedAt: null,
    });

    if (existing) {
      return existing;
    }

    try {
      return await AgentThread.query().insertAndFetch({
        sessionId: session.id,
        title: 'Default thread',
        isDefault: true,
        metadata: {
          sessionUuid: session.uuid,
        },
      } as Partial<AgentThread>);
    } catch (error) {
      const retried = await AgentThread.query().findOne({
        sessionId: session.id,
        isDefault: true,
        archivedAt: null,
      });
      if (!retried) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create default thread: ${message}`);
      }
      return retried;
    }
  }

  static async listThreadsForSession(sessionUuid: string, userId: string): Promise<AgentThread[]> {
    const session = await this.getOwnedSession(sessionUuid, userId);
    await this.getDefaultThreadForSession(sessionUuid, userId);

    return AgentThread.query()
      .where({ sessionId: session.id })
      .whereNull('archivedAt')
      .orderBy('isDefault', 'desc')
      .orderBy('createdAt', 'asc');
  }

  static async listThreadHistoryForSession(sessionUuid: string, userId: string): Promise<AgentThreadHistoryEntry[]> {
    const session = await this.getOwnedSession(sessionUuid, userId);
    await this.getDefaultThreadForSession(sessionUuid, userId);

    const threads = await AgentThread.query()
      .where({ sessionId: session.id })
      .whereNull('archivedAt')
      .orderBy('isDefault', 'desc')
      .orderBy('createdAt', 'asc');
    const threadIds = threads.map((thread) => thread.id);
    const { default: AgentUsageService } = await import('./AgentUsageService');

    if (threadIds.length === 0) {
      return [];
    }

    const [messageRows, runRows, pendingRows] = await Promise.all([
      AgentMessage.query().whereIn('threadId', threadIds).select('threadId'),
      AgentRun.query().whereIn('threadId', threadIds).orderBy('createdAt', 'desc').orderBy('id', 'desc'),
      AgentPendingAction.query().whereIn('threadId', threadIds).where('status', 'pending').select('threadId'),
    ]);

    const messageCountByThreadId = new Map<number, number>();
    for (const row of messageRows as Array<{ threadId: number }>) {
      incrementThreadCount(messageCountByThreadId, Number(row.threadId));
    }

    const pendingCountByThreadId = new Map<number, number>();
    for (const row of pendingRows as Array<{ threadId: number }>) {
      incrementThreadCount(pendingCountByThreadId, Number(row.threadId));
    }

    const runsByThreadId = groupRunsByThreadId(runRows as AgentRun[]);

    return threads.map((thread) => {
      const threadRuns = runsByThreadId.get(thread.id) || [];
      const latestRun = pickLatestRun(threadRuns);
      const usage = AgentUsageService.aggregateRuns(threadRuns as AgentUsageRunRecord[]);

      return {
        ...this.serializeThread(thread, session.uuid),
        summary: {
          messageCount: messageCountByThreadId.get(thread.id) || 0,
          runCount: threadRuns.length,
          pendingActionsCount: pendingCountByThreadId.get(thread.id) || 0,
          latestRun: serializeLatestRunSummary(latestRun),
          lastActivityAt: resolveLastActivityAt(thread, latestRun),
          usage,
        },
      };
    });
  }

  static async createThread(
    sessionUuid: string,
    userId: string,
    input?: string | CreateAgentThreadInput | null
  ): Promise<AgentThread> {
    const { title, sourceThreadId } = normalizeCreateThreadInput(input);

    // A waiting_for_input run has no in-product resume; a new thread supersedes it instead of 409ing forever.
    await AgentRunService.supersedeRecoveryPausedRunForSessionUuid(sessionUuid, userId);

    return AgentSession.transaction(async (trx) => {
      const session = await AgentSession.query(trx).findOne({ uuid: sessionUuid, userId }).forUpdate();
      if (!session) {
        throw new AgentThreadCreateNotFoundError('session_not_found', 'Agent session not found');
      }
      if (session.status === 'archived' || session.status === 'error') {
        throw new AgentThreadCreateConflictError('inactive_session', 'Cannot create a thread for an inactive session');
      }
      if (!canSessionAcceptMessages(session)) {
        const blockReason = getSessionMessageBlockReason(session);
        throw new AgentThreadCreateConflictError(
          blockReason === 'Wait for the session to finish starting before sending a message.'
            ? 'session_starting'
            : 'session_unavailable',
          blockReason
        );
      }

      const activeRun = await AgentRun.query(trx)
        .where({ sessionId: session.id })
        .whereNotIn('status', TERMINAL_RUN_STATUSES)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .first();
      if (activeRun) {
        throw new AgentThreadCreateConflictError(
          'active_run',
          'Wait for the current agent run to finish before starting a new thread.'
        );
      }

      const pendingAction = await AgentPendingAction.query(trx)
        .alias('pendingAction')
        .joinRelated('thread')
        .where('thread.sessionId', session.id)
        .where('pendingAction.status', 'pending')
        .select('pendingAction.*')
        .first();
      if (pendingAction) {
        throw new AgentThreadCreateConflictError(
          'pending_approval',
          'Resolve pending approvals before starting a new thread.'
        );
      }

      await WorkspaceRuntimeStateService.assertNoActiveWorkspaceAction(session.id, { trx });

      const normalizedSourceThreadId = normalizeSourceThreadId(sourceThreadId);
      let sourceThread: AgentThread | null = null;
      if (normalizedSourceThreadId) {
        sourceThread =
          (await AgentThread.query(trx).findOne({
            uuid: normalizedSourceThreadId,
            sessionId: session.id,
            archivedAt: null,
          })) || null;
        if (!sourceThread) {
          throw new AgentThreadCreateNotFoundError('source_thread_not_found', 'Source agent thread not found');
        }
      } else if (session.defaultThreadId) {
        sourceThread =
          (await AgentThread.query(trx).findOne({
            id: session.defaultThreadId,
            sessionId: session.id,
            archivedAt: null,
          })) || null;
      }

      await AgentThread.query(trx)
        .where({ sessionId: session.id, isDefault: true })
        .whereNull('archivedAt')
        .patch({ isDefault: false } as Partial<AgentThread>);

      const thread = await AgentThread.query(trx).insertAndFetch({
        sessionId: session.id,
        title: normalizeTitle(title),
        isDefault: true,
        metadata: buildFreshThreadMetadata(session, sourceThread),
      } as Partial<AgentThread>);

      await AgentSession.query(trx).patchAndFetchById(session.id, {
        defaultThreadId: thread.id,
      } as Partial<AgentSession>);

      return thread;
    });
  }

  static async patchRuntimeControlChoices(
    threadId: number,
    choices: AgentThreadRuntimeControlChoicesMetadata,
    trx?: Transaction
  ): Promise<AgentThread> {
    const thread = await AgentThread.query(trx).findById(threadId);
    if (!thread) {
      throw new Error('Agent thread not found');
    }

    return AgentThread.query(trx).patchAndFetchById(threadId, {
      metadata: {
        ...(thread.metadata || {}),
        ...buildRuntimeControlChoicesMetadataPatch(choices),
      },
    } as Partial<AgentThread>);
  }

  static async setToolApprovalAllowlist(threadId: number, toolKeys: string[], trx?: Transaction): Promise<AgentThread> {
    const thread = await AgentThread.query(trx).findById(threadId);
    if (!thread) {
      throw new Error('Agent thread not found');
    }

    return AgentThread.query(trx).patchAndFetchById(threadId, {
      metadata: {
        ...(thread.metadata || {}),
        ...buildToolApprovalAllowlistMetadataPatch(toolKeys),
      },
    } as Partial<AgentThread>);
  }

  static async addToolApprovalAllowlistEntry(
    threadId: number,
    toolKey: string,
    trx?: Transaction
  ): Promise<AgentThread> {
    const thread = await AgentThread.query(trx).findById(threadId);
    if (!thread) {
      throw new Error('Agent thread not found');
    }

    return AgentThread.query(trx).patchAndFetchById(threadId, {
      metadata: {
        ...(thread.metadata || {}),
        ...buildToolApprovalAllowlistMetadataPatch([...getToolApprovalAllowlist(thread), toolKey]),
      },
    } as Partial<AgentThread>);
  }

  static serializeThread(thread: AgentThread, sessionUuid?: string) {
    return {
      id: thread.uuid,
      sessionId: sessionUuid,
      title: thread.title,
      isDefault: thread.isDefault,
      archivedAt: thread.archivedAt,
      lastRunAt: thread.lastRunAt,
      metadata: thread.metadata || {},
      createdAt: thread.createdAt || null,
      updatedAt: thread.updatedAt || null,
    };
  }
}
