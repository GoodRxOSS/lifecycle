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

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse, errorResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentProviderRegistry from 'server/services/agent/ProviderRegistry';
import { AGENT_API_KEY_HEADER, AGENT_API_KEY_PROVIDER_HEADER } from 'server/services/agent/providerConfig';

export const dynamic = 'force-dynamic';

/**
 * @openapi
 * /api/v2/ai/agent/models:
 *   get:
 *     summary: List enabled agent models for the current workspace configuration
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentModels
 *     parameters:
 *       - in: query
 *         name: repo
 *         schema:
 *           type: string
 *         description: Optional repository full name used to resolve repo-scoped provider overrides.
 *     responses:
 *       '200':
 *         description: Enabled agent models
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       type: object
 *                       required: [models]
 *                       properties:
 *                         models:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/AgentModel'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const repo = req.nextUrl.searchParams.get('repo') || undefined;
  const models = await AgentProviderRegistry.listAvailableModelsForUser({
    repoFullName: repo,
    userIdentity,
    requestApiKey: req.headers.get(AGENT_API_KEY_HEADER),
    requestApiKeyProvider: req.headers.get(AGENT_API_KEY_PROVIDER_HEADER),
  });

  return successResponse({ models }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
