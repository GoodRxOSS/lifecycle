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
import { serializeAgentSessionSummary } from 'server/services/agent/serializeSessionSummary';
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
 *                   type: object
 *                   required:
 *                     - id
 *                     - buildUuid
 *                     - baseBuildUuid
 *                     - buildKind
 *                     - userId
 *                     - ownerGithubUsername
 *                     - podName
 *                     - namespace
 *                     - model
 *                     - status
 *                     - repo
 *                     - branch
 *                     - services
 *                     - lastActivity
 *                     - createdAt
 *                     - updatedAt
 *                     - endedAt
 *                     - startupFailure
 *                     - editorUrl
 *                   properties:
 *                     id:
 *                       type: string
 *                     buildUuid:
 *                       type: string
 *                       nullable: true
 *                     baseBuildUuid:
 *                       type: string
 *                       nullable: true
 *                     buildKind:
 *                       $ref: '#/components/schemas/BuildKind'
 *                     userId:
 *                       type: string
 *                     ownerGithubUsername:
 *                       type: string
 *                       nullable: true
 *                     podName:
 *                       type: string
 *                     namespace:
 *                       type: string
 *                     model:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [starting, active, ended, error]
 *                     repo:
 *                       type: string
 *                       nullable: true
 *                     branch:
 *                       type: string
 *                       nullable: true
 *                     primaryRepo:
 *                       type: string
 *                       nullable: true
 *                     primaryBranch:
 *                       type: string
 *                       nullable: true
 *                     workspaceRepos:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [repo, repoUrl, branch, mountPath]
 *                         properties:
 *                           repo:
 *                             type: string
 *                           repoUrl:
 *                             type: string
 *                           branch:
 *                             type: string
 *                           revision:
 *                             type: string
 *                             nullable: true
 *                           mountPath:
 *                             type: string
 *                           primary:
 *                             type: boolean
 *                     selectedServices:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [name, deployId, repo, branch, workspacePath]
 *                         properties:
 *                           name:
 *                             type: string
 *                           deployId:
 *                             type: integer
 *                           repo:
 *                             type: string
 *                           branch:
 *                             type: string
 *                           revision:
 *                             type: string
 *                             nullable: true
 *                           resourceName:
 *                             type: string
 *                             nullable: true
 *                           workspacePath:
 *                             type: string
 *                           workDir:
 *                             type: string
 *                             nullable: true
 *                     services:
 *                       type: array
 *                       items:
 *                         type: string
 *                     lastActivity:
 *                       type: string
 *                       format: date-time
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                     endedAt:
 *                       type: string
 *                       nullable: true
 *                       format: date-time
 *                     startupFailure:
 *                       type: object
 *                       nullable: true
 *                       required:
 *                         - stage
 *                         - title
 *                         - message
 *                         - recordedAt
 *                       properties:
 *                         stage:
 *                           type: string
 *                           enum: [create_session, connect_runtime, attach_services]
 *                         title:
 *                           type: string
 *                         message:
 *                           type: string
 *                         recordedAt:
 *                           type: string
 *                           format: date-time
 *                     editorUrl:
 *                       type: string
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
  const session = await AgentSessionService.getSession(sessionId);
  if (!session) {
    return errorResponse(new Error('Session not found'), { status: 404 }, req);
  }

  if (session.userId !== userIdentity.userId) {
    return errorResponse(new Error('Forbidden: you do not own this session'), { status: 401 }, req);
  }

  return successResponse(serializeAgentSessionSummary(session), { status: 200 }, req);
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
