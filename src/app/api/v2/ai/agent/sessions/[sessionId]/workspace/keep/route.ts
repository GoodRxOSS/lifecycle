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
import { requireRequestUserIdentity } from 'server/lib/get-user';
import { errorResponse, successResponse } from 'server/lib/response';
import AgentSessionReadService from 'server/services/agent/SessionReadService';
import AgentSessionService from 'server/services/agentSession';

/**
 * @openapi
 * /api/v2/ai/agent/sessions/{sessionId}/workspace/keep:
 *   post:
 *     summary: Pin or unpin the session workspace so cleanup never reclaims it
 *     tags:
 *       - Agent Sessions
 *     operationId: keepAgentSessionWorkspace
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [keep]
 *             properties:
 *               keep:
 *                 type: boolean
 *     responses:
 *       '200':
 *         description: Updated session
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
 *         description: Invalid body
 *       '401':
 *         description: Unauthorized
 *       '404':
 *         description: Session not found
 */
const postHandler = async (req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) => {
  const { sessionId } = await params;
  const userIdentity = requireRequestUserIdentity(req);

  const body = await req.json().catch(() => null);
  const keep = (body as { keep?: unknown } | null)?.keep;
  if (typeof keep !== 'boolean') {
    return errorResponse(new Error('keep must be a boolean'), { status: 400 }, req);
  }

  try {
    const session = await AgentSessionService.setKeepWorkspace(sessionId, userIdentity.userId, keep);
    return successResponse(await AgentSessionReadService.serializeSessionRecord(session), { status: 200 }, req);
  } catch (error) {
    if (error instanceof Error && error.message === 'Session not found') {
      return errorResponse(error, { status: 404 }, req);
    }
    throw error;
  }
};

export const POST = createApiHandler(postHandler, { auth: 'session' });
