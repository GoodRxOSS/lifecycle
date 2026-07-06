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

import { getLogger } from 'server/lib/logger';

export type PgListenConnection = {
  on(event: 'notification', listener: (notification: { channel?: string; payload?: string }) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
  query(sql: string): Promise<unknown>;
};

export type PgListenKnexClient = {
  client: {
    acquireConnection(): Promise<PgListenConnection>;
    releaseConnection(connection: PgListenConnection): Promise<void>;
  };
};

type ListenerState = {
  connection: PgListenConnection | null;
  listenPromise: Promise<void> | null;
  handlers: {
    notification: (notification: { channel?: string; payload?: string }) => void;
    error: (error: unknown) => void;
  } | null;
};

// Pinned to globalThis so LISTEN state survives Next.js dev module re-eval.
type PgListenGlobal = typeof globalThis & {
  __lifecyclePgNotificationListeners?: Map<string, ListenerState>;
};

function listenerState(channel: string): ListenerState {
  const globalScope = globalThis as PgListenGlobal;
  if (!globalScope.__lifecyclePgNotificationListeners) {
    globalScope.__lifecyclePgNotificationListeners = new Map();
  }
  let state = globalScope.__lifecyclePgNotificationListeners.get(channel);
  if (!state) {
    state = { connection: null, listenPromise: null, handlers: null };
    globalScope.__lifecyclePgNotificationListeners.set(channel, state);
  }
  return state;
}

const CHANNEL_REGEX = /^[a-z_][a-z0-9_]*$/;

/** One shared LISTEN connection per channel; errors RELEASE the pool slot, and the next ensureListening re-acquires. */
export class PgNotificationListener {
  constructor(
    private readonly options: {
      channel: string;
      getKnex: () => PgListenKnexClient;
      onNotification: (payload: string | undefined) => void;
      logLabel: string;
    }
  ) {
    if (!CHANNEL_REGEX.test(options.channel)) {
      throw new Error(`Invalid pg notification channel '${options.channel}'`);
    }
  }

  async ensureListening(): Promise<void> {
    const state = listenerState(this.options.channel);
    if (state.connection) {
      return;
    }
    if (state.listenPromise) {
      return state.listenPromise;
    }

    state.listenPromise = (async () => {
      const knex = this.options.getKnex();
      const connection = await knex.client.acquireConnection();
      const handlers = {
        notification: (notification: { channel?: string; payload?: string }) => {
          if (notification.channel === this.options.channel) {
            this.options.onNotification(notification.payload);
          }
        },
        error: (error: unknown) => {
          getLogger().warn({ error }, `${this.options.logLabel}: notification listener failed`);
          void this.release();
        },
      };

      try {
        connection.on('notification', handlers.notification);
        connection.on('error', handlers.error);
        await connection.query(`LISTEN ${this.options.channel}`);
        state.connection = connection;
        state.handlers = handlers;
      } catch (error) {
        await knex.client.releaseConnection(connection);
        throw error;
      }
    })()
      .catch((error) => {
        state.connection = null;
        state.handlers = null;
        getLogger().warn({ error }, `${this.options.logLabel}: notification listener unavailable`);
        throw error;
      })
      .finally(() => {
        state.listenPromise = null;
      });

    return state.listenPromise;
  }

  private async release(): Promise<void> {
    const state = listenerState(this.options.channel);
    const connection = state.connection;
    const handlers = state.handlers;
    state.connection = null;
    state.handlers = null;
    state.listenPromise = null;
    if (!connection) {
      return;
    }

    try {
      if (handlers) {
        connection.removeListener?.('notification', handlers.notification);
        connection.removeListener?.('error', handlers.error);
      }
      await this.options.getKnex().client.releaseConnection(connection);
    } catch (error) {
      getLogger().warn({ error }, `${this.options.logLabel}: listener connection release failed`);
    }
  }
}
