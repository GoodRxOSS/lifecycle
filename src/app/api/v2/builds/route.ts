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
import { getUser } from 'server/lib/get-user';
import { getPaginationParamsFromURL } from 'server/lib/paginate';
import { successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v2/builds:
 *   get:
 *     summary: Get a list of builds
 *     description: Returns a paginated list of builds, optionally excluding certain statuses.
 *     tags:
 *       - Builds
 *     operationId: getBuilds
 *     parameters:
 *       - in: query
 *         name: exclude
 *         schema:
 *           type: string
 *           example: "pending,failed"
 *         description: Comma-separated list of build statuses to exclude.
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 25
 *         description: Number of items per page.
 *       - in: query
 *         name: my_envs
 *         schema:
 *           type: boolean
 *           default: false
 *         description: If true, only returns builds for the current user.
 *     responses:
 *       '200':
 *         description: A paginated list of builds.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetBuildsSuccessResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const { searchParams } = req.nextUrl;
  const user = getUser(req);
  const buildService = new BuildService();

  const { data, paginationMetadata } = await buildService.getAllBuilds(
    searchParams.get('exclude'),
    searchParams.get('my_envs') === 'true' ? (user.github_username as string) || '' : '',
    getPaginationParamsFromURL(searchParams)
  );

  return successResponse(
    data,
    {
      metadata: { pagination: paginationMetadata },
      status: 200,
    },
    req
  );
};

export const GET = createApiHandler(getHandler);
