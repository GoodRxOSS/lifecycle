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
import rootLogger from './logger';

const logger = rootLogger.child({
  filename: 'lib/queueManager.ts',
});

interface RegisteredQueue {
  queue: Queue;
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
    logger.debug(`Registering queue ${queueName}`);

    const queue = new Queue(queueName, {
      connection: options.connection.duplicate ? options.connection.duplicate() : options.connection,
      defaultJobOptions: options.defaultJobOptions,
    });

    this.registeredQueues.push({ queue });
    return queue;
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
    logger.debug(`Registering worker for queue ${queueName}`);

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
    const registered = this.registeredQueues.find((r) => r.queue?.name === queueName);
    if (registered) {
      registered.worker = worker;
    } else {
      this.registeredQueues.push({ queue: null, worker });
    }

    return worker;
  }

  public getQueues(): Queue[] {
    return this.registeredQueues.map((r) => r.queue).filter(Boolean);
  }

  public async emptyAndCloseAllQueues(): Promise<void> {
    for (const { queue, worker } of this.registeredQueues) {
      if (worker) {
        logger.debug(`Closing worker for queue: ${worker.name}`);
        try {
          await worker.close();
        } catch (error) {
          logger.warn(`⚠️ Error closing worker for queue ${worker.name}:`, error.message);
        }
      }

      if (queue) {
        logger.debug(`Closing queue: ${queue.name}`);
        try {
          await queue.close();
        } catch (error) {
          logger.warn(`⚠️ Error closing queue ${queue.name}:`, error.message);
        }
      }
    }
    logger.info('✅ All queues have been closed successfully.');
  }
}
