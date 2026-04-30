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
import AgentThread from 'server/models/AgentThread';
import type { Transaction } from 'objection';
import { canSessionAcceptMessages, getSessionMessageBlockReason } from './sessionReadiness';

export const AGENT_THREAD_SELECTED_AGENT_DEFINITION_METADATA_KEY = 'selectedAgentDefinitionId';
export const AGENT_THREAD_RUNTIME_CONTROL_CHOICES_METADATA_KEY = 'runtimeControlChoices';

export type AgentThreadRuntimeControlChoicesMetadata = {
  version: 1;
  toolChoiceIds: string[];
  mcpChoiceIds: string[];
};

function normalizeTitle(title?: string | null): string | null {
  const trimmed = title?.trim();
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

export default class AgentThreadService {
  static getSelectedAgentDefinitionId = getSelectedAgentDefinitionId;
  static buildSelectedAgentDefinitionMetadataPatch = buildSelectedAgentDefinitionMetadataPatch;
  static getRuntimeControlChoices = getRuntimeControlChoices;
  static buildRuntimeControlChoicesMetadataPatch = buildRuntimeControlChoicesMetadataPatch;

  static async getOwnedSession(sessionUuid: string, userId: string): Promise<AgentSession> {
    const session = await AgentSession.query().findOne({ uuid: sessionUuid, userId });
    if (!session) {
      throw new Error('Agent session not found');
    }

    return session;
  }

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

  static async createThread(sessionUuid: string, userId: string, title?: string | null): Promise<AgentThread> {
    const session = await this.getOwnedSession(sessionUuid, userId);
    if (session.status === 'ended' || session.status === 'error') {
      throw new Error('Cannot create a thread for an inactive session');
    }
    if (!canSessionAcceptMessages(session)) {
      throw new Error(getSessionMessageBlockReason(session));
    }

    return AgentThread.query().insertAndFetch({
      sessionId: session.id,
      title: normalizeTitle(title),
      isDefault: false,
      metadata: {
        sessionUuid: session.uuid,
      },
    } as Partial<AgentThread>);
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
