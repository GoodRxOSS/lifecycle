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

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse, errorResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import UserApiKeyService from 'server/services/userApiKey';
import RedisClient from 'server/lib/redisClient';

const CACHE_TTL_SECONDS = 300;

/**
 * @openapi
 * /api/v2/ai/agent/models:
 *   get:
 *     summary: List Anthropic models available to the authenticated user's stored API key
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentModels
 *     responses:
 *       '200':
 *         description: Available models
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [request_id, data, error]
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   type: object
 *                   required:
 *                     - data
 *                     - has_more
 *                     - first_id
 *                     - last_id
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required:
 *                           - id
 *                           - display_name
 *                           - created_at
 *                           - type
 *                         properties:
 *                           id:
 *                             type: string
 *                           display_name:
 *                             type: string
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *                           type:
 *                             type: string
 *                     has_more:
 *                       type: boolean
 *                     first_id:
 *                       type: string
 *                       nullable: true
 *                     last_id:
 *                       type: string
 *                       nullable: true
 *                 error:
 *                   nullable: true
 *       '400':
 *         description: API key missing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '502':
 *         description: Anthropic models request failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const apiKey = await UserApiKeyService.getDecryptedKey(userIdentity.userId, 'anthropic', userIdentity.githubUsername);
  if (!apiKey) {
    return errorResponse(
      new Error('An Anthropic API key is required. Please add one in settings.'),
      { status: 400 },
      req
    );
  }

  const redis = RedisClient.getInstance().getRedis();
  const cacheOwner = userIdentity.githubUsername || userIdentity.userId;
  const cacheKey = `lifecycle:agent:models:${cacheOwner}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return successResponse(JSON.parse(cached), { status: 200 }, req);
  }

  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!res.ok) {
    return errorResponse(new Error(`Failed to fetch models: ${res.status} ${res.statusText}`), { status: 502 }, req);
  }

  const data = await res.json();
  await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(data));

  return successResponse(data, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
