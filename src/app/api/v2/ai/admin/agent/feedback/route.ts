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
import { successResponse } from 'server/lib/response';
import AgentFeedbackService, { type AgentAdminFeedbackFilters } from 'server/services/agent/FeedbackService';

/**
 * @openapi
 * /api/v2/ai/admin/agent/feedback:
 *   get:
 *     summary: List user feedback for administrator review
 *     description: Returns saved conversation and reply feedback, including feedback retained after the collection policy changes. Open the existing thread conversation endpoint to inspect context.
 *     tags: [Agent Admin]
 *     operationId: getAdminAgentFeedback
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *       - in: query
 *         name: rating
 *         schema: { type: string, enum: [all, up, down], default: all }
 *       - in: query
 *         name: scope
 *         schema: { type: string, enum: [all, thread, message], default: all }
 *       - in: query
 *         name: repo
 *         schema: { type: string }
 *         description: Case-insensitive repository search.
 *       - in: query
 *         name: user
 *         schema: { type: string }
 *         description: Case-insensitive user ID or GitHub username search.
 *     responses:
 *       '200':
 *         description: Paginated feedback; metadata.pagination.items is the row count and total is the page count.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminAgentFeedbackSuccessResponse'
 *       '400':
 *         description: Invalid filters or pagination
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
 *         description: Administrator role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  requireRequestUserIdentity(req);
  const params = req.nextUrl.searchParams;
  const result = await AgentFeedbackService.listAdminFeedback({
    page: Number(params.get('page') ?? 1),
    limit: Number(params.get('limit') ?? 25),
    rating: (params.get('rating') ?? 'all') as AgentAdminFeedbackFilters['rating'],
    scope: (params.get('scope') ?? 'all') as AgentAdminFeedbackFilters['scope'],
    repo: params.get('repo') ?? undefined,
    user: params.get('user') ?? undefined,
  });
  return successResponse(result.data, { status: 200, metadata: result.metadata }, req);
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
