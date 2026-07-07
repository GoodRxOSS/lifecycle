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
import { WorkspaceActionBlockedError } from 'server/services/agent/WorkspaceRuntimeStateService';
import AgentSessionReadService from 'server/services/agent/SessionReadService';
import AgentSessionService from 'server/services/agentSession';

/**
 * @openapi
 * /api/v2/ai/agent/sessions/{sessionId}/workspace/release:
 *   post:
 *     summary: Release the session workspace; the conversation stays live and a fresh workspace provisions on the next message
 *     tags:
 *       - Agent Sessions
 *     operationId: releaseAgentSessionWorkspace
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Session with released workspace
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
 *       '401':
 *         description: Unauthorized
 *       '404':
 *         description: Session not found
 *       '409':
 *         description: Workspace action is blocked by an active run or another lifecycle action
 */
const postHandler = async (req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) => {
  const { sessionId } = await params;
  const userIdentity = requireRequestUserIdentity(req);

  const session = await AgentSessionService.getSession(sessionId);
  if (!session || session.userId !== userIdentity.userId) {
    return errorResponse(new Error('Session not found'), { status: 404 }, req);
  }

  try {
    await AgentSessionService.releaseWorkspace(sessionId);
  } catch (error) {
    if (error instanceof WorkspaceActionBlockedError) {
      return errorResponse(error, { status: 409 }, req);
    }
    throw error;
  }

  const released = await AgentSessionService.getSession(sessionId);
  return successResponse(await AgentSessionReadService.serializeSessionRecord(released!), { status: 200 }, req);
};

export const POST = createApiHandler(postHandler, { auth: 'session' });
