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
import AgentThreadRuntimeControlsService, {
  type AgentRuntimeControlsEntryDefaultsInput,
  type AgentRuntimeControlsEntrySourceInput,
  type AgentThreadRuntimeControlChoiceInput,
} from 'server/services/agent/ThreadRuntimeControlsService';

type RuntimeControlsPreviewBody = {
  agentId?: string | null;
  source?: AgentRuntimeControlsEntrySourceInput;
  defaults?: AgentRuntimeControlsEntryDefaultsInput;
  runtimeControlChoices?: AgentThreadRuntimeControlChoiceInput;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseStringArray(value: unknown, fieldName: string): string[] | undefined | Error {
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

function parseRuntimeControlChoices(value: unknown): AgentThreadRuntimeControlChoiceInput | undefined | Error {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    return new Error('runtimeControlChoices must be an object.');
  }

  const unknownKeys = Object.keys(value).filter(
    (key) => key !== 'agentId' && key !== 'toolChoiceIds' && key !== 'mcpChoiceIds'
  );
  if (unknownKeys.length > 0) {
    return new Error(`Unsupported runtime-control fields: ${unknownKeys.join(', ')}.`);
  }

  const agentId =
    value.agentId === undefined || value.agentId === null
      ? undefined
      : typeof value.agentId === 'string' && value.agentId.trim()
      ? value.agentId.trim()
      : new Error('runtimeControlChoices.agentId must be a non-empty string.');
  if (agentId instanceof Error) {
    return agentId;
  }

  const toolChoiceIds = parseStringArray(value.toolChoiceIds, 'runtimeControlChoices.toolChoiceIds');
  if (toolChoiceIds instanceof Error) {
    return toolChoiceIds;
  }

  const mcpChoiceIds = parseStringArray(value.mcpChoiceIds, 'runtimeControlChoices.mcpChoiceIds');
  if (mcpChoiceIds instanceof Error) {
    return mcpChoiceIds;
  }

  return { agentId, toolChoiceIds, mcpChoiceIds };
}

function parsePreviewBody(body: unknown): RuntimeControlsPreviewBody | Error {
  if (!isPlainObject(body)) {
    return new Error('Request body must be an object.');
  }

  const unknownKeys = Object.keys(body).filter(
    (key) => key !== 'agentId' && key !== 'source' && key !== 'defaults' && key !== 'runtimeControlChoices'
  );
  if (unknownKeys.length > 0) {
    return new Error(`Unsupported runtime-control preview fields: ${unknownKeys.join(', ')}.`);
  }

  const agentId =
    body.agentId === undefined || body.agentId === null
      ? undefined
      : typeof body.agentId === 'string' && body.agentId.trim()
      ? body.agentId.trim()
      : new Error('agentId must be a non-empty string.');
  if (agentId instanceof Error) {
    return agentId;
  }

  if (body.source !== undefined && !isPlainObject(body.source)) {
    return new Error('source must be an object.');
  }

  if (body.defaults !== undefined && !isPlainObject(body.defaults)) {
    return new Error('defaults must be an object.');
  }

  const runtimeControlChoices = parseRuntimeControlChoices(body.runtimeControlChoices);
  if (runtimeControlChoices instanceof Error) {
    return runtimeControlChoices;
  }

  return {
    agentId,
    source: body.source as AgentRuntimeControlsEntrySourceInput | undefined,
    defaults: body.defaults as AgentRuntimeControlsEntryDefaultsInput | undefined,
    runtimeControlChoices,
  };
}

/**
 * @openapi
 * /api/v2/ai/agent/runtime-controls/preview:
 *   post:
 *     summary: Preview runtime control choices for a new run or session
 *     description: Previews available runtime control choices for the selected agent, source, defaults, and draft runtime-control choices.
 *     tags:
 *       - Agent Platform
 *     operationId: agentRuntimeControlsPreview
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentRuntimeControlsPreviewRequest'
 *     responses:
 *       '200':
 *         description: Runtime controls preview
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
 *       '401':
 *         description: Unauthorized
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
 */
const postHandler = async (req: NextRequest) => {
  const userIdentity = requireRequestUserIdentity(req);

  const parsedBody = parsePreviewBody(await req.json().catch(() => ({})));
  if (parsedBody instanceof Error) {
    return errorResponse(parsedBody, { status: 400 }, req);
  }

  // AgentThreadRuntimeControlsError is an AppError; createApiHandler maps its httpStatus/code.
  const state = await AgentThreadRuntimeControlsService.getEntryPreview({
    userIdentity,
    ...parsedBody,
  });
  return successResponse(state, { status: 200 }, req);
};

export const POST = createApiHandler(postHandler, { auth: 'session' });
