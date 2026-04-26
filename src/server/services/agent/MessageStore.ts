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
export const DEFAULT_AGENT_MESSAGE_PAGE_LIMIT = 50;
export const MAX_AGENT_MESSAGE_PAGE_LIMIT = 100;

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
  if (message.role !== 'user' && message.role !== 'assistant') {
    return null;
  }

  const parts = normalizeCanonicalAgentMessageParts(message.parts || []);
  if (parts.length === 0) {
    return null;
  }

  const enrichedMessage = message as AgentMessage & {
    runUuid?: string | null;
    createdAt?: string | null;
  };

  return {
    id: message.uuid,
    clientMessageId:
      normalizeMessageId(message.clientMessageId) ||
      normalizeMessageId(message.metadata?.[CLIENT_MESSAGE_ID_METADATA_KEY]),
    threadId: threadUuid,
    runId: runUuid || normalizeMessageId(enrichedMessage.runUuid),
    role: message.role,
    parts,
    createdAt: enrichedMessage.createdAt || null,
  };
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit) || !limit) {
    return DEFAULT_AGENT_MESSAGE_PAGE_LIMIT;
  }

  return Math.min(Math.max(1, Math.trunc(limit)), MAX_AGENT_MESSAGE_PAGE_LIMIT);
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
      .whereIn('message.role', ['user', 'assistant'])
      .select('message.*', 'run.uuid as runUuid')
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

  static async syncCanonicalMessages(
    threadUuid: string,
    userId: string,
    messages: CanonicalAgentInputMessage[],
    runUuid?: string
  ): Promise<AgentUIMessage[]> {
    const thread = await AgentThreadService.getOwnedThread(threadUuid, userId);
    const run = runUuid ? await AgentRun.query().findOne({ uuid: runUuid, threadId: thread.id }) : null;
    const runId = run?.id ?? null;
    const existing = await AgentMessage.query().where({ threadId: thread.id });
    const existingByMessageId = new Map<string, AgentMessage>();
    for (const message of existing) {
      for (const messageId of getStoredMessageIds(message)) {
        existingByMessageId.set(messageId, message);
      }
    }

    const nonEmptyMessages = messages.filter(
      (message) => normalizeCanonicalAgentMessageParts(message.parts).length > 0
    );

    for (const message of nonEmptyMessages) {
      const incomingMessageId = getIncomingMessageId(message);
      const row = incomingMessageId ? existingByMessageId.get(incomingMessageId) : undefined;
      const stored = buildStoredCanonicalMessage(message, undefined, row);
      const metadata = toJsonRecord(stored.metadata);
      const patch: PartialModelObject<AgentMessage> = {
        role: message.role,
        parts: stored.parts as unknown as Record<string, unknown>[],
        uiMessage: null,
        clientMessageId: stored.clientMessageId,
        metadata,
        runId: message.role === 'assistant' && runId ? runId : row?.runId ?? null,
      };

      if (!row) {
        const inserted = await AgentMessage.query().insert({
          uuid: stored.uuid,
          threadId: thread.id,
          ...patch,
        });
        for (const messageId of getStoredMessageIds(inserted)) {
          existingByMessageId.set(messageId, inserted);
        }
        continue;
      }

      await AgentMessage.query().patchAndFetchById(row.id, patch);
    }

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
    const existingByMessageId = new Map<string, AgentMessage>();
    for (const message of existing) {
      for (const messageId of getStoredMessageIds(message)) {
        existingByMessageId.set(messageId, message);
      }
    }

    for (const message of nonEmptyMessages) {
      const incomingMessageId = getIncomingMessageId(message);
      const row = incomingMessageId ? existingByMessageId.get(incomingMessageId) : undefined;
      const stored = buildStoredCanonicalMessage(message, undefined, row);
      const patch: PartialModelObject<AgentMessage> = {
        role: message.role,
        parts: stored.parts as unknown as Record<string, unknown>[],
        uiMessage: null,
        clientMessageId: stored.clientMessageId,
        metadata: toJsonRecord(stored.metadata),
        runId: message.role === 'assistant' && options?.runId ? options.runId : row?.runId ?? null,
      };

      if (!row) {
        const inserted = await AgentMessage.query(options?.trx).insert({
          uuid: stored.uuid,
          threadId: thread.id,
          ...patch,
        });
        for (const messageId of getStoredMessageIds(inserted)) {
          existingByMessageId.set(messageId, inserted);
        }
        continue;
      }

      const updated = await AgentMessage.query(options?.trx).patchAndFetchById(row.id, patch);
      for (const messageId of getStoredMessageIds(updated)) {
        existingByMessageId.set(messageId, updated);
      }
    }
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
    const existingByMessageId = new Map<string, AgentMessage>();
    for (const message of existing) {
      for (const messageId of getStoredMessageIds(message)) {
        existingByMessageId.set(messageId, message);
      }
    }

    for (const message of canonicalMessages) {
      const incomingMessageId = getIncomingMessageId(message);
      const row = incomingMessageId ? existingByMessageId.get(incomingMessageId) : undefined;
      const stored = buildStoredCanonicalMessage(
        message,
        incomingMessageId ? metadataById.get(incomingMessageId) : undefined,
        row
      );
      const patch: PartialModelObject<AgentMessage> = {
        role: message.role,
        parts: stored.parts as unknown as Record<string, unknown>[],
        uiMessage: null,
        clientMessageId: stored.clientMessageId,
        metadata: toJsonRecord(stored.metadata),
        runId: message.role === 'assistant' && options?.runId ? options.runId : row?.runId ?? null,
      };

      if (!row) {
        const inserted = await AgentMessage.query(options?.trx).insert({
          uuid: stored.uuid,
          threadId: thread.id,
          ...patch,
        });
        for (const messageId of getStoredMessageIds(inserted)) {
          existingByMessageId.set(messageId, inserted);
        }
        continue;
      }

      await AgentMessage.query(options?.trx).patchAndFetchById(row.id, patch);
    }
  }
}
