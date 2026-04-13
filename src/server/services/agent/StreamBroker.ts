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

import type { UIMessageChunk } from 'ai';
import { getLogger } from 'server/lib/logger';
import AgentRunService from './RunService';

type BrokerEntry = {
  history: UIMessageChunk[];
  subscribers: Set<ReadableStreamDefaultController<UIMessageChunk>>;
  active: boolean;
  cleanupTimer?: NodeJS.Timeout;
  persistTimer?: NodeJS.Timeout;
  pendingPersistChunks: UIMessageChunk[];
  persistPromise: Promise<void>;
};

const STREAM_TTL_MS = 5 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 200;

function cloneChunk<T>(chunk: T): T {
  return JSON.parse(JSON.stringify(chunk)) as T;
}

export default class AgentStreamBroker {
  private static entries = new Map<string, BrokerEntry>();

  static attach(runUuid: string, stream: ReadableStream<UIMessageChunk>): void {
    const existing = this.entries.get(runUuid);
    if (existing?.active) {
      return;
    }

    if (existing?.cleanupTimer) {
      clearTimeout(existing.cleanupTimer);
    }

    const entry: BrokerEntry = existing || {
      history: [],
      subscribers: new Set(),
      active: true,
      pendingPersistChunks: [],
      persistPromise: Promise.resolve(),
    };

    entry.active = true;
    entry.cleanupTimer = undefined;
    this.entries.set(runUuid, entry);

    void this.consume(runUuid, stream, entry);
  }

  static open(runUuid: string): ReadableStream<UIMessageChunk> | null {
    const entry = this.entries.get(runUuid);
    if (!entry) {
      return null;
    }

    let controllerRef: ReadableStreamDefaultController<UIMessageChunk> | null = null;

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        controllerRef = controller;

        for (const chunk of entry.history) {
          controller.enqueue(cloneChunk(chunk));
        }

        if (entry.active) {
          entry.subscribers.add(controller);
        } else {
          controller.close();
        }
      },
      cancel: () => {
        if (controllerRef) {
          entry.subscribers.delete(controllerRef);
        }
      },
    });
  }

  private static async consume(
    runUuid: string,
    stream: ReadableStream<UIMessageChunk>,
    entry: BrokerEntry
  ): Promise<void> {
    const reader = stream.getReader();

    try {
      let streamDone = false;

      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) {
          streamDone = true;
          continue;
        }

        if (value === undefined) {
          continue;
        }

        const clonedChunk = cloneChunk(value);
        entry.history.push(clonedChunk);
        this.queuePersist(runUuid, entry, clonedChunk);

        for (const subscriber of [...entry.subscribers]) {
          try {
            subscriber.enqueue(cloneChunk(clonedChunk));
          } catch (error) {
            entry.subscribers.delete(subscriber);
            getLogger().debug({ error, runUuid }, `AgentExec: stream subscriber dropped runId=${runUuid}`);
          }
        }
      }

      await this.flushPersistedChunks(runUuid, entry);
      this.finish(runUuid, entry);
    } catch (error) {
      getLogger().warn({ error, runUuid }, `AgentExec: stream broker failed runId=${runUuid}`);

      await this.flushPersistedChunks(runUuid, entry);
      for (const subscriber of [...entry.subscribers]) {
        try {
          subscriber.error(error);
        } catch {
          // Ignore subscriber shutdown failures.
        }
      }

      this.finish(runUuid, entry);
    } finally {
      reader.releaseLock();
    }
  }

  private static queuePersist(runUuid: string, entry: BrokerEntry, chunk: UIMessageChunk): void {
    entry.pendingPersistChunks.push(cloneChunk(chunk));
    if (entry.persistTimer) {
      return;
    }

    entry.persistTimer = setTimeout(() => {
      entry.persistTimer = undefined;
      void this.flushPersistedChunks(runUuid, entry);
    }, PERSIST_DEBOUNCE_MS);
  }

  private static async flushPersistedChunks(runUuid: string, entry: BrokerEntry): Promise<void> {
    if (entry.persistTimer) {
      clearTimeout(entry.persistTimer);
      entry.persistTimer = undefined;
    }

    if (entry.pendingPersistChunks.length === 0) {
      return;
    }

    const chunks = entry.pendingPersistChunks.splice(0, entry.pendingPersistChunks.length);
    entry.persistPromise = entry.persistPromise
      .catch(() => undefined)
      .then(() => AgentRunService.appendStreamChunks(runUuid, chunks))
      .then(() => undefined)
      .catch((error) => {
        getLogger().warn({ error, runUuid }, `AgentExec: stream persist failed runId=${runUuid}`);
      });

    await entry.persistPromise;
  }

  private static finish(runUuid: string, entry: BrokerEntry): void {
    entry.active = false;
    if (entry.persistTimer) {
      clearTimeout(entry.persistTimer);
      entry.persistTimer = undefined;
    }

    for (const subscriber of [...entry.subscribers]) {
      try {
        subscriber.close();
      } catch {
        // Ignore subscriber shutdown failures.
      }
    }

    entry.subscribers.clear();
    entry.cleanupTimer = setTimeout(() => {
      this.entries.delete(runUuid);
    }, STREAM_TTL_MS);
  }
}
