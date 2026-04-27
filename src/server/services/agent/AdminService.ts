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

import AgentMessage from 'server/models/AgentMessage';
import AgentPendingAction from 'server/models/AgentPendingAction';
import AgentRun from 'server/models/AgentRun';
import AgentRunEvent from 'server/models/AgentRunEvent';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import AgentToolExecution from 'server/models/AgentToolExecution';
import McpServerConfig from 'server/models/McpServerConfig';
import UserMcpConnection from 'server/models/UserMcpConnection';
import AgentSessionService from 'server/services/agentSession';
import UserMcpConnectionService from 'server/services/userMcpConnection';
import AgentRunService from './RunService';
import AgentRunEventService from './RunEventService';
import ApprovalService from './ApprovalService';
import AgentThreadService from './ThreadService';
import AgentMessageStore from './MessageStore';
import type { CanonicalAgentMessage } from './canonicalMessages';
import type {
  McpAuthConfig,
  McpDiscoveredTool,
  McpSharedConnectionConfig,
  McpTransportConfig,
} from 'server/services/ai/mcp/types';
import {
  buildMcpDefinitionFingerprint,
  normalizeAuthConfig,
  requiresUserConnection,
} from 'server/services/ai/mcp/connectionConfig';
import { redactSharedConfigSecrets } from 'server/services/ai/mcp/config';

type SessionStatus = AgentSession['status'];

export interface AgentAdminSessionListFilters {
  page?: number;
  limit?: number;
  status?: SessionStatus | 'all';
  repo?: string;
  user?: string;
  buildUuid?: string;
}

type EnrichedSession = Awaited<ReturnType<typeof AgentSessionService.enrichSessions>>[number];

type AdminThreadSummary = ReturnType<typeof AgentThreadService.serializeThread> & {
  messageCount: number;
  runCount: number;
  pendingActionsCount: number;
  latestRun: ReturnType<typeof AgentRunService.serializeRun> | null;
};

type AdminToolExecutionRecord = {
  id: string;
  threadId: string;
  runId: string;
  pendingActionId: string | null;
  source: string;
  serverSlug: string | null;
  toolName: string;
  toolCallId: string | null;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: AgentToolExecution['status'];
  safetyLevel: string | null;
  approved: boolean | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AgentAdminMcpServerCoverage = {
  slug: string;
  name: string;
  description: string | null;
  scope: string;
  preset: string | null;
  transport: McpTransportConfig;
  sharedConfig: McpSharedConnectionConfig;
  authConfig: McpAuthConfig;
  enabled: boolean;
  timeout: number;
  connectionRequired: boolean;
  sharedDiscoveredTools: McpDiscoveredTool[];
  userConnectionCount: number;
  latestUserValidatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AgentAdminMcpServerUserConnection = {
  userId: string;
  githubUsername: string | null;
  authMode: 'fields' | 'oauth' | 'none';
  stale: boolean;
  configuredFieldKeys: string[];
  discoveredToolCount: number;
  validationError: string | null;
  validatedAt: string | null;
  updatedAt: string | null;
};

function normalizeSearchTerm(value?: string | null): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function toToolExecutionRecord(row: AgentToolExecution): AdminToolExecutionRecord {
  const enrichedRow = row as AgentToolExecution & {
    threadUuid?: string;
    runUuid?: string;
    pendingActionUuid?: string | null;
  };

  return {
    id: row.uuid,
    threadId: enrichedRow.threadUuid || String(row.threadId),
    runId: enrichedRow.runUuid || String(row.runId),
    pendingActionId: enrichedRow.pendingActionUuid || null,
    source: row.source,
    serverSlug: row.serverSlug,
    toolName: row.toolName,
    toolCallId: row.toolCallId || null,
    args: (row.args || {}) as Record<string, unknown>,
    result: (row.result as Record<string, unknown> | null) || null,
    status: row.status,
    safetyLevel: row.safetyLevel,
    approved: row.approved,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function toCanonicalMessageRecord(message: AgentMessage, threadUuid: string): CanonicalAgentMessage | null {
  try {
    return AgentMessageStore.serializeCanonicalMessage(
      message,
      threadUuid,
      (message as AgentMessage & { runUuid?: string | null }).runUuid || null
    );
  } catch {
    return null;
  }
}

function paginateArray<T>(items: T[], page = 1, limit = 25) {
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 25;
  const offset = (safePage - 1) * safeLimit;

  return {
    data: items.slice(offset, offset + safeLimit),
    metadata: {
      pagination: {
        current: safePage,
        total: Math.max(1, Math.ceil(items.length / safeLimit)),
        items: items.length,
        limit: safeLimit,
      },
    },
  };
}

function serializeSessionSummary(
  session: EnrichedSession,
  counts?: {
    threadCount?: number;
    pendingActionsCount?: number;
    lastRunAt?: string | null;
  }
) {
  return {
    id: session.uuid,
    sessionKind: session.sessionKind,
    buildUuid: session.buildUuid,
    baseBuildUuid: session.baseBuildUuid,
    buildKind: session.buildKind,
    userId: session.userId,
    ownerGithubUsername: session.ownerGithubUsername,
    podName: session.podName,
    namespace: session.namespace,
    pvcName: session.pvcName,
    model: session.model,
    status: session.status,
    chatStatus: session.chatStatus,
    workspaceStatus: session.workspaceStatus,
    repo: session.repo,
    branch: session.branch,
    primaryRepo: session.primaryRepo,
    primaryBranch: session.primaryBranch,
    services: session.services || [],
    workspaceRepos: session.workspaceRepos || [],
    selectedServices: session.selectedServices || [],
    startupFailure: session.startupFailure || null,
    lastActivity: session.lastActivity,
    endedAt: session.endedAt,
    threadCount: counts?.threadCount ?? 0,
    pendingActionsCount: counts?.pendingActionsCount ?? 0,
    lastRunAt: counts?.lastRunAt ?? null,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
    editorUrl: session.podName && session.namespace ? `/api/agent-session/workspace-editor/${session.uuid}/` : null,
  };
}

export default class AgentAdminService {
  static async listSessions(filters: AgentAdminSessionListFilters) {
    const query = AgentSession.query();

    if (filters.status && filters.status !== 'all') {
      query.where({ status: filters.status });
    }

    if (filters.buildUuid) {
      query.where({ buildUuid: filters.buildUuid });
    }

    const normalizedUser = normalizeSearchTerm(filters.user);
    if (normalizedUser) {
      query.where((builder) => {
        builder
          .whereRaw('LOWER("userId") like ?', [`%${normalizedUser}%`])
          .orWhereRaw('LOWER(COALESCE("ownerGithubUsername", \'\')) like ?', [`%${normalizedUser}%`]);
      });
    }

    const sessions = await query.orderBy('updatedAt', 'desc').orderBy('createdAt', 'desc');
    const sessionDbIdByUuid = new Map(sessions.map((session) => [session.uuid, session.id]));
    const enrichedSessions = await AgentSessionService.enrichSessions(sessions);

    const normalizedRepo = normalizeSearchTerm(filters.repo);
    const filteredSessions = normalizedRepo
      ? enrichedSessions.filter((session) =>
          [session.repo, session.primaryRepo, ...(session.services || [])]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(normalizedRepo)
        )
      : enrichedSessions;

    const sessionIds = filteredSessions
      .map((session) => sessionDbIdByUuid.get(session.uuid))
      .filter((sessionId): sessionId is number => Number.isInteger(sessionId));
    const [threadRows, pendingRows] = await Promise.all([
      sessionIds.length
        ? AgentThread.query().whereIn('sessionId', sessionIds).select('sessionId', 'lastRunAt')
        : Promise.resolve([] as Pick<AgentThread, 'sessionId' | 'lastRunAt'>[]),
      sessionIds.length
        ? AgentPendingAction.query()
            .alias('action')
            .joinRelated('thread')
            .whereIn('thread.sessionId', sessionIds)
            .where('action.status', 'pending')
            .select('thread.sessionId')
        : Promise.resolve([] as Array<{ sessionId: number }>),
    ]);

    const threadCountBySessionId = new Map<number, number>();
    const lastRunAtBySessionId = new Map<number, string | null>();
    for (const thread of threadRows) {
      threadCountBySessionId.set(thread.sessionId, (threadCountBySessionId.get(thread.sessionId) || 0) + 1);
      const currentLastRunAt = lastRunAtBySessionId.get(thread.sessionId);
      if (!currentLastRunAt || (thread.lastRunAt && thread.lastRunAt > currentLastRunAt)) {
        lastRunAtBySessionId.set(thread.sessionId, thread.lastRunAt || null);
      }
    }

    const pendingCountBySessionId = new Map<number, number>();
    for (const row of pendingRows) {
      const sessionId = Number((row as { sessionId: number }).sessionId);
      pendingCountBySessionId.set(sessionId, (pendingCountBySessionId.get(sessionId) || 0) + 1);
    }

    const serialized = filteredSessions.map((session) =>
      serializeSessionSummary(session, {
        threadCount: threadCountBySessionId.get(sessionDbIdByUuid.get(session.uuid) || -1) || 0,
        pendingActionsCount: pendingCountBySessionId.get(sessionDbIdByUuid.get(session.uuid) || -1) || 0,
        lastRunAt: lastRunAtBySessionId.get(sessionDbIdByUuid.get(session.uuid) || -1) || null,
      })
    );

    return paginateArray(serialized, filters.page, filters.limit);
  }

  static async getSession(sessionUuid: string) {
    const session = await AgentSession.query().findOne({ uuid: sessionUuid });
    if (!session) {
      throw new Error('Agent session not found');
    }

    const [enrichedSession] = await AgentSessionService.enrichSessions([session]);
    const threads = await AgentThread.query()
      .where({ sessionId: session.id })
      .whereNull('archivedAt')
      .orderBy('isDefault', 'desc');

    const threadIds = threads.map((thread) => thread.id);
    const [messageRows, runRows, pendingRows] = await Promise.all([
      threadIds.length
        ? AgentMessage.query().whereIn('threadId', threadIds).select('threadId')
        : Promise.resolve([] as Array<{ threadId: number }>),
      threadIds.length
        ? AgentRun.query().whereIn('threadId', threadIds).orderBy('createdAt', 'desc')
        : Promise.resolve([] as AgentRun[]),
      threadIds.length
        ? AgentPendingAction.query().whereIn('threadId', threadIds).where('status', 'pending').select('threadId')
        : Promise.resolve([] as Array<{ threadId: number }>),
    ]);

    const messageCountByThreadId = new Map<number, number>();
    for (const row of messageRows) {
      const threadId = Number((row as { threadId: number }).threadId);
      messageCountByThreadId.set(threadId, (messageCountByThreadId.get(threadId) || 0) + 1);
    }

    const runCountByThreadId = new Map<number, number>();
    const latestRunByThreadId = new Map<number, AgentRun>();
    for (const run of runRows) {
      runCountByThreadId.set(run.threadId, (runCountByThreadId.get(run.threadId) || 0) + 1);
      if (!latestRunByThreadId.has(run.threadId)) {
        latestRunByThreadId.set(run.threadId, run);
      }
    }

    const pendingCountByThreadId = new Map<number, number>();
    for (const row of pendingRows) {
      const threadId = Number((row as { threadId: number }).threadId);
      pendingCountByThreadId.set(threadId, (pendingCountByThreadId.get(threadId) || 0) + 1);
    }

    const serializedThreads: AdminThreadSummary[] = threads.map((thread) => ({
      ...AgentThreadService.serializeThread(thread, session.uuid),
      messageCount: messageCountByThreadId.get(thread.id) || 0,
      runCount: runCountByThreadId.get(thread.id) || 0,
      pendingActionsCount: pendingCountByThreadId.get(thread.id) || 0,
      latestRun: latestRunByThreadId.has(thread.id)
        ? AgentRunService.serializeRun({
            ...(latestRunByThreadId.get(thread.id) as AgentRun),
            threadUuid: thread.uuid,
            sessionUuid: session.uuid,
          } as AgentRun)
        : null,
    }));

    return {
      session: serializeSessionSummary(enrichedSession, {
        threadCount: serializedThreads.length,
        pendingActionsCount: serializedThreads.reduce((total, thread) => total + thread.pendingActionsCount, 0),
        lastRunAt:
          serializedThreads
            .map((thread) => thread.lastRunAt)
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1) || null,
      }),
      threads: serializedThreads,
    };
  }

  static async getThreadConversation(threadUuid: string) {
    const thread = await AgentThread.query().findOne({ uuid: threadUuid });
    if (!thread) {
      throw new Error('Agent thread not found');
    }

    const session = await AgentSession.query().findById(thread.sessionId);
    if (!session) {
      throw new Error('Agent session not found');
    }

    const [sessionDetail, messageRows, runRows, pendingRows, toolRows, eventRows] = await Promise.all([
      this.getSession(session.uuid),
      AgentMessage.query()
        .alias('message')
        .leftJoinRelated('run')
        .where('message.threadId', thread.id)
        .select('message.*', 'run.uuid as runUuid')
        .orderBy('message.createdAt', 'asc'),
      AgentRun.query().where({ threadId: thread.id }).orderBy('createdAt', 'asc'),
      AgentPendingAction.query()
        .alias('action')
        .joinRelated('run')
        .where('action.threadId', thread.id)
        .select('action.*', 'run.uuid as runUuid')
        .orderBy('action.createdAt', 'asc'),
      AgentToolExecution.query()
        .alias('tool')
        .joinRelated('[run, thread]')
        .leftJoinRelated('pendingAction')
        .where('tool.threadId', thread.id)
        .select('tool.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid', 'pendingAction.uuid as pendingActionUuid')
        .orderBy('tool.createdAt', 'asc'),
      AgentRunEvent.query()
        .alias('event')
        .joinRelated('run')
        .where('run.threadId', thread.id)
        .select('event.*', 'run.uuid as runUuid')
        .orderBy('event.runId', 'asc')
        .orderBy('event.sequence', 'asc'),
    ]);

    const runs = runRows.map((run) =>
      AgentRunService.serializeRun({
        ...run,
        threadUuid: thread.uuid,
        sessionUuid: session.uuid,
      } as AgentRun)
    );

    const pendingActions = pendingRows.map((action) =>
      ApprovalService.serializePendingAction({
        ...action,
        threadUuid: thread.uuid,
        runUuid: (action as AgentPendingAction & { runUuid?: string }).runUuid,
      } as AgentPendingAction)
    );

    const threadSummary = sessionDetail.threads.find((candidate) => candidate.id === threadUuid);
    if (!threadSummary) {
      throw new Error('Agent thread not found');
    }

    return {
      session: sessionDetail.session,
      thread: threadSummary,
      messages: messageRows.flatMap((message) => {
        const serialized = toCanonicalMessageRecord(message, thread.uuid);
        return serialized ? [serialized] : [];
      }),
      runs,
      events: eventRows.map((event) =>
        AgentRunEventService.serializeRunEvent({
          ...event,
          runUuid: (event as AgentRunEvent & { runUuid?: string }).runUuid,
          threadUuid: thread.uuid,
          sessionUuid: session.uuid,
        } as AgentRunEvent)
      ),
      pendingActions,
      toolExecutions: toolRows.map(toToolExecutionRecord),
    };
  }

  static async listMcpServerCoverage(scope = 'global'): Promise<AgentAdminMcpServerCoverage[]> {
    const configs = await McpServerConfig.query().where({ scope }).whereNull('deletedAt').orderBy('name', 'asc');
    if (configs.length === 0) {
      return [];
    }

    const connectionRows = await UserMcpConnection.query().where({ scope }).orderBy('updatedAt', 'desc');
    const connectionRowsBySlug = new Map<string, UserMcpConnection[]>();
    for (const row of connectionRows) {
      const current = connectionRowsBySlug.get(row.slug) || [];
      current.push(row);
      connectionRowsBySlug.set(row.slug, current);
    }

    return configs.map((config) => {
      const rows = connectionRowsBySlug.get(config.slug) || [];
      const connectionRequired = requiresUserConnection(normalizeAuthConfig(config.authConfig));
      return {
        slug: config.slug,
        name: config.name,
        description: config.description ?? null,
        scope: config.scope,
        preset: config.preset ?? null,
        transport: config.transport,
        sharedConfig: redactSharedConfigSecrets({ sharedConfig: config.sharedConfig || {} }).sharedConfig || {},
        authConfig: normalizeAuthConfig(config.authConfig),
        enabled: config.enabled,
        timeout: config.timeout,
        connectionRequired: requiresUserConnection(normalizeAuthConfig(config.authConfig)),
        sharedDiscoveredTools: connectionRequired ? [] : config.sharedDiscoveredTools || [],
        userConnectionCount: rows.length,
        latestUserValidatedAt: rows[0]?.validatedAt || null,
        createdAt: config.createdAt || null,
        updatedAt: config.updatedAt || null,
      };
    });
  }

  static async listMcpServerUsers(slug: string, scope: string): Promise<AgentAdminMcpServerUserConnection[]> {
    const config = await McpServerConfig.query().where({ slug, scope }).whereNull('deletedAt').first();
    if (!config) {
      throw new Error('MCP server config not found');
    }

    const rows = await UserMcpConnectionService.listMaskedUsersForServer(
      scope,
      slug,
      buildMcpDefinitionFingerprint({
        preset: config.preset,
        transport: config.transport,
        sharedConfig: config.sharedConfig,
        authConfig: normalizeAuthConfig(config.authConfig),
      })
    );
    return rows.map((row) => ({
      userId: row.userId,
      githubUsername: row.ownerGithubUsername,
      authMode: row.authMode,
      stale: row.stale,
      configuredFieldKeys: row.configuredFieldKeys,
      discoveredToolCount: row.discoveredToolCount,
      validationError: row.validationError,
      validatedAt: row.validatedAt,
      updatedAt: row.updatedAt || null,
    }));
  }
}
