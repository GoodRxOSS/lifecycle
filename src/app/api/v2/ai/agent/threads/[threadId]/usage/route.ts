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
import 'server/lib/dependencies';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import { requireRequestUserIdentity } from 'server/lib/get-user';
import AgentUsageService from 'server/services/agent/AgentUsageService';

/**
 * @openapi
 * /api/v2/ai/agent/threads/{threadId}/usage:
 *   get:
 *     summary: Get exact token usage for an agent thread
 *     description: Returns provider-reported token usage aggregated from agent runs in the thread, grouped by the resolved provider and model used for each run.
 *     tags:
 *       - Agent Platform
 *     operationId: getAgentThreadUsage
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Exact provider-reported usage for the thread
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAgentThreadUsageSuccessResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Thread or session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) => {
  const routeParams = await params;
  const userIdentity = requireRequestUserIdentity(req);

  try {
    const usage = await AgentUsageService.getOwnedThreadUsage(routeParams.threadId, userIdentity.userId);
    return successResponse(usage, { status: 200 }, req);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'Agent thread not found' || error.message === 'Agent session not found')
    ) {
      return errorResponse(error, { status: 404 }, req);
    }

    throw error;
  }
};

export const GET = createApiHandler(getHandler);
