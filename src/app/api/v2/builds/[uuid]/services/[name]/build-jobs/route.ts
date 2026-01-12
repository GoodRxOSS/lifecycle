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
import { getLogger } from 'server/lib/logger';
import { HttpError } from '@kubernetes/client-node';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import { getNativeBuildJobs } from 'server/lib/kubernetes/getNativeBuildJobs';

/**
 * @openapi
 * /api/v2/builds/{uuid}/services/{name}/builds:
 *   get:
 *     summary: List build jobs for a service
 *     description: |
 *       Returns a list of all build jobs for a specific service within a build.
 *       This includes both active and completed build jobs with their status,
 *       timing information, and the build engine used.
 *     tags:
 *       - Builds
 *       - Native Build
 *     operationId: listBuildJobsForService
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the service
 *     responses:
 *       '200':
 *         description: List of build jobs
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetBuildLogsSuccessResponse'
 *       '400':
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Environment or service not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '502':
 *         description: Failed to communicate with Kubernetes
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: { uuid: string; name: string } }) => {
  const { uuid, name } = params;

  if (!uuid || !name) {
    getLogger().warn(`API: invalid params uuid=${uuid} name=${name}`);
    return errorResponse('Missing or invalid uuid or name parameters', { status: 400 }, req);
  }

  try {
    const namespace = `env-${uuid}`;
    const buildJobs = await getNativeBuildJobs(name, namespace);

    const response = { builds: buildJobs };

    return successResponse(response, { status: 200 }, req);
  } catch (error) {
    getLogger().error({ error }, `API: build logs fetch failed service=${name}`);

    if (error instanceof HttpError) {
      if (error.response?.statusCode === 404) {
        return errorResponse('Environment or service not found.', { status: 404 }, req);
      }
      return errorResponse('Failed to communicate with Kubernetes.', { status: 502 }, req);
    }

    return errorResponse('Internal server error occurred.', { status: 500 }, req);
  }
};

export const GET = createApiHandler(getHandler);
