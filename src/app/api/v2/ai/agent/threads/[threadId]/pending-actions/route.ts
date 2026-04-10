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
import ApprovalService from 'server/services/agent/ApprovalService';

/**
 * @openapi
 * /api/v2/ai/agent/threads/{threadId}/pending-actions:
 *   get:
 *     summary: List pending actions for an agent thread
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentThreadPendingActions
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Pending actions for the thread
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
 *                       required: [pendingActions]
 *                       properties:
 *                         pendingActions:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/AgentPendingAction'
 */
const getHandler = async (req: NextRequest, { params }: { params: { threadId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const pendingActions = await ApprovalService.listPendingActions(params.threadId, userIdentity.userId);
  return successResponse(
    {
      pendingActions: pendingActions.map((action) => ApprovalService.serializePendingAction(action)),
    },
    { status: 200 },
    req
  );
};

export const GET = createApiHandler(getHandler);
