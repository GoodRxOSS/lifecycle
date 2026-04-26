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
import { getRequestUserIdentity } from 'server/lib/get-user';
import { errorResponse, successResponse } from 'server/lib/response';
import AgentSessionService, { ActiveAgentRunSuspensionError } from 'server/services/agentSession';
import AgentSessionReadService from 'server/services/agent/SessionReadService';

/**
 * @openapi
 * /api/v2/ai/agent/sessions/{sessionId}/sandbox/suspend:
 *   post:
 *     summary: Suspend a chat session sandbox runtime
 *     tags:
 *       - Agent Sessions
 *     operationId: suspendAgentSessionSandbox
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Suspended session
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AgentSessionSummary'
 *       '400':
 *         description: Session cannot be suspended
 *       '401':
 *         description: Unauthorized
 *       '409':
 *         description: Session has an active agent run
 */
const postHandler = async (req: NextRequest, { params }: { params: { sessionId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  try {
    const session = await AgentSessionService.suspendChatRuntime({
      sessionId: params.sessionId,
      userId: userIdentity.userId,
    });

    return successResponse(await AgentSessionReadService.serializeSessionRecord(session), { status: 200 }, req);
  } catch (error) {
    if (error instanceof ActiveAgentRunSuspensionError) {
      return errorResponse(error, { status: 409 }, req);
    }
    return errorResponse(error, { status: 400 }, req);
  }
};

export const POST = createApiHandler(postHandler);
