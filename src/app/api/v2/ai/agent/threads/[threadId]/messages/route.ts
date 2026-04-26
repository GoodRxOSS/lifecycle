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
import AgentMessageStore, {
  DEFAULT_AGENT_MESSAGE_PAGE_LIMIT,
  MAX_AGENT_MESSAGE_PAGE_LIMIT,
} from 'server/services/agent/MessageStore';

function parseLimit(value: string | null): number {
  if (value == null || value.trim() === '') {
    return DEFAULT_AGENT_MESSAGE_PAGE_LIMIT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Expected a positive integer limit.');
  }

  return Math.min(parsed, MAX_AGENT_MESSAGE_PAGE_LIMIT);
}

/**
 * @openapi
 * /api/v2/ai/agent/threads/{threadId}/messages:
 *   get:
 *     summary: List canonical messages for an agent thread
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentThreadMessages
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *       - in: query
 *         name: beforeMessageId
 *         required: false
 *         schema:
 *           type: string
 *         description: Return messages older than this message id.
 *     responses:
 *       '200':
 *         description: Canonical thread messages
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AgentThreadMessagesResponse'
 *       '400':
 *         description: Invalid message cursor or page size
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
 *         description: Thread not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: { threadId: string } }) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  let limit;
  try {
    limit = parseLimit(req.nextUrl.searchParams.get('limit'));
  } catch (error) {
    return errorResponse(error, { status: 400 }, req);
  }

  try {
    const result = await AgentMessageStore.listCanonicalMessages(params.threadId, userIdentity.userId, {
      limit,
      beforeMessageId: req.nextUrl.searchParams.get('beforeMessageId'),
    });

    return successResponse(result, { status: 200 }, req);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'Agent thread not found' || error.message === 'Agent session not found')
    ) {
      return errorResponse(error, { status: 404 }, req);
    }
    if (error instanceof Error && error.message === 'Agent message cursor not found') {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
