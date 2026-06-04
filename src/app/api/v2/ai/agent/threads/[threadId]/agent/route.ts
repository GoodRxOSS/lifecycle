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
import AgentSelectionService from 'server/services/agent/AgentSelectionService';

// AgentThreadAgentSwitchError self-maps via createApiHandler; only plain not-found Errors need mapping here.
function mapAgentSelectionError(error: unknown, req: NextRequest) {
  if (
    error instanceof Error &&
    (error.message === 'Agent thread not found' || error.message === 'Agent session not found')
  ) {
    return errorResponse(error, { status: 404 }, req);
  }

  throw error;
}

/**
 * @openapi
 * /api/v2/ai/agent/threads/{threadId}/agent:
 *   get:
 *     summary: Get the current agent selection state for a thread
 *     description: Returns the selected agent that will be used when future runs are created for this thread.
 *     tags:
 *       - Agent Platform
 *     operationId: getAgentThreadSelection
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Agent selection state
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AgentSelectionState'
 *   patch:
 *     summary: Switch the agent used for future runs in a thread
 *     description: Updates the thread's selected agent for future runs without changing already-created runs.
 *     tags:
 *       - Agent Platform
 *     operationId: switchAgentThreadSelection
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SwitchAgentSelectionRequest'
 *     responses:
 *       '200':
 *         description: Agent selection switched or already selected
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/SwitchAgentSelectionResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) => {
  const routeParams = await params;
  const userIdentity = requireRequestUserIdentity(req);

  try {
    const state = await AgentSelectionService.getThreadAgentState({ threadId: routeParams.threadId, userIdentity });
    return successResponse(state, { status: 200 }, req);
  } catch (error) {
    return mapAgentSelectionError(error, req);
  }
};

const patchHandler = async (req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) => {
  const routeParams = await params;
  const userIdentity = requireRequestUserIdentity(req);

  const body = await req.json().catch(() => ({}));
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(new Error('Request body must be an object'), { status: 400 }, req);
  }

  const requestBody = body as Record<string, unknown>;
  const unknownKeys = Object.keys(requestBody).filter((key) => key !== 'agentId');
  if (unknownKeys.length > 0) {
    return errorResponse(
      new Error(`Unsupported switch request fields: ${unknownKeys.join(', ')}`),
      { status: 400 },
      req
    );
  }

  if (typeof requestBody.agentId !== 'string' || !requestBody.agentId.trim()) {
    return errorResponse(new Error('agentId must be a non-empty string'), { status: 400 }, req);
  }

  try {
    const result = await AgentSelectionService.switchThreadAgent({
      threadId: routeParams.threadId,
      userIdentity,
      agentId: requestBody.agentId.trim(),
    });
    return successResponse(result, { status: 200 }, req);
  } catch (error) {
    return mapAgentSelectionError(error, req);
  }
};

export const GET = createApiHandler(getHandler);
export const PATCH = createApiHandler(patchHandler);
