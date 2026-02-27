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
import { getUser } from 'server/lib/get-user';
import AIAgentConversationService from 'server/services/ai/conversation/storage';
import ConversationPersistenceService from 'server/services/ai/conversation/persistence';
import FeedbackService from 'server/services/ai/feedback/FeedbackService';
import { MAX_FEEDBACK_TEXT_LENGTH } from 'server/services/ai/feedback/constants';
import { resolveFeedbackContext } from 'server/services/ai/feedback/resolveFeedbackContext';
import { resolveUserIdentifierFromPayload } from 'server/services/ai/feedback/userIdentifier';

/**
 * @openapi
 * /api/v2/ai/chat/{buildUuid}/feedback:
 *   post:
 *     summary: Submit conversation feedback
 *     description: >
 *       Submit a thumbs up/down rating for an entire conversation session.
 *       Triggers conversation persistence from Redis to Postgres if not already persisted.
 *     tags:
 *       - AI Chat
 *     operationId: submitConversationFeedback
 *     parameters:
 *       - in: path
 *         name: buildUuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build whose conversation to rate.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - rating
 *             properties:
 *               rating:
 *                 type: string
 *                 enum: [up, down]
 *               text:
 *                 type: string
 *     responses:
 *       '201':
 *         description: Feedback created successfully
 *       '400':
 *         description: Invalid or missing rating
 *       '404':
 *         description: Conversation not found
 *       '500':
 *         description: Server error
 */
const postHandler = async (req: NextRequest, { params }: { params: { buildUuid: string } }) => {
  const { buildUuid } = params;

  if (!buildUuid) {
    return errorResponse(new Error('Missing required parameter: buildUuid'), { status: 400 }, req);
  }

  const body = await req.json();
  const { rating, text } = body;

  if (!rating || (rating !== 'up' && rating !== 'down')) {
    return errorResponse(new Error('Invalid rating: must be "up" or "down"'), { status: 400 }, req);
  }

  if (text !== undefined && typeof text !== 'string') {
    return errorResponse(new Error('Invalid text: must be a string'), { status: 400 }, req);
  }

  if (typeof text === 'string' && Array.from(text).length > MAX_FEEDBACK_TEXT_LENGTH) {
    return errorResponse(
      new Error(`Invalid text: exceeds max length of ${MAX_FEEDBACK_TEXT_LENGTH} characters`),
      { status: 400 },
      req
    );
  }

  const conversationService = new AIAgentConversationService(defaultDb, defaultRedis);
  const persistenceService = new ConversationPersistenceService(conversationService);
  const feedbackService = new FeedbackService(persistenceService);
  const userIdentifier = resolveUserIdentifierFromPayload(getUser(req));

  const { repo, prNumber } = await resolveFeedbackContext(buildUuid);
  if (!repo) {
    return errorResponse(
      new Error(`Unable to resolve repository context for buildUuid=${buildUuid}`),
      { status: 404 },
      req
    );
  }

  try {
    const record = await feedbackService.submitConversationFeedback({
      buildUuid,
      rating,
      text,
      userIdentifier,
      repo,
      prNumber,
    });
    return successResponse(record, { status: 201 }, req);
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      return errorResponse(error, { status: 404 }, req);
    }
    throw error;
  }
};

export const POST = createApiHandler(postHandler);
