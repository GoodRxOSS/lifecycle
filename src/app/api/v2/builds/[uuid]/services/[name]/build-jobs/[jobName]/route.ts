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
import { LogStreamingService } from 'server/services/logStreaming';
import { HttpError } from '@kubernetes/client-node';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';

interface RouteParams {
  uuid: string;
  name: string;
  jobName: string;
}
/**
 * @openapi
 * /api/v2/builds/{uuid}/services/{name}/build-jobs/{jobName}:
 *   get:
 *     summary: Get log streaming info for a build job
 *     description: |
 *       Returns log streaming information for a specific build job within a service.
 *     tags:
 *       - Builds
 *       - Logs
 *     operationId: getBuildJobLogStreamInfo
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
 *       - in: path
 *         name: jobName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the build job
 *     responses:
 *       '200':
 *         description: Successful response with WebSocket information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LogStreamSuccessResponse'
 *       '400':
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Build or job not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '502':
 *         description: Kubernetes communication error
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
 */
const getHandler = async (req: NextRequest, { params }: { params: RouteParams }) => {
  const { uuid, name: serviceName, jobName } = params;

  if (!uuid || !jobName || !serviceName) {
    getLogger().warn(`API: invalid params uuid=${uuid} serviceName=${serviceName} jobName=${jobName}`);
    return errorResponse('Missing or invalid parameters', { status: 400 }, req);
  }

  try {
    const logService = new LogStreamingService();

    const response = await logService.getLogStreamInfo(uuid, jobName, serviceName, 'build');

    return successResponse(response, { status: 200 }, req);
  } catch (error: any) {
    getLogger().error({ error }, `API: log streaming info failed jobName=${jobName} service=${serviceName}`);

    if (error.message === 'Build not found') {
      return errorResponse('Build not found', { status: 404 }, req);
    }

    if (error instanceof HttpError || error.message?.includes('Kubernetes') || error.statusCode === 502) {
      return errorResponse('Failed to communicate with Kubernetes.', { status: 502 }, req);
    }

    return errorResponse('Internal server error occurred.', { status: 500 }, req);
  }
};

export const GET = createApiHandler(getHandler);
