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
import { REDIS_URL, APP_REDIS_HOST, APP_REDIS_PORT, APP_REDIS_PASSWORD, APP_REDIS_TLS } from 'shared/config';
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
    if (APP_REDIS_HOST) {
      const redisConfig: any = {
        host: APP_REDIS_HOST,
        port: APP_REDIS_PORT ? parseInt(APP_REDIS_PORT, 10) : 6379,
      };

      if (APP_REDIS_PASSWORD) {
        redisConfig.password = APP_REDIS_PASSWORD;
      }

      if (APP_REDIS_TLS === 'true') {
        redisConfig.tls = {
          rejectUnauthorized: false,
        };
      }

      this.redis = new Redis(redisConfig);
    } else if (REDIS_URL) {
      this.redis = new Redis(REDIS_URL);
    } else {
      throw new Error(
        'Redis configuration not found. Please provide either REDIS_URL or individual APP_REDIS_* environment variables.'
      );
    }

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

  public getConnection(): Redis {
    const connection = this.redis.duplicate();
    // BullMQ requires maxRetriesPerRequest to be null for blocking operations
    connection.options.maxRetriesPerRequest = null;
    return connection;
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
