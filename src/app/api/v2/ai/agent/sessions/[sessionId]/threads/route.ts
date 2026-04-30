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
import AgentThreadService from 'server/services/agent/ThreadService';

/**
 * @openapi
 * /api/v2/ai/agent/sessions/{sessionId}/threads:
 *   get:
 *     summary: List threads for an agent session
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentSessionThreads
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Threads for the session
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
 *                       required: [threads]
 *                       properties:
 *                         threads:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/AgentThread'
 *       '401':
 *         description: Unauthorized
 *       '404':
 *         description: Agent session not found
 *   post:
 *     summary: Create a new thread in an agent session
 *     tags:
 *       - Agent Sessions
 *     operationId: createAgentSessionThread
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
 *             properties:
 *               title:
 *                 type: string
 *     responses:
 *       '201':
 *         description: Thread created
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AgentThread'
 *       '401':
 *         description: Unauthorized
 *       '404':
 *         description: Agent session not found
 *       '409':
 *         description: Session cannot create new threads in its current state
 */
const getHandler = async (req: NextRequest, { params }: { params: { sessionId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  try {
    const threads = await AgentThreadService.listThreadsForSession(params.sessionId, userIdentity.userId);
    return successResponse(
      {
        threads: threads.map((thread) => AgentThreadService.serializeThread(thread, params.sessionId)),
      },
      { status: 200 },
      req
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'Agent session not found') {
      return errorResponse(error, { status: 404 }, req);
    }

    throw error;
  }
};

const postHandler = async (req: NextRequest, { params }: { params: { sessionId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const body = await req.json().catch(() => ({}));
  try {
    const thread = await AgentThreadService.createThread(params.sessionId, userIdentity.userId, body?.title);

    return successResponse(AgentThreadService.serializeThread(thread, params.sessionId), { status: 201 }, req);
  } catch (error) {
    if (error instanceof Error && error.message === 'Agent session not found') {
      return errorResponse(error, { status: 404 }, req);
    }

    if (error instanceof Error && error.message === 'Cannot create a thread for an inactive session') {
      return errorResponse(error, { status: 409 }, req);
    }

    if (
      error instanceof Error &&
      (error.message === 'Wait for the session to finish starting before sending a message.' ||
        error.message === 'This session is no longer available for new messages.')
    ) {
      return errorResponse(error, { status: 409 }, req);
    }

    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
