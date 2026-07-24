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
import {
  sanitizeAgentRunStreamChunks,
  scrubSecretsFromAgentRunStreamChunks,
  type AgentUiMessageChunk,
} from './streamChunks';
import { limitDurablePayloadRecord } from './payloadLimits';
import { resolveAgentSessionDurabilityConfig } from 'server/lib/agentSession/runtimeConfig';
import { AgentRunOwnershipLostError } from './AgentRunOwnershipLostError';
import { readString } from './runEventUtils';
import { PgNotificationListener, type PgListenKnexClient } from 'server/lib/pgNotificationListener';
import { toChunkEvents, chunkFromEvent, type ChunkEvent } from './runEventChunkCodec';
import type { Transaction } from 'objection';

// Replayed verbatim as tool input on approval-resume; truncation would execute the tool against a stub.
const RESUME_CRITICAL_EVENT_TYPES = new Set<string>(['tool.call.started']);

type RunEventAppendTarget = Pick<AgentRun, 'id'> & Partial<Pick<AgentRun, 'uuid'>>;

type RunEventAppendOptions = {
  executionOwner?: string;
  trx?: Transaction;
  lockRun?: boolean;
};

export const DEFAULT_RUN_EVENT_PAGE_LIMIT = 100;
export const MAX_RUN_EVENT_PAGE_LIMIT = 500;
export const RUN_EVENT_STREAM_PAGE_LIMIT = 100;
// Polling fallback when LISTEN/notify is unavailable; tight so short reasoning bursts still stream live.
// Marks a turn restarted from scratch; replay folds only events after the newest marker.
export const RUN_ATTEMPT_RESTARTED_EVENT_TYPE = 'attempt.restarted';
export const RUN_EVENT_STREAM_POLL_INTERVAL_MS = 250;
// Keepalive/status-recheck cadence, not event latency (LISTEN wakes the loop); under proxy idle-kill windows.
export const RUN_EVENT_STREAM_NOTIFY_WAIT_MS = 15_000;
const AGENT_RUN_EVENT_VERSION = 1;
const RUN_EVENT_NOTIFY_CHANNEL = 'agent_run_events';
const RUN_EVENT_TERMINAL_STATUSES = new Set<AgentRun['status']>(['transitioned', 'completed', 'failed', 'cancelled']);
const RUN_EVENT_TERMINAL_EVENT_TYPES = new Set(['run.transitioned', 'run.completed', 'run.failed', 'run.cancelled']);
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

type RunEventNotificationSubscriber = (notification: RunEventNotification) => void;

// Pinned to globalThis so subscriber state survives Next.js dev module re-eval.
type RunEventNotifyGlobal = typeof globalThis & {
  __lifecycleRunEventNotify?: {
    subscribers: Map<string, Set<RunEventNotificationSubscriber>>;
  };
};

function runEventNotifyState() {
  const globalScope = globalThis as RunEventNotifyGlobal;
  if (!globalScope.__lifecycleRunEventNotify) {
    globalScope.__lifecycleRunEventNotify = {
      subscribers: new Map(),
    };
  }
  return globalScope.__lifecycleRunEventNotify;
}

const runEventNotificationListener = new PgNotificationListener({
  channel: RUN_EVENT_NOTIFY_CHANNEL,
  getKnex: () => AgentRunEvent.knex() as unknown as PgListenKnexClient,
  onNotification: (payload) => {
    const parsed = parseRunEventNotification(payload);
    if (parsed) {
      notifySubscribers(parsed);
    }
  },
  logLabel: 'AgentExec run-events',
});

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

// SSE comment frame keeps idle connections warm so proxies/LBs don't idle-kill the stream.
const SSE_KEEPALIVE_FRAME = textEncoder.encode(': keepalive\n\n');

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
  const subscribers = runEventNotifyState().subscribers.get(notification.runId);
  if (!subscribers) {
    return;
  }

  for (const subscriber of [...subscribers]) {
    subscriber(notification);
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
    return runEventNotificationListener.ensureListening();
  }

  static async waitForRunEventNotification(
    runUuid: string,
    afterSequence: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (timeoutMs <= 0 || signal?.aborted) {
      return false;
    }

    try {
      await this.ensureNotificationListener();
    } catch {
      // LISTEN unavailable: short poll keeps event latency low.
      await sleep(Math.min(timeoutMs, RUN_EVENT_STREAM_POLL_INTERVAL_MS));
      return false;
    }

    return new Promise((resolve) => {
      let timeout: NodeJS.Timeout | null = null;
      const subscribers = runEventNotifyState().subscribers.get(runUuid) || new Set<RunEventNotificationSubscriber>();

      const cleanup = (notified: boolean) => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }

        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }

        subscribers.delete(subscriber);
        if (subscribers.size === 0) {
          runEventNotifyState().subscribers.delete(runUuid);
        }

        resolve(notified);
      };

      const onAbort = () => cleanup(false);

      const subscriber: RunEventNotificationSubscriber = (notification) => {
        if (notification.latestSequence > afterSequence) {
          cleanup(true);
        }
      };

      subscribers.add(subscriber);
      runEventNotifyState().subscribers.set(runUuid, subscribers);
      timeout = setTimeout(() => cleanup(false), timeoutMs);

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
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
    const pollIntervalMs = options.pollIntervalMs ?? RUN_EVENT_STREAM_NOTIFY_WAIT_MS;

    // `stopped` exits the loop on disconnect; the controller interrupts the notification wait.
    let stopped = false;
    const abortController = new AbortController();

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let cursor = normalizeRunEventAfterSequence(afterSequence);
        let sawTerminalEvent = false;

        // enqueue() throws after the consumer cancels; guard every write so a disconnect tears down cleanly.
        const safeEnqueue = (chunk: Uint8Array): boolean => {
          if (stopped) {
            return false;
          }
          try {
            controller.enqueue(chunk);
            return true;
          } catch {
            stopped = true;
            abortController.abort();
            return false;
          }
        };

        const drainAvailableEvents = async (): Promise<boolean> => {
          let hasMoreEvents = true;

          while (hasMoreEvents && !stopped) {
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
              if (!safeEnqueue(encodeCanonicalSseEvent(this.serializeRunEvent(event)))) {
                return false;
              }
            }

            cursor = page.nextSequence;
            hasMoreEvents = page.hasMore;
          }

          return !stopped;
        };

        try {
          let streamOpen = true;
          while (streamOpen && !stopped) {
            if (!(await drainAvailableEvents())) {
              break;
            }

            const currentRun = await AgentRun.query().findOne({ uuid: runUuid });
            if (!currentRun) {
              break;
            }

            if (!isRunEventStreamOpen(currentRun)) {
              // Terminal status: drain anything still pending, then close.
              if (!sawTerminalEvent) {
                if (!(await drainAvailableEvents())) {
                  break;
                }
              }

              // Self-heal: terminal status without a terminal event would poll forever; repair it.
              if (!sawTerminalEvent) {
                await this.ensureTerminalEventForTerminalRun(runUuid);
                await drainAvailableEvents();
              }

              break;
            }

            // Idle keep-alive: with no new events the connection would be idle-killed (~30-60s).
            if (!safeEnqueue(SSE_KEEPALIVE_FRAME)) {
              break;
            }

            await this.waitForRunEventNotification(runUuid, cursor, pollIntervalMs, abortController.signal);
          }
        } finally {
          stopped = true;
          if (!abortController.signal.aborted) {
            abortController.abort();
          }
          try {
            controller.close();
          } catch {
            // already closed/errored by the consumer
          }
        }
      },
      cancel: () => {
        stopped = true;
        abortController.abort();
      },
    });
  }

  /** Idempotently append the terminal run.* event for a terminal-status run missing it, so stranded streams recover. Returns true if appended. */
  private static async ensureTerminalEventForTerminalRun(runUuid: string): Promise<boolean> {
    let appendedSequence: number | null = null;
    await AgentRun.transaction(async (trx) => {
      const run = await AgentRun.query(trx).findOne({ uuid: runUuid }).forUpdate();
      if (!run || isRunEventStreamOpen(run)) {
        return;
      }

      const terminalEventType = `run.${run.status}`;
      if (!RUN_EVENT_TERMINAL_EVENT_TYPES.has(terminalEventType)) {
        return;
      }

      const existing = await AgentRunEvent.query(trx).where({ runId: run.id, eventType: terminalEventType }).first();
      if (existing) {
        return;
      }

      const runWithError = run as AgentRun & { error?: unknown; usageSummary?: unknown };
      appendedSequence = await this.appendStatusEventForRunInTransaction(
        run,
        terminalEventType,
        {
          status: run.status,
          error: runWithError.error || null,
          usageSummary: runWithError.usageSummary || {},
          transition: run.transition || null,
          repaired: true,
        },
        trx
      );
    });

    if (appendedSequence) {
      await this.notifyRunEventsInserted(runUuid, appendedSequence);
      return true;
    }
    return false;
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
          lockedRun as unknown as Pick<AgentRun, 'status' | 'executionOwner'>
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
          payload: RESUME_CRITICAL_EVENT_TYPES.has(event.eventType)
            ? event.payload
            : limitDurablePayloadRecord(event.payload, durability),
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

    // SECURITY: redact credentials from reasoning before it hits the events table / live stream.
    for (const chunk of scrubSecretsFromAgentRunStreamChunks(chunks)) {
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

    // SECURITY: redact credentials from reasoning before it hits the events table / live stream.
    for (const chunk of scrubSecretsFromAgentRunStreamChunks(chunks)) {
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
    // SECURITY: redact credentials from reasoning before it hits the events table / live stream.
    for (const chunk of scrubSecretsFromAgentRunStreamChunks(chunks)) {
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
