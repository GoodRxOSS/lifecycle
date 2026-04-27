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

import AgentRun from 'server/models/AgentRun';
import AgentRunEvent from 'server/models/AgentRunEvent';
import { getLogger } from 'server/lib/logger';
import { sanitizeAgentRunStreamChunks, type AgentUiMessageChunk } from './streamChunks';
import { limitDurablePayloadRecord } from './payloadLimits';
import { resolveAgentSessionDurabilityConfig } from 'server/lib/agentSession/runtimeConfig';
import { AgentRunOwnershipLostError } from './AgentRunOwnershipLostError';
import type { Transaction } from 'objection';

type ChunkEvent = {
  eventType: string;
  payload: Record<string, unknown>;
};

type RunEventAppendTarget = Pick<AgentRun, 'id'> & Partial<Pick<AgentRun, 'uuid'>>;

type RunEventAppendOptions = {
  executionOwner?: string;
  trx?: Transaction;
  lockRun?: boolean;
};

export const DEFAULT_RUN_EVENT_PAGE_LIMIT = 100;
export const MAX_RUN_EVENT_PAGE_LIMIT = 500;
export const RUN_EVENT_STREAM_PAGE_LIMIT = 100;
export const RUN_EVENT_STREAM_POLL_INTERVAL_MS = 2000;
const AGENT_RUN_EVENT_VERSION = 1;
const RUN_EVENT_NOTIFY_CHANNEL = 'agent_run_events';
const RUN_EVENT_TERMINAL_STATUSES = new Set<AgentRun['status']>(['completed', 'failed', 'cancelled']);
const RUN_EVENT_TERMINAL_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const textEncoder = new TextEncoder();

type RunEventPageOptions = {
  afterSequence?: number;
  limit?: number;
};

type RunEventPageRun = Pick<AgentRun, 'id' | 'uuid' | 'threadId' | 'sessionId' | 'status'> & {
  threadUuid?: string;
  sessionUuid?: string;
};

type RunEventPage = {
  events: AgentRunEvent[];
  nextSequence: number;
  hasMore: boolean;
  run: {
    id: string;
    status: AgentRun['status'];
  };
  limit: number;
  maxLimit: number;
};

type RunEventNotification = {
  runId: string;
  latestSequence: number;
};

type SerializedRunEvent = {
  id: string;
  runId: string;
  threadId: string;
  sessionId: string;
  sequence: number;
  eventType: string;
  version: number;
  payload: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

type PgListenConnection = {
  on(event: 'notification', listener: (notification: { channel?: string; payload?: string }) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  query(sql: string): Promise<unknown>;
};

type RunEventNotificationSubscriber = (notification: RunEventNotification) => void;

const notificationSubscribers = new Map<string, Set<RunEventNotificationSubscriber>>();
let notificationConnection: PgListenConnection | null = null;
let notificationListenPromise: Promise<void> | null = null;

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRunEventStreamOpen(run: Pick<AgentRun, 'status'>): boolean {
  return !RUN_EVENT_TERMINAL_STATUSES.has(run.status);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function encodeCanonicalSseEvent(event: SerializedRunEvent): Uint8Array {
  return textEncoder.encode(
    [`id: ${event.sequence}`, `event: ${event.eventType}`, `data: ${JSON.stringify(event)}`, ''].join('\n') + '\n'
  );
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};

  for (const key of keys) {
    if (source[key] !== undefined) {
      picked[key] = cloneValue(source[key]);
    }
  }

  return picked;
}

function compactChunk(fields: Record<string, unknown>): AgentUiMessageChunk {
  const chunk: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      chunk[key] = value;
    }
  }

  return chunk as AgentUiMessageChunk;
}

function parseRunEventNotification(payload: string | undefined): RunEventNotification | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const runId = readString(parsed.runId);
    const latestSequence = typeof parsed.latestSequence === 'number' ? parsed.latestSequence : null;
    if (!runId || latestSequence == null) {
      return null;
    }

    return {
      runId,
      latestSequence,
    };
  } catch (error) {
    getLogger().warn({ error }, 'AgentExec: ignored invalid run-event notification');
    return null;
  }
}

function notifySubscribers(notification: RunEventNotification): void {
  const subscribers = notificationSubscribers.get(notification.runId);
  if (!subscribers) {
    return;
  }

  for (const subscriber of [...subscribers]) {
    subscriber(notification);
  }
}

function clearNotificationConnection(): void {
  notificationConnection = null;
  notificationListenPromise = null;
}

function handleNotification(notification: { channel?: string; payload?: string }): void {
  if (notification.channel !== RUN_EVENT_NOTIFY_CHANNEL) {
    return;
  }

  const parsed = parseRunEventNotification(notification.payload);
  if (parsed) {
    notifySubscribers(parsed);
  }
}

function handleNotificationError(error: unknown): void {
  getLogger().warn({ error }, 'AgentExec: run-event notification listener failed');
  clearNotificationConnection();
}

function toChunkEvents(chunk: AgentUiMessageChunk): ChunkEvent[] {
  const chunkRecord = chunk as unknown as Record<string, unknown>;

  switch (chunk.type) {
    case 'start':
      return [
        {
          eventType: 'message.created',
          payload: {
            messageId: chunk.messageId,
            metadata: chunk.messageMetadata || {},
          },
        },
      ];
    case 'message-metadata':
      return [
        {
          eventType: 'message.metadata',
          payload: {
            metadata: cloneValue(chunk.messageMetadata || {}),
          },
        },
      ];
    case 'text-start':
      return [
        {
          eventType: 'message.part.started',
          payload: {
            partType: 'text',
            partId: chunk.id,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'text-delta':
      return [
        {
          eventType: 'message.delta',
          payload: {
            partType: 'text',
            partId: chunk.id,
            delta: chunk.delta,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'text-end':
      return [
        {
          eventType: 'message.part.completed',
          payload: {
            partType: 'text',
            partId: chunk.id,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'reasoning-start':
      return [
        {
          eventType: 'message.part.started',
          payload: {
            partType: 'reasoning',
            partId: chunk.id,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'reasoning-delta':
      return [
        {
          eventType: 'message.delta',
          payload: {
            partType: 'reasoning',
            partId: chunk.id,
            delta: chunk.delta,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'reasoning-end':
      return [
        {
          eventType: 'message.part.completed',
          payload: {
            partType: 'reasoning',
            partId: chunk.id,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'tool-input-start':
      return [
        {
          eventType: 'tool.call.input.started',
          payload: {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            ...pickDefined(chunkRecord, ['providerExecuted', 'providerMetadata', 'dynamic', 'title']),
          },
        },
      ];
    case 'tool-input-delta':
      return [
        {
          eventType: 'tool.call.input.delta',
          payload: {
            toolCallId: chunk.toolCallId,
            inputTextDelta: chunk.inputTextDelta,
          },
        },
      ];
    case 'tool-input-available':
    case 'tool-input-error':
      return [
        {
          eventType: 'tool.call.started',
          payload: {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            inputStatus: chunk.type === 'tool-input-error' ? 'error' : 'available',
            input: 'input' in chunk ? chunk.input : null,
            errorText: 'errorText' in chunk ? chunk.errorText : null,
            ...pickDefined(chunkRecord, ['providerExecuted', 'providerMetadata', 'dynamic', 'title']),
          },
        },
      ];
    case 'tool-output-available':
    case 'tool-output-error':
    case 'tool-output-denied':
      return [
        {
          eventType: 'tool.call.completed',
          payload: {
            toolCallId: chunk.toolCallId,
            output: 'output' in chunk ? chunk.output : null,
            errorText: 'errorText' in chunk ? chunk.errorText : null,
            status:
              chunk.type === 'tool-output-available'
                ? 'completed'
                : chunk.type === 'tool-output-denied'
                ? 'denied'
                : 'failed',
            ...pickDefined(chunkRecord, ['providerExecuted', 'providerMetadata', 'dynamic', 'preliminary']),
          },
        },
      ];
    case 'tool-approval-request':
      return [
        {
          eventType: 'approval.requested',
          payload: {
            ...pickDefined(chunkRecord, ['actionId']),
            approvalId: chunk.approvalId,
            toolCallId: chunk.toolCallId,
          },
        },
      ];
    case 'data-file-change':
      return [
        {
          eventType: 'tool.file_change',
          payload: {
            id: chunk.id,
            data: cloneValue(chunk.data),
            transient: chunk.transient,
          },
        },
      ];
    case 'source-url':
      return [
        {
          eventType: 'message.source',
          payload: {
            sourceType: 'url',
            sourceId: chunk.sourceId,
            url: chunk.url,
            ...pickDefined(chunkRecord, ['title', 'providerMetadata']),
          },
        },
      ];
    case 'source-document':
      return [
        {
          eventType: 'message.source',
          payload: {
            sourceType: 'document',
            sourceId: chunk.sourceId,
            mediaType: chunk.mediaType,
            title: chunk.title,
            ...pickDefined(chunkRecord, ['filename', 'providerMetadata']),
          },
        },
      ];
    case 'file':
      return [
        {
          eventType: 'message.file',
          payload: {
            url: chunk.url,
            mediaType: chunk.mediaType,
            ...pickDefined(chunkRecord, ['providerMetadata']),
          },
        },
      ];
    case 'start-step':
      return [
        {
          eventType: 'run.step.started',
          payload: {},
        },
      ];
    case 'finish-step':
      return [
        {
          eventType: 'run.step.completed',
          payload: {},
        },
      ];
    case 'finish':
      return [
        {
          eventType: 'run.finished',
          payload: {
            finishReason: chunk.finishReason,
            metadata: chunk.messageMetadata || {},
          },
        },
      ];
    case 'abort':
      return [
        {
          eventType: 'run.aborted',
          payload: {
            reason: chunk.reason,
          },
        },
      ];
    case 'error':
      return [
        {
          eventType: 'run.error',
          payload: {
            errorText: chunk.errorText,
          },
        },
      ];
  }

  return [];
}

function chunkFromMessagePartEvent(eventType: string, payload: Record<string, unknown>): AgentUiMessageChunk | null {
  const partType = readString(payload.partType);
  const partId = readString(payload.partId) || readString(payload.messageId);
  if ((partType !== 'text' && partType !== 'reasoning') || !partId) {
    return null;
  }

  const providerMetadata = payload.providerMetadata;

  if (eventType === 'message.part.started') {
    return compactChunk({
      type: partType === 'text' ? 'text-start' : 'reasoning-start',
      id: partId,
      providerMetadata,
    });
  }

  if (eventType === 'message.delta') {
    return compactChunk({
      type: partType === 'text' ? 'text-delta' : 'reasoning-delta',
      id: partId,
      delta: readString(payload.delta) || '',
      providerMetadata,
    });
  }

  if (eventType === 'message.part.completed') {
    return compactChunk({
      type: partType === 'text' ? 'text-end' : 'reasoning-end',
      id: partId,
      providerMetadata,
    });
  }

  return null;
}

function chunkFromToolStartedEvent(payload: Record<string, unknown>): AgentUiMessageChunk | null {
  const toolCallId = readString(payload.toolCallId);
  const toolName = readString(payload.toolName);
  if (!toolCallId || !toolName) {
    return null;
  }

  const inputStatus = readString(payload.inputStatus);
  return compactChunk({
    type: inputStatus === 'error' ? 'tool-input-error' : 'tool-input-available',
    toolCallId,
    toolName,
    input: payload.input,
    errorText: inputStatus === 'error' ? readString(payload.errorText) || 'Tool input failed.' : undefined,
    providerExecuted: readBoolean(payload.providerExecuted),
    providerMetadata: payload.providerMetadata,
    dynamic: readBoolean(payload.dynamic),
    title: readString(payload.title),
  });
}

function chunkFromToolCompletedEvent(payload: Record<string, unknown>): AgentUiMessageChunk | null {
  const toolCallId = readString(payload.toolCallId);
  if (!toolCallId) {
    return null;
  }

  const status = readString(payload.status);
  if (status === 'denied') {
    return compactChunk({
      type: 'tool-output-denied',
      toolCallId,
    });
  }

  if (status === 'failed') {
    return compactChunk({
      type: 'tool-output-error',
      toolCallId,
      errorText: readString(payload.errorText) || 'Tool execution failed.',
      providerExecuted: readBoolean(payload.providerExecuted),
      providerMetadata: payload.providerMetadata,
      dynamic: readBoolean(payload.dynamic),
    });
  }

  return compactChunk({
    type: 'tool-output-available',
    toolCallId,
    output: payload.output,
    providerExecuted: readBoolean(payload.providerExecuted),
    providerMetadata: payload.providerMetadata,
    dynamic: readBoolean(payload.dynamic),
    preliminary: readBoolean(payload.preliminary),
  });
}

function chunkFromEvent(event: AgentRunEvent): AgentUiMessageChunk | null {
  const payload = asRecord(event.payload);

  switch (event.eventType) {
    case 'message.created':
      return compactChunk({
        type: 'start',
        messageId: readString(payload.messageId),
        messageMetadata: payload.metadata,
      });
    case 'message.metadata':
      return compactChunk({
        type: 'message-metadata',
        messageMetadata: payload.metadata || {},
      });
    case 'message.part.started':
    case 'message.delta':
    case 'message.part.completed':
      return chunkFromMessagePartEvent(event.eventType, payload);
    case 'tool.call.input.started': {
      const toolCallId = readString(payload.toolCallId);
      const toolName = readString(payload.toolName);
      if (!toolCallId || !toolName) {
        return null;
      }

      return compactChunk({
        type: 'tool-input-start',
        toolCallId,
        toolName,
        providerExecuted: readBoolean(payload.providerExecuted),
        providerMetadata: payload.providerMetadata,
        dynamic: readBoolean(payload.dynamic),
        title: readString(payload.title),
      });
    }
    case 'tool.call.input.delta': {
      const toolCallId = readString(payload.toolCallId);
      if (!toolCallId) {
        return null;
      }

      return compactChunk({
        type: 'tool-input-delta',
        toolCallId,
        inputTextDelta: readString(payload.inputTextDelta) || '',
      });
    }
    case 'tool.call.started':
      return chunkFromToolStartedEvent(payload);
    case 'tool.call.completed':
      return chunkFromToolCompletedEvent(payload);
    case 'approval.requested': {
      const approvalId = readString(payload.approvalId);
      const toolCallId = readString(payload.toolCallId);
      if (!approvalId || !toolCallId) {
        return null;
      }

      return compactChunk({
        type: 'tool-approval-request',
        actionId: readString(payload.actionId),
        approvalId,
        toolCallId,
      });
    }
    case 'tool.file_change':
      if (!payload.data) {
        return null;
      }

      return compactChunk({
        type: 'data-file-change',
        id: readString(payload.id),
        data: payload.data,
        transient: readBoolean(payload.transient),
      });
    case 'message.source':
      if (payload.sourceType === 'url') {
        const sourceId = readString(payload.sourceId);
        const url = readString(payload.url);
        if (!sourceId || !url) {
          return null;
        }

        return compactChunk({
          type: 'source-url',
          sourceId,
          url,
          title: readString(payload.title),
          providerMetadata: payload.providerMetadata,
        });
      }

      if (payload.sourceType === 'document') {
        const sourceId = readString(payload.sourceId);
        const mediaType = readString(payload.mediaType);
        const title = readString(payload.title);
        if (!sourceId || !mediaType || !title) {
          return null;
        }

        return compactChunk({
          type: 'source-document',
          sourceId,
          mediaType,
          title,
          filename: readString(payload.filename),
          providerMetadata: payload.providerMetadata,
        });
      }

      return null;
    case 'message.file': {
      const url = readString(payload.url);
      const mediaType = readString(payload.mediaType);
      if (!url || !mediaType) {
        return null;
      }

      return compactChunk({
        type: 'file',
        url,
        mediaType,
        providerMetadata: payload.providerMetadata,
      });
    }
    case 'run.step.started':
      return compactChunk({ type: 'start-step' });
    case 'run.step.completed':
      return compactChunk({ type: 'finish-step' });
    case 'run.finished':
      return compactChunk({
        type: 'finish',
        finishReason: readString(payload.finishReason),
        messageMetadata: payload.metadata,
      });
    case 'run.aborted':
      return compactChunk({
        type: 'abort',
        reason: readString(payload.reason),
      });
    case 'run.error':
      return compactChunk({
        type: 'error',
        errorText: readString(payload.errorText) || 'Agent run failed.',
      });
    case 'run.failed': {
      const error = asRecord(payload.error);
      return compactChunk({
        type: 'error',
        errorText: readString(error.message) || readString(payload.errorText) || 'Agent run failed.',
      });
    }
    default:
      return null;
  }
}

export function normalizeRunEventPageLimit(limit?: number | null): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_RUN_EVENT_PAGE_LIMIT;
  }

  return Math.min(Math.max(Math.floor(limit as number), 1), MAX_RUN_EVENT_PAGE_LIMIT);
}

function normalizeRunEventAfterSequence(afterSequence?: number | null): number {
  if (!Number.isFinite(afterSequence)) {
    return 0;
  }

  return Math.max(Math.floor(afterSequence as number), 0);
}

export default class AgentRunEventService {
  private static async ensureNotificationListener(): Promise<void> {
    if (notificationConnection) {
      return;
    }

    if (notificationListenPromise) {
      return notificationListenPromise;
    }

    notificationListenPromise = (async () => {
      const knex = AgentRunEvent.knex() as unknown as {
        client: {
          acquireConnection(): Promise<PgListenConnection>;
          releaseConnection(connection: PgListenConnection): Promise<void>;
        };
      };
      const connection = await knex.client.acquireConnection();

      try {
        connection.on('notification', handleNotification);
        connection.on('error', handleNotificationError);
        await connection.query(`LISTEN ${RUN_EVENT_NOTIFY_CHANNEL}`);
        notificationConnection = connection;
      } catch (error) {
        await knex.client.releaseConnection(connection);
        throw error;
      }
    })()
      .catch((error) => {
        clearNotificationConnection();
        getLogger().warn({ error }, 'AgentExec: run-event notification listener unavailable');
        throw error;
      })
      .finally(() => {
        notificationListenPromise = null;
      });

    return notificationListenPromise;
  }

  static async waitForRunEventNotification(
    runUuid: string,
    afterSequence: number,
    timeoutMs: number
  ): Promise<boolean> {
    if (timeoutMs <= 0) {
      return false;
    }

    try {
      await this.ensureNotificationListener();
    } catch {
      await sleep(timeoutMs);
      return false;
    }

    return new Promise((resolve) => {
      let timeout: NodeJS.Timeout | null = null;
      const subscribers = notificationSubscribers.get(runUuid) || new Set<RunEventNotificationSubscriber>();

      const cleanup = (notified: boolean) => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }

        subscribers.delete(subscriber);
        if (subscribers.size === 0) {
          notificationSubscribers.delete(runUuid);
        }

        resolve(notified);
      };

      const subscriber: RunEventNotificationSubscriber = (notification) => {
        if (notification.latestSequence > afterSequence) {
          cleanup(true);
        }
      };

      subscribers.add(subscriber);
      notificationSubscribers.set(runUuid, subscribers);
      timeout = setTimeout(() => cleanup(false), timeoutMs);
    });
  }

  static async notifyRunEventsInserted(runUuid: string, latestSequence: number): Promise<void> {
    try {
      await AgentRunEvent.knex().raw('select pg_notify(?, ?)', [
        RUN_EVENT_NOTIFY_CHANNEL,
        JSON.stringify({
          runId: runUuid,
          latestSequence,
        }),
      ]);
    } catch (error) {
      getLogger().warn({ error, runUuid, latestSequence }, `AgentExec: run-event notify failed runId=${runUuid}`);
    }
  }

  static async listRunEventsPageForRun(run: RunEventPageRun, options: RunEventPageOptions = {}): Promise<RunEventPage> {
    const limit = normalizeRunEventPageLimit(options.limit);
    const afterSequence = normalizeRunEventAfterSequence(options.afterSequence);
    const threadUuid = run.threadUuid || String(run.threadId);
    const sessionUuid = run.sessionUuid || String(run.sessionId);
    const rows = await AgentRunEvent.query()
      .where({ runId: run.id })
      .where('sequence', '>', afterSequence)
      .orderBy('sequence', 'asc')
      .orderBy('id', 'asc')
      .limit(limit + 1);
    const events = rows
      .slice(0, limit)
      .map((event) => Object.assign(event, { runUuid: run.uuid, threadUuid, sessionUuid }));
    const lastEvent = events[events.length - 1];

    return {
      events,
      nextSequence: lastEvent?.sequence || afterSequence,
      hasMore: rows.length > limit,
      run: {
        id: run.uuid,
        status: run.status,
      },
      limit,
      maxLimit: MAX_RUN_EVENT_PAGE_LIMIT,
    };
  }

  static async listRunEventsPage(runUuid: string, options: RunEventPageOptions = {}): Promise<RunEventPage | null> {
    const run = await AgentRun.query()
      .alias('run')
      .joinRelated('[thread, session]')
      .where('run.uuid', runUuid)
      .select('run.*', 'thread.uuid as threadUuid', 'session.uuid as sessionUuid')
      .first();
    if (!run) {
      return null;
    }

    return this.listRunEventsPageForRun(run, options);
  }

  static createCanonicalRunEventStream(
    runUuid: string,
    afterSequence: number,
    options: {
      pageLimit?: number;
      pollIntervalMs?: number;
    } = {}
  ): ReadableStream<Uint8Array> {
    const pageLimit = normalizeRunEventPageLimit(options.pageLimit ?? RUN_EVENT_STREAM_PAGE_LIMIT);
    const pollIntervalMs = options.pollIntervalMs ?? RUN_EVENT_STREAM_POLL_INTERVAL_MS;

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let cursor = normalizeRunEventAfterSequence(afterSequence);
        let sawTerminalEvent = false;

        const drainAvailableEvents = async (): Promise<boolean> => {
          let hasMoreEvents = true;

          while (hasMoreEvents) {
            const page = await this.listRunEventsPage(runUuid, {
              afterSequence: cursor,
              limit: pageLimit,
            });
            if (!page) {
              return false;
            }

            for (const event of page.events) {
              if (RUN_EVENT_TERMINAL_EVENT_TYPES.has(event.eventType)) {
                sawTerminalEvent = true;
              }
              controller.enqueue(encodeCanonicalSseEvent(this.serializeRunEvent(event)));
            }

            cursor = page.nextSequence;
            hasMoreEvents = page.hasMore;
          }

          return true;
        };

        let streamOpen = true;
        while (streamOpen) {
          if (!(await drainAvailableEvents())) {
            controller.close();
            return;
          }

          const currentRun = await AgentRun.query().findOne({ uuid: runUuid });
          if (!currentRun) {
            controller.close();
            return;
          }

          if (!isRunEventStreamOpen(currentRun)) {
            if (sawTerminalEvent) {
              streamOpen = false;
              controller.close();
              return;
            }

            if (!(await drainAvailableEvents())) {
              controller.close();
              return;
            }

            if (sawTerminalEvent) {
              streamOpen = false;
              controller.close();
              return;
            }

            if (!sawTerminalEvent) {
              await this.waitForRunEventNotification(runUuid, cursor, pollIntervalMs);
              continue;
            }
          }

          await this.waitForRunEventNotification(runUuid, cursor, pollIntervalMs);
        }
      },
    });
  }

  private static requireExecutionOwner(
    runUuid: string,
    expectedExecutionOwner: string,
    run: Pick<AgentRun, 'status' | 'executionOwner'>
  ): void {
    if (run.executionOwner !== expectedExecutionOwner || RUN_EVENT_TERMINAL_STATUSES.has(run.status)) {
      throw new AgentRunOwnershipLostError({
        runUuid,
        expectedExecutionOwner,
        currentStatus: run.status,
        currentExecutionOwner: run.executionOwner,
      });
    }
  }

  private static async appendEventsForRun(
    run: RunEventAppendTarget,
    events: ChunkEvent[],
    options: RunEventAppendOptions = {}
  ): Promise<number | null> {
    if (events.length === 0) {
      return null;
    }

    const durability = await resolveAgentSessionDurabilityConfig();
    const append = async (trx: Transaction): Promise<number | null> => {
      const lockedRun = options.lockRun === false ? run : await AgentRun.query(trx).findById(run.id).forUpdate();
      if (!lockedRun) {
        return null;
      }
      if (options.executionOwner) {
        this.requireExecutionOwner(
          lockedRun.uuid || String(run.id),
          options.executionOwner,
          lockedRun as Pick<AgentRun, 'status' | 'executionOwner'>
        );
      }

      const latest = await AgentRunEvent.query(trx).where({ runId: run.id }).orderBy('sequence', 'desc').first();
      let sequence = latest?.sequence || 0;
      const rows = events.map((event) => {
        sequence += 1;
        return {
          runId: run.id,
          sequence,
          eventType: event.eventType,
          payload: limitDurablePayloadRecord(event.payload, durability),
        } as Partial<AgentRunEvent>;
      });

      await AgentRunEvent.query(trx).insert(rows);
      return sequence;
    };

    return options.trx ? append(options.trx) : AgentRun.transaction(append);
  }

  static async appendEvent(runId: number, eventType: string, payload: Record<string, unknown>): Promise<number> {
    const sequence = await this.appendEventsForRun(
      {
        id: runId,
      },
      [
        {
          eventType,
          payload,
        },
      ]
    );

    if (!sequence) {
      throw new Error('Agent run not found');
    }

    return sequence;
  }

  static async appendStatusEvent(runUuid: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    const run = await AgentRun.query().findOne({ uuid: runUuid });
    if (!run) {
      return;
    }

    const sequence = await this.appendEvent(run.id, eventType, payload);
    await this.notifyRunEventsInserted(run.uuid, sequence);
  }

  static async appendStatusEventForRunInTransaction(
    run: RunEventAppendTarget,
    eventType: string,
    payload: Record<string, unknown>,
    trx: Transaction
  ): Promise<number | null> {
    return this.appendEventsForRun(
      run,
      [
        {
          eventType,
          payload,
        },
      ],
      { trx, lockRun: false }
    );
  }

  static async appendEventsForChunks(runUuid: string, chunks: AgentUiMessageChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const run = await AgentRun.query().findOne({ uuid: runUuid });
    if (!run) {
      return;
    }

    const events: ChunkEvent[] = [];

    for (const chunk of chunks) {
      for (const event of toChunkEvents(chunk)) {
        events.push(event);
      }
    }

    const sequence = await this.appendEventsForRun(run, events);
    if (sequence) {
      await this.notifyRunEventsInserted(run.uuid, sequence);
    }
  }

  static async appendEventsForChunksForExecutionOwner(
    runUuid: string,
    executionOwner: string,
    chunks: AgentUiMessageChunk[]
  ): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const run = await AgentRun.query().findOne({ uuid: runUuid });
    if (!run) {
      return;
    }

    const events: ChunkEvent[] = [];

    for (const chunk of chunks) {
      for (const event of toChunkEvents(chunk)) {
        events.push(event);
      }
    }

    const sequence = await this.appendEventsForRun(run, events, { executionOwner });
    if (sequence) {
      await this.notifyRunEventsInserted(run.uuid, sequence);
    }
  }

  static async appendChunkEventsForRunInTransaction(
    run: RunEventAppendTarget,
    chunks: AgentUiMessageChunk[],
    trx: Transaction
  ): Promise<number | null> {
    if (chunks.length === 0) {
      return null;
    }

    const events: ChunkEvent[] = [];
    for (const chunk of chunks) {
      for (const event of toChunkEvents(chunk)) {
        events.push(event);
      }
    }

    return this.appendEventsForRun(run, events, { trx, lockRun: false });
  }

  static projectUiChunksFromEvents(events: AgentRunEvent[]): AgentUiMessageChunk[] {
    const chunks = events.flatMap((event) => {
      const chunk = chunkFromEvent(event);
      return chunk ? [chunk] : [];
    });

    return sanitizeAgentRunStreamChunks(chunks);
  }

  static serializeRunEvent(event: AgentRunEvent): SerializedRunEvent {
    const enrichedEvent = event as AgentRunEvent & {
      runUuid?: string;
      threadUuid?: string;
      sessionUuid?: string;
      threadId?: number;
      sessionId?: number;
    };

    return {
      id: event.uuid,
      runId: enrichedEvent.runUuid || String(event.runId),
      threadId: enrichedEvent.threadUuid || String(enrichedEvent.threadId),
      sessionId: enrichedEvent.sessionUuid || String(enrichedEvent.sessionId),
      sequence: event.sequence,
      eventType: event.eventType,
      version: AGENT_RUN_EVENT_VERSION,
      payload: event.payload || {},
      createdAt: event.createdAt || null,
      updatedAt: event.updatedAt || null,
    };
  }
}
