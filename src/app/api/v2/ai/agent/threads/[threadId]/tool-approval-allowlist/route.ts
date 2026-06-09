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
import AgentThreadService, { getToolApprovalAllowlist } from 'server/services/agent/ThreadService';

function parseToolKeys(body: unknown): string[] | Error {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Error('Request body must be an object.');
  }

  const toolKeys = (body as Record<string, unknown>).toolKeys;
  if (!Array.isArray(toolKeys) || toolKeys.some((key) => typeof key !== 'string' || !key.trim())) {
    return new Error('toolKeys must be an array of tool keys.');
  }

  return (toolKeys as string[]).map((key) => key.trim());
}

function notFoundOrThrow(error: unknown, req: NextRequest) {
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
 * /api/v2/ai/agent/threads/{threadId}/tool-approval-allowlist:
 *   get:
 *     summary: List tools auto-approved for this conversation
 *     tags:
 *       - Agent Platform
 *     operationId: getAgentThreadToolApprovalAllowlist
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Tool keys auto-approved for future runs in this thread
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
 *                       required: [toolKeys]
 *                       properties:
 *                         toolKeys:
 *                           type: array
 *                           items:
 *                             type: string
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Thread or session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   put:
 *     summary: Replace the tools auto-approved for this conversation
 *     tags:
 *       - Agent Platform
 *     operationId: setAgentThreadToolApprovalAllowlist
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
 *             type: object
 *             required: [toolKeys]
 *             additionalProperties: false
 *             properties:
 *               toolKeys:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       '200':
 *         description: Updated allowlist
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
 *                       required: [toolKeys]
 *                       properties:
 *                         toolKeys:
 *                           type: array
 *                           items:
 *                             type: string
 *       '400':
 *         description: Invalid allowlist body
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
 *         description: Thread or session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) => {
  const routeParams = await params;
  const userIdentity = requireRequestUserIdentity(req);

  try {
    const { thread } = await AgentThreadService.getOwnedThreadWithSession(routeParams.threadId, userIdentity.userId);
    return successResponse({ toolKeys: getToolApprovalAllowlist(thread) }, { status: 200 }, req);
  } catch (error) {
    return notFoundOrThrow(error, req);
  }
};

const putHandler = async (req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) => {
  const routeParams = await params;
  const userIdentity = requireRequestUserIdentity(req);

  const body = await req.json().catch(() => null);
  const toolKeys = parseToolKeys(body);
  if (toolKeys instanceof Error) {
    return errorResponse(toolKeys, { status: 400 }, req);
  }

  try {
    const { thread } = await AgentThreadService.getOwnedThreadWithSession(routeParams.threadId, userIdentity.userId);
    const updated = await AgentThreadService.setToolApprovalAllowlist(thread.id, toolKeys);
    return successResponse({ toolKeys: getToolApprovalAllowlist(updated) }, { status: 200 }, req);
  } catch (error) {
    return notFoundOrThrow(error, req);
  }
};

export const GET = createApiHandler(getHandler);
export const PUT = createApiHandler(putHandler);
