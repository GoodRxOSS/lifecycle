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
import AgentSessionConfigService from 'server/services/agentSessionConfig';

export const dynamic = 'force-dynamic';

/**
 * @openapi
 * /api/v2/ai/admin/agent/tools:
 *   get:
 *     summary: List effective Agent Session tool inventory for a scope
 *     tags:
 *       - Agent Admin
 *     operationId: getAdminAgentToolInventory
 *     parameters:
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           default: global
 *     responses:
 *       '200':
 *         description: Effective Agent Session tool inventory
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminAgentToolInventorySuccessResponse'
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

  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const data = await AgentSessionConfigService.getInstance().listToolInventory(scope);
  return successResponse(data, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
