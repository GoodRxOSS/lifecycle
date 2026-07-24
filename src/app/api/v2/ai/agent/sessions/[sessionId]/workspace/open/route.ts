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
import { resolveRequestGitHubToken } from 'server/lib/agentSession/githubToken';
import { buildWorkspaceFailureLinkData } from 'server/lib/agentSession/workspaceFailureLink';
import { requireRequestUserIdentity } from 'server/lib/get-user';
import { errorResponse, successResponse } from 'server/lib/response';
import { WorkspaceActionBlockedError } from 'server/services/agent/WorkspaceRuntimeStateService';
import AgentSessionReadService from 'server/services/agent/SessionReadService';
import AgentSessionService from 'server/services/agentSession';

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Session not found';
}

/**
 * @openapi
 * /api/v2/ai/agent/sessions/{sessionId}/workspace/open:
 *   post:
 *     summary: Open a chat session workspace runtime
 *     description: Dispatches chat workspace open, retry, or hibernated resume through the canonical workspace policy.
 *     tags:
 *       - Agent Sessions
 *     operationId: openAgentSessionWorkspace
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *     responses:
 *       '200':
 *         description: Opened session
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
 *         description: Session workspace cannot be opened
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [request_id, data, error]
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   nullable: true
 *                   allOf:
 *                     - $ref: '#/components/schemas/WorkspaceFailureLinkData'
 *                 error:
 *                   $ref: '#/components/schemas/ApiError'
 *       '401':
 *         description: Unauthorized
 *       '404':
 *         description: Session not found
 *       '409':
 *         description: Workspace action is blocked by an active run or another lifecycle action
 */
const postHandler = async (req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) => {
  const routeParams = await params;
  const userIdentity = requireRequestUserIdentity(req);

  try {
    const githubToken = await resolveRequestGitHubToken(req);
    const session = await AgentSessionService.openChatRuntime({
      sessionId: routeParams.sessionId,
      userId: userIdentity.userId,
      userIdentity,
      githubToken,
    });

    return successResponse(await AgentSessionReadService.serializeSessionRecord(session), { status: 200 }, req);
  } catch (error) {
    if (error instanceof WorkspaceActionBlockedError) {
      return errorResponse(error, { status: 409 }, req);
    }
    if (isSessionNotFoundError(error)) {
      return errorResponse(new Error('Session not found'), { status: 404 }, req);
    }

    const failureData = await buildWorkspaceFailureLinkData({
      sessionId: routeParams.sessionId,
      userId: userIdentity.userId,
    });
    return errorResponse(error, { status: 400, data: failureData }, req);
  }
};

export const POST = createApiHandler(postHandler, { auth: 'session' });
