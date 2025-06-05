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

import Redis from 'ioredis';
import Redlock from 'redlock';
import { REDIS_URL } from 'shared/config';
import rootLogger from './logger';

const logger = rootLogger.child({
  filename: 'lib/redisClient.ts',
});

export class RedisClient {
  private static instance: RedisClient;

  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly redlock: Redlock;
  private readonly bclients: Redis[] = [];

  private constructor() {
    this.redis = new Redis(REDIS_URL);
    this.subscriber = this.redis.duplicate();
    this.redlock = new Redlock([this.redis], {
      driftFactor: 0.01,
      retryCount: 120,
      retryDelay: 1000,
      retryJitter: 200,
    });
    this.redis.setMaxListeners(50);
    this.subscriber.setMaxListeners(50);
  }

  public static getInstance(): RedisClient {
    if (!this.instance) {
      this.instance = new RedisClient();
    }
    return this.instance;
  }

  public getRedis(): Redis {
    return this.redis;
  }

  public getRedlock(): Redlock {
    return this.redlock;
  }

  public getBullCreateClient() {
    return (type: string): Redis => {
      switch (type) {
        case 'client':
          return this.redis;
        case 'subscriber':
          return this.subscriber;
        case 'bclient': {
          const bclient = this.redis.duplicate();
          this.bclients.push(bclient);
          return bclient;
        }
        default: {
          const client = this.redis.duplicate();
          this.bclients.push(client);
          return client;
        }
      }
    };
  }

  public async close(): Promise<void> {
    try {
      await Promise.all([this.redis.quit(), this.subscriber.quit(), ...this.bclients.map((client) => client.quit())]);
      logger.info(' ✅All Redis connections closed successfully.');
    } catch (error) {
      logger.warn(' ⚠️Error closing Redis connections. Forcing disconnect.', error);
      this.redis.disconnect();
      this.subscriber.disconnect();
      this.bclients.forEach((client) => client.disconnect());
    } finally {
      this.bclients.length = 0;
    }
  }
}

export default RedisClient;
