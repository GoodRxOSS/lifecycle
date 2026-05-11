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
import AgentSandbox from 'server/models/AgentSandbox';
import AgentSandboxExposure from 'server/models/AgentSandboxExposure';
import AgentSource from 'server/models/AgentSource';
import AgentThread from 'server/models/AgentThread';
import type { PaginationMetadata } from 'server/lib/paginate';
import { raw } from 'objection';
import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';
import { normalizeWorkspaceRuntimeFailure } from 'server/lib/agentSession/startupFailureState';
import AgentThreadService from './ThreadService';
import AgentSandboxService from './SandboxService';
import AgentUsageService, { type AgentUsageAggregate } from './AgentUsageService';

export const DEFAULT_AGENT_SESSION_LIST_LIMIT = 25;
export const MAX_AGENT_SESSION_LIST_LIMIT = 100;

interface ListOwnedSessionRecordOptions {
  includeEnded?: boolean;
  page?: number;
  limit?: number;
}

interface SessionRecordRelations {
  source: AgentSource;
  sandbox: AgentSandbox | null;
  exposures: AgentSandboxExposure[];
  defaultThread: AgentThread | null;
  conversationSummary: AgentSessionConversationSummary;
  usage: AgentUsageAggregate;
}

interface AgentSessionConversationSummary {
  activeTitle: string | null;
  conversationCount: number;
  lastActivityAt: string | null;
}

interface AgentThreadConversationSummaryRow {
  sessionId: number | string;
  conversationCount: number | string;
  lastActivityAt?: string | Date | null;
}

function mapSessionStatus(session: AgentSession): 'ready' | 'ended' | 'error' {
  if (session.status === 'ended') {
    return 'ended';
  }

  if (session.status === 'error' || session.chatStatus === AgentChatStatus.ERROR) {
    return 'error';
  }

  if (session.workspaceStatus === 'failed' && session.sessionKind !== AgentSessionKind.CHAT) {
    return 'error';
  }

  return 'ready';
}

function buildDerivedSourceInput(session: AgentSession, source: AgentSource) {
  const workspaceRepos = session.workspaceRepos ?? [];
  const primaryRepo = workspaceRepos.find((repo) => repo.primary) ?? workspaceRepos[0] ?? null;

  return {
    ...(source.input || {}),
    sessionKind: session.sessionKind,
    buildUuid: session.buildUuid,
    buildKind: session.buildKind,
    repo: primaryRepo?.repo ?? null,
    branch: primaryRepo?.branch ?? null,
    primaryRepo: primaryRepo?.repo ?? null,
    primaryBranch: primaryRepo?.branch ?? null,
    workspaceRepos,
    selectedServices: session.selectedServices ?? [],
    services: (session.selectedServices ?? []).map((service) => service.name),
  };
}

function readSourceDefaultProvider(source: AgentSource): string | null {
  const defaults = source.input?.defaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return null;
  }

  const provider = (defaults as Record<string, unknown>).provider;
  return typeof provider === 'string' && provider.trim() ? provider.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function serializeWorkspaceStorageProviderState(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const workspaceStorage = {
    ...(readString(value.size) ? { size: readString(value.size) as string } : {}),
    ...(readString(value.accessMode) ? { accessMode: readString(value.accessMode) as string } : {}),
    ...(readString(value.pvcName) ? { pvcName: readString(value.pvcName) as string } : {}),
  };

  return Object.keys(workspaceStorage).length > 0 ? workspaceStorage : undefined;
}

function serializeSelectedServicesProviderState(value: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const selectedServices = value
    .filter(isRecord)
    .map((service) => ({
      ...(readString(service.name) ? { name: readString(service.name) as string } : {}),
      ...(readString(service.repositoryFullName)
        ? { repositoryFullName: readString(service.repositoryFullName) as string }
        : {}),
      ...(readString(service.branch) ? { branch: readString(service.branch) as string } : {}),
      ...(readString(service.deployableName) ? { deployableName: readString(service.deployableName) as string } : {}),
      ...(readString(service.deployUuid) ? { deployUuid: readString(service.deployUuid) as string } : {}),
    }))
    .filter((service) => Object.keys(service).length > 0);

  return selectedServices.length > 0 ? selectedServices : undefined;
}

function serializeProviderState(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  const workspaceStorage = serializeWorkspaceStorageProviderState(value.workspaceStorage);
  const selectedServices = serializeSelectedServicesProviderState(value.selectedServices);

  return {
    ...(readString(value.namespace) ? { namespace: readString(value.namespace) as string } : {}),
    ...(readString(value.podName) ? { podName: readString(value.podName) as string } : {}),
    ...(readString(value.pvcName) ? { pvcName: readString(value.pvcName) as string } : {}),
    ...(workspaceStorage ? { workspaceStorage } : {}),
    ...(selectedServices ? { selectedServices } : {}),
  };
}

function serializeSandboxError(sandbox: AgentSandbox) {
  if (!sandbox.error && sandbox.status !== 'failed') {
    return null;
  }

  return normalizeWorkspaceRuntimeFailure(sandbox.error, {
    origin: 'legacy',
    retryable: false,
  });
}

function serializeEmptySandbox(session: AgentSession) {
  const failedWorkspace = session.workspaceStatus === AgentWorkspaceStatus.FAILED;

  return {
    id: null,
    generation: null,
    provider: null,
    status: failedWorkspace ? 'failed' : 'none',
    capabilitySnapshot: {},
    providerState: {},
    exposures: [],
    suspendedAt: null,
    endedAt: null,
    error: failedWorkspace
      ? normalizeWorkspaceRuntimeFailure(null, {
          origin: 'legacy',
          retryable: false,
        })
      : null,
    createdAt: null,
    updatedAt: null,
  };
}

function normalizeTimestamp(value: string | Date | null | undefined): { time: number; iso: string } | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : { time, iso: value.toISOString() };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const hasExplicitTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const parseableValue = hasExplicitTimezone ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
  const time = Date.parse(parseableValue);
  return Number.isNaN(time) ? null : { time, iso: new Date(time).toISOString() };
}

function latestTimestamp(values: Array<string | Date | null | undefined>): string | null {
  let latest: { time: number; iso: string } | null = null;

  for (const value of values) {
    const timestamp = normalizeTimestamp(value);
    if (!timestamp) {
      continue;
    }

    if (!latest || timestamp.time > latest.time) {
      latest = timestamp;
    }
  }

  return latest?.iso || null;
}

function readUsefulThreadTitle(thread: AgentThread | null): string | null {
  const title = thread?.title?.trim();
  if (!title || title.toLowerCase() === 'default thread') {
    return null;
  }

  return title;
}

function resolveConversationSummary(
  session: AgentSession,
  activeDefaultThread: AgentThread | null,
  threadSummary: AgentThreadConversationSummaryRow | null
): AgentSessionConversationSummary {
  const parsedCount = Number(threadSummary?.conversationCount || 0);
  const conversationCount = Number.isFinite(parsedCount) ? Math.max(0, parsedCount) : 0;

  return {
    activeTitle: readUsefulThreadTitle(activeDefaultThread),
    conversationCount,
    lastActivityAt: latestTimestamp([
      threadSummary?.lastActivityAt,
      session.lastActivity,
      session.updatedAt,
      session.createdAt,
    ]),
  };
}

export default class AgentSessionReadService {
  static async getOwnedSessionRecord(sessionId: string, userId: string) {
    const session = await AgentSession.query().findOne({ uuid: sessionId, userId });
    if (!session) {
      return null;
    }

    return this.serializeSessionRecord(session);
  }

  static async listOwnedSessionRecords(userId: string, options?: ListOwnedSessionRecordOptions) {
    const page =
      typeof options?.page === 'number' && Number.isFinite(options.page) && options.page > 0
        ? Math.floor(options.page)
        : 1;
    const limit =
      typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), MAX_AGENT_SESSION_LIST_LIMIT)
        : DEFAULT_AGENT_SESSION_LIST_LIMIT;
    const query = AgentSession.query().where({ userId });

    if (!options?.includeEnded) {
      query.whereIn('status', ['starting', 'active']);
    }

    const result = await query
      .orderBy('updatedAt', 'desc')
      .orderBy('createdAt', 'desc')
      .page(page - 1, limit);

    return {
      records: await this.listSessionRecords(result.results),
      metadata: {
        pagination: {
          current: page,
          total: Math.max(1, Math.ceil(result.total / limit)),
          items: result.total,
          limit,
        },
      } as { pagination: PaginationMetadata },
    };
  }

  static async serializeSessionRecord(session: AgentSession) {
    const [record] = await this.listSessionRecords([session]);
    return record;
  }

  private static serializeSessionRecordWithRelations(session: AgentSession, relations: SessionRecordRelations) {
    const { source, sandbox, defaultThread } = relations;
    return {
      session: {
        id: session.uuid,
        status: mapSessionStatus(session),
        userId: session.userId,
        ownerGithubUsername: session.ownerGithubUsername,
        defaults: {
          provider: readSourceDefaultProvider(source),
          model: session.defaultModel || session.model,
          harness: session.defaultHarness,
        },
        defaultThreadId: defaultThread?.uuid || null,
        lastActivity: session.lastActivity || null,
        endedAt: session.endedAt || null,
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
      },
      source: {
        id: source.uuid,
        adapter: source.adapter,
        status: source.status,
        input: buildDerivedSourceInput(session, source),
        sandboxRequirements: source.sandboxRequirements || {},
        error: source.error,
        preparedAt: source.preparedAt,
        cleanedUpAt: source.cleanedUpAt,
        createdAt: source.createdAt || null,
        updatedAt: source.updatedAt || null,
      },
      sandbox: sandbox
        ? {
            id: sandbox.uuid,
            generation: sandbox.generation,
            provider: sandbox.provider,
            status: sandbox.status,
            capabilitySnapshot: sandbox.capabilitySnapshot || {},
            providerState: serializeProviderState(sandbox.providerState),
            exposures: relations.exposures.map((exposure) => AgentSandboxService.serializeSandboxExposure(exposure)),
            suspendedAt: sandbox.suspendedAt,
            endedAt: sandbox.endedAt,
            error: serializeSandboxError(sandbox),
            createdAt: sandbox.createdAt || null,
            updatedAt: sandbox.updatedAt || null,
          }
        : serializeEmptySandbox(session),
      conversationSummary: relations.conversationSummary,
      usage: relations.usage,
    };
  }

  static async listSessionRecords(sessions: AgentSession[]) {
    if (sessions.length === 0) {
      return [];
    }

    const sessionIds = sessions.map((session) => session.id);
    const defaultThreadIds = sessions
      .map((session) => session.defaultThreadId)
      .filter((threadId): threadId is number => Number.isInteger(threadId));
    const [sources, sandboxes, defaultThreads, activeDefaultThreads, threadSummaryRows, usageBySessionId] =
      await Promise.all([
        AgentSource.query().whereIn('sessionId', sessionIds),
        AgentSandbox.query()
          .whereIn('sessionId', sessionIds)
          .orderBy('generation', 'desc')
          .orderBy('createdAt', 'desc'),
        defaultThreadIds.length ? AgentThread.query().whereIn('id', defaultThreadIds) : Promise.resolve([]),
        AgentThread.query()
          .whereIn('sessionId', sessionIds)
          .where({ isDefault: true })
          .whereNull('archivedAt')
          .orderBy('createdAt', 'asc'),
        AgentThread.query()
          .whereIn('sessionId', sessionIds)
          .whereNull('archivedAt')
          .select(
            'sessionId',
            raw('count("id")::int as "conversationCount"'),
            raw(`
            max(greatest(
              coalesce("lastRunAt", '-infinity'::timestamp),
              coalesce("updatedAt", '-infinity'::timestamp),
              coalesce("createdAt", '-infinity'::timestamp)
            )) as "lastActivityAt"
          `)
          )
          .groupBy('sessionId'),
        AgentUsageService.aggregateSessionsUsage(sessionIds),
      ]);
    const sourceBySessionId = new Map<number, AgentSource>();
    for (const source of sources) {
      sourceBySessionId.set(source.sessionId, source);
    }

    const sandboxBySessionId = new Map<number, AgentSandbox>();
    for (const sandbox of sandboxes) {
      if (!sandboxBySessionId.has(sandbox.sessionId)) {
        sandboxBySessionId.set(sandbox.sessionId, sandbox);
      }
    }

    const latestSandboxIds = [...sandboxBySessionId.values()].map((sandbox) => sandbox.id);
    const exposures = latestSandboxIds.length
      ? await AgentSandboxExposure.query().whereIn('sandboxId', latestSandboxIds).orderBy('createdAt', 'asc')
      : [];
    const exposuresBySandboxId = new Map<number, AgentSandboxExposure[]>();
    for (const exposure of exposures) {
      const existing = exposuresBySandboxId.get(exposure.sandboxId) || [];
      existing.push(exposure);
      exposuresBySandboxId.set(exposure.sandboxId, existing);
    }

    const defaultThreadById = new Map<number, AgentThread>();
    for (const thread of defaultThreads) {
      defaultThreadById.set(thread.id, thread);
    }

    const threadSummaryBySessionId = new Map<number, AgentThreadConversationSummaryRow>();
    for (const row of threadSummaryRows as AgentThreadConversationSummaryRow[]) {
      threadSummaryBySessionId.set(Number(row.sessionId), row);
    }

    const fallbackThreadBySessionId = new Map<number, AgentThread>();
    for (const thread of activeDefaultThreads) {
      if (!fallbackThreadBySessionId.has(thread.sessionId)) {
        fallbackThreadBySessionId.set(thread.sessionId, thread);
      }
    }

    return sessions.map((session) => {
      const source = sourceBySessionId.get(session.id);
      if (!source) {
        throw new Error(`Agent session source missing for session ${session.uuid}`);
      }

      const sandbox = sandboxBySessionId.get(session.id) || null;
      const defaultThread =
        (session.defaultThreadId ? defaultThreadById.get(session.defaultThreadId) : null) ||
        fallbackThreadBySessionId.get(session.id) ||
        null;

      return this.serializeSessionRecordWithRelations(session, {
        source,
        sandbox,
        defaultThread,
        conversationSummary: resolveConversationSummary(
          session,
          fallbackThreadBySessionId.get(session.id) || null,
          threadSummaryBySessionId.get(session.id) || null
        ),
        exposures: sandbox ? exposuresBySandboxId.get(sandbox.id) || [] : [],
        usage: usageBySessionId.get(session.id) || AgentUsageService.aggregateRuns([]),
      });
    });
  }

  static async serializeThread(thread: AgentThread, session: AgentSession) {
    const serialized = AgentThreadService.serializeThread(thread, session.uuid);
    return {
      ...serialized,
      session: {
        id: session.uuid,
      },
    };
  }
}
