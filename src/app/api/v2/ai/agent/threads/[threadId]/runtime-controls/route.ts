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
import AgentThreadRuntimeControlsService from 'server/services/agent/ThreadRuntimeControlsService';

type RuntimeControlsPatchBody = {
  toolChoiceIds?: string[];
  mcpChoiceIds?: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readChoiceIds(value: unknown, fieldName: string): string[] | undefined | Error {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return new Error(`${fieldName} must be an array of choice ids.`);
  }

  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      return new Error(`${fieldName} must contain only choice ids.`);
    }
  }

  return value.map((item) => item.trim());
}

function parsePatchBody(body: unknown): RuntimeControlsPatchBody | Error {
  if (!isPlainObject(body)) {
    return new Error('Request body must be an object.');
  }

  const unknownKeys = Object.keys(body).filter((key) => key !== 'toolChoiceIds' && key !== 'mcpChoiceIds');
  if (unknownKeys.length > 0) {
    return new Error(`Unsupported runtime-control fields: ${unknownKeys.join(', ')}.`);
  }

  const toolChoiceIds = readChoiceIds(body.toolChoiceIds, 'toolChoiceIds');
  if (toolChoiceIds instanceof Error) {
    return toolChoiceIds;
  }

  const mcpChoiceIds = readChoiceIds(body.mcpChoiceIds, 'mcpChoiceIds');
  if (mcpChoiceIds instanceof Error) {
    return mcpChoiceIds;
  }

  return { toolChoiceIds, mcpChoiceIds };
}

/**
 * @openapi
 * /api/v2/ai/agent/threads/{threadId}/runtime-controls:
 *   get:
 *     summary: Get runtime control choices for a thread
 *     description: Returns available and selected runtime control choices that apply to future runs in the thread.
 *     tags:
 *       - Agent Platform
 *     operationId: getAgentThreadRuntimeControls
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Thread runtime controls
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AgentThreadRuntimeControlsState'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Thread not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   patch:
 *     summary: Update runtime control choices for future runs in a thread
 *     description: Updates selected runtime control choices for future runs without changing active or completed runs.
 *     tags:
 *       - Agent Platform
 *     operationId: patchAgentThreadRuntimeControls
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
 *             $ref: '#/components/schemas/AgentThreadRuntimeControlsPatchRequest'
 *     responses:
 *       '200':
 *         description: Updated thread runtime controls
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AgentThreadRuntimeControlsState'
 *       '400':
 *         description: Invalid runtime-control choices
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Runtime-control choice is unavailable
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Thread not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '409':
 *         description: Runtime controls cannot change while a run is active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) => {
  const routeParams = await params;
  const userIdentity = requireRequestUserIdentity(req);

  // AgentThreadRuntimeControlsError is an AppError; createApiHandler maps its httpStatus/code.
  const state = await AgentThreadRuntimeControlsService.getState({ threadId: routeParams.threadId, userIdentity });
  return successResponse(state, { status: 200 }, req);
};

const patchHandler = async (req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) => {
  const routeParams = await params;
  const userIdentity = requireRequestUserIdentity(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Request body must be valid JSON.'), { status: 400 }, req);
  }

  const parsedBody = parsePatchBody(body);
  if (parsedBody instanceof Error) {
    return errorResponse(parsedBody, { status: 400 }, req);
  }

  const state = await AgentThreadRuntimeControlsService.patchChoices({
    threadId: routeParams.threadId,
    userIdentity,
    ...parsedBody,
  });
  return successResponse(state, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { auth: 'session' });
export const PATCH = createApiHandler(patchHandler, { auth: 'session' });
