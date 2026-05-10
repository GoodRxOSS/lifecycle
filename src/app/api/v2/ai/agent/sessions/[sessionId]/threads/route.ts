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
import AgentThreadService, {
  AgentThreadCreateConflictError,
  AgentThreadCreateNotFoundError,
} from 'server/services/agent/ThreadService';
import { WorkspaceActionBlockedError } from 'server/services/agent/WorkspaceRuntimeStateService';

type CreateThreadBody = {
  title?: string;
  sourceThreadId?: string;
};

function getUnknownKeys(value: Record<string, unknown>, allowedKeys: string[]): string[] {
  return Object.keys(value).filter((key) => !allowedKeys.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseCreateThreadBody(body: unknown): CreateThreadBody | Error {
  if (!isPlainObject(body)) {
    return new Error('Request body must be an object.');
  }

  const unknownKeys = getUnknownKeys(body, ['title', 'sourceThreadId']);
  if (unknownKeys.length > 0) {
    return new Error(`Unsupported thread request fields: ${unknownKeys.join(', ')}.`);
  }

  if (body.title !== undefined && typeof body.title !== 'string') {
    return new Error('title must be a string.');
  }

  if (body.sourceThreadId !== undefined && typeof body.sourceThreadId !== 'string') {
    return new Error('sourceThreadId must be a string.');
  }

  return {
    title: body.title,
    sourceThreadId: body.sourceThreadId,
  };
}

async function readCreateThreadBody(req: NextRequest): Promise<CreateThreadBody | Error> {
  if (req.body === null) {
    return {};
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Error('Request body must be valid JSON.');
  }

  return parseCreateThreadBody(body);
}

function mapCreateThreadError(error: unknown, req: NextRequest) {
  if (error instanceof WorkspaceActionBlockedError) {
    return errorResponse(error, { status: 409 }, req);
  }

  if (error instanceof AgentThreadCreateNotFoundError) {
    return errorResponse(error, { status: 404 }, req);
  }

  if (error instanceof AgentThreadCreateConflictError) {
    return errorResponse(error, { status: 409 }, req);
  }

  if (
    error instanceof Error &&
    (error.message === 'Agent session not found' ||
      error.message === 'Agent thread not found' ||
      error.message === 'Source agent thread not found')
  ) {
    return errorResponse(error, { status: 404 }, req);
  }

  if (
    error instanceof Error &&
    (error.message === 'Cannot create a thread for an inactive session' ||
      error.message === 'Wait for the session to finish starting before sending a message.' ||
      error.message === 'This session is no longer available for new messages.' ||
      error.message === 'Wait for the current agent run to finish before starting a new thread.' ||
      error.message === 'Resolve pending approvals before starting a new thread.')
  ) {
    return errorResponse(error, { status: 409 }, req);
  }

  throw error;
}

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
 *                             $ref: '#/components/schemas/AgentThreadHistoryEntry'
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
 *             $ref: '#/components/schemas/CreateAgentSessionThreadBody'
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
 *       '400':
 *         description: Invalid create-thread request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Agent session or source thread not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '409':
 *         description: Session cannot create new threads while inactive, busy, awaiting approval, or changing workspace state
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
    const threads = await AgentThreadService.listThreadHistoryForSession(params.sessionId, userIdentity.userId);
    return successResponse({ threads }, { status: 200 }, req);
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

  const body = await readCreateThreadBody(req);
  if (body instanceof Error) {
    return errorResponse(body, { status: 400 }, req);
  }

  try {
    const thread = await AgentThreadService.createThread(params.sessionId, userIdentity.userId, body);

    return successResponse(AgentThreadService.serializeThread(thread, params.sessionId), { status: 201 }, req);
  } catch (error) {
    return mapCreateThreadError(error, req);
  }
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
