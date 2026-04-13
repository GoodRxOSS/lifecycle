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
import AgentAdminService from 'server/services/agent/AdminService';

/**
 * @openapi
 * /api/v2/ai/admin/agent/sessions/{sessionId}:
 *   get:
 *     summary: Get agent session details for admin review
 *     description: >
 *       Returns a single agent session with thread-level summaries,
 *       including message, run, and pending action counts.
 *     tags:
 *       - Agent Admin
 *     operationId: getAdminAgentSession
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Agent session detail.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminAgentSessionSuccessResponse'
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
const getHandler = async (req: NextRequest, { params }: { params: { sessionId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  try {
    const result = await AgentAdminService.getSession(params.sessionId);
    return successResponse(result, { status: 200 }, req);
  } catch (error) {
    if (error instanceof Error && error.message === 'Agent session not found') {
      return errorResponse(error, { status: 404 }, req);
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
