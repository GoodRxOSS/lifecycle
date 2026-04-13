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
import { errorResponse, successResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentSettingsService from 'server/services/agent/SettingsService';

export const dynamic = 'force-dynamic';

/**
 * @openapi
 * /api/v2/ai/agent/settings:
 *   get:
 *     summary: Get agent settings for the current user
 *     description: >
 *       Returns a client-neutral settings snapshot for the current user,
 *       including provider credential state and enabled MCP connections with
 *       per-user connection state. This endpoint is intended to power multiple
 *       clients, not just the current web UI.
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentSettings
 *     parameters:
 *       - in: query
 *         name: repo
 *         schema:
 *           type: string
 *         description: Optional repository full name used to include repo-enabled MCP connections.
 *     responses:
 *       '200':
 *         description: Agent settings snapshot
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAgentSettingsSuccessResponse'
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
  const settings = await AgentSettingsService.getSettingsSnapshot(userIdentity, repo);

  return successResponse(settings, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
