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

const mockWarn = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: mockWarn }),
}));

import { PgNotificationListener, type PgListenConnection, type PgListenKnexClient } from '../pgNotificationListener';

type Notification = { channel?: string; payload?: string };

function connection(options: { queryError?: Error; removeListener?: boolean } = {}) {
  const listeners: {
    notification?: (notification: Notification) => void;
    error?: (error: unknown) => void;
  } = {};
  const on = jest.fn((event: 'notification' | 'error', listener: (...args: any[]) => void) => {
    if (event === 'notification') {
      listeners.notification = listener;
    } else {
      listeners.error = listener;
    }
  });
  const query = options.queryError
    ? jest.fn().mockRejectedValue(options.queryError)
    : jest.fn().mockResolvedValue(undefined);
  const removeListener = jest.fn();
  const value = {
    on,
    query,
    ...(options.removeListener === false ? {} : { removeListener }),
  } as PgListenConnection;

  return { value, listeners, on, query, removeListener };
}

function knex(
  acquireConnection: jest.Mock,
  releaseConnection: jest.Mock = jest.fn().mockResolvedValue(undefined)
): PgListenKnexClient {
  return { client: { acquireConnection, releaseConnection } };
}

function createListener(
  db: PgListenKnexClient,
  overrides: Partial<ConstructorParameters<typeof PgNotificationListener>[0]> = {}
) {
  return new PgNotificationListener({
    channel: 'agent_run_events',
    getKnex: () => db,
    onNotification: jest.fn(),
    logLabel: 'Agent runs',
    ...overrides,
  });
}

function resetGlobalState(): void {
  delete (globalThis as typeof globalThis & { __lifecyclePgNotificationListeners?: unknown })
    .__lifecyclePgNotificationListeners;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('PgNotificationListener', () => {
  beforeEach(() => {
    resetGlobalState();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetGlobalState();
  });

  it.each(['AgentEvents', 'agent-events', 'agent events', 'agent_events;drop table builds', '1agent_events'])(
    'rejects unsafe channel %p before requesting a database client',
    (channel) => {
      const getKnex = jest.fn();

      expect(
        () =>
          new PgNotificationListener({
            channel,
            getKnex,
            onNotification: jest.fn(),
            logLabel: 'Unsafe',
          })
      ).toThrow(`Invalid pg notification channel '${channel}'`);
      expect(getKnex).not.toHaveBeenCalled();
    }
  );

  it('acquires one connection, listens on the validated channel, and routes only matching notifications', async () => {
    const pg = connection();
    const acquireConnection = jest.fn().mockResolvedValue(pg.value);
    const db = knex(acquireConnection);
    const onNotification = jest.fn();
    const listener = createListener(db, { onNotification });

    await listener.ensureListening();
    await listener.ensureListening();

    expect(acquireConnection).toHaveBeenCalledTimes(1);
    expect(pg.query).toHaveBeenCalledWith('LISTEN agent_run_events');
    expect(pg.on).toHaveBeenCalledWith('notification', expect.any(Function));
    expect(pg.on).toHaveBeenCalledWith('error', expect.any(Function));

    pg.listeners.notification?.({ channel: 'other_channel', payload: 'ignored' });
    pg.listeners.notification?.({ channel: 'agent_run_events', payload: 'run-1' });
    pg.listeners.notification?.({ channel: 'agent_run_events' });

    expect(onNotification).toHaveBeenNthCalledWith(1, 'run-1');
    expect(onNotification).toHaveBeenNthCalledWith(2, undefined);
    expect(onNotification).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight connection attempt between concurrent callers', async () => {
    const pg = connection();
    let resolveAcquisition: ((value: PgListenConnection) => void) | undefined;
    const acquireConnection = jest.fn(
      () =>
        new Promise<PgListenConnection>((resolve) => {
          resolveAcquisition = resolve;
        })
    );
    const listener = createListener(knex(acquireConnection));

    const first = listener.ensureListening();
    const second = listener.ensureListening();

    expect(acquireConnection).toHaveBeenCalledTimes(1);
    resolveAcquisition?.(pg.value);
    await Promise.all([first, second]);

    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('shares established channel state across listener instances', async () => {
    const pg = connection();
    const acquireConnection = jest.fn().mockResolvedValue(pg.value);
    const db = knex(acquireConnection);
    const firstNotification = jest.fn();
    const secondNotification = jest.fn();
    const first = createListener(db, { onNotification: firstNotification });
    const second = createListener(db, { onNotification: secondNotification });

    await first.ensureListening();
    await second.ensureListening();
    pg.listeners.notification?.({ channel: 'agent_run_events', payload: 'run-1' });

    expect(acquireConnection).toHaveBeenCalledTimes(1);
    expect(firstNotification).toHaveBeenCalledWith('run-1');
    expect(secondNotification).not.toHaveBeenCalled();
  });

  it('releases a connection after LISTEN fails and permits a later retry', async () => {
    const queryError = new Error('permission denied');
    const failed = connection({ queryError });
    const recovered = connection();
    const acquireConnection = jest.fn().mockResolvedValueOnce(failed.value).mockResolvedValueOnce(recovered.value);
    const releaseConnection = jest.fn().mockResolvedValue(undefined);
    const listener = createListener(knex(acquireConnection, releaseConnection));

    await expect(listener.ensureListening()).rejects.toBe(queryError);

    expect(releaseConnection).toHaveBeenCalledWith(failed.value);
    expect(mockWarn).toHaveBeenCalledWith({ error: queryError }, 'Agent runs: notification listener unavailable');

    await expect(listener.ensureListening()).resolves.toBeUndefined();
    expect(acquireConnection).toHaveBeenCalledTimes(2);
    expect(recovered.query).toHaveBeenCalledWith('LISTEN agent_run_events');
  });

  it('logs acquisition failure and retries without releasing an unacquired connection', async () => {
    const acquisitionError = new Error('pool exhausted');
    const recovered = connection();
    const acquireConnection = jest.fn().mockRejectedValueOnce(acquisitionError).mockResolvedValueOnce(recovered.value);
    const releaseConnection = jest.fn().mockResolvedValue(undefined);
    const listener = createListener(knex(acquireConnection, releaseConnection));

    await expect(listener.ensureListening()).rejects.toBe(acquisitionError);
    expect(releaseConnection).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith({ error: acquisitionError }, 'Agent runs: notification listener unavailable');

    await listener.ensureListening();
    expect(acquireConnection).toHaveBeenCalledTimes(2);
  });

  it('removes handlers, releases the pool slot on connection error, and re-acquires on demand', async () => {
    const failed = connection();
    const recovered = connection();
    const acquireConnection = jest.fn().mockResolvedValueOnce(failed.value).mockResolvedValueOnce(recovered.value);
    const releaseConnection = jest.fn().mockResolvedValue(undefined);
    const listener = createListener(knex(acquireConnection, releaseConnection));
    await listener.ensureListening();

    const connectionError = new Error('socket closed');
    failed.listeners.error?.(connectionError);
    await flushPromises();

    expect(mockWarn).toHaveBeenCalledWith({ error: connectionError }, 'Agent runs: notification listener failed');
    expect(failed.removeListener).toHaveBeenCalledWith('notification', failed.listeners.notification);
    expect(failed.removeListener).toHaveBeenCalledWith('error', failed.listeners.error);
    expect(releaseConnection).toHaveBeenCalledWith(failed.value);

    await listener.ensureListening();
    expect(acquireConnection).toHaveBeenCalledTimes(2);
    expect(recovered.query).toHaveBeenCalled();
  });

  it('tolerates connections without removeListener and repeated stale error callbacks', async () => {
    const pg = connection({ removeListener: false });
    const releaseConnection = jest.fn().mockResolvedValue(undefined);
    const listener = createListener(knex(jest.fn().mockResolvedValue(pg.value), releaseConnection));
    await listener.ensureListening();

    pg.listeners.error?.(new Error('first failure'));
    await flushPromises();
    pg.listeners.error?.(new Error('stale callback'));
    await flushPromises();

    expect(releaseConnection).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it('contains release failures after clearing shared state', async () => {
    const failed = connection();
    const recovered = connection();
    const releaseError = new Error('release failed');
    const releaseConnection = jest.fn().mockRejectedValueOnce(releaseError).mockResolvedValueOnce(undefined);
    const acquireConnection = jest.fn().mockResolvedValueOnce(failed.value).mockResolvedValueOnce(recovered.value);
    const listener = createListener(knex(acquireConnection, releaseConnection));
    await listener.ensureListening();

    failed.listeners.error?.(new Error('connection failed'));
    await flushPromises();

    expect(mockWarn).toHaveBeenCalledWith({ error: releaseError }, 'Agent runs: listener connection release failed');
    await listener.ensureListening();
    expect(acquireConnection).toHaveBeenCalledTimes(2);
  });
});
