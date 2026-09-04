/**
 * Copyright 2026 Lifecycle contributors
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

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};
const mockQueueConstructor = jest.fn();
const mockWorkerConstructor = jest.fn();

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((...args) => mockQueueConstructor(...args)),
  Worker: jest.fn().mockImplementation((...args) => mockWorkerConstructor(...args)),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
}));

import QueueManager from './queueManager';

type TestQueue = {
  name: string;
  close: jest.Mock;
  add: jest.Mock;
  paused: boolean;
  [key: string]: unknown;
};

type TestWorker = {
  name: string;
  close: jest.Mock;
};

function connection({ duplicate = true, options = {} as Record<string, unknown> } = {}) {
  const duplicated = { options: { ...options } };
  const value: any = { options };
  if (duplicate) {
    value.duplicate = jest.fn(() => duplicated);
  }
  return { value, duplicated };
}

function queue(name: string, overrides: Partial<TestQueue> = {}): TestQueue {
  const result: TestQueue = {
    name,
    close: jest.fn().mockResolvedValue(undefined),
    add: jest.fn(function (this: TestQueue, jobName: string) {
      return `${this.name}:${jobName}`;
    }),
    paused: false,
    ...overrides,
  };
  return result;
}

function worker(name: string, overrides: Partial<TestWorker> = {}): TestWorker {
  return {
    name,
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('QueueManager', () => {
  beforeEach(() => {
    delete (globalThis as any).__lifecycleQueueManager;
    jest.clearAllMocks();
    mockQueueConstructor.mockImplementation((name: string) => queue(name));
    mockWorkerConstructor.mockImplementation((name: string) => worker(name));
  });

  afterEach(() => {
    delete (globalThis as any).__lifecycleQueueManager;
  });

  it('returns one process-wide singleton until that singleton is closed', async () => {
    const first = QueueManager.getInstance();

    expect(QueueManager.getInstance()).toBe(first);

    await first.emptyAndCloseAllQueues();

    expect(QueueManager.getInstance()).not.toBe(first);
  });

  it('registers queues lazily and returns the same proxy for duplicate registration', () => {
    const manager = QueueManager.getInstance();
    const redis = connection();
    const proxy = manager.registerQueue('builds', {
      connection: redis.value,
      defaultJobOptions: { attempts: 3 },
    });

    expect(proxy.name).toBe('builds');
    expect(mockQueueConstructor).not.toHaveBeenCalled();
    expect(manager.getQueues()).toEqual([]);
    expect(manager.registerQueue('builds', { connection: {} as any })).toBe(proxy);

    expect(proxy.add('deploy', {})).toBe('builds:deploy');
    expect(redis.value.duplicate).toHaveBeenCalledTimes(1);
    expect(mockQueueConstructor).toHaveBeenCalledWith('builds', {
      connection: redis.duplicated,
      defaultJobOptions: { attempts: 3 },
    });
    expect(manager.getQueues()).toHaveLength(1);

    proxy.add('teardown', {});
    expect(mockQueueConstructor).toHaveBeenCalledTimes(1);
  });

  it('forwards property reads, writes, membership, keys, and descriptors through the lazy proxy', () => {
    const manager = QueueManager.getInstance();
    const redis = connection({ duplicate: false });
    const underlying = queue('events');
    Object.defineProperty(underlying, 'marker', {
      configurable: true,
      enumerable: true,
      value: 'present',
      writable: true,
    });
    mockQueueConstructor.mockReturnValue(underlying);
    const proxy: any = manager.registerQueue('events', { connection: redis.value });

    expect(proxy.paused).toBe(false);
    proxy.paused = true;
    expect(underlying.paused).toBe(true);
    expect('paused' in proxy).toBe(true);
    expect(Reflect.ownKeys(proxy)).toEqual(expect.arrayContaining(['name', 'close', 'add', 'paused', 'marker']));
    expect(Object.getOwnPropertyDescriptor(proxy, 'marker')).toEqual(
      expect.objectContaining({ value: 'present', enumerable: true })
    );
    expect(mockQueueConstructor).toHaveBeenCalledWith('events', {
      connection: redis.value,
      defaultJobOptions: undefined,
    });
  });

  it('registers a worker with a duplicate connection and associates it with an existing queue', async () => {
    const manager = QueueManager.getInstance();
    const queueConnection = connection({ duplicate: false });
    const workerConnection = connection({ options: { maxRetriesPerRequest: 8 } });
    const registeredQueue = queue('builds');
    const registeredWorker = worker('builds');
    mockQueueConstructor.mockReturnValue(registeredQueue);
    mockWorkerConstructor.mockReturnValue(registeredWorker);
    const queueProxy = manager.registerQueue('builds', { connection: queueConnection.value });
    void queueProxy.close;
    const processor = jest.fn();

    expect(
      manager.registerWorker('builds', processor, {
        connection: workerConnection.value,
        concurrency: 4,
        settings: { backoffStrategy: jest.fn() },
        limiter: { max: 12, duration: 1000 },
      })
    ).toBe(registeredWorker);

    expect(workerConnection.duplicated.options.maxRetriesPerRequest).toBeNull();
    expect(mockWorkerConstructor).toHaveBeenCalledWith('builds', processor, {
      connection: workerConnection.duplicated,
      concurrency: 4,
      settings: { backoffStrategy: expect.any(Function) },
      limiter: { max: 12, duration: 1000 },
    });

    await manager.emptyAndCloseAllQueues();

    expect(registeredWorker.close).toHaveBeenCalledTimes(1);
    expect(registeredQueue.close).toHaveBeenCalledTimes(1);
  });

  it('supports a worker-only registration with an unduplicated connection that has no options', async () => {
    const manager = QueueManager.getInstance();
    const redis = connection({ duplicate: false });
    delete redis.value.options;
    const registeredWorker = worker('cleanup');
    mockWorkerConstructor.mockReturnValue(registeredWorker);

    manager.registerWorker('cleanup', jest.fn(), { connection: redis.value });

    expect(mockWorkerConstructor).toHaveBeenCalledWith(
      'cleanup',
      expect.any(Function),
      expect.objectContaining({ connection: redis.value })
    );
    expect(manager.getQueues()).toEqual([]);

    await manager.emptyAndCloseAllQueues();

    expect(registeredWorker.close).toHaveBeenCalledTimes(1);
  });

  it('continues closing remaining resources and warns when worker and queue shutdown fail', async () => {
    const manager = QueueManager.getInstance();
    const redis = connection({ duplicate: false });
    const workerFailure = new Error('worker still active');
    const queueFailure = new Error('queue connection lost');
    const registeredQueue = queue('webhooks', {
      close: jest.fn().mockRejectedValue(queueFailure),
    });
    const registeredWorker = worker('webhooks', {
      close: jest.fn().mockRejectedValue(workerFailure),
    });
    mockQueueConstructor.mockReturnValue(registeredQueue);
    mockWorkerConstructor.mockReturnValue(registeredWorker);
    const queueProxy = manager.registerQueue('webhooks', { connection: redis.value });
    void queueProxy.close;
    manager.registerWorker('webhooks', jest.fn(), { connection: redis.value });

    await expect(manager.emptyAndCloseAllQueues()).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { error: 'worker still active' },
      'Queue: worker close failed name=webhooks'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { error: 'queue connection lost' },
      'Queue: close failed name=webhooks'
    );
    expect(manager.getQueues()).toEqual([]);
    expect(mockLogger.info).toHaveBeenCalledWith('Queue: closed');
  });

  it('does not delete a different singleton installed while this manager is closing', async () => {
    const manager = QueueManager.getInstance();
    const replacement = { replacement: true };
    (globalThis as any).__lifecycleQueueManager = replacement;

    await manager.emptyAndCloseAllQueues();

    expect((globalThis as any).__lifecycleQueueManager).toBe(replacement);
  });
});
