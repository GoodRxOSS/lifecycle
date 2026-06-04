/**
 * Copyright 2026 GoodRx, Inc.
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
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import DeployCleanupService from 'server/services/deployCleanup';

/**
 * @openapi
 * /api/v2/builds/{uuid}/services/{name}/destroy:
 *   put:
 *     summary: Destroy a service deployment within an environment
 *     description: |
 *       Queues deploy-scoped infrastructure teardown for a service in a build environment. The worker deletes
 *       Kubernetes resources, secrets, Helm releases, and configured CLI/Codefresh destroy steps for the service type.
 *       Static environments are allowed. When cleanup succeeds, the Deploy record is marked torn_down.
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
 *         description: The name of the service deployment to destroy
 *     responses:
 *       200:
 *         description: Service deployment teardown has been successfully queued
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DestroyServiceDeploymentSuccessResponse'
 *       404:
 *         description: Build or service not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       400:
 *         description: Cleanup failed
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
const PutHandler = async (req: NextRequest, { params }: { params: Promise<{ uuid: string; name: string }> }) => {
  const routeParams = await params;
  const { uuid: buildUuid, name: serviceName } = routeParams;

  const deployCleanupService = new DeployCleanupService();

  const response = await deployCleanupService.destroyServiceDeployment(buildUuid, serviceName);

  if (response.status === 'success') {
    return successResponse(response, { status: 200 }, req);
  } else if (response.status === 'not_found') {
    return errorResponse(response.message, { status: 404 }, req);
  } else {
    return errorResponse(response.message, { status: 400 }, req);
  }
};

export const PUT = createApiHandler(PutHandler);
