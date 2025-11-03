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

import { NextApiRequest, NextApiResponse } from 'next';
import { defaultDb } from 'server/lib/dependencies';
import logger from 'server/lib/logger';
import RedisClient from 'server/lib/redisClient';

export default async function healthHandler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  try {
    await RedisClient.getInstance().getRedis().ping();
    await defaultDb.knex.raw('SELECT 1');
    res.status(200).json({ status: 'Healthy' });
  } catch (error) {
    logger.error(`Health check failed. Error:\n ${error}`);
    return res.status(500).json({ status: 'Unhealthy', error: `An error occurred while performing health check.` });
  }
}
