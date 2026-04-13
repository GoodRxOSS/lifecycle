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
import { getRequestUserIdentity } from 'server/lib/get-user';
import RepositoryService from 'server/services/repository';

/**
 * @openapi
 * /api/v2/repositories:
 *   get:
 *     summary: Search repositories
 *     description: Search known repositories by full name for pickers and scoped configuration flows.
 *     tags:
 *       - Repositories
 *     operationId: searchRepositories
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Case-insensitive repository search query.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 25
 *         description: Maximum number of repositories to return.
 *     responses:
 *       '200':
 *         description: Matching repositories.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SearchRepositoriesSuccessResponse'
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

  const query = req.nextUrl.searchParams.get('q') || '';
  const rawLimit = Number.parseInt(req.nextUrl.searchParams.get('limit') || '10', 10);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 10;

  const repositories = await new RepositoryService().searchRepositories(query, limit);

  return successResponse({ repositories }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
