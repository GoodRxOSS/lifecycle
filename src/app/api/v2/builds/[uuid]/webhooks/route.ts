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
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v2/builds/{uuid}/webhooks:
 *   post:
 *     summary: Invoke webhooks for a build
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
const PutHandler = async (req: NextRequest, { params }: { params: { uuid: string } }) => {
  const { uuid: buildUuid } = params;

  const buildService = new BuildService();

  const response = await buildService.invokeWebhooksForBuild(buildUuid);

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

export const PUT = createApiHandler(PutHandler);
