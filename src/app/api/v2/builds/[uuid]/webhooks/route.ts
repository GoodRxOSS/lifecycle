/**
 * Copyright 2026 Lifecycle contributors
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
 * /api/v2/builds/{uuid}/webhooks:
 *   get:
 *     summary: Retrieve webhook invocations for a build
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: |
 *       Retrieves all webhook invocations for a specific build,
 *       ordered by creation date in descending order.
 *     tags:
 *       - Builds
 *     operationId: getWebhooksForBuild
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *     responses:
 *       '200':
 *         description: List of webhook invocations
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetWebhooksSuccessResponse'
 *       '404':
 *         description: Build not found
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
 *   put:
 *     summary: Invoke webhooks for a build
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: |
 *       Triggers the execution of configured webhooks for a specific build.
 *       The webhooks must be defined in the build's webhooksYaml configuration.
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
 *         description: Webhooks successfully queued
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InvokeWebhooksSuccessResponse'
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
const getHandler = async (
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

  const response = await buildService.getWebhooksForBuild(buildUuid, build.id);

  if (response.status === 'not_found') {
    return errorResponse(response.message, { status: 404 }, req);
  }

  return successResponse(response.data, { status: 200 }, req);
};

const putHandler = async (
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

  const response = await buildService.invokeWebhooksForBuild(buildUuid, build.id);

  if (response.status === 'success') {
    return successResponse(response, { status: 200 }, req);
  } else if (response.status === 'not_found') {
    return errorResponse(response.message, { status: 404 }, req);
  } else if (response.status === 'no_content') {
    return successResponse(response, { status: 200 }, req);
  } else {
    return errorResponse(response.message, { status: 400 }, req);
  }
};

export const GET = createPrincipalApiHandler({ scope: 'env:read' }, getHandler);
export const PUT = createPrincipalApiHandler({ scope: 'env:write' }, putHandler);
