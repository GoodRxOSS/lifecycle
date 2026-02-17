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
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import { defaultDb, defaultRedis } from 'server/lib/dependencies';
import AIAgentConversationService from 'server/services/ai/conversation/storage';

/**
 * @openapi
 * /api/v2/ai/chat/{buildUuid}/messages:
 *   get:
 *     summary: Get conversation messages
 *     description: >
 *       Returns the full conversation history for a given build UUID, including
 *       user and assistant messages. Assistant messages may include tool call
 *       activity history, evidence items, and debug data collected during streaming.
 *       Returns an empty array if no conversation exists for the build.
 *     tags:
 *       - AI Chat
 *     operationId: getAIChatMessages
 *     parameters:
 *       - in: path
 *         name: buildUuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build to retrieve messages for.
 *         example: white-poetry-596195
 *     responses:
 *       '200':
 *         description: Conversation messages with optional activity history and debug data.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAIMessagesSuccessResponse'
 *       '400':
 *         description: Missing or invalid buildUuid
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: { buildUuid: string } }) => {
  const { buildUuid } = params;

  if (!buildUuid) {
    return errorResponse(new Error('Missing required parameter: buildUuid'), { status: 400 }, req);
  }

  const conversationService = new AIAgentConversationService(defaultDb, defaultRedis);
  const conversation = await conversationService.getConversation(buildUuid);

  return successResponse(
    { messages: conversation?.messages || [], lastActivity: conversation?.lastActivity || null },
    { status: 200 },
    req
  );
};

export const GET = createApiHandler(getHandler);
