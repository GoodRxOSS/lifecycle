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
import AgentThreadService from './ThreadService';
import AgentSandboxService from './SandboxService';

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
}

function mapSessionStatus(session: AgentSession): 'ready' | 'ended' | 'error' {
  if (session.status === 'ended') {
    return 'ended';
  }

  if (session.status === 'error' || session.workspaceStatus === 'failed') {
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
            exposures: relations.exposures.map((exposure) => AgentSandboxService.serializeSandboxExposure(exposure)),
            suspendedAt: sandbox.suspendedAt,
            endedAt: sandbox.endedAt,
            error: sandbox.error,
            createdAt: sandbox.createdAt || null,
            updatedAt: sandbox.updatedAt || null,
          }
        : {
            id: null,
            generation: null,
            provider: null,
            status: 'none',
            capabilitySnapshot: {},
            exposures: [],
            suspendedAt: null,
            endedAt: null,
            error: null,
            createdAt: null,
            updatedAt: null,
          },
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
    const [sources, sandboxes, defaultThreads, fallbackThreads] = await Promise.all([
      AgentSource.query().whereIn('sessionId', sessionIds),
      AgentSandbox.query().whereIn('sessionId', sessionIds).orderBy('generation', 'desc').orderBy('createdAt', 'desc'),
      defaultThreadIds.length ? AgentThread.query().whereIn('id', defaultThreadIds) : Promise.resolve([]),
      AgentThread.query()
        .whereIn('sessionId', sessionIds)
        .where({ isDefault: true })
        .whereNull('archivedAt')
        .orderBy('createdAt', 'asc'),
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

    const fallbackThreadBySessionId = new Map<number, AgentThread>();
    for (const thread of fallbackThreads) {
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
        exposures: sandbox ? exposuresBySandboxId.get(sandbox.id) || [] : [],
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
