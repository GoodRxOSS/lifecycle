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

/**
 * @openapi
 * /api/v2/ai/agent/threads/{threadId}/messages/{messageId}/feedback:
 *   put:
 *     summary: Set your feedback for a finished assistant reply
 *     tags: [Agent Platform]
 *     operationId: setAgentMessageFeedback
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     description: Replaces the saved rating, optional text, and reasons. Omitted or blank text clears the comment; omitted reasons clears reason tags. Feedback is visible to administrators for review.
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
 *         description: The assistant reply is still running or feedback is not enabled for it
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   delete:
 *     summary: Remove your feedback for an assistant reply
 *     tags: [Agent Platform]
 *     operationId: deleteAgentMessageFeedback
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: messageId
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
export const PUT = createApiHandler(setAgentFeedbackHandler, { auth: 'session' });
export const DELETE = createApiHandler(deleteAgentFeedbackHandler, { auth: 'session' });
