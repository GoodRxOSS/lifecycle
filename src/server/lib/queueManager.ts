/**
 * Copyright 2025 GoodRx, Inc.
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

import { Queue, Worker, QueueOptions, WorkerOptions, Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { getLogger } from 'server/lib/logger';

interface RegisteredQueue {
  name: string;
  queue: Queue | null;
  queueProxy?: Queue;
  worker?: Worker;
}

export default class QueueManager {
  private static instance: QueueManager;
  private registeredQueues: RegisteredQueue[] = [];

  private constructor() {}

  public static getInstance(): QueueManager {
    if (!this.instance) {
      this.instance = new QueueManager();
    }
    return this.instance;
  }

  public registerQueue(
    queueName: string,
    options: {
      connection: Redis;
      defaultJobOptions?: QueueOptions['defaultJobOptions'];
    }
  ): Queue {
    const existing = this.registeredQueues.find((r) => r.name === queueName);
    if (existing?.queueProxy) {
      return existing.queueProxy;
    }

    const registered: RegisteredQueue = {
      name: queueName,
      queue: null,
    };

    const getOrCreateQueue = (): Queue => {
      if (registered.queue) {
        return registered.queue;
      }

      getLogger().debug(`Registering queue: queueName=${queueName}`);
      registered.queue = new Queue(queueName, {
        connection: options.connection.duplicate ? options.connection.duplicate() : options.connection,
        defaultJobOptions: options.defaultJobOptions,
      });

      return registered.queue;
    };

    const queueProxy = new Proxy({} as Queue, {
      get(_target, prop) {
        if (prop === 'name') {
          return queueName;
        }

        const queue = getOrCreateQueue();
        const value = Reflect.get(queue, prop, queue);
        return typeof value === 'function' ? value.bind(queue) : value;
      },
      set(_target, prop, value) {
        const queue = getOrCreateQueue();
        return Reflect.set(queue, prop, value, queue);
      },
      has(_target, prop) {
        const queue = getOrCreateQueue();
        return prop in queue;
      },
      ownKeys() {
        return Reflect.ownKeys(getOrCreateQueue());
      },
      getOwnPropertyDescriptor(_target, prop) {
        return Object.getOwnPropertyDescriptor(getOrCreateQueue(), prop);
      },
    });

    registered.queueProxy = queueProxy;
    this.registeredQueues.push(registered);
    return queueProxy;
  }

  public registerWorker(
    queueName: string,
    processor: Processor,
    options: {
      connection: Redis;
      concurrency?: number;
      settings?: WorkerOptions['settings'];
      limiter?: {
        max: number;
        duration: number;
      };
    }
  ): Worker {
    getLogger().debug(`Registering worker: queueName=${queueName}`);

    const workerConnection = options.connection.duplicate ? options.connection.duplicate() : options.connection;
    // ensure maxRetriesPerRequest is null for workers
    if (workerConnection.options) {
      workerConnection.options.maxRetriesPerRequest = null;
    }

    const worker = new Worker(queueName, processor, {
      connection: workerConnection,
      concurrency: options.concurrency,
      settings: options.settings,
      limiter: options.limiter,
    });

    // find queue to associate with worker
    const registered = this.registeredQueues.find((r) => r.name === queueName);
    if (registered) {
      registered.worker = worker;
    } else {
      this.registeredQueues.push({ name: queueName, queue: null, worker });
    }

    return worker;
  }

  public getQueues(): Queue[] {
    return this.registeredQueues.map((r) => r.queue).filter((queue): queue is Queue => queue != null);
  }

  public async emptyAndCloseAllQueues(): Promise<void> {
    for (const { queue, worker } of this.registeredQueues) {
      if (worker) {
        getLogger().debug(`Closing worker: queueName=${worker.name}`);
        try {
          await worker.close();
        } catch (error) {
          getLogger().warn({ error: error.message }, `Queue: worker close failed name=${worker.name}`);
        }
      }

      if (queue) {
        getLogger().debug(`Closing queue: queueName=${queue.name}`);
        try {
          await queue.close();
        } catch (error) {
          getLogger().warn({ error: error.message }, `Queue: close failed name=${queue.name}`);
        }
      }
    }
    getLogger().info('Queue: closed');
  }
}
