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
 * /api/v2/ai/agent/pending-actions/{actionId}/respond:
 *   post:
 *     summary: Resolve a pending action with an approve or deny response
 *     tags:
 *       - Agent Sessions
 *     operationId: respondToAgentPendingAction
 *     parameters:
 *       - in: path
 *         name: actionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               approved:
 *                 type: boolean
 *               reason:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Pending action resolved
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AgentPendingAction'
 */
const postHandler = async (req: NextRequest, { params }: { params: { actionId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const body = await req.json().catch(() => ({}));
  const approved = body?.approved === true;
  const action = await ApprovalService.resolvePendingAction(
    params.actionId,
    userIdentity.userId,
    approved ? 'approved' : 'denied',
    {
      approved,
      reason: typeof body?.reason === 'string' ? body.reason : null,
      source: 'endpoint',
    }
  );

  return successResponse(ApprovalService.serializePendingAction(action), { status: 200 }, req);
};

export const POST = createApiHandler(postHandler);
