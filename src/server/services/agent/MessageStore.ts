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
import { v4 as uuid } from 'uuid';
import AgentMessage from 'server/models/AgentMessage';
import AgentRun from 'server/models/AgentRun';
import type AgentThread from 'server/models/AgentThread';
import type { AgentUIMessage } from './types';
import AgentThreadService from './ThreadService';
import {
  getCanonicalPartsFromUiMessage,
  normalizeCanonicalAgentMessageParts,
  toUiMessageFromCanonicalInput,
  type CanonicalAgentMessage,
  type CanonicalAgentInputMessage,
  type CanonicalAgentMessagePart,
  type CanonicalAgentRunMessageInput,
} from './canonicalMessages';

const AGENT_MESSAGE_UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CLIENT_MESSAGE_ID_METADATA_KEY = 'clientMessageId';
export const AGENT_SWITCH_METADATA_KIND = 'agent_switch';
// Must match EnvironmentWatchService.ENVIRONMENT_UPDATE_METADATA_KIND.
export const ENVIRONMENT_UPDATE_METADATA_KIND = 'environment_update';
const SYSTEM_MESSAGE_METADATA_KINDS = [AGENT_SWITCH_METADATA_KIND, ENVIRONMENT_UPDATE_METADATA_KIND];
export const DEFAULT_AGENT_MESSAGE_PAGE_LIMIT = 50;
export const MAX_AGENT_MESSAGE_PAGE_LIMIT = 100;

export type AgentSwitchEventMetadata = {
  kind: typeof AGENT_SWITCH_METADATA_KIND;
  actor: {
    userId: string;
    label: string;
  };
  beforeAgent: {
    id: string;
    label: string;
  };
  afterAgent: {
    id: string;
    label: string;
  };
  appliesTo: 'future_runs';
  occurredAt: string;
};

function toAgentUiMessage(message: AgentMessage): AgentUIMessage {
  return toUiMessageFromCanonicalInput(
    {
      id: message.uuid,
      role: message.role as CanonicalAgentInputMessage['role'],
      parts: normalizeCanonicalAgentMessageParts(message.parts || []),
    },
    message.metadata || {}
  );
}

function toNonEmptyAgentUiMessage(message: AgentMessage): AgentUIMessage | null {
  const uiMessage = toAgentUiMessage(message);
  return uiMessage.parts.length > 0 ? uiMessage : null;
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function normalizeMessageId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Joined run.startedAt/completedAt aliases come back as Date (they skip the model's timestamp->ISO serialization).
function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isAgentSwitchMessage(message: AgentMessage): boolean {
  return message.role === 'system' && SYSTEM_MESSAGE_METADATA_KINDS.includes(String(message.metadata?.kind));
}

function getIncomingMessageId(message: Pick<CanonicalAgentInputMessage, 'id'>): string | null {
  return normalizeMessageId(message.id);
}

function getIncomingClientMessageId(
  message: Pick<CanonicalAgentInputMessage, 'id' | 'clientMessageId'>
): string | null {
  const explicitClientMessageId = normalizeMessageId(message.clientMessageId);
  if (explicitClientMessageId) {
    return explicitClientMessageId;
  }

  const incomingMessageId = getIncomingMessageId(message);
  return incomingMessageId && !AGENT_MESSAGE_UUID_PATTERN.test(incomingMessageId) ? incomingMessageId : null;
}

function getStoredMessageIds(message: AgentMessage): string[] {
  const ids = new Set<string>();
  const rowUuid = normalizeMessageId(message.uuid);
  const rowClientMessageId = normalizeMessageId(message.clientMessageId);
  const metadataClientMessageId = normalizeMessageId(message.metadata?.[CLIENT_MESSAGE_ID_METADATA_KEY]);

  for (const id of [rowUuid, rowClientMessageId, metadataClientMessageId]) {
    if (id) {
      ids.add(id);
    }
  }

  return [...ids];
}

function buildStoredCanonicalMessage(
  message: CanonicalAgentInputMessage,
  metadata?: Record<string, unknown>,
  row?: AgentMessage
): {
  uuid: string;
  clientMessageId: string | null;
  metadata: Record<string, unknown>;
  parts: CanonicalAgentMessagePart[];
} {
  const incomingMessageId = getIncomingMessageId(message);
  const clientMessageId =
    getIncomingClientMessageId(message) ||
    normalizeMessageId(metadata?.[CLIENT_MESSAGE_ID_METADATA_KEY]) ||
    normalizeMessageId(row?.clientMessageId);
  const messageUuid =
    row?.uuid || (incomingMessageId && AGENT_MESSAGE_UUID_PATTERN.test(incomingMessageId) ? incomingMessageId : uuid());
  const storedMetadata = {
    ...(metadata || {}),
    ...(clientMessageId ? { [CLIENT_MESSAGE_ID_METADATA_KEY]: clientMessageId } : {}),
  };

  return {
    uuid: messageUuid,
    clientMessageId,
    metadata: storedMetadata,
    parts: normalizeCanonicalAgentMessageParts(message.parts || []),
  };
}

function resolveStoredRunId(
  role: CanonicalAgentInputMessage['role'],
  row: AgentMessage | undefined,
  runId?: number | null
): number | null {
  if (role !== 'assistant') {
    return row?.runId ?? null;
  }

  return row?.runId ?? runId ?? null;
}

async function loadExistingMessagesForIncomingIds(
  threadId: number,
  messages: CanonicalAgentInputMessage[],
  trx?: Transaction
): Promise<AgentMessage[]> {
  const incomingIds = [
    ...new Set(
      messages
        .flatMap((message) => [getIncomingMessageId(message), getIncomingClientMessageId(message)])
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const uuidIds = incomingIds.filter((id) => AGENT_MESSAGE_UUID_PATTERN.test(id));

  if (incomingIds.length === 0) {
    return [];
  }

  return AgentMessage.query(trx)
    .where({ threadId })
    .where((builder) => {
      if (uuidIds.length > 0) {
        builder
          .whereIn('uuid', uuidIds)
          .orWhereIn('clientMessageId', incomingIds)
          .orWhereRaw('"metadata"->>? = ANY(?::text[])', [CLIENT_MESSAGE_ID_METADATA_KEY, incomingIds]);
        return;
      }

      builder
        .whereIn('clientMessageId', incomingIds)
        .orWhereRaw('"metadata"->>? = ANY(?::text[])', [CLIENT_MESSAGE_ID_METADATA_KEY, incomingIds]);
    });
}

function serializeCanonicalAgentMessage(
  message: AgentMessage,
  threadUuid: string,
  runUuid?: string | null
): CanonicalAgentMessage | null {
  if (message.role !== 'user' && message.role !== 'assistant' && !isAgentSwitchMessage(message)) {
    return null;
  }

  const parts = normalizeCanonicalAgentMessageParts(message.parts || []);
  if (parts.length === 0) {
    return null;
  }

  const enrichedMessage = message as AgentMessage & {
    runUuid?: string | null;
    runStartedAt?: Date | string | null;
    runCompletedAt?: Date | string | null;
    createdAt?: string | null;
  };

  return {
    id: message.uuid,
    clientMessageId:
      normalizeMessageId(message.clientMessageId) ||
      normalizeMessageId(message.metadata?.[CLIENT_MESSAGE_ID_METADATA_KEY]),
    threadId: threadUuid,
    runId: runUuid || normalizeMessageId(enrichedMessage.runUuid),
    role: message.role as CanonicalAgentMessage['role'],
    parts,
    ...resolveSerializedMetadata(message, enrichedMessage),
    createdAt: enrichedMessage.createdAt || null,
  };
}

// Assistant messages carry run start/end timestamps in metadata so the read API can render a thinking duration.
function resolveSerializedMetadata(
  message: AgentMessage,
  enrichedMessage: AgentMessage & {
    runStartedAt?: Date | string | null;
    runCompletedAt?: Date | string | null;
    createdAt?: string | null;
  }
): { metadata?: Record<string, unknown> } {
  if (isAgentSwitchMessage(message)) {
    return { metadata: message.metadata || {} };
  }

  if (message.role !== 'assistant') {
    return {};
  }

  const metadata = message.metadata || {};
  // run.startedAt is the authoritative thinking start; stored metadata.createdAt is a buggy ~completion value.
  const createdAt =
    normalizeTimestamp(enrichedMessage.runStartedAt) ||
    normalizeTimestamp(metadata.createdAt) ||
    normalizeTimestamp(enrichedMessage.createdAt);
  const completedAt =
    normalizeTimestamp(enrichedMessage.runCompletedAt) || normalizeTimestamp(metadata.completedAt) || createdAt;

  return {
    metadata: {
      ...metadata,
      ...(createdAt ? { createdAt: clampStartBeforeEnd(createdAt, completedAt) } : {}),
      ...(completedAt ? { completedAt } : {}),
    },
  };
}

// Keep the served start strictly before the end so the UI renders a real positive duration.
function clampStartBeforeEnd(start: string, end: string | null): string {
  if (!end) {
    return start;
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return start;
  }
  return startMs <= endMs ? start : end;
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit) || !limit) {
    return DEFAULT_AGENT_MESSAGE_PAGE_LIMIT;
  }

  return Math.min(Math.max(1, Math.trunc(limit)), MAX_AGENT_MESSAGE_PAGE_LIMIT);
}

// Build the messageId -> row index used by every upsert path.
function buildExistingByMessageId(rows: AgentMessage[]): Map<string, AgentMessage> {
  const existingByMessageId = new Map<string, AgentMessage>();
  for (const message of rows) {
    for (const messageId of getStoredMessageIds(message)) {
      existingByMessageId.set(messageId, message);
    }
  }

  return existingByMessageId;
}

// Shared insert-or-patch loop; `reAddPatchedRow` keeps the index current after a patch for callers that rely on it.
async function applyCanonicalMessageUpserts(
  threadId: number,
  messages: CanonicalAgentInputMessage[],
  existingByMessageId: Map<string, AgentMessage>,
  options: {
    runId?: number | null;
    trx?: Transaction;
    metadataFor?: (message: CanonicalAgentInputMessage) => Record<string, unknown> | undefined;
    reAddPatchedRow?: boolean;
  } = {}
): Promise<void> {
  for (const message of messages) {
    const incomingMessageId = getIncomingMessageId(message);
    const row = incomingMessageId ? existingByMessageId.get(incomingMessageId) : undefined;
    const stored = buildStoredCanonicalMessage(message, options.metadataFor?.(message), row);
    const patch: PartialModelObject<AgentMessage> = {
      role: message.role,
      parts: stored.parts as unknown as Record<string, unknown>[],
      uiMessage: null,
      clientMessageId: stored.clientMessageId,
      metadata: toJsonRecord(stored.metadata),
      runId: resolveStoredRunId(message.role, row, options.runId),
    };

    if (!row) {
      const inserted = await AgentMessage.query(options.trx).insert({
        uuid: stored.uuid,
        threadId,
        ...patch,
      });
      for (const messageId of getStoredMessageIds(inserted)) {
        existingByMessageId.set(messageId, inserted);
      }
      continue;
    }

    const updated = await AgentMessage.query(options.trx).patchAndFetchById(row.id, patch);
    if (options.reAddPatchedRow) {
      for (const messageId of getStoredMessageIds(updated)) {
        existingByMessageId.set(messageId, updated);
      }
    }
  }
}

export default class AgentMessageStore {
  static serializeCanonicalMessage(
    message: AgentMessage,
    threadUuid: string,
    runUuid?: string | null
  ): CanonicalAgentMessage {
    const serialized = serializeCanonicalAgentMessage(message, threadUuid, runUuid);
    if (!serialized) {
      throw new Error('Agent message is not a public canonical message');
    }

    return serialized;
  }

  static async listMessages(threadUuid: string, userId: string): Promise<AgentUIMessage[]> {
    const thread = await AgentThreadService.getOwnedThread(threadUuid, userId);
    const rows = await AgentMessage.query().where({ threadId: thread.id }).orderBy('createdAt', 'asc');
    return rows.flatMap((row) => {
      const message = toNonEmptyAgentUiMessage(row);
      return message ? [message] : [];
    });
  }

  static async listCanonicalMessages(
    threadUuid: string,
    userId: string,
    options: {
      limit?: number;
      beforeMessageId?: string | null;
    } = {}
  ): Promise<{
    thread: ReturnType<typeof AgentThreadService.serializeThread>;
    messages: CanonicalAgentMessage[];
    pagination: {
      hasMore: boolean;
      nextBeforeMessageId: string | null;
    };
  }> {
    const { thread, session } = await AgentThreadService.getOwnedThreadWithSession(threadUuid, userId);
    const limit = normalizeLimit(options.limit);
    let cursor: AgentMessage | undefined;

    if (options.beforeMessageId) {
      cursor = await AgentMessage.query().findOne({
        threadId: thread.id,
        uuid: options.beforeMessageId,
      });
      if (!cursor) {
        throw new Error('Agent message cursor not found');
      }
    }

    const query = AgentMessage.query()
      .alias('message')
      .leftJoin('agent_runs as run', 'message.runId', 'run.id')
      .where('message.threadId', thread.id)
      .where((builder) => {
        builder.whereIn('message.role', ['user', 'assistant']).orWhere((systemBuilder) => {
          systemBuilder
            .where('message.role', 'system')
            .whereRaw('"message"."metadata"->>? in (?, ?)', ['kind', ...SYSTEM_MESSAGE_METADATA_KINDS]);
        });
      })
      .select('message.*', 'run.uuid as runUuid', 'run.startedAt as runStartedAt', 'run.completedAt as runCompletedAt')
      .orderBy('message.createdAt', 'desc')
      .orderBy('message.id', 'desc')
      .limit(limit + 1);

    if (cursor) {
      const cursorCreatedAt = (cursor as AgentMessage & { createdAt?: string | null }).createdAt;
      if (!cursorCreatedAt) {
        throw new Error('Agent message cursor not found');
      }
      const cursorId = cursor.id;
      query.where((builder) => {
        builder.where('message.createdAt', '<', cursorCreatedAt).orWhere((sameTimestampBuilder) => {
          sameTimestampBuilder.where('message.createdAt', '=', cursorCreatedAt).where('message.id', '<', cursorId);
        });
      });
    }

    const rows = await query;
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit).reverse();
    const messages = pageRows.flatMap((row) => {
      const serialized = serializeCanonicalAgentMessage(row, thread.uuid);
      return serialized ? [serialized] : [];
    });

    return {
      thread: AgentThreadService.serializeThread(thread, session.uuid),
      messages,
      pagination: {
        hasMore,
        nextBeforeMessageId: hasMore && pageRows[0] ? pageRows[0].uuid : null,
      },
    };
  }

  static async findCanonicalMessageByClientMessageId(
    thread: Pick<AgentThread, 'id'>,
    clientMessageId: string,
    trx?: Transaction
  ): Promise<AgentMessage | undefined> {
    const normalizedClientMessageId = normalizeMessageId(clientMessageId);
    if (!normalizedClientMessageId) {
      return undefined;
    }

    const message = await AgentMessage.query(trx)
      .where({ threadId: thread.id, clientMessageId: normalizedClientMessageId })
      .orWhere((builder) => {
        builder
          .where({ threadId: thread.id })
          .whereRaw('"metadata"->>? = ?', [CLIENT_MESSAGE_ID_METADATA_KEY, normalizedClientMessageId]);
      })
      .first();

    return message || undefined;
  }

  static async insertUserMessageForRun(
    thread: Pick<AgentThread, 'id'>,
    run: Pick<AgentRun, 'id'>,
    message: CanonicalAgentRunMessageInput,
    trx?: Transaction
  ): Promise<AgentMessage> {
    const clientMessageId = normalizeMessageId(message.clientMessageId);
    const metadata = clientMessageId ? { [CLIENT_MESSAGE_ID_METADATA_KEY]: clientMessageId } : {};

    return AgentMessage.query(trx).insertAndFetch({
      uuid: uuid(),
      threadId: thread.id,
      runId: run.id,
      role: 'user',
      parts: normalizeCanonicalAgentMessageParts(message.parts) as unknown as Record<string, unknown>[],
      uiMessage: null,
      clientMessageId,
      metadata,
    });
  }

  static async createAgentSwitchEvent({
    thread,
    actor,
    beforeAgent,
    afterAgent,
    occurredAt = new Date().toISOString(),
    trx,
  }: {
    thread: Pick<AgentThread, 'id'>;
    actor: { userId: string; label?: string | null };
    beforeAgent: { id: string; label: string };
    afterAgent: { id: string; label: string };
    occurredAt?: string;
    trx?: Transaction;
  }): Promise<AgentMessage> {
    const actorLabel = actor.label?.trim() || 'You';
    const text = `${actorLabel} switched ${beforeAgent.label} -> ${afterAgent.label}. Applies to future runs.`;
    const metadata: AgentSwitchEventMetadata = {
      kind: AGENT_SWITCH_METADATA_KIND,
      actor: {
        userId: actor.userId,
        label: actorLabel,
      },
      beforeAgent,
      afterAgent,
      appliesTo: 'future_runs',
      occurredAt,
    };

    return AgentMessage.query(trx).insertAndFetch({
      uuid: uuid(),
      threadId: thread.id,
      runId: null,
      role: 'system',
      parts: [{ type: 'text', text }] as unknown as Record<string, unknown>[],
      uiMessage: null,
      clientMessageId: null,
      metadata: metadata as unknown as Record<string, unknown>,
    });
  }

  static async syncCanonicalMessages(
    threadUuid: string,
    userId: string,
    messages: CanonicalAgentInputMessage[],
    runUuid?: string
  ): Promise<AgentUIMessage[]> {
    const thread = await AgentThreadService.getOwnedThread(threadUuid, userId);
    const run = runUuid ? await AgentRun.query().findOne({ uuid: runUuid, threadId: thread.id }) : null;
    const existing = await AgentMessage.query().where({ threadId: thread.id });
    const existingByMessageId = buildExistingByMessageId(existing);

    const nonEmptyMessages = messages.filter(
      (message) => normalizeCanonicalAgentMessageParts(message.parts).length > 0
    );

    await applyCanonicalMessageUpserts(thread.id, nonEmptyMessages, existingByMessageId, {
      runId: run?.id ?? null,
    });

    const reloaded = await AgentMessage.query().where({ threadId: thread.id }).orderBy('createdAt', 'asc');
    return reloaded.flatMap((row) => {
      const message = toNonEmptyAgentUiMessage(row);
      return message ? [message] : [];
    });
  }

  static async upsertCanonicalMessagesForThread(
    thread: Pick<AgentThread, 'id'>,
    messages: CanonicalAgentInputMessage[],
    options?: {
      trx?: Transaction;
      runId?: number | null;
    }
  ): Promise<void> {
    const nonEmptyMessages = messages.filter(
      (message) => normalizeCanonicalAgentMessageParts(message.parts).length > 0
    );
    if (nonEmptyMessages.length === 0) {
      return;
    }

    const existing = await loadExistingMessagesForIncomingIds(thread.id, nonEmptyMessages, options?.trx);
    const existingByMessageId = buildExistingByMessageId(existing);

    await applyCanonicalMessageUpserts(thread.id, nonEmptyMessages, existingByMessageId, {
      runId: options?.runId,
      trx: options?.trx,
      reAddPatchedRow: true,
    });
  }

  static async syncCanonicalMessagesFromUiMessages(
    threadUuid: string,
    userId: string,
    messages: AgentUIMessage[],
    runUuid?: string
  ): Promise<AgentUIMessage[]> {
    const thread = await AgentThreadService.getOwnedThread(threadUuid, userId);
    const run = runUuid ? await AgentRun.query().findOne({ uuid: runUuid, threadId: thread.id }) : null;
    await this.upsertCanonicalUiMessagesForThread(thread, messages, {
      runId: run?.id ?? null,
    });

    const reloaded = await AgentMessage.query().where({ threadId: thread.id }).orderBy('createdAt', 'asc');
    return reloaded.flatMap((row) => {
      const message = toNonEmptyAgentUiMessage(row);
      return message ? [message] : [];
    });
  }

  static async upsertCanonicalUiMessagesForThread(
    thread: Pick<AgentThread, 'id'>,
    messages: AgentUIMessage[],
    options?: {
      trx?: Transaction;
      runId?: number | null;
    }
  ): Promise<void> {
    const metadataById = new Map<string, Record<string, unknown>>();
    const canonicalMessages = messages
      .filter((message) => ['user', 'assistant', 'system'].includes(message.role))
      .map((message) => {
        metadataById.set(message.id, toJsonRecord(message.metadata || {}));
        return {
          id: message.id,
          role: message.role as CanonicalAgentInputMessage['role'],
          parts: getCanonicalPartsFromUiMessage(message),
        };
      })
      .filter((message) => message.parts.length > 0);

    const existing = await AgentMessage.query(options?.trx).where({ threadId: thread.id });
    const existingByMessageId = buildExistingByMessageId(existing);

    await applyCanonicalMessageUpserts(thread.id, canonicalMessages, existingByMessageId, {
      runId: options?.runId,
      trx: options?.trx,
      metadataFor: (message) => {
        const incomingMessageId = getIncomingMessageId(message);
        return incomingMessageId ? metadataById.get(incomingMessageId) : undefined;
      },
    });
  }
}
