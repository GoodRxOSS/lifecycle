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

import { redisClient } from 'server/lib/dependencies';
import { getRequestUserSub } from 'server/lib/get-user';
import { getSandboxLaunchState, toPublicSandboxLaunchState } from 'server/lib/agentSession/sandboxLaunchState';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';

/**
 * @openapi
 * /api/v2/ai/agent/sandbox-sessions/launches/{launchId}:
 *   get:
 *     summary: Get sandbox launch progress
 *     tags:
 *       - Agent Sessions
 *     operationId: getSandboxAgentSessionLaunch
 *     parameters:
 *       - in: path
 *         name: launchId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Current sandbox launch status
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
 *                     - launchId
 *                     - status
 *                     - stage
 *                     - message
 *                     - createdAt
 *                     - updatedAt
 *                     - baseBuildUuid
 *                     - service
 *                     - buildUuid
 *                     - namespace
 *                     - sessionId
 *                     - focusUrl
 *                     - error
 *                   properties:
 *                     launchId:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [queued, running, created, error]
 *                     stage:
 *                       type: string
 *                       enum:
 *                         - queued
 *                         - resolving_base_build
 *                         - resolving_services
 *                         - creating_sandbox_build
 *                         - resolving_environment
 *                         - deploying_resources
 *                         - creating_agent_session
 *                         - ready
 *                         - error
 *                     message:
 *                       type: string
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                     baseBuildUuid:
 *                       type: string
 *                     service:
 *                       type: string
 *                     buildUuid:
 *                       type: string
 *                       nullable: true
 *                     namespace:
 *                       type: string
 *                       nullable: true
 *                     sessionId:
 *                       type: string
 *                       nullable: true
 *                     focusUrl:
 *                       type: string
 *                       nullable: true
 *                     error:
 *                       type: string
 *                       nullable: true
 *                 error:
 *                   nullable: true
 *       '401':
 *         description: Unauthorized
 *       '404':
 *         description: Launch not found
 */
const getHandler = async (req: NextRequest, { params }: { params: Promise<{ launchId: string }> }) => {
  const userId = getRequestUserSub(req);
  if (!userId) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const { launchId } = await params;
  const state = await getSandboxLaunchState(redisClient.getRedis(), launchId);
  if (!state || state.userId !== userId) {
    return errorResponse(new Error('Sandbox launch not found'), { status: 404 }, req);
  }

  return successResponse(toPublicSandboxLaunchState(state), { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
