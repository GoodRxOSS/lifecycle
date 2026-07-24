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

import Database from 'server/database';
import { Redis } from 'ioredis';
import Redlock from 'redlock';
import { RedisClient } from './redisClient';
import QueueManager from './queueManager';

export const defaultDb = new Database();

export const redisClient = RedisClient.getInstance();
export const defaultRedis: Redis = redisClient.getRedis();
export const defaultRedlock: Redlock = redisClient.getRedlock();
export const defaultQueueManager: QueueManager = QueueManager.getInstance();
