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

import { createApiHandler } from 'server/lib/createApiHandler';
import 'server/lib/dependencies';
import { setAgentFeedbackHandler, deleteAgentFeedbackHandler } from 'server/lib/agentFeedbackHandlers';
import { NextRequest } from 'next/server';
import { requireRequestUserIdentity } from 'server/lib/get-user';
import { successResponse } from 'server/lib/response';
import AgentFeedbackService from 'server/services/agent/FeedbackService';

/**
 * @openapi
 * /api/v2/ai/agent/threads/{threadId}/feedback:
 *   get:
 *     summary: List your chat and reply feedback for a thread
 *     tags: [Agent Platform]
 *     operationId: getAgentThreadFeedback
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       '200':
 *         description: Feedback saved, listed, or removed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentFeedbackListSuccessResponse'
 *       '400':
 *         description: Invalid feedback or target
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Interactive user session required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Thread or assistant reply not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   put:
 *     summary: Set your feedback for a chat
 *     tags: [Agent Platform]
 *     operationId: setAgentThreadFeedback
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     description: Requires feedback collection to be enabled for this conversation and at least one finished assistant response with meaningful content. Replaces the saved rating, optional text, and reasons. Omitted or blank text clears the comment; omitted reasons clears reason tags. Feedback is visible to administrators for review.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AgentFeedbackRequest'
 *     responses:
 *       '200':
 *         description: Feedback saved, listed, or removed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentFeedbackSuccessResponse'
 *       '400':
 *         description: Invalid feedback or target
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Interactive user session required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Thread or assistant reply not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '409':
 *         description: Feedback is not enabled for this conversation
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   delete:
 *     summary: Remove your feedback for a chat
 *     tags: [Agent Platform]
 *     operationId: deleteAgentThreadFeedback
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       '200':
 *         description: Feedback saved, listed, or removed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeleteAgentFeedbackSuccessResponse'
 *       '400':
 *         description: Invalid feedback or target
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Interactive user session required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Thread or assistant reply not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) => {
  const { userId } = requireRequestUserIdentity(req);
  return successResponse(
    await AgentFeedbackService.listOwnedThreadFeedback((await params).threadId, userId),
    { status: 200 },
    req
  );
};

export const GET = createApiHandler(getHandler, { auth: 'session' });
export const PUT = createApiHandler(setAgentFeedbackHandler, { auth: 'session' });
export const DELETE = createApiHandler(deleteAgentFeedbackHandler, { auth: 'session' });
