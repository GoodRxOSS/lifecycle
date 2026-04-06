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
import { getLogger } from 'server/lib/logger';
import { HttpError } from '@kubernetes/client-node';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import { getEnvironmentPods } from 'server/lib/kubernetes/getEnvironmentPods';

/**
 * @openapi
 * /api/v2/builds/{uuid}/pods:
 *   get:
 *     summary: List all pods for a build
 *     description: |
 *       Returns a list of all pods running in the environment namespace for a specific build.
 *       Each pod includes its service name, status, age, restarts, readiness, and container information.
 *     tags:
 *       - Deployments
 *     operationId: listEnvironmentPods
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *     responses:
 *       '200':
 *         description: List of pods
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetEnvironmentPodsSuccessResponse'
 *       '400':
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Environment not found
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
const getHandler = async (req: NextRequest, { params }: { params: { uuid: string } }) => {
  const { uuid } = params;

  if (!uuid) {
    getLogger().warn(`API: invalid params uuid=${uuid}`);
    return errorResponse('Missing or invalid uuid parameter', { status: 400 }, req);
  }

  try {
    const pods = await getEnvironmentPods(uuid);

    const response = { pods };

    return successResponse(response, { status: 200 }, req);
  } catch (error) {
    getLogger().error({ error }, `API: pods fetch failed for build uuid=${uuid}`);

    if (error instanceof HttpError) {
      if (error.response?.statusCode === 404) {
        return errorResponse('Environment not found.', { status: 404 }, req);
      }
      return errorResponse('Failed to communicate with Kubernetes.', { status: 502 }, req);
    }

    return errorResponse('Internal server error occurred.', { status: 500 }, req);
  }
};

export const GET = createApiHandler(getHandler);
