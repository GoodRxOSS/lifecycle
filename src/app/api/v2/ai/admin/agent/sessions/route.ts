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
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import { getPaginationParamsFromURL } from 'server/lib/paginate';
import { getRequestUserIdentity } from 'server/lib/get-user';
import AgentAdminService from 'server/services/agent/AdminService';

/**
 * @openapi
 * /api/v2/ai/admin/agent/sessions:
 *   get:
 *     summary: List agent sessions for admin review
 *     description: >
 *       Returns paginated agent sessions across users for operational review.
 *       Results can be filtered by status, repository, user, and build UUID.
 *     tags:
 *       - Agent Admin
 *     operationId: getAdminAgentSessions
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 25
 *           minimum: 1
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [all, starting, active, ended, error]
 *           default: all
 *       - in: query
 *         name: repo
 *         schema:
 *           type: string
 *         description: Case-insensitive repository search.
 *       - in: query
 *         name: user
 *         schema:
 *           type: string
 *         description: Case-insensitive user or GitHub username search.
 *       - in: query
 *         name: buildUuid
 *         schema:
 *           type: string
 *         description: Exact build UUID filter.
 *     responses:
 *       '200':
 *         description: Paginated agent sessions.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminAgentSessionsSuccessResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const { page, limit } = getPaginationParamsFromURL(req.nextUrl.searchParams);
  const status = req.nextUrl.searchParams.get('status') || 'all';
  const repo = req.nextUrl.searchParams.get('repo') || undefined;
  const user = req.nextUrl.searchParams.get('user') || undefined;
  const buildUuid = req.nextUrl.searchParams.get('buildUuid') || undefined;

  const result = await AgentAdminService.listSessions({
    page,
    limit,
    status: status as 'all' | 'starting' | 'active' | 'ended' | 'error',
    repo,
    user,
    buildUuid,
  });

  return successResponse(result.data, { status: 200, metadata: result.metadata }, req);
};

export const GET = createApiHandler(getHandler);
