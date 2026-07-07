/**
 * Copyright 2025 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NextRequest } from 'next/server';
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import type { Principal } from 'server/lib/principal';
import { assertBuildRepositoryAllowed } from 'server/lib/repositoryAuthorization';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v2/builds/{uuid}/redeploy:
 *   put:
 *     summary: Redeploy an entire build
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: |
 *       Triggers a redeployment of an entire build. The build
 *       will be queued for deployment and its status will be updated accordingly.
 *     tags:
 *       - Builds
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *     responses:
 *       200:
 *         description: Build has been successfully queued for redeployment
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RedeployBuildSuccessResponse'
 *       404:
 *         description: Build not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const PutHandler = async (
  req: NextRequest,
  principal: Principal,
  { params }: { params: Promise<{ uuid: string }> }
) => {
  const routeParams = await params;
  const { uuid: buildUuid } = routeParams;

  const buildService = new BuildService();
  const build = await buildService.getBuildByUUID(buildUuid);
  if (!build) {
    return errorResponse(`Build not found for ${buildUuid}.`, { status: 404 }, req);
  }
  await assertBuildRepositoryAllowed(principal, build);

  const response = await buildService.redeployBuild(buildUuid, build.id);

  if (response.status === 'success') {
    return successResponse(response, { status: 200 }, req);
  } else if (response.status === 'not_found') {
    return errorResponse(response.message, { status: 404 }, req);
  } else {
    return errorResponse(response.message, { status: 400 }, req);
  }
};

export const PUT = createPrincipalApiHandler({ scope: 'env:write' }, PutHandler);
