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
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildMetadataService, { BuildMetadataError } from 'server/services/buildMetadata';

function mapMetadataError(error: unknown, req: NextRequest) {
  if (error instanceof BuildMetadataError) {
    return errorResponse(error, { status: error.code === 'not_found' ? 404 : 400 }, req);
  }

  throw error;
}

async function readRequestBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BuildMetadataError('Invalid JSON in request body.', 'invalid_input');
  }
}

/**
 * @openapi
 * /api/v2/config/metadata:
 *   get:
 *     summary: Get build metadata config
 *     description: Returns the global build metadata configuration, including unrendered link templates.
 *     tags:
 *       - Config
 *     operationId: getBuildMetadataConfig
 *     responses:
 *       '200':
 *         description: Build metadata config.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BuildMetadataSuccessResponse'
 *       '403':
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   post:
 *     summary: Create a build metadata link
 *     description: Adds a link template to the global build metadata configuration.
 *     tags:
 *       - Config
 *     operationId: createBuildMetadataLink
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/BuildMetadataLinkCreateRequest'
 *     responses:
 *       '201':
 *         description: Build metadata config after the link was created.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BuildMetadataSuccessResponse'
 *       '400':
 *         description: Invalid metadata link input.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const metadata = await new BuildMetadataService().getConfig();
  return successResponse(metadata, { status: 200 }, req);
};

const postHandler = async (req: NextRequest) => {
  const service = new BuildMetadataService();

  try {
    const body = await readRequestBody(req);
    const metadata = await service.createLink(body);
    return successResponse(metadata, { status: 201 }, req);
  } catch (error) {
    return mapMetadataError(error, req);
  }
};

export const GET = createApiHandler(getHandler, { roles: ['admin'] });
export const POST = createApiHandler(postHandler, { roles: ['admin'] });
