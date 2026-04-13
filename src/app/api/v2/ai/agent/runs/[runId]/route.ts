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
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentRunService from 'server/services/agent/RunService';

/**
 * @openapi
 * /api/v2/ai/agent/runs/{runId}:
 *   get:
 *     summary: Get an agent run
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentRun
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Agent run
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AgentRun'
 *       '404':
 *         description: Agent run not found
 */
const getHandler = async (req: NextRequest, { params }: { params: { runId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  try {
    const run = await AgentRunService.getOwnedRun(params.runId, userIdentity.userId);
    return successResponse(AgentRunService.serializeRun(run), { status: 200 }, req);
  } catch (error) {
    if (AgentRunService.isRunNotFoundError(error)) {
      return errorResponse(new Error('Agent run not found'), { status: 404 }, req);
    }

    throw error;
  }
};

export const GET = createApiHandler(getHandler);
