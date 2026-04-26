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
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import RepositoryService from 'server/services/repository';

interface RouteContext {
  params: {
    fullName?: string[];
  };
}

/**
 * @openapi
 * /api/v2/repositories/{owner}/{repo}:
 *   delete:
 *     summary: Remove an onboarded repository
 *     description: Soft-removes a repository from Lifecycle onboarding while preserving historical data.
 *     tags:
 *       - Repositories
 *     operationId: removeRepository
 *     parameters:
 *       - in: path
 *         name: owner
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: repo
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: installationId
 *         schema:
 *           type: integer
 *     responses:
 *       '200':
 *         description: Repository removed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RemoveRepositorySuccessResponse'
 *       '400':
 *         description: Invalid repository full name.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Repository not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const deleteHandler = async (req: NextRequest, { params }: RouteContext) => {
  const segments = params.fullName || [];
  if (segments.length < 2) {
    return errorResponse(new Error('Invalid repository fullName. Expected format: owner/repo'), { status: 400 }, req);
  }

  const rawInstallationId = req.nextUrl.searchParams.get('installationId');
  const installationId = rawInstallationId ? Number(rawInstallationId) : undefined;
  if (rawInstallationId && !Number.isFinite(installationId)) {
    return errorResponse(new Error('installationId must be a number'), { status: 400 }, req);
  }

  try {
    const repository = await new RepositoryService().removeRepository(segments.join('/'), installationId);
    return successResponse({ repository }, { status: 200 }, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Invalid repository fullName')) {
      return errorResponse(error, { status: 400 }, req);
    }
    if (message.includes('Repository not found')) {
      return errorResponse(error, { status: 404 }, req);
    }
    throw error;
  }
};

export const DELETE = createApiHandler(deleteHandler);
