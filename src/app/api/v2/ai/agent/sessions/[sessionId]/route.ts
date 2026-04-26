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
import 'server/lib/dependencies';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse, errorResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentSessionReadService from 'server/services/agent/SessionReadService';
import AgentSessionService from 'server/services/agentSession';

/**
 * @openapi
 * /api/v2/ai/agent/sessions/{sessionId}:
 *   get:
 *     summary: Get an agent session by id
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentSession
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Agent session
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [request_id, data, error]
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   $ref: '#/components/schemas/AgentSessionSummary'
 *                 error:
 *                   nullable: true
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   delete:
 *     summary: End an agent session
 *     tags:
 *       - Agent Sessions
 *     operationId: deleteAgentSession
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Session ended
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
 *                     - ended
 *                   properties:
 *                     ended:
 *                       type: boolean
 *                 error:
 *                   nullable: true
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const { sessionId } = await params;
  const sessionRecord = await AgentSessionReadService.getOwnedSessionRecord(sessionId, userIdentity.userId);
  if (!sessionRecord) {
    return errorResponse(new Error('Session not found'), { status: 404 }, req);
  }

  return successResponse(sessionRecord, { status: 200 }, req);
};

const deleteHandler = async (req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const { sessionId } = await params;
  const session = await AgentSessionService.getSession(sessionId);
  if (!session) {
    return errorResponse(new Error('Session not found'), { status: 404 }, req);
  }

  if (session.userId !== userIdentity.userId) {
    return errorResponse(new Error('Forbidden: you do not own this session'), { status: 401 }, req);
  }

  await AgentSessionService.endSession(sessionId);
  return successResponse({ ended: true }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
export const DELETE = createApiHandler(deleteHandler);
