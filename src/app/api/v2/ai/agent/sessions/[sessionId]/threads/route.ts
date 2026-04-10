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
 */
const getHandler = async (req: NextRequest, { params }: { params: { sessionId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const threads = await AgentThreadService.listThreadsForSession(params.sessionId, userIdentity.userId);
  return successResponse(
    {
      threads: threads.map((thread) => AgentThreadService.serializeThread(thread, params.sessionId)),
    },
    { status: 200 },
    req
  );
};

const postHandler = async (req: NextRequest, { params }: { params: { sessionId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const body = await req.json().catch(() => ({}));
  const thread = await AgentThreadService.createThread(params.sessionId, userIdentity.userId, body?.title);

  return successResponse(AgentThreadService.serializeThread(thread, params.sessionId), { status: 201 }, req);
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
