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

import { NextRequest, NextResponse } from 'next/server';
import 'server/lib/dependencies';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildMetadataService, { BuildMetadataError } from 'server/services/buildMetadata';

interface RouteContext {
  params: {
    id: string;
  };
}

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
 * /api/v2/config/metadata/{id}:
 *   patch:
 *     summary: Update a build metadata link
 *     description: Updates selected fields on one configured build metadata link template.
 *     tags:
 *       - Config
 *     operationId: updateBuildMetadataLink
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/BuildMetadataLinkPatchRequest'
 *     responses:
 *       '200':
 *         description: Build metadata config after the link was updated.
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
 *       '404':
 *         description: Metadata link not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   delete:
 *     summary: Delete a build metadata link
 *     description: Removes one configured build metadata link template.
 *     tags:
 *       - Config
 *     operationId: deleteBuildMetadataLink
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '204':
 *         description: Metadata link deleted.
 *       '403':
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Metadata link not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const patchHandler = async (req: NextRequest, { params }: RouteContext) => {
  const service = new BuildMetadataService();

  try {
    const body = await readRequestBody(req);
    const metadata = await service.updateLink(params.id, body);
    return successResponse(metadata, { status: 200 }, req);
  } catch (error) {
    return mapMetadataError(error, req);
  }
};

const deleteHandler = async (req: NextRequest, { params }: RouteContext) => {
  const service = new BuildMetadataService();

  try {
    await service.deleteLink(params.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return mapMetadataError(error, req);
  }
};

export const PATCH = createApiHandler(patchHandler, { roles: ['admin'] });
export const DELETE = createApiHandler(deleteHandler, { roles: ['admin'] });
