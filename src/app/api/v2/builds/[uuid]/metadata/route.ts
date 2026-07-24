/**
 * Copyright 2026 Lifecycle contributors
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
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import type { Principal } from 'server/lib/principal';
import { assertBuildRepositoryAllowed } from 'server/lib/repositoryAuthorization';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';
import BuildMetadataService, { BuildMetadataError } from 'server/services/buildMetadata';

interface RouteContext {
  params: Promise<{
    uuid: string;
  }>;
}

/**
 * @openapi
 * /api/v2/builds/{uuid}/metadata:
 *   get:
 *     summary: Get rendered build metadata
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: Returns build metadata with configured links rendered for the requested build.
 *     tags:
 *       - Builds
 *     operationId: getBuildMetadata
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build to render metadata for.
 *     responses:
 *       '200':
 *         description: Rendered build metadata.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BuildMetadataSuccessResponse'
 *       '404':
 *         description: Build not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '400':
 *         description: Invalid rendered metadata link.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '500':
 *         description: Server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, principal: Principal, { params }: RouteContext) => {
  const routeParams = await params;

  const build = await new BuildService().getBuildByUUID(routeParams.uuid);
  if (!build) {
    return errorResponse(
      new BuildMetadataError(`Build with UUID ${routeParams.uuid} not found.`, 'not_found'),
      { status: 404 },
      req
    );
  }
  await assertBuildRepositoryAllowed(principal, build);

  const service = new BuildMetadataService();

  try {
    const metadata = await service.renderMetadataForBuild(build);
    return successResponse(metadata, { status: 200 }, req);
  } catch (error) {
    if (error instanceof BuildMetadataError) {
      return errorResponse(error, { status: error.code === 'not_found' ? 404 : 400 }, req);
    }

    throw error;
  }
};

export const GET = createPrincipalApiHandler({ scope: 'env:read' }, getHandler);
