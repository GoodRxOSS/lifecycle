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
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v2/builds/{uuid}/services/{name}/redeploy:
 *   put:
 *     summary: Redeploy a service within an environment
 *     description: |
 *       Triggers a redeployment of a specific service within an environment. The service
 *       will be queued for deployment and its status will be updated accordingly.
 *     tags:
 *       - Services
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the environment
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the service to redeploy
 *     responses:
 *       200:
 *         description: Service has been successfully queued for redeployment
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RedeployServiceSuccessResponse'
 *       404:
 *         description: Build or service not found
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
const PutHandler = async (req: NextRequest, { params }: { params: { uuid: string; name: string } }) => {
  const { uuid: buildUuid, name: serviceName } = params;

  if (!buildUuid || !serviceName) {
    getLogger().warn(`API: invalid params buildUuid=${buildUuid} serviceName=${serviceName}`);
    return errorResponse('Missing or invalid uuid or name parameters', { status: 400 }, req);
  }

  const buildService = new BuildService();

  try {
    const response = await buildService.redeploymentServiceFromBuild(buildUuid, serviceName);

    if (response.status === 'success') {
      return successResponse(response, { status: 200 }, req);
    } else {
      return errorResponse(response.message, { status: 400 }, req);
    }
  } catch (error) {
    getLogger().error({ error }, `API: redeploy failed service=${serviceName}`);
    return errorResponse('Internal server error occurred.', { status: 500 }, req);
  }
};

export const PUT = createApiHandler(PutHandler);
